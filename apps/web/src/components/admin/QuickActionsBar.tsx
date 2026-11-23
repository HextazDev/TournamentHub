"use client";

import Link from "next/link";
import { Plus, Settings, Archive, Trophy } from "lucide-react";
import type { Locale } from "@/i18n/types";
import { t } from "@/i18n";

export interface QuickActionsBarProps {
  guildId: string;
  locale: Locale;
  canCreate?: boolean;
  canConfigureServer?: boolean;
}

export function QuickActionsBar({
  guildId,
  locale,
  canCreate = false,
  canConfigureServer = false,
}: QuickActionsBarProps) {
  return (
    <div className="bg-slate-800/80 border border-slate-700/80 rounded-2xl p-4 sm:p-5 shadow-md flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <div className="p-2.5 bg-blue-500/10 rounded-xl text-blue-400 shrink-0">
          <Trophy className="w-5 h-5" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-white">
            {t(locale, "adminDashboard.quickActionsTitle")}
          </h3>
          <p className="text-xs text-slate-400">
            {t(locale, "adminDashboard.quickActionsSubtitle")}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        {/* Créer un tournoi */}
        {canCreate && (
          <Link
            href={`/admin/${guildId}/tournaments`}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 px-4 py-2 text-xs sm:text-sm font-bold text-white transition-colors shadow-lg shadow-blue-900/20 grow sm:grow-0"
          >
            <Plus className="w-4 h-4" />
            <span>{t(locale, "adminDashboard.createTournament")}</span>
          </Link>
        )}

        {/* Configurer le serveur / Discord */}
        {canConfigureServer && (
          <Link
            href={`/admin/${guildId}/settings`}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-700 hover:bg-slate-600 px-4 py-2 text-xs sm:text-sm font-semibold text-white transition-colors grow sm:grow-0"
          >
            <Settings className="w-4 h-4" />
            <span>{t(locale, "adminDashboard.configureServer")}</span>
          </Link>
        )}

        {/* Consulter les archives */}
        <Link
          href={`/admin/${guildId}/tournaments`}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-700/60 hover:bg-slate-700 px-4 py-2 text-xs sm:text-sm font-semibold text-slate-300 hover:text-white transition-colors grow sm:grow-0"
        >
          <Archive className="w-4 h-4 text-slate-400" />
          <span>{t(locale, "adminDashboard.viewArchives")}</span>
        </Link>
      </div>
    </div>
  );
}
