import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import {
  canPerform,
  CreateOrganizationSchema,
  IntegrationProviderSchema,
  MAX_OWNED_ORGANIZATIONS,
  UpdateIntegrationSchema,
  UpdateOrganizationSchema,
  UpsertOrganizationMemberSchema,
  UpsertTournamentStaffSchema,
} from "@hub/shared";
import { supabase } from "../lib/supabase";
import { encryptSecretPayload } from "../utils/crypto";
import { sendServerError } from "../utils/serverError";
import { resolveOrganization, verifyTournamentGuild } from "../utils/tenant";
import {
  invalidateGuildAccess,
  invalidateMemberAccess,
  resolveMemberAccess,
  type DiscordClientLike,
} from "../services/MemberAccessService";
import { discordIntegrationPlugin } from "../services/integrations/DiscordIntegrationPlugin";
import { logger } from "../utils/logger";

export const organizationRouter = Router();

function getCallerId(req: Request): string | null {
  const fromCheck = req.adminCheck?.discordId;
  if (fromCheck) return fromCheck;
  const fromHeader = req.headers["x-discord-user-id"];
  return typeof fromHeader === "string" && fromHeader.length > 0 ? fromHeader : null;
}

const FALLBACK_DISCORD_CLIENT: DiscordClientLike = {
  guilds: {
    fetch: () => Promise.reject(new Error("Unknown Guild")),
  },
};

async function resolveCallerOrgAccess(req: Request, orgIdentifier: string) {
  const callerId = getCallerId(req);
  if (!callerId) return { ok: false as const, status: 401, code: "NOT_LOGGED_IN", error: "User identity required" };

  const org = await resolveOrganization(orgIdentifier);
  if (!org) return { ok: false as const, status: 404, code: "NO_RIGHTS", error: "Organization not found" };

  if (req.adminCheck && (req.adminCheck.guildId === org.id || req.adminCheck.guildId === org.slug)) {
    return { ok: true as const, callerId, org, access: req.adminCheck.access };
  }

  const client = (req.app?.locals?.discordClient as DiscordClientLike | undefined) ?? FALLBACK_DISCORD_CLIENT;
  const decision = await resolveMemberAccess(client, org.id, callerId);
  if (!decision.allowed) {
    return {
      ok: false as const,
      status: decision.code === "CHECK_FAILED" ? 503 : 403,
      code: decision.code,
      error: "Access denied",
    };
  }
  return { ok: true as const, callerId, org, access: decision.access };
}

// POST /api/organizations — Créer une organisation 100 % Web sans serveur Discord (SEC-27)
organizationRouter.post("/", async (req, res) => {
  try {
    const callerId = getCallerId(req);
    if (!callerId) {
      return res.status(401).json({ error: "User identity required", code: "NOT_LOGGED_IN" });
    }

    const parsed = CreateOrganizationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
    }

    // SEC-27 : vérifier le quota maximal de 5 organisations possédées (ORG_OWNER)
    const { data: ownedRows, error: ownedErr } = await supabase
      .from("organization_members")
      .select("organization_id, role")
      .eq("user_id", callerId);
    if (ownedErr) throw ownedErr;

    const ownedCount = ((ownedRows ?? []) as { role?: string }[]).filter(
      (r) => r.role === "ORG_OWNER" || r.role === "OWNER",
    ).length;

    if (ownedCount >= MAX_OWNED_ORGANIZATIONS) {
      return res.status(403).json({
        error: `Quota atteint : vous ne pouvez posséder que ${MAX_OWNED_ORGANIZATIONS} organisations maximum.`,
        code: "QUOTA_EXCEEDED",
      });
    }

    const { data: existingSlug } = await supabase
      .from("organizations")
      .select("id")
      .eq("slug", parsed.data.slug)
      .maybeSingle();
    if (existingSlug && typeof (existingSlug as { id?: unknown }).id === "string") {
      return res.status(409).json({ error: "Ce slug d'organisation est déjà utilisé." });
    }

    const now = new Date().toISOString();
    const orgId = randomUUID();
    const newOrgRow = {
      id: orgId,
      slug: parsed.data.slug,
      name: parsed.data.name,
      logo_url: parsed.data.logo_url ?? null,
      icon_url: parsed.data.logo_url ?? null,
      language: parsed.data.language ?? "fr",
      invite_url: parsed.data.invite_url ?? null,
      created_at: now,
      updated_at: now,
    };

    const { error: insertOrgErr } = await supabase.from("organizations").insert(newOrgRow);
    if (insertOrgErr) throw insertOrgErr;

    const { error: insertMemberErr } = await supabase.from("organization_members").insert({
      organization_id: orgId,
      user_id: callerId,
      role: "ORG_OWNER",
      created_at: now,
    });
    if (insertMemberErr) throw insertMemberErr;

    return res.status(201).json(newOrgRow);
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.create");
  }
});

