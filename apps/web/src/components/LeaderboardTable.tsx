"use client";

import React from "react";
import { useTranslation } from "@/i18n/LanguageContext";
import { resolveGroupPoints } from "@hub/shared";

export interface PhaseTeamStat {
  id: string;
  team_id: string;
  group_id: string | null;
  seed: number | null;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  forfeits: number;
  score_for: number;
  score_against: number;
  differential: number;
  points: number;
  teams: {
    id: string;
    name: string;
    logo_url: string | null;
  };
}

export function LeaderboardTable({ teams, matches, settings }: { teams: PhaseTeamStat[], matches?: any[], settings?: unknown }) {
  const { t } = useTranslation();

  // Config defaults (from @hub/shared / LeaderboardService)
  const {
    points_win: pointsWin,
    points_draw: pointsDraw,
    points_loss: pointsLoss,
    points_forfeit: pointsForfeit,
  } = resolveGroupPoints(settings);

  // Option: dynamically override stats based on matches array if provided
  const computedTeams = teams.map((t) => {
    if (!matches || matches.length === 0) return t;

    let played = 0, wins = 0, draws = 0, losses = 0, forfeits = 0, score_for = 0, score_against = 0;

    matches.forEach((m) => {
      const isCompleted = m.status === "COMPLETED" || m.status === "FF";
      if (!isCompleted) return;

      const isTeam1 = m.team1_id === t.team_id;
      const isTeam2 = m.team2_id === t.team_id;

      if (!isTeam1 && !isTeam2) return;

      played += 1;

      const myScore = isTeam1 ? (m.team1_score || 0) : (m.team2_score || 0);
      const theirScore = isTeam1 ? (m.team2_score || 0) : (m.team1_score || 0);

      score_for += myScore;
      score_against += theirScore;

      if (myScore > theirScore) {
        wins += 1;
      } else if (myScore < theirScore) {
        losses += 1;
        if (m.status === "FF") {
           forfeits += 1;
        }
      } else {
        draws += 1;
      }
    });

    return {
      ...t,
      played,
      wins,
      draws,
      losses,
      forfeits,
      score_for,
      score_against,
      differential: score_for - score_against,
      points: (wins * pointsWin) + (draws * pointsDraw) + (losses * pointsLoss) + (forfeits * pointsForfeit)
    };
  });

  // Sort teams: points DESC, differential DESC, score_for DESC
  const sortedTeams = [...computedTeams].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.differential !== a.differential) return b.differential - a.differential;
    return b.score_for - a.score_for;
  });

  return (
    <div className="w-full overflow-x-auto rounded-lg border border-slate-800/60 shadow-xl bg-slate-900/50">
      <table className="w-full text-left border-collapse text-sm">
        <thead>
          <tr className="bg-slate-800 text-slate-300 font-semibold border-b border-slate-700/50 uppercase text-xs tracking-wider">
            <th className="px-4 py-3 text-center w-12">#</th>
            <th className="px-4 py-3">{t("stages.table.team")}</th>
            <th className="px-3 py-3 text-center" title={t("stages.table.playedTitle")}>{t("stages.table.played")}</th>
            <th className="px-3 py-3 text-center" title={t("stages.table.winsTitle")}>{t("stages.table.wins")}</th>
            <th className="px-3 py-3 text-center" title={t("stages.table.drawsTitle")}>{t("stages.table.draws")}</th>
            <th className="px-3 py-3 text-center" title={t("stages.table.lossesTitle")}>{t("stages.table.losses")}</th>
            <th className="px-3 py-3 text-center" title={t("stages.table.forfeitsTitle")}>{t("stages.table.forfeits")}</th>
            <th className="px-3 py-3 text-center" title={t("stages.table.scoreForTitle")}>{t("stages.table.scoreFor")}</th>
            <th className="px-3 py-3 text-center" title={t("stages.table.scoreAgainstTitle")}>{t("stages.table.scoreAgainst")}</th>
            <th className="px-3 py-3 text-center" title={t("stages.table.differentialTitle")}>{t("stages.table.differential")}</th>
            <th className="px-4 py-3 text-center font-bold text-blue-400">{t("stages.table.points")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/40">
          {sortedTeams.length === 0 ? (
            <tr>
              <td colSpan={11} className="px-6 py-8 text-center text-slate-400 italic">
                {t("stages.noTeamsInGroup")}
              </td>
            </tr>
          ) : (
            sortedTeams.map((stat, index) => (
              <tr 
                key={stat.id || stat.team_id}
                className="hover:bg-slate-800/30 transition-colors"
              >
                <td className="px-4 py-3 text-center font-bold text-slate-500">
                  {index + 1}
                </td>
                <td className="px-4 py-3 font-semibold text-slate-200">
                  <div className="flex items-center gap-2">
                    {stat.teams?.logo_url ? (
                      <img src={stat.teams.logo_url} alt="" className="w-6 h-6 rounded-full object-cover bg-slate-800" />
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center text-xs font-bold">
                        {stat.teams?.name?.substring(0, 1)}
                      </div>
                    )}
                    <span className="truncate max-w-[150px] md:max-w-[200px]" title={stat.teams?.name}>
                      {stat.teams?.name || t("common.unknownTeam")}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-3 text-center text-slate-300">{stat.played || 0}</td>
                <td className="px-3 py-3 text-center text-green-400 font-medium">{stat.wins || 0}</td>
                <td className="px-3 py-3 text-center text-slate-400 font-medium">{stat.draws || 0}</td>
                <td className="px-3 py-3 text-center text-red-400 font-medium">{stat.losses || 0}</td>
                <td className="px-3 py-3 text-center text-orange-400 font-medium">{stat.forfeits || 0}</td>
                <td className="px-3 py-3 text-center text-slate-300">{stat.score_for || 0}</td>
                <td className="px-3 py-3 text-center text-slate-300">{stat.score_against || 0}</td>
                <td className="px-3 py-3 text-center font-medium">
                  <span className={(stat.differential || 0) > 0 ? "text-emerald-400" : (stat.differential || 0) < 0 ? "text-rose-400" : "text-slate-400"}>
                    {(stat.differential || 0) > 0 ? '+' : ''}{(stat.differential || 0)}
                  </span>
                </td>
                <td className="px-4 py-3 text-center font-black text-blue-400 text-base">
                  {stat.points || 0}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}