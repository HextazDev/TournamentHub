"use client";

import { CopyX, GitMerge, LayoutGrid, Network, LayoutList } from "lucide-react";
import Link from "next/link";
import { useTranslation } from "@/i18n/LanguageContext";

export function PlacementOverviewClient({ 
  tournamentId, 
  guildId, 
  initialPhases 
}: { 
  tournamentId: string; 
  guildId: string; 
  initialPhases: any[] 
}) {
  const { t } = useTranslation();

  const getFormatDetails = (format: string) => {
    if (format === 'SINGLE_ELIM') return { icon: GitMerge, label: t("adminStructure.singleElimLabel") };
    if (format === 'ROUND_ROBIN') return { icon: LayoutGrid, label: t("adminStructure.roundRobinLabel") };
    if (format === 'DOUBLE_ELIM') return { icon: CopyX, label: t("adminStructure.doubleElimLabel") };
    if (format === 'SWISS') return { icon: Network, label: t("adminStructure.swissLabel") };
    return { icon: LayoutList, label: t("common.unknown") };
  };

  return (
    <div className="space-y-8 bg-slate-950 min-h-[50vh] p-6 md:p-8 rounded-xl border border-slate-800">
      
      {initialPhases.length === 0 ? (
        <div className="bg-orange-500/10 border border-orange-500/20 text-orange-400 p-6 rounded-xl text-center">
          {t("adminPlacement.noPhasesFound")}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          
          {/* Existing Phases */}
          {initialPhases.map((phase) => {
            const { icon: PhaseIcon, label: formatLabel } = getFormatDetails(phase.format);
            
            return (
              <div key={phase.id} className="bg-slate-900 rounded-xl border border-slate-800 flex flex-col justify-between shadow-lg relative min-h-[260px] group transition-all duration-300 hover:border-slate-700 hover:shadow-indigo-500/5 hover:shadow-2xl">
                {/* Card Body */}
                <div className="p-8 flex flex-col items-center justify-center flex-1 text-center h-full">
                  <div className="mb-6 flex items-center justify-center text-slate-500 group-hover:text-indigo-400 transition-colors">
                     <PhaseIcon className="w-16 h-16" strokeWidth={1.2} />
                  </div>
                  <h3 className="text-xl font-bold text-white mb-1">{phase.phase_order}. {phase.name}</h3>
                  <p className="text-sm font-medium text-slate-400">{formatLabel}</p>
                </div>

                {/* Card Footer */}
                <div className="border-t border-slate-800 p-1.5 flex justify-center items-center bg-slate-950/80 rounded-b-xl">
                  <Link 
                    href={`/admin/${guildId}/tournaments/${tournamentId}/placement/${phase.id}`}
                    className="text-indigo-400 hover:text-indigo-300 text-sm font-bold px-4 py-2.5 transition-colors w-full text-center"
                  >
                    {t("adminPlacement.managePlacements")}
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
