"use client";

import Link from "next/link";
import {
  Trophy,
  Swords,
  Layers,
  FolderTree,
  Settings,
  AlertCircle,
  RotateCcw,
  Plus,
  Users,
} from "lucide-react";
import type { DashboardTournament } from "@/lib/adminDashboard";
import { computePhaseProgression } from "@/lib/adminDashboard";
import type { Locale, TranslationKey } from "@/i18n/types";
import { t } from "@/i18n";

const STATUS_TRANSLATIONS: Record<string, TranslationKey> = {
  DRAFT: "tournaments.statusDraft",
  REGISTRATION: "tournaments.statusRegistrationOpen",
  ACTIVE: "tournaments.statusActive",
  COMPLETED: "tournaments.statusCompleted",
  ARCHIVED: "tournaments.statusArchived",
};

export interface ActiveTournamentWithDetails extends DashboardTournament {
  teamsCount?: number;
  matches?: { phase_id: string; status: string }[];
}

export interface ActiveTournamentsListProps {
  guildId: string;
  tournaments: ActiveTournamentWithDetails[];
  locale: Locale;
  canCreate?: boolean;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

export function ActiveTournamentsList({
  guildId,
  tournaments,
  locale,
  canCreate = false,
  loading = false,
  error = null,
  onRetry,
}: ActiveTournamentsListProps) {
  // 1. Loading Skeleton
  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-6 w-48 bg-slate-700/60 rounded animate-pulse" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-md animate-pulse space-y-4"
            >
              <div className="flex justify-between items-center">
                <div className="h-5 w-40 bg-slate-700 rounded" />
                <div className="h-5 w-20 bg-slate-700 rounded-full" />
              </div>
              <div className="h-3 w-full bg-slate-700 rounded" />
              <div className="h-10 w-full bg-slate-700 rounded-xl" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // 2. Error State
  if (error) {
    return (
      <div className="bg-slate-800 border border-red-900/50 rounded-2xl p-6 text-center space-y-3">
        <AlertCircle className="w-8 h-8 text-red-400 mx-auto" />
        <h3 className="text-base font-bold text-white">{t(locale, "adminDashboard.kpiError")}</h3>
        <p className="text-sm text-slate-300">{error}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-700 hover:bg-slate-600 px-4 py-2 text-sm font-semibold text-white transition-colors cursor-pointer"
          >
            <RotateCcw className="w-4 h-4" /> {t(locale, "adminDashboard.retry")}
          </button>
        )}
      </div>
    );
  }

  // 3. Empty State
  if (tournaments.length === 0) {
    return (
      <div className="bg-slate-800/40 border border-slate-700/60 border-dashed rounded-2xl p-8 sm:p-12 text-center space-y-4">
        <div className="p-4 bg-slate-700/30 rounded-2xl w-max mx-auto text-slate-500">
          <Trophy className="w-10 h-10" />
        </div>
        <div className="space-y-1">
          <h3 className="text-lg font-bold text-white">{t(locale, "adminDashboard.noActiveTournaments")}</h3>
          <p className="text-sm text-slate-400 max-w-md mx-auto">
            {t(locale, "adminDashboard.noActiveTournamentsDesc")}
          </p>
        </div>
        <div className="pt-2">
          <Link
            href={`/admin/${guildId}/tournaments`}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 px-5 py-2.5 text-sm font-bold text-white transition-colors shadow-lg shadow-blue-900/20"
          >
            {canCreate ? <Plus className="w-4 h-4" /> : <Trophy className="w-4 h-4" />}
            {canCreate
              ? t(locale, "adminDashboard.createTournament")
              : t(locale, "adminDashboard.manageTournaments")}
          </Link>
        </div>
      </div>
    );
  }

  // 4. Active Tournaments List
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Trophy className="w-5 h-5 text-emerald-400" />
            {t(locale, "adminDashboard.activeTournamentsTitle")}
          </h2>
          <p className="text-sm text-slate-400">
            {t(locale, "adminDashboard.activeTournamentsSubtitle")}
          </p>
        </div>
        <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          {tournaments.length} {t(locale, "admin.active")}
        </span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {tournaments.map((tournament) => {
          const progression = computePhaseProgression(tournament.phases, tournament.matches);
          const isRegistration = tournament.status === "REGISTRATION";
          const isActive = tournament.status === "ACTIVE";

          return (
            <div
              key={tournament.id}
              className="bg-slate-800 border border-slate-700/80 rounded-2xl p-5 sm:p-6 shadow-md hover:border-slate-600 transition-all flex flex-col justify-between space-y-5"
            >
              {/* Header: Name, Status badge */}
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <span
                      className={`text-xs font-bold px-2 py-0.5 rounded-full inline-block ${
                        isActive
                          ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                          : "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                      }`}
                    >
                      {t(locale, STATUS_TRANSLATIONS[tournament.status] ?? "tournaments.statusActive")}
                    </span>
                    <h3 className="text-lg sm:text-xl font-bold text-white leading-tight">
                      {tournament.name}
                    </h3>
                  </div>

                  {typeof tournament.teamsCount === "number" && (
                    <div className="flex items-center gap-1.5 text-xs text-slate-400 bg-slate-900/60 px-2.5 py-1 rounded-lg border border-slate-700/50 shrink-0">
                      <Users className="w-3.5 h-3.5 text-blue-400" />
                      <span>{t(locale, "adminDashboard.teamsCount", { count: tournament.teamsCount })}</span>
                    </div>
                  )}
                </div>

                {/* Progression Bar & Details */}
                <div className="bg-slate-900/50 rounded-xl p-3 border border-slate-700/40 space-y-2">
                  <div className="flex justify-between text-xs text-slate-300 font-medium">
                    <span>
                      {progression.currentPhaseName
                        ? t(locale, "adminDashboard.phaseCurrent", { phase: progression.currentPhaseName })
                        : isRegistration
                        ? tournament.is_registration_open
                          ? t(locale, "adminDashboard.registrationOpenBadge")
                          : t(locale, "adminDashboard.registrationClosedBadge")
                        : t(locale, "adminDashboard.phaseProgress")}
                    </span>
                    {progression.totalMatches > 0 && (
                      <span className="text-slate-400">
                        {t(locale, "adminDashboard.matchesCompleted", {
                          completed: progression.completedMatches,
                          total: progression.totalMatches,
                          percent: progression.progressPercent,
                        })}
                      </span>
                    )}
                  </div>

                  {/* Progress bar */}
                  <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                    <div
                      className={`h-full transition-all duration-500 ${
                        progression.progressPercent === 100
                          ? "bg-emerald-400"
                          : "bg-gradient-to-r from-blue-500 to-indigo-500"
                      }`}
                      style={{
                        width: `${
                          progression.totalMatches > 0
                            ? Math.max(5, progression.progressPercent)
                            : isRegistration
                            ? 25
                            : 10
                        }%`,
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Direct 1-Click Action Links to Sub-modules */}
              <div className="pt-2 border-t border-slate-700/60">
                <p className="text-[11px] uppercase tracking-wider font-bold text-slate-400 mb-2">
                  {t(locale, "adminDashboard.directAccess")}
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {/* Matchs */}
                  <Link
                    href={`/admin/${guildId}/tournaments/${tournament.id}/matches`}
                    className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-slate-700/70 hover:bg-blue-600 text-slate-200 hover:text-white text-xs font-semibold transition-colors"
                  >
                    <Swords className="w-3.5 h-3.5" />
                    <span>{t(locale, "adminDashboard.actionMatches")}</span>
                  </Link>

                  {/* Placement */}
                  <Link
                    href={`/admin/${guildId}/tournaments/${tournament.id}/placement`}
                    className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-slate-700/70 hover:bg-blue-600 text-slate-200 hover:text-white text-xs font-semibold transition-colors"
                  >
                    <Layers className="w-3.5 h-3.5" />
                    <span>{t(locale, "adminDashboard.actionPlacement")}</span>
                  </Link>

                  {/* Structure */}
                  <Link
                    href={`/admin/${guildId}/tournaments/${tournament.id}/structure`}
                    className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-slate-700/70 hover:bg-blue-600 text-slate-200 hover:text-white text-xs font-semibold transition-colors"
                  >
                    <FolderTree className="w-3.5 h-3.5" />
                    <span>{t(locale, "adminDashboard.actionStructure")}</span>
                  </Link>

                  {/* Paramètres */}
                  <Link
                    href={`/admin/${guildId}/tournaments/${tournament.id}/settings`}
                    className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-slate-700/70 hover:bg-blue-600 text-slate-200 hover:text-white text-xs font-semibold transition-colors"
                  >
                    <Settings className="w-3.5 h-3.5" />
                    <span>{t(locale, "adminDashboard.actionSettings")}</span>
                  </Link>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
