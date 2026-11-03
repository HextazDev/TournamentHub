// Règles d'accès et de guidage pures (sans I/O) : partagées par les pages serveur et testées unitairement.

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

export interface TournamentVisibility {
  guild_id: string;
  is_public: boolean | null;
}

/**
 * SEC-10 : un tournoi est lisible s'il est public, ou si le visiteur est membre de son serveur.
 * L'URL doit en plus désigner le bon serveur, pour qu'aucun lien ne présente un tournoi sous un autre organisateur.
 */
export function canViewTournament(
  tournament: TournamentVisibility,
  routeGuildId: string,
  memberGuildIds: ReadonlySet<string>,
): boolean {
  if (tournament.guild_id !== routeGuildId) return false;
  return tournament.is_public === true || memberGuildIds.has(tournament.guild_id);
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

/**
 * Sépare les serveurs Discord du visiteur en deux vues :
 * - memberServers (« Mes serveurs ») : membre + bot présent, quels que soient les droits ;
 * - managedServers (panel organisateur) : droits de gestion (OAuth ou rôle TO via guild_admins), bot présent ou non.
 */
export function splitServers<G extends GuildSummary>(
  guilds: G[],
  settings: ReadonlyMap<string, SetupFields & { bot_present: boolean }>,
  adminOf: ReadonlySet<string>,
): { memberServers: G[]; managedServers: { guild: G; state: ManageState }[] } {
  const byName = (a: G, b: G) => a.name.localeCompare(b.name);
  const memberServers = guilds.filter((g) => settings.get(g.id)?.bot_present === true).sort(byName);
  const managedServers = guilds
    .filter((g) => canManageFromOAuth(g) || adminOf.has(g.id))
    .map((guild) => {
      const profile = settings.get(guild.id);
      const state: ManageState = !profile?.bot_present ? "install" : isServerSetupComplete(profile) ? "ready" : "setup";
      return { guild, state };
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
  ctx: { phasesCount: number; teamsCount: number; serverSetupComplete: boolean },
): TournamentNextStep | null {
  if (t.status === "ACTIVE") return "runMatches";
  if (t.status === "COMPLETED" || t.status === "ARCHIVED") return null;
  if (!ctx.serverSetupComplete) return "serverSetup";
  if (!t.discord_registration_channel_id) return "registrationChannel";
  if (ctx.phasesCount === 0) return "structure";
  if (!t.is_registration_open) return "openRegistrations";
  if (!t.checkin_start_at || !t.checkin_end_at) return "checkinDates";
  if (ctx.teamsCount < 2) return "waitParticipants";
  return "placementAndLaunch";
}

export function buildBotInviteUrl(clientId: string, guildId: string): string {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", "bot applications.commands");
  url.searchParams.set("permissions", BOT_INVITE_PERMISSIONS);
  url.searchParams.set("guild_id", guildId);
  url.searchParams.set("disable_guild_select", "true");
  return url.toString();
}
