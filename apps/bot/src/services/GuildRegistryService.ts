import { PermissionFlagsBits } from "discord.js";
import type { GuildDirectoryReason } from "@hub/shared";
import { supabase } from "../lib/supabase";
import { logger } from "../utils/logger";
import { resolveAdminReason } from "../utils/adminAccess";
import { resolveOrganization } from "../utils/tenant";

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
  return { ok: true, toRoleId };
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

      const { data: orgRow, error: orgReadError } = await supabase
        .from("organizations")
        .select("id, slug")
        .eq("id", orgId)
        .maybeSingle();
      if (orgReadError) {
        logger.error(`[GuildRegistry] Lecture de l'organisation pour ${guild.id} échouée:`, orgReadError);
        return false;
      }

      // Seule une organisation créée à l'installation du bot suit le profil du serveur : une organisation Web garde le sien.
      if ((orgRow as { slug?: string } | null)?.slug === `discord-${guild.id}`) {
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
      }

      const { left_while_enabled: leftWhileEnabled, ...prevConfig } = (existingInt.config as Record<string, unknown> | null) ?? {};
      const nextConfig = {
        ...prevConfig,
        guild_name: guild.name,
        guild_icon: guild.icon,
        bot_present: true,
      };

      // SEC-02 : seul le retour du bot rétablit une intégration que son départ avait coupée. Le choix d'un administrateur
      // de la désactiver survit à tout redémarrage.
      const { error: intUpdateError } = await supabase
        .from("organization_integrations")
        .update({
          config: nextConfig,
          ...(leftWhileEnabled === true ? { enabled: true, status: "CONNECTED" } : {}),
        })
        .eq("id", existingInt.id);

      if (intUpdateError) {
        logger.error(`[GuildRegistry] Mise à jour de organization_integrations pour ${guild.id} échouée:`, intUpdateError);
        return false;
      }

      if (!(await this.ensureNativeManager(orgId, guild))) return false;
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

      if (!(await this.ensureNativeManager(orgId, guild))) return false;
    }

    logger.info(`[GuildRegistry] Serveur ${guild.name} (${guild.id}) enregistré.`);
    return true;
  }

  /**
   * ACC-01 (RFC Q5) : le propriétaire du serveur devient responsable natif, seul accès qui survit à la coupure de Discord.
   * Au plafond de 5 organisations possédées, il reçoit ORG_ADMIN : l'organisation n'est jamais sans responsable.
   */
  private static async ensureNativeManager(organizationId: string, guild: GuildLike): Promise<boolean> {
    const { data: members, error: readError } = await supabase
      .from("organization_members")
      .select("role")
      .eq("organization_id", organizationId);
    if (readError) {
      logger.error(`[GuildRegistry] Lecture des membres natifs de ${organizationId} échouée:`, readError);
      return false;
    }
    const hasManager = ((members ?? []) as { role: string }[]).some((m) => m.role === "ORG_OWNER" || m.role === "ORG_ADMIN");
    if (hasManager) return true;

    const member = (role: "ORG_OWNER" | "ORG_ADMIN") => ({ organization_id: organizationId, user_id: guild.ownerId, role });
    const { error: ownerError } = await supabase.from("organization_members").insert(member("ORG_OWNER"));
    if (!ownerError) return true;
    if (ownerError.code !== "HT001") {
      logger.error(`[GuildRegistry] Inscription du propriétaire de ${guild.id} échouée:`, ownerError);
      return false;
    }

    const { error: adminError } = await supabase.from("organization_members").insert(member("ORG_ADMIN"));
    if (adminError) {
      logger.error(`[GuildRegistry] Inscription du responsable de ${guild.id} échouée:`, adminError);
      return false;
    }
    return true;
  }

  /** Le bot a quitté le serveur : marque l'intégration Discord comme DISCONNECTED (DISC-07). */
  static async markGuildLeft(guildId: string): Promise<boolean> {
    const { data: existing, error: readError } = await supabase
      .from("organization_integrations")
      .select("id, enabled, config")
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
        // SEC-02 : mémorise que la coupure vient du départ du bot, pas du choix d'un administrateur.
        config: { ...prevConfig, bot_present: false, left_while_enabled: existing.enabled === true },
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
    const org = await resolveOrganization(guild.id);
    if (!org?.discordEnabled) return false;

    const serverReason = resolveAdminReason({
      isOwner: guild.ownerId === member.id,
      hasAdministrator: member.permissions.has(PermissionFlagsBits.Administrator),
      hasManageGuild: member.permissions.has(PermissionFlagsBits.ManageGuild),
      hasToRole: !!roles.toRoleId && member.roles.cache.has(roles.toRoleId),
    });

    let grant: {
      organization_id: string;
      provider: "DISCORD";
      user_id: string;
      scope_type: "ORGANIZATION" | "TOURNAMENT";
      tournament_id?: string | null;
      granted_role: "ORG_OWNER" | "ORG_ADMIN" | "ORG_TO" | "TOURNAMENT_TO";
      reason: GuildDirectoryReason;
      synced_at: string;
    } | null = null;

    const now = new Date().toISOString();

    if (serverReason) {
      grant = {
        organization_id: org.id,
        provider: "DISCORD",
        user_id: member.id,
        scope_type: "ORGANIZATION",
        tournament_id: null,
        granted_role: serverReason === "TO_ROLE" ? "ORG_TO" : "ORG_ADMIN",
        reason: serverReason,
        synced_at: now,
      };
    } else {
      const match = roles.tournamentRoles.find((tr) => member.roles.cache.has(tr.roleId));
      if (match) {
        grant = {
          organization_id: org.id,
          provider: "DISCORD",
          user_id: member.id,
          scope_type: "TOURNAMENT",
          tournament_id: match.tournamentId,
          granted_role: "TOURNAMENT_TO",
          reason: "TOURNAMENT_TO_ROLE",
          synced_at: now,
        };
      }
    }

    const { error } = grant
      ? await supabase
          .from("integration_access_grants")
          .upsert(grant, { onConflict: "organization_id,provider,user_id,scope_type,tournament_id" })
      : await supabase
          .from("integration_access_grants")
          .delete()
          .eq("organization_id", org.id)
          .eq("provider", "DISCORD")
          .eq("user_id", member.id);

    if (error) {
      logger.error(`[GuildRegistry] Synchronisation des droits de ${member.id} sur ${guild.id} échouée:`, error);
      return false;
    }
    logger.info(`[GuildRegistry] Droits de ${member.id} sur ${guild.id} : ${grant?.reason ?? "aucun"}.`);
    return true;
  }

  /** Retire un membre ayant quitté le serveur. */
  static async removeMember(guildId: string, discordId: string): Promise<boolean> {
    const org = await resolveOrganization(guildId);
    if (!org) return false;

    const { error } = await supabase
      .from("integration_access_grants")
      .delete()
      .eq("organization_id", org.id)
      .eq("provider", "DISCORD")
      .eq("user_id", discordId);

    if (error) {
      logger.error(`[GuildRegistry] Retrait des droits de ${discordId} sur ${guildId} échoué:`, error);
      return false;
    }
    return true;
  }

  /**
   * Reconstruit integration_access_grants pour tout le serveur (démarrage du bot, changement du rôle TO du serveur ou d'un
   * tournoi, archivage, rôle supprimé).
   * Les admins qui ont perdu leurs droits sont purgés ; rien n'est supprimé si la lecture initiale échoue.
   */
  static async syncGuildAdmins(guild: GuildLike): Promise<boolean> {
    const roles = await readAdminRoles(guild.id);
    if (!roles.ok) return false;

    const org = await resolveOrganization(guild.id);
    if (!org) return false;

    // SEC-26 : intégration coupée ➜ aucun grant Discord ne doit subsister, même après un événement du serveur.
    if (!org.discordEnabled) {
      const { error } = await supabase
        .from("integration_access_grants")
        .delete()
        .eq("organization_id", org.id)
        .eq("provider", "DISCORD");
      if (error) {
        logger.error(`[GuildRegistry] Purge des accès de ${guild.id} échouée:`, error);
        return false;
      }
      return true;
    }

    const members = await guild.members.fetch();
    const records: {
      organization_id: string;
      provider: "DISCORD";
      user_id: string;
      scope_type: "ORGANIZATION" | "TOURNAMENT";
      tournament_id?: string | null;
      granted_role: "ORG_OWNER" | "ORG_ADMIN" | "ORG_TO" | "TOURNAMENT_TO";
      reason: GuildDirectoryReason;
      synced_at: string;
    }[] = [];

    const now = new Date().toISOString();
    for (const member of members.values()) {
      if (member.user.bot) continue;
      const serverReason = resolveAdminReason({
        isOwner: guild.ownerId === member.id,
        hasAdministrator: member.permissions.has(PermissionFlagsBits.Administrator),
        hasManageGuild: member.permissions.has(PermissionFlagsBits.ManageGuild),
        hasToRole: !!roles.toRoleId && member.roles.cache.has(roles.toRoleId),
      });

      if (serverReason) {
        records.push({
          organization_id: org.id,
          provider: "DISCORD",
          user_id: member.id,
          scope_type: "ORGANIZATION",
          tournament_id: null,
          granted_role: serverReason === "TO_ROLE" ? "ORG_TO" : "ORG_ADMIN",
          reason: serverReason,
          synced_at: now,
        });
      } else {
        const match = roles.tournamentRoles.find((tr) => member.roles.cache.has(tr.roleId));
        if (match) {
          records.push({
            organization_id: org.id,
            provider: "DISCORD",
            user_id: member.id,
            scope_type: "TOURNAMENT",
            tournament_id: match.tournamentId,
            granted_role: "TOURNAMENT_TO",
            reason: "TOURNAMENT_TO_ROLE",
            synced_at: now,
          });
        }
      }
    }

    if (records.length > 0) {
      const { error } = await supabase.from("integration_access_grants").upsert(records, {
        onConflict: "organization_id,provider,user_id,scope_type,tournament_id",
      });
      if (error) {
        logger.error(`[GuildRegistry] Écriture des admins de ${guild.id} échouée:`, error);
        return false;
      }
    }

    const keepUserIds = Array.from(new Set(records.map((r) => r.user_id)));
    let purge = supabase
      .from("integration_access_grants")
      .delete()
      .eq("organization_id", org.id)
      .eq("provider", "DISCORD");
    if (keepUserIds.length > 0) {
      const keep = `(${keepUserIds.map((id) => `"${id}"`).join(",")})`;
      purge = purge.not("user_id", "in", keep);
    }
    const { error: purgeError } = await purge;
    if (purgeError) {
      logger.error(`[GuildRegistry] Purge des anciens admins de ${guild.id} échouée:`, purgeError);
      return false;
    }

    logger.info(`[GuildRegistry] ${records.length} admin(s) synchronisé(s) pour ${guild.name}.`);
    return true;
  }
}
