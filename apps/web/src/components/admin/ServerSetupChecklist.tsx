import Link from "next/link";
import { CheckCircle2, Circle, Settings } from "lucide-react";
import type { ServerSettings } from "@hub/shared";
import { serverSetupChecklist, type SetupStepKey } from "@/lib/accessRules";
import { t } from "@/i18n";
import type { Locale, TranslationKey } from "@/i18n/types";

const STEP_TEXT: Record<SetupStepKey, TranslationKey> = {
  toRole: "guide.step_toRole",
  captainRole: "guide.step_captainRole",
  registrationChannel: "guide.step_registrationChannel",
  announcementChannel: "guide.step_announcementChannel",
  checkinChannel: "guide.step_checkinChannel",
};

/** Guide de configuration du serveur : chaque réglage manquant est expliqué et mène aux paramètres. */
export function ServerSetupChecklist({ guildId, settings, locale }: { guildId: string; settings: ServerSettings | null; locale: Locale }) {
  const steps = serverSetupChecklist(settings);
  const done = steps.filter((s) => s.done).length;
  const complete = done === steps.length;

  return (
    <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-md space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">{t(locale, "guide.setupTitle")}</h2>
          <p className={`text-sm ${complete ? "text-emerald-400" : "text-amber-400"}`}>
            {complete ? t(locale, "guide.setupDone") : t(locale, "guide.setupProgress", { done, total: steps.length })}
          </p>
        </div>
        <Link href={`/admin/${guildId}/settings`} className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-700 hover:bg-slate-600 px-4 py-2 text-sm font-semibold text-white">
          <Settings className="w-4 h-4" /> {t(locale, "guide.configure")}
        </Link>
      </div>
      {!complete && (
        <ul className="space-y-2">
          {steps.map((step) => (
            <li key={step.key} className="flex items-start gap-2 text-sm">
              {step.done ? <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" /> : <Circle className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" />}
              <span className={step.done ? "text-slate-500 line-through" : "text-slate-300"}>{t(locale, STEP_TEXT[step.key])}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
