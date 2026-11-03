import { cache } from "react";
import { getServerSession } from "next-auth";
import { canPerform, type ServerSettings, type Tournament } from "@hub/shared";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { canViewTournament } from "@/lib/accessRules";
import { checkGuildAdminAccess, type GuildAdminAccess } from "@/lib/guildAccess";

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
    botApiUrl: process.env.NEXT_PUBLIC_BOT_API_URL || "http://localhost:8080",
    botApiSecret: process.env.BOT_API_SECRET,
    fetchImpl: fetch,
  });
});

export const getServerProfile = cache(async (guildId: string): Promise<ServerSettings | null> => {
  const { data, error } = await supabaseAdmin.from("server_settings").select("*").eq("guild_id", guildId).maybeSingle();
  if (error) throw new Error(`server_settings read failed: ${error.message}`);
  return data as ServerSettings | null;
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
  const tournament = data as Tournament;
  if (tournament.is_public && tournament.guild_id === guildId) return tournament;
  return canViewTournament(tournament, guildId, memberGuildIds(await getViewer())) ? tournament : null;
});

/** Tournoi géré : l'utilisateur peut gérer ce tournoi ET il appartient au serveur (SEC-01 côté lecture). */
export const getManagedTournament = cache(async (guildId: string, tournamentId: string): Promise<Tournament | null> => {
  const access = await getGuildAdminAccess(guildId);
  if (!access.allowed || !canPerform(access.access, "MANAGE_TOURNAMENT", tournamentId)) return null;
  const { data, error } = await supabaseAdmin
    .from("tournaments")
    .select("*")
    .eq("id", tournamentId)
    .eq("guild_id", guildId)
    .maybeSingle();
  if (error) {
    if (error.code === "22P02") return null;
    throw new Error(`tournament read failed: ${error.message}`);
  }
  return data as Tournament | null;
});
