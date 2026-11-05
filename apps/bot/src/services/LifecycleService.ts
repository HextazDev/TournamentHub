import { Client, Guild, ChannelType, CategoryChannel, PermissionFlagsBits, OverwriteData, PermissionResolvable } from 'discord.js';
import { supabase } from '../lib/supabase';
import { tBot, getGuildLanguage } from '../i18n';
import { DomainError } from '../utils/serverError';
import type { LaunchTournamentInput, Tournament } from '@hub/shared';

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

const DISCORD_UNKNOWN_MEMBER = 10007;
const DISCORD_UNKNOWN_USER = 10013;

/**
 * DISC-09 : un capitaine inscrit sur le Web n'est pas forcément membre du serveur, et Discord refuse toute permission
 * portant sur un identifiant inconnu. Seuls les absents avérés sont écartés : une panne remonte pour rester rejouable.
 */
async function captainsPresentInGuild(guild: Guild, captainIds: readonly string[]): Promise<string[]> {
  const uniqueIds = [...new Set(captainIds)];
  const present = await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        await guild.members.fetch(id);
        return id;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === DISCORD_UNKNOWN_MEMBER || code === DISCORD_UNKNOWN_USER) return null;
        throw error;
      }
    }),
  );
  return present.filter((id): id is string => id !== null);
}

export class LifecycleService {
  /**
   * Transition métier du lancement (DISC-02) : la base est l'autorité, sans aucun appel Discord.
   * Les effets externes sont délégués au bus d'intégrations par l'appelant.
   * Les équipes non check-in ne sont jamais retirées sans décision explicite du TO (LCH-01 à LCH-04).
   */
  static async launchTournament(tournamentId: string, options: LaunchTournamentInput = {}): Promise<void> {
    const { data: tournament, error } = await supabase
      .from('tournaments')
      .select('id, status, checkin_mode')
      .eq('id', tournamentId)
      .maybeSingle();
    if (error) throw error;
    if (!tournament) throw new DomainError(404, 'Tournament not found');
    if (tournament.status !== 'DRAFT' && tournament.status !== 'REGISTRATION') {
      throw new DomainError(400, 'Le tournoi ne peut pas être lancé depuis son statut actuel.', { code: 'INVALID_STATUS' });
    }

    const { data: phases, error: phasesError } = await supabase
      .from('phases')
      .select('id')
      .eq('tournament_id', tournamentId);
    if (phasesError) throw phasesError;
    if ((phases ?? []).length === 0) {
      throw new DomainError(400, 'Ajoutez au moins une phase avant de lancer le tournoi.', { code: 'NO_PHASE' });
    }

    const { data: teamRows, error: teamsError } = await supabase
      .from('teams')
      .select('id, is_checked_in')
      .eq('tournament_id', tournamentId);
    if (teamsError) throw teamsError;
    const teams = (teamRows ?? []) as { id: string; is_checked_in: boolean | null }[];
    const uncheckedIds = tournament.checkin_mode === 'DISABLED' ? [] : teams.filter((t) => !t.is_checked_in).map((t) => t.id);

    if (uncheckedIds.length > 0 && options.uncheckedTeams === undefined) {
      throw new DomainError(409, 'Des équipes inscrites n\'ont pas fait leur check-in.', {
        code: 'UNCHECKED_TEAMS',
        uncheckedCount: uncheckedIds.length,
      });
    }

    const removeIds = options.uncheckedTeams === 'remove' ? uncheckedIds : [];
    if (teams.length - removeIds.length < 2) {
      throw new DomainError(400, 'Il faut au moins 2 équipes pour lancer le tournoi.', { code: 'NOT_ENOUGH_TEAMS' });
    }

    if (removeIds.length > 0) {
      const { data: placed, error: placedError } = await supabase
        .from('phase_teams')
        .select('team_id')
        .in('team_id', removeIds);
      if (placedError) throw placedError;
      if ((placed ?? []).length > 0) {
        throw new DomainError(409, 'Des équipes non check-in sont déjà placées : retirez-les du placement avant de lancer.', {
          code: 'UNCHECKED_TEAMS_PLACED',
        });
      }
    }

    // Transition atomique : un double clic ne lance (et ne purge) qu'une seule fois.
    const { data: launched, error: updateError } = await supabase
      .from('tournaments')
      .update({ status: 'ACTIVE', updated_at: new Date().toISOString() })
      .eq('id', tournamentId)
      .in('status', ['DRAFT', 'REGISTRATION'])
      .select('id');
    if (updateError) throw updateError;
    if (!launched || launched.length === 0) {
      throw new DomainError(400, 'Le tournoi ne peut pas être lancé depuis son statut actuel.', { code: 'INVALID_STATUS' });
    }

    if (removeIds.length > 0) {
      const { error: removeError } = await supabase.from('teams').delete().in('id', removeIds);
      if (removeError) throw removeError;
    }
  }

