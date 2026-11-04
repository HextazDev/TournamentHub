import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { canPerform, WebRegisterTeamSchema, WebReportScoreSchema } from "@hub/shared";
import { supabase } from "../lib/supabase";
import { sendServerError } from "../utils/serverError";
import { IntegrationBus } from "../services/IntegrationBus";
import { LeaderboardService } from "../services/LeaderboardService";
import { ScoreService } from "../services/ScoreService";
import { resolveMemberAccess, type DiscordClientLike } from "../services/MemberAccessService";

const UNIQUE_VIOLATION = "23505";

export const playerRouter = Router();

function getCallerId(req: Request): string | null {
  const fromHeader = req.headers["x-discord-user-id"];
  if (typeof fromHeader === "string" && fromHeader.length > 0) return fromHeader;
  return req.adminCheck?.discordId ?? null;
}

const FALLBACK_DISCORD_CLIENT: DiscordClientLike = {
  guilds: {
    fetch: () => Promise.reject(new Error("Unknown Guild")),
  },
};

// POST /api/player/tournaments/:tournamentId/register — Inscription autonome d'une équipe sur le Web (INT-02)
playerRouter.post("/tournaments/:tournamentId/register", async (req, res) => {
  try {
    const callerId = getCallerId(req);
    if (!callerId) {
      return res.status(401).json({ error: "User identity required", code: "NOT_LOGGED_IN" });
    }

    const parsed = WebRegisterTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
    }

    const { tournamentId } = req.params;
    const { data: tournament, error: tourneyErr } = await supabase
      .from("tournaments")
      .select("*")
      .eq("id", tournamentId)
      .maybeSingle();

    if (tourneyErr) throw tourneyErr;
    const tRow = tournament as Record<string, unknown> | null;
    if (!tRow) {
      return res.status(404).json({ error: "Tournament not found" });
    }

    if (
      !tRow.is_registration_open ||
      (tRow.status !== "DRAFT" && tRow.status !== "REGISTRATION")
    ) {
      return res.status(400).json({ error: "Les inscriptions ne sont pas ouvertes pour ce tournoi." });
    }

    const { data: existingTeams } = await supabase
      .from("teams")
      .select("id, name, captain_discord_id")
      .eq("tournament_id", tournamentId);
    const list = (existingTeams ?? []) as { id: string; name: string; captain_discord_id: string }[];
    if (
      list.some(
        (t) =>
          t.captain_discord_id === callerId ||
          t.name.toLowerCase() === parsed.data.name.toLowerCase(),
      )
    ) {
      return res.status(409).json({
        error: "Vous êtes déjà inscrit comme capitaine ou ce nom d'équipe est déjà pris.",
      });
    }

    const teamId = randomUUID();
    const now = new Date().toISOString();
    const isCheckedIn = tRow.checkin_mode === "DISABLED";

    const newTeam = {
      id: teamId,
      tournament_id: tournamentId,
      name: parsed.data.name,
      captain_discord_id: callerId,
      is_checked_in: isCheckedIn,
      created_at: now,
      updated_at: now,
    };

    const { error: insertTeamErr } = await supabase.from("teams").insert(newTeam);
    if (insertTeamErr?.code === UNIQUE_VIOLATION) {
      return res.status(409).json({
        error: "Vous êtes déjà inscrit comme capitaine ou ce nom d'équipe est déjà pris.",
      });
    }
    if (insertTeamErr) throw insertTeamErr;

    const memberRows = [
      {
        id: randomUUID(),
        team_id: teamId,
        user_id: callerId,
        ingame_name: parsed.data.captain_ingame_name,
        friend_code: parsed.data.captain_friend_code,
        is_captain: true,
        created_at: now,
      },
      ...parsed.data.members.map((m) => ({
        id: randomUUID(),
        team_id: teamId,
        user_id: null,
        ingame_name: m.ingame_name,
        friend_code: m.friend_code,
        is_captain: false,
        created_at: now,
      })),
    ];

    const { error: membersErr } = await supabase.from("team_members").insert(memberRows);
    if (membersErr) throw membersErr;

    if (typeof tRow.organization_id === "string") {
      await IntegrationBus.emit("onTeamRegistered", {
        organizationId: tRow.organization_id,
        tournamentId,
        teamId,
        discordClient: req.app?.locals?.discordClient,
      });
    }

    return res.status(201).json({ ...newTeam, team_members: memberRows });
  } catch (error: unknown) {
    return sendServerError(res, error, "PlayerRouter.registerTeam");
  }
});

