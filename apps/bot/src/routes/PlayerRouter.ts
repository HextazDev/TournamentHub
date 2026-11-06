import { createHash, randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { canPerform, MAX_FAKE_TEAMS, WebRegisterTeamSchema, WebReportScoreSchema } from "@hub/shared";
import { supabase } from "../lib/supabase";
import { sendServerError } from "../utils/serverError";
import { IntegrationBus } from "../services/IntegrationBus";
import { LeaderboardService } from "../services/LeaderboardService";
import { ScoreService } from "../services/ScoreService";
import { resolveMemberAccess, type DiscordClientLike } from "../services/MemberAccessService";
import { isCheckinWindowOpen } from "../utils/manualTeamCheckin";
import { resolveActiveDiscordGuild } from "../utils/tenant";

const UNIQUE_VIOLATION = "23505";

export const playerRouter = Router();

/**
 * Identité de l'appelant. CLN-05 : la confiance en `x-discord-user-id` ne tient QUE parce que
 * `authMiddleware` exige le Bearer BOT_API_SECRET sur tout `/api` et que ce header est injecté
 * côté serveur par le proxy Next.js — jamais par le client. Ne jamais monter ces routes sans ce middleware.
 */
function getCallerId(req: Request): string | null {
  const fromHeader = req.headers["x-discord-user-id"];
  if (typeof fromHeader === "string" && fromHeader.length > 0) return fromHeader;
  return req.adminCheck?.discordId ?? null;
}

type MatchRecord = Record<string, unknown>;

const FALLBACK_DISCORD_CLIENT: DiscordClientLike = {
  guilds: {
    fetch: () => Promise.reject(new Error("Unknown Guild")),
  },
};

/** Membre ou staff de l'organisation, porteur du lien de partage, ou membre du serveur Discord tant que l'intégration est active. */
async function canJoinPrivateTournament(
  req: Request,
  tournament: Record<string, unknown>,
  tournamentId: string,
  callerId: string,
  inviteToken: string | undefined,
): Promise<boolean> {
  const organizationId = typeof tournament.organization_id === "string" ? tournament.organization_id : null;
  if (!organizationId) return false;

  const [memberRes, staffRes] = await Promise.all([
    supabase.from("organization_members").select("role").eq("organization_id", organizationId).eq("user_id", callerId).maybeSingle(),
    supabase.from("tournament_staff").select("role").eq("tournament_id", tournamentId).eq("user_id", callerId).maybeSingle(),
  ]);
  if (memberRes.error) throw memberRes.error;
  if (staffRes.error) throw staffRes.error;
  if (memberRes.data || staffRes.data) return true;

  if (inviteToken) {
    const { data, error } = await supabase
      .from("tournament_invite_tokens")
      .select("tournament_id")
      .eq("tournament_id", tournamentId)
      .eq("token_hash", createHash("sha256").update(inviteToken).digest("hex"))
      .maybeSingle();
    if (error) throw error;
    if (data) return true;
  }

  const guildId = await resolveActiveDiscordGuild(organizationId);
  const client = req.app?.locals?.discordClient as DiscordClientLike | undefined;
  if (!guildId || !client) return false;
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  return Boolean(guild && (await guild.members.fetch(callerId).catch(() => null)));
}

/** Effets communs d'un match terminé : classement de poule puis progression, depuis le score retenu. */
async function completeMatch(
  req: Request,
  organizationId: string | null | undefined,
  match: MatchRecord,
  team1Score: number,
  team2Score: number,
): Promise<void> {
  const team1 = typeof match.team1_id === "string" ? match.team1_id : null;
  const team2 = typeof match.team2_id === "string" ? match.team2_id : null;
  const team1Won = team1Score > team2Score;
  const isDraw = team1Score === team2Score;

  if (typeof match.group_id === "string") {
    await LeaderboardService.calculateGroupStandings(match.group_id);
  }
  await ScoreService.progressTeams(
    match,
    undefined,
    isDraw ? null : team1Won ? team1 : team2,
    isDraw ? null : team1Won ? team2 : team1,
    // SEC-26 : la progression reste 100 % en base quand l'intégration Discord est coupée.
    (await resolveActiveDiscordGuild(organizationId)) ? req.app?.locals?.discordClient : undefined,
  );
}

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
      return res.status(400).json({ error: "Les inscriptions ne sont pas ouvertes pour ce tournoi.", code: "REGISTRATION_CLOSED" });
    }

    // SEC-10 : mêmes droits que la lecture d'un tournoi privé, sans dépendre de Discord.
    if (tRow.is_public === false && !(await canJoinPrivateTournament(req, tRow, tournamentId, callerId, parsed.data.invite_token))) {
      return res.status(403).json({
        error: "Ce tournoi est privé : un lien de partage ou l'appartenance à l'organisation est requis.",
        code: "PRIVATE_TOURNAMENT",
      });
    }

    // PERF-02 / DAT-01: contrôles par count() ciblés, sans charger toutes les équipes du tournoi.
    const { count: teamCount } = await supabase
      .from("teams")
      .select("id", { count: "exact", head: true })
      .eq("tournament_id", tournamentId);
    if ((teamCount ?? 0) >= MAX_FAKE_TEAMS) {
      return res.status(400).json({ error: "La capacité maximale d'équipes pour ce tournoi est atteinte.", code: "TOURNAMENT_FULL" });
    }

    const escapedName = parsed.data.name.replace(/[\\%_]/g, (c) => `\\${c}`);
    const [captainCountRes, nameCountRes] = await Promise.all([
      supabase.from("teams").select("id", { count: "exact", head: true })
        .eq("tournament_id", tournamentId).eq("captain_discord_id", callerId),
      supabase.from("teams").select("id", { count: "exact", head: true })
        .eq("tournament_id", tournamentId).ilike("name", escapedName),
    ]);
    if ((captainCountRes.count ?? 0) > 0 || (nameCountRes.count ?? 0) > 0) {
      return res.status(409).json({
        error: "Vous êtes déjà inscrit comme capitaine ou ce nom d'équipe est déjà pris.",
        code: "ALREADY_REGISTERED",
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
        code: "ALREADY_REGISTERED",
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

    // DAT-01: Si l'insertion des membres échoue, rollback immédiat de l'équipe pour éviter les orphelins
    const { error: membersErr } = await supabase.from("team_members").insert(memberRows);
    if (membersErr) {
      await supabase.from("teams").delete().eq("id", teamId);
      throw membersErr;
    }

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
      return res.status(400).json({ error: "Impossible de se désinscrire une fois le tournoi lancé.", code: "TOURNAMENT_STARTED" });
    }

    const { data: team } = await supabase
      .from("teams")
      .select("id")
      .eq("tournament_id", tournamentId)
      .eq("captain_discord_id", callerId)
      .maybeSingle();
    const teamRow = team as { id?: string } | null;
    if (!teamRow?.id) {
      return res.status(404).json({ error: "Aucune équipe inscrite trouvée pour ce capitaine.", code: "TEAM_NOT_FOUND" });
    }

    const { error: memErr } = await supabase.from("team_members").delete().eq("team_id", teamRow.id);
    if (memErr) throw memErr;
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

    // ARC-01: Validation stricte de la fenêtre de check-in (parité Web & Discord)
    const windowCheck = isCheckinWindowOpen({
      status: typeof tRow.status === "string" ? tRow.status : "",
      checkin_mode: tRow.checkin_mode === "ENABLED" || tRow.checkin_mode === "DISABLED" ? tRow.checkin_mode : null,
      checkin_start_at: typeof tRow.checkin_start_at === "string" ? tRow.checkin_start_at : null,
      checkin_end_at: typeof tRow.checkin_end_at === "string" ? tRow.checkin_end_at : null,
    });

    if (!windowCheck.open) {
      if (windowCheck.reason === "DISABLED") {
        return res.status(400).json({ error: "Le check-in est désactivé pour ce tournoi.", code: "CHECKIN_DISABLED" });
      }
      if (windowCheck.reason === "NOT_STARTED") {
        return res.status(400).json({ error: "La fenêtre de check-in n'est pas encore ouverte.", code: "CHECKIN_NOT_STARTED" });
      }
      if (windowCheck.reason === "ENDED") {
        return res.status(400).json({ error: "La fenêtre de check-in est terminée.", code: "CHECKIN_ENDED" });
      }
      return res.status(400).json({ error: "Le check-in n'est pas ouvert pour ce tournoi.", code: "CHECKIN_NOT_OPEN" });
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
        code: "NOT_CAPTAIN",
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
      return res.status(400).json({ error: "Ce match est déjà terminé.", code: "MATCH_FINISHED" });
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

    // SEC-02: Contrôle obligatoire que le tournoi est ACTIVE
    const { data: tourney, error: tourneyErr } = await supabase
      .from("tournaments")
      .select("status, organization_id, guild_id")
      .eq("id", phase.tournament_id)
      .maybeSingle();
    if (tourneyErr) throw tourneyErr;
    const tObj = tourney as { status?: string; organization_id?: string | null; guild_id?: string | null } | null;
    if (!tObj || tObj.status !== "ACTIVE") {
      return res.status(400).json({ error: "Le tournoi n'est pas actif.", code: "TOURNAMENT_NOT_ACTIVE" });
    }

    // SEC-30 : vérifier que l'appelant est capitaine de team1 ou team2, ou staff autorisé (SCORE_MATCH)
    const teamIds = [match.team1_id, match.team2_id].filter((id): id is string => typeof id === "string");
    const { data: teamsData } =
      teamIds.length > 0
        ? await supabase.from("teams").select("id, captain_discord_id").in("id", teamIds)
        : { data: [] };
    const matchTeams = (teamsData ?? []) as { id: string; captain_discord_id: string }[];
    const callerTeam = matchTeams.find((t) => t.captain_discord_id === callerId);

    let isStaff = false;
    const tenantKey = tObj.organization_id ?? tObj.guild_id;
    if (tenantKey) {
      const client = (req.app?.locals?.discordClient as DiscordClientLike | undefined) ?? FALLBACK_DISCORD_CLIENT;
      const decision = await resolveMemberAccess(client, tenantKey, callerId);
      if (decision.allowed && canPerform(decision.access, "SCORE_MATCH", phase.tournament_id)) {
        isStaff = true;
      }
    }

    if (!callerTeam && !isStaff) {
      return res.status(403).json({
        error: "Seul un capitaine participant au match ou un membre du staff peut déclarer le score.",
        code: "NOT_MATCH_PARTICIPANT",
      });
    }

    // SEC-31 : un score ne se saisit que sur une affiche complète (ni TBD, ni BYE).
    if (typeof match.team1_id !== "string" || typeof match.team2_id !== "string") {
      return res.status(400).json({ error: "Ce match n'a pas encore ses deux équipes.", code: "MATCH_NOT_READY" });
    }

    const { team1_score, team2_score } = parsed.data;
    if (
      team1_score === team2_score &&
      (phase.format === "SINGLE_ELIM" || phase.format === "DOUBLE_ELIM")
    ) {
      return res.status(400).json({ error: "Une égalité n'est pas autorisée en phase à élimination.", code: "DRAW_NOT_ALLOWED" });
    }

    // 1. Staff arbitre (SCORE_MATCH) : validation directe, y compris pour résoudre une contestation (SEC-31)
    if (isStaff && !callerTeam) {
      const { data: updated, error: updateErr } = await supabase
        .from("matches")
        .update({
          team1_score,
          team2_score,
          status: "COMPLETED",
          reported_by_team_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", matchId)
        .in("status", ["PENDING", "IN_PROGRESS", "WAITING_VALIDATION", "CONTESTED"])
        .select();

      if (updateErr) throw updateErr;
      if (!updated || updated.length === 0) {
        return res.status(400).json({ error: "Ce match est déjà terminé.", code: "MATCH_FINISHED" });
      }

      await completeMatch(req, tObj.organization_id, { ...match, team1_score, team2_score, status: "COMPLETED" }, team1_score, team2_score);
      return res.status(200).json({ message: "Score validé par le staff", match: updated[0] });
    }

    if (!callerTeam) {
      return res.status(403).json({ error: "Accès refusé", code: "NO_RIGHTS" });
    }

    // 2. Capitaine déclarant : passage en WAITING_VALIDATION atomique si PENDING / IN_PROGRESS
    if (match.status === "PENDING" || match.status === "IN_PROGRESS") {
      const { data: updated, error: updateErr } = await supabase
        .from("matches")
        .update({
          team1_score,
          team2_score,
          status: "WAITING_VALIDATION",
          reported_by_team_id: callerTeam.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", matchId)
        .in("status", ["PENDING", "IN_PROGRESS"])
        .select();

      if (updateErr) throw updateErr;
      if (!updated || updated.length === 0) {
        return res.status(400).json({ error: "Ce match est déjà en cours de validation ou terminé.", code: "MATCH_ALREADY_REPORTED" });
      }

      return res.status(200).json({
        message: "Score soumis, en attente de validation par le capitaine adverse.",
        match: updated[0],
      });
    }

    // 3. Match déjà en WAITING_VALIDATION
    if (match.status === "WAITING_VALIDATION") {
      // Interdiction de s'auto-valider son propre score
      if (callerTeam.id === match.reported_by_team_id) {
        return res.status(400).json({
          error: "En attente de confirmation par le capitaine adverse.",
          code: "AWAITING_OPPONENT",
        });
      }

      // SCR-11 : le capitaine adverse valide le score enregistré ; tout autre score relève de la contestation.
      if (match.team1_score !== team1_score || match.team2_score !== team2_score) {
        return res.status(409).json({
          error: "Ce score diffère de celui déclaré par l'adversaire : validez-le tel quel ou contestez-le.",
          code: "SCORE_MISMATCH",
        });
      }

      // Transition atomique WAITING_VALIDATION ➜ COMPLETED (SCR-05)
      const { data: updated, error: updateErr } = await supabase
        .from("matches")
        .update({
          status: "COMPLETED",
          updated_at: new Date().toISOString(),
        })
        .eq("id", matchId)
        .eq("status", "WAITING_VALIDATION")
        .select();

      if (updateErr) throw updateErr;
      if (!updated || updated.length === 0) {
        return res.status(400).json({ error: "Ce match est déjà terminé.", code: "MATCH_FINISHED" });
      }

      const completedMatch = { ...match, status: "COMPLETED" };
      await completeMatch(req, tObj.organization_id, completedMatch, team1_score, team2_score);
      return res.status(200).json({ message: "Score validé avec succès", match: completedMatch });
    }

    // 4. Match contesté : seul le staff peut encore trancher (branche 1).
    if (match.status === "CONTESTED") {
      return res.status(409).json({ error: "Ce match est contesté : un organisateur doit trancher.", code: "MATCH_CONTESTED" });
    }

    return res.status(400).json({ error: "Ce match est déjà terminé.", code: "MATCH_FINISHED" });
  } catch (error: unknown) {
    return sendServerError(res, error, "PlayerRouter.reportScore");
  }
});

// POST /api/player/matches/:matchId/contest-score — Le capitaine adverse conteste le score déclaré (SCR-12)
playerRouter.post("/matches/:matchId/contest-score", async (req, res) => {
  try {
    const callerId = getCallerId(req);
    if (!callerId) {
      return res.status(401).json({ error: "User identity required", code: "NOT_LOGGED_IN" });
    }

    const { matchId } = req.params;
    const { data: matchData, error: matchErr } = await supabase
      .from("matches")
      .select("id, status, team1_id, team2_id, reported_by_team_id")
      .eq("id", matchId)
      .maybeSingle();
    if (matchErr) throw matchErr;
    const match = matchData as {
      status: string;
      team1_id: string | null;
      team2_id: string | null;
      reported_by_team_id: string | null;
    } | null;
    if (!match) return res.status(404).json({ error: "Match not found" });

    const opponentTeamId = match.team1_id === match.reported_by_team_id ? match.team2_id : match.team1_id;
    const { data: opponent, error: opponentErr } = opponentTeamId
      ? await supabase.from("teams").select("captain_discord_id").eq("id", opponentTeamId).maybeSingle()
      : { data: null, error: null };
    if (opponentErr) throw opponentErr;
    if ((opponent as { captain_discord_id?: string } | null)?.captain_discord_id !== callerId) {
      return res.status(403).json({ error: "Seul le capitaine adverse peut contester ce score.", code: "NOT_OPPONENT" });
    }

    const { data: updated, error: updateErr } = await supabase
      .from("matches")
      .update({ status: "CONTESTED", updated_at: new Date().toISOString() })
      .eq("id", matchId)
      .eq("status", "WAITING_VALIDATION")
      .select();
    if (updateErr) throw updateErr;
    if (!updated || updated.length === 0) {
      return res.status(400).json({ error: "Aucun score en attente de validation sur ce match.", code: "NOT_WAITING_VALIDATION" });
    }

    return res.status(200).json({ message: "Score contesté : un organisateur va trancher.", match: updated[0] });
  } catch (error: unknown) {
    return sendServerError(res, error, "PlayerRouter.contestScore");
  }
});
