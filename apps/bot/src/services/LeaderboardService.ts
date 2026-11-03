import { resolveGroupPoints } from "@hub/shared";
import { supabase } from "../lib/supabase";
import { logger } from "../utils/logger";

// Mutex map: prevents concurrent calculations for the same group
const groupLocks: Map<string, Promise<void>> = new Map();

export class LeaderboardService {
  /**
   * Recalculates stats for all teams in a specific group and updates the phase_teams table.
   * Uses a per-group mutex to prevent concurrent calculations from overwriting each other.
   */
  public static async calculateGroupStandings(groupId: string): Promise<void> {
    // Wait for any in-progress calculation for this group, then re-run
    const existingLock = groupLocks.get(groupId);
    if (existingLock) {
      await existingLock;
      // After waiting, re-run to pick up any changes that occurred during the lock
    }

    const lockPromise = this.doCalculateGroupStandings(groupId);
    groupLocks.set(groupId, lockPromise);

    try {
      await lockPromise;
    } finally {
      groupLocks.delete(groupId);
    }
  }

  private static async doCalculateGroupStandings(groupId: string): Promise<void> {
    try {
      const { data: group } = await supabase
        .from("groups")
        .select("phase_id")
        .eq("id", groupId)
        .single();

      if (!group) return;

      const { data: phase } = await supabase
        .from("phases")
        .select("settings")
        .eq("id", group.phase_id)
        .single();

      if (!phase) return;

      let rawSettings: unknown = phase.settings;
      if (typeof rawSettings === "string") {
        try {
          rawSettings = JSON.parse(rawSettings);
        } catch (parseError) {
          logger.error(`[LeaderboardService] Malformed settings JSON for phase ${group.phase_id}, using defaults.`, parseError);
          rawSettings = null;
        }
      }
      const {
        points_win: pointsWin,
        points_draw: pointsDraw,
        points_loss: pointsLoss,
        points_forfeit: pointsForfeit,
      } = resolveGroupPoints(rawSettings);

      const { data: groupTeams } = await supabase
        .from("phase_teams")
        .select("team_id, phase_id")
        .eq("group_id", groupId);

      if (!groupTeams || groupTeams.length === 0) return;

      const statsMap: Record<string, any> = {};
      for (const t of groupTeams) {
        statsMap[t.team_id] = {
          played: 0, wins: 0, draws: 0, losses: 0, forfeits: 0,
          score_for: 0, score_against: 0, differential: 0, points: 0
        };
      }

      // Include both COMPLETED and BYE matches — BYE matches count as wins
      const { data: matches } = await supabase
        .from("matches")
        .select("team1_id, team2_id, team1_score, team2_score, status")
        .eq("group_id", groupId)
        .in("status", ["COMPLETED", "BYE"]);

      if (matches && matches.length > 0) {
        for (const match of matches) {
          const t1 = match.team1_id;
          const t2 = match.team2_id;
          const isBye = match.status === "BYE";
          const s1 = match.team1_score || 0;
          const s2 = match.team2_score || 0;

          // For BYE matches, the real team gets a win
          if (isBye) {
            const realTeamId = t1 || t2;
            if (realTeamId && statsMap[realTeamId]) {
              statsMap[realTeamId].played += 1;
              statsMap[realTeamId].wins += 1;
              statsMap[realTeamId].score_for += Math.max(s1, s2);
            }
            continue;
          }

          if (t1 && statsMap[t1]) {
            statsMap[t1].played += 1;
            statsMap[t1].score_for += s1;
            statsMap[t1].score_against += s2;
            if (s1 > s2) statsMap[t1].wins += 1;
            else if (s1 < s2) statsMap[t1].losses += 1;
            else statsMap[t1].draws += 1;
          }

          if (t2 && statsMap[t2]) {
            statsMap[t2].played += 1;
            statsMap[t2].score_for += s2;
            statsMap[t2].score_against += s1;
            if (s2 > s1) statsMap[t2].wins += 1;
            else if (s2 < s1) statsMap[t2].losses += 1;
            else statsMap[t2].draws += 1;
          }
        }
      }

      const updatePromises = [];
      for (const t of groupTeams) {
        const stats = statsMap[t.team_id];
        stats.differential = stats.score_for - stats.score_against;
        stats.points = (stats.wins * pointsWin) + (stats.draws * pointsDraw) + (stats.losses * pointsLoss) + (stats.forfeits * pointsForfeit);

        const promise = supabase
          .from("phase_teams")
          .update({
            played: stats.played, wins: stats.wins, draws: stats.draws,
            losses: stats.losses, forfeits: stats.forfeits,
            score_for: stats.score_for, score_against: stats.score_against,
            differential: stats.differential, points: stats.points
          })
          .eq("phase_id", t.phase_id)
          .eq("team_id", t.team_id);

        updatePromises.push(promise);
      }

      await Promise.all(updatePromises);
      logger.info(`[LeaderboardService] Successfully updated standings for group ${groupId}`);

    } catch (error) {
      logger.error(`[LeaderboardService] Error calculating group standings for ${groupId}:`, error);
    }
  }

