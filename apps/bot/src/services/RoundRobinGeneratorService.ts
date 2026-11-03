import { supabase } from "../lib/supabase";
import { DomainError } from "../utils/serverError";

export class RoundRobinGeneratorService {
  static async generateGroups(phaseId: string, groupCount: number = 1) {
    const { data: seededRows, error: seedError } = await supabase
      .from("phase_teams")
      .select("team_id, seed")
      .eq("phase_id", phaseId)
      .order("seed", { ascending: true });

    if (seedError) throw seedError;
    const teams = seededRows || [];

    // Stale groups check — delete first, then recreate
    await supabase.from("groups").delete().eq("phase_id", phaseId);

    // Validate: need at least groupCount teams total to fill groups
    if (teams.length < groupCount) {
      throw new DomainError(400, `Cannot create ${groupCount} groups with only ${teams.length} teams. Reduce the number of groups or add more teams.`);
    }

    const newGroups = [];
    for (let i = 1; i <= groupCount; i++) {
      newGroups.push({ phase_id: phaseId, name: "Groupe " + i });
    }

    const { data: insertedGroups, error: groupErr } = await supabase
      .from("groups")
      .insert(newGroups)
      .select();

    if (groupErr || !insertedGroups) throw new Error("Erreur insertion groupes");

    // Snake seeding distribution
    const groups: { group_id: string, group_name: string, teams: any[] }[] = insertedGroups.map(g => ({
      group_id: g.id,
      group_name: g.name,
      teams: []
    }));

    let currentGroup = 0;
    let direction = 1;

    if (groups.length > 0) {
      for (const t of teams) {
        groups[currentGroup]?.teams.push(t);
        currentGroup += direction;
        if (currentGroup >= groupCount) {
          currentGroup = groupCount - 1;
          direction = -1;
        } else if (currentGroup < 0) {
          currentGroup = 0;
          direction = 1;
        }
      }
    }

    // Update phase_teams with their group assignment
    const phaseTeamsUpdates: Promise<void>[] = [];
    for (const g of groups) {
      for (const t of g.teams) {
        phaseTeamsUpdates.push(
          supabase
            .from("phase_teams")
            .update({ group_name: g.group_name, group_id: g.group_id })
            .match({ phase_id: phaseId, team_id: t.team_id })
            .then(({ error }) => {
              if (error) console.error("Error setting group_name", error);
            }) as Promise<void>
        );
      }
    }
    await Promise.all(phaseTeamsUpdates);

    const matchesToInsert: any[] = [];
    let matchCounter = 1;

    for (const g of groups) {
      const teamIds = g.teams.map((t: any) => t.team_id);

      if (teamIds.length < 2) continue;

      const hasBye = teamIds.length % 2 !== 0;
      if (hasBye) {
        teamIds.push("BYE");
      }

      const totalRounds = teamIds.length - 1;
      const matchesPerRound = teamIds.length / 2;

      for (let r = 1; r <= totalRounds; r++) {
        for (let i = 0; i < matchesPerRound; i++) {
          const t1 = teamIds[i];
          const t2 = teamIds[teamIds.length - 1 - i];

          if (t1 === "BYE" && t2 === "BYE") continue;

          const isByeMatch = t1 === "BYE" || t2 === "BYE";
          const realTeam1 = t1 === "BYE" ? (t2 as string) : (t1 as string);
          const realTeam2 = isByeMatch ? null : (t2 as string);

          matchesToInsert.push({
            phase_id: phaseId,
            group_id: g.group_id,
            team1_id: realTeam1,
            team2_id: realTeam2,
            round_number: r,
            match_number: matchCounter++,
            // BYE matches are COMPLETED so the leaderboard counts them as wins
            status: isByeMatch ? "COMPLETED" : "PENDING",
            team1_score: isByeMatch ? 1 : 0,
            team2_score: 0
          });
        }
        // Rotate: keep first fixed, move last to index 1
        const lastTeam = teamIds.pop()!;
        teamIds.splice(1, 0, lastTeam);
      }
    }

    if (matchesToInsert.length > 0) {
      const { error: insertError } = await supabase
        .from("matches")
        .insert(matchesToInsert);

      if (insertError) {
        console.error("Erreur Bulk Insert Round Robin Matches: ", insertError);
        throw new Error("La création des matchs de poule a échoué.");
      }
    }

    // Recalculate standings for all groups (handles BYE wins)
    const { LeaderboardService } = require("./LeaderboardService");
    for (const g of groups) {
      if (g.teams.length >= 2) {
        await LeaderboardService.calculateGroupStandings(g.group_id).catch((e: any) =>
          console.error(`Failed to calculate standings for group ${g.group_id}:`, e)
        );
      }
    }
  }
}
