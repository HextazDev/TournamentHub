"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Clock, Loader2, Shield, Trophy, UserMinus, UserPlus, XCircle } from "lucide-react";
import { botApiFetch } from "@/utils/api";
import { useTranslation } from "@/i18n/LanguageContext";
import { useToast } from "@/context/ToastContext";
import { getErrorMessage, readApiError } from "@/utils/errors";

export interface CaptainTeamInfo {
  id: string;
  name: string;
  is_checked_in: boolean;
}

export interface CaptainMatch {
  id: string;
  /** TO_REPORT : à déclarer ; TO_VALIDATE : score adverse à valider ou contester ; WAITING_OPPONENT ; CONTESTED : arbitrage. */
  state: "TO_REPORT" | "TO_VALIDATE" | "WAITING_OPPONENT" | "CONTESTED";
  team1_name: string;
  team2_name: string;
  team1_score: number;
  team2_score: number;
}

export function WebPlayerActions({
  tournamentId,
  status,
  isRegistrationOpen,
  canCheckinNow,
  viewerDiscordId,
  inviteToken,
  captainTeam,
  captainMatch,
}: {
  tournamentId: string;
  status: string;
  isRegistrationOpen: boolean;
  canCheckinNow: boolean;
  viewerDiscordId: string | null;
  /** Lien de partage d'un tournoi privé : revalidé par le bot à l'inscription. */
  inviteToken: string | null;
  captainTeam: CaptainTeamInfo | null;
  captainMatch: CaptainMatch | null;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const router = useRouter();

  const [teamName, setTeamName] = useState("");
  const [captainIngameName, setCaptainIngameName] = useState("");
  const [captainFriendCode, setCaptainFriendCode] = useState("");
  const [team1Score, setTeam1Score] = useState(0);
  const [team2Score, setTeam2Score] = useState(0);
  const [loading, setLoading] = useState(false);

  if (!viewerDiscordId) return null;

  const showRegistrationBlock = (status === "DRAFT" || status === "REGISTRATION") && (isRegistrationOpen || captainTeam !== null);
  const showScoreBlock = status === "ACTIVE" && captainMatch !== null;

  if (!showRegistrationBlock && !showScoreBlock) return null;

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!teamName.trim() || !captainIngameName.trim() || !captainFriendCode.trim()) return;
    setLoading(true);
    try {
      const res = await botApiFetch(`/api/player/tournaments/${tournamentId}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: teamName.trim(),
          captain_ingame_name: captainIngameName.trim(),
          captain_friend_code: captainFriendCode.trim(),
          members: [],
        }),
      });
      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("common.unknown"));
      }
      toast.success(t("playerActions.registeredSuccess"));
      setTeamName("");
      setCaptainIngameName("");
      setCaptainFriendCode("");
      router.refresh();
    } catch (err: unknown) {
      toast.error(t("feedback.genericError", { message: getErrorMessage(err) ?? t("common.unknown") }));
    } finally {
      setLoading(false);
    }
  };

  const handleUnregister = async () => {
    setLoading(true);
    try {
      const res = await botApiFetch(`/api/player/tournaments/${tournamentId}/register`, {
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("common.unknown"));
      }
      toast.success(t("playerActions.unregisteredSuccess"));
      router.refresh();
    } catch (err: unknown) {
      toast.error(t("feedback.genericError", { message: getErrorMessage(err) ?? t("common.unknown") }));
    } finally {
      setLoading(false);
    }
  };

  const handleCheckin = async () => {
    setLoading(true);
    try {
      const res = await botApiFetch(`/api/player/tournaments/${tournamentId}/checkin`, {
        method: "POST",
      });
      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("common.unknown"));
      }
      toast.success(t("playerActions.checkedInSuccess"));
      router.refresh();
    } catch (err: unknown) {
      toast.error(t("feedback.genericError", { message: getErrorMessage(err) ?? t("common.unknown") }));
    } finally {
      setLoading(false);
    }
  };

  const submitScore = async (matchId: string, team1: number, team2: number, successMessage: string) => {
    setLoading(true);
    try {
      const res = await botApiFetch(`/api/player/matches/${matchId}/report-score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ team1_score: team1, team2_score: team2 }),
      });
      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("common.unknown"));
      }
      toast.success(successMessage);
      router.refresh();
    } catch (err: unknown) {
      toast.error(t("feedback.genericError", { message: getErrorMessage(err) ?? t("common.unknown") }));
    } finally {
      setLoading(false);
    }
  };

  const handleReportScore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!captainMatch) return;
    await submitScore(captainMatch.id, team1Score, team2Score, t("playerActions.scoreReportedSuccess"));
  };

  const handleContest = async () => {
    if (!captainMatch) return;
    setLoading(true);
    try {
      const res = await botApiFetch(`/api/player/matches/${captainMatch.id}/contest-score`, { method: "POST" });
      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("common.unknown"));
      }
      toast.success(t("playerActions.scoreContestedSuccess"));
      router.refresh();
    } catch (err: unknown) {
      toast.error(t("feedback.genericError", { message: getErrorMessage(err) ?? t("common.unknown") }));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-[#151722] border border-slate-800/70 rounded-xl p-6 space-y-6">
      <div className="flex items-center gap-2 text-white font-bold text-lg">
        <Shield className="w-5 h-5 text-blue-400" />
        <span>{t("playerActions.sectionTitle")}</span>
      </div>

      {showRegistrationBlock && (
        <div className="space-y-4">
          {!captainTeam && isRegistrationOpen ? (
            <form onSubmit={handleRegister} className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <input
                type="text"
                required
                minLength={1}
                maxLength={32}
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder={t("playerActions.teamNamePlaceholder")}
                className="rounded-lg bg-slate-900 border border-slate-700 px-4 py-2.5 text-white focus:border-blue-500 focus:outline-none"
              />
              <input
                type="text"
                required
                minLength={1}
                maxLength={50}
                value={captainIngameName}
                onChange={(e) => setCaptainIngameName(e.target.value)}
                placeholder={t("playerActions.captainIngameNamePlaceholder")}
                className="rounded-lg bg-slate-900 border border-slate-700 px-4 py-2.5 text-white focus:border-blue-500 focus:outline-none"
              />
              <input
                type="text"
                required
                pattern="[Ss][Ww]-\d{4}-\d{4}-\d{4}"
                title={t("playerActions.captainFriendCodePlaceholder")}
                maxLength={17}
                value={captainFriendCode}
                onChange={(e) => setCaptainFriendCode(e.target.value)}
                placeholder={t("playerActions.captainFriendCodePlaceholder")}
                className="rounded-lg bg-slate-900 border border-slate-700 px-4 py-2.5 text-white focus:border-blue-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={loading}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 px-5 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                {t("playerActions.registerButton")}
              </button>
            </form>
          ) : captainTeam ? (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-900/60 p-4 rounded-lg border border-slate-800">
              <div className="space-y-1">
                <p className="text-sm font-medium text-slate-200">
                  {t("playerActions.registeredAsCaptain", { teamName: captainTeam.name })}
                </p>
                {captainTeam.is_checked_in && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
                    <CheckCircle2 className="w-4 h-4" />
                    {t("playerActions.checkedInBadge")}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-3">
                {canCheckinNow && !captainTeam.is_checked_in && (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={handleCheckin}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition-colors disabled:opacity-50"
                  >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                    {t("playerActions.checkinButton")}
                  </button>
                )}
                <button
                  type="button"
                  disabled={loading}
                  onClick={handleUnregister}
                  className="inline-flex items-center gap-2 rounded-lg bg-red-600/20 hover:bg-red-600/30 border border-red-500/40 px-4 py-2 text-sm font-semibold text-red-300 transition-colors disabled:opacity-50"
                >
                  <UserMinus className="w-4 h-4" />
                  {t("playerActions.unregisterButton")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {showScoreBlock && captainMatch?.state === "TO_REPORT" && (
        <form onSubmit={handleReportScore} className="bg-slate-900/60 p-4 rounded-lg border border-slate-800 space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Trophy className="w-4 h-4 text-amber-400" />
            <span>
              {t("playerActions.reportScoreTitle")} ({captainMatch.team1_name} vs {captainMatch.team2_name})
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-400">{captainMatch.team1_name}</label>
              <input
                type="number"
                min={0}
                max={99}
                value={team1Score}
                onChange={(e) => setTeam1Score(Number(e.target.value))}
                className="rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-white font-mono"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-400">{captainMatch.team2_name}</label>
              <input
                type="number"
                min={0}
                max={99}
                value={team2Score}
                onChange={(e) => setTeam2Score(Number(e.target.value))}
                className="rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-white font-mono"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-50"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {t("playerActions.submitScoreButton")}
            </button>
          </div>
        </form>
      )}

      {showScoreBlock && captainMatch && captainMatch.state !== "TO_REPORT" && (
        <div className="bg-slate-900/60 p-4 rounded-lg border border-slate-800 space-y-3">
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Trophy className="w-4 h-4 text-amber-400" />
            {captainMatch.team1_name} {captainMatch.team1_score} - {captainMatch.team2_score} {captainMatch.team2_name}
          </p>
          {captainMatch.state === "TO_VALIDATE" && (
            <div className="space-y-3">
              <p className="text-sm text-slate-300">{t("playerActions.validateScorePrompt")}</p>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => submitScore(captainMatch.id, captainMatch.team1_score, captainMatch.team2_score, t("playerActions.scoreValidatedSuccess"))}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  {t("playerActions.validateScoreButton")}
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={handleContest}
                  className="inline-flex items-center gap-2 rounded-lg bg-red-600/20 hover:bg-red-600/30 border border-red-500/40 px-4 py-2 text-sm font-semibold text-red-300 disabled:opacity-50"
                >
                  <XCircle className="w-4 h-4" />
                  {t("playerActions.contestScoreButton")}
                </button>
              </div>
            </div>
          )}
          {captainMatch.state === "WAITING_OPPONENT" && (
            <p className="flex items-center gap-2 text-sm text-slate-300">
              <Clock className="w-4 h-4 text-blue-400" />
              {t("playerActions.waitingOpponent")}
            </p>
          )}
          {captainMatch.state === "CONTESTED" && (
            <p className="flex items-center gap-2 text-sm text-amber-300">
              <AlertTriangle className="w-4 h-4" />
              {t("playerActions.contestedNotice")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
