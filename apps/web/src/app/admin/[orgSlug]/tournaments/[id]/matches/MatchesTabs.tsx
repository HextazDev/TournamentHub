"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Users, Trophy } from "lucide-react";
import { useTranslation } from "@/i18n/LanguageContext";

export default function MatchesTabs({ guildId, tournamentId, phases }: { guildId: string; tournamentId: string; phases: any[] }) {
  const pathname = usePathname();
  const { t } = useTranslation();
  const basePath = `/admin/${guildId}/tournaments/${tournamentId}/matches`;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-4">
      <Link
        href={basePath}
        className={`px-4 py-2 rounded-lg font-medium transition-all duration-200 flex items-center gap-2 ${
          pathname === basePath
            ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20"
            : "bg-slate-900 text-slate-400 hover:bg-slate-800 hover:text-white"
        }`}
      >
        <LayoutDashboard className="w-4 h-4" />
        {t("adminMatches.overviewTab")}
      </Link>

      {phases.map((phase, index) => {
        let Icon = LayoutDashboard;
        if (phase.format === 'round_robin' || phase.format === 'swiss') Icon = Users;
        else if (phase.format === 'single_elimination' || phase.format === 'double_elimination') Icon = Trophy;

        const phasePath = `${basePath}/${phase.id}`;

        return (
          <Link
            key={phase.id}
            href={phasePath}
            className={`px-4 py-2 rounded-lg font-medium transition-all duration-200 flex items-center gap-2 ${
              pathname === phasePath
                ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20"
                : "bg-slate-900 text-slate-400 hover:bg-slate-800 hover:text-white"
            }`}
          >
            <Icon className="w-4 h-4" />
            {index + 1}. {phase.name}
          </Link>
        );
      })}
    </div>
  );
}
