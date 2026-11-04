import { Client, TextChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, Interaction } from 'discord.js';
import { supabase } from '../lib/supabase';
import { tBot, getGuildLanguage, isBotLocale } from '../i18n';
import { logger } from '../utils/logger';
import { applyPresence } from './CaptainPresenceService';

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface CachedRegistration {
  teamName: string;
  players: { name: string; fc: string }[];
  captainDiscordId: string;
  timer: NodeJS.Timeout;
}

const registrationCache = new Map<string, CachedRegistration>();

function setCacheWithTTL(key: string, data: Omit<CachedRegistration, 'timer'>) {
  // Clear existing timer if overwriting
  const existing = registrationCache.get(key);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    registrationCache.delete(key);
  }, CACHE_TTL_MS);

  registrationCache.set(key, { ...data, timer });
}

export class RegistrationService {

  static async sendRegistrationEmbed(tournamentId: string, client: Client) {
    try {
      const { data: tournament, error } = await supabase
        .from('tournaments')
        .select('*')
        .eq('id', tournamentId)
        .single();

      if (error || !tournament) throw new Error("Tournoi introuvable dans la base de données.");

      if (!tournament.discord_registration_channel_id) {
        throw new Error("Aucun salon d'inscription n'a été défini pour ce tournoi dans ses paramètres. Impossible d'envoyer l'annonce.");
      }

      const channel = await client.channels.fetch(tournament.discord_registration_channel_id).catch(() => null) as TextChannel | null;
      if (!channel) throw new Error(`Impossible de trouver le salon Discord avec l'ID ${tournament.discord_registration_channel_id}. Vérifiez que le bot y a accès.`);

      const lang = await getGuildLanguage(tournament.guild_id, tournament.id);

      const embed = {
        title: tBot(lang, 'registration.embedTitle', { name: tournament.name }),
        description: tournament.description || tBot(lang, 'registration.embedDescription'),
        color: 0x5865F2,
        fields: [
          {
            name: tBot(lang, 'registration.friendCodeRuleTitle'),
            value: tBot(lang, 'registration.friendCodeRuleValue')
          }
        ],
        footer: {
          text: tBot(lang, 'registration.tournamentIdFooter', { id: tournament.id })
        }
      };

      const toggleLang = lang === 'fr' ? 'en' : 'fr';
      const toggleLabel = lang === 'fr' ? 'View in 🇬🇧 English' : 'Voir en 🇫🇷 Français';

      const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`btn_register_${tournament.id}`)
            .setLabel(tBot(lang, 'registration.buttonLabel'))
            .setStyle(ButtonStyle.Primary)
            .setEmoji("📝"),
          new ButtonBuilder()
            .setCustomId(`btn_toggle_lang_${tournament.id}_${toggleLang}`)
            .setLabel(toggleLabel)
            .setStyle(ButtonStyle.Secondary)
        );

