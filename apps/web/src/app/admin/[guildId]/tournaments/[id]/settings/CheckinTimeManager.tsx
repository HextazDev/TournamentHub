"use client";

import { useState, useEffect } from "react";
import { botApiFetch } from "@/utils/api";
import { useRouter } from "next/navigation";
import { Square, Clock, ShieldAlert, Calendar } from "lucide-react";
import { useToast } from "@/context/ToastContext";
import { ConfirmModal } from "@/components/ui/ConfirmModal";
import { useTranslation } from "@/i18n/LanguageContext";
import { getErrorMessage, readApiError } from "@/utils/errors";

interface Props {
  tournament: any;
  guildId: string;
}

export function CheckinTimeManager({ tournament, guildId }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const { t, locale } = useTranslation();
  const dateLocale = locale === "en" ? "en-US" : "fr-FR";
  const [loadingStop, setLoadingStop] = useState(false);
  const [showStopModal, setShowStopModal] = useState(false);
  const [now, setNow] = useState(new Date());

  // Tick for countdown accuracy
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 10000);
    return () => clearInterval(timer);
  }, []);

  const isCheckinDisabled = tournament.checkin_mode === "DISABLED";

  const checkinStart = tournament.checkin_start_at ? new Date(tournament.checkin_start_at) : null;
  const checkinEnd = tournament.checkin_end_at ? new Date(tournament.checkin_end_at) : null;
  
  const isCheckinRunning =
    !isCheckinDisabled &&
    tournament.status === "REGISTRATION" &&
    checkinStart &&
    checkinEnd &&
    now >= checkinStart &&
    now < checkinEnd;

  const isCheckinClosed =
    !isCheckinDisabled && checkinEnd && now >= checkinEnd;

  const isDraft = !isCheckinDisabled && tournament.status === "DRAFT";

  const handleStopCheckin = async () => {
    setLoadingStop(true);
    try {
      const res = await botApiFetch(`/api/tournaments/${tournament.id}/checkin/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guildId }),
      });

      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("admin.botCommunicationError"));
      }

      setShowStopModal(false);
      toast.success(t("adminCheckin.stoppedSuccess"));
      router.refresh();
    } catch (e: unknown) {
      toast.error(getErrorMessage(e) ?? t("adminCheckin.stopFailed"));
    } finally {
      setLoadingStop(false);
    }
  };

  return (
    <div className="bg-slate-800 rounded-xl p-6 border border-slate-700 space-y-6 shadow-xl mb-6">
      <div className="flex items-center justify-between border-b border-slate-700/60 pb-4">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Clock className="w-5 h-5 text-emerald-400" />
            {t("adminCheckin.title")}
          </h2>
          <p className="text-slate-400 text-xs mt-1">
            {t("adminCheckin.subtitle")}
          </p>
        </div>
        <div>
          <span
            className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
              isCheckinDisabled
                ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                : isCheckinRunning
                ? "bg-green-500/20 text-green-400 border border-green-500/30"
                : isCheckinClosed
                ? "bg-slate-700/50 text-slate-400 border border-slate-600/30"
                : isDraft
                ? "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30"
                : "bg-blue-500/20 text-blue-400 border border-blue-500/30"
            }`}
          >
            {isCheckinDisabled
              ? t("adminCheckin.disabledStatus")
              : isCheckinRunning
              ? t("adminCheckin.runningStatus")
              : isCheckinClosed
              ? t("adminCheckin.closedStatus")
              : isDraft
              ? t("adminCheckin.draftStatus")
              : t("adminCheckin.plannedStatus")}
          </span>
        </div>
      </div>

      {/* 0. STATE: DISABLED */}
      {isCheckinDisabled && (
        <div className="bg-purple-950/20 border border-purple-900/40 rounded-xl p-5 flex items-center gap-3 text-slate-300">
          <Calendar className="w-5 h-5 text-purple-400 shrink-0" />
          <div className="text-xs space-y-1">
            <p className="font-semibold text-purple-400">{t("adminCheckin.disabledNoticeTitle")}</p>
            <p className="text-slate-300">{t("adminCheckin.disabledNoticeText")}</p>
          </div>
        </div>
      )}

      {/* 1. STATE: RUNNING (SHOW KILL SWITCH) */}
      {isCheckinRunning && checkinEnd && (
        <div className="bg-green-950/20 border border-green-800/40 rounded-xl p-5 flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="space-y-1">
            <p className="text-sm text-green-400 font-medium">
              {t("adminCheckin.openNotice")}
            </p>
            <p className="text-xs text-slate-400">
              {t("adminCheckin.endScheduled", {
                time: checkinEnd.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' }),
                date: checkinEnd.toLocaleDateString(dateLocale, { dateStyle: 'medium' })
              })}
            </p>
          </div>

          <button
            onClick={() => setShowStopModal(true)}
            disabled={loadingStop}
            className="flex items-center gap-2 bg-red-600 hover:bg-red-500 text-white px-5 py-2.5 rounded-lg font-bold transition-all shadow-md shadow-red-900/35 active:scale-[0.98] disabled:opacity-50 cursor-pointer"
          >
            <Square className="w-4 h-4 fill-white" />
            {loadingStop ? t("adminCheckin.stopping") : t("adminCheckin.killSwitch")}
          </button>
        </div>
      )}

      {/* 2. STATE: DRAFT */}
      {isDraft && (
        <div className="bg-slate-900/40 border border-slate-700/50 rounded-xl p-5 flex items-center gap-3 text-slate-400">
          <Calendar className="w-5 h-5 text-slate-500" />
          <div className="text-xs">
            {t("adminCheckin.draftNotice")}
          </div>
        </div>
      )}

      {/* 3. STATE: PLANNED NOT STARTED */}
      {!isCheckinRunning && !isCheckinClosed && !isDraft && checkinStart && checkinEnd && (
        <div className="bg-blue-950/20 border border-blue-900/40 rounded-xl p-5 flex items-center gap-3 text-slate-300">
          <Calendar className="w-5 h-5 text-blue-400" />
          <div className="text-xs space-y-1">
            <p className="font-semibold text-blue-400">{t("adminCheckin.plannedNoticeTitle")}</p>
            <p>
              {t("adminCheckin.plannedNoticeText", {
                start: checkinStart.toLocaleString(dateLocale, { dateStyle: 'short', timeStyle: 'short' }),
                end: checkinEnd.toLocaleString(dateLocale, { dateStyle: 'short', timeStyle: 'short' })
              })}
            </p>
            <p className="text-slate-400">{t("adminCheckin.plannedNoticeBot")}</p>
          </div>
        </div>
      )}

      {/* 4. STATE: ALREADY CLOSED */}
      {isCheckinClosed && (
        <div className="bg-slate-900/60 border border-slate-700/60 rounded-xl p-5 flex items-center gap-3 text-slate-400">
          <ShieldAlert className="w-5 h-5 text-slate-500" />
          <div className="text-xs">
            {t("adminCheckin.closedNotice", {
              date: checkinEnd.toLocaleDateString(dateLocale, { dateStyle: 'medium' }),
              time: checkinEnd.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' })
            })}
          </div>
        </div>
      )}

      {/* Modal Confirmation Arrêt Checkin */}
      <ConfirmModal
        isOpen={showStopModal}
        onClose={() => setShowStopModal(false)}
        onConfirm={handleStopCheckin}
        title={t("adminCheckin.stopTitle")}
        description={t("adminCheckin.stopConfirm")}
        confirmText={t("adminCheckin.stopNow")}
        variant="danger"
        icon={Square}
        isLoading={loadingStop}
      />
    </div>
  );
}
