"use client";

import type { ReactNode, ComponentType } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";
import { useTranslation } from "@/i18n/LanguageContext";

export interface KpiCardProps {
  title: string;
  value: ReactNode;
  subtitle?: ReactNode;
  icon: ComponentType<{ className?: string }>;
  variant?: "blue" | "green" | "amber" | "purple";
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  empty?: boolean;
  emptyMessage?: string;
  retryLabel?: string;
}

const VARIANT_STYLES = {
  blue: {
    bgIcon: "bg-blue-500/10",
    textIcon: "text-blue-400",
    border: "border-slate-700/80 hover:border-blue-500/40",
  },
  green: {
    bgIcon: "bg-emerald-500/10",
    textIcon: "text-emerald-400",
    border: "border-slate-700/80 hover:border-emerald-500/40",
  },
  amber: {
    bgIcon: "bg-amber-500/10",
    textIcon: "text-amber-400",
    border: "border-slate-700/80 hover:border-amber-500/40",
  },
  purple: {
    bgIcon: "bg-purple-500/10",
    textIcon: "text-purple-400",
    border: "border-slate-700/80 hover:border-purple-500/40",
  },
} as const;

export function KpiCard({
  title,
  value,
  subtitle,
  icon: Icon,
  variant = "blue",
  loading = false,
  error = null,
  onRetry,
  empty = false,
  emptyMessage,
  retryLabel,
}: KpiCardProps) {
  const { t } = useTranslation();
  const styles = VARIANT_STYLES[variant];

  // 1. Loading Skeleton
  if (loading) {
    return (
      <div className="bg-slate-800 p-6 rounded-xl border border-slate-700/80 shadow-md animate-pulse flex items-center justify-between">
        <div className="space-y-2 flex-1">
          <div className="h-3 w-28 bg-slate-700 rounded" />
          <div className="h-8 w-20 bg-slate-700 rounded" />
          <div className="h-3 w-36 bg-slate-700 rounded" />
        </div>
        <div className="w-12 h-12 bg-slate-700 rounded-xl shrink-0 ml-4" />
      </div>
    );
  }

  // 2. Error State with Retry
  if (error) {
    return (
      <div className="bg-slate-800 p-6 rounded-xl border border-red-900/50 shadow-md flex items-center justify-between">
        <div className="space-y-2 flex-1">
          <div className="flex items-center gap-2 text-red-400">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="text-xs font-semibold uppercase tracking-wider">{title}</span>
          </div>
          <p className="text-sm text-slate-300">{error}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 font-semibold pt-1 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" /> {retryLabel ?? t("adminDashboard.retry")}
            </button>
          )}
        </div>
        <div className="p-3 bg-red-500/10 rounded-xl shrink-0 ml-4">
          <Icon className="w-6 h-6 text-red-400" />
        </div>
      </div>
    );
  }

  // 3. Normal / Empty State
  return (
    <div
      className={`bg-slate-800 p-6 rounded-xl border ${styles.border} shadow-md flex items-center justify-between transition-all duration-200`}
    >
      <div className="space-y-1 flex-1 pr-4">
        <p className="text-slate-400 text-xs font-bold uppercase tracking-wider">{title}</p>
        <div className="text-2xl lg:text-3xl font-extrabold text-white">
          {empty && emptyMessage ? (
            <span className="text-sm font-normal text-slate-400">{emptyMessage}</span>
          ) : (
            value
          )}
        </div>
        {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
      </div>
      <div className={`p-3.5 ${styles.bgIcon} rounded-xl shrink-0`}>
        <Icon className={`w-7 h-7 ${styles.textIcon}`} />
      </div>
    </div>
  );
}
