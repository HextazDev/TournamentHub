import { cache } from "react";
import { getServerSession } from "next-auth";
import { canPerform, type ServerSettings, type Tournament } from "@hub/shared";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { canViewTournament } from "@/lib/accessRules";
import { checkGuildAdminAccess, type GuildAdminAccess } from "@/lib/guildAccess";
import { resolveServerBotApiUrl } from "@/lib/config";

// Accès serveur uniquement : ce module lit la session NextAuth et utilise la clé service_role.
// Toute lecture via supabaseAdmin DOIT passer par une des vérifications ci-dessous (SEC-10 / SEC-11).

export interface DiscordGuildSummary {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
}

export interface Viewer {
  discordId: string | null;
  /** null si non connecté ou si Discord n'a pas répondu (guildsError). */
  guilds: DiscordGuildSummary[] | null;
  guildsError: boolean;
}

interface SessionWithDiscord {
  accessToken?: string;
  user?: { id?: string };
}

export const getViewer = cache(async (): Promise<Viewer> => {
  const session = (await getServerSession(authOptions)) as SessionWithDiscord | null;
  const discordId = session?.user?.id ?? null;
  if (!session?.accessToken || !discordId) return { discordId: null, guilds: null, guildsError: false };

  const res = await fetch("https://discord.com/api/users/@me/guilds", {
    headers: { Authorization: `Bearer ${session.accessToken}` },
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) {
    console.error("[viewer] Discord guilds fetch failed:", res?.status ?? "network error");
    return { discordId, guilds: null, guildsError: true };
  }
  return { discordId, guilds: (await res.json()) as DiscordGuildSummary[], guildsError: false };
});

export function memberGuildIds(viewer: Viewer): Set<string> {
  return new Set((viewer.guilds ?? []).map((g) => g.id));
}

export type { GuildAdminAccess };

/**
 * Règle unique d'accès au back-office (bouton du hub, layout admin, pages admin, suppression) — SEC-11 / SEC-17.
 * Le bot décide en direct (même décision et même cache que ses routes de mutation) : une page n'est jamais
 * visible quand l'action correspondante serait refusée. guild_admins ne sert qu'à lister les serveurs du hub.
 * Sans bot joignable, l'accès est refusé (CHECK_FAILED).
 */
export const getGuildAdminAccess = cache(async (guildId: string): Promise<GuildAdminAccess> => {
  const { discordId } = await getViewer();
  return checkGuildAdminAccess({
    guildId,
    discordId,
    botApiUrl: resolveServerBotApiUrl(),
    botApiSecret: process.env.BOT_API_SECRET,
    fetchImpl: fetch,
  });
});

export type ServerProfile = ServerSettings & {
  organization_id?: string;
  slug?: string;
  discord_enabled?: boolean;
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const getServerProfile = cache(async (guildIdOrSlug: string): Promise<ServerProfile | null> => {
  let orgRow: Record<string, unknown> | null = null;

  if (UUID_REGEX.test(guildIdOrSlug)) {
    const { data } = await supabaseAdmin.from("organizations").select("*").eq("id", guildIdOrSlug).maybeSingle();
    if (data) orgRow = data as Record<string, unknown>;
  }
  // SEC-01 : résoudre l'external_id Discord AVANT le slug pour empêcher le squat de snowflakes
  if (!orgRow) {
    const { data: intRow } = await supabaseAdmin
      .from("organization_integrations")
      .select("organization_id")
      .eq("provider", "DISCORD")
      .eq("external_id", guildIdOrSlug)
      .maybeSingle();
    if (intRow?.organization_id) {
      const { data } = await supabaseAdmin.from("organizations").select("*").eq("id", intRow.organization_id).maybeSingle();
      if (data) orgRow = data as Record<string, unknown>;
    }
  }
  // Slug en dernier
  if (!orgRow) {
    const { data } = await supabaseAdmin.from("organizations").select("*").eq("slug", guildIdOrSlug).maybeSingle();
    if (data) orgRow = data as Record<string, unknown>;
  }

  if (orgRow && typeof orgRow.id === "string" && typeof orgRow.slug === "string") {
    const { data: discordInt } = await supabaseAdmin
      .from("organization_integrations")
      .select("*")
      .eq("organization_id", orgRow.id)
      .eq("provider", "DISCORD")
      .maybeSingle();

    const cfg = (discordInt?.config ?? {}) as Record<string, unknown>;
    const discordEnabled = Boolean(discordInt?.enabled);
    const externalGuildId = typeof discordInt?.external_id === "string" ? discordInt.external_id : orgRow.slug;

    return {
      guild_id: externalGuildId,
      guild_name: typeof orgRow.name === "string" ? orgRow.name : orgRow.slug,
      guild_icon: typeof orgRow.icon_url === "string" ? orgRow.icon_url : null,
      bot_present: discordEnabled && Boolean(cfg.bot_present ?? true),
      to_role_id: typeof cfg.to_role_id === "string" ? cfg.to_role_id : null,
      captain_role_id: typeof cfg.captain_role_id === "string" ? cfg.captain_role_id : null,
      registration_channel_id: typeof cfg.registration_channel_id === "string" ? cfg.registration_channel_id : null,
      announcement_channel_id: typeof cfg.announcement_channel_id === "string" ? cfg.announcement_channel_id : null,
      checkin_channel_id: typeof cfg.checkin_channel_id === "string" ? cfg.checkin_channel_id : null,
      language: orgRow.language === "en" ? "en" : "fr",
      invite_url:
        typeof orgRow.invite_url === "string"
          ? orgRow.invite_url
          : typeof orgRow.public_contact_url === "string"
            ? orgRow.public_contact_url
            : null,
      updated_at: typeof orgRow.updated_at === "string" ? orgRow.updated_at : new Date().toISOString(),
      organization_id: orgRow.id,
      slug: orgRow.slug,
      discord_enabled: discordEnabled,
    };
  }

  return null;
});

/** Tournoi lisible par le visiteur (public, ou privé dont il est membre), sinon null ➜ 404. */
export const getReadableTournament = cache(async (guildId: string, tournamentId: string): Promise<Tournament | null> => {
  const { data, error } = await supabaseAdmin.from("tournaments").select("*").eq("id", tournamentId).maybeSingle();
  if (error) {
    // Un UUID mal formé est une simple URL invalide, pas une panne.
    if (error.code === "22P02") return null;
    throw new Error(`tournament read failed: ${error.message}`);
  }
  if (!data) return null;
  const tournament = data as Tournament & { organization_id?: string | null };
  const profile = await getServerProfile(guildId);
  const matchesRoute = Boolean(profile?.organization_id && tournament.organization_id === profile.organization_id);

  if (!matchesRoute) return null;
  if (tournament.is_public) return tournament;

  const viewer = await getViewer();
  const memberIds = memberGuildIds(viewer);
  if (viewer.discordId && profile?.organization_id) {
    const { data: memberRow } = await supabaseAdmin
      .from("organization_members")
      .select("role")
      .eq("organization_id", profile.organization_id)
      .eq("user_id", viewer.discordId)
      .maybeSingle();
    if (memberRow) memberIds.add(profile.organization_id);
  }
  return canViewTournament(
    { guild_id: tournament.guild_id, organization_id: tournament.organization_id ?? null, is_public: tournament.is_public },
    matchesRoute ? tournament.guild_id : guildId,
    memberIds,
  )
    ? tournament
    : null;
});

/** Tournoi géré : l'utilisateur peut gérer ce tournoi ET il appartient au serveur / à l'organisation (SEC-01 côté lecture). */
export const getManagedTournament = cache(async (guildId: string, tournamentId: string): Promise<Tournament | null> => {
  const access = await getGuildAdminAccess(guildId);
  if (!access.allowed || !canPerform(access.access, "MANAGE_TOURNAMENT", tournamentId)) return null;
  const { data, error } = await supabaseAdmin
    .from("tournaments")
    .select("*")
    .eq("id", tournamentId)
    .maybeSingle();
  if (error) {
    if (error.code === "22P02") return null;
    throw new Error(`tournament read failed: ${error.message}`);
  }
  if (!data) return null;
  const row = data as Tournament & { organization_id?: string | null };
  const profile = await getServerProfile(guildId);
  if (profile?.organization_id && row.organization_id === profile.organization_id) {
    return row;
  }
  return null;
});
