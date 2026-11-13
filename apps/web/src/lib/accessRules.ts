// Règles d'accès et de guidage pures (sans I/O) : partagées par les pages serveur et testées unitairement.
import { canPerform, type GuildAccess, type GuildDirectoryReason, type OrganizationAccess } from "@hub/shared";

const ADMINISTRATOR = BigInt(0x8);
const MANAGE_GUILD = BigInt(0x20);

/** Permissions demandées à l'installation : salons, rôles, messages et embeds (jamais Administrateur). */
const BOT_INVITE_PERMISSIONS = (
  BigInt(0x10) | // Gérer les salons
  BigInt(0x400) | // Voir les salons
  BigInt(0x800) | // Envoyer des messages
  BigInt(0x4000) | // Intégrer des liens
  BigInt(0x10000) | // Voir l'historique
  BigInt(0x10000000) // Gérer les rôles
).toString();

/** Préfixe du cookie httpOnly qui porte le jeton du lien de partage d'un tournoi privé. */
export const TOURNAMENT_INVITE_COOKIE_PREFIX = "tournament_invite_";

export interface PrivateTournamentAccessFacts {
  isOrganizationMember: boolean;
  isTournamentStaff: boolean;
  isParticipant: boolean;
  hasValidInvite: boolean;
  /** Membre du serveur Discord rattaché, et seulement tant que l'intégration est active. */
  isActiveDiscordMember: boolean;
}

/** SEC-10 / RFC, décision 3 : les conditions d'accès à un tournoi privé, indépendantes les unes des autres. */
export function canViewPrivateTournament(facts: PrivateTournamentAccessFacts): boolean {
  return (
    facts.isOrganizationMember ||
    facts.isTournamentStaff ||
    facts.isParticipant ||
    facts.hasValidInvite ||
    facts.isActiveDiscordMember
  );
}

/** Droits de gestion visibles dans l'OAuth Discord (le rôle TO, lui, n'apparaît que dans guild_admins). */
export function canManageFromOAuth(guild: { owner: boolean; permissions: string }): boolean {
  const perms = BigInt(guild.permissions);
  return guild.owner || (perms & ADMINISTRATOR) === ADMINISTRATOR || (perms & MANAGE_GUILD) === MANAGE_GUILD;
}

export interface SetupFields {
  to_role_id: string | null;
  captain_role_id: string | null;
  registration_channel_id: string | null;
  announcement_channel_id: string | null;
  checkin_channel_id: string | null;
}

export type SetupStepKey = "toRole" | "captainRole" | "registrationChannel" | "announcementChannel" | "checkinChannel";

export function serverSetupChecklist(settings: SetupFields | null): { key: SetupStepKey; done: boolean }[] {
  return [
    { key: "toRole", done: !!settings?.to_role_id },
    { key: "captainRole", done: !!settings?.captain_role_id },
    { key: "registrationChannel", done: !!settings?.registration_channel_id },
    { key: "announcementChannel", done: !!settings?.announcement_channel_id },
    { key: "checkinChannel", done: !!settings?.checkin_channel_id },
  ];
}

export function isServerSetupComplete(settings: SetupFields | null): boolean {
  return serverSetupChecklist(settings).every((step) => step.done);
}

export interface GuildSummary {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
}

export type ManageState = "install" | "setup" | "ready";

const MANAGE_ORDER: Record<ManageState, number> = { setup: 0, ready: 1, install: 2 };

/** Portée affichée dans le hub : tout le serveur, ou seulement les tournois dont on porte le rôle TO (SEC-24). */
export type ManageScope = "server" | "tournament";

/**
 * Sépare les serveurs Discord du visiteur en deux vues :
 * - memberServers (« Mes serveurs ») : membre + bot présent, quels que soient les droits ;
 * - managedServers (panel organisateur) : droits de gestion (OAuth, ou annuaire guild_admins), bot présent ou non.
 * L'annuaire ne fait que lister : l'accès réel reste décidé par le bot (SEC-17 / SEC-24).
 */
export function splitServers<G extends GuildSummary>(
  guilds: G[],
  settings: ReadonlyMap<string, SetupFields & { bot_present: boolean }>,
  directory: ReadonlyMap<string, GuildDirectoryReason>,
): { memberServers: G[]; managedServers: { guild: G; state: ManageState; scope: ManageScope }[] } {
  const byName = (a: G, b: G) => a.name.localeCompare(b.name);
  const memberServers = guilds.filter((g) => settings.get(g.id)?.bot_present === true).sort(byName);
  const managedServers = guilds
    .filter((g) => canManageFromOAuth(g) || directory.has(g.id))
    .map((guild) => {
      const profile = settings.get(guild.id);
      const state: ManageState = !profile?.bot_present ? "install" : isServerSetupComplete(profile) ? "ready" : "setup";
      const scope: ManageScope =
        !canManageFromOAuth(guild) && directory.get(guild.id) === "TOURNAMENT_TO_ROLE" ? "tournament" : "server";
      return { guild, state, scope };
    })
    .sort((a, b) => MANAGE_ORDER[a.state] - MANAGE_ORDER[b.state] || byName(a.guild, b.guild));
  return { memberServers, managedServers };
}

