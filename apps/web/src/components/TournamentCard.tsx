import Link from "next/link";
import { Calendar, Lock } from "lucide-react";
import type { ServerSettings, Tournament } from "@hub/shared";
import { OrganizerCard } from "@/components/OrganizerCard";
import { t } from "@/i18n";
import type { Locale } from "@/i18n/types";
import type { TranslationKey } from "@/i18n/types";

const STATUS_KEYS: Record<Tournament["status"], TranslationKey> = {
  DRAFT: "tournaments.statusDraft",
  REGISTRATION: "tournaments.statusRegistrationOpen",
  ACTIVE: "tournaments.statusActive",
  COMPLETED: "tournaments.statusCompleted",
  ARCHIVED: "tournaments.statusArchived",
};

export function TournamentCard({
  tournament,
  profile,
  locale,
  showOrganizer,
}: {
  tournament: Tournament;
  profile: ServerSettings | null;
  locale: Locale;
  showOrganizer: boolean;
}) {
  const date = tournament.start_at ?? tournament.checkin_start_at;

  return (
    <div className="bg-[#151722] border border-slate-800/50 p-6 rounded-xl hover:border-slate-700 transition-colors h-full flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs font-semibold">
        <span className="px-2 py-1 rounded bg-slate-800 text-slate-300">{t(locale, STATUS_KEYS[tournament.status])}</span>
        {!tournament.is_public && (
          <span className="px-2 py-1 rounded bg-amber-500/10 text-amber-400 flex items-center gap-1">
            <Lock className="w-3 h-3" /> {t(locale, "discover.privateBadge")}
          </span>
        )}
      </div>
      <Link href={`/${tournament.guild_id}/tournaments/${tournament.id}`} className="group">
        <h2 className="text-2xl font-bold text-white group-hover:text-blue-400 transition-colors">{tournament.name}</h2>
      </Link>
      <p className="text-slate-400 flex-grow line-clamp-3">
        {tournament.description || t(locale, "tournaments.noDescription")}
      </p>
      {showOrganizer && <OrganizerCard guildId={tournament.guild_id} profile={profile} locale={locale} compact />}
      <div className="flex items-center text-sm text-slate-500">
        <Calendar className="w-4 h-4 mr-2" />
        {date
          ? new Intl.DateTimeFormat(locale === "en" ? "en-US" : "fr-FR", { dateStyle: "long" }).format(new Date(date))
          : t(locale, "common.dateNotSet")}
      </div>
    </div>
  );
}
