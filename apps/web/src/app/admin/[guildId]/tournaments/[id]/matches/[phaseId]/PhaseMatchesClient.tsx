"use client";

import { useState } from "react";
import { botApiFetch } from '@/utils/api';
import { formatRoundName } from "@hub/shared";

import { useRouter } from "next/navigation";
import { Search, Trophy, Check, X, CalendarDays, Loader2, ArrowLeft, Users, AlertCircle } from "lucide-react";
import { LeaderboardTable } from "@/components/LeaderboardTable";
import { useSupabaseSubscription } from "@/hooks/useSupabaseSubscription";
import { useToast } from "@/context/ToastContext";
import { useTranslation } from "@/i18n/LanguageContext";

export function PhaseMatchesClient({ tournamentId, guildId, phase, initialMatches, phaseTeams, dbGroups }: any) {
  const router = useRouter();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [selectedMatch, setSelectedMatch] = useState<any>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);

  useSupabaseSubscription({
    table: "matches",
    onChange: () => router.refresh()
  });

  useSupabaseSubscription({
    table: "phase_teams",
    onChange: () => router.refresh()
  });

  const isGroups = phase.format === "ROUND_ROBIN";
  
  // Checking completion
  const totalMatches = initialMatches.length;
  const completedMatches = initialMatches.filter((m: any) => m.status === "COMPLETED" || m.status === "FF" || m.status === "BYE").length;
  const isPhaseFinished = totalMatches > 0 && completedMatches === totalMatches;

  // --- STATE FOR MODAL ---
  const [mTeam1Score, setMTeam1Score] = useState(0);
  const [mTeam2Score, setMTeam2Score] = useState(0);
  const [mTeam1Ff, setMTeam1Ff] = useState(false);
  const [mTeam2Ff, setMTeam2Ff] = useState(false);

  const openMatchEdit = (match: any) => {
    setSelectedMatch(match);
    setMTeam1Score(match.team1_score || 0);
    setMTeam2Score(match.team2_score || 0);
    const isT1Ff = match.status === "FF" && (match.team1_score || 0) < (match.team2_score || 0);
    const isT2Ff = match.status === "FF" && (match.team2_score || 0) < (match.team1_score || 0);
    // Rough approximation of FF from DB.
    setMTeam1Ff(isT1Ff);
    setMTeam2Ff(isT2Ff);
  };

  const handleUpdateMatch = async () => {
    setIsSubmitting(true);
    const isFf = mTeam1Ff || mTeam2Ff;
    const finalData = {
      team1_score: mTeam1Score,
      team2_score: mTeam2Score,
      status: isFf ? "FF" : "COMPLETED",
      guildId: guildId
    };

    try {
      const res = await botApiFetch(`/api/matches/${selectedMatch.id}/force-score`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finalData)
      });
      if (!res.ok) throw new Error("API Error");
      setSelectedMatch(null);
      toast.success(t("adminMatches.updateSuccess"));
      router.refresh();
    } catch (err) {
      console.error(err);
      toast.error(t("adminMatches.updateError"));
    } finally {
      setIsSubmitting(false);
    }
  };

  // --- RENDERING HELPERS ---
  const getBadgeClass = (res: string, target: string) => {
    if (res !== target) return "bg-slate-800 text-slate-500 border border-slate-700";
    if (target === "V") return "bg-green-500 text-white font-bold border border-green-600 shadow-sm";
    if (target === "D") return "bg-red-500 text-white font-bold border border-red-600 shadow-sm";
    return "bg-slate-700 text-white font-bold border border-slate-600 shadow-sm"; // N
  };

  const renderBadgeRow = (isTeam1: boolean) => {
    let t1Res = "N"; let t2Res = "N";
    if (mTeam1Ff && mTeam2Ff) { t1Res = "D"; t2Res = "D"; }
    else if (mTeam1Ff) { t1Res = "D"; t2Res = "V"; }
    else if (mTeam2Ff) { t1Res = "V"; t2Res = "D"; }
    else if (mTeam1Score > mTeam2Score) { t1Res = "V"; t2Res = "D"; }
    else if (mTeam1Score < mTeam2Score) { t1Res = "D"; t2Res = "V"; }

    const targetRes = isTeam1 ? t1Res : t2Res;
    
    return (
      <div className="flex gap-1">
        <div className={`w-8 h-8 flex flex-col items-center justify-center text-xs rounded ${getBadgeClass(targetRes, "V")}`}>V</div>
        <div className={`w-8 h-8 flex flex-col items-center justify-center text-xs rounded ${getBadgeClass(targetRes, "N")}`}>N</div>
        <div className={`w-8 h-8 flex flex-col items-center justify-center text-xs rounded ${getBadgeClass(targetRes, "D")}`}>D</div>
      </div>
    );
  };

  const getMatchStatusText = (match: any) => {
    if (match.status === "COMPLETED" || match.status === "FF") return t("tournaments.statusCompleted");
    if (match.team1_id && match.team2_id) return t("tournaments.statusActive");
    return t("adminParticipants.pending");
  };


  // --- GROUPS (ROUND ROBIN) RENDER ---
  const renderGroups = () => {
    if (selectedGroup === null) {
      const groupCount = phase.max_groups || 1;
      const displayGroups = dbGroups?.length 
        ? dbGroups 
        : Array.from({length: groupCount}).map((_, i) => ({ id: String(i + 1), name: `Group ${i + 1}` }));

      return (
        <div className="p-6 md:p-8">
          <h2 className="text-2xl font-bold text-white mb-6">{t("adminMatches.groupsTitle")}</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {displayGroups.map((g: any, i: number) => (
              <div 
                key={g.id || i} 
                onClick={() => setSelectedGroup(g.id)}
                className="bg-slate-900 border border-slate-800 rounded-xl p-6 cursor-pointer hover:border-blue-500 hover:bg-slate-800 transition-all flex flex-col items-center justify-center group shadow-md"
              >
                <div className="w-12 h-12 rounded-full bg-blue-500/10 text-blue-400 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                  <Users className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-bold text-white">{g.name || `Group ${i + 1}`}</h3>
                <span className="text-sm text-slate-500 mt-2">{t("adminMatches.clickToViewDetails")}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }

    // Individual Group Detail
    const activeGroupMatches = initialMatches.filter((m: any) => String(m.group_id) === String(selectedGroup));

    const rounds = activeGroupMatches.reduce((acc: any, m: any) => {
      acc[m.round_number] = acc[m.round_number] || [];
      acc[m.round_number].push(m);
      return acc;
    }, {});

    // Filter Phase Teams matching this group
    const currentGroupPhaseTeams = phaseTeams?.filter((pt: any) => 
      String(pt.group_id) === String(selectedGroup)
    ) || [];

    return (
      <div className="p-6 md:p-8 flex flex-col gap-8">
        <div className="flex items-center justify-between">
          <button onClick={() => setSelectedGroup(null)} className="flex items-center gap-2 text-blue-400 hover:text-blue-300 font-bold transition-colors">
            <ArrowLeft className="w-5 h-5"/> {t("adminMatches.backToGroups")}
          </button>
          <div className="flex gap-2">
            <button className="bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 text-sm font-bold rounded shadow-sm border border-slate-700">{t("adminMatches.manualTiebreak")}</button>
            <button className="bg-green-600 hover:bg-green-500 text-white px-4 py-2 text-sm font-bold rounded shadow-sm flex items-center gap-2">
              <Check className="w-4 h-4"/> {t("adminMatches.validate")}
            </button>
          </div>
        </div>

        {/* Classement */}
        <div className="mb-8">
          <LeaderboardTable teams={currentGroupPhaseTeams} matches={activeGroupMatches} settings={phase?.settings} />
        </div>

        {/* Rounds matches */}
        <div className="flex flex-col gap-6">
           {Object.keys(rounds).sort((a,b) => Number(a)-Number(b)).map(roundNum => (
             <div key={roundNum} className="flex flex-col gap-3">
               <h4 className="text-xl font-bold text-slate-400">{t("adminMatches.roundHeader", { round: roundNum })}</h4>
               <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                 {rounds[roundNum].map((match: any) => {
                    const isCompleted = match.status === "COMPLETED" || match.status === "FF";
                    const isPending = !match.team1_id || !match.team2_id;
                    
                    return (
                      <div 
                        key={match.id}
                        onClick={() => !isPending && openMatchEdit(match)}
                        className={`bg-[#151722] rounded border ${isPending ? 'border-slate-700/50 opacity-50 cursor-not-allowed' : 'border-slate-800/50 cursor-pointer hover:border-blue-400'} shadow-sm flex flex-col overflow-hidden transition-colors`}
                      >
                         <div className="flex items-center justify-between p-3 border-b border-slate-700/50">
                            <span className={`text-sm font-semibold truncate ${match.team1_score > match.team2_score ? 'text-white' : 'text-slate-500'}`}>
                              {match.team1?.name || t("common.tbd")}
                            </span>
                            {isCompleted && <span className="text-sm font-bold ml-2">{match.team1_score}</span>}
                         </div>
                         <div className="flex items-center justify-between p-3">
                            <span className={`text-sm font-semibold truncate ${match.team2_score > match.team1_score ? 'text-white' : 'text-slate-500'}`}>
                              {match.team2?.name || t("common.tbd")}
                            </span>
                            {isCompleted && <span className="text-sm font-bold ml-2">{match.team2_score}</span>}
                         </div>
                      </div>
                    )
                 })}
               </div>
             </div>
           ))}
        </div>

      </div>
    );
  };

  // --- BRACKET RENDER ---
  const renderBracket = () => {
    // Organise matches by round
    const rounds = initialMatches.reduce((acc: any, m: any) => {
      acc[m.round_number] = acc[m.round_number] || [];
      acc[m.round_number].push(m);
      return acc;
    }, {});
    
    const roundNumbers = Object.keys(rounds).map(Number).sort((a,b) => a-b);

    if (roundNumbers.length === 0) {
      return (
        <div className="py-12 text-center flex flex-col items-center">
          <p className="text-slate-400">{t("adminMatches.treeNotGenerated")}</p>
        </div>
      );
    }

    const getRoundName = (r: number) => {
      if (phase.format === "DOUBLE_ELIM") {
        if (r < 10) return `Winner Bracket - Round ${r}`;
        if (r >= 11 && r < 21) return `Loser Bracket - Round ${r - 10}`;
        if (r === 21) return `Grande Finale`;
        return `Grande Finale - Reset`;
      }
      return `Round ${r}`;
    };

    const renderRoundColumns = (roundsList: number[]) => {
      const baseHeight = 116;
      const cardHeight = 80;

      return (
        <div className="flex flex-row gap-12 px-8 h-fit min-w-max items-stretch bg-[#0f111a] rounded-xl border border-slate-800/80 p-8">
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
                    const isCompleted = (match.status === "COMPLETED" || match.status === "FF") && !isTBD;
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
                          <div 
                            onClick={() => !isTBD && openMatchEdit(match)}
                            className={`h-full bg-[#151722] border ${isTBD ? 'border-slate-700/50' : 'border-slate-800/50 cursor-pointer hover:border-blue-400'} rounded-lg shadow-sm flex flex-col overflow-hidden text-sm transition-colors text-slate-400 relative z-10 w-full`}
                          >
                             <div className="flex items-stretch border-b border-slate-700/50 h-10">
                                <div className={`flex-1 px-3 flex flex-col justify-center truncate ${isTeam1Winner ? 'font-bold text-slate-200' : 'font-medium text-slate-500'}`}>
                                   {match.team1?.name || t("common.tbd")}
                                </div>
                                {isCompleted && (
                                   <div className="px-3 border-l border-slate-700/50 flex items-center justify-center font-bold text-slate-300 w-10 shrink-0 bg-[#0f111a]">
                                     {match.team1_score}
                                   </div>
                                )}
                             </div>
                             <div className="flex items-stretch h-10">
                                <div className={`flex-1 px-3 flex flex-col justify-center truncate ${isTeam2Winner ? 'font-bold text-slate-200' : 'font-medium text-slate-500'}`}>
                                   {match.team2?.name ? (
                                      match.team2.name
                                   ) : isBye ? (
                                      <span className="text-slate-400 font-bold italic">BYE ({t("common.tbd")})</span>
                                   ) : t("common.tbd")}
                                </div>
                                {isCompleted && (
                                   <div className="px-3 border-l border-slate-700/50 flex items-center justify-center font-bold text-slate-300 w-10 shrink-0 bg-[#0f111a]">
                                     {match.team2_score}
                                   </div>
                                )}
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
        <div className="space-y-4 mb-10 px-8">
          <div className="border-b border-slate-800 pb-2 mb-4">
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

    if (phase.format === "DOUBLE_ELIM") {
      const wbRoundNumbers = roundNumbers.filter(r => r < 10 || r >= 21);
      const lbRoundNumbers = roundNumbers.filter(r => r >= 11 && r < 21);

      return (
        <div className="bg-slate-950 flex flex-col gap-2 py-6 overflow-y-auto max-h-[calc(100vh-140px)]">
          {renderRoundRow(wbRoundNumbers, t("stages.winnerBracket"))}
          {renderRoundRow(lbRoundNumbers, t("stages.loserBracket"))}
        </div>
      );
    }

    return (
      <div className="overflow-x-auto pb-8 pt-4 custom-scrollbar">
        {renderRoundColumns(roundNumbers)}
      </div>
    );
  };

  // --- SWISS RENDER ---
  const renderSwiss = () => {
    // Matches grouped by round
    const rounds = initialMatches.reduce((acc: any, m: any) => {
      acc[m.round_number] = acc[m.round_number] || [];
      acc[m.round_number].push(m);
      return acc;
    }, {});

    return (
      <div className="p-6 md:p-8 flex flex-col gap-8 overflow-y-auto">
        <div>
          <h2 className="text-2xl font-bold text-white mb-2">{t("adminMatches.swissTitle", { name: phase.name })}</h2>
          <p className="text-sm text-slate-500">{t("adminMatches.swissSubtitle")}</p>
        </div>

        {/* Standings */}
        <div className="mb-8">
          <LeaderboardTable teams={phaseTeams} matches={initialMatches} settings={phase?.settings} />
        </div>

        {/* Rounds matches */}
        <div className="flex flex-col gap-6">
           {Object.keys(rounds).sort((a,b) => Number(a)-Number(b)).map(roundNum => (
             <div key={roundNum} className="flex flex-col gap-3">
               <h4 className="text-xl font-bold text-slate-400">{t("adminMatches.swissRoundHeader", { round: roundNum })}</h4>
               <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                 {rounds[roundNum].map((match: any) => {
                    const isCompleted = match.status === "COMPLETED" || match.status === "FF" || match.status === "BYE";
                    const isPending = !match.team1_id && !match.team2_id;
                    const isBye = match.status === "BYE";
                    
                    return (
                      <div 
                        key={match.id}
                        onClick={() => !isPending && !isBye && openMatchEdit(match)}
                        className={`bg-[#151722] rounded border ${isPending ? 'border-slate-700/50 opacity-50 cursor-not-allowed' : (isBye ? 'border-slate-700/30 cursor-default opacity-85' : 'border-slate-800/50 cursor-pointer hover:border-blue-400')} shadow-sm flex flex-col overflow-hidden transition-colors`}
                      >
                         <div className="flex items-center justify-between p-3 border-b border-slate-700/50">
                            <span className={`text-sm font-semibold truncate ${match.team1_score > match.team2_score || isBye ? 'text-white' : 'text-slate-500'}`}>
                              {match.team1?.name || t("common.tbd")}
                            </span>
                            {isCompleted && <span className="text-sm font-bold ml-2">{match.team1_score}</span>}
                         </div>
                         <div className="flex items-center justify-between p-3">
                            <span className={`text-sm font-semibold truncate ${match.team2_score > match.team1_score ? 'text-white' : 'text-slate-500'}`}>
                              {isBye ? (
                                <span className="text-slate-400 font-bold italic">{t("adminMatches.byeExempt")}</span>
                              ) : (
                                match.team2?.name || t("common.tbd")
                              )}
                            </span>
                            {isCompleted && !isBye && <span className="text-sm font-bold ml-2">{match.team2_score}</span>}
                         </div>
                      </div>
                    )
                 })}
               </div>
             </div>
           ))}
        </div>
      </div>
    );
  };


  return (
    <div className="relative flex-1 flex flex-col bg-slate-950">
      
      {/* Banner for completed phase */}
      {isPhaseFinished && (
        <div className="bg-green-500/10 border-b border-green-500/20 px-6 py-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3 text-green-400">
            <Check className="w-5 h-5" />
            <p className="font-semibold text-sm">
              {t("adminMatches.phaseCompletedBanner", { completed: completedMatches, total: totalMatches })}
            </p>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
         {phase.format === "SWISS" ? renderSwiss() : (isGroups ? renderGroups() : renderBracket())}
      </div>

      {/* MATCH EDIT MODAL */}
      {selectedMatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 backdrop-blur-sm p-4">
          <div className="bg-[#151722] rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            
            {/* Header */}
            <div className="p-6 pb-0 flex flex-col items-center text-center shrink-0">
               <h2 className="text-slate-400 font-bold uppercase tracking-wider text-xs mb-4">
                 {formatRoundName(selectedMatch.round_number, phase?.format)} • {t("common.match")} #{selectedMatch.match_number}
               </h2>
               <div className="flex items-center gap-12 w-full justify-center">
                 <span className="text-2xl font-bold text-slate-200 flex-1 text-right truncate bg-[#0f111a] px-4 py-2 rounded-lg border border-slate-700/50">{selectedMatch.team1?.name}</span>
                 <span className="text-sm font-bold text-slate-400 uppercase">VS</span>
                 <span className="text-2xl font-bold text-slate-200 flex-1 text-left truncate bg-[#0f111a] px-4 py-2 rounded-lg border border-slate-700/50">{selectedMatch.team2?.name}</span>
               </div>
               <div className="mt-4 text-sm font-semibold text-slate-500 bg-slate-800 px-4 py-1.5 rounded-full flex items-center gap-2">
                 <CalendarDays className="w-4 h-4"/>
                 {getMatchStatusText(selectedMatch)}
               </div>
            </div>

            {/* Tabs Mock */}
            <div className="px-8 mt-6 border-b border-slate-800/50 flex gap-6 shrink-0">
              <div className="pb-3 border-b-2 border-blue-500 text-blue-600 font-bold text-sm cursor-pointer">{t("adminMatches.resultTab")}</div>
              <div className="pb-3 border-transparent text-slate-500 font-bold text-sm cursor-pointer">{t("adminMatches.infoTab")}</div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto bg-[#151722] p-8">
               <h3 className="text-xl font-bold text-slate-200 mb-6 border-b border-slate-700/50 pb-2">Match</h3>
               
               <table className="w-full">
                  <thead>
                    <tr className="text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700/50">
                      <th className="text-left pb-4 w-1/2">{t("adminMatches.nameHeader")}</th>
                      <th className="text-center pb-4 w-24">{t("adminMatches.forfeitHeader")}</th>
                      <th className="text-center pb-4 w-32">{t("adminMatches.scoreHeader")}</th>
                      <th className="text-right pb-4 w-32 pr-2">{t("adminMatches.resultHeader")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    <tr className="hover:bg-slate-800/30">
                      <td className="py-4 font-bold text-slate-200 text-lg">
                        {selectedMatch.team1?.name}
                      </td>
                      <td className="py-4 text-center">
                        <input 
                          type="checkbox" 
                          checked={mTeam1Ff}
                          onChange={(e) => setMTeam1Ff(e.target.checked)}
                          className="w-5 h-5 rounded text-blue-600 accent-blue-600"
                        />
                      </td>
                      <td className="py-4 text-center">
                         <input 
                           type="number" 
                           min="0"
                           value={mTeam1Score}
                           onChange={(e) => setMTeam1Score(Number(e.target.value))}
                           disabled={mTeam1Ff}
                           className="w-20 px-3 py-2 border border-slate-600/50 rounded shadow-sm text-center font-bold text-slate-200 bg-[#151722] disabled:opacity-50"
                         />
                      </td>
                      <td className="py-4 flex justify-end">
                         {renderBadgeRow(true)}
                      </td>
                    </tr>
                    <tr className="hover:bg-slate-800/30">
                      <td className="py-4 font-bold text-slate-200 text-lg">
                        {selectedMatch.team2?.name}
                      </td>
                      <td className="py-4 text-center">
                        <input 
                          type="checkbox" 
                          checked={mTeam2Ff}
                          onChange={(e) => setMTeam2Ff(e.target.checked)}
                          className="w-5 h-5 rounded text-blue-600 accent-blue-600"
                        />
                      </td>
                      <td className="py-4 text-center">
                         <input 
                           type="number" 
                           min="0"
                           value={mTeam2Score}
                           onChange={(e) => setMTeam2Score(Number(e.target.value))}
                           disabled={mTeam2Ff}
                           className="w-20 px-3 py-2 border border-slate-600/50 rounded shadow-sm text-center font-bold text-slate-200 bg-[#151722] disabled:opacity-50"
                         />
                      </td>
                      <td className="py-4 flex justify-end">
                         {renderBadgeRow(false)}
                      </td>
                    </tr>
                  </tbody>
               </table>
            </div>

            {/* Footer */}
            <div className="bg-[#0f111a] px-8 py-5 border-t border-slate-800/50 flex justify-end gap-3 shrink-0">
               <button 
                 onClick={() => setSelectedMatch(null)}
                 disabled={isSubmitting}
                 className="px-6 py-2.5 bg-slate-700 hover:bg-slate-600 text-white font-bold rounded shadow-sm transition-colors flex items-center gap-2"
               >
                 <ArrowLeft className="w-4 h-4"/> {t("common.back")}
               </button>
               <button 
                 onClick={handleUpdateMatch}
                 disabled={isSubmitting}
                 className="px-6 py-2.5 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded shadow-sm transition-colors flex items-center gap-2"
               >
                 {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin"/> : t("adminPhaseConfig.update")}
               </button>
            </div>
            
          </div>
        </div>
      )}
    </div>
  );
}
