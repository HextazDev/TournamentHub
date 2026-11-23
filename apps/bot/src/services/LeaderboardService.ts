import {
  STANDINGS_MATCH_STATUSES,
  computeStandings,
  resolveGroupPoints,
  type GroupPoints,
  type StandingsMatch,
} from "@hub/shared";
import { supabase } from "../lib/supabase";
import { logger } from "../utils/logger";

// Mutex map: prevents concurrent calculations for the same group
const groupLocks: Map<string, Promise<void>> = new Map();

interface PhaseTeamRow {
  team_id: string;
  phase_id: string;
}

const STANDINGS_MATCH_COLUMNS = "team1_id, team2_id, team1_score, team2_score, status";

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

      const points = await this.loadPhasePoints(group.phase_id);
      if (!points) return;

      const { data: groupTeams } = await supabase
        .from("phase_teams")
        .select("team_id, phase_id")
        .eq("group_id", groupId);

      if (!groupTeams || groupTeams.length === 0) return;

      // COMPLETED, FF (forfait exclusif, LB-05) et BYE : même calcul que le web (LB-06)
      const { data: matches } = await supabase
        .from("matches")
        .select(STANDINGS_MATCH_COLUMNS)
        .eq("group_id", groupId)
        .in("status", [...STANDINGS_MATCH_STATUSES]);

      await this.persistStandings(groupTeams, matches ?? [], points);
      logger.info(`[LeaderboardService] Successfully updated standings for group ${groupId}`);
    } catch (error) {
      logger.error(`[LeaderboardService] Error calculating group standings for ${groupId}:`, error);
    }
  }

  /**
   * Recalculates stats for all teams in a specific SWISS phase and updates the phase_teams table.
   * Le barème vient de `phase.settings`, BYE compris (SWS-05).
   */
  public static async calculateSwissStandings(phaseId: string): Promise<void> {
    try {
      const points = await this.loadPhasePoints(phaseId);
      if (!points) return;

      const { data: phaseTeams } = await supabase
        .from("phase_teams")
        .select("team_id, phase_id")
        .eq("phase_id", phaseId);

      if (!phaseTeams || phaseTeams.length === 0) return;

      const { data: matches } = await supabase
        .from("matches")
        .select(STANDINGS_MATCH_COLUMNS)
        .eq("phase_id", phaseId)
        .in("status", [...STANDINGS_MATCH_STATUSES]);

      await this.persistStandings(phaseTeams, matches ?? [], points);
      logger.info(`[LeaderboardService] Successfully updated Swiss standings for phase ${phaseId}`);
    } catch (error) {
      logger.error(`[LeaderboardService] Error calculating Swiss standings for phase ${phaseId}:`, error);
    }
  }

  /** Barème de la phase ; `null` si la phase n'existe pas. Un JSON malformé retombe sur le défaut (LB-02). */
  private static async loadPhasePoints(phaseId: string): Promise<GroupPoints | null> {
    const { data: phase } = await supabase
      .from("phases")
      .select("settings")
      .eq("id", phaseId)
      .single();

    if (!phase) return null;

    let rawSettings: unknown = phase.settings;
    if (typeof rawSettings === "string") {
      try {
        rawSettings = JSON.parse(rawSettings);
      } catch (parseError) {
        logger.error(`[LeaderboardService] Malformed settings JSON for phase ${phaseId}, using defaults.`, parseError);
        rawSettings = null;
      }
    }
    return resolveGroupPoints(rawSettings);
  }

  private static async persistStandings(
    phaseTeams: readonly PhaseTeamRow[],
    matches: readonly StandingsMatch[],
    points: GroupPoints,
  ): Promise<void> {
    const standings = computeStandings(phaseTeams.map((t) => t.team_id), matches, points);

    await Promise.all(
      phaseTeams.map(async (t) => {
        const stats = standings.get(t.team_id);
        if (!stats) return;
        const { error } = await supabase
          .from("phase_teams")
          .update(stats)
          .eq("phase_id", t.phase_id)
          .eq("team_id", t.team_id);
        if (error) throw error;
      }),
    );
  }
}
