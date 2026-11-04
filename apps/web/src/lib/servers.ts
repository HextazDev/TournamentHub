import { cache } from "react";
import { GuildDirectoryReasonSchema, type GuildDirectoryReason } from "@hub/shared";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { splitServers, type GuildSummary, type ManageScope, type ManageState, type SetupFields } from "@/lib/accessRules";
import type { Viewer } from "@/lib/viewer";

/** Vues « Mes serveurs » et « Panel organisateur » du visiteur connecté (lectures service_role bornées à ses serveurs / organisations). */
export const loadServerOverview = cache(async (viewer: Viewer & { discordId: string; guilds: NonNullable<Viewer["guilds"]> }) => {
  const ids = viewer.guilds.map((g) => g.id);

  // 1. Lecture du modèle RFC 0001 (organizations, organization_members, organization_integrations, integration_access_grants)
  const [orgMembersRes, staffRes, discordIntsRes, grantsRes] = await Promise.all([
    supabaseAdmin.from("organization_members").select("organization_id, role").eq("user_id", viewer.discordId),
    supabaseAdmin.from("tournament_staff").select("tournament_id, role, tournaments!inner(organization_id, guild_id, status)").eq("user_id", viewer.discordId),
    ids.length > 0
      ? supabaseAdmin.from("organization_integrations").select("*").eq("provider", "DISCORD").in("external_id", ids)
      : Promise.resolve({ data: [], error: null }),
    supabaseAdmin.from("integration_access_grants").select("organization_id, reason").eq("user_id", viewer.discordId),
  ]);

  const settings = new Map<string, SetupFields & { bot_present: boolean }>();
  const orgIdToGuildId = new Map<string, string>();

  for (const row of (discordIntsRes.data ?? []) as Record<string, unknown>[]) {
    const extId = typeof row.external_id === "string" ? row.external_id : null;
    if (!extId) continue;
    if (typeof row.organization_id === "string") {
      orgIdToGuildId.set(row.organization_id, extId);
    }
    const cfg = (typeof row.config === "object" && row.config !== null ? row.config : {}) as Record<string, unknown>;
    const enabled = Boolean(row.enabled);
    settings.set(extId, {
      bot_present: enabled && Boolean(cfg.bot_present ?? true),
      to_role_id: typeof cfg.to_role_id === "string" ? cfg.to_role_id : null,
      captain_role_id: typeof cfg.captain_role_id === "string" ? cfg.captain_role_id : null,
      registration_channel_id: typeof cfg.registration_channel_id === "string" ? cfg.registration_channel_id : null,
      announcement_channel_id: typeof cfg.announcement_channel_id === "string" ? cfg.announcement_channel_id : null,
      checkin_channel_id: typeof cfg.checkin_channel_id === "string" ? cfg.checkin_channel_id : null,
    });
  }

  const directory = new Map<string, GuildDirectoryReason>();
  if (!grantsRes.error && grantsRes.data) {
    for (const row of grantsRes.data as { organization_id?: string; reason?: string }[]) {
      const orgId = typeof row.organization_id === "string" ? row.organization_id : null;
      if (!orgId) continue;
      const guildId = orgIdToGuildId.get(orgId);
      if (!guildId) continue;
      const reason = GuildDirectoryReasonSchema.safeParse(row.reason);
      if (reason.success) {
        const existing = directory.get(guildId);
        if (!existing || (existing === "TOURNAMENT_TO_ROLE" && reason.data !== "TOURNAMENT_TO_ROLE")) {
          directory.set(guildId, reason.data);
        }
      }
    }
  }

  if (!orgMembersRes.error && orgMembersRes.data) {
    for (const m of orgMembersRes.data as { organization_id?: string; role?: string }[]) {
      if (typeof m.organization_id === "string") {
        const guildId = orgIdToGuildId.get(m.organization_id);
        if (guildId && !directory.has(guildId)) {
          if (m.role === "OWNER") directory.set(guildId, "SERVER_OWNER");
          else if (m.role === "ADMIN") directory.set(guildId, "ADMINISTRATOR");
          else if (m.role === "TO") directory.set(guildId, "TO_ROLE");
        }
      }
    }
  }

  const baseResult = splitServers(viewer.guilds, settings, directory);

  // 2. Organisations Web autonomes (sans serveur Discord attaché dans viewer.guilds) où le visiteur est membre ou staff
  const nativeOrgIds = new Set<string>();
  const nativeOrgRoles = new Map<string, "server" | "tournament">();
  for (const m of (orgMembersRes.data ?? []) as { organization_id?: string; role?: string }[]) {
    if (typeof m.organization_id === "string") {
      nativeOrgIds.add(m.organization_id);
      nativeOrgRoles.set(m.organization_id, "server");
    }
  }
  for (const s of (staffRes.data ?? []) as Record<string, unknown>[]) {
    const t = Array.isArray(s.tournaments) ? s.tournaments[0] : s.tournaments;
    const tObj = t as { organization_id?: string; status?: string } | undefined;
    if (tObj?.organization_id && tObj.status !== "ARCHIVED" && !nativeOrgRoles.has(tObj.organization_id)) {
      nativeOrgIds.add(tObj.organization_id);
      nativeOrgRoles.set(tObj.organization_id, "tournament");
    }
  }
  for (const g of (grantsRes.data ?? []) as { organization_id?: string; reason?: string }[]) {
    if (typeof g.organization_id === "string" && !nativeOrgRoles.has(g.organization_id)) {
      nativeOrgIds.add(g.organization_id);
      nativeOrgRoles.set(g.organization_id, g.reason === "TOURNAMENT_TO_ROLE" ? "tournament" : "server");
    }
  }

  if (nativeOrgIds.size > 0) {
    const [orgsRes, allOrgIntsRes] = await Promise.all([
      supabaseAdmin.from("organizations").select("*").in("id", [...nativeOrgIds]),
      supabaseAdmin.from("organization_integrations").select("*").eq("provider", "DISCORD").in("organization_id", [...nativeOrgIds]),
    ]);

    const discordByOrg = new Map<string, { external_id: string | null; enabled: boolean }>();
    for (const intRow of (allOrgIntsRes.data ?? []) as Record<string, unknown>[]) {
      if (typeof intRow.organization_id === "string") {
        discordByOrg.set(intRow.organization_id, {
          external_id: typeof intRow.external_id === "string" ? intRow.external_id : null,
          enabled: Boolean(intRow.enabled),
        });
      }
    }

    const existingManagedIds = new Set(baseResult.managedServers.map((s) => s.guild.id));
    const existingMemberIds = new Set(baseResult.memberServers.map((s) => s.id));

    for (const org of (orgsRes.data ?? []) as Record<string, unknown>[]) {
      const orgId = typeof org.id === "string" ? org.id : null;
      const slug = typeof org.slug === "string" ? org.slug : null;
      const name = typeof org.name === "string" ? org.name : slug;
      if (!orgId || !slug || !name) continue;

      const disc = discordByOrg.get(orgId);
      const routeKey = disc?.enabled && disc.external_id ? disc.external_id : slug;
      if (existingManagedIds.has(routeKey) || (disc?.external_id && existingManagedIds.has(disc.external_id))) {
        continue;
      }

      const summary: GuildSummary = {
        id: routeKey,
        name,
        icon: typeof org.icon_url === "string" ? org.icon_url : null,
        owner: true,
        permissions: "8",
      };
      const scope: ManageScope = nativeOrgRoles.get(orgId) ?? "server";
      const state: ManageState = "ready";
      baseResult.managedServers.push({ guild: summary, state, scope });
      if (!existingMemberIds.has(routeKey)) {
        baseResult.memberServers.push(summary);
      }
    }
  }

  return baseResult;
});