// GET /api/organizations/:orgId — Lire le profil, les membres et les intégrations (sans secrets)
organizationRouter.get("/:orgId", async (req, res) => {
  try {
    const auth = await resolveCallerOrgAccess(req, req.params.orgId);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }

    const [{ data: members }, { data: integrations }] = await Promise.all([
      supabase.from("organization_members").select("*").eq("organization_id", auth.org.id),
      supabase.from("organization_integrations").select("*").eq("organization_id", auth.org.id),
    ]);

    return res.status(200).json({
      ...auth.org,
      organization: auth.org,
      members: members ?? [],
      integrations: integrations ?? [],
    });
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.get");
  }
});

// PUT /api/organizations/:orgId — Modifier les paramètres de l'organisation
organizationRouter.put("/:orgId", async (req, res) => {
  try {
    const auth = await resolveCallerOrgAccess(req, req.params.orgId);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }
    if (!canPerform(auth.access, "MANAGE_ORG_SETTINGS")) {
      return res.status(403).json({ error: "Action reserved to organization administrators", code: "SERVER_SETTINGS_RESERVED" });
    }

    const parsed = UpdateOrganizationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
    }

    const payload = Object.fromEntries(
      Object.entries({
        ...parsed.data,
        ...(parsed.data.logo_url !== undefined ? { icon_url: parsed.data.logo_url } : {}),
        updated_at: new Date().toISOString(),
      }).filter(([, v]) => v !== undefined),
    );

    const { data, error } = await supabase
      .from("organizations")
      .update(payload)
      .eq("id", auth.org.id)
      .select()
      .maybeSingle();

    if (error) throw error;
    return res.status(200).json(data ?? { ...auth.org, ...payload });
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.update");
  }
});

// PUT /api/organizations/:orgId/members — Ajouter ou modifier un membre natif (SEC-27)
organizationRouter.put("/:orgId/members", async (req, res) => {
  try {
    const auth = await resolveCallerOrgAccess(req, req.params.orgId);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }
    if (!canPerform(auth.access, "MANAGE_ORG_MEMBERS")) {
      return res.status(403).json({ error: "Action reserved to organization administrators", code: "SERVER_SETTINGS_RESERVED" });
    }

    const parsed = UpsertOrganizationMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
    }

    const { user_id, role } = parsed.data;
    const { data: currentMembers, error: membersErr } = await supabase
      .from("organization_members")
      .select("*")
      .eq("organization_id", auth.org.id);
    if (membersErr) throw membersErr;

    const list = (currentMembers ?? []) as { organization_id: string; user_id: string; role: string }[];
    const targetCurrent = list.find((m) => m.user_id === user_id);
    const isTargetOwner = targetCurrent?.role === "ORG_OWNER" || targetCurrent?.role === "OWNER";

    // Seul ORG_OWNER peut nommer ou modifier un ORG_OWNER
    if ((role === "ORG_OWNER" || isTargetOwner) && !canPerform(auth.access, "TRANSFER_OWNERSHIP")) {
      return res.status(403).json({ error: "Seul un propriétaire (ORG_OWNER) peut gérer le rôle ORG_OWNER.", code: "NO_RIGHTS" });
    }

    // SEC-27 : interdiction de rétrograder le dernier ORG_OWNER
    if (isTargetOwner && role !== "ORG_OWNER") {
      const otherOwners = list.filter(
        (m) => m.user_id !== user_id && (m.role === "ORG_OWNER" || m.role === "OWNER"),
      );
      if (otherOwners.length === 0) {
        return res.status(400).json({ error: "Impossible de rétrograder le dernier propriétaire (ORG_OWNER) de l'organisation." });
      }
    }

    if (targetCurrent) {
      const { error } = await supabase
        .from("organization_members")
        .update({ role })
        .eq("organization_id", auth.org.id)
        .eq("user_id", user_id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("organization_members").insert({
        organization_id: auth.org.id,
        user_id,
        role,
        created_at: new Date().toISOString(),
      });
      if (error) throw error;
    }

    invalidateMemberAccess(auth.org.id, user_id);
    invalidateMemberAccess(auth.org.slug, user_id);
    if (auth.org.discordGuildId) invalidateMemberAccess(auth.org.discordGuildId, user_id);

    return res.status(200).json({ organization_id: auth.org.id, user_id, role });
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.upsertMember");
  }
});

