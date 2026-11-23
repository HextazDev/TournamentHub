import { supabase } from "../lib/supabase";
import { DomainError } from "../utils/serverError";
import crypto from "crypto";

interface MatchData {
  id: string;
  phase_id: string;
  round_number: number;
  match_number: number;
  team1_id: string | null;
  team2_id: string | null;
  next_match_winner_id: string | null;
  next_match_loser_id?: string | null;
  status: string;
  team1_score?: number;
  team2_score?: number;
}

export class BracketGeneratorService {
  public static getStandardSeeds(bracketSize: number): number[] {
    let seeds = [1, 2];
    for (let currentSize = 4; currentSize <= bracketSize; currentSize *= 2) {
      const nextSeeds = [];
      for (const seed of seeds) {
        nextSeeds.push(seed);
        nextSeeds.push(currentSize + 1 - seed);
      }
      seeds = nextSeeds;
    }
    return seeds;
  }

  static async generateBracket(phaseId: string, bracketSize: number) {
    const { data: phase } = await supabase
      .from("phases")
      .select("format")
      .eq("id", phaseId)
      .single();
    
    const isDoubleElim = phase?.format === "DOUBLE_ELIM";

    const { data: seededRows, error: seedError } = await supabase
      .from("phase_teams")
      .select("team_id, seed")
      .eq("phase_id", phaseId);

    if (seedError) throw seedError;
    const seededTeams = seededRows || [];

    // Check for duplicate seeds (ignoring signs, i.e. absolute value)
    const seedSet = new Set<number>();
    for (const row of seededTeams) {
      if (row.seed !== null && row.seed !== undefined) {
        const absSeed = Math.abs(row.seed);
        if (seedSet.has(absSeed)) {
          throw new DomainError(409, `Duplicate seed ${row.seed} found in phase ${phaseId}. Each team must have a unique seed.`);
        }
        seedSet.add(absSeed);
      }
    }

    // Determine the next power of 2 size
    const powerOfTwoSize = Math.pow(2, Math.ceil(Math.log2(bracketSize || 8)));

    if (isDoubleElim) {
      const wbRounds: MatchData[][] = [];
      const totalWbRounds = Math.log2(powerOfTwoSize);

      let matchGlobalCount = 1;

      // 1. Generate Winners Bracket
      for (let r = 1; r <= totalWbRounds; r++) {
        const numMatchesInRound = powerOfTwoSize / Math.pow(2, r);
        const roundMatches: MatchData[] = [];

        for (let m = 1; m <= numMatchesInRound; m++) {
          roundMatches.push({
            id: crypto.randomUUID(),
            phase_id: phaseId,
            round_number: r,
            match_number: matchGlobalCount++,
            team1_id: null,
            team2_id: null,
            next_match_winner_id: null,
            next_match_loser_id: null,
            status: "PENDING"
          });
        }
        wbRounds.push(roundMatches);
      }

      // Link WB matches to next WB matches
      for (let r = 0; r < wbRounds.length - 1; r++) {
        const currentRound = wbRounds[r]!;
        const nextRound = wbRounds[r + 1]!;
        for (let i = 0; i < currentRound.length; i++) {
          const parentMatchIndex = Math.floor(i / 2);
          currentRound[i]!.next_match_winner_id = nextRound[parentMatchIndex]!.id;
        }
      }

      // 2. Generate Losers Bracket
      const lbRounds: Record<number, MatchData[]> = {};

      // LB Round 11 (WB R1 losers)
      const numMatchesInR11 = powerOfTwoSize / 4;
      const r11Matches: MatchData[] = [];
      for (let m = 1; m <= numMatchesInR11; m++) {
        r11Matches.push({
          id: crypto.randomUUID(),
          phase_id: phaseId,
          round_number: 11,
          match_number: matchGlobalCount++,
          team1_id: null,
          team2_id: null,
          next_match_winner_id: null,
          status: "PENDING"
        });
      }
      lbRounds[11] = r11Matches;

      // Link WB R1 losers to LB R11
      const wbR1 = wbRounds[0]!;
      for (let i = 0; i < wbR1.length; i++) {
        const targetLbMatchIndex = Math.floor(i / 2);
        wbR1[i]!.next_match_loser_id = r11Matches[targetLbMatchIndex]!.id;
      }

      // For rounds r = 2 to totalWbRounds:
      for (let r = 2; r <= totalWbRounds; r++) {
        const numMatchesInRound = powerOfTwoSize / Math.pow(2, r);

        // Major round: round_number = 10 + 2r - 2
        const majorRoundNum = 10 + 2 * r - 2;
        const majorMatches: MatchData[] = [];
        for (let m = 1; m <= numMatchesInRound; m++) {
          majorMatches.push({
            id: crypto.randomUUID(),
            phase_id: phaseId,
            round_number: majorRoundNum,
            match_number: matchGlobalCount++,
            team1_id: null,
            team2_id: null,
            next_match_winner_id: null,
            status: "PENDING"
          });
        }
        lbRounds[majorRoundNum] = majorMatches;

        // Link WB R[r] losers to LB Major Round
        const wbRound = wbRounds[r - 1]!;
        for (let i = 0; i < wbRound.length; i++) {
          wbRound[i]!.next_match_loser_id = majorMatches[i]!.id;
        }

        // Minor round: round_number = 10 + 2r - 3 (only for r > 2)
        if (r > 2) {
          const minorRoundNum = 10 + 2 * r - 3;
          const minorMatches: MatchData[] = [];
          for (let m = 1; m <= numMatchesInRound; m++) {
            minorMatches.push({
              id: crypto.randomUUID(),
              phase_id: phaseId,
              round_number: minorRoundNum,
              match_number: matchGlobalCount++,
              team1_id: null,
              team2_id: null,
              next_match_winner_id: null,
              status: "PENDING"
            });
          }
          lbRounds[minorRoundNum] = minorMatches;

          // Link previous Major Round to this Minor Round
          const prevMajorRoundNum = 10 + 2 * (r - 1) - 2;
          const prevMajorMatches = lbRounds[prevMajorRoundNum]!;
          for (let i = 0; i < prevMajorMatches.length; i++) {
            const targetMinorIndex = Math.floor(i / 2);
            prevMajorMatches[i]!.next_match_winner_id = minorMatches[targetMinorIndex]!.id;
          }

          // Link this Minor Round to current Major Round
          for (let i = 0; i < minorMatches.length; i++) {
            minorMatches[i]!.next_match_winner_id = majorMatches[i]!.id;
          }
        } else {
          // For r = 2: link LB R11 to LB R12
          const r11 = lbRounds[11]!;
          for (let i = 0; i < r11.length; i++) {
            r11[i]!.next_match_winner_id = majorMatches[i]!.id;
          }
        }
      }

      // 3. Generate Grand Final (Round 21)
      const gfRoundNum = 21;
      const gfMatch: MatchData = {
        id: crypto.randomUUID(),
        phase_id: phaseId,
        round_number: gfRoundNum,
        match_number: matchGlobalCount++,
        team1_id: null,
        team2_id: null,
        next_match_winner_id: null,
        status: "PENDING"
      };

      // Link Winners Final to Grand Final
      const wbFinal = wbRounds[totalWbRounds - 1]![0]!;
      wbFinal.next_match_winner_id = gfMatch.id;

      // Link Losers Final to Grand Final
      const lbFinalRoundNum = 10 + 2 * totalWbRounds - 2;
      const lbFinal = lbRounds[lbFinalRoundNum]![0]!;
      lbFinal.next_match_winner_id = gfMatch.id;

      // 4. Inject seeds into Winners Round 1 & Losers Round 1
      const foldedSeeds = this.getStandardSeeds(powerOfTwoSize);
      const round1Matches = wbRounds[0]!;

      for (let i = 0; i < round1Matches.length; i++) {
        const seed1 = foldedSeeds[i * 2] || 0;
        const seed2 = foldedSeeds[i * 2 + 1] || 0;

        const pt1 = seededTeams.find(t => t.seed === seed1 || t.seed === -seed1);
        const pt2 = seededTeams.find(t => t.seed === seed2 || t.seed === -seed2);

        const isPt1Losers = pt1 && pt1.seed < 0;
        const isPt2Losers = pt2 && pt2.seed < 0;

        round1Matches[i]!.team1_id = (pt1 && !isPt1Losers) ? pt1.team_id : null;
        round1Matches[i]!.team2_id = (pt2 && !isPt2Losers) ? pt2.team_id : null;

        // If pt1 starts in Losers: place in Losers Round 1 (Round 11)
        if (pt1 && isPt1Losers) {
          const targetLbMatchIndex = Math.floor(i / 2);
          const lbMatch = lbRounds[11]![targetLbMatchIndex]!;
          if (i % 2 === 0) {
            lbMatch.team1_id = pt1.team_id;
          } else {
            lbMatch.team2_id = pt1.team_id;
          }
        }

        // If pt2 starts in Losers: place in Losers Round 1 (Round 11)
        if (pt2 && isPt2Losers) {
          const targetLbMatchIndex = Math.floor(i / 2);
          const lbMatch = lbRounds[11]![targetLbMatchIndex]!;
          if (i % 2 === 0) {
            if (!lbMatch.team1_id) {
              lbMatch.team1_id = pt2.team_id;
            } else {
              lbMatch.team2_id = pt2.team_id;
            }
          } else {
            if (!lbMatch.team2_id) {
              lbMatch.team2_id = pt2.team_id;
            } else {
              lbMatch.team1_id = pt2.team_id;
            }
          }
        }
      }

      // 5. Gather all matches
      const allMatches: MatchData[] = [];
      wbRounds.forEach(round => allMatches.push(...round));
      Object.keys(lbRounds).forEach(roundNum => {
        allMatches.push(...lbRounds[Number(roundNum)]!);
      });
      allMatches.push(gfMatch);

      // 6. Cascade propagation of BYEs for Double Elimination
      let changed = true;
      while (changed) {
        changed = false;
        for (const match of allMatches) {
          if (match.status === "COMPLETED" || match.status === "BYE") {
            continue;
          }

          // Check if all matches feeding this match are completed
          const incomingMatches = allMatches.filter(
            m => m.next_match_winner_id === match.id || m.next_match_loser_id === match.id
          );
          const allIncomingCompleted = incomingMatches.every(
            m => m.status === "COMPLETED" || m.status === "BYE"
          );

          if (!allIncomingCompleted) {
            continue; // Skip, wait for parent matches to complete
          }

          const isTeam1Empty = !match.team1_id;
          const isTeam2Empty = !match.team2_id;

          if (isTeam1Empty && isTeam2Empty) {
            // Both slots empty — mark as COMPLETED (dead match)
            match.status = "COMPLETED";
            match.team1_score = 0;
            match.team2_score = 0;
            changed = true;
          } else if (isTeam1Empty || isTeam2Empty) {
            // One slot empty, one present — BYE (auto-advance)
            match.status = "COMPLETED";
            match.team1_score = isTeam1Empty ? 0 : 1;
            match.team2_score = isTeam2Empty ? 0 : 1;
            changed = true;

            const winnerId = isTeam1Empty ? match.team2_id : match.team1_id;

            // Propagate winner
            if (match.next_match_winner_id) {
              const nextWinnerMatch = allMatches.find(m => m.id === match.next_match_winner_id);
              if (nextWinnerMatch) {
                if (!nextWinnerMatch.team1_id) {
                  nextWinnerMatch.team1_id = winnerId;
                } else if (nextWinnerMatch.team1_id !== winnerId && !nextWinnerMatch.team2_id) {
                  nextWinnerMatch.team2_id = winnerId;
                }
              }
            }
          }
        }
      }

      // Check for existing matches to prevent duplicates
      const { data: existingMatches } = await supabase
        .from("matches")
        .select("id")
        .eq("phase_id", phaseId)
        .limit(1);

      if (existingMatches && existingMatches.length > 0) {
        throw new DomainError(409, `Matches already exist for phase ${phaseId}. Delete them before regenerating.`);
      }

      // Insert all matches
      const { error: insertError } = await supabase.from("matches").insert(allMatches);
      if (insertError) {
        console.error("Erreur Bulk Insert Matches: ", insertError);
        throw new Error("L'insertion de l'arbre a échoué.");
      }

      return allMatches;
    }

    // SINGLE ELIMINATION BRACKET
    const rounds: MatchData[][] = [];
    const totalRounds = Math.log2(powerOfTwoSize);

    let matchGlobalCount = 1;

    for (let r = 1; r <= totalRounds; r++) {
      const numMatchesInRound = powerOfTwoSize / Math.pow(2, r);
      const roundMatches: MatchData[] = [];

      for (let m = 1; m <= numMatchesInRound; m++) {
        roundMatches.push({
          id: crypto.randomUUID(),
          phase_id: phaseId,
          round_number: r,
          match_number: matchGlobalCount++,
          team1_id: null,
          team2_id: null,
          next_match_winner_id: null,
          status: "PENDING"
        });
      }
      rounds.push(roundMatches);
    }

    // Link matches: each match points to its parent (next round)
    for (let r = 0; r < rounds.length - 1; r++) {
      const currentRound = rounds[r]!;
      const nextRound = rounds[r + 1]!;

      for (let i = 0; i < currentRound.length; i++) {
        const parentMatchIndex = Math.floor(i / 2);
        currentRound[i]!.next_match_winner_id = nextRound[parentMatchIndex]!.id;
      }
    }

    // Inject seeds into Round 1
    const foldedSeeds = this.getStandardSeeds(powerOfTwoSize);
    const round1Matches = rounds[0]!;

    for (let i = 0; i < round1Matches.length; i++) {
      const seed1 = foldedSeeds[i * 2] || 0;
      const seed2 = foldedSeeds[i * 2 + 1] || 0;

      // Treat negative seeds also as Winners since there's no Losers Bracket
      const team1 = seededTeams.find(t => t.seed === seed1 || t.seed === -seed1)?.team_id || null;
      const team2 = seededTeams.find(t => t.seed === seed2 || t.seed === -seed2)?.team_id || null;

      round1Matches[i]!.team1_id = team1;
      round1Matches[i]!.team2_id = team2;
    }

    const allMatches = rounds.flat();

    // Auto-resolve BYEs across ALL matches (cascade propagation)
    let changed = true;
    while (changed) {
      changed = false;
      for (const match of allMatches) {
        if (match.status === "COMPLETED" || match.status === "BYE") {
          continue;
        }

        // Check if all matches feeding this match are completed
        const incomingMatches = allMatches.filter(
          m => m.next_match_winner_id === match.id
        );
        const allIncomingCompleted = incomingMatches.every(
          m => m.status === "COMPLETED" || m.status === "BYE"
        );

        if (!allIncomingCompleted) {
          continue; // Wait for parent matches to complete
        }

        const isTeam1Empty = !match.team1_id;
        const isTeam2Empty = !match.team2_id;

        if (isTeam1Empty && isTeam2Empty) {
          // Both empty — mark as COMPLETED (dead match)
          match.status = "COMPLETED";
          match.team1_score = 0;
          match.team2_score = 0;
          changed = true;
        } else if (isTeam1Empty || isTeam2Empty) {
          // BYE: one team present auto-advances
          match.status = "COMPLETED";
          match.team1_score = isTeam1Empty ? 0 : 1;
          match.team2_score = isTeam2Empty ? 0 : 1;
          changed = true;

          const winnerId = isTeam1Empty ? match.team2_id : match.team1_id;

          // Propagate to parent match
          if (match.next_match_winner_id) {
            const nextWinnerMatch = allMatches.find(m => m.id === match.next_match_winner_id);
            if (nextWinnerMatch) {
              if (!nextWinnerMatch.team1_id) {
                nextWinnerMatch.team1_id = winnerId;
              } else if (nextWinnerMatch.team1_id !== winnerId && !nextWinnerMatch.team2_id) {
                nextWinnerMatch.team2_id = winnerId;
              }
            }
          }
        }
      }
    }

    // Check for existing matches to prevent duplicates
    const { data: existingMatches } = await supabase
      .from("matches")
      .select("id")
      .eq("phase_id", phaseId)
      .limit(1);

    if (existingMatches && existingMatches.length > 0) {
      throw new DomainError(409, `Matches already exist for phase ${phaseId}. Delete them before regenerating.`);
    }

    const flattenMatches = rounds.flat();
    const { error: insertError } = await supabase
      .from("matches")
      .insert(flattenMatches);

    if (insertError) {
      console.error("Erreur Bulk Insert Matches: ", insertError);
      throw new Error("L'insertion de l'arbre a échoué.");
    }

    return flattenMatches;
  }
}