// DELETE /api/player/tournaments/:tournamentId/register — Désinscription par le capitaine (INT-02)
playerRouter.delete("/tournaments/:tournamentId/register", async (req, res) => {
  try {
    const callerId = getCallerId(req);
    if (!callerId) {
      return res.status(401).json({ error: "User identity required", code: "NOT_LOGGED_IN" });
    }

    const { tournamentId } = req.params;
    const { data: tournament, error: tourneyErr } = await supabase
      .from("tournaments")
      .select("status")
      .eq("id", tournamentId)
      .maybeSingle();
    if (tourneyErr) throw tourneyErr;
    const tRow = tournament as { status?: string } | null;
    if (!tRow) return res.status(404).json({ error: "Tournament not found" });

    if (tRow.status !== "DRAFT" && tRow.status !== "REGISTRATION") {
      return res.status(400).json({ error: "Impossible de se désinscrire une fois le tournoi lancé." });
    }

    const { data: team } = await supabase
      .from("teams")
      .select("id")
      .eq("tournament_id", tournamentId)
      .eq("captain_discord_id", callerId)
      .maybeSingle();
    const teamRow = team as { id?: string } | null;
    if (!teamRow?.id) {
      return res.status(404).json({ error: "Aucune équipe inscrite trouvée pour ce capitaine." });
    }

    await supabase.from("team_members").delete().eq("team_id", teamRow.id);
    const { error: delErr } = await supabase.from("teams").delete().eq("id", teamRow.id);
    if (delErr) throw delErr;

    return res.status(200).json({ success: true });
  } catch (error: unknown) {
    return sendServerError(res, error, "PlayerRouter.unregisterTeam");
  }
});

// POST /api/player/tournaments/:tournamentId/checkin — Check-in autonome par le capitaine sur le Web (SEC-30 / INT-02)
playerRouter.post("/tournaments/:tournamentId/checkin", async (req, res) => {
  try {
    const callerId = getCallerId(req);
    if (!callerId) {
      return res.status(401).json({ error: "User identity required", code: "NOT_LOGGED_IN" });
    }

    const { tournamentId } = req.params;
    const { data: tournament, error: tourneyErr } = await supabase
      .from("tournaments")
      .select("*")
      .eq("id", tournamentId)
      .maybeSingle();
    if (tourneyErr) throw tourneyErr;
    const tRow = tournament as Record<string, unknown> | null;
    if (!tRow) return res.status(404).json({ error: "Tournament not found" });

    if (tRow.status !== "REGISTRATION") {
      return res.status(400).json({ error: "Le check-in n'est pas ouvert pour ce tournoi." });
    }

    // SEC-30 : seul le capitaine inscrit pour ce tournoi peut valider son check-in
    const { data: team, error: teamErr } = await supabase
      .from("teams")
      .select("*")
      .eq("tournament_id", tournamentId)
      .eq("captain_discord_id", callerId)
      .maybeSingle();
    if (teamErr) throw teamErr;
    const teamRow = team as Record<string, unknown> | null;
    if (!teamRow || typeof teamRow.id !== "string") {
      return res.status(403).json({
        error: "Seul le capitaine d'une équipe inscrite peut effectuer le check-in.",
        code: "NO_RIGHTS",
      });
    }

    const { error: updateErr } = await supabase
      .from("teams")
      .update({ is_checked_in: true, updated_at: new Date().toISOString() })
      .eq("id", teamRow.id);
    if (updateErr) throw updateErr;

    if (typeof tRow.organization_id === "string") {
      await IntegrationBus.emit("onCheckinCompleted", {
        organizationId: tRow.organization_id,
        tournamentId,
        teamId: teamRow.id,
        discordClient: req.app?.locals?.discordClient,
      });
    }

    return res.status(200).json({ ...teamRow, is_checked_in: true });
  } catch (error: unknown) {
    return sendServerError(res, error, "PlayerRouter.checkin");
  }
});

