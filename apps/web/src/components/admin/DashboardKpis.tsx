"use client";

import { Trophy, Users, Swords } from "lucide-react";
import type { DashboardStats } from "@/lib/adminDashboard";
import type { Locale } from "@/i18n/types";
import { t } from "@/i18n";
import { KpiCard } from "./KpiCard";

export interface DashboardKpisProps {
  stats: DashboardStats;
  locale: Locale;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

export function DashboardKpis({ stats, locale, loading = false, error = null, onRetry }: DashboardKpisProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      {/* 1. Tournois en cours / Total */}
      <KpiCard
        title={t(locale, "adminDashboard.kpiActiveTournaments")}
        value={
          <span className="flex items-baseline gap-2">
            <span className="text-emerald-400">{stats.activeTournamentsCount}</span>
            <span className="text-slate-400 text-lg font-normal">/ {stats.totalTournaments}</span>
          </span>
        }
        subtitle={t(locale, "adminDashboard.kpiActiveTournamentsDesc", { total: stats.totalTournaments })}
        icon={Trophy}
        variant="blue"
        loading={loading}
        error={error}
        onRetry={onRetry}
      />

      {/* 2. Inscriptions globales (équipes & joueurs) */}
      <KpiCard
        title={t(locale, "adminDashboard.kpiRegistrations")}
        value={
          <span className="flex items-baseline gap-2">
            <span>{stats.totalTeams}</span>
            <span className="text-slate-400 text-sm font-normal">
              {stats.totalTeams <= 1 ? "équipe" : "équipes"} ({stats.totalPlayers} {t(locale, "common.playersShort")})
            </span>
          </span>
        }
        subtitle={t(locale, "adminDashboard.kpiRegistrationsDesc")}
        icon={Users}
        variant="purple"
        loading={loading}
        error={error}
        onRetry={onRetry}
      />

      {/* 3. Matchs en attente de score */}
      <KpiCard
        title={t(locale, "adminDashboard.kpiPendingMatches")}
        value={
          <span className={stats.pendingMatchesCount > 0 ? "text-amber-400" : "text-emerald-400"}>
            {stats.pendingMatchesCount}
          </span>
        }
        subtitle={
          stats.pendingMatchesCount > 0
            ? t(locale, "adminDashboard.kpiPendingMatchesDesc")
            : t(locale, "adminDashboard.kpiPendingMatchesNone")
        }
        icon={Swords}
        variant={stats.pendingMatchesCount > 0 ? "amber" : "green"}
        loading={loading}
        error={error}
        onRetry={onRetry}
      />
    </div>
  );
}
