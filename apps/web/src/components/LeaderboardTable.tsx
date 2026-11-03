"use client";

import React from "react";
import { useTranslation } from "@/i18n/LanguageContext";
import { compareStandings, computeStandings, resolveGroupPoints, type StandingsMatch } from "@hub/shared";

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

/**
 * Sans matchs fournis : valeurs persistées (phase_teams). Avec matchs : même calcul partagé que le bot
 * (`computeStandings` de @hub/shared), pour un classement identique web / Discord (LB-06).
 */
function withStandings(teams: PhaseTeamStat[], matches: readonly StandingsMatch[] | undefined, settings: unknown): PhaseTeamStat[] {
  if (!matches || matches.length === 0) return teams;
  const standings = computeStandings(teams.map((team) => team.team_id), matches, resolveGroupPoints(settings));
  return teams.map((team) => {
    const standing = standings.get(team.team_id);
    return standing ? { ...team, ...standing } : team;
  });
}

export function LeaderboardTable({ teams, matches, settings }: { teams: PhaseTeamStat[], matches?: readonly StandingsMatch[], settings?: unknown }) {
  const { t } = useTranslation();
  const sortedTeams = [...withStandings(teams, matches, settings)].sort(compareStandings);

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