// POST /api/player/matches/:matchId/report-score — Saisie de score Web par un capitaine ou un arbitre (SEC-30 / INT-02)
playerRouter.post("/matches/:matchId/report-score", async (req, res) => {
  try {
    const callerId = getCallerId(req);
    if (!callerId) {
      return res.status(401).json({ error: "User identity required", code: "NOT_LOGGED_IN" });
    }

    const parsed = WebReportScoreSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
    }

    const { matchId } = req.params;
    const { data: matchData, error: matchErr } = await supabase
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (matchErr) throw matchErr;
    const match = matchData as Record<string, unknown> | null;
    if (!match || typeof match.phase_id !== "string") {
      return res.status(404).json({ error: "Match not found" });
    }

    if (match.status === "COMPLETED" || match.status === "FF" || match.status === "BYE") {
      return res.status(400).json({ error: "Ce match est déjà terminé." });
    }

    const { data: phaseData, error: phaseErr } = await supabase
      .from("phases")
      .select("tournament_id, format")
      .eq("id", match.phase_id)
      .maybeSingle();
    if (phaseErr) throw phaseErr;
    const phase = phaseData as { tournament_id?: string; format?: string } | null;
    if (!phase?.tournament_id) {
      return res.status(404).json({ error: "Phase not found" });
    }

    // SEC-30 : vérifier que l'appelant est capitaine de team1 ou team2, ou staff autorisé (SCORE_MATCH)
    const teamIds = [match.team1_id, match.team2_id].filter((id): id is string => typeof id === "string");
    const { data: teamsData } =
      teamIds.length > 0
        ? await supabase.from("teams").select("id, captain_discord_id").in("id", teamIds)
        : { data: [] };
    const matchTeams = (teamsData ?? []) as { id: string; captain_discord_id: string }[];
    const callerTeam = matchTeams.find((t) => t.captain_discord_id === callerId);

    let authorized = Boolean(callerTeam);
    if (!authorized) {
      const { data: tourney } = await supabase
        .from("tournaments")
        .select("organization_id, guild_id")
        .eq("id", phase.tournament_id)
        .maybeSingle();
      const tObj = tourney as { organization_id?: string | null; guild_id?: string | null } | null;
      const tenantKey = tObj?.organization_id ?? tObj?.guild_id;
      if (tenantKey) {
        const client = (req.app?.locals?.discordClient as DiscordClientLike | undefined) ?? FALLBACK_DISCORD_CLIENT;
        const decision = await resolveMemberAccess(client, tenantKey, callerId);
        if (decision.allowed && canPerform(decision.access, "SCORE_MATCH", phase.tournament_id)) {
          authorized = true;
        }
      }
    }

    if (!authorized) {
      return res.status(403).json({
        error: "Seul un capitaine participant au match ou un membre du staff peut déclarer le score.",
        code: "NO_RIGHTS",
      });
    }

    const { team1_score, team2_score } = parsed.data;
    if (
      team1_score === team2_score &&
      (phase.format === "SINGLE_ELIM" || phase.format === "DOUBLE_ELIM")
    ) {
      return res.status(400).json({ error: "Une égalité n'est pas autorisée en phase à élimination." });
    }

    const { error: updateErr } = await supabase
      .from("matches")
      .update({
        team1_score,
        team2_score,
        status: "COMPLETED",
        reported_by_team_id: callerTeam?.id ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", matchId);
    if (updateErr) throw updateErr;

    const updatedMatch = {
      ...match,
      team1_score,
      team2_score,
      status: "COMPLETED",
    };

    let winnerId: string | null = null;
    let loserId: string | null = null;
    if (team1_score > team2_score) {
      winnerId = typeof match.team1_id === "string" ? match.team1_id : null;
      loserId = typeof match.team2_id === "string" ? match.team2_id : null;
    } else if (team2_score > team1_score) {
      winnerId = typeof match.team2_id === "string" ? match.team2_id : null;
      loserId = typeof match.team1_id === "string" ? match.team1_id : null;
    }

    if (typeof match.group_id === "string") {
      await LeaderboardService.calculateGroupStandings(match.group_id);
    }

    await ScoreService.progressTeams(
      updatedMatch,
      undefined,
      winnerId,
      loserId,
      req.app?.locals?.discordClient,
    );

    return res.status(200).json({ message: "Score enregistré", match: updatedMatch });
  } catch (error: unknown) {
    return sendServerError(res, error, "PlayerRouter.reportScore");
  }
});
