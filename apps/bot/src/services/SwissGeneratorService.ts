import { supabase } from "../lib/supabase";
import crypto from "crypto";
import { LeaderboardService } from "./LeaderboardService";
import { logger } from "../utils/logger";

export class SwissGeneratorService {
  /**
   * Generates Round 1 Swiss matches based on seeded teams.
   */
  public static async generateFirstRound(phaseId: string) {
    // 1. Get phase teams
    const { data: seededRows, error: seedError } = await supabase
      .from("phase_teams")
      .select("team_id, seed")
      .eq("phase_id", phaseId)
      .order("seed", { ascending: true });

    if (seedError) throw seedError;
    const teams = seededRows || [];

    if (teams.length < 2) {
      throw new Error("Il faut au moins 2 équipes pour générer une ronde suisse.");
    }

    // Check if matches already exist to avoid duplicates
    const { data: existingMatches } = await supabase
      .from("matches")
      .select("id")
      .eq("phase_id", phaseId)
      .limit(1);

    if (existingMatches && existingMatches.length > 0) {
      throw new Error(`Des matchs existent déjà pour la phase ${phaseId}.`);
    }

    const matchesToInsert: any[] = [];
    let matchCounter = 1;

    // Handle odd number of teams -> last team gets a BYE
    const teamIds = teams.map(t => t.team_id);
    const hasOddTeams = teamIds.length % 2 !== 0;
    
    let byeTeamId: string | null = null;
    if (hasOddTeams) {
      // Last team (lowest seed) gets the BYE in Round 1
      byeTeamId = teamIds.pop()!;
    }

    // Pair remaining teams: 1 vs 2, 3 vs 4, etc.
    for (let i = 0; i < teamIds.length; i += 2) {
      matchesToInsert.push({
        id: crypto.randomUUID(),
        phase_id: phaseId,
        team1_id: teamIds[i],
        team2_id: teamIds[i + 1],
        round_number: 1,
        match_number: matchCounter++,
        status: "PENDING",
        team1_score: 0,
        team2_score: 0
      });
    }

    // Insert the BYE match if any
    if (byeTeamId) {
      matchesToInsert.push({
        id: crypto.randomUUID(),
        phase_id: phaseId,
        team1_id: byeTeamId,
        team2_id: null,
        round_number: 1,
        match_number: matchCounter++,
        status: "BYE", // Store status as BYE so LeaderboardService counts it as a win!
        team1_score: 1,
        team2_score: 0
      });
    }

    const { error: insertError } = await supabase.from("matches").insert(matchesToInsert);
    if (insertError) throw insertError;

    // Calculate Swiss standings immediately (handles the BYE team getting their point)
    await LeaderboardService.calculateSwissStandings(phaseId).catch(console.error);
  }

