"use client";

import { useState } from "react";
import { botApiFetch } from '@/utils/api';
import { useRouter } from "next/navigation";
import { Rocket, Loader2, AlertOctagon, AlertTriangle, RefreshCw } from "lucide-react";
import { useToast } from "@/context/ToastContext";
import { ConfirmModal } from "@/components/ui/ConfirmModal";
import { useTranslation } from "@/i18n/LanguageContext";
import { getErrorMessage, readApiError } from "@/utils/errors";

interface Props {
  tournamentId: string;
  guildId: string;
  status: string;
  /** Une intégration est en panne : ses effets externes (salons, annonces) sont à rejouer. */
  integrationDegraded?: boolean;
}

type UncheckedChoice = "keep" | "remove";

export function TournamentLifecycleManager({ tournamentId, guildId, status, integrationDegraded = false }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [loadingLaunch, setLoadingLaunch] = useState(false);
  const [loadingClose, setLoadingClose] = useState(false);
  const [showLaunchModal, setShowLaunchModal] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [uncheckedCount, setUncheckedCount] = useState<number | null>(null);
  const [needsResync, setNeedsResync] = useState(integrationDegraded);
  const [syncing, setSyncing] = useState(false);

  /** INT-01 : le tournoi a avancé ; seul l'effet externe a échoué et reste rejouable. */
  const handleIntegrationWarnings = (payload: { integrationWarnings?: unknown[] }) => {
    if (payload.integrationWarnings?.length) {
      toast.warning(t("integrationSync.warning"));
      setNeedsResync(true);
    }
  };

  const handleResync = async () => {
    setSyncing(true);
    try {
      const res = await botApiFetch(`/api/tournaments/${tournamentId}/integrations/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guildId }),
      });
      if (!res.ok) throw new Error((await readApiError(res)) ?? t("admin.botCommunicationError"));
      const payload = (await res.json()) as { integrationWarnings?: unknown[] };
      if (payload.integrationWarnings?.length) {
        toast.warning(t("integrationSync.warning"));
      } else {
        toast.success(t("integrationSync.success"));
        setNeedsResync(false);
        router.refresh();
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err) ?? t("admin.botCommunicationError"));
    } finally {
      setSyncing(false);
    }
  };

  const handleLaunch = async (uncheckedTeams?: UncheckedChoice) => {
    setLoadingLaunch(true);
    try {
      const res = await botApiFetch(`/api/tournaments/${tournamentId}/launch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guildId, ...(uncheckedTeams ? { uncheckedTeams } : {}) }),
      });

      if (res.status === 409) {
        const conflict = (await res.clone().json()) as { code?: string; uncheckedCount?: number };
        if (conflict.code === "UNCHECKED_TEAMS" && typeof conflict.uncheckedCount === "number") {
          setShowLaunchModal(false);
          setUncheckedCount(conflict.uncheckedCount);
          return;
        }
      }
      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("admin.botCommunicationError"));
      }

      toast.success(t("admin.launchedSuccess"));
      handleIntegrationWarnings((await res.json()) as { integrationWarnings?: unknown[] });
      setShowLaunchModal(false);
      setUncheckedCount(null);
      router.refresh();
    } catch (err: unknown) {
      console.error(err);
      toast.error(t("feedback.launchFailed", { message: getErrorMessage(err) ?? t("admin.botCommunicationError") }));
    } finally {
      setLoadingLaunch(false);
    }
  };

  const handleClose = async () => {
    setLoadingClose(true);
    try {
      const res = await botApiFetch(`/api/tournaments/${tournamentId}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guildId }),
      });

      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("admin.botCommunicationError"));
      }

      toast.success(t("admin.closedSuccess"));
      handleIntegrationWarnings((await res.json()) as { integrationWarnings?: unknown[] });
      setShowCloseModal(false);
      router.refresh();
    } catch (err: unknown) {
      console.error(err);
      toast.error(t("feedback.closeFailed", { message: getErrorMessage(err) ?? t("admin.botCommunicationError") }));
    } finally {
      setLoadingClose(false);
    }
  };

  const resyncBanner = needsResync && (
    <div role="status" className="bg-amber-950/30 border border-amber-800/50 p-4 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
      <span className="flex items-center gap-2 text-sm text-amber-200">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        {t("integrationSync.banner")}
      </span>
      <button
        type="button"
        disabled={syncing}
        onClick={handleResync}
        className="inline-flex items-center gap-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white"
      >
        <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />
        {t("integrationSync.button")}
      </button>
    </div>
  );

  if (status === "COMPLETED" || status === "ARCHIVED") {
    return (
      <>
      {resyncBanner}
      <div className="bg-slate-800/50 border border-slate-700 p-4 rounded-xl flex items-center mb-6">
        <span className="text-slate-400 font-medium">{t("admin.archivedNotice")}</span>
      </div>
      </>
    );
  }

  return (
    <>
      {resyncBanner}
      <div className="bg-slate-900 border border-slate-800 p-6 rounded-xl shadow-lg mb-6 flex flex-col md:flex-row justify-between items-center gap-4">
        <div>
          <h2 className="text-xl font-bold text-white mb-1">{t("admin.lifecycleTitle")}</h2>
          <p className="text-slate-400 text-sm">{t("admin.lifecycleDesc")}</p>
        </div>

        <div className="flex flex-col sm:flex-row items-center gap-3">
          {status !== "ACTIVE" && (
            <button
              onClick={() => setShowLaunchModal(true)}
              disabled={loadingLaunch || loadingClose}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold px-6 py-2.5 rounded-lg transition-colors cursor-pointer"
            >
              {loadingLaunch ? <Loader2 className="w-5 h-5 animate-spin" /> : <Rocket className="w-5 h-5" />}
              {t("admin.launchTournament")}
            </button>
          )}

          {status === "ACTIVE" && (
            <button
              onClick={() => setShowCloseModal(true)}
              disabled={loadingLaunch || loadingClose}
              className="flex items-center gap-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-bold px-6 py-2.5 rounded-lg transition-colors cursor-pointer"
            >
              {loadingClose ? <Loader2 className="w-5 h-5 animate-spin" /> : <AlertOctagon className="w-5 h-5" />}
              {t("admin.closeTournament")}
            </button>
          )}
        </div>
      </div>

      {/* Modal Lancement */}
      <ConfirmModal
        isOpen={showLaunchModal}
        onClose={() => setShowLaunchModal(false)}
        onConfirm={() => handleLaunch()}
        title={t("admin.launchTournament")}
        description={t("admin.launchConfirm")}
        confirmText={t("admin.launchTournament")}
        variant="primary"
        icon={Rocket}
        isLoading={loadingLaunch}
      />

      {/* LCH-01 : le sort des équipes sans check-in est toujours une décision explicite du TO. */}
      <ConfirmModal
        isOpen={uncheckedCount !== null}
        onClose={() => setUncheckedCount(null)}
        onConfirm={() => handleLaunch("keep")}
        title={t("admin.uncheckedTeamsTitle")}
        description={
          <span className="block space-y-3">
            <span className="block">{t("admin.uncheckedTeamsDesc", { count: uncheckedCount ?? 0 })}</span>
            <button
              type="button"
              disabled={loadingLaunch}
              onClick={() => handleLaunch("remove")}
              className="w-full rounded-lg border border-red-500/40 bg-red-600/20 hover:bg-red-600/30 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-red-300"
            >
              {t("admin.uncheckedTeamsRemove", { count: uncheckedCount ?? 0 })}
            </button>
          </span>
        }
        confirmText={t("admin.uncheckedTeamsKeep")}
        variant="warning"
        isLoading={loadingLaunch}
      />

      {/* Modal Clôture */}
      <ConfirmModal
        isOpen={showCloseModal}
        onClose={() => setShowCloseModal(false)}
        onConfirm={handleClose}
        title={t("admin.closeTournament")}
        description={t("admin.closeConfirm")}
        confirmText={t("admin.closeConfirmButton")}
        confirmPhrase={t("admin.closeConfirmPhrase")}
        variant="danger"
        icon={AlertOctagon}
        isLoading={loadingClose}
      />
    </>
  );
}