// DELETE /api/organizations/:orgId/members/:userId — Retirer un membre natif (SEC-27)
organizationRouter.delete("/:orgId/members/:userId", async (req, res) => {
  try {
    const auth = await resolveCallerOrgAccess(req, req.params.orgId);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }
    if (!canPerform(auth.access, "MANAGE_ORG_MEMBERS")) {
      return res.status(403).json({ error: "Action reserved to organization administrators", code: "SERVER_SETTINGS_RESERVED" });
    }

    const targetUserId = req.params.userId;
    const { data: currentMembers, error: membersErr } = await supabase
      .from("organization_members")
      .select("*")
      .eq("organization_id", auth.org.id);
    if (membersErr) throw membersErr;

    const list = (currentMembers ?? []) as { user_id: string; role: string }[];
    const targetCurrent = list.find((m) => m.user_id === targetUserId);
    if (!targetCurrent) {
      return res.status(404).json({ error: "Member not found" });
    }

    const isTargetOwner = targetCurrent.role === "ORG_OWNER" || targetCurrent.role === "OWNER";
    if (isTargetOwner && !canPerform(auth.access, "TRANSFER_OWNERSHIP")) {
      return res.status(403).json({ error: "Seul un propriétaire peut retirer un propriétaire.", code: "NO_RIGHTS" });
    }

    if (isTargetOwner) {
      const otherOwners = list.filter(
        (m) => m.user_id !== targetUserId && (m.role === "ORG_OWNER" || m.role === "OWNER"),
      );
      if (otherOwners.length === 0) {
        return res.status(400).json({ error: "Impossible de supprimer le dernier propriétaire (ORG_OWNER) de l'organisation." });
      }
    }

    const { error } = await supabase
      .from("organization_members")
      .delete()
      .eq("organization_id", auth.org.id)
      .eq("user_id", targetUserId);
    if (error) throw error;

    invalidateMemberAccess(auth.org.id, targetUserId);
    invalidateMemberAccess(auth.org.slug, targetUserId);
    if (auth.org.discordGuildId) invalidateMemberAccess(auth.org.discordGuildId, targetUserId);

    return res.status(200).json({ success: true });
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.deleteMember");
  }
});

// PUT /api/organizations/:orgId/tournaments/:tournamentId/staff — Attribuer un rôle staff de tournoi
organizationRouter.put("/:orgId/tournaments/:tournamentId/staff", async (req, res) => {
  try {
    const auth = await resolveCallerOrgAccess(req, req.params.orgId);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }
    const { tournamentId } = req.params;
    if (!canPerform(auth.access, "MANAGE_TOURNAMENT_ROLES", tournamentId)) {
      return res.status(403).json({ error: "Tournament roles are reserved to organization managers", code: "TOURNAMENT_ROLES_RESERVED" });
    }
    if (!(await verifyTournamentGuild(tournamentId, auth.org.id))) {
      return res.status(403).json({ error: "Ce tournoi n'appartient pas à cette organisation." });
    }

    const parsed = UpsertTournamentStaffSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
    }

    const { user_id, role } = parsed.data;
    const { data: existing } = await supabase
      .from("tournament_staff")
      .select("*")
      .eq("tournament_id", tournamentId)
      .eq("user_id", user_id)
      .maybeSingle();

    if (existing) {
      const { error } = await supabase
        .from("tournament_staff")
        .update({ role })
        .eq("tournament_id", tournamentId)
        .eq("user_id", user_id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("tournament_staff").insert({
        tournament_id: tournamentId,
        user_id,
        role,
        created_at: new Date().toISOString(),
      });
      if (error) throw error;
    }

    invalidateMemberAccess(auth.org.id, user_id);
    invalidateMemberAccess(auth.org.slug, user_id);
    return res.status(200).json({ tournament_id: tournamentId, user_id, role });
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.upsertTournamentStaff");
  }
});

