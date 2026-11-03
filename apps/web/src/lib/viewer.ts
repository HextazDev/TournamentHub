import { cache } from "react";
import { z } from "zod";
import { getServerSession } from "next-auth";
import type { GuildAdminReason, ServerSettings, Tournament } from "@hub/shared";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { canViewTournament } from "@/lib/accessRules";

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

export type GuildAdminAccess =
  | { allowed: true; reason: GuildAdminReason }
  | { allowed: false; reason: "NOT_LOGGED_IN" | "NOT_A_MEMBER" | "NO_RIGHTS" | "BOT_NOT_IN_GUILD" | "CHECK_FAILED" };

// Miroir local de GuildAdminReason (@hub/shared embarque zod 3, le web zod 4 : les schémas ne se mélangent pas).
const GuildAdminReasonSchema = z.enum(["SERVER_OWNER", "ADMINISTRATOR", "MANAGE_GUILD", "TO_ROLE"]) satisfies z.ZodType<GuildAdminReason>;

const PermissionResponseSchema = z.discriminatedUnion("hasPermission", [
  z.object({ hasPermission: z.literal(true), reason: GuildAdminReasonSchema }),
  z.object({ hasPermission: z.literal(false), reason: z.enum(["NOT_A_MEMBER", "NO_RIGHTS", "BOT_NOT_IN_GUILD"]) }),
]);

/**
 * Règle unique d'accès au back-office (bouton du hub, layout admin, pages admin) — SEC-11.
 * 1. guild_admins (synchronisée par le bot : propriétaire, Administrateur, Gérer le serveur, rôle TO) ;
 * 2. sinon vérification en direct par le bot (rôle TO attribué pendant que le bot était hors ligne, etc.).
 */
export const getGuildAdminAccess = cache(async (guildId: string): Promise<GuildAdminAccess> => {
  const { discordId } = await getViewer();
  if (!discordId) return { allowed: false, reason: "NOT_LOGGED_IN" };

  const { data: row, error } = await supabaseAdmin
    .from("guild_admins")
    .select("reason")
    .eq("guild_id", guildId)
    .eq("discord_id", discordId)
    .maybeSingle();
  if (error) console.error("[access] guild_admins read failed:", error);
  const storedReason = GuildAdminReasonSchema.safeParse(row?.reason);
  if (storedReason.success) return { allowed: true, reason: storedReason.data };

  const botApiSecret = process.env.BOT_API_SECRET;
  if (!botApiSecret) {
    console.error("[access] BOT_API_SECRET is missing");
    return { allowed: false, reason: "CHECK_FAILED" };
  }
  const botApiUrl = process.env.NEXT_PUBLIC_BOT_API_URL || "http://localhost:8080";
  const params = new URLSearchParams({ guildId, userId: discordId });
  const res = await fetch(`${botApiUrl}/api/discord/permissions?${params}`, {
    headers: { Authorization: `Bearer ${botApiSecret}` },
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) {
    console.error("[access] Bot permission check failed:", res?.status ?? "network error");
    return { allowed: false, reason: "CHECK_FAILED" };
  }

  const parsed = PermissionResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    console.error("[access] Unexpected bot permission payload:", parsed.error.message);
    return { allowed: false, reason: "CHECK_FAILED" };
  }
  return parsed.data.hasPermission
    ? { allowed: true, reason: parsed.data.reason }
    : { allowed: false, reason: parsed.data.reason };
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

/** Tournoi géré : l'utilisateur administre le serveur ET le tournoi lui appartient (SEC-01 côté lecture). */
export const getManagedTournament = cache(async (guildId: string, tournamentId: string): Promise<Tournament | null> => {
  const access = await getGuildAdminAccess(guildId);
  if (!access.allowed) return null;
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
