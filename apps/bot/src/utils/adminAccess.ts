import type { GuildAdminReason } from "@hub/shared";

export interface AdminSignals {
  isOwner: boolean;
  hasAdministrator: boolean;
  hasManageGuild: boolean;
  hasToRole: boolean;
}

/**
 * Règle unique d'accès au back-office d'un serveur (SEC-04 / SEC-11).
 * Utilisée par requireGuildAdmin, /api/discord/permissions et la synchronisation de guild_admins.
 */
export function resolveAdminReason(signals: AdminSignals): GuildAdminReason | null {
  if (signals.isOwner) return "SERVER_OWNER";
  if (signals.hasAdministrator) return "ADMINISTRATOR";
  if (signals.hasManageGuild) return "MANAGE_GUILD";
  if (signals.hasToRole) return "TO_ROLE";
  return null;
}
