import { PermissionFlagsBits } from "discord.js";
import type { GuildDirectoryReason } from "@hub/shared";
import { supabase } from "../lib/supabase";
import { logger } from "../utils/logger";
import { resolveAdminReason } from "../utils/adminAccess";

/** Sous-ensemble de GuildMember utilisé ici (facilite les tests sans client Discord). */
export interface MemberLike {
  id: string;
  user: { bot: boolean };
  permissions: { has(flag: bigint): boolean };
  roles: { cache: { has(roleId: string): boolean } };
}

/** Sous-ensemble de Guild utilisé ici. */
export interface GuildLike {
  id: string;
  name: string;
  icon: string | null;
  ownerId: string;
  preferredLocale: string;
  members: { fetch(): Promise<Map<string, MemberLike> | { values(): IterableIterator<MemberLike> }> };
}

/** Rôles qui donnent accès au panel : rôle TO du serveur et rôles TO des tournois non archivés. */
export interface AdminRoles {
  toRoleId: string | null;
  tournamentRoles: TournamentToRole[];
}

/**
 * Motif d'annuaire d'un membre (DISC-08) : motif serveur d'abord (même règle que resolveMemberAccess),
 * sinon TOURNAMENT_TO_ROLE s'il porte le rôle TO d'un tournoi non archivé.
 */
function memberDirectoryReason(guild: GuildLike, member: MemberLike, roles: AdminRoles): GuildDirectoryReason | null {
  const serverReason = resolveAdminReason({
    isOwner: guild.ownerId === member.id,
    hasAdministrator: member.permissions.has(PermissionFlagsBits.Administrator),
    hasManageGuild: member.permissions.has(PermissionFlagsBits.ManageGuild),
    hasToRole: !!roles.toRoleId && member.roles.cache.has(roles.toRoleId),
  });
  if (serverReason) return serverReason;
  return roles.tournamentRoles.some((role) => member.roles.cache.has(role.roleId)) ? "TOURNAMENT_TO_ROLE" : null;
}

export async function readToRoleId(guildId: string): Promise<{ ok: true; toRoleId: string | null } | { ok: false }> {
  const { data, error } = await supabase
    .from("organization_integrations")
    .select("config")
    .eq("provider", "DISCORD")
    .eq("external_id", guildId)
    .maybeSingle();
  if (error) {
    logger.error(`[GuildRegistry] Lecture du rôle TO impossible pour ${guildId}:`, error);
    return { ok: false };
  }
  const row = data as { config?: Record<string, unknown> | null } | null;
  const config = row?.config;
  const toRoleId =
    config && typeof config === "object" && typeof config.to_role_id === "string" ? config.to_role_id : null;
  if (toRoleId) {
    return { ok: true, toRoleId };
  }

  // Fallback historique (server_settings) pour la compatibilité des fixtures de test existantes
  const { data: legacyData, error: legacyError } = await supabase
    .from("server_settings")
    .select("to_role_id")
    .eq("guild_id", guildId)
    .maybeSingle();
  if (!legacyError && legacyData) {
    const legacyTo = (legacyData as { to_role_id?: string | null }).to_role_id ?? null;
    if (legacyTo) return { ok: true, toRoleId: legacyTo };
  }

  return { ok: true, toRoleId: null };
}

export interface TournamentToRole {
  tournamentId: string;
  roleId: string;
}

/**
 * Rôles TO propres aux tournois du serveur (tournaments.discord_to_role_id), hors tournois archivés (SEC-23).
 * Un tournoi COMPLETED reste géré : son TO peut encore corriger les résultats.
 */
export async function readTournamentToRoles(guildId: string): Promise<{ ok: true; roles: TournamentToRole[] } | { ok: false }> {
  const { data, error } = await supabase
    .from("tournaments")
    .select("id, discord_to_role_id")
    .eq("guild_id", guildId)
    .neq("status", "ARCHIVED")
    .not("discord_to_role_id", "is", null);
  if (error) {
    logger.error(`[GuildRegistry] Lecture des rôles TO de tournoi impossible pour ${guildId}:`, error);
    return { ok: false };
  }
  const rows = (data ?? []) as { id: string; discord_to_role_id: string | null }[];
  return {
    ok: true,
    roles: rows.flatMap((row) => (row.discord_to_role_id ? [{ tournamentId: row.id, roleId: row.discord_to_role_id }] : [])),
  };
}