export interface NextStepTournament {
  status: string;
  is_registration_open: boolean | null;
  checkin_start_at: string | null;
  checkin_end_at: string | null;
  discord_registration_channel_id: string | null;
  checkin_mode?: "ENABLED" | "DISABLED" | null;
}

export type TournamentNextStep =
  | "serverSetup"
  | "registrationChannel"
  | "structure"
  | "openRegistrations"
  | "checkinDates"
  | "waitParticipants"
  | "placementAndLaunch"
  | "runMatches";

/** Prochaine action utile pour l'organisateur, dans l'ordre des dépendances réelles du parcours. */
export function tournamentNextStep(
  t: NextStepTournament,
  ctx: { phasesCount: number; teamsCount: number; serverSetupComplete: boolean; discordEnabled?: boolean },
): TournamentNextStep | null {
  if (t.status === "ACTIVE") return "runMatches";
  if (t.status === "COMPLETED" || t.status === "ARCHIVED") return null;
  if (ctx.discordEnabled !== false) {
    if (!ctx.serverSetupComplete) return "serverSetup";
    if (!t.discord_registration_channel_id) return "registrationChannel";
  }
  if (ctx.phasesCount === 0) return "structure";
  if (!t.is_registration_open) return "openRegistrations";
  // CHK-05 (#15) : si le check-in est désactivé, on saute l'étape des dates de check-in
  if (t.checkin_mode !== "DISABLED" && (!t.checkin_start_at || !t.checkin_end_at)) return "checkinDates";
  if (ctx.teamsCount < 2) return "waitParticipants";
  return "placementAndLaunch";
}

export function buildBotInviteUrl(clientId: string, guildId?: string | null): string {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", "bot applications.commands");
  url.searchParams.set("permissions", BOT_INVITE_PERMISSIONS);
  if (guildId && /^\d+$/.test(guildId)) {
    url.searchParams.set("guild_id", guildId);
    url.searchParams.set("disable_guild_select", "true");
  }
  return url.toString();
}

/**
 * SEC-21 : tournois lisibles dans le panel. `null` = tous les tournois du serveur / organisation (niveau SERVER / ORGANIZATION) ;
 * sinon, uniquement ceux dont le membre porte le rôle TO (niveau TOURNAMENT).
 */
export function managedTournamentIds(access: GuildAccess | OrganizationAccess): readonly string[] | null {
  return access.level === "SERVER" || access.level === "ORGANIZATION" ? null : access.tournamentIds;
}

/** Actions de niveau serveur / organisation affichées dans le panel (le bot refuse de toute façon les autres, SEC-21). */
export function panelCapabilities(access: GuildAccess | OrganizationAccess): { canCreate: boolean; canDelete: boolean; canConfigureServer: boolean } {
  return {
    canCreate: canPerform(access, "CREATE_TOURNAMENT"),
    // DELETE_TOURNAMENT ne dépend pas du tournoi au niveau SERVER/ORGANIZATION et est toujours refusé au niveau TOURNAMENT.
    canDelete: (access.level === "SERVER" || access.level === "ORGANIZATION") && canPerform(access, "DELETE_TOURNAMENT"),
    canConfigureServer: canPerform(access, "MANAGE_SERVER_SETTINGS"),
  };
}

/** Paramètres des listes Discord (rôles, salons, membres) : un TO de tournoi doit désigner son tournoi. */
export function discordListQuery(guildId: string, tournamentId?: string): string {
  const params = new URLSearchParams({ guildId });
  if (tournamentId) params.set("tournamentId", tournamentId);
  return params.toString();
}

/**
 * Entrée du panel depuis le hub. Un TO de tournoi va toujours sur la liste filtrée de ses tournois (jamais sur les
 * paramètres serveur, qui lui sont refusés) ; `null` : pas de lien, il faut d'abord installer le bot.
 */
export function panelEntryPath(guildId: string, state: ManageState, scope: ManageScope): string | null {
  if (scope === "tournament") return `/admin/${guildId}/tournaments`;
  if (state === "install") return null;
  return state === "setup" ? `/admin/${guildId}/settings` : `/admin/${guildId}`;
}
