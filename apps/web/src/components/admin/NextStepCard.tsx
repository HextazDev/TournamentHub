import Link from "next/link";
import { ArrowRight, CheckCircle2, Compass } from "lucide-react";
import type { TournamentNextStep } from "@/lib/accessRules";
import { t } from "@/i18n";
import type { Locale, TranslationKey } from "@/i18n/types";

const STEP_TEXT: Record<TournamentNextStep, TranslationKey> = {
  serverSetup: "guide.next_serverSetup",
  registrationChannel: "guide.next_registrationChannel",
  structure: "guide.next_structure",
  openRegistrations: "guide.next_openRegistrations",
  checkinDates: "guide.next_checkinDates",
  waitParticipants: "guide.next_waitParticipants",
  placementAndLaunch: "guide.next_placementAndLaunch",
  runMatches: "guide.next_runMatches",
};

function stepHref(step: TournamentNextStep, guildId: string, tournamentId: string): string | null {
  const base = `/admin/${guildId}/tournaments/${tournamentId}`;
  switch (step) {
    case "serverSetup":
      return `/admin/${guildId}/settings`;
    case "registrationChannel":
    case "checkinDates":
      return `${base}/settings`;
    case "structure":
      return `${base}/structure`;
    case "waitParticipants":
      return `${base}/participants`;
    case "placementAndLaunch":
      return `${base}/placement`;
    case "runMatches":
      return `${base}/matches`;
    case "openRegistrations":
      return null; // Le bouton est sur cette page.
  }
}

/** Indique la prochaine action utile à l'organisateur et le mène à l'écran concerné. */
export function NextStepCard({
  guildId,
  tournamentId,
  step,
  locale,
}: {
  guildId: string;
  tournamentId: string;
  step: TournamentNextStep | null;
  locale: Locale;
}) {
  if (!step) {
    return (
      <div className="rounded-xl border border-emerald-800/50 bg-emerald-950/30 p-4 flex items-center gap-3 text-emerald-300">
        <CheckCircle2 className="w-5 h-5 shrink-0" />
        <p className="text-sm">{t(locale, "guide.completed")}</p>
      </div>
    );
  }
  const href = stepHref(step, guildId, tournamentId);
  return (
    <div className="rounded-xl border border-blue-800/50 bg-blue-950/30 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
      <Compass className="w-5 h-5 text-blue-400 shrink-0" />
      <div className="flex-1">
        <p className="text-xs font-semibold uppercase tracking-wider text-blue-400">{t(locale, "guide.nextStepTitle")}</p>
        <p className="text-sm text-slate-200 mt-1">{t(locale, STEP_TEXT[step])}</p>
      </div>
      {href && (
        <Link href={href} className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 px-4 py-2 text-sm font-semibold text-white">
          {t(locale, "guide.go")} <ArrowRight className="w-4 h-4" />
        </Link>
      )}
    </div>
  );
}
