"use client";

import Link from "next/link";
import {
  CheckCircle2,
  AlertTriangle,
  Bot,
  Settings,
  ExternalLink,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import type { ServerSettings } from "@hub/shared";
import { checkDiscordHealth, type DiscordHealthItemKey } from "@/lib/adminDashboard";
import { buildBotInviteUrl } from "@/lib/accessRules";
import type { Locale, TranslationKey } from "@/i18n/types";
import { t } from "@/i18n";

export interface DiscordHealthWidgetProps {
  guildId: string;
  settings: ServerSettings | null;
  locale: Locale;
  clientId?: string;
  canConfigureServer?: boolean;
}

const ITEM_TRANSLATIONS: Record<DiscordHealthItemKey, TranslationKey> = {
  to_role_id: "adminDashboard.role_to_role_id",
  captain_role_id: "adminDashboard.role_captain_role_id",
  announcement_channel_id: "adminDashboard.channel_announcement_channel_id",
  checkin_channel_id: "adminDashboard.channel_checkin_channel_id",
  registration_channel_id: "adminDashboard.channel_registration_channel_id",
};

export function DiscordHealthWidget({
  guildId,
  settings,
  locale,
  clientId,
  canConfigureServer = false,
}: DiscordHealthWidgetProps) {
  const health = checkDiscordHealth(settings);

  // 1. Bot non présent sur le serveur Discord : Bannière claire avec bouton d'invitation OAuth
  if (!health.botPresent) {
    const inviteUrl = clientId ? buildBotInviteUrl(clientId, guildId) : null;

    return (
      <div className="bg-gradient-to-r from-indigo-950/60 to-slate-900 border border-indigo-700/60 rounded-2xl p-6 shadow-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div className="flex items-start gap-4">
          <div className="p-3.5 bg-indigo-500/20 text-indigo-400 rounded-2xl shrink-0 mt-1 md:mt-0">
            <Bot className="w-8 h-8" />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-red-400 animate-pulse" />
              <h3 className="text-lg font-bold text-white">
                {t(locale, "adminDashboard.botMissing")}
              </h3>
            </div>
            <p className="text-sm text-slate-300 max-w-2xl">
              {t(locale, "adminDashboard.botMissingDesc")}
            </p>
          </div>
        </div>

        {inviteUrl ? (
          <a
            href={inviteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 px-5 py-3 text-sm font-bold text-white transition-all shadow-lg shadow-indigo-900/40 shrink-0 w-full md:w-auto"
          >
            <ExternalLink className="w-4 h-4" />
            {t(locale, "adminDashboard.installBot")}
          </a>
        ) : null}
      </div>
    );
  }

  // 2. Bot présent : Tableau de bord de santé des rôles et salons
  return (
    <div className="bg-slate-800 border border-slate-700/80 rounded-2xl p-6 shadow-md space-y-6">
      {/* En-tête avec statut du bot et badge de complétion */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-700/60 pb-5">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              <Bot className="w-5 h-5 text-indigo-400" />
              {t(locale, "adminDashboard.discordHealthTitle")}
            </h3>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-semibold">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              {t(locale, "adminDashboard.botConnected")}
            </span>
          </div>
          <p className="text-xs sm:text-sm text-slate-400">
            {t(locale, "adminDashboard.discordHealthSubtitle")}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span
            className={`text-xs font-bold px-3 py-1 rounded-full border ${
              health.isAllConfigured
                ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40 flex items-center gap-1"
                : "bg-amber-500/20 text-amber-300 border-amber-500/40 flex items-center gap-1"
            }`}
          >
            {health.isAllConfigured ? (
              <ShieldCheck className="w-3.5 h-3.5" />
            ) : (
              <ShieldAlert className="w-3.5 h-3.5" />
            )}
            {health.isAllConfigured
              ? t(locale, "adminDashboard.allConfigured")
              : t(locale, "adminDashboard.partialConfig", {
                  configured: health.configuredCount,
                  total: health.totalItems,
                })}
          </span>

          {canConfigureServer && (
            <Link
              href={`/admin/${guildId}/settings`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors"
            >
              <Settings className="w-3.5 h-3.5" />
              <span>{t(locale, "adminDashboard.configureDiscord")}</span>
            </Link>
          )}
        </div>
      </div>

      {/* Grille des 5 éléments de configuration (2 rôles, 3 salons) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {health.items.map((item) => {
          const translationKey = ITEM_TRANSLATIONS[item.key];
          const isConfigured = item.configured;

          return (
            <div
              key={item.key}
              className={`p-3.5 rounded-xl border flex items-center justify-between gap-3 transition-colors ${
                isConfigured
                  ? "bg-slate-900/40 border-slate-700/60"
                  : "bg-amber-950/20 border-amber-800/40"
              }`}
            >
              <div className="space-y-0.5 min-w-0">
                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 block">
                  {t(locale, item.type === "role" ? "adminDashboard.typeRole" : "adminDashboard.typeChannel")}
                </span>
                <p className="text-xs sm:text-sm font-semibold text-white truncate">
                  {t(locale, translationKey)}
                </p>
              </div>

              {isConfigured ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 shrink-0">
                  <CheckCircle2 className="w-3 h-3" />
                  {t(locale, "adminDashboard.itemConfigured")}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20 shrink-0">
                  <AlertTriangle className="w-3 h-3" />
                  {t(locale, "adminDashboard.itemMissing")}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
