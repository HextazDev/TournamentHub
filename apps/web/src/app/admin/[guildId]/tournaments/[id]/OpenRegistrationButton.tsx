"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { botApiFetch } from "@/utils/api";
import { RefreshCw, Send } from "lucide-react";
import { useTranslation } from "@/i18n/LanguageContext";
import { useToast } from "@/context/ToastContext";
import { getErrorMessage, readApiError } from "@/utils/errors";

/**
 * Ouvre les inscriptions et publie l'annonce Discord (REG-08) : indépendant de la visibilité web du tournoi.
 * Chaque blocage affiche sa raison au lieu d'un bouton grisé muet.
 */
export function OpenRegistrationButton({
  tournamentId,
  guildId,
  isRegistrationOpen,
  hasRegistrationChannel,
  hasStartedOrCheckin,
}: {
  tournamentId: string;
  guildId: string;
  isRegistrationOpen: boolean;
  hasRegistrationChannel: boolean;
  hasStartedOrCheckin: boolean;
}) {
  const [isSending, setIsSending] = useState(false);
  const { t } = useTranslation();
  const { toast } = useToast();
  const router = useRouter();

  const blockedReason = isRegistrationOpen
    ? t("adminTournaments.alreadyOpen")
    : hasStartedOrCheckin
      ? t("adminTournaments.passedCheckin")
      : !hasRegistrationChannel
        ? t("adminTournaments.missingRegistrationChannel")
        : null;
  const isDisabled = isSending || blockedReason !== null;

  const onOpen = async () => {
    setIsSending(true);
    try {
      const res = await botApiFetch(`/api/tournaments/${tournamentId}/registrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "open", guildId }),
      });
      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("common.unknown"));
      }
      toast.success(t("adminTournaments.openEmbedSent"));
      router.refresh();
    } catch (e: unknown) {
      toast.error(t("adminTournaments.discordError", { message: getErrorMessage(e) ?? t("common.unknown") }));
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 w-full mt-4">
      <button
        onClick={onOpen}
        disabled={isDisabled}
        className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-all shadow-md w-full ${isDisabled ? "bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700" : "bg-indigo-600 hover:bg-indigo-500 text-white"}`}
      >
        {isSending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        {t("adminTournaments.openRegistrationsDiscord")}
      </button>
      {blockedReason && <p className="text-xs text-slate-400">{blockedReason}</p>}
    </div>
  );
}
