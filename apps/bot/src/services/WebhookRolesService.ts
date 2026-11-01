import { Client } from "discord.js";
import { supabase } from "../lib/supabase";
import { logger } from "../utils/logger";

export class WebhookRolesService {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * Handle team update webhook from Supabase
   * This is called by Supabase Database Webhooks when a team is created/updated/deleted
   */
  async handleTeamUpdate(payload: any) {
    try {
      logger.info(`[WebhookRoles] Received team update webhook:`, {
        type: payload.type,
        table: payload.table,
      });

      const record = payload.record;

      // Handle different event types
      switch (payload.type) {
        case 'INSERT':
          await this.handleInsert(record);
          break;
        case 'UPDATE':
          await this.handleUpdate(record);
          break;
        case 'DELETE':
          await this.handleDelete(record);
          break;
        default:
          logger.warn(`[WebhookRoles] Unknown event type: ${payload.type}`);
      }

      return { success: true };
    } catch (error) {
      logger.error(`[WebhookRoles] Error handling team update webhook:`, error);
      return { success: false, error: "Discord role synchronization failed" };
    }
  }

  private async handleInsert(record: any) {
    logger.info(`[WebhookRoles] INSERT - Team: ${record.name}, CheckedIn: ${record.is_checked_in}, Captain: ${record.captain_discord_id}`);

    if (record.is_checked_in && record.captain_discord_id) {
      await this.applyPresence(record);
    } else {
      logger.info(`[WebhookRoles] INSERT - Skipping presence application (is_checked_in: ${record.is_checked_in})`);
    }
  }

  private async handleUpdate(record: any) {
    // For UPDATE, we need to get the old record to detect changes
    // But Supabase webhooks only send the new record
    // We'll check the current state and apply/remove presence accordingly

    logger.info(`[WebhookRoles] UPDATE - Team: ${record.name}, CheckedIn: ${record.is_checked_in}, Captain: ${record.captain_discord_id}`);

    if (record.is_checked_in && record.captain_discord_id) {
      // Team is checked in, apply presence
      await this.applyPresence(record);
    } else {
      // Team is not checked in, remove presence
      await this.removePresence(record);
    }
  }

  private async handleDelete(record: any) {
    logger.info(`[WebhookRoles] DELETE - Team: ${record.name}, CheckedIn: ${record.is_checked_in}, Captain: ${record.captain_discord_id}`);

    if (record.is_checked_in && record.captain_discord_id) {
      await this.removePresence(record);
    }
  }

  private async applyPresence(team: any) {
    logger.info(`[WebhookRoles] applyPresence - Team: ${team.name}, Captain: ${team.captain_discord_id}, Tournament: ${team.tournament_id}`);

    try {
      const { data: tourney, error } = await supabase
        .from("tournaments")
        .select("guild_id, discord_captain_role_id")
        .eq("id", team.tournament_id)
        .single();

      if (error || !tourney || !tourney.guild_id) {
        throw new Error("Tournament lookup failed");
      }

      logger.info(`[WebhookRoles] Tournament found: ${tourney.guild_id}, Captain Role: ${tourney.discord_captain_role_id}`);

      const guild = await this.client.guilds.fetch(tourney.guild_id).catch(() => null);
      if (!guild) {
        throw new Error("Discord guild unavailable");
      }

      logger.info(`[WebhookRoles] Guild fetched successfully: ${guild.name}`);

      const member = await guild.members.fetch(team.captain_discord_id).catch(() => null);
      if (!member) {
        throw new Error("Discord member unavailable");
      }

      logger.info(`[WebhookRoles] Member fetched successfully: ${member.user.tag}, Manageable: ${member.manageable}`);

      // Apply Nickname
      const nickname = team.name.substring(0, 32);
      if (member.nickname !== nickname && member.user.displayName !== nickname) {
        if (!member.manageable) throw new Error("Discord member is not manageable");
        await member.setNickname(nickname, "Check-in au Tournoi");
        logger.info(`[WebhookRoles] Nickname set successfully`);
      }

      // Apply Role
      if (tourney.discord_captain_role_id) {
        const role = guild.roles.cache.get(tourney.discord_captain_role_id);
        if (role) {
          logger.info(`[WebhookRoles] Role found: ${role.name} (${role.id}), Has role: ${member.roles.cache.has(role.id)}`);

          if (!member.roles.cache.has(role.id)) {
            await member.roles.add(role, "Check-in au Tournoi");
            logger.info(`[WebhookRoles] Role added successfully: ${role.name}`);
          } else {
            logger.info(`[WebhookRoles] Member already has the role`);
          }
        } else {
          throw new Error("Configured Discord role not found");
        }
      } else {
        logger.warn(`[WebhookRoles] No captain role configured for tournament`);
      }

      logger.info(`[WebhookRoles] applyPresence completed for team: ${team.name}`);
    } catch (error) {
      throw error;
    }
  }

  private async removePresence(team: any) {
    logger.info(`[WebhookRoles] removePresence - Team: ${team.name}, Captain: ${team.captain_discord_id}, Tournament: ${team.tournament_id}`);

    try {
      const { data: tourney, error } = await supabase
        .from("tournaments")
        .select("guild_id, discord_captain_role_id")
        .eq("id", team.tournament_id)
        .single();

      if (error || !tourney || !tourney.guild_id) {
        throw new Error("Tournament lookup failed");
      }

      logger.info(`[WebhookRoles] Tournament found: ${tourney.guild_id}, Captain Role: ${tourney.discord_captain_role_id}`);

      const guild = await this.client.guilds.fetch(tourney.guild_id).catch(() => null);
      if (!guild) {
        throw new Error("Discord guild unavailable");
      }

      logger.info(`[WebhookRoles] Guild fetched successfully: ${guild.name}`);

      const member = await guild.members.fetch(team.captain_discord_id).catch(() => null);
      if (!member) {
        throw new Error("Discord member unavailable");
      }

      logger.info(`[WebhookRoles] Member fetched successfully: ${member.user.tag}, Manageable: ${member.manageable}`);

      // Remove Nickname
      if (member.manageable && member.nickname === team.name.substring(0, 32)) {
        logger.info(`[WebhookRoles] Current nickname matches team name, removing`);
        await member.setNickname(null, "Annulation du Check-in / Changement d'équipe");
        logger.info(`[WebhookRoles] Nickname removed successfully`);
      } else if (member.nickname === team.name.substring(0, 32)) {
        throw new Error("Discord member is not manageable");
      } else {
        logger.info(`[WebhookRoles] Nickname does not match team name, skipping`);
      }

      // Remove Role
      if (tourney.discord_captain_role_id) {
        const role = guild.roles.cache.get(tourney.discord_captain_role_id);
        if (role) {
          logger.info(`[WebhookRoles] Role found: ${role.name} (${role.id}), Has role: ${member.roles.cache.has(role.id)}`);

          if (member.roles.cache.has(role.id)) {
            await member.roles.remove(role, "Annulation du Check-in / Changement d'équipe");
            logger.info(`[WebhookRoles] Role removed successfully: ${role.name}`);
          } else {
            logger.info(`[WebhookRoles] Member does not have the role`);
          }
        } else {
          throw new Error("Configured Discord role not found");
        }
      } else {
        logger.warn(`[WebhookRoles] No captain role configured for tournament`);
      }

      logger.info(`[WebhookRoles] removePresence completed for team: ${team.name}`);
    } catch (error) {
      throw error;
    }
  }

  /**
   * Verify webhook signature (optional but recommended for security)
   */
  verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
    // Implement signature verification if needed
    // For now, we'll trust the webhook as it's coming from Supabase
    return true;
  }
}
