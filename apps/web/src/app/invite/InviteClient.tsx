"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn, useSession } from "next-auth/react";
import { Loader2, UserPlus } from "lucide-react";
import { useTranslation } from "@/i18n/LanguageContext";
import { botApiFetch } from "@/utils/api";
import { readApiError } from "@/utils/errors";

export function InviteClient() {
  const { t } = useTranslation();
  const router = useRouter();
  const { status } = useSession();
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    const token = window.location.hash.slice(1);
    if (!token) {
      setError(t("invitePage.missingToken"));
      return;
    }
    setAccepting(true);
    setError(null);
    try {
      const res = await botApiFetch("/api/organizations/invites/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        setError((await readApiError(res)) ?? t("common.unknown"));
        return;
      }
      const { slug } = (await res.json()) as { slug: string };
      router.push(`/admin/${slug}`);
    } catch {
      setError(t("common.internalError"));
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-6">
      <div className="bg-[#151722] border border-slate-800 rounded-2xl p-8 max-w-md w-full text-center space-y-5">
        <UserPlus className="w-10 h-10 text-blue-400 mx-auto" />
        <h1 className="text-2xl font-bold text-white">{t("invitePage.title")}</h1>
        <p className="text-slate-400">{t("invitePage.description")}</p>
        {error && <p role="alert" className="text-sm text-red-300 bg-red-950/40 border border-red-900/50 rounded-lg p-3">{error}</p>}
        {status === "unauthenticated" ? (
          <button
            type="button"
            onClick={() => signIn("discord", { callbackUrl: window.location.href })}
            className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2.5 font-semibold text-white"
          >
            {t("invitePage.signIn")}
          </button>
        ) : (
          <button
            type="button"
            onClick={accept}
            disabled={accepting || status === "loading"}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2.5 font-semibold text-white"
          >
            {accepting && <Loader2 className="w-4 h-4 animate-spin" />}
            {t("invitePage.accept")}
          </button>
        )}
      </div>
    </div>
  );
}
