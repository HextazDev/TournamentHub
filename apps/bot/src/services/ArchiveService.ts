import { Client, TextChannel } from "discord.js";
import { supabase } from "../lib/supabase";
import { logger } from "../utils/logger";

const BATCH_SIZE = 5;
const DELAY_BETWEEN_BATCHES_MS = 100;

async function processInBatches<T>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(fn));

    if (i + batchSize < items.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
    }
  }
}

export interface ArchivedTournamentInfo {
  id: string;
  discord_captain_role_id?: string | null;
  discord_checkin_channel_id?: string | null;
}

export class ArchiveService {
  public static async backgroundDiscordCleanup(
    client: Client,
    guildId: string,
    archivedTournaments: ArchivedTournamentInfo[]
  ): Promise<void> {
    if (!archivedTournaments || archivedTournaments.length === 0) {
      return;
    }

    try {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) {
        logger.error(`[ArchiveService] Guild ${guildId} not found.`);
        return;
      }

      // 1. Fetch non-archived tournaments for this guild to protect active resources
      const { data: nonArchived, error: nonArchivedErr } = await supabase
        .from("tournaments")
        .select("id, discord_captain_role_id, discord_checkin_channel_id")
        .eq("guild_id", guildId)
        .neq("status", "ARCHIVED");

      if (nonArchivedErr) {
        logger.error(`[ArchiveService] Failed to fetch non-archived tournaments for ${guildId}:`, nonArchivedErr);
        return;
      }

      const activeTournaments = (nonArchived ?? []) as {
        id: string;
        discord_captain_role_id: string | null;
        discord_checkin_channel_id: string | null;
      }[];
      const activeTournamentIds = activeTournaments.map((t) => t.id);

      // Fetch server settings for fallback role/channel
      const { data: settings } = await supabase
        .from("server_settings")
        .select("captain_role_id, checkin_channel_id")
        .eq("guild_id", guildId)
        .single();

      // Collect active captains (who must keep their role)
      const activeCaptainDiscordIds = new Set<string>();
      if (activeTournamentIds.length > 0) {
        const { data: activeTeams, error: teamsErr } = await supabase
          .from("teams")
          .select("captain_discord_id")
          .in("tournament_id", activeTournamentIds);

        if (teamsErr) {
          logger.error(`[ArchiveService] Failed to fetch active teams for guild ${guildId}:`, teamsErr);
          return;
        }

        if (activeTeams) {
          for (const team of activeTeams) {
            if (team.captain_discord_id) {
              activeCaptainDiscordIds.add(team.captain_discord_id);
            }
          }
        }
      }

      // Collect captain roles to clean from archived tournaments
      const captainRolesToClean = new Set<string>();
      for (const t of archivedTournaments) {
        const roleId = t.discord_captain_role_id || settings?.captain_role_id;
        if (roleId) {
          captainRolesToClean.add(roleId);
        }
      }

      // Remove captain role from members, EXCEPT those who are captains of active tournaments
      for (const roleId of captainRolesToClean) {
        const role = await guild.roles.fetch(roleId).catch(() => null);
        if (!role) continue;

        await guild.members.fetch();
        const membersToRemove = [...role.members.entries()].filter(
          ([memberId]) => !activeCaptainDiscordIds.has(memberId)
        );

        await processInBatches(membersToRemove, BATCH_SIZE, async ([, member]) => {
          try {
            await member.roles.remove(role, "Archivage du Tournoi");
          } catch (err) {
            logger.error(`[ArchiveService] Failed to remove role for ${member.user.tag}:`, err);
          }
        });

        logger.info(
          `[ArchiveService] Rôle Capitaine (${roleId}) retiré pour ${membersToRemove.length} membre(s) du serveur ${guild.name} (${activeCaptainDiscordIds.size} capitaine(s) actif(s) épargné(s)).`
        );
      }

      // Collect active checkin channels (must NOT be locked)
      const activeCheckinChannels = new Set<string>();
      for (const t of activeTournaments) {
        const chanId = t.discord_checkin_channel_id || settings?.checkin_channel_id;
        if (chanId) activeCheckinChannels.add(chanId);
      }

      // Collect archived checkin channels that can be locked
      const checkinChannelsToLock = new Set<string>();
      for (const t of archivedTournaments) {
        const chanId = t.discord_checkin_channel_id || settings?.checkin_channel_id;
        if (chanId && !activeCheckinChannels.has(chanId)) {
          checkinChannelsToLock.add(chanId);
        }
      }

      for (const chanId of checkinChannelsToLock) {
        const checkinChannel = await guild.channels.fetch(chanId).catch(() => null);
        if (checkinChannel && checkinChannel.isTextBased() && !checkinChannel.isThread()) {
          const textChannel = checkinChannel as TextChannel;
          await textChannel.permissionOverwrites.edit(
            guild.roles.everyone,
            { SendMessages: false },
            { reason: "Archivage du Tournoi" }
          );
          logger.info(`[ArchiveService] Salon ${textChannel.name} passé en lecture seule.`);
        }
      }

      logger.info(`[ArchiveService] Nettoyage asynchrone terminé avec succès.`);
    } catch (error) {
      logger.error("[ArchiveService] Erreur lors du nettoyage background:", error);
    }
  }
}