/** Lecture groupée des rôles d'accès ; `ok: false` si l'une des lectures échoue (rien n'est alors purgé). */
export async function readAdminRoles(guildId: string): Promise<({ ok: true } & AdminRoles) | { ok: false }> {
  const [settings, tournaments] = await Promise.all([readToRoleId(guildId), readTournamentToRoles(guildId)]);
  if (!settings.ok || !tournaments.ok) return { ok: false };
  return { ok: true, toRoleId: settings.toRoleId, tournamentRoles: tournaments.roles };
}

export class GuildRegistryService {
  /**
   * Enregistre (ou rafraîchit) le serveur dans organizations et organization_integrations (DISC-07).
   * La langue n'est détectée qu'à la première insertion pour ne jamais écraser le choix des TO.
   */
  static async registerGuild(guild: GuildLike): Promise<boolean> {
    const { data: existingInt, error: readIntError } = await supabase
      .from("organization_integrations")
      .select("id, organization_id, config")
      .eq("provider", "DISCORD")
      .eq("external_id", guild.id)
      .maybeSingle();

    if (readIntError) {
      logger.error(`[GuildRegistry] Lecture de organization_integrations impossible pour ${guild.id}:`, readIntError);
      return false;
    }

    if (existingInt) {
      const orgId = existingInt.organization_id as string;
      const { error: orgUpdateError } = await supabase
        .from("organizations")
        .update({
          name: guild.name,
          icon_url: guild.icon,
          logo_url: guild.icon,
        })
        .eq("id", orgId);

      if (orgUpdateError) {
        logger.error(`[GuildRegistry] Mise à jour de l'organisation pour ${guild.id} échouée:`, orgUpdateError);
        return false;
      }

      const prevConfig = (existingInt.config as Record<string, unknown> | null) ?? {};
      const nextConfig = {
        ...prevConfig,
        guild_name: guild.name,
        guild_icon: guild.icon,
        bot_present: true,
      };

      const { error: intUpdateError } = await supabase
        .from("organization_integrations")
        .update({
          enabled: true,
          status: "CONNECTED",
          config: nextConfig,
        })
        .eq("id", existingInt.id);

      if (intUpdateError) {
        logger.error(`[GuildRegistry] Mise à jour de organization_integrations pour ${guild.id} échouée:`, intUpdateError);
        return false;
      }
    } else {
      const slug = `discord-${guild.id}`;
      const language = guild.preferredLocale.toLowerCase().startsWith("en") ? "en" : "fr";

      const { data: orgData, error: orgInsertError } = await supabase
        .from("organizations")
        .insert({
          slug,
          name: guild.name,
          icon_url: guild.icon,
          logo_url: guild.icon,
          language,
        })
        .select("id")
        .single();

      if (orgInsertError) {
        logger.error(`[GuildRegistry] Enregistrement de l'organisation pour ${guild.id} échoué:`, orgInsertError);
        return false;
      }

      const orgId = (orgData as { id: string }).id;

      const { error: intInsertError } = await supabase
        .from("organization_integrations")
        .insert({
          organization_id: orgId,
          provider: "DISCORD",
          type: "DISCORD",
          external_id: guild.id,
          enabled: true,
          status: "CONNECTED",
          config: {
            guild_name: guild.name,
            guild_icon: guild.icon,
            bot_present: true,
          },
        });

      if (intInsertError) {
        logger.error(`[GuildRegistry] Création de l'intégration Discord pour ${guild.id} échouée:`, intInsertError);
        return false;
      }
    }

    logger.info(`[GuildRegistry] Serveur ${guild.name} (${guild.id}) enregistré.`);
    return true;
  }

