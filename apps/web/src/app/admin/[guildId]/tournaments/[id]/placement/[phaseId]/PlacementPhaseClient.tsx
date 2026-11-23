"use client";

import { useState } from "react";
import { botApiFetch } from '@/utils/api';

import { useRouter } from "next/navigation";
import {
  Lock,
  Plus,
  Search,
  Trash2,
  Maximize2,
  Users,
  Loader2,
  Wand2,
  Save,
  RotateCcw,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/context/ToastContext";
import { ConfirmModal } from "@/components/ui/ConfirmModal";
import { useTranslation } from "@/i18n/LanguageContext";
import { getErrorMessage, readApiError } from "@/utils/errors";

// Helper for bracket visually formatting the first round
const BRACKET_PAIRS: Record<number, number[][]> = {
  2: [[0, 1]],
  4: [
    [0, 3],
    [1, 2],
  ],
  8: [
    [0, 7],
    [3, 4],
    [1, 6],
    [2, 5],
  ],
  16: [
    [0, 15],
    [7, 8],
    [3, 12],
    [4, 11],
    [1, 14],
    [6, 9],
    [2, 13],
    [5, 10],
  ],
  32: [
    [0, 31],
    [15, 16],
    [7, 24],
    [8, 23],
    [3, 28],
    [12, 19],
    [4, 27],
    [11, 20],
    [1, 30],
    [14, 17],
    [6, 25],
    [9, 22],
    [2, 29],
    [13, 18],
    [5, 26],
    [10, 21],
  ],
};

export function PlacementPhaseClient({
  tournamentId,
  guildId,
  phase,
  availableTeams,
  initialPhaseTeams,
}: {
  tournamentId: string;
  guildId: string;
  phase: any;
  availableTeams: any[];
  initialPhaseTeams: any[];
}) {
  const router = useRouter();
  const { t, locale } = useTranslation();

  const isGroups = phase.format === "ROUND_ROBIN";
  const isSwiss = phase.format === "SWISS";
  const isDoubleElim = phase.format === "DOUBLE_ELIM";
  
  // The total number of slots: round up to next power of 2 for brackets
  const baseSlots = phase.bracket_size || (availableTeams.length > 0 ? availableTeams.length : 8);
  const totalSlots = (isSwiss || isGroups) 
    ? baseSlots 
    : Math.pow(2, Math.ceil(Math.log2(baseSlots)));
  const activeSlotsCount = baseSlots;

  // seeds state: array where index + 1 = seed number. Value = team object or null.
  const [seeds, setSeeds] = useState<(any | null)[]>(() => {
    const array = new Array(totalSlots).fill(null);
    initialPhaseTeams.forEach((pt) => {
      // seed is 1-indexed, can be negative for teams starting in losers
      const zeroIndex = Math.abs(pt.seed) - 1;
      if (zeroIndex >= 0 && zeroIndex < array.length) {
        array[zeroIndex] = pt.teams;
      }
    });
    return array;
  });

  // State to track which seeds start in losers bracket (only for double elimination)
  const [loserSeeds, setLoserSeeds] = useState<Record<number, boolean>>(() => {
    const initial: Record<number, boolean> = {};
    initialPhaseTeams.forEach((pt) => {
      if (pt.seed < 0) {
        initial[Math.abs(pt.seed)] = true;
      }
    });
    return initial;
  });

  const { toast } = useToast();
  const [isSaving, setIsSaving] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [targetSlot, setTargetSlot] = useState<number | null>(null); // 1-indexed
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);

  // Computed state for modal
  const assignedTeamIds = seeds.filter((t) => t !== null).map((t) => t.id);
  const unassignedTeams = availableTeams.filter(
    (t) => !assignedTeamIds.includes(t.id),
  );
  const filteredTeams = unassignedTeams.filter((t) =>
    t.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  // Handlers
  const handleOpenModal = (slotNum: number) => {
    setTargetSlot(slotNum);
    setSelectedTeamId(null);
    setSearchQuery("");
    setModalOpen(true);
  };
  const handleAutoFill = () => {
    const unplacedTeams = availableTeams.filter(
      (t) => !seeds.some((s) => s?.id === t.id),
    );
    if (unplacedTeams.length === 0) {
      toast.info(t("adminPlacement.noTeamsAvailable"));
      return;
    }
    const newSeeds = [...seeds];
    for (let i = 0; i < activeSlotsCount; i++) {
      if (!newSeeds[i] && unplacedTeams.length > 0) {
        newSeeds[i] = unplacedTeams.shift() || null;
      }
    }
    setSeeds(newSeeds);
    toast.success(t("adminPlacement.autoFillSuccess"));
  };
  const handleRemoveFromSlot = (index: number) => {
    const newSeeds = [...seeds];
    newSeeds[index] = null;
    setSeeds(newSeeds);
  };
  const handleResetSeeding = () => {
    setSeeds(new Array(totalSlots).fill(null));
    setShowResetModal(false);
    toast.success(t("adminPlacement.resetSuccess"));
  };

  const handleConfirmSelection = () => {
    if (!targetSlot || !selectedTeamId) return;
    const team = availableTeams.find((t) => t.id === selectedTeamId);
    if (!team) return;

    const newSeeds = [...seeds];
    const zeroIndex = targetSlot - 1;
    // Swap back if picking a team that somehow got assigned while modal open (rare), but just in case
    newSeeds[zeroIndex] = team;
    setSeeds(newSeeds);
    setModalOpen(false);
  };

  const handleSaveSeeding = async () => {
    setIsSaving(true);

    // Construct payload
    const participants = seeds
      .map((team, index) => {
        if (!team) return null;
        const seedNum = index + 1;
        const finalSeed = loserSeeds[seedNum] ? -seedNum : seedNum;
        return { team_id: team.id, seed: finalSeed };
      })
      .filter((t) => t !== null);

    try {
      const res = await botApiFetch(
        `/api/phases/${phase.id}/seeding`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ participants, guildId: guildId }),
        },
      );

      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("adminPlacement.saveFailed"));
      }
      setShowSaveModal(false);
      toast.success(t("adminPlacement.saveSuccess"));
      router.refresh();
    } catch (e: unknown) {
      console.error(e);
      toast.error(t("feedback.genericError", { message: getErrorMessage(e) ?? t("common.unknown") }));
    } finally {
      setIsSaving(false);
    }
  };

  // --- Rendering UI Helpers ---

  // Renders a single slot generically
  const renderSlot = (slotNum: number, small = false) => {
    const team = seeds[slotNum - 1];

    if (!team) {
      return (
        <div
          onClick={() => handleOpenModal(slotNum)}
          className={`flex items-center gap-2 ${small ? "p-1.5" : "p-2.5"} cursor-pointer hover:bg-slate-800/40 transition-colors border border-transparent hover:border-slate-700/50 group rounded`}
        >
          <div className="flex-shrink-0 text-green-500 font-bold group-hover:scale-110 transition-transform">
            <Plus className="w-4 h-4" strokeWidth={3} />
          </div>
          <span className="text-slate-500 text-xs font-medium uppercase tracking-wider">
            {t("adminPlacement.emptySlot")}
          </span>
        </div>
      );
    }

    return (
      <div
        className={`flex items-center justify-between ${small ? "p-1.5" : "p-2.5"} border border-slate-800/50 shadow-sm bg-[#1e2030] rounded group`}
      >
        <div className="flex items-center gap-2 overflow-hidden">
          <div className="flex-shrink-0 w-5 text-center text-xs font-bold text-slate-500">
            (#{slotNum})
          </div>
          <span className="text-slate-200 text-sm font-bold truncate">
            {team.name}
          </span>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleRemoveFromSlot(slotNum - 1);
            }}
            className="text-slate-500 hover:text-red-400 p-1"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <div className="text-slate-500 p-1">
            <Lock className="w-3.5 h-3.5" />
          </div>
        </div>
      </div>
    );
  };

  // Groups Render
  const renderRightGroups = () => {
    const groupCount = phase.max_groups || 1;
    const groups: number[][] = Array.from({ length: groupCount }, () => []);

    // Snake seeding distribution
    for (let i = 0; i < totalSlots; i++) {
      const seed = i + 1; // 1-indexed
      let groupIndex = i % groupCount; // Standard round robin distribution

      // Basic snake draft direction
      const round = Math.floor(i / groupCount);
      if (round % 2 === 1) {
        groupIndex = groupCount - 1 - groupIndex;
      }

      groups[groupIndex].push(seed);
    }

    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 auto-rows-max bg-[#0f111a]">
        {groups.map((groupSeeds, idx) => (
          <div
            key={idx}
            className="bg-[#151722] rounded-lg border border-slate-800 shadow-sm overflow-hidden"
          >
            <div className="bg-slate-900 border-b border-slate-800 px-4 py-2 font-bold text-slate-200 text-sm">
              {t("adminPlacement.groupHeader", { number: idx + 1 })}
            </div>
            <div className="p-2 flex flex-col gap-1.5 bg-[#0f111a]">
              {groupSeeds.map((seedNum) => (
                <div key={seedNum}>{renderSlot(seedNum, true)}</div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  };

  // Swiss Render
  const renderRightSwiss = () => {
    const pairs: number[][] = [];
    const activeSeeds: number[] = [];
    for (let i = 1; i <= totalSlots; i++) {
      activeSeeds.push(i);
    }
    const hasOdd = activeSeeds.length % 2 !== 0;
    let byeSeed: number | null = null;
    if (hasOdd) {
      byeSeed = activeSeeds.pop() || null;
    }
    for (let i = 0; i < activeSeeds.length; i += 2) {
      pairs.push([activeSeeds[i], activeSeeds[i + 1]]);
    }

    return (
      <div className="flex flex-col gap-6 py-4">
        <div>
          <h3 className="text-sm font-bold text-slate-350 tracking-wide uppercase flex items-center gap-2 mb-2">
            <span className="w-2 h-4 bg-amber-500 rounded-sm inline-block"></span>
            {t("adminPlacement.swissPreviewTitle")}
          </h3>
          <p className="text-xs text-slate-500">
            {t("adminPlacement.swissPreviewDesc")}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {pairs.map(([seedA, seedB], idx) => {
            const teamA = seeds[seedA - 1];
            const teamB = seeds[seedB - 1];

            return (
              <div 
                key={idx}
                className="bg-[#151722] rounded-lg border border-slate-800/80 shadow-md flex flex-col overflow-hidden text-sm text-slate-400"
              >
                {/* Match header */}
                <div className="px-3 py-1.5 bg-slate-900 border-b border-slate-800/50 flex justify-between items-center text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  <span>{t("adminPlacement.matchNumber", { number: idx + 1 })}</span>
                </div>

                {/* Team 1 */}
                <div className="flex items-stretch border-b border-slate-800/50 h-11 relative">
                  {!teamA ? (
                    <button
                      onClick={() => handleOpenModal(seedA)}
                      className="flex-1 px-3 text-left hover:bg-slate-800/30 transition-colors flex items-center justify-between group h-full"
                    >
                      <span className="text-slate-500 font-semibold text-xs">
                        {t("adminPlacement.emptySlot")} (Seed {seedA})
                      </span>
                      <Plus
                        className="w-3.5 h-3.5 text-green-500 opacity-0 group-hover:opacity-100"
                        strokeWidth={3}
                      />
                    </button>
                  ) : (
                    <div className="flex-1 px-3 flex items-center justify-between bg-[#151722] group h-full">
                      <div className="flex items-center gap-2 truncate">
                        <span className="text-slate-500 text-xs font-bold">
                          (#{seedA})
                        </span>
                        <span className="font-bold truncate text-sm text-slate-200">
                          {teamA.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => handleRemoveFromSlot(seedA - 1)}
                          className="text-slate-500 hover:text-red-400 p-1 rounded hover:bg-red-500/10 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Team 2 */}
                <div className="flex items-stretch h-11 relative">
                  {!teamB ? (
                    <button
                      onClick={() => handleOpenModal(seedB)}
                      className="flex-1 px-3 text-left hover:bg-slate-800/30 transition-colors flex items-center justify-between group h-full"
                    >
                      <span className="text-slate-500 font-semibold text-xs">
                        {t("adminPlacement.emptySlot")} (Seed {seedB})
                      </span>
                      <Plus
                        className="w-3.5 h-3.5 text-green-500 opacity-0 group-hover:opacity-100"
                        strokeWidth={3}
                      />
                    </button>
                  ) : (
                    <div className="flex-1 px-3 flex items-center justify-between bg-[#151722] group h-full">
                      <div className="flex items-center gap-2 truncate">
                        <span className="text-slate-500 text-xs font-bold">
                          (#{seedB})
                        </span>
                        <span className="font-bold truncate text-sm text-slate-200">
                          {teamB.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => handleRemoveFromSlot(seedB - 1)}
                          className="text-slate-500 hover:text-red-400 p-1 rounded hover:bg-red-500/10 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* BYE Match if any */}
          {byeSeed && (() => {
            const team = seeds[byeSeed - 1];
            return (
              <div 
                className="bg-[#151722] rounded-lg border border-slate-800/80 shadow-md flex flex-col overflow-hidden text-sm text-slate-400 md:col-span-2 max-w-md"
              >
                <div className="px-3 py-1.5 bg-slate-900 border-b border-slate-800/50 flex justify-between items-center text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  <span>{t("adminPlacement.byeMatchTitle")}</span>
                </div>

                <div className="flex items-stretch border-b border-slate-800/50 h-11 relative">
                  {!team ? (
                    <button
                      onClick={() => handleOpenModal(byeSeed!)}
                      className="flex-1 px-3 text-left hover:bg-slate-800/30 transition-colors flex items-center justify-between group h-full"
                    >
                      <span className="text-slate-500 font-semibold text-xs">
                        {t("adminPlacement.emptySlot")} (Seed {byeSeed})
                      </span>
                      <Plus
                        className="w-3.5 h-3.5 text-green-500 opacity-0 group-hover:opacity-100"
                        strokeWidth={3}
                      />
                    </button>
                  ) : (
                    <div className="flex-1 px-3 flex items-center justify-between bg-[#151722] group h-full">
                      <div className="flex items-center gap-2 truncate">
                        <span className="text-slate-500 text-xs font-bold">
                          (#{byeSeed})
                        </span>
                        <span className="font-bold truncate text-sm text-slate-200">
                          {team.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => handleRemoveFromSlot(byeSeed! - 1)}
                          className="text-slate-500 hover:text-red-400 p-1 rounded hover:bg-red-500/10 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex items-center px-3 h-11 bg-slate-900/40 text-slate-500 italic font-semibold">
                  {t("adminPlacement.byeExemptLabel")}
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    );
  };

  // Bracket Render
  const renderRightBracket = () => {
    const pairs = BRACKET_PAIRS[totalSlots];
    if (!pairs) {
      return (
        <div className="text-slate-400 p-8 text-center bg-slate-900 rounded-xl border border-slate-800">
          {t("adminPlacement.noTreeFormat", { size: totalSlots })}
        </div>
      );
    }

    const isDoubleElim = phase.format === "DOUBLE_ELIM";

    const renderBracketTree = (bracketTitle: string, isLoser = false) => {
      const totalRounds = !isLoser ? Math.log2(totalSlots) : 2 * Math.log2(totalSlots) - 2;
      const baseHeight = 116;
      const cardHeight = 80;
      const firstRoundMatchesCount = !isLoser ? pairs.length : pairs.length / 2;

      return (
        <div className="space-y-4 mb-10">
          <div className="border-b border-slate-800 pb-2 mb-4">
            <h3 className="text-sm font-bold text-slate-300 tracking-wide uppercase flex items-center gap-2">
              <span className={`w-2 h-4 ${isLoser ? 'bg-rose-500' : 'bg-blue-500'} rounded-sm inline-block`}></span>
              {bracketTitle}
            </h3>
          </div>
          
          <div className="overflow-x-auto pb-6 pt-2 custom-scrollbar">
            <div className="flex flex-row gap-12 px-4 h-fit min-w-max items-stretch bg-[#0f111a] rounded-xl border border-slate-800 p-8">
              {Array.from({ length: totalRounds }).map((_, rIndex) => {
                const r = rIndex + 1;
                
                const currentRoundMatchesCount = !isLoser
                  ? totalSlots / Math.pow(2, r)
                  : totalSlots / Math.pow(2, Math.floor((r + 1) / 2) + 1);

                const nextRoundMatchesCount = r < totalRounds
                  ? (!isLoser
                      ? totalSlots / Math.pow(2, r + 1)
                      : totalSlots / Math.pow(2, Math.floor((r + 2) / 2) + 1))
                  : 0;

                const prevRoundMatchesCount = r > 1
                  ? (!isLoser
                      ? totalSlots / Math.pow(2, r - 1)
                      : totalSlots / Math.pow(2, Math.floor(r / 2) + 1))
                  : 0;

                const hasOutgoing = r < totalRounds;
                const isOutgoingStraight = hasOutgoing && nextRoundMatchesCount === currentRoundMatchesCount;
                const isOutgoingMerge = hasOutgoing && nextRoundMatchesCount === currentRoundMatchesCount / 2;

                const hasIncoming = r > 1;
                const isIncomingMerge = hasIncoming && prevRoundMatchesCount === currentRoundMatchesCount * 2;
                
                const wrapperHeight = (firstRoundMatchesCount / currentRoundMatchesCount) * baseHeight;

                return (
                  <div key={r} className={`flex flex-col min-w-[240px] w-64 flex-shrink-0 ${isLoser || r > 1 ? 'opacity-60 pointer-events-none' : ''}`}>
                    <div className="text-slate-400 text-xs font-bold text-center py-2 uppercase tracking-wider bg-slate-900 border border-slate-800/80 rounded-md mb-6">
                      {isLoser ? `Loser Round ${r}` : `Round ${r}`}
                    </div>
                    
                    <div className="flex flex-col relative w-full">
                      {Array.from({ length: currentRoundMatchesCount }).map((_, matchIdx) => {
                        let teamAName = "TBD";
                        let teamBName = "TBD";
                        let seedA: number | null = null;
                        let seedB: number | null = null;

                        if (r === 1 && !isLoser) {
                          const pair = pairs[matchIdx];
                          if (pair) {
                            seedA = pair[0] + 1;
                            seedB = pair[1] + 1;
                            const teamA = !loserSeeds[seedA] ? seeds[pair[0]] : null;
                            const teamB = !loserSeeds[seedB] ? seeds[pair[1]] : null;
                            teamAName = teamA?.name || "";
                            teamBName = teamB?.name || "";
                          }
                        } else if (r === 1 && isLoser) {
                          const pairA = pairs[matchIdx * 2];
                          const pairB = pairs[matchIdx * 2 + 1];
                          const sAL = pairA ? pairA.find((s: number) => loserSeeds[s + 1]) : undefined;
                          const sBL = pairB ? pairB.find((s: number) => loserSeeds[s + 1]) : undefined;

                          if (sAL !== undefined) {
                            seedA = sAL + 1;
                            teamAName = seeds[sAL]?.name || "";
                          }
                          if (sBL !== undefined) {
                            seedB = sBL + 1;
                            teamBName = seeds[sBL]?.name || "";
                          }
                        }

                        const isTBD = !seedA && !seedB;

                        return (
                          <div 
                            key={matchIdx} 
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
                                matchIdx % 2 === 0 ? (
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
                              <div className="h-full bg-[#151722] border border-slate-800/50 rounded-lg shadow-sm flex flex-col overflow-hidden text-sm text-slate-400 relative z-10 w-full">
                                {/* Slot A */}
                                <div className="border-b border-slate-700/50 flex items-stretch h-10 w-full relative">
                                  {isTBD || !teamAName ? (
                                    <button
                                      onClick={() => !isTBD && seedA && handleOpenModal(seedA)}
                                      disabled={isTBD || isLoser || r > 1}
                                      className={`flex-1 px-3 text-left ${(isTBD || isLoser || r > 1) ? 'cursor-default' : 'hover:bg-slate-800/30'} transition-colors flex items-center justify-between group h-full`}
                                    >
                                      <span className="text-slate-500 font-semibold text-xs">
                                        {isTBD ? t("common.tbd") : `${t("adminPlacement.emptySlot")} (Seed ${seedA})`}
                                      </span>
                                      {!isTBD && !isLoser && r === 1 && (
                                        <Plus
                                          className="w-3.5 h-3.5 text-green-500 opacity-0 group-hover:opacity-100"
                                          strokeWidth={3}
                                        />
                                      )}
                                    </button>
                                  ) : (
                                    <div className="flex-1 px-3 flex items-center justify-between bg-[#151722] group h-full">
                                      <div className="flex items-center gap-2 truncate">
                                        <span className="text-slate-500 text-xs font-bold">(#{seedA})</span>
                                        <span className="font-bold truncate text-sm text-slate-200">
                                          {teamAName}
                                        </span>
                                      </div>
                                      {!(isLoser || r > 1) && (
                                        <button
                                          onClick={() => seedA && handleRemoveFromSlot(seedA - 1)}
                                          className="text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-500/10 transition-colors"
                                        >
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                      )}
                                    </div>
                                  )}
                                  <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-20 pointer-events-none text-slate-400">
                                    <Lock className="w-3 h-3" />
                                  </div>
                                </div>

                                {/* Slot B */}
                                <div className="flex items-stretch h-10 w-full relative">
                                  {isTBD || !teamBName ? (
                                    <button
                                      onClick={() => !isTBD && seedB && handleOpenModal(seedB)}
                                      disabled={isTBD || isLoser || r > 1}
                                      className={`flex-1 px-3 text-left ${(isTBD || isLoser || r > 1) ? 'cursor-default' : 'hover:bg-slate-800/30'} transition-colors flex items-center justify-between group h-full`}
                                    >
                                      <span className="text-slate-500 font-semibold text-xs">
                                        {isTBD ? t("common.tbd") : `${t("adminPlacement.emptySlot")} (Seed ${seedB})`}
                                      </span>
                                      {!isTBD && !isLoser && r === 1 && (
                                        <Plus
                                          className="w-3.5 h-3.5 text-green-500 opacity-0 group-hover:opacity-100"
                                          strokeWidth={3}
                                        />
                                      )}
                                    </button>
                                  ) : (
                                    <div className="flex-1 px-3 flex items-center justify-between bg-[#151722] group h-full">
                                      <div className="flex items-center gap-2 truncate">
                                        <span className="text-slate-500 text-xs font-bold">(#{seedB})</span>
                                        <span className="font-bold truncate text-sm text-slate-200">
                                          {teamBName}
                                        </span>
                                      </div>
                                      {!(isLoser || r > 1) && (
                                        <button
                                          onClick={() => seedB && handleRemoveFromSlot(seedB - 1)}
                                          className="text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-500/10 transition-colors"
                                        >
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                      )}
                                    </div>
                                  )}
                                  <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-20 pointer-events-none text-slate-400">
                                    <Lock className="w-3 h-3" />
                                  </div>
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
          </div>
        </div>
      );
    };

    if (isDoubleElim) {
      return (
        <div className="flex flex-col gap-8">
          {renderBracketTree(t("adminPlacement.winnerBracket"))}
          {renderBracketTree(t("adminPlacement.loserBracket"), true)}
        </div>
      );
    }

    return renderBracketTree(t("adminPlacement.singleElimination"));
  };

  return (
    <>
      <div className="flex flex-col lg:grid lg:grid-cols-12 gap-6 flex-1 min-h-0">
        {/* LEFT COLUMN: Roster */}
        <div className="col-span-12 lg:col-span-4 bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl flex flex-col h-[50vh] lg:h-[calc(100vh-12rem)] shrink-0 lg:shrink">
          <div className="px-5 py-4 border-b border-slate-800 bg-slate-800/50 flex justify-between items-center shrink-0">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Users className="w-5 h-5 text-blue-400" />
              {t("adminPlacement.rosterTitle")}
            </h2>
            <span className="bg-blue-500/20 text-blue-400 text-xs font-bold px-2 py-1 rounded">
              {seeds.filter((s) => s !== null).length} / {activeSlotsCount}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
            {Array.from({ length: activeSlotsCount }).map((_, index) => {
              const seedNum = index + 1;
              const team = seeds[index];

              return (
                <div
                  key={seedNum}
                  className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                    team
                      ? "bg-slate-800 border-slate-700"
                      : "bg-slate-900 border-slate-800 hover:border-slate-700 border-dashed cursor-pointer"
                  }`}
                  onClick={() => !team && handleOpenModal(seedNum)}
                >
                  <div className="w-6 text-center text-slate-500 font-bold text-sm shrink-0">
                    {seedNum}
                  </div>

                  {team ? (
                    <>
                      <div className="flex-1 font-semibold text-slate-200 truncate pr-2">
                        {team.name}
                      </div>
                      {isDoubleElim && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setLoserSeeds(prev => ({
                              ...prev,
                              [seedNum]: !prev[seedNum]
                            }));
                          }}
                          className={`text-[10px] font-bold px-2 py-1 rounded transition-colors shrink-0 flex items-center gap-1 border uppercase tracking-wider ${
                            loserSeeds[seedNum]
                              ? "bg-rose-500/20 text-rose-400 border-rose-500/30 hover:bg-rose-500/30"
                              : "bg-blue-500/20 text-blue-400 border-blue-500/30 hover:bg-blue-500/30"
                          }`}
                        >
                          {loserSeeds[seedNum] ? "Losers" : "Winners"}
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveFromSlot(index);
                        }}
                        className="text-slate-500 hover:text-red-400 hover:bg-red-500/10 p-1.5 rounded transition-colors shrink-0"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="flex-1 flex items-center justify-between opacity-50 group">
                        <span className="text-slate-400 font-medium text-sm">
                          {t("adminPlacement.emptySlot")}...
                        </span>
                        <div className="w-6 h-6 rounded-full bg-slate-800 text-green-500 flex items-center justify-center border border-slate-700 group-hover:bg-green-500/20 group-hover:text-green-400 transition-colors">
                          <Plus className="w-3.5 h-3.5" strokeWidth={3} />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <div className="p-4 border-t border-slate-800 bg-slate-900/80 shrink-0 backdrop-blur flex flex-col gap-2">
            <button
              onClick={handleAutoFill}
              className="w-full h-10 bg-gradient-to-r from-amber-600 to-yellow-500 hover:from-amber-500 hover:to-yellow-400 text-white rounded-lg font-bold shadow-lg shadow-yellow-500/10 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Wand2 className="w-4 h-4" />
              {t("adminPlacement.autoFill")}
            </button>
            <button
              onClick={() => setShowResetModal(true)}
              disabled={seeds.every((s) => s === null)}
              className="w-full h-10 bg-slate-800/80 hover:bg-rose-950/40 text-slate-400 hover:text-rose-400 rounded-lg font-semibold border border-slate-700 hover:border-rose-900/50 transition-all flex items-center justify-center gap-2 disabled:opacity-30 disabled:hover:bg-slate-800/80 disabled:hover:text-slate-400 disabled:hover:border-slate-700 cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              {t("adminPlacement.resetSeeding")}
            </button>
            <button
              onClick={() => setShowSaveModal(true)}
              disabled={isSaving}
              className="w-full h-12 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-lg font-bold shadow-lg shadow-indigo-500/15 transition-all flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
            >
              {isSaving ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <>
                  <Save className="w-5 h-5" />
                  {t("adminPlacement.saveSeeding")}
                </>
              )}
            </button>
          </div>
        </div>

        {/* RIGHT COLUMN: Visual Preview */}
        <div className="col-span-12 lg:col-span-8 bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl flex flex-col h-[50vh] lg:h-[calc(100vh-12rem)] shrink-0 lg:shrink">
          <div className="px-6 py-4 border-b border-slate-800 bg-slate-800/50 shrink-0 flex justify-between items-center">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Maximize2 className="w-5 h-5 text-slate-400" />
              {t("adminPlacement.previewTitle")}{" "}
              <span className="opacity-50 font-normal">
                ({isGroups ? t("adminStructure.roundRobin") : (isSwiss ? t("adminStructure.swiss") : (phase.format === "DOUBLE_ELIM" ? t("adminStructure.doubleElim") : t("adminStructure.singleElim")))})
              </span>
            </h2>
          </div>

          {/* Visual preview wrapper using dark theme */}
          <div className="p-6 md:p-8 flex-1 overflow-auto bg-[#0f111a]">
            {isGroups ? renderRightGroups() : (isSwiss ? renderRightSwiss() : renderRightBracket())}
          </div>
        </div>
       {/* SELECTION MODAL */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="bg-slate-900 rounded-xl shadow-2xl shadow-indigo-500/10 w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden border border-slate-800 animate-in fade-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="border-b border-slate-800 px-6 py-5 bg-slate-900 shrink-0">
              <h2 className="text-xl font-extrabold text-white flex items-center gap-2">
                <Users className="w-5 h-5 text-indigo-400" />
                {t("adminPlacement.selectParticipantModal", { seed: targetSlot ?? 0 })}
              </h2>
            </div>

            {/* Modal Controls */}
            <div className="px-6 pt-5 pb-2 shrink-0 flex gap-4 items-center">
              <div className="relative flex-1">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Search className="h-4 w-4 text-slate-500" />
                </div>
                <input
                  type="text"
                  className="block w-full pl-10 pr-3 py-2 border border-slate-800 rounded-lg leading-5 bg-slate-950 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm text-slate-200 transition-colors"
                  placeholder={t("adminPlacement.searchParticipantPlaceholder")}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <div className="text-sm font-semibold border border-slate-800 bg-slate-950 px-4 py-2 rounded-lg text-slate-400 flex items-center gap-2 shrink-0">
                {t("adminPlacement.unassignedParticipants")}
              </div>
            </div>

            <div className="px-6 py-2 shrink-0">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="dispo"
                  checked
                  readOnly
                  className="w-4 h-4 rounded text-indigo-600 accent-indigo-600 bg-slate-950 border-slate-800"
                />
                <label
                  htmlFor="dispo"
                  className="text-sm font-semibold text-slate-300"
                >
                  {t("adminPlacement.availableCount", { count: unassignedTeams.length })}
                </label>
              </div>
            </div>

            {/* Modal List */}
            <div className="flex-1 overflow-y-auto bg-slate-950 border-t border-b border-slate-800 custom-scrollbar">
              <table className="min-w-full divide-y divide-slate-800">
                <thead className="bg-slate-900 sticky top-0 z-10 shadow-sm border-b border-slate-850">
                  <tr>
                    <th
                      scope="col"
                      className="px-6 py-3 text-left text-xs font-bold text-slate-400 uppercase tracking-wider w-12"
                    ></th>
                    <th
                      scope="col"
                      className="px-6 py-3 text-left text-xs font-bold text-slate-400 uppercase tracking-wider"
                    >
                      {t("adminParticipants.teamName")}
                    </th>
                    <th
                      scope="col"
                      className="px-6 py-3 text-right text-xs font-bold text-slate-400 uppercase tracking-wider"
                    >
                      {t("adminPlacement.creationDate")}
                    </th>
                    <th
                      scope="col"
                      className="px-6 py-3 text-center text-xs font-bold text-slate-400 uppercase tracking-wider"
                    >
                      Seed
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-slate-950 divide-y divide-slate-800/40">
                  {filteredTeams.length === 0 ? (
                    <tr>
                      <td
                        colSpan={4}
                        className="px-6 py-8 text-center text-slate-500"
                      >
                        {t("adminPlacement.noParticipantFound")}
                      </td>
                    </tr>
                  ) : (
                    filteredTeams.map((team) => (
                      <tr
                        key={team.id}
                        onClick={() => setSelectedTeamId(team.id)}
                        className={`cursor-pointer transition-colors ${selectedTeamId === team.id ? "bg-indigo-500/10 border-l-4 border-l-indigo-500" : "hover:bg-slate-900/40 border-l-4 border-l-transparent"}`}
                      >
                        <td className="px-6 py-4 whitespace-nowrap text-center">
                          <input
                            type="radio"
                            checked={selectedTeamId === team.id}
                            onChange={() => setSelectedTeamId(team.id)}
                            className="w-4 h-4 text-indigo-600 accent-indigo-600 focus:ring-indigo-500 cursor-pointer"
                          />
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-white">
                          {team.name}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-400 text-right">
                          {new Date(team.created_at).toLocaleString(locale === "en" ? "en-US" : "fr-FR", {
                            dateStyle: "short",
                            timeStyle: "medium",
                          })}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500 text-center font-mono">
                          -
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 bg-slate-900 flex items-center justify-between shrink-0 border-t border-slate-800">
              <button
                onClick={() => setModalOpen(false)}
                className="px-6 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg font-bold shadow-md transition-colors flex items-center gap-2 border border-slate-700 cursor-pointer"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleConfirmSelection}
                disabled={!selectedTeamId}
                className="px-8 py-2.5 bg-gradient-to-r from-emerald-600 to-green-600 hover:from-emerald-500 hover:to-green-500 disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-white rounded-lg font-bold shadow-lg transition-all cursor-pointer"
              >
                {t("common.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Réinitialisation Seeding */}
      <ConfirmModal
        isOpen={showResetModal}
        onClose={() => setShowResetModal(false)}
        onConfirm={handleResetSeeding}
        title={t("adminPlacement.resetSeeding")}
        description={t("adminPlacement.resetConfirm")}
        confirmText={t("adminPlacement.resetButton")}
        variant="danger"
        icon={RotateCcw}
      />

      {/* Modal Sauvegarde Seeding */}
      <ConfirmModal
        isOpen={showSaveModal}
        onClose={() => setShowSaveModal(false)}
        onConfirm={handleSaveSeeding}
        title={t("adminPlacement.saveSeeding")}
        description={t("adminPlacement.saveConfirm")}
        confirmText={t("adminPlacement.saveAndGenerate")}
        variant="primary"
        icon={Save}
        isLoading={isSaving}
      />
      </div>
    </>
  );
}
