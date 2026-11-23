import { logger } from "../utils/logger";
import { GuildRegistryService, type GuildLike } from "./GuildRegistryService";
import { invalidateGuildAccess } from "./MemberAccessService";
import { resolveOrganization } from "../utils/tenant";

/** Sous-ensemble du client Discord nécessaire à la resynchronisation (facilite les tests). */
export interface GuildFetcher {
  guilds: { fetch(guildId: string): Promise<GuildLike> };
}

async function resyncDirectory(client: GuildFetcher, tenantId: string): Promise<void> {
  const org = await resolveOrganization(tenantId);
  if (!org) return;
  // Une même décision est mise en cache sous chaque identifiant de l'organisation (UUID, slug, serveur).
  invalidateGuildAccess(org.id);
  invalidateGuildAccess(org.slug);
  if (org.discordGuildId) invalidateGuildAccess(org.discordGuildId);
  // Organisation sans Discord actif : aucun annuaire à reconstruire.
  if (!org.discordEnabled || !org.discordGuildId) return;

  const guild = await client.guilds.fetch(org.discordGuildId);
  const synced = await GuildRegistryService.syncGuildAdmins(guild);
  if (!synced) logger.warn(`[AccessRefresh] Annuaire des accès Discord non resynchronisé pour ${org.discordGuildId}.`);
}

/**
 * Un changement modifie qui accède au panel (rôle TO d'un tournoi, archivage, création avec rôle TO).
 * SEC-05 : le cache d'accès est invalidé immédiatement (synchrone) ; DISC-08 : l'annuaire guild_admins est
 * resynchronisé en arrière-plan, car le chargement des membres ne doit jamais retarder la réponse HTTP.
 * Toute erreur est journalisée ; aucune promesse ne reste non gérée.
 */
export function refreshGuildAccess(client: GuildFetcher, guildId: string): void {
  invalidateGuildAccess(guildId);
  resyncDirectory(client, guildId).catch((error: unknown) => {
    logger.error(`[AccessRefresh] Resynchronisation des accès de ${guildId} échouée:`, error);
  });
}