  /**
   * Recalculates stats for all teams in a specific SWISS phase and updates the phase_teams table.
   */
  public static async calculateSwissStandings(phaseId: string): Promise<void> {
    try {
      const { data: phaseTeams } = await supabase
        .from("phase_teams")
        .select("team_id, phase_id")
        .eq("phase_id", phaseId);

      if (!phaseTeams || phaseTeams.length === 0) return;

      const statsMap: Record<string, any> = {};
      for (const t of phaseTeams) {
        statsMap[t.team_id] = {
          played: 0, wins: 0, losses: 0, forfeits: 0, draws: 0,
          score_for: 0, score_against: 0, differential: 0, points: 0
        };
      }

      // Get all completed/bye matches for this phase
      const { data: matches } = await supabase
        .from("matches")
        .select("team1_id, team2_id, team1_score, team2_score, status")
        .eq("phase_id", phaseId)
        .in("status", ["COMPLETED", "FF", "BYE"]);

      if (matches && matches.length > 0) {
        for (const match of matches) {
          const t1 = match.team1_id;
          const t2 = match.team2_id;
          const isBye = match.status === "BYE" || (!t2 && t1);
          const s1 = match.team1_score || 0;
          const s2 = match.team2_score || 0;

          if (isBye) {
            const realTeamId = t1 || t2;
            if (realTeamId && statsMap[realTeamId]) {
              statsMap[realTeamId].played += 1;
              statsMap[realTeamId].wins += 1;
              statsMap[realTeamId].score_for += Math.max(s1, s2);
              statsMap[realTeamId].points += 3; // 3 points for a BYE win
            }
            continue;
          }

          if (t1 && statsMap[t1]) {
            statsMap[t1].played += 1;
            statsMap[t1].score_for += s1;
            statsMap[t1].score_against += s2;
            if (s1 > s2) {
              statsMap[t1].wins += 1;
              statsMap[t1].points += 3;
            } else if (s1 < s2) {
              statsMap[t1].losses += 1;
            } else {
              statsMap[t1].draws += 1;
              statsMap[t1].points += 1;
            }
          }

          if (t2 && statsMap[t2]) {
            statsMap[t2].played += 1;
            statsMap[t2].score_for += s2;
            statsMap[t2].score_against += s1;
            if (s2 > s1) {
              statsMap[t2].wins += 1;
              statsMap[t2].points += 3;
            } else if (s2 < s1) {
              statsMap[t2].losses += 1;
            } else {
              statsMap[t2].draws += 1;
              statsMap[t2].points += 1;
            }
          }
        }
      }

      const updatePromises = [];
      for (const t of phaseTeams) {
        const stats = statsMap[t.team_id];
        stats.differential = stats.score_for - stats.score_against;

        const promise = supabase
          .from("phase_teams")
          .update({
            played: stats.played, wins: stats.wins, draws: stats.draws,
            losses: stats.losses, forfeits: stats.forfeits,
            score_for: stats.score_for, score_against: stats.score_against,
            differential: stats.differential, points: stats.points
          })
          .eq("phase_id", t.phase_id)
          .eq("team_id", t.team_id);

        updatePromises.push(promise);
      }

      await Promise.all(updatePromises);
      console.log(`[LeaderboardService] Successfully updated Swiss standings for phase ${phaseId}`);

    } catch (error) {
      console.error(`[LeaderboardService] Error calculating Swiss standings for phase ${phaseId}:`, error);
    }
  }
}
