import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { ServerSettings } from "@hub/shared";
import { t } from "@/i18n";
import type { Locale } from "@/i18n/types";

export function guildIconUrl(guildId: string, icon: string | null): string | null {
  return icon ? `https://cdn.discordapp.com/icons/${guildId}/${icon}.png?size=96` : null;
}

/** Identité du serveur organisateur + invitation configurée par les TO (affichée seulement si renseignée). */
export function OrganizerCard({
  guildId,
  profile,
  locale,
  compact = false,
}: {
  guildId: string;
  profile: ServerSettings | null;
  locale: Locale;
  compact?: boolean;
}) {
  const name = profile?.guild_name || t(locale, "discover.unknownServer");
  const icon = guildIconUrl(guildId, profile?.guild_icon ?? null);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Link href={`/${guildId}`} className="flex items-center gap-2 min-w-0 group">
        {icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={icon} alt="" className={`${compact ? "w-6 h-6" : "w-9 h-9"} rounded-lg bg-slate-800 shrink-0`} />
        ) : (
          <span className={`${compact ? "w-6 h-6 text-[10px]" : "w-9 h-9 text-xs"} rounded-lg bg-slate-800 flex items-center justify-center font-bold text-slate-300 shrink-0`}>
            {name.substring(0, 2).toUpperCase()}
          </span>
        )}
        <span className={`truncate text-slate-300 group-hover:text-white ${compact ? "text-sm" : "font-semibold"}`}>
          {t(locale, "discover.organizedBy", { name })}
        </span>
      </Link>
      {!compact && profile?.invite_url && (
        <a
          href={profile.invite_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 text-sm font-semibold text-white transition-colors"
        >
          {t(locale, "discover.joinDiscord")}
          <ExternalLink className="w-4 h-4" />
        </a>
      )}
    </div>
  );
}
