"use client";

import { useState } from "react";
import { botApiFetch } from '@/utils/api';
import { Send, Globe, Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useToast } from "@/context/ToastContext";
import { useTranslation } from "@/i18n/LanguageContext";
import { getErrorMessage, readApiError } from "@/utils/errors";

export function VisibilityToggle({ tournamentId, guildId, initialIsPublic }: { tournamentId: string, guildId: string, initialIsPublic: boolean }) {
  const [isPublic, setIsPublic] = useState(initialIsPublic);
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  const { toast } = useToast();
  const { t } = useTranslation();

  const handleToggle = async () => {
    setIsLoading(true);
    try {
      const res = await botApiFetch(`/api/tournaments/${tournamentId}/visibility`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_public: !isPublic, guildId }),
      });

      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("common.unknown"));
      }

      setIsPublic(!isPublic);
      toast.success(!isPublic ? t("feedback.nowPublic") : t("feedback.nowPrivate"));
      router.refresh();
    } catch (e: unknown) {
      console.error(e);
      toast.error(t("feedback.visibilityFailed", { message: getErrorMessage(e) ?? t("common.unknown") }));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider border ${isPublic ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-slate-800 text-slate-400 border-slate-700'}`}>
        {isPublic ? (
          <span className="flex items-center gap-1.5"><Globe className="w-3 h-3" /> {t("admin.public")}</span>
        ) : (
          <span className="flex items-center gap-1.5"><Lock className="w-3 h-3" /> {t("admin.private")}</span>
        )}
      </span>
      <button
        onClick={handleToggle}
        disabled={isLoading}
        className="p-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors disabled:opacity-50"
        title={isPublic ? t("admin.private") : t("admin.public")}
      >
        <Send className={`w-4 h-4 ${isPublic ? 'text-emerald-400' : ''}`} />
      </button>
    </div>
  );
}

