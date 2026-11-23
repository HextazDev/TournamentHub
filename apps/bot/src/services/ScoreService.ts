import { type Client, ModalSubmitInteraction, ButtonInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel, StringSelectMenuInteraction, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { supabase } from "../lib/supabase";
import { LeaderboardService } from "./LeaderboardService";
import { SwissGeneratorService } from "./SwissGeneratorService";
import { LifecycleService } from "./LifecycleService";
import { IntegrationBus } from "./IntegrationBus";
import { tBot, getGuildLanguage, getPhaseLanguage, type BotLocale } from "../i18n";
import { logger } from "../utils/logger";
import { isFinishedMatchStatus, isSyntheticDiscordId } from "@hub/shared";
import { resolveActiveDiscordGuild, resolveOrganization } from "../utils/tenant";
import { assertChannelInGuild, isChannelInGuild } from "../utils/discordChannel";

type MatchValidationUpdate = { status: "COMPLETED" } | { status: "CONTESTED" };

export type MatchCompletionSource = "DISCORD" | "WEB_CAPTAIN" | "WEB_STAFF" | "TO_FORCE";

export interface MatchChannelRef {
  id?: string;
  discord_channel_id?: string | null;
  group_id?: string | null;
  phase_id?: string | null;
}

export interface MatchAnnounceRef extends MatchChannelRef {
  match_number?: number | null;
  team1_id?: string | null;
  team2_id?: string | null;
  team1_score?: number | null;
  team2_score?: number | null;
  status?: string | null;
}

interface ProgressPhaseRow {
  id?: string;
  name?: string | null;
  format?: string | null;
  tournament_id?: string | null;
  discord_channel_id?: string | null;
  settings?: { swiss_rounds_count?: number } | null;
}

function isValidScore(val: number): boolean {
  return Number.isInteger(val) && val >= 0 && val <= 99;
}

function formatBracketCaptainMention(captainId: string | null | undefined): string {
  if (!captainId || isSyntheticDiscordId(captainId)) return "";
  return ` (<@${captainId}>)`;
}

export class ScoreService {
  public static async handleSelectMenu(interaction: StringSelectMenuInteraction) {
    if (interaction.customId !== 'select_match_to_score') return;

    const matchId = interaction.values[0];
    const captainId = interaction.user.id;

    await interaction.deferReply({ ephemeral: true });

    const { data: match } = await supabase
      .from('matches')
      .select('*, teamA:teams!matches_team1_id_fkey(id, name, captain_discord_id), teamB:teams!matches_team2_id_fkey(id, name, captain_discord_id)')
      .eq('id', matchId)
      .single();

    const lang = await getPhaseLanguage(interaction.guildId, match?.phase_id);

    if (!match) {
      return interaction.editReply({ content: tBot(lang, 'score.matchNotFound') });
    }

    if (match.status !== 'PENDING' && match.status !== 'IN_PROGRESS') {
      return interaction.editReply({ content: tBot(lang, 'score.notPending') });
    }

    const isTeam1 = match.teamA?.captain_discord_id === captainId;
    const isTeam2 = match.teamB?.captain_discord_id === captainId;

    if (!isTeam1 && !isTeam2) {
      return interaction.editReply({ content: tBot(lang, 'score.notCaptain') });
    }

    const myTeamId = isTeam1 ? match.team1_id : match.team2_id;
    const myName = isTeam1 ? match.teamA?.name : match.teamB?.name;
    const unknownTeam = tBot(lang, 'score.unknownTeam');
    const oppName = isTeam1 ? match.teamB?.name || unknownTeam : match.teamA?.name || unknownTeam;

    const modal = new ModalBuilder()
      .setCustomId(`modal_score_${matchId}_${myTeamId}`)
      .setTitle(tBot(lang, 'score.modalTitle'));

    const myScoreInput = new TextInputBuilder()
      .setCustomId('my_score')
      .setLabel(tBot(lang, 'score.myScoreLabel', { name: myName ?? unknownTeam }))
      .setPlaceholder(tBot(lang, 'score.myScorePlaceholder'))
      .setStyle(TextInputStyle.Short)
      .setMaxLength(2)
      .setRequired(true);

    const oppScoreInput = new TextInputBuilder()
      .setCustomId('opponent_score')
      .setLabel(tBot(lang, 'score.oppScoreLabel', { name: oppName }))
      .setPlaceholder(tBot(lang, 'score.oppScorePlaceholder'))
      .setStyle(TextInputStyle.Short)
      .setMaxLength(2)
      .setRequired(true);

    const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(myScoreInput);
    const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(oppScoreInput);

    modal.addComponents(row1, row2);
    await interaction.showModal(modal);
  }

  public static async handleModalSubmit(interaction: ModalSubmitInteraction) {
    if (!interaction.customId.startsWith("modal_score_")) return;

    const parts = interaction.customId.split("_");
    const matchId = parts[2];
    const reporterTeamId = parts[3];

    const myScoreRaw = interaction.fields.getTextInputValue("my_score");
    const oppScoreRaw = interaction.fields.getTextInputValue("opponent_score");
    const myScore = parseInt(myScoreRaw, 10);
    const oppScore = parseInt(oppScoreRaw, 10);

    if (isNaN(myScore) || isNaN(oppScore) || !isValidScore(myScore) || !isValidScore(oppScore)) {
      const guildLang = await getGuildLanguage(interaction.guildId);
      return interaction.reply({ content: tBot(guildLang, 'score.invalidScore'), ephemeral: true });
    }

    // Defer immediately to avoid 3-second timeout
    await interaction.deferReply();

    // 1. Check Match
    const { data: match } = await supabase.from("matches").select("*").eq("id", matchId).single();
    const lang = await getPhaseLanguage(interaction.guildId, match?.phase_id);
    if (!match) return interaction.editReply({ content: tBot(lang, 'score.matchNotFound') });

    if (match.status !== 'PENDING' && match.status !== 'IN_PROGRESS') {
      return interaction.editReply({ content: tBot(lang, 'score.notPending') });
    }

    const isTeamA = match.team1_id === reporterTeamId;
    const team1Score = isTeamA ? myScore : oppScore;
    const team2Score = isTeamA ? oppScore : myScore;
    const opponentTeamId = isTeamA ? match.team2_id : match.team1_id;

    // 2. Update DB => WAITING_VALIDATION
    const { error } = await supabase.from("matches")
      .update({
        team1_score: team1Score,
        team2_score: team2Score,
        status: "WAITING_VALIDATION",
        reported_by_team_id: reporterTeamId
      })
      .eq("id", matchId);

    if (error) {
      return interaction.editReply({ content: tBot(lang, 'score.updateError') });
    }

    // 3. Avertir l'autre capitaine
    const { data: oppTeam } = await supabase.from("teams").select("name, captain_discord_id").eq("id", opponentTeamId).single();
    const { data: myTeam } = await supabase.from("teams").select("name").eq("id", reporterTeamId).single();

    if (!oppTeam) {
      return interaction.editReply({ content: tBot(lang, 'score.opponentNotFound') });
    }

    const reporterName = myTeam?.name ?? tBot(lang, 'score.unknownTeam');
    const embed = new EmbedBuilder()
      .setTitle(tBot(lang, 'score.waitingValidationTitle'))
      .setDescription(tBot(lang, 'score.waitingValidationDesc', {
        myTeam: reporterName,
        team1: isTeamA ? reporterName : oppTeam.name,
        score1: team1Score,
        team2: isTeamA ? oppTeam.name : reporterName,
        score2: team2Score,
      }))
      .setColor(0xFFA500);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`btn_score_val_${matchId}_${opponentTeamId}`)
        .setLabel(tBot(lang, 'score.validateBtn'))
        .setStyle(ButtonStyle.Success)
        .setEmoji("✅"),
      new ButtonBuilder()
        .setCustomId(`btn_score_deny_${matchId}_${opponentTeamId}`)
        .setLabel(tBot(lang, 'score.contestBtn'))
        .setStyle(ButtonStyle.Danger)
        .setEmoji("❌")
    );

    if (interaction.channel && 'send' in interaction.channel) {
      await interaction.channel.send({
        content: tBot(lang, 'score.notifyOpponent', { captainId: oppTeam.captain_discord_id }),
        embeds: [embed],
        components: [row]
      });
      await interaction.deleteReply();
    } else {
      await interaction.editReply({ content: tBot(lang, 'score.cannotNotifyHere') });
    }
  }

  public static async handleButton(interaction: ButtonInteraction) {
    if (!interaction.customId.startsWith("btn_score_")) return;

    const parts = interaction.customId.split("_");
    const action = parts[2]; // 'val' or 'deny'
    const matchId = parts[3];
    const expectedCaptainTeamId = parts[4];
    if (!matchId || !expectedCaptainTeamId) {
      logger.warn(`[ScoreService] customId de bouton de score invalide : ${interaction.customId}`);
      return;
    }

    // deferUpdate : editReply agit ensuite sur le message d'origine (celui qui porte les boutons).
    // Les refus passent donc par followUp éphémère pour ne pas écraser ce message.
    await interaction.deferUpdate();

    const { data: match } = await supabase.from("matches").select("*").eq("id", matchId).single();
    const lang = await getPhaseLanguage(interaction.guildId, match?.phase_id);

    const { data: team } = await supabase.from("teams").select("name, captain_discord_id").eq("id", expectedCaptainTeamId).single();

    if (!team || team.captain_discord_id !== interaction.user.id) {
      return interaction.followUp({ content: tBot(lang, 'score.onlyOpponentCanValidate'), ephemeral: true });
    }

    if (!match) return interaction.followUp({ content: tBot(lang, 'score.matchNotFound'), ephemeral: true });

    // SCR-05 : seul un score en attente de validation peut être validé ou contesté (vieux message, double-clic, score forcé par un TO).
    if (match.status !== "WAITING_VALIDATION") {
      return this.rejectProcessedClick(interaction, lang, matchId, match.status);
    }

    if (action === "deny") {
      const outcome = await this.transitionFromWaitingValidation(matchId, { status: "CONTESTED" });
      if (outcome === "error") return interaction.followUp({ content: tBot(lang, 'score.updateError'), ephemeral: true });
      if (outcome === "already_processed") return this.rejectProcessedClick(interaction, lang, matchId, "WAITING_VALIDATION");

      let toRoleId: string | null = null;
      if (interaction.guildId) {
        const org = await resolveOrganization(interaction.guildId);
        toRoleId = typeof org?.discordConfig?.to_role_id === "string" ? org.discordConfig.to_role_id : null;
      }
      const toPing = toRoleId ? `<@&${toRoleId}>` : tBot(lang, 'score.toFallback');

      const embedBase = interaction.message.embeds[0];
      if (!embedBase) return interaction.editReply({ content: tBot(lang, 'score.originalEmbedNotFound'), components: [] });

      const updatedEmbed = EmbedBuilder.from(embedBase)
        .setTitle(tBot(lang, 'score.scoreContestedTitle'))
        .setColor(0xFF0000)
        .setFooter({ text: tBot(lang, 'score.scoreContestedFooter') });

      await interaction.editReply({ content: tBot(lang, 'score.scoreContestedContent', { toPing }), embeds: [updatedEmbed], components: [] });

    } else if (action === "val") {
      let winnerId: string | null = null;
      let loserId: string | null = null;

      if (match.team1_score > match.team2_score) {
        winnerId = match.team1_id;
        loserId = match.team2_id;
      } else if (match.team2_score > match.team1_score) {
        winnerId = match.team2_id;
        loserId = match.team1_id;
      }

      const outcome = await this.transitionFromWaitingValidation(matchId, { status: "COMPLETED" });
      if (outcome === "error") return interaction.followUp({ content: tBot(lang, 'score.updateError'), ephemeral: true });
      // Un clic concurrent a gagné la transition : aucune progression ni recalcul de classement.
      if (outcome === "already_processed") return this.rejectProcessedClick(interaction, lang, matchId, "WAITING_VALIDATION");

      const embedBase = interaction.message.embeds[0];
      if (embedBase) {
        const updatedEmbed = EmbedBuilder.from(embedBase)
          .setTitle(tBot(lang, 'score.scoreValidatedTitle'))
          .setColor(0x00FF00)
          .setDescription(tBot(lang, 'score.scoreValidatedDesc', { teamName: team.name, score1: match.team1_score, score2: match.team2_score }))
          .setFooter({ text: tBot(lang, 'score.scoreValidatedFooter') });

        await interaction.editReply({ content: tBot(lang, 'score.matchFinished'), embeds: [updatedEmbed], components: [] });
      } else {
        await interaction.editReply({ content: tBot(lang, 'score.scoreValidatedShort'), components: [] });
      }

      // Leaderboard calculation for group matches
      if (match.group_id) {
        LeaderboardService.calculateGroupStandings(match.group_id).catch(console.error);
      }

      if (interaction.guildId) {
        const org = await resolveOrganization(interaction.guildId).catch(() => null);
        if (org) {
          await IntegrationBus.emit("onMatchCompleted", {
            organizationId: org.id,
            ...(typeof match.phase_id === "string" ? { phaseId: match.phase_id } : {}),
            matchId,
            discordClient: interaction.client,
            data: {
              source: "DISCORD" satisfies MatchCompletionSource,
              status: "COMPLETED",
              team1_score: match.team1_score,
              team2_score: match.team2_score,
            },
          });
        }
      }

      // Auto-routing in bracket
      if (interaction.channel && 'send' in interaction.channel) {
        await this.progressTeams(match, interaction.channel as TextChannel, winnerId, loserId, interaction.client);
      }
    }
  }

  /**
   * Transition atomique WAITING_VALIDATION ➜ COMPLETED | CONTESTED (SCR-05).
   * Le filtre sur le statut fait de l'update un verrou : un seul clic concurrent modifie la ligne.
   */
  private static async transitionFromWaitingValidation(matchId: string, update: MatchValidationUpdate): Promise<"applied" | "already_processed" | "error"> {
    const { data, error } = await supabase
      .from("matches")
      .update(update)
      .eq("id", matchId)
      .eq("status", "WAITING_VALIDATION")
      .select("id");

    if (error) {
      logger.error(`[ScoreService] Échec de la transition ${update.status} du match ${matchId}:`, error);
      return "error";
    }
    return data && data.length > 0 ? "applied" : "already_processed";
  }

  /** Clic sur un score déjà traité : refus éphémère, et retrait des boutons restés actifs sur le message d'origine. */
  private static async rejectProcessedClick(interaction: ButtonInteraction, lang: BotLocale, matchId: string, status: string) {
    logger.warn(`[ScoreService] Clic ignoré sur le match ${matchId} (statut ${status}) : score déjà traité.`);
    await interaction.followUp({ content: tBot(lang, 'score.alreadyProcessed'), ephemeral: true });
    await interaction.editReply({ components: [] });
  }

  /**
   * DISC-18 (#102) : résout le salon Discord associé à un match (match -> groupe -> phase).
   * Contrôle fail-closed (`isChannelInGuild`) sur `expectedGuildId` pour bloquer salons étrangers et DM (AUD-SEC-01/02).
   */
  public static async resolveMatchChannel(
    match: MatchChannelRef,
    discordClient: Pick<Client, "channels"> | undefined,
    options: { expectedGuildId: string; throwOnCrossGuild?: boolean; phaseChannelId?: string | null },
  ): Promise<TextChannel | undefined> {
    if (!discordClient || !options.expectedGuildId) return undefined;

    let channelId: string | null = typeof match.discord_channel_id === "string" && match.discord_channel_id ? match.discord_channel_id : null;

    if (!channelId && typeof match.group_id === "string" && match.group_id) {
      const { data: group } = await supabase
        .from("groups")
        .select("discord_channel_id")
        .eq("id", match.group_id)
        .maybeSingle();
      if (typeof group?.discord_channel_id === "string" && group.discord_channel_id) {
        channelId = group.discord_channel_id;
      }
    }

    if (!channelId && typeof options.phaseChannelId === "string" && options.phaseChannelId) {
      channelId = options.phaseChannelId;
    }

    if (!channelId && typeof match.phase_id === "string" && match.phase_id) {
      const { data: phase } = await supabase
        .from("phases")
        .select("discord_channel_id")
        .eq("id", match.phase_id)
        .maybeSingle();
      if (typeof phase?.discord_channel_id === "string" && phase.discord_channel_id) {
        channelId = phase.discord_channel_id;
      }
    }

    if (!channelId) return undefined;

    const fetched = await discordClient.channels.fetch(channelId);
    if (!fetched || !fetched.isTextBased()) return undefined;

    if (!isChannelInGuild(fetched, options.expectedGuildId)) {
      if (options.throwOnCrossGuild) {
        assertChannelInGuild(fetched, options.expectedGuildId, channelId);
      }
      logger.warn(`[ScoreService] Salon ${channelId} ignoré : n'appartient pas au serveur lié.`);
      return undefined;
    }

    return fetched as TextChannel;
  }

  /**
   * DISC-18 (#102) : publie le résultat d'un match validé sur le Web ou arbitré/forfait par un TO
   * dans le salon de phase ou de groupe. Sans effet pour `source === "DISCORD"` (embed déjà mis à jour).
   */
  public static async announceMatchCompleted(
    matchId: string,
    guildId: string,
    discordClient: Client,
    options: {
      source?: MatchCompletionSource;
      status?: string;
      team1Score?: number;
      team2Score?: number;
      match?: MatchAnnounceRef;
    } = {},
  ): Promise<void> {
    if (options.source === "DISCORD") return;

    let match: MatchAnnounceRef | null = options.match ?? null;
    if (!match) {
      const { data: fetchedMatch, error: matchErr } = await supabase
        .from("matches")
        .select("id, phase_id, group_id, match_number, team1_id, team2_id, team1_score, team2_score, status, discord_channel_id")
        .eq("id", matchId)
        .maybeSingle();
      if (matchErr) throw matchErr;
      match = fetchedMatch;
    }
    if (!match) return;

    const channel = await this.resolveMatchChannel(match, discordClient, {
      expectedGuildId: guildId,
      throwOnCrossGuild: true,
    });
    if (!channel) return;

    const teamIds = [match.team1_id, match.team2_id].filter((id): id is string => typeof id === "string");
    const { data: teams } = teamIds.length > 0
      ? await supabase.from("teams").select("id, name").in("id", teamIds)
      : { data: [] };

    const lang = await getPhaseLanguage(guildId, match.phase_id ?? undefined);
    const unknownTeam = tBot(lang, "score.unknownTeam");
    const nameById = new Map(((teams ?? []) as { id: string; name?: string | null }[]).map((t) => [t.id, t.name || unknownTeam]));
    const team1Name = (typeof match.team1_id === "string" ? nameById.get(match.team1_id) : undefined) ?? unknownTeam;
    const team2Name = (typeof match.team2_id === "string" ? nameById.get(match.team2_id) : undefined) ?? unknownTeam;

    const status = options.status ?? match.status;
    const score1 = options.team1Score ?? match.team1_score ?? 0;
    const score2 = options.team2Score ?? match.team2_score ?? 0;
    const isStaffArbitrated = options.source === "TO_FORCE" || options.source === "WEB_STAFF";

    const title =
      status === "FF"
        ? tBot(lang, "score.forfeitRecordedTitle")
        : isStaffArbitrated
          ? tBot(lang, "score.toScoreForcedTitle")
          : tBot(lang, "score.webScoreValidatedTitle");
    const color = status === "FF" ? 0xf59e0b : isStaffArbitrated ? 0x3b82f6 : 0x22c55e;
    const description =
      typeof match.match_number === "number"
        ? tBot(lang, "score.matchResultSummaryWithNumber", {
            number: match.match_number,
            team1: team1Name,
            score1,
            team2: team2Name,
            score2,
          })
        : tBot(lang, "score.matchResultSummary", {
            team1: team1Name,
            score1,
            team2: team2Name,
            score2,
          });

    const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color);
    await channel.send({ embeds: [embed] });
  }

  public static async progressTeams(
    match: any,
    channel: TextChannel | undefined,
    winnerId: string | null,
    loserId: string | null,
    discordClient?: any,
    options: { expectedGuildId?: string | null } = {},
  ) {
    const client = discordClient || channel?.client;
    let phase: ProgressPhaseRow | null = null;

    if (match.phase_id) {
      const { data: phaseData } = await supabase
        .from("phases")
        .select("*")
        .eq("id", match.phase_id)
        .single();
      phase = (phaseData as ProgressPhaseRow | null) ?? null;
    }

    let resolvedGuildId: string | null | undefined = options.expectedGuildId;
    const getExpectedGuildId = async (): Promise<string | null> => {
      if (resolvedGuildId !== undefined) return resolvedGuildId;
      if (phase?.tournament_id) {
        const { data: tournament } = await supabase
          .from("tournaments")
          .select("organization_id")
          .eq("id", phase.tournament_id)
          .single();
        resolvedGuildId = await resolveActiveDiscordGuild(tournament?.organization_id);
      } else {
        resolvedGuildId = null;
      }
      return resolvedGuildId;
    };

    // AUD-SEC-01 & AUD-PRF-01 : résolution paresseuse (uniquement si un message Discord est réellement à envoyer)
    // et toujours bornée par expectedGuildId (fail-closed, jamais de fuite cross-serveur).
    let channelResolved = Boolean(channel);
    let cachedChannel: TextChannel | undefined = channel;
    const getTargetChannel = async (): Promise<TextChannel | undefined> => {
      if (channelResolved) return cachedChannel;
      channelResolved = true;
      if (!client) return undefined;
      const expectedGuildId = await getExpectedGuildId();
      if (!expectedGuildId) return undefined;
      cachedChannel = await this.resolveMatchChannel(match, client, {
        expectedGuildId,
        ...(typeof phase?.discord_channel_id === "string" ? { phaseChannelId: phase.discord_channel_id } : {}),
      }).catch((err: unknown) => {
        logger.warn(`[ScoreService] Impossible de résoudre le salon Discord pour le match ${match.id}:`, err);
        return undefined;
      });
      return cachedChannel;
    };

    // 0. Handle Swiss format auto-progression
    if (match.phase_id && phase && phase.format === "SWISS") {
      // Recalculate Swiss standings to make sure they are up-to-date
      await LeaderboardService.calculateSwissStandings(match.phase_id).catch(console.error);

      // SCR-08 : la ronde est close quand tous ses matchs sont terminés (COMPLETED, FF ou BYE).
      const { data: roundMatches } = await supabase
        .from("matches")
        .select("status")
        .eq("phase_id", match.phase_id)
        .eq("round_number", match.round_number);

      if (roundMatches) {
        const isRoundFinished = roundMatches.every(m => isFinishedMatchStatus(m.status));
        if (isRoundFinished) {
          const maxRounds = phase.settings?.swiss_rounds_count || 3;
          const currentRound = match.round_number;

          if (currentRound < maxRounds) {
            // Generate next round
            const nextRound = currentRound + 1;
            const generated = await SwissGeneratorService.generateNextRound(match.phase_id, nextRound);
            // SWS-06 : ronde déjà générée par un autre appel ➜ ni resynchronisation ni annonce en double.
            if (!generated) return;

            // Sync phase channel permissions
            if (client && phase.tournament_id) {
              const activeGuildId = await getExpectedGuildId();
              if (activeGuildId) {
                await LifecycleService.syncPhaseChannels(match.phase_id, activeGuildId, client).catch(console.error);
              }
            }

            // Post round announcement and captain pings in the Swiss channel
            const targetChannel = await getTargetChannel();
            if (targetChannel) {
              const lang = await getPhaseLanguage(targetChannel.guildId, match.phase_id);
              const unknownTeam = tBot(lang, 'score.unknownTeam');
              const { data: nextMatches } = await supabase
                .from("matches")
                .select(`
                  id, match_number, status, team1_id, team2_id,
                  teamA:teams!matches_team1_id_fkey(name, captain_discord_id),
                  teamB:teams!matches_team2_id_fkey(name, captain_discord_id)
                `)
                .eq("phase_id", match.phase_id)
                .eq("round_number", nextRound);

              if (nextMatches && nextMatches.length > 0) {
                const embed = new EmbedBuilder()
                  .setTitle(tBot(lang, 'score.swissRoundGenerated', { round: nextRound }))
                  .setDescription(tBot(lang, 'score.swissRoundDesc', { prevRound: currentRound, round: nextRound }))
                  .setColor(0x0099FF);

                const pings: string[] = [];
                const matchesList: string[] = [];
                const pushCaptainPing = (captainId: unknown) => {
                  if (typeof captainId === "string" && captainId && !isSyntheticDiscordId(captainId)) {
                    pings.push(`<@${captainId}>`);
                  }
                };

                nextMatches.forEach(m => {
                  const tA = (Array.isArray(m.teamA) ? m.teamA[0] : m.teamA) as { name?: string | null; captain_discord_id?: string | null } | null;
                  const tB = (Array.isArray(m.teamB) ? m.teamB[0] : m.teamB) as { name?: string | null; captain_discord_id?: string | null } | null;

                  if (m.status === "BYE") {
                    const taName = tA?.name || unknownTeam;
                    matchesList.push(tBot(lang, 'score.swissMatchBye', { number: m.match_number, name: taName }));
                    pushCaptainPing(tA?.captain_discord_id);
                  } else {
                    const taName = tA?.name || unknownTeam;
                    const tbName = tB?.name || unknownTeam;
                    matchesList.push(tBot(lang, 'score.swissMatchVs', { number: m.match_number, name1: taName, name2: tbName }));
                    pushCaptainPing(tA?.captain_discord_id);
                    pushCaptainPing(tB?.captain_discord_id);
                  }
                });

                embed.addFields({ name: tBot(lang, 'score.swissRoundMatchesField'), value: matchesList.join("\n") });

                await targetChannel.send({
                  ...(pings.length > 0 ? { content: tBot(lang, 'score.swissCaptainsPing', { pings: pings.join(" "), round: nextRound }) } : {}),
                  embeds: [embed]
                }).catch((err: unknown) => {
                  logger.warn(`[ScoreService] Échec d'annonce de la ronde suisse ${nextRound}:`, err);
                });
              }
            }
          } else {
            // All rounds finished! Let's end the Swiss phase.
            const targetChannel = await getTargetChannel();
            if (targetChannel) {
              const lang = await getPhaseLanguage(targetChannel.guildId, match.phase_id);
              const unknownTeam = tBot(lang, 'score.unknownTeam');
              const { data: standings } = await supabase
                .from("phase_teams")
                .select(`
                  points, wins, draws, played,
                  team:teams(name)
                `)
                .eq("phase_id", match.phase_id)
                .order("points", { ascending: false })
                .order("wins", { ascending: false });

              if (standings && standings.length > 0) {
                const embed = new EmbedBuilder()
                  .setTitle(tBot(lang, 'score.swissFinishedTitle'))
                  .setDescription(tBot(lang, 'score.swissFinishedDesc', { name: phase.name ?? unknownTeam, rounds: maxRounds }))
                  .setColor(0xFFD700);

                const standingsText = standings.map((s, idx) => {
                  const t = (Array.isArray(s.team) ? s.team[0] : s.team) as { name?: string | null } | null;
                  const tName = t?.name || unknownTeam;
                  return tBot(lang, 'score.swissStandingLine', { rank: idx + 1, name: tName, points: s.points, wins: s.wins, played: s.played });
                }).join("\n");

                embed.addFields({ name: tBot(lang, 'score.swissStandingsField'), value: standingsText });

                await targetChannel.send({
                  content: tBot(lang, 'score.swissFinishedCongrats'),
                  embeds: [embed]
                }).catch((err: unknown) => {
                  logger.warn(`[ScoreService] Échec d'annonce de fin de ronde suisse:`, err);
                });
              }
            }
          }
        }
      }
      return; // Done with Swiss, do not execute normal bracket routing
    }

    if (!winnerId || !loserId) {
      // SCR-06 / AUD-BUG-01 : seuls les brackets à élimination (ou matchs avec auto-routing) requièrent un arbitrage sur égalité.
      // En poules (ROUND_ROBIN), l'égalité est légitime et ne doit jamais déclencher d'alerte @TO.
      const requiresBracketRouting =
        Boolean(match.next_match_winner_id || match.next_match_loser_id) ||
        phase?.format === "SINGLE_ELIM" ||
        phase?.format === "DOUBLE_ELIM";
      if (!requiresBracketRouting) return;

      const targetChannel = await getTargetChannel();
      if (targetChannel) {
        const lang = await getPhaseLanguage(targetChannel.guildId, match.phase_id);
        const org = await resolveOrganization(targetChannel.guildId);
        const toRoleId = typeof org?.discordConfig?.to_role_id === "string" ? org.discordConfig.to_role_id : null;
        const toPing = toRoleId ? `<@&${toRoleId}>` : tBot(lang, 'score.toFallback');
        await targetChannel
          .send(tBot(lang, 'score.drawMatchNotice', { matchNumber: match.match_number || '?', toPing }))
          .catch((err: unknown) => {
            logger.warn(`[ScoreService] Échec d'annonce de match nul pour ${match.id}:`, err);
          });
      }
      return;
    }

    if (match.next_match_winner_id) {
      await this.assignTeamToNextMatch(match.next_match_winner_id, winnerId, getTargetChannel);
    }
    if (match.next_match_loser_id) {
      await this.assignTeamToNextMatch(match.next_match_loser_id, loserId, getTargetChannel);
    }
  }

  private static async assignTeamToNextMatch(
    targetMatchId: string,
    teamId: string,
    getChannel: () => Promise<TextChannel | undefined>,
  ) {
    // Use atomic RPC function to prevent race conditions
    const { data: result, error } = await supabase.rpc('assign_team_to_match', {
      p_target_match_id: targetMatchId,
      p_team_id: teamId
    });

    if (error) {
      console.error('[ScoreService] Error in atomic assign_team_to_match:', error);
      // Fallback: try the old non-atomic way
      const { data: targetMatch } = await supabase.from("matches").select("*").eq("id", targetMatchId).single();
      if (!targetMatch) return;

      const updateData: { team1_id?: string; team2_id?: string } = {};
      if (!targetMatch.team1_id) {
        updateData.team1_id = teamId;
      } else if (!targetMatch.team2_id && targetMatch.team1_id !== teamId) {
        updateData.team2_id = teamId;
      } else {
        return;
      }
      await supabase.from("matches").update(updateData).eq("id", targetMatchId);

      // Check if match is now full for notification
      const newTeamA = targetMatch.team1_id || updateData.team1_id;
      const newTeamB = targetMatch.team2_id || updateData.team2_id;
      if (newTeamA && newTeamB) {
        await this.notifyMatchReady(newTeamA, newTeamB, await getChannel());
      }
      return;
    }

    if (!result || result.length === 0) {
      console.log(`[ScoreService] Team ${teamId} could not be assigned to match ${targetMatchId} (already full or conflict)`);
      return;
    }

    // Check if the match is now fully assigned after our atomic operation
    const { data: updatedMatch } = await supabase.from("matches").select("team1_id, team2_id").eq("id", targetMatchId).single();
    if (updatedMatch?.team1_id && updatedMatch?.team2_id) {
      await this.notifyMatchReady(updatedMatch.team1_id, updatedMatch.team2_id, await getChannel());
    }
  }

  private static async notifyMatchReady(team1Id: string, team2Id: string, channel: TextChannel | undefined) {
    if (!channel) return;
    const [{ data: ta }, { data: tb }] = await Promise.all([
      supabase.from("teams").select("captain_discord_id, name, tournament_id").eq("id", team1Id).single(),
      supabase.from("teams").select("captain_discord_id, name").eq("id", team2Id).single()
    ]);

    if (ta && tb) {
      const lang = await getGuildLanguage(channel.guildId, ta.tournament_id);
      await channel
        .send(
          tBot(lang, 'score.newBracketMatch', {
            team1: ta.name,
            cap1: formatBracketCaptainMention(ta.captain_discord_id),
            team2: tb.name,
            cap2: formatBracketCaptainMention(tb.captain_discord_id),
          }),
        )
        .catch((err: unknown) => {
          logger.warn(`[ScoreService] Échec d'annonce du match prêt (${team1Id} vs ${team2Id}):`, err);
        });
    }
  }
}
