import type { Client, Guild, GuildMember, Role } from "discord.js";
import type { Team } from "@hub/shared";
import { supabase } from "../lib/supabase";
import { logger } from "../utils/logger";

/**
 * Présence d'un capitaine checké : pseudo = nom d'équipe + rôle Capitaine du tournoi.
 * Le pseudo et le rôle sont traités indépendamment : l'échec de l'un n'empêche jamais l'autre (DISC-09).
 * Chaque échec est remonté dans le rapport et journalisé en `warn` structuré (aucun succès annoncé à tort).
 */
export type PresenceTeam = Pick<Team, "id" | "tournament_id" | "name" | "captain_discord_id">;

export type NicknameOutcome = "applied" | "unchanged" | "not_manageable" | "failed";
export type RoleOutcome = "applied" | "unchanged" | "not_configured" | "not_found" | "above_bot" | "failed";
export type PresenceSkipReason = "tournament_not_found" | "guild_unavailable" | "member_unavailable";

export type PresenceReport =
  | { status: "skipped"; reason: PresenceSkipReason }
  | { status: "done"; nickname: NicknameOutcome; role: RoleOutcome };

const NICKNAME_MAX_LENGTH = 32;
const APPLY_REASON = "Check-in au Tournoi";
const REMOVE_REASON = "Annulation du Check-in / Changement d'équipe";

const NICKNAME_FAILURES: ReadonlySet<NicknameOutcome> = new Set(["not_manageable", "failed"]);
const ROLE_FAILURES: ReadonlySet<RoleOutcome> = new Set(["not_found", "above_bot", "failed"]);

export function hasPresenceFailure(report: PresenceReport): boolean {
  if (report.status === "skipped") return true;
  return NICKNAME_FAILURES.has(report.nickname) || ROLE_FAILURES.has(report.role);
}

interface PresenceContext {
  guildId: string;
  teamId: string;
}

function discordCode(error: unknown): number | string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "number" || typeof code === "string") return code;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warn(message: string, ctx: PresenceContext, reason: string, error?: unknown) {
  logger.warn(`[CaptainPresence] ${message}`, {
    ...ctx,
    reason,
    ...(error === undefined ? {} : { code: discordCode(error), error: errorMessage(error) }),
  });
}

function teamNickname(team: PresenceTeam): string {
  return team.name.substring(0, NICKNAME_MAX_LENGTH);
}

interface ResolvedTarget {
  ctx: PresenceContext;
  guild: Guild;
  member: GuildMember;
  roleId: string | null;
}

async function resolveTarget(client: Client, team: PresenceTeam): Promise<ResolvedTarget | PresenceSkipReason> {
  const { data: tourney, error } = await supabase
    .from("tournaments")
    .select("guild_id, discord_captain_role_id")
    .eq("id", team.tournament_id)
    .single();

  if (error || !tourney?.guild_id) {
    logger.error(`[CaptainPresence] Tournament lookup failed`, { teamId: team.id, tournamentId: team.tournament_id, error });
    return "tournament_not_found";
  }

  const ctx: PresenceContext = { guildId: tourney.guild_id, teamId: team.id };

  let guild: Guild;
  try {
    guild = await client.guilds.fetch(tourney.guild_id);
  } catch (fetchError) {
    warn("Discord guild unavailable", ctx, "guild_unavailable", fetchError);
    return "guild_unavailable";
  }

  let member: GuildMember;
  try {
    member = await guild.members.fetch(team.captain_discord_id);
  } catch (fetchError) {
    warn("Captain is not a member of the guild", ctx, "member_unavailable", fetchError);
    return "member_unavailable";
  }

  return { ctx, guild, member, roleId: tourney.discord_captain_role_id ?? null };
}

/** Cache d'abord, puis Discord : un cache froid ne doit pas faire échouer l'attribution (DISC-10). */
async function resolveRole(guild: Guild, roleId: string, ctx: PresenceContext): Promise<Role | null> {
  const cached = guild.roles.cache.get(roleId);
  if (cached) return cached;
  try {
    const fetched = await guild.roles.fetch(roleId);
    if (fetched) return fetched;
  } catch (fetchError) {
    warn("Captain role fetch failed", ctx, "role_not_found", fetchError);
    return null;
  }
  warn("Captain role not found on the guild", ctx, "role_not_found");
  return null;
}

async function setTeamNickname(member: GuildMember, team: PresenceTeam, ctx: PresenceContext): Promise<NicknameOutcome> {
  const nickname = teamNickname(team);
  if (member.nickname === nickname || member.displayName === nickname) return "unchanged";
  if (!member.manageable) {
    warn("Captain cannot be renamed (server owner or highest role above the bot)", ctx, "member_not_manageable");
    return "not_manageable";
  }
  try {
    await member.setNickname(nickname, APPLY_REASON);
    return "applied";
  } catch (error) {
    warn("Discord rejected the nickname update", ctx, "nickname_failed", error);
    return "failed";
  }
}

async function clearTeamNickname(member: GuildMember, team: PresenceTeam, ctx: PresenceContext): Promise<NicknameOutcome> {
  if (member.nickname !== teamNickname(team)) return "unchanged";
  if (!member.manageable) {
    warn("Captain nickname cannot be reset (server owner or highest role above the bot)", ctx, "member_not_manageable");
    return "not_manageable";
  }
  try {
    await member.setNickname(null, REMOVE_REASON);
    return "applied";
  } catch (error) {
    warn("Discord rejected the nickname reset", ctx, "nickname_failed", error);
    return "failed";
  }
}

async function updateCaptainRole(target: ResolvedTarget, mode: "add" | "remove"): Promise<RoleOutcome> {
  const { guild, member, roleId, ctx } = target;
  if (!roleId) return "not_configured";

  const hasRole = member.roles.cache.has(roleId);
  if (mode === "add" ? hasRole : !hasRole) return "unchanged";

  const role = await resolveRole(guild, roleId, ctx);
  if (!role) return "not_found";
  if (!role.editable) {
    warn("Captain role is above the bot's highest role", ctx, "role_above_bot");
    return "above_bot";
  }
  try {
    if (mode === "add") await member.roles.add(role, APPLY_REASON);
    else await member.roles.remove(role, REMOVE_REASON);
    return "applied";
  } catch (error) {
    warn(`Discord rejected the captain role ${mode}`, ctx, `role_${mode}_failed`, error);
    return "failed";
  }
}

export async function applyPresence(client: Client, team: PresenceTeam): Promise<PresenceReport> {
  const target = await resolveTarget(client, team);
  if (typeof target === "string") return { status: "skipped", reason: target };

  const nickname = await setTeamNickname(target.member, team, target.ctx);
  const role = await updateCaptainRole(target, "add");
  logger.info(`[CaptainPresence] applyPresence done`, { ...target.ctx, nickname, role });
  return { status: "done", nickname, role };
}

export async function removePresence(client: Client, team: PresenceTeam): Promise<PresenceReport> {
  const target = await resolveTarget(client, team);
  if (typeof target === "string") return { status: "skipped", reason: target };

  const nickname = await clearTeamNickname(target.member, team, target.ctx);
  const role = await updateCaptainRole(target, "remove");
  logger.info(`[CaptainPresence] removePresence done`, { ...target.ctx, nickname, role });
  return { status: "done", nickname, role };
}
