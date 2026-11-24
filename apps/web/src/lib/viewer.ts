import { createHash } from "node:crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { canPerform, isDiscordSnowflake, type ServerSettings, type Tournament } from "@hub/shared";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { canViewPrivateTournament, TOURNAMENT_INVITE_COOKIE_PREFIX } from "@/lib/accessRules";
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

/**
 * Discord limite fortement /users/@me/guilds : sans cache, naviguer dans le site suffit à déclencher des 429.
 * En cas d'échec, la dernière liste connue reste utilisée plutôt que de priver le visiteur de ses droits Discord.
 */
const GUILDS_CACHE_TTL_MS = 60_000;
const GUILDS_CACHE_MAX_ENTRIES = 5_000;
const guildsCache = new Map<string, { guilds: DiscordGuildSummary[]; fetchedAt: number }>();

async function fetchViewerGuilds(discordId: string, accessToken: string): Promise<DiscordGuildSummary[] | null> {
  const cached = guildsCache.get(discordId);
  if (cached && Date.now() - cached.fetchedAt < GUILDS_CACHE_TTL_MS) return cached.guilds;

  const res = await fetch("https://discord.com/api/users/@me/guilds", {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) {
    console.warn("[viewer] Discord guilds fetch failed:", res?.status ?? "network error");
    return cached?.guilds ?? null;
  }

  const guilds = (await res.json()) as DiscordGuildSummary[];
  if (guildsCache.size >= GUILDS_CACHE_MAX_ENTRIES) guildsCache.clear();
  guildsCache.set(discordId, { guilds, fetchedAt: Date.now() });
  return guilds;
}

export interface ViewerSession {
  discordId: string | null;
  accessToken: string | null;
}

/**
 * Lit uniquement la session NextAuth (cookie JWT local, 0 appel réseau).
 * À préférer à getViewer() dès que la liste des serveurs Discord n'est pas nécessaire.
 */
export const getViewerSession = cache(async (): Promise<ViewerSession> => {
  const session = (await getServerSession(authOptions)) as SessionWithDiscord | null;
  const discordId = session?.user?.id ?? null;
  const accessToken = session?.accessToken ?? null;
  if (!discordId) return { discordId: null, accessToken: null };
  return { discordId, accessToken };
});

export const getViewer = cache(async (): Promise<Viewer> => {
  const { discordId, accessToken } = await getViewerSession();
  if (!accessToken || !discordId) return { discordId: null, guilds: null, guildsError: false };

  const guilds = await fetchViewerGuilds(discordId, accessToken);
  return guilds ? { discordId, guilds, guildsError: false } : { discordId, guilds: null, guildsError: true };
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
  const { discordId } = await getViewerSession();
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
  discord_status?: string | null;
  discord_last_error?: string | null;
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractDiscordIntegration(orgRow: Record<string, unknown>): Record<string, unknown> | null {
  const embedded = orgRow.organization_integrations;
  if (Array.isArray(embedded)) {
    const match = embedded.find(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && (item as Record<string, unknown>).provider === "DISCORD",
    );
    return match ?? null;
  }
  if (typeof embedded === "object" && embedded !== null && (embedded as Record<string, unknown>).provider === "DISCORD") {
    return embedded as Record<string, unknown>;
  }
  return null;
}

function buildServerProfile(
  orgRow: Record<string, unknown>,
  discordInt: Record<string, unknown> | null,
): ServerProfile | null {
  if (typeof orgRow.id !== "string" || typeof orgRow.slug !== "string") return null;

  const cfg = (typeof discordInt?.config === "object" && discordInt.config !== null
    ? discordInt.config
    : {}) as Record<string, unknown>;
  const discordEnabled = Boolean(discordInt?.enabled && discordInt.external_id);
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
    discord_status: typeof discordInt?.status === "string" ? discordInt.status : null,
    discord_last_error: typeof discordInt?.last_error === "string" ? discordInt.last_error : null,
  };
}

export const getServerProfile = cache(async (guildIdOrSlug: string): Promise<ServerProfile | null> => {
  if (UUID_REGEX.test(guildIdOrSlug)) {
    const { data, error } = await supabaseAdmin
      .from("organizations")
      .select("*, organization_integrations(*)")
      .eq("id", guildIdOrSlug)
      .maybeSingle();
    if (error) throw new Error(`organization read failed: ${error.message}`);
    if (data) {
      const orgRow = data as Record<string, unknown>;
      return buildServerProfile(orgRow, extractDiscordIntegration(orgRow));
    }
    return null;
  }

  // SEC-01 : résoudre l'external_id Discord AVANT le slug pour empêcher le squat de snowflakes.
  if (isDiscordSnowflake(guildIdOrSlug)) {
    const { data: intData, error: intError } = await supabaseAdmin
      .from("organization_integrations")
      .select("*, organizations(*)")
      .eq("provider", "DISCORD")
      .eq("external_id", guildIdOrSlug)
      .maybeSingle();
    if (intError) throw new Error(`organization integration read failed: ${intError.message}`);
    if (intData) {
      const intRow = intData as Record<string, unknown>;
      const linkedOrg = Array.isArray(intRow.organizations) ? intRow.organizations[0] : intRow.organizations;
      if (typeof linkedOrg === "object" && linkedOrg !== null) {
        return buildServerProfile(linkedOrg as Record<string, unknown>, intRow);
      }
    }
  }

  // Slug par défaut (1 seule requête jointe organisation + intégrations)
  const { data: slugData, error: slugError } = await supabaseAdmin
    .from("organizations")
    .select("*, organization_integrations(*)")
    .eq("slug", guildIdOrSlug)
    .maybeSingle();
  if (slugError) throw new Error(`organization read failed: ${slugError.message}`);
  if (slugData) {
    const orgRow = slugData as Record<string, unknown>;
    return buildServerProfile(orgRow, extractDiscordIntegration(orgRow));
  }

  return null;
});

/** Tournoi lisible par le visiteur (public, ou privé dont il est membre), sinon null ➜ 404. */
export const getReadableTournament = cache(async (guildId: string, tournamentId: string): Promise<Tournament | null> => {
  const [tournamentRes, profile] = await Promise.all([
    supabaseAdmin.from("tournaments").select("*").eq("id", tournamentId).maybeSingle(),
    getServerProfile(guildId),
  ]);
  const { data, error } = tournamentRes;
  if (error) {
    // Un UUID mal formé est une simple URL invalide, pas une panne.
    if (error.code === "22P02") return null;
    throw new Error(`tournament read failed: ${error.message}`);
  }
  if (!data) return null;
  const tournament = data as Tournament & { organization_id?: string | null };
  const matchesRoute = Boolean(profile?.organization_id && tournament.organization_id === profile.organization_id);

  if (!matchesRoute) return null;
  if (tournament.is_public) return tournament;

  const organizationId = profile?.organization_id;
  if (!organizationId) return null;

  // Évite tout appel Discord /users/@me/guilds sur les tournois privés d'organisations Web autonomes.
  const [viewerIdentity, inviteToken] = await Promise.all([
    profile.discord_enabled ? getViewer() : getViewerSession(),
    getTournamentInviteToken(tournamentId),
  ]);
  const discordId = viewerIdentity.discordId;
  const facts = await Promise.all([
    discordId
      ? supabaseAdmin.from("organization_members").select("role").eq("organization_id", organizationId).eq("user_id", discordId).maybeSingle()
      : null,
    discordId
      ? supabaseAdmin.from("tournament_staff").select("role").eq("tournament_id", tournamentId).eq("user_id", discordId).maybeSingle()
      : null,
    discordId
      ? supabaseAdmin.from("teams").select("id").eq("tournament_id", tournamentId).eq("captain_discord_id", discordId).limit(1)
      : null,
    discordId
      ? supabaseAdmin.from("team_members").select("id, teams!inner(tournament_id)").eq("teams.tournament_id", tournamentId).eq("user_id", discordId).limit(1)
      : null,
    inviteToken
      ? supabaseAdmin
          .from("tournament_invite_tokens")
          .select("tournament_id")
          .eq("tournament_id", tournamentId)
          .eq("token_hash", createHash("sha256").update(inviteToken).digest("hex"))
          .maybeSingle()
      : null,
  ]);
  const [memberRes, staffRes, captainRes, playerRes, inviteRes] = facts;
  for (const result of facts) {
    if (result?.error) throw new Error(`private tournament check failed: ${result.error.message}`);
  }

  // SEC-26 : l'appartenance au serveur Discord ne compte que tant que l'intégration est active.
  const isActiveDiscordMember = Boolean(
    profile.discord_enabled && "guilds" in viewerIdentity && memberGuildIds(viewerIdentity).has(profile.guild_id),
  );

  return canViewPrivateTournament({
    isOrganizationMember: Boolean(memberRes?.data),
    isTournamentStaff: Boolean(staffRes?.data),
    isParticipant: Boolean(captainRes?.data?.length || playerRes?.data?.length),
    hasValidInvite: Boolean(inviteRes?.data),
    isActiveDiscordMember,
  })
    ? tournament
    : null;
});

/** Jeton du lien de partage déposé par /api/tournament-invite, à revalider à chaque usage (il peut avoir été révoqué). */
export async function getTournamentInviteToken(tournamentId: string): Promise<string | null> {
  const store = await cookies();
  return store.get(`${TOURNAMENT_INVITE_COOKIE_PREFIX}${tournamentId}`)?.value ?? null;
}

/** Tournoi géré : l'utilisateur peut gérer ce tournoi ET il appartient au serveur / à l'organisation (SEC-01 côté lecture). */
export const getManagedTournament = cache(async (guildId: string, tournamentId: string): Promise<Tournament | null> => {
  const access = await getGuildAdminAccess(guildId);
  if (!access.allowed || !canPerform(access.access, "MANAGE_TOURNAMENT", tournamentId)) return null;

  const [tournamentRes, profile] = await Promise.all([
    supabaseAdmin.from("tournaments").select("*").eq("id", tournamentId).maybeSingle(),
    getServerProfile(guildId),
  ]);
  const { data, error } = tournamentRes;
  if (error) {
    if (error.code === "22P02") return null;
    throw new Error(`tournament read failed: ${error.message}`);
  }
  if (!data) return null;
  const row = data as Tournament & { organization_id?: string | null };
  if (profile?.organization_id && row.organization_id === profile.organization_id) {
    return row;
  }
  return null;
});