  /**
   * Generates next Round matches dynamically based on current standings and match history.
   * @returns `true` si la ronde a été créée, `false` si elle existait déjà (SWS-06 : aucune insertion).
   */
  public static async generateNextRound(phaseId: string, nextRoundNumber: number): Promise<boolean> {
    // 0. SWS-06 : ne jamais générer deux fois la même ronde (double validation, score forcé par un TO…)
    const { data: existingRound, error: existingError } = await supabase
      .from("matches")
      .select("id")
      .eq("phase_id", phaseId)
      .eq("round_number", nextRoundNumber)
      .limit(1);

    if (existingError) throw existingError;
    if (existingRound && existingRound.length > 0) {
      logger.warn(`[SwissGenerator] Ronde ${nextRoundNumber} déjà générée pour la phase ${phaseId} : génération ignorée.`);
      return false;
    }

    // 1. Get all teams in this phase
    const { data: phaseTeams, error: ptError } = await supabase
      .from("phase_teams")
      .select("team_id, points, wins")
      .eq("phase_id", phaseId);

    if (ptError || !phaseTeams || phaseTeams.length < 2) {
      throw new Error("Impossible de récupérer les équipes de la phase.");
    }

    // 2. Get all matches so far (completed/bye) to build history and verify past matchups
    const { data: pastMatches, error: matchesError } = await supabase
      .from("matches")
      .select("team1_id, team2_id, status, round_number")
      .eq("phase_id", phaseId);

    if (matchesError) throw matchesError;

    // Build map of who has played whom
    const playedHistory: Record<string, Set<string>> = {};
    const byeHistory: Set<string> = new Set();

    phaseTeams.forEach(t => {
      playedHistory[t.team_id] = new Set();
    });

    pastMatches?.forEach(m => {
      const t1 = m.team1_id;
      const t2 = m.team2_id;
      if (m.status === "BYE" || (!t2 && t1)) {
        if (t1) byeHistory.add(t1);
        return;
      }
      if (t1 && t2) {
        playedHistory[t1]?.add(t2);
        playedHistory[t2]?.add(t1);
      }
    });

    // 3. Sort teams by their current points / wins descending (highest points first)
    const sortedTeams = [...phaseTeams].sort((a, b) => b.points - a.points || b.wins - a.wins);

    const matchesToInsert: any[] = [];
    let matchCounter = 1;

    // Check if we need to assign a BYE (odd number of teams)
    let byeTeamId: string | null = null;
    if (sortedTeams.length % 2 !== 0) {
      // Find the team with the lowest points that hasn't had a BYE yet
      for (let i = sortedTeams.length - 1; i >= 0; i--) {
        const team = sortedTeams[i]!;
        if (!byeHistory.has(team.team_id)) {
          byeTeamId = team.team_id;
          sortedTeams.splice(i, 1); // Remove from pool of teams to be paired
          break;
        }
      }
      // Fallback in case everyone had a BYE (unlikely): take the last team
      if (!byeTeamId) {
        const lastTeam = sortedTeams.pop()!;
        byeTeamId = lastTeam.team_id;
      }
    }

    // 4. Pair teams using Score Group Pairing with simple backtracking / float-down
    const unmatchedTeams = [...sortedTeams];
    const pairs: [string, string][] = [];

    while (unmatchedTeams.length > 0) {
      const teamA = unmatchedTeams.shift()!; // Take highest ranked unmatched team
      let pairedIndex = -1;

      // Try to find the closest opponent in rank who teamA hasn't played yet
      for (let i = 0; i < unmatchedTeams.length; i++) {
        const teamB = unmatchedTeams[i]!;
        if (!playedHistory[teamA.team_id]?.has(teamB.team_id)) {
          pairedIndex = i;
          break;
        }
      }

      if (pairedIndex !== -1) {
        const teamB = unmatchedTeams.splice(pairedIndex, 1)[0]!;
        pairs.push([teamA.team_id, teamB.team_id]);
      } else {
        // Backtracking / Fallback: If no valid opponent found (rare in early rounds),
        // we pair with the closest unmatched team regardless of history to prevent blocking.
        if (unmatchedTeams.length > 0) {
          const teamB = unmatchedTeams.shift()!;
          pairs.push([teamA.team_id, teamB.team_id]);
        }
      }
    }

    // 5. Create new matches in database
    for (const pair of pairs) {
      matchesToInsert.push({
        id: crypto.randomUUID(),
        phase_id: phaseId,
        team1_id: pair[0],
        team2_id: pair[1],
        round_number: nextRoundNumber,
        match_number: matchCounter++,
        status: "PENDING",
        team1_score: 0,
        team2_score: 0
      });
    }

    if (byeTeamId) {
      matchesToInsert.push({
        id: crypto.randomUUID(),
        phase_id: phaseId,
        team1_id: byeTeamId,
        team2_id: null,
        round_number: nextRoundNumber,
        match_number: matchCounter++,
        status: "BYE",
        team1_score: 1,
        team2_score: 0
      });
    }

    const { error: insertError } = await supabase.from("matches").insert(matchesToInsert);
    if (insertError) throw insertError;

    // Automatically recalculate Swiss standings to account for new BYE point
    await LeaderboardService.calculateSwissStandings(phaseId).catch(console.error);
    return true;
  }
}
