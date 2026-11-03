import { PermissionFlagsBits } from "discord.js";
import type { GuildAdminReason } from "@hub/shared";
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

function memberAdminReason(guild: GuildLike, member: MemberLike, toRoleId: string | null): GuildAdminReason | null {
  return resolveAdminReason({
    isOwner: guild.ownerId === member.id,
    hasAdministrator: member.permissions.has(PermissionFlagsBits.Administrator),
    hasManageGuild: member.permissions.has(PermissionFlagsBits.ManageGuild),
    hasToRole: !!toRoleId && member.roles.cache.has(toRoleId),
  });
}

export async function readToRoleId(guildId: string): Promise<{ ok: true; toRoleId: string | null } | { ok: false }> {
  const { data, error } = await supabase
    .from("server_settings")
    .select("to_role_id")
    .eq("guild_id", guildId)
    .maybeSingle();
  if (error) {
    logger.error(`[GuildRegistry] Lecture du rôle TO impossible pour ${guildId}:`, error);
    return { ok: false };
  }
  return { ok: true, toRoleId: (data as { to_role_id: string | null } | null)?.to_role_id ?? null };
}

export class GuildRegistryService {
  /**
   * Enregistre (ou rafraîchit) le serveur dans server_settings : c'est cette ligne qui le rend visible sur le web.
   * La langue n'est détectée qu'à la première insertion pour ne jamais écraser le choix des TO.
   */
  static async registerGuild(guild: GuildLike): Promise<boolean> {
    const profile = { guild_name: guild.name, guild_icon: guild.icon, bot_present: true };

    const { data: existing, error: readError } = await supabase
      .from("server_settings")
      .select("guild_id")
      .eq("guild_id", guild.id)
      .maybeSingle();
    if (readError) {
      logger.error(`[GuildRegistry] Lecture de server_settings impossible pour ${guild.id}:`, readError);
      return false;
    }

    const { error } = existing
      ? await supabase.from("server_settings").update(profile).eq("guild_id", guild.id)
      : await supabase.from("server_settings").insert({
          guild_id: guild.id,
          ...profile,
          language: guild.preferredLocale.toLowerCase().startsWith("en") ? "en" : "fr",
        });

    if (error) {
      logger.error(`[GuildRegistry] Enregistrement du serveur ${guild.id} échoué:`, error);
      return false;
    }
    logger.info(`[GuildRegistry] Serveur ${guild.name} (${guild.id}) enregistré.`);
    return true;
  }

  /** Le bot a quitté le serveur : le web propose de le réinstaller au lieu de le masquer. */
  static async markGuildLeft(guildId: string): Promise<boolean> {
    const { error } = await supabase.from("server_settings").update({ bot_present: false }).eq("guild_id", guildId);
    if (error) {
      logger.error(`[GuildRegistry] Marquage du départ du serveur ${guildId} échoué:`, error);
      return false;
    }
    logger.info(`[GuildRegistry] Bot retiré du serveur ${guildId}.`);
    return true;
  }

  /** Recalcule les droits d'un membre (changement de rôles, de permissions ou départ). */
  static async syncMemberAdmin(guild: GuildLike, member: MemberLike, toRoleId: string | null): Promise<boolean> {
    const reason = memberAdminReason(guild, member, toRoleId);
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
   * Reconstruit guild_admins pour tout le serveur (démarrage du bot, changement du rôle TO).
   * Les admins qui ont perdu leurs droits sont purgés ; rien n'est supprimé si la lecture initiale échoue.
   */
  static async syncGuildAdmins(guild: GuildLike): Promise<boolean> {
    const settings = await readToRoleId(guild.id);
    if (!settings.ok) return false;

    const members = await guild.members.fetch();
    const records: { guild_id: string; discord_id: string; reason: GuildAdminReason }[] = [];
    for (const member of members.values()) {
      if (member.user.bot) continue;
      const reason = memberAdminReason(guild, member, settings.toRoleId);
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