      await channel.send({ embeds: [embed], components: [row] });
      return true;

    } catch (e: any) {
      console.error("[RegistrationService] Error sending embed:", e);
      throw new Error(e.message);
    }
  }

  static async handleInteraction(interaction: Interaction) {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('btn_register_')) {
        await this.handleRegisterButton(interaction);
      } else if (interaction.customId.startsWith('btn_toggle_lang_')) {
        await this.handleToggleLangButton(interaction);
      } else if (interaction.customId.startsWith('btn_add_subs_')) {
        await this.handleSubsButton(interaction);
      } else if (interaction.customId.startsWith('btn_skip_subs_')) {
        await this.handleSkipSubsButton(interaction);
      }
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('modal_register_main_')) {
        await this.handleMainModalSubmit(interaction);
      } else if (interaction.customId.startsWith('modal_register_subs_')) {
        await this.handleSubsModalSubmit(interaction);
      }
    }
  }

  private static async handleToggleLangButton(interaction: any) {
    const parts = interaction.customId.split('_');
    const tournamentId = parts[3];
    const requestedLang = parts[4];
    const targetLang = isBotLocale(requestedLang) ? requestedLang : 'en';

    try {
      const { data: tournament } = await supabase
        .from('tournaments')
        .select('*')
        .eq('id', tournamentId)
        .single();

      if (!tournament || tournament.guild_id !== interaction.guildId) {
        return interaction.reply({ content: tBot(targetLang, 'registration.toggleUnauthorized'), ephemeral: true });
      }

      const embed = {
        title: tBot(targetLang, 'registration.embedTitle', { name: tournament.name }),
        description: tournament.description || tBot(targetLang, 'registration.embedDescription'),
        color: 0x5865F2,
        fields: [
          {
            name: tBot(targetLang, 'registration.friendCodeRuleTitle'),
            value: tBot(targetLang, 'registration.friendCodeRuleValue')
          }
        ],
        footer: {
          text: tBot(targetLang, 'registration.tournamentIdFooter', { id: tournament.id })
        }
      };

      return interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (e) {
      logger.error("[RegistrationService] Language toggle error:", e);
    }

    return interaction.reply({ content: tBot(targetLang, 'common.commandError'), ephemeral: true });
  }

  private static async handleRegisterButton(interaction: any) {
    const tournamentId = interaction.customId.split('_').pop();
    const lang = await getGuildLanguage(interaction.guildId, tournamentId);

    const { data: tournament, error } = await supabase
      .from('tournaments')
      .select('status, start_at, start_date, checkin_start_at')
      .eq('id', tournamentId)
      .single();

    if (error || !tournament) {
      return interaction.reply({ content: tBot(lang, 'registration.tournamentNotFound'), ephemeral: true });
    }

    const now = new Date();
    const startDate = tournament.start_at ? new Date(tournament.start_at) : (tournament.start_date ? new Date(tournament.start_date) : null);
    const checkinStart = tournament.checkin_start_at ? new Date(tournament.checkin_start_at) : null;

    if ((checkinStart && now >= checkinStart) || (startDate && now >= startDate) || tournament.status === 'ACTIVE' || tournament.status === 'COMPLETED' || tournament.status === 'ARCHIVED') {
      return interaction.reply({ content: tBot(lang, 'registration.closed'), ephemeral: true });
    }

    const modal = new ModalBuilder()
      .setCustomId(`modal_register_main_${tournamentId}`)
      .setTitle(tBot(lang, 'registration.modalTitle'));

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('team_name').setLabel(tBot(lang, 'registration.teamNameLabel')).setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('player1').setLabel(tBot(lang, 'registration.captainLabel')).setStyle(TextInputStyle.Short).setPlaceholder(tBot(lang, 'registration.playerPlaceholder')).setRequired(true)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('player2').setLabel(tBot(lang, 'registration.playerLabel', { number: 2 })).setStyle(TextInputStyle.Short).setPlaceholder(tBot(lang, 'registration.playerPlaceholder')).setRequired(true)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('player3').setLabel(tBot(lang, 'registration.playerLabel', { number: 3 })).setStyle(TextInputStyle.Short).setPlaceholder(tBot(lang, 'registration.playerPlaceholder')).setRequired(true)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('player4').setLabel(tBot(lang, 'registration.playerLabel', { number: 4 })).setStyle(TextInputStyle.Short).setPlaceholder(tBot(lang, 'registration.playerPlaceholder')).setRequired(true)
      )
    );

    await interaction.showModal(modal);
  }

  private static parsePlayerInput(input: string): { name: string, fc: string } | null {
    if (!input || input.trim() === '') return null;
    // Strict format: SW-XXXX-XXXX-XXXX (with dashes, 4 digits each)
    const regex = /(.+?)\s*(SW-\d{4}-\d{4}-\d{4})\s*$/i;
    const match = input.match(regex);
    if (!match || !match[1] || !match[2]) return null;

    const name = match[1].replace(/[-:]/g, '').trim();
    if (!name || name.length === 0) return null; // Name is required

    const fc = match[2].toUpperCase();
    return { name, fc };
  }

  private static async handleMainModalSubmit(interaction: any) {
    const tournamentId = interaction.customId.split('_').pop();
    const lang = await getGuildLanguage(interaction.guildId, tournamentId);

    const { data: tournament, error } = await supabase
      .from('tournaments')
      .select('status, start_at, start_date, checkin_start_at')
      .eq('id', tournamentId)
      .single();

    if (error || !tournament) {
      return interaction.reply({ content: tBot(lang, 'registration.tournamentNotFound'), ephemeral: true });
    }

    const now = new Date();
    const startDate = tournament.start_at ? new Date(tournament.start_at) : (tournament.start_date ? new Date(tournament.start_date) : null);
    const checkinStart = tournament.checkin_start_at ? new Date(tournament.checkin_start_at) : null;

    if ((checkinStart && now >= checkinStart) || (startDate && now >= startDate) || tournament.status === 'ACTIVE' || tournament.status === 'COMPLETED' || tournament.status === 'ARCHIVED') {
      return interaction.reply({ content: tBot(lang, 'registration.closed'), ephemeral: true });
    }

    const teamName = interaction.fields.getTextInputValue('team_name');
    const p1 = interaction.fields.getTextInputValue('player1');
    const p2 = interaction.fields.getTextInputValue('player2');
    const p3 = interaction.fields.getTextInputValue('player3');
    const p4 = interaction.fields.getTextInputValue('player4');

    const rawPlayers = [p1, p2, p3, p4];
    const parsedPlayers = [];
    const errors = [];

    for (let i = 0; i < rawPlayers.length; i++) {
      const p = this.parsePlayerInput(rawPlayers[i]);
      if (!p) {
        errors.push(tBot(lang, 'registration.invalidPlayerFc', { number: i + 1 }));
      } else {
        parsedPlayers.push(p);
      }
    }

    if (errors.length > 0) {
      return interaction.reply({
        content: tBot(lang, 'registration.fcErrorTitle', { errors: errors.join('\n') }),
        ephemeral: true
      });
    }

    // Check duplicate captain
    const { count } = await supabase
      .from('teams')
      .select('*', { count: 'exact', head: true })
      .eq('tournament_id', tournamentId)
      .eq('captain_discord_id', interaction.user.id);

    if (count && count > 0) {
      return interaction.reply({ content: tBot(lang, 'registration.alreadyCaptain'), ephemeral: true });
    }

    const cacheKey = `${interaction.user.id}_${tournamentId}`;

    setCacheWithTTL(cacheKey, {
      teamName,
      players: parsedPlayers,
      captainDiscordId: interaction.user.id
    });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`btn_add_subs_${tournamentId}`)
        .setLabel(tBot(lang, 'registration.addSubs'))
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("➕"),
      new ButtonBuilder()
        .setCustomId(`btn_skip_subs_${tournamentId}`)
        .setLabel(tBot(lang, 'registration.finishReg'))
        .setStyle(ButtonStyle.Success)
        .setEmoji("✅")
    );

    await interaction.reply({
      content: tBot(lang, 'registration.rosterValidated', { teamName }),
      components: [row],
      ephemeral: true
    });
  }

  private static async handleSubsButton(interaction: any) {
    const tournamentId = interaction.customId.split('_').pop();
    const lang = await getGuildLanguage(interaction.guildId, tournamentId);

    const modal = new ModalBuilder()
      .setCustomId(`modal_register_subs_${tournamentId}`)
      .setTitle(tBot(lang, 'registration.subModalTitle'));

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('sub1').setLabel(tBot(lang, 'registration.subLabel', { number: 1 })).setStyle(TextInputStyle.Short).setPlaceholder(tBot(lang, 'registration.playerPlaceholder')).setRequired(false)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('sub2').setLabel(tBot(lang, 'registration.subLabel', { number: 2 })).setStyle(TextInputStyle.Short).setPlaceholder(tBot(lang, 'registration.playerPlaceholder')).setRequired(false)
      )
    );

    await interaction.showModal(modal);
  }

  private static async handleSkipSubsButton(interaction: any) {
    const tournamentId = interaction.customId.split('_').pop();
    await this.finalizeRegistration(interaction, tournamentId, []);
  }

  private static async handleSubsModalSubmit(interaction: any) {
    const tournamentId = interaction.customId.split('_').pop();
    const lang = await getGuildLanguage(interaction.guildId, tournamentId);

    const sub1 = interaction.fields.getTextInputValue('sub1');
    const sub2 = interaction.fields.getTextInputValue('sub2');

    const parsedSubs = [];
    const errors = [];

    if (sub1 && sub1.trim() !== '') {
      const p = this.parsePlayerInput(sub1);
      if (!p) errors.push(tBot(lang, 'registration.invalidSubFc', { number: 1 }));
      else parsedSubs.push(p);
    }

    if (sub2 && sub2.trim() !== '') {
      const p = this.parsePlayerInput(sub2);
      if (!p) errors.push(tBot(lang, 'registration.invalidSubFc', { number: 2 }));
      else parsedSubs.push(p);
    }

    if (errors.length > 0) {
      return interaction.reply({
        content: tBot(lang, 'registration.subFcErrorTitle', { errors: errors.join('\n') }),
        ephemeral: true
      });
    }

    await this.finalizeRegistration(interaction, tournamentId, parsedSubs);
  }

  private static async finalizeRegistration(interaction: any, tournamentId: string, subs: any[]) {
    await interaction.deferReply({ ephemeral: true });
    try {
      const lang = await getGuildLanguage(interaction.guildId, tournamentId);
      const cacheKey = `${interaction.user.id}_${tournamentId}`;
      const cachedData = registrationCache.get(cacheKey);

      if (!cachedData) {
        return interaction.editReply({ content: tBot(lang, 'registration.sessionExpired') });
      }

      // Clear cache immediately to prevent double-registration
      clearTimeout(cachedData.timer);
      registrationCache.delete(cacheKey);

      const { data: tournament } = await supabase.from('tournaments').select('*').eq('id', tournamentId).single();

      const isCheckedIn = tournament?.checkin_mode === 'DISABLED';

      const { data: team, error: teamErr } = await supabase
        .from('teams')
        .insert({
          tournament_id: tournamentId,
          name: cachedData.teamName,
          captain_discord_id: interaction.user.id,
          is_checked_in: isCheckedIn
        })
        .select()
        .single();

      if (teamErr) {
        if (teamErr.message?.includes('unique_captain_per_tournament') || teamErr.code === '23505') {
          return interaction.editReply({ content: tBot(lang, 'registration.alreadyCaptain') });
        }
        throw teamErr;
      }
      if (!team) throw new Error("Équipe non créée");

      // Batch insert team members (PERF-02)
      const allPlayers = [...cachedData.players, ...subs];
      const membersToInsert = allPlayers.map((p, index) => ({
        team_id: team.id,
        user_id: index === 0 ? interaction.user.id : null,
        ingame_name: p.name,
        is_captain: index === 0,
        friend_code: p.fc
      }));

      const insertErrors: string[] = [];
      const { error: batchErr } = await supabase
        .from('team_members')
        .insert(membersToInsert);

      if (batchErr) {
        console.error("Erreur lors de l'insertion par lot des joueurs:", batchErr);
        insertErrors.push(batchErr.message);
      }

      // Announce in registration channel
      if (tournament && tournament.discord_registration_channel_id) {
        const annChannel = await interaction.client.channels.fetch(tournament.discord_registration_channel_id);
        if (annChannel && annChannel.isTextBased()) {
          const rosterStr = cachedData.players.map((p: any) => `• ${p.name}`).join('\n');
          const subsStr = subs.length > 0
            ? `${tBot(lang, 'registration.subsHeader')}${subs.map((s: any) => `• ${s.name}`).join('\n')}`
            : '';

          const embed = {
            title: tBot(lang, 'registration.newRegistrationAnnouncementTitle', { teamName: cachedData.teamName }),
            description: tBot(lang, 'registration.newRegistrationAnnouncementDesc', {
              teamName: cachedData.teamName,
              roster: rosterStr,
              subs: subsStr
            }),
            color: 0x57F287,
            timestamp: new Date().toISOString()
          };
          await annChannel.send({ embeds: [embed] });
        }
      }

      // Si check-in désactivé, appliquer la présence Discord dès l'inscription (#15 / #68)
      if (isCheckedIn) {
        try {
          await applyPresence(interaction.client, {
            id: team.id,
            tournament_id: team.tournament_id,
            name: team.name,
            captain_discord_id: team.captain_discord_id,
          });
        } catch (presenceErr) {
          logger.warn("Failed to apply presence on registration for disabled checkin tournament:", presenceErr);
        }
      }

      const warningStr = insertErrors.length > 0
        ? tBot(lang, 'registration.technicalWarning', { count: allPlayers.length })
        : '';

      const replyEmbed = {
        title: tBot(lang, 'registration.registrationSuccessTitle'),
        description: `${tBot(lang, 'registration.registrationSuccessDesc', { teamName: cachedData.teamName })}${warningStr}`,
        fields: [
          { name: tBot(lang, 'registration.nameChangeField'), value: isCheckedIn ? tBot(lang, 'registration.presenceApplied') : tBot(lang, 'registration.pendingCheckin'), inline: true },
          { name: tBot(lang, 'registration.captainRoleField'), value: isCheckedIn ? tBot(lang, 'registration.presenceApplied') : tBot(lang, 'registration.pendingCheckin'), inline: true }
        ],
        color: 0x57F287
      };

      await interaction.editReply({ content: '', embeds: [replyEmbed] });

    } catch (e: any) {
      console.error("Erreur lors de la finalisation", e);
      const lang = await getGuildLanguage(interaction.guildId, tournamentId);
      await interaction.editReply({ content: tBot(lang, 'registration.generalError', { message: e.message }) });
    }
  }
}
