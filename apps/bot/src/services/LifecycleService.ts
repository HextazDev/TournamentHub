import { Client, Guild, ChannelType, CategoryChannel, PermissionFlagsBits, OverwriteData, PermissionResolvable } from 'discord.js';
import { supabase } from '../lib/supabase';
import { tBot, getGuildLanguage } from '../i18n';
import { DomainError } from '../utils/serverError';
import { IntegrationBus } from './IntegrationBus';

function hasPerm(list: PermissionResolvable[] | undefined, bit: bigint): boolean {
  if (!list) return false;
  for (const item of list) {
    if (typeof item === 'bigint' && item === bit) return true;
    if (Array.isArray(item) && item.includes(bit)) return true;
  }
  return false;
}

function permsToEditData(perm: OverwriteData) {
  return {
    ViewChannel: hasPerm(perm.deny as any, PermissionFlagsBits.ViewChannel) ? false : hasPerm(perm.allow as any, PermissionFlagsBits.ViewChannel) ? true : undefined,
    SendMessages: hasPerm(perm.allow as any, PermissionFlagsBits.SendMessages) ? true : hasPerm(perm.deny as any, PermissionFlagsBits.SendMessages) ? false : undefined,
    ReadMessageHistory: hasPerm(perm.allow as any, PermissionFlagsBits.ReadMessageHistory) ? true : undefined,
    ManageChannels: hasPerm(perm.allow as any, PermissionFlagsBits.ManageChannels) ? true : undefined,
  };
}

