import { Router } from "express";
import { supabase } from "../lib/supabase";
import { ScoreService } from "../services/ScoreService";
import { LeaderboardService } from "../services/LeaderboardService";
import { TextChannel } from "discord.js";
import { getAuthenticatedGuildId, verifyMatchGuild } from "../utils/tenant";
import { ForceScoreSchema } from "@hub/shared";
import { sendServerError } from "../utils/serverError";
import { requireTournamentScope, tournamentFrom } from "../middleware/auth";

export const matchRouter = Router();

matchRouter.put("/:id/force-score", requireTournamentScope(tournamentFrom.match("id")), async (req, res) => {
  try {
    const matchId = req.params.id;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyMatchGuild(matchId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : ce match n'appartient pas à votre serveur." });
    }

    // SCR-01 / SCR-10 : corps validé (scores entiers 0-99, statut COMPLETED | FF) avant toute écriture.
    const parsed = ForceScoreSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
    }
    const { team1_score, team2_score, status } = parsed.data;

    // Un forfait (FF) suit la même progression et le même recalcul qu'un COMPLETED ;
    // computeStandings lui applique la sémantique « forfait exclusif » (LB-05, LB-07).
    const { data: updatedMatch, error: updateError } = await supabase
      .from("matches")
      .update({
        team1_score,
        team2_score,
        status
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
  } catch (error: unknown) {
    sendServerError(res, error, "MatchRouter.forceScore");
  }
});
