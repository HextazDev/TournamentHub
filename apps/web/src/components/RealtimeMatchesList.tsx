"use client";

import { useRealtimeMatches } from "@/hooks/useRealtimeMatches";
import { RealtimeBadge } from "@/components/RealtimeBadge";
import { useTranslation } from "@/i18n/LanguageContext";
import { formatRoundName } from "@hub/shared";

interface RealtimeMatchesListProps {
  initialMatches: any[];
  tournamentId?: string;
  phaseId?: string;
  limitRecent?: number;
  limitUpcoming?: number;
  showBadge?: boolean;
}

export function RealtimeMatchesList({
  initialMatches,
  tournamentId,
  phaseId,
  limitRecent,
  limitUpcoming,
  showBadge = true,
}: RealtimeMatchesListProps) {
  const { t } = useTranslation();
  const { matches, recentlyUpdatedMatchId, isConnected } = useRealtimeMatches({
    initialMatches,
    tournamentId,
    phaseId,
  });

  const recentMatchesAll = matches
    .filter((m) => m.status === "COMPLETED" || m.status === "FF" || m.status === "BYE")
    .sort((a, b) => {
      const orderA = a.phase?.phase_order || 0;
      const orderB = b.phase?.phase_order || 0;
      if (orderB !== orderA) return orderB - orderA;

      const dateA = new Date(a.updated_at || a.created_at).getTime();
      const dateB = new Date(b.updated_at || b.created_at).getTime();
      return dateB - dateA;
    });

  const upcomingMatchesAll = matches
    .filter((m) => m.status !== "COMPLETED" && m.status !== "FF" && m.status !== "BYE")
    .sort((a, b) => {
      const orderA = a.phase?.phase_order || 0;
      const orderB = b.phase?.phase_order || 0;
      if (orderA !== orderB) return orderA - orderB;

      const roundA = a.round_number || 0;
      const roundB = b.round_number || 0;
      if (roundA !== roundB) return roundA - roundB;

      return (a.match_number || 0) - (b.match_number || 0);
    });

  const recentMatches = limitRecent ? recentMatchesAll.slice(0, limitRecent) : recentMatchesAll;
  const upcomingMatches = limitUpcoming ? upcomingMatchesAll.slice(0, limitUpcoming) : upcomingMatchesAll;

  return (
    <div className="space-y-6">
      {showBadge && (
        <div className="flex justify-between items-center border-b border-slate-800/50 pb-3">
          <h3 className="text-sm font-semibold text-slate-300">{t("matches.tournamentMatches")}</h3>
          <RealtimeBadge isLive={isConnected} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Derniers résultats */}
        <div>
          <div className="flex text-sm text-slate-400 border-b border-slate-800/50 mb-4 pb-2">
            <span className="font-semibold text-slate-200 border-b-2 border-slate-200 px-2 pb-[10px] -mb-[10px]">
              {t("matches.recentResultsCount", { count: recentMatchesAll.length })}
            </span>
          </div>
          <div className="space-y-3">
            {recentMatches.length === 0 ? (
              <p className="text-slate-500 py-4 text-center bg-[#151722] rounded-lg border border-slate-800/30">
                {t("tournaments.noCompletedMatches")}
              </p>
            ) : (
              recentMatches.map((match) => {
                const s1 = match.team1_score || 0;
                const s2 = match.team2_score || 0;
                const isBye = match.status === "BYE";
                const team1Wins = s1 > s2 || isBye;
                const team2Wins = s2 > s1 && !isBye;
                const isUpdated = recentlyUpdatedMatchId === match.id;

                return (
                  <div
                    key={match.id}
                    className={`bg-[#151722] rounded overflow-hidden flex flex-col font-mono text-sm shadow-sm cursor-pointer group transition-all duration-500 ${
                      isUpdated
                        ? "border-2 border-emerald-500 ring-2 ring-emerald-500/50 shadow-emerald-500/30 bg-emerald-950/20"
                        : "border border-slate-800/50 hover:bg-[#1a1d2d]"
                    }`}
                  >
                    <div className="text-xs text-slate-500 px-3 py-1.5 border-b border-slate-800/50 bg-[#12141d] flex justify-between">
                      <span>
                        {match.phase?.name || t("common.match")} • {match.round_number ? formatRoundName(match.round_number, match.phase?.format) : "Round ?"}
                      </span>
                      {match.match_number && (
                        <span className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-400">
                          {t("common.match")} #{match.match_number}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col p-2">
                      <div className="flex justify-between items-center py-1.5 px-2 hover:bg-slate-800/20 rounded">
                        <span className={`font-semibold ${team1Wins ? "text-slate-200" : "text-slate-400"}`}>
                          {match.team1?.name || t("common.tbd")}
                        </span>
                        <div className="flex items-center gap-3">
                          {!isBye && <span className="text-slate-300 font-bold">{s1}</span>}
                          {isBye && <span className="text-green-500 font-bold text-xs uppercase">{t("common.auto")}</span>}
                          {team1Wins ? (
                            <span className="w-5 h-5 flex items-center justify-center bg-green-500/20 text-green-400 rounded text-[10px] font-bold">
                              {t("common.win")}
                            </span>
                          ) : (
                            <span className="w-5 h-5 flex items-center justify-center bg-slate-800 text-slate-500 rounded text-[10px] font-bold">
                              {t("common.loss")}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex justify-between items-center py-1.5 px-2 hover:bg-slate-800/20 rounded">
                        <span className={`font-semibold ${team2Wins ? "text-slate-200" : "text-slate-400"}`}>
                          {isBye ? t("common.bye") : match.team2?.name || t("common.tbd")}
                        </span>
                        <div className="flex items-center gap-3">
                          {!isBye && <span className="text-slate-300 font-bold">{s2}</span>}
                          {team2Wins ? (
                            <span className="w-5 h-5 flex items-center justify-center bg-green-500/20 text-green-400 rounded text-[10px] font-bold">
                              {t("common.win")}
                            </span>
                          ) : (
                            <span className="w-5 h-5 flex items-center justify-center bg-slate-800 text-slate-500 rounded text-[10px] font-bold">
                              {t("common.loss")}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* À venir */}
        <div>
          <div className="flex text-sm text-slate-400 border-b border-slate-800/50 mb-4 pb-2">
            <span className="font-semibold text-slate-200 border-b-2 border-slate-200 px-2 pb-[10px] -mb-[10px]">
              {t("matches.upcomingCount", { count: upcomingMatchesAll.length })}
            </span>
          </div>
          <div className="space-y-3">
            {upcomingMatches.length === 0 ? (
              <p className="text-slate-500 py-4 text-center bg-[#151722] rounded-lg border border-slate-800/30">
                {t("tournaments.noUpcomingMatches")}
              </p>
            ) : (
              upcomingMatches.map((match) => {
                const isUpdated = recentlyUpdatedMatchId === match.id;

                return (
                  <div
                    key={match.id}
                    className={`bg-[#151722] rounded overflow-hidden flex flex-col font-mono text-sm shadow-sm cursor-pointer group transition-all duration-500 ${
                      isUpdated
                        ? "border-2 border-emerald-500 ring-2 ring-emerald-500/50 shadow-emerald-500/30 bg-emerald-950/20"
                        : "border border-slate-800/50 hover:bg-[#1a1d2d]"
                    }`}
                  >
                    <div className="text-xs text-slate-500 px-3 py-1.5 border-b border-slate-800/50 bg-[#12141d] flex justify-between">
                      <span>
                        {match.phase?.name || t("common.match")} • {match.round_number ? formatRoundName(match.round_number, match.phase?.format) : "Round ?"}
                      </span>
                      {match.match_number && (
                        <span className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-400">
                          {t("common.match")} #{match.match_number}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col p-2 text-slate-300">
                      <div className="flex justify-between items-center py-1.5 px-2">
                        <span className="font-semibold">{match.team1?.name || t("common.tbd")}</span>
                        <span className="text-slate-500 text-xs">VS</span>
                      </div>
                      <div className="flex justify-between items-center py-1.5 px-2 border-t border-slate-800/30">
                        <span className="font-semibold">{match.team2?.name || t("common.tbd")}</span>
                        <span className="text-slate-500 text-xs">{t("admin.pending").toUpperCase()}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