export class LifecycleService {
  static async launchTournament(
    tournamentId: string,
    guildId: string,
    discordClient?: Client | null,
    options?: { skipDiscord?: boolean },
  ): Promise<boolean> {
    try {
      const { data: tournament, error } = await supabase
        .from('tournaments')
        .select('*')
        .eq('id', tournamentId)
        .single();

      if (error || !tournament) throw new DomainError(404, 'Tournament not found');

      // ARC-02: Contrôle d'état strict sur le lancement
      if (tournament.status === 'ACTIVE' || tournament.status === 'COMPLETED' || tournament.status === 'ARCHIVED') {
        throw new DomainError(400, 'Le tournoi ne peut pas être lancé depuis son statut actuel.');
      }

      // ARC-02: Purge des équipes non check-in si le check-in est activé
      if (tournament.checkin_mode !== 'DISABLED') {
        const { error: purgeError } = await supabase
          .from('teams')
          .delete()
          .eq('tournament_id', tournamentId)
          .eq('is_checked_in', false);
        if (purgeError) throw purgeError;
      }

      // Mode sans Discord (organisation autonome ou Discord désactivé)
      if (options?.skipDiscord || !discordClient || !guildId) {
        const { error: updateError } = await supabase
          .from('tournaments')
          .update({
            status: 'ACTIVE',
            updated_at: new Date().toISOString(),
          })
          .eq('id', tournamentId);
        if (updateError) throw updateError;

        if (tournament.organization_id) {
          await IntegrationBus.emit('onTournamentLaunched', {
            organizationId: tournament.organization_id,
            tournamentId,
            discordClient: discordClient ?? undefined,
          });
        }
        return true;
      }

      const lang = await getGuildLanguage(guildId);

      const guild: Guild | undefined = discordClient.guilds.cache.get(guildId) || await discordClient.guilds.fetch(guildId).catch(() => undefined);
      if (!guild) throw new Error(`Guild ${guildId} not found by bot.`);

      const permissions: OverwriteData[] = [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
      ];

      if (tournament.discord_to_role_id) {
        permissions.push({
          id: tournament.discord_to_role_id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels],
        });
      }

      if (tournament.discord_captain_role_id) {
        permissions.push({
          id: tournament.discord_captain_role_id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [PermissionFlagsBits.SendMessages],
        });
      }

      // 1. Create category
      const categoryName = `🏆 ${tournament.name}`;
      const category = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
        permissionOverwrites: permissions,
      });

      console.log(`[LifecycleService] Created category ${category.name} (${category.id}) for tournament ${tournamentId}`);

      // 2. Create info channel
      const infoChannel = await guild.channels.create({
        name: 'informations',
        type: ChannelType.GuildText,
        parent: category.id,
      });

      const messagePayload: any = {
        embeds: [{
          title: tBot(lang, 'lifecycle.tournamentLaunchedTitle'),
          description: tBot(lang, 'lifecycle.tournamentLaunchedDesc', { name: tournament.name }),
          color: 0x3b82f6,
        }]
      };

      if (tournament.discord_captain_role_id) {
        messagePayload.content = `<@&${tournament.discord_captain_role_id}>`;
      }

      await infoChannel.send(messagePayload);

      // 3. Sync phase channels BEFORE setting status to ACTIVE
      const { data: phasesIds_1 } = await supabase.from("phases").select("id").eq("tournament_id", tournamentId);
      if (phasesIds_1 && phasesIds_1.length > 0) {
        for (const p of phasesIds_1) {
          try {
            await this.syncPhaseChannels(p.id, guildId, discordClient);
          } catch (err) {
            console.error(`[LifecycleService] Failed to sync phase ${p.id}, but continuing:`, err);
          }
        }
      }

      // 4. Only set ACTIVE after all Discord resources are created
      await supabase
        .from('tournaments')
        .update({
          status: 'ACTIVE',
          discord_category_id: category.id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', tournamentId);

      if (tournament.organization_id) {
        await IntegrationBus.emit('onTournamentLaunched', {
          organizationId: tournament.organization_id,
          tournamentId,
          discordClient,
        });
      }

      // 5. Optional: announce in general channel
      if (tournament.discord_announcement_channel_id) {
        const annChannel = await guild.channels.fetch(tournament.discord_announcement_channel_id).catch(() => null);
        if (annChannel && annChannel.isTextBased()) {
          await annChannel.send(tBot(lang, 'lifecycle.tournamentActiveAnnounce', { name: tournament.name }));
        }
      }

      return true;

    } catch (error) {
      console.error('[LifecycleService] Error launching tournament:', error);
      throw error;
    }
  }

  static async closeTournament(tournamentId: string, guildId: string, discordClient: Client): Promise<boolean> {
    try {
      const { data: tournament, error } = await supabase
        .from('tournaments')
        .select('*')
        .eq('id', tournamentId)
        .single();

      if (error || !tournament) throw new Error('Tournament not found');

      const guild: Guild | undefined = discordClient.guilds.cache.get(guildId) || await discordClient.guilds.fetch(guildId).catch(() => undefined);
      if (!guild) {
        console.warn(`[LifecycleService] Guild ${guildId} not found, proceeding with local DB update only.`);
      } else if (tournament.discord_category_id) {
        const category = guild.channels.cache.get(tournament.discord_category_id) as CategoryChannel | undefined;
        if (category) {
          for (const [_, child] of category.children.cache) {
            await child.delete('Tournament Closure').catch(e => console.error(`Failed to delete channel ${child.id}:`, e));
          }
          await category.delete('Tournament Closure').catch(e => console.error(`Failed to delete category ${category.id}:`, e));
          console.log(`[LifecycleService] Deleted category and children for tournament ${tournamentId}`);
        } else {
          console.warn(`[LifecycleService] Category ${tournament.discord_category_id} not found on Discord.`);
        }
      }

      await supabase
        .from('tournaments')
        .update({
          status: 'COMPLETED'
        })
        .eq('id', tournamentId);

      return true;
    } catch (error) {
      console.error('[LifecycleService] Error closing tournament:', error);
      throw error;
    }
  }

  static async syncPhaseChannels(phaseId: string, guildId: string, discordClient: Client): Promise<boolean> {
    try {
      const { data: phase, error: phaseErr } = await supabase
        .from('phases')
        .select(`
          *,
          tournaments ( id, name, discord_category_id, discord_to_role_id ),
          groups ( id, name, discord_channel_id )
        `)
        .eq('id', phaseId)
        .single();

      if (phaseErr || !phase) throw new Error('Phase not found');

      const tournament = phase.tournaments;
      if (!tournament.discord_category_id) {
        throw new DomainError(409, 'Tournament does not have an active Discord Category. Please launch the tournament first.');
      }

      const lang = await getGuildLanguage(guildId, tournament.id);

      const guild = discordClient.guilds.cache.get(guildId) || await discordClient.guilds.fetch(guildId).catch(() => undefined);
      if (!guild) throw new Error(`Guild ${guildId} not found.`);

      const { data: ptData, error: ptErr } = await supabase
        .from('phase_teams')
        .select('group_id, teams ( id, captain_discord_id )')
        .eq('phase_id', phaseId);

      if (ptErr) throw ptErr;

      const isSingleChannelPhase = phase.format === 'SINGLE_ELIM' || phase.format === 'DOUBLE_ELIM' || phase.format === 'SWISS';

      const getBasePerms = (): OverwriteData[] => {
        const perms: OverwriteData[] = [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel],
          }
        ];
        if (tournament.discord_to_role_id) {
          perms.push({
            id: tournament.discord_to_role_id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels],
          });
        }
        return perms;
      };

      if (isSingleChannelPhase) {
        let channelId = phase.discord_channel_id;
        const perms = getBasePerms();
        for (const pt of (ptData || [])) {
          const teamDetails: any = Array.isArray(pt.teams) ? pt.teams[0] : pt.teams;
          if (teamDetails?.captain_discord_id) {
            perms.push({
              id: teamDetails.captain_discord_id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
            });
          }
        }

        if (!channelId) {
          const prefix = phase.format === 'SWISS' ? 'swiss' : 'bracket';
          const phaseChannel = await guild.channels.create({
            name: `${prefix}-${phase.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
            type: ChannelType.GuildText,
            parent: tournament.discord_category_id,
            permissionOverwrites: perms,
          });
          channelId = phaseChannel.id;
          await supabase.from('phases').update({ discord_channel_id: channelId }).eq('id', phaseId);
          const welcomeMsg = phase.format === 'SWISS'
            ? tBot(lang, 'lifecycle.swissWelcome', { name: phase.name })
            : tBot(lang, 'lifecycle.bracketWelcome', { name: phase.name });
          await phaseChannel.send(welcomeMsg);
        } else {
          const phaseChannel = guild.channels.cache.get(channelId);
          if (phaseChannel && phaseChannel.isTextBased() && 'permissionOverwrites' in phaseChannel) {
            // Delete stale member overwrites
            const activeMemberIds = new Set(perms.map(p => p.id));
            for (const [overwriteId, overwrite] of phaseChannel.permissionOverwrites.cache.entries()) {
              if (overwrite.type === 1 && !activeMemberIds.has(overwriteId)) {
                await phaseChannel.permissionOverwrites.delete(overwriteId, "Stale Captain Removal").catch(() => {});
              }
            }

            for (const perm of perms) {
              await phaseChannel.permissionOverwrites.edit(perm.id, permsToEditData(perm) as any).catch(() => {});
            }
          }
        }
      } else {
        const groups = phase.groups || [];
        for (const group of groups) {
          let channelId = group.discord_channel_id;

          const captainsInGroup = (ptData || [])
            .map(pt => ({
              group_id: pt.group_id,
              teamDetails: Array.isArray(pt.teams) ? pt.teams[0] : pt.teams
            }))
            .filter(pt => pt.group_id === group.id && pt.teamDetails?.captain_discord_id)
            .map(pt => pt.teamDetails!.captain_discord_id);

          const perms = getBasePerms();
          for (const capId of captainsInGroup) {
            perms.push({
              id: capId,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
            });
          }

          if (!channelId) {
            const groupChannel = await guild.channels.create({
              name: `groupe-${group.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
              type: ChannelType.GuildText,
              parent: tournament.discord_category_id,
              permissionOverwrites: perms,
            });
            channelId = groupChannel.id;
            await supabase.from('groups').update({ discord_channel_id: channelId }).eq('id', group.id);
            await groupChannel.send(tBot(lang, 'lifecycle.groupWelcome', { groupName: group.name, phaseName: phase.name }));
          } else {
            const groupChannel = guild.channels.cache.get(channelId);
            if (groupChannel && groupChannel.isTextBased() && 'permissionOverwrites' in groupChannel) {
              // Delete stale member overwrites
              const activeMemberIds = new Set(perms.map(p => p.id));
              for (const [overwriteId, overwrite] of groupChannel.permissionOverwrites.cache.entries()) {
                if (overwrite.type === 1 && !activeMemberIds.has(overwriteId)) {
                  await groupChannel.permissionOverwrites.delete(overwriteId, "Stale Captain Removal").catch(() => {});
                }
              }

              for (const perm of perms) {
                await groupChannel.permissionOverwrites.edit(perm.id, permsToEditData(perm) as any).catch(() => {});
              }
            }
          }
        }
      }

      return true;

    } catch (error) {
      console.error('[LifecycleService] Error syncing phase channels:', error);
      throw error;
    }
  }
}
