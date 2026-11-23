"use client";

import { useState, useMemo } from "react";
import { GitCommit } from "lucide-react";
import { LeaderboardTable } from "@/components/LeaderboardTable";
import { useRouter } from "next/navigation";
import { useSupabaseSubscription } from "@/hooks/useSupabaseSubscription";
import { useRealtimeMatches } from "@/hooks/useRealtimeMatches";
import { RealtimeBadge } from "@/components/RealtimeBadge";
import { useTranslation } from "@/i18n/LanguageContext";

type Phase = any;
type Match = any;
type Team = any;

export function StagesClientView({ phases, matches: initialMatches, teams, phaseTeams }: { phases: Phase[], matches: Match[], teams: Team[], phaseTeams?: any[] }) {
  const router = useRouter();
  const { t } = useTranslation();
  const sortedPhases = [...phases].sort((a, b) => a.phase_order - b.phase_order);
  const [activePhaseId, setActivePhaseId] = useState<string | null>(sortedPhases[0]?.id || null);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [groupTab, setGroupTab] = useState<"ranking" | "rounds">("ranking");

  const { matches, recentlyUpdatedMatchId, isConnected } = useRealtimeMatches({
    initialMatches,
    phaseId: activePhaseId || undefined,
  });

  useSupabaseSubscription({
    table: "phase_teams",
    onChange: () => router.refresh()
  });

  const activePhase = phases.find(p => p.id === activePhaseId);

  const phaseMatches = matches.filter(m => m.phase_id === activePhaseId);

  const isBracket = activePhase?.format === "SINGLE_ELIM" || activePhase?.format === "DOUBLE_ELIM";

  // Group phase logic
  const groupsInPhase = useMemo(() => {
    if (isBracket || activePhase?.format === "SWISS") return [];
    
    const explicitGroupIds = new Set(phaseMatches.map(m => m.group_id).filter(Boolean));
    if (explicitGroupIds.size > 0) {
      return Array.from(explicitGroupIds).sort() as string[];
    }

    const count = activePhase?.max_groups || 1;
    return Array.from({ length: count }).map((_, i) => String(i + 1));
  }, [activePhase, phaseMatches, isBracket]);

  // Set default group when phase changes
  useMemo(() => {
    if (!isBracket && activePhase?.format !== "SWISS" && groupsInPhase.length > 0 && (!activeGroupId || !groupsInPhase.includes(activeGroupId))) {
      setActiveGroupId(groupsInPhase[0]);
    }
  }, [isBracket, activePhase, groupsInPhase, activeGroupId]);

  const activeGroupMatches = useMemo(() => {
    if (phaseMatches.some(m => m.group_id)) {
      return phaseMatches.filter(m => String(m.group_id) === String(activeGroupId));
    }
    return phaseMatches;
  }, [phaseMatches, activeGroupId]);

  const renderBracket = () => {
    // Basic flexbox bracket
    const rounds = phaseMatches.reduce((acc: any, m: any) => {
      acc[m.round_number] = acc[m.round_number] || [];
      acc[m.round_number].push(m);
      return acc;
    }, {});
    
    const roundNumbers = Object.keys(rounds).map(Number).sort((a, b) => a - b);

    if (roundNumbers.length === 0) {
      return (
        <div className="py-12 text-center flex flex-col items-center">
          <GitCommit className="w-12 h-12 text-slate-600 mb-4 rotate-90" />
          <p className="text-slate-400">{t("stages.bracketNotGenerated")}</p>
        </div>
      );
    }

    const getRoundName = (r: number) => {
      if (activePhase?.format === "DOUBLE_ELIM") {
        if (r < 10) return `Winner Bracket - Round ${r}`;
        if (r >= 11 && r < 21) return `Loser Bracket - Round ${r - 10}`;
        if (r === 21) return t("stages.grandFinal");
        return t("stages.grandFinalReset");
      }
      return `Round ${r}`;
    };

    const renderRoundColumns = (roundsList: number[]) => {
      const baseHeight = 112;
      const cardHeight = 76;

      return (
        <div className="flex flex-row gap-12 px-4 min-w-max items-stretch bg-[#0f111a] rounded-xl border border-slate-800 p-8">
          {roundsList.map((r, rIndex) => {
            const rMatches = rounds[r].sort((a: any, b: any) => a.match_number - b.match_number);
            const nextRound = roundsList[rIndex + 1];
            const nextRoundMatches = nextRound ? (rounds[nextRound] || []) : [];
            const prevRound = roundsList[rIndex - 1];
            const prevRoundMatches = prevRound ? (rounds[prevRound] || []) : [];
            
            const firstRoundMatchesCount = rounds[roundsList[0]].length;
            const currentRoundMatchesCount = rMatches.length;
            const wrapperHeight = (firstRoundMatchesCount / currentRoundMatchesCount) * baseHeight;
            
            return (
              <div key={r} className="flex flex-col min-w-[240px] w-64 flex-shrink-0">
                <div className="text-slate-400 text-xs font-bold text-center py-2 uppercase tracking-wider bg-slate-900 border border-slate-800/80 rounded-md mb-6">
                  {getRoundName(r)}
                </div>
                
                <div className="flex flex-col relative w-full">
                  {rMatches.map((match: any, idx: number) => {
                    const isBye = !match.team2_id && r === 1 && match.team1_id;
                    const isTBD = !match.team1_id && !match.team2_id;
                    const isCompleted = match.status === "COMPLETED" || match.status === "FF";
                    const isTeam1Winner = isCompleted && match.team1_score > match.team2_score;
                    const isTeam2Winner = isCompleted && match.team2_score > match.team1_score;

                    const hasOutgoing = rIndex < roundsList.length - 1;
                    const isOutgoingStraight = hasOutgoing && nextRoundMatches.length === rMatches.length;
                    const isOutgoingMerge = hasOutgoing && nextRoundMatches.length === rMatches.length / 2;

                    const hasIncoming = rIndex > 0;
                    const isIncomingMerge = hasIncoming && prevRoundMatches.length === rMatches.length * 2;
                    const isByeMatch = (match.status === "COMPLETED" || match.status === "BYE") && (!match.team1_id || !match.team2_id);

                    if (isByeMatch) {
                      return (
                        <div 
                          key={match.id} 
                          className="flex flex-col justify-center items-center relative w-full flex-shrink-0" 
                          style={{ height: `${wrapperHeight}px` }}
                        />
                      );
                    }

                    return (
                      <div 
                        key={match.id} 
                        className="flex flex-col justify-center items-center relative w-full flex-shrink-0" 
                        style={{ height: `${wrapperHeight}px` }}
                      >
                        <div className="relative w-full flex-shrink-0" style={{ height: `${cardHeight}px` }}>
                          
                          {/* Incoming horizontal line */}
                          {hasIncoming && isIncomingMerge && (
                            <div className="absolute right-full top-1/2 w-6 border-t-2 border-slate-700/60 z-0 pointer-events-none -translate-y-1/2" />
                          )}

                          {/* Outgoing lines */}
                          {hasOutgoing && isOutgoingStraight && (
                            <div className="absolute left-full top-1/2 w-12 border-t-2 border-slate-700/60 z-0 pointer-events-none -translate-y-1/2" />
                          )}

                          {hasOutgoing && isOutgoingMerge && (
                            idx % 2 === 0 ? (
                              <div 
                                className="absolute left-full top-1/2 w-6 border-r-2 border-t-2 border-slate-700/60 rounded-tr-md z-0 pointer-events-none origin-top-left" 
                                style={{ height: `${wrapperHeight / 2}px` }}
                              />
                            ) : (
                              <div 
                                className="absolute left-full bottom-1/2 w-6 border-r-2 border-b-2 border-slate-700/60 rounded-br-md z-0 pointer-events-none origin-bottom-left" 
                                style={{ height: `${wrapperHeight / 2}px` }}
                              />
                            )
                          )}

                          {/* Match box content */}
                          <div className={`h-full bg-[#151722] rounded-md overflow-hidden flex flex-col shadow-sm transition-all duration-500 text-sm font-mono cursor-pointer relative z-10 w-full ${recentlyUpdatedMatchId === match.id ? 'border-2 border-emerald-500 ring-2 ring-emerald-500/50 shadow-emerald-500/30 bg-emerald-950/20' : 'border border-slate-800/80 hover:border-slate-600/80'}`}>
                            <div className={`flex justify-between items-center p-2 border-b border-slate-800/50 ${isTeam1Winner ? 'bg-slate-800/30' : ''}`}>
                              <span className={`truncate mr-2 ${isTeam1Winner ? 'text-slate-200 font-bold' : match.team1?.name ? 'text-slate-400' : 'text-slate-600 italic'}`}>
                                {match.team1?.name || t("common.tbd")}
                              </span>
                              <span className={`font-bold ${isTeam1Winner ? 'text-green-400' : isCompleted ? 'text-slate-500' : 'text-slate-600'}`}>
                                {isCompleted ? (match.team1_score || 0) : "-"}
                              </span>
                            </div>
                            <div className={`flex justify-between items-center p-2 ${isTeam2Winner ? 'bg-slate-800/30' : ''}`}>
                              <span className={`truncate mr-2 ${isTeam2Winner ? 'text-slate-200 font-bold' : match.team2?.name ? 'text-slate-400' : 'text-slate-600 italic'}`}>
                                {match.team2?.name ? (
                                  match.team2.name
                                ) : isBye ? (
                                  <span className="text-slate-400 font-bold italic">{t("common.bye")} ({t("common.tbd")})</span>
                                ) : t("common.tbd")}
                              </span>
                              <span className={`font-bold ${isTeam2Winner ? 'text-green-400' : isCompleted ? 'text-slate-500' : 'text-slate-600'}`}>
                                {isCompleted ? (match.team2_score || 0) : "-"}
                              </span>
                            </div>
                          </div>

                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      );
    };

    const renderRoundRow = (roundsList: number[], bracketTitle: string) => {
      if (roundsList.length === 0) return null;
      
      return (
        <div className="space-y-4 mb-10">
          <div className="border-b border-slate-800/80 pb-2 mb-4">
            <h3 className="text-sm font-bold text-slate-350 tracking-wide uppercase flex items-center gap-2">
              <span className="w-2 h-4 bg-blue-500 rounded-sm inline-block"></span>
              {bracketTitle}
            </h3>
          </div>
          
          <div className="overflow-x-auto pb-6 pt-2 custom-scrollbar">
            {renderRoundColumns(roundsList)}
          </div>
        </div>
      );
    };

    if (activePhase?.format === "DOUBLE_ELIM") {
      const wbRoundNumbers = roundNumbers.filter(r => r < 10 || r >= 21);
      const lbRoundNumbers = roundNumbers.filter(r => r >= 11 && r < 21);

      return (
        <div className="flex flex-col gap-2">
          {renderRoundRow(wbRoundNumbers, t("stages.winnerBracket"))}
          {renderRoundRow(lbRoundNumbers, t("stages.loserBracket"))}
        </div>
      );
    }

    return (
      <div className="overflow-x-auto pb-6 pt-2 custom-scrollbar">
        {renderRoundColumns(roundNumbers)}
      </div>
    );
  };

  const renderGroup = () => {
    // Collect `phase_teams` and pass them to LeaderboardTable
    const currentGroupPhaseTeams = phaseTeams?.filter((pt) => 
      pt.phase_id === activePhaseId && 
      (activePhase?.format === "SWISS" ? true : (activeGroupId ? pt.group_id === activeGroupId : true))
    ) || [];

    // Matches grouped by round
    const rounds = activeGroupMatches.reduce((acc: any, m: any) => {
      acc[m.round_number] = acc[m.round_number] || [];
      acc[m.round_number].push(m);
      return acc;
    }, {});
    const roundNumbers = Object.keys(rounds).map(Number).sort((a,b) => a - b);

    return (
      <div className="space-y-6">
        {/* Sub Navigation Group */}
        {groupsInPhase.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-6">
            {groupsInPhase.map((gId, index) => (
              <button
                key={gId}
                onClick={() => setActiveGroupId(gId)}
                className={`px-4 py-2 text-sm font-semibold rounded transition-colors ${
                  activeGroupId === gId
                    ? "bg-blue-600 text-white"
                    : "bg-[#151722] text-slate-400 border border-slate-800/50 hover:bg-slate-800"
                }`}
              >
                {t("stages.groupNumber", { number: index + 1 })}
              </button>
            ))}
          </div>
        )}

        {/* Group Tabs: Classement vs Tours */}
        <div className="flex gap-1 border-b border-slate-800/80 mb-6">
          <button
            onClick={() => setGroupTab("ranking")}
            className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${
              groupTab === "ranking"
                ? "border-blue-500 text-slate-200"
                : "border-transparent text-slate-500 hover:text-slate-300"
            }`}
          >
            {t("stages.ranking")}
          </button>
          <button
            onClick={() => setGroupTab("rounds")}
            className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${
              groupTab === "rounds"
                ? "border-blue-500 text-slate-200"
                : "border-transparent text-slate-500 hover:text-slate-300"
            }`}
          >
            {t("stages.rounds")}
          </button>
        </div>

        {groupTab === "ranking" ? (
          <LeaderboardTable teams={currentGroupPhaseTeams} matches={activeGroupMatches} settings={activePhase?.settings} />
        ) : (
          <div className="space-y-8">
            {roundNumbers.map(roundNum => (
              <div key={roundNum} className="space-y-3">
                <div className="text-xs text-slate-500 uppercase tracking-wide font-bold mb-2">Round {roundNum}</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {rounds[roundNum].map((match: any) => {
                    const isCompleted = match.status === "COMPLETED" || match.status === "FF";
                    const isTeam1Winner = isCompleted && match.team1_score > match.team2_score;
                    const isTeam2Winner = isCompleted && match.team2_score > match.team1_score;

                    return (
                      <div key={match.id} className="bg-[#151722] border border-slate-800/80 rounded flex overflow-hidden font-mono text-sm">
                        <div className="flex flex-col w-full">
                          <div className={`flex justify-between items-center p-2.5 border-b border-slate-800/40 ${isTeam1Winner ? 'bg-slate-800/30 text-slate-200' : 'text-slate-400'}`}>
                            <span className="truncate mr-4">{match.team1?.name || t("common.tbd")}</span>
                            <div className="flex items-center gap-3 shrink-0">
                               {isCompleted ? <span className="font-bold">{match.team1_score}</span> : <span>-</span>}
                               {isTeam1Winner && <span className="w-5 h-5 flex items-center justify-center bg-green-500/20 text-green-400 rounded text-[10px] font-bold">{t("common.win")}</span>}
                               {!isTeam1Winner && isCompleted && <span className="w-5 h-5 flex items-center justify-center bg-slate-800 text-slate-500 rounded text-[10px] font-bold">{t("common.loss")}</span>}
                            </div>
                          </div>
                          <div className={`flex justify-between items-center p-2.5 ${isTeam2Winner ? 'bg-slate-800/30 text-slate-200' : 'text-slate-400'}`}>
                            <span className="truncate mr-4">{match.team2?.name || t("common.tbd")}</span>
                            <div className="flex items-center gap-3 shrink-0">
                               {isCompleted ? <span className="font-bold">{match.team2_score}</span> : <span>-</span>}
                               {isTeam2Winner && <span className="w-5 h-5 flex items-center justify-center bg-green-500/20 text-green-400 rounded text-[10px] font-bold">{t("common.win")}</span>}
                               {!isTeam2Winner && isCompleted && <span className="w-5 h-5 flex items-center justify-center bg-slate-800 text-slate-500 rounded text-[10px] font-bold">{t("common.loss")}</span>}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="bg-[#0f111a] text-slate-200">
      {/* Top Phase Navigation */}
      <div className="flex flex-wrap justify-between items-center gap-4 mb-8 pb-4 border-b border-slate-800/50">
        <div className="flex flex-wrap gap-2 items-center">
          {sortedPhases.map((phase) => (
            <button
              key={phase.id}
              onClick={() => {
                setActivePhaseId(phase.id);
                setGroupTab("ranking");
              }}
              className={`px-4 py-1.5 text-sm font-semibold transition-colors ${
                activePhaseId === phase.id
                  ? "text-blue-400 border-b-2 border-blue-400 pb-1"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {phase.name}
            </button>
          ))}
        </div>
        <RealtimeBadge isLive={isConnected} />
      </div>

      <div className="mt-4">
        {isBracket ? renderBracket() : renderGroup()}
      </div>
    </div>
  );
}