  /** Le bot a quitté le serveur : marque l'intégration Discord comme DISCONNECTED (DISC-07). */
  static async markGuildLeft(guildId: string): Promise<boolean> {
    const { data: existing, error: readError } = await supabase
      .from("organization_integrations")
      .select("id, config")
      .eq("provider", "DISCORD")
      .eq("external_id", guildId)
      .maybeSingle();

    if (readError) {
      logger.error(`[GuildRegistry] Lecture de organization_integrations pour départ de ${guildId} échouée:`, readError);
      return false;
    }

    if (!existing) {
      logger.warn(`[GuildRegistry] Aucune intégration Discord trouvée pour le départ de ${guildId}.`);
      return true;
    }

    const prevConfig = (existing.config as Record<string, unknown> | null) ?? {};
    const { error } = await supabase
      .from("organization_integrations")
      .update({
        enabled: false,
        status: "DISCONNECTED",
        config: { ...prevConfig, bot_present: false },
      })
      .eq("id", existing.id);

    if (error) {
      logger.error(`[GuildRegistry] Marquage du départ du serveur ${guildId} échoué:`, error);
      return false;
    }
    logger.info(`[GuildRegistry] Bot retiré du serveur ${guildId}.`);
    return true;
  }

  /** Recalcule les droits d'un membre (changement de rôles, de permissions ou départ). */
  static async syncMemberAdmin(guild: GuildLike, member: MemberLike, roles: AdminRoles): Promise<boolean> {
    const reason = memberDirectoryReason(guild, member, roles);
    const { error } = reason
      ? await supabase
          .from("guild_admins")
          .upsert({ guild_id: guild.id, discord_id: member.id, reason }, { onConflict: "guild_id,discord_id" })
      : await supabase.from("guild_admins").delete().eq("guild_id", guild.id).eq("discord_id", member.id);

    if (error) {
      logger.error(`[GuildRegistry] Synchronisation des droits de ${member.id} sur ${guild.id} échouée:`, error);
      return false;
    }
    logger.info(`[GuildRegistry] Droits de ${member.id} sur ${guild.id} : ${reason ?? "aucun"}.`);
    return true;
  }

  /** Retire un membre ayant quitté le serveur. */
  static async removeMember(guildId: string, discordId: string): Promise<boolean> {
    const { error } = await supabase.from("guild_admins").delete().eq("guild_id", guildId).eq("discord_id", discordId);
    if (error) {
      logger.error(`[GuildRegistry] Retrait des droits de ${discordId} sur ${guildId} échoué:`, error);
      return false;
    }
    return true;
  }

  /**
   * Reconstruit guild_admins pour tout le serveur (démarrage du bot, changement du rôle TO du serveur ou d'un
   * tournoi, archivage, rôle supprimé).
   * Les admins qui ont perdu leurs droits sont purgés ; rien n'est supprimé si la lecture initiale échoue.
   */
  static async syncGuildAdmins(guild: GuildLike): Promise<boolean> {
    const roles = await readAdminRoles(guild.id);
    if (!roles.ok) return false;

    const members = await guild.members.fetch();
    const records: { guild_id: string; discord_id: string; reason: GuildDirectoryReason }[] = [];
    for (const member of members.values()) {
      if (member.user.bot) continue;
      const reason = memberDirectoryReason(guild, member, roles);
      if (reason) records.push({ guild_id: guild.id, discord_id: member.id, reason });
    }

    if (records.length > 0) {
      const { error } = await supabase.from("guild_admins").upsert(records, { onConflict: "guild_id,discord_id" });
      if (error) {
        logger.error(`[GuildRegistry] Écriture des admins de ${guild.id} échouée:`, error);
        return false;
      }
    }

    const keep = `(${records.map((r) => `"${r.discord_id}"`).join(",")})`;
    let purge = supabase.from("guild_admins").delete().eq("guild_id", guild.id);
    if (records.length > 0) purge = purge.not("discord_id", "in", keep);
    const { error: purgeError } = await purge;
    if (purgeError) {
      logger.error(`[GuildRegistry] Purge des anciens admins de ${guild.id} échouée:`, purgeError);
      return false;
    }

    logger.info(`[GuildRegistry] ${records.length} admin(s) synchronisé(s) pour ${guild.name}.`);
    return true;
  }
}