// PUT /api/organizations/:orgId/integrations/:provider — Activer/configurer/désactiver une intégration (SEC-26/28/29)
organizationRouter.put("/:orgId/integrations/:provider", async (req, res) => {
  try {
    const auth = await resolveCallerOrgAccess(req, req.params.orgId);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, code: auth.code });
    }
    if (!canPerform(auth.access, "MANAGE_INTEGRATIONS")) {
      return res.status(403).json({ error: "Action reserved to organization administrators", code: "SERVER_SETTINGS_RESERVED" });
    }

    const providerParse = IntegrationProviderSchema.safeParse(req.params.provider);
    if (!providerParse.success) {
      return res.status(400).json({ error: "Unknown integration provider" });
    }
    const provider = providerParse.data;

    const parsed = UpdateIntegrationSchema.safeParse({ ...req.body, provider });
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
    }

    // SEC-29 : vérifier l'unicité de (provider, external_id) sur les autres organisations
    if (parsed.data.external_id) {
      const { data: conflict } = await supabase
        .from("organization_integrations")
        .select("organization_id")
        .eq("provider", provider)
        .eq("external_id", parsed.data.external_id)
        .neq("organization_id", auth.org.id)
        .maybeSingle();

      if (conflict && typeof (conflict as { organization_id?: unknown }).organization_id === "string") {
        return res.status(409).json({
          error: "Cet identifiant externe est déjà rattaché à une autre organisation.",
          code: "EXTERNAL_ID_ALREADY_LINKED",
        });
      }
    }

    const { data: existing } = await supabase
      .from("organization_integrations")
      .select("*")
      .eq("organization_id", auth.org.id)
      .eq("provider", provider)
      .maybeSingle();

    const existingRow = existing as Record<string, unknown> | null;
    const now = new Date().toISOString();
    const enabled = parsed.data.enabled ?? (existingRow ? Boolean(existingRow.enabled) : true);
    const externalId =
      parsed.data.external_id !== undefined
        ? parsed.data.external_id
        : existingRow && typeof existingRow.external_id === "string"
          ? existingRow.external_id
          : null;
    const config =
      parsed.data.config !== undefined
        ? {
            ...(existingRow && typeof existingRow.config === "object" && existingRow.config !== null
              ? (existingRow.config as Record<string, unknown>)
              : {}),
            ...parsed.data.config,
          }
        : existingRow && typeof existingRow.config === "object" && existingRow.config !== null
          ? (existingRow.config as Record<string, unknown>)
          : {};

    const integrationId =
      existingRow && typeof existingRow.id === "string" ? existingRow.id : randomUUID();
    const status = enabled ? "CONNECTED" : "DISCONNECTED";

    if (existingRow && typeof existingRow.id === "string") {
      const { error } = await supabase
        .from("organization_integrations")
        .update({
          external_id: externalId,
          enabled,
          config,
          status,
          updated_at: now,
        })
        .eq("id", integrationId);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("organization_integrations").insert({
        id: integrationId,
        organization_id: auth.org.id,
        provider,
        type: provider,
        external_id: externalId,
        enabled,
        config,
        status,
        created_at: now,
        updated_at: now,
      });
      if (error) throw error;
    }

    // SEC-28 : stockage chiffré AES-256-GCM dans la table dédiée organization_integration_secrets
    let hasSecret = false;
    if (parsed.data.secret_payload) {
      const encryptedPayload = encryptSecretPayload({ secret: parsed.data.secret_payload });
      const { data: existingSecret } = await supabase
        .from("organization_integration_secrets")
        .select("integration_id")
        .eq("integration_id", integrationId)
        .maybeSingle();

      if (existingSecret) {
        const { error: secErr } = await supabase
          .from("organization_integration_secrets")
          .update({ encrypted_payload: encryptedPayload, updated_at: now })
          .eq("integration_id", integrationId);
        if (secErr) throw secErr;
      } else {
        const { error: secErr } = await supabase.from("organization_integration_secrets").insert({
          integration_id: integrationId,
          encrypted_payload: encryptedPayload,
          key_version: 1,
          updated_at: now,
        });
        if (secErr) throw secErr;
      }
      hasSecret = true;
    }

    // SEC-26 : révocation immédiate des accès issus de l'intégration et invalidation du cache
    if (!enabled) {
      await supabase
        .from("integration_access_grants")
        .delete()
        .eq("organization_id", auth.org.id)
        .eq("provider", provider);

      if (parsed.data.cleanupExternalResources && provider === "DISCORD" && discordIntegrationPlugin.cleanupExternalResources) {
        discordIntegrationPlugin
          .cleanupExternalResources({
            organizationId: auth.org.id,
            guildId: externalId,
            discordClient: req.app?.locals?.discordClient,
            integration: {
              id: integrationId,
              organization_id: auth.org.id,
              provider,
              external_id: externalId,
              enabled,
              config,
              status,
              created_at: now,
              updated_at: now,
            },
          })
          .catch((err: unknown) => logger.error("[OrganizationRouter] Nettoyage Discord échoué:", err));
      }
    }

    invalidateGuildAccess(auth.org.id);
    invalidateGuildAccess(auth.org.slug);
    if (externalId) invalidateGuildAccess(externalId);
    if (auth.org.discordGuildId) invalidateGuildAccess(auth.org.discordGuildId);

    return res.status(200).json({
      id: integrationId,
      organization_id: auth.org.id,
      provider,
      external_id: externalId,
      enabled,
      config,
      status,
      has_secret: hasSecret,
      updated_at: now,
    });
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.updateIntegration");
  }
});
