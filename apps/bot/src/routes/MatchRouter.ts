import { Router } from "express";
import { supabase } from "../lib/supabase";
import { ScoreService } from "../services/ScoreService";
import { LeaderboardService } from "../services/LeaderboardService";
import { TextChannel } from "discord.js";
import { getAuthenticatedGuildId, verifyMatchGuild } from "../utils/tenant";

export const matchRouter = Router();

matchRouter.put("/:id/force-score", async (req, res) => {
  try {
    const matchId = req.params.id;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyMatchGuild(matchId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : ce match n'appartient pas à votre serveur." });
    }

    const { team1_score, team2_score } = req.body;

    if (
      typeof team1_score !== 'number' || typeof team2_score !== 'number' ||
      !Number.isInteger(team1_score) || !Number.isInteger(team2_score) ||
      team1_score < 0 || team2_score < 0 ||
      team1_score > 99 || team2_score > 99
    ) {
      return res.status(400).json({ error: "team1_score and team2_score must be integers between 0 and 99" });
    }

    const { data: updatedMatch, error: updateError } = await supabase
      .from("matches")
      .update({
        team1_score,
        team2_score,
        status: "COMPLETED"
      })
      .eq("id", matchId)
      .select()
      .single();

    if (updateError) throw updateError;
    if (!updatedMatch) return res.status(404).json({ error: "Match not found" });

    const discordClient = req.app.locals.discordClient;
    let channel: TextChannel | undefined;

    if (discordClient && updatedMatch.discord_channel_id) {
      try {
        const fetchedChannel = await discordClient.channels.fetch(updatedMatch.discord_channel_id);
        if (fetchedChannel && fetchedChannel.isTextBased()) {
          channel = fetchedChannel as TextChannel;
        }
      } catch (err) {
        console.warn(`Could not fetch channel ${updatedMatch.discord_channel_id} for match ${matchId}`);
      }
    }

    let winnerId: string | null = null;
    let loserId: string | null = null;
    if (team1_score > team2_score) {
      winnerId = updatedMatch.team1_id;
      loserId = updatedMatch.team2_id;
    } else if (team2_score > team1_score) {
      winnerId = updatedMatch.team2_id;
      loserId = updatedMatch.team1_id;
    }

    // Poules : le classement persisté (phase_teams, embeds Discord) suit le score forcé (LB-06).
    // La Suisse est recalculée par progressTeams.
    if (updatedMatch.group_id) {
      await LeaderboardService.calculateGroupStandings(updatedMatch.group_id);
    }

    await ScoreService.progressTeams(updatedMatch, channel, winnerId, loserId, discordClient);

    res.status(200).json({ message: "Score forced and bracket updated", match: updatedMatch });
  } catch (error: any) {
    console.error("Force Score Error:", error);
    res.status(500).json({ error: error.message });
  }
});