  /**
   * Effets Discord du lancement, exécutés par le plugin après le commit (INT-01).
   * Idempotent pour le rejeu : une catégorie déjà créée et toujours présente n'est pas recréée.
   */
  static async syncDiscordLaunch(tournamentId: string, guildId: string, discordClient: Client): Promise<void> {
    const { data: tournament, error } = await supabase
      .from('tournaments')
      .select('*')
      .eq('id', tournamentId)
      .single();
    if (error || !tournament) throw new Error('Tournament not found');

    const guild: Guild | undefined = discordClient.guilds.cache.get(guildId) || await discordClient.guilds.fetch(guildId).catch(() => undefined);
    if (!guild) throw new Error(`Guild ${guildId} not found by bot.`);

    const existingCategory = tournament.discord_category_id
      ? await guild.channels.fetch(tournament.discord_category_id).catch(() => null)
      : null;

    if (!existingCategory) {
      await this.createLaunchChannels(tournament, guild, guildId);
    }

    const { data: phases } = await supabase.from('phases').select('id').eq('tournament_id', tournamentId);
    const phaseFailures: unknown[] = [];
    for (const phase of phases ?? []) {
      try {
        await this.syncPhaseChannels(phase.id, guildId, discordClient);
      } catch (err) {
        phaseFailures.push(err);
      }
    }
    if (phaseFailures.length > 0) {
      throw new Error(`${phaseFailures.length} phase(s) non synchronisée(s) sur Discord`, { cause: phaseFailures[0] });
    }
  }

  private static async createLaunchChannels(
    tournament: Pick<Tournament, 'id' | 'name' | 'discord_to_role_id' | 'discord_captain_role_id' | 'discord_announcement_channel_id'>,
    guild: Guild,
    guildId: string,
  ): Promise<void> {
    const lang = await getGuildLanguage(guildId, tournament.id);
    const permissions: OverwriteData[] = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
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

    const category = await guild.channels.create({
      name: `🏆 ${tournament.name}`,
      type: ChannelType.GuildCategory,
      permissionOverwrites: permissions,
    });

    const { error: categoryError } = await supabase
      .from('tournaments')
      .update({ discord_category_id: category.id })
      .eq('id', tournament.id);
    if (categoryError) throw categoryError;

    const infoChannel = await guild.channels.create({
      name: 'informations',
      type: ChannelType.GuildText,
      parent: category.id,
    });
    await infoChannel.send({
      ...(tournament.discord_captain_role_id ? { content: `<@&${tournament.discord_captain_role_id}>` } : {}),
      embeds: [{
        title: tBot(lang, 'lifecycle.tournamentLaunchedTitle'),
        description: tBot(lang, 'lifecycle.tournamentLaunchedDesc', { name: tournament.name }),
        color: 0x3b82f6,
      }],
    });

    if (tournament.discord_announcement_channel_id) {
      const announcement = await guild.channels.fetch(tournament.discord_announcement_channel_id).catch(() => null);
      if (announcement?.isTextBased()) {
        await announcement.send(tBot(lang, 'lifecycle.tournamentActiveAnnounce', { name: tournament.name }));
      }
    }
  }

  /** Transition métier de la clôture : un seul passage ACTIVE ➜ COMPLETED, sans appel Discord (LCH-07). */
  static async closeTournament(tournamentId: string): Promise<void> {
    const { data, error } = await supabase
      .from('tournaments')
      .update({ status: 'COMPLETED', updated_at: new Date().toISOString() })
      .eq('id', tournamentId)
      .eq('status', 'ACTIVE')
      .select('id');
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new DomainError(400, 'Seul un tournoi en cours peut être clôturé.', { code: 'INVALID_STATUS' });
    }
  }

  /** Supprime la catégorie Discord du tournoi et ses salons. Sans effet si elle n'existe plus (rejeu). */
  static async deleteDiscordCategory(tournamentId: string, guildId: string, discordClient: Client): Promise<void> {
    const { data: tournament, error } = await supabase
      .from('tournaments')
      .select('discord_category_id')
      .eq('id', tournamentId)
      .single();
    if (error || !tournament) throw new Error('Tournament not found');
    if (!tournament.discord_category_id) return;

    const guild: Guild | undefined = discordClient.guilds.cache.get(guildId) || await discordClient.guilds.fetch(guildId).catch(() => undefined);
    if (!guild) throw new Error(`Guild ${guildId} not found by bot.`);

    const category = await guild.channels.fetch(tournament.discord_category_id).catch(() => null);
    if (category?.type !== ChannelType.GuildCategory) return;

    for (const child of (category as CategoryChannel).children.cache.values()) {
      await child.delete('Tournament Closure');
    }
    await category.delete('Tournament Closure');
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
        const phaseCaptains = (ptData || []).flatMap((pt) => {
          const team = Array.isArray(pt.teams) ? pt.teams[0] : pt.teams;
          return team?.captain_discord_id ? [team.captain_discord_id] : [];
        });
        for (const capId of await captainsPresentInGuild(guild, phaseCaptains)) {
          perms.push({
            id: capId,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
          });
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
          for (const capId of await captainsPresentInGuild(guild, captainsInGroup)) {
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
