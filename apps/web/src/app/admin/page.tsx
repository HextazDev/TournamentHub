import { redirect } from "next/navigation";
import Link from "next/link";
import { ExternalLink, ShieldCheck } from "lucide-react";
import { getViewer, type DiscordGuildSummary } from "@/lib/viewer";
import { loadServerOverview } from "@/lib/servers";
import { buildBotInviteUrl, type ManageState } from "@/lib/accessRules";
import { GuildAvatar } from "@/components/GuildAvatar";
import { t } from "@/i18n";
import { getServerLocale } from "@/i18n/server";
import type { Locale, TranslationKey } from "@/i18n/types";

const STATE_STYLE: Record<ManageState, string> = {
  install: "bg-slate-700/40 text-slate-300",
  setup: "bg-amber-500/10 text-amber-400",
  ready: "bg-emerald-500/10 text-emerald-400",
};
const STATE_LABEL: Record<ManageState, TranslationKey> = {
  install: "adminHub.stateInstall",
  setup: "adminHub.stateSetup",
  ready: "adminHub.stateReady",
};

function PrimaryAction({ guild, state, locale }: { guild: DiscordGuildSummary; state: ManageState; locale: Locale }) {
  const className = "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors w-full sm:w-auto";
  if (state === "install") {
    const clientId = process.env.DISCORD_CLIENT_ID;
    if (!clientId) return null;
    return (
      <a href={buildBotInviteUrl(clientId, guild.id)} target="_blank" rel="noopener noreferrer" className={`${className} bg-indigo-600 hover:bg-indigo-500 text-white`}>
        {t(locale, "adminHub.actionInstall")} <ExternalLink className="w-4 h-4" />
      </a>
    );
  }
  if (state === "setup") {
    return (
      <Link href={`/admin/${guild.id}/settings`} className={`${className} bg-amber-600 hover:bg-amber-500 text-white`}>
        {t(locale, "adminHub.actionSetup")}
      </Link>
    );
  }
  return (
    <Link href={`/admin/${guild.id}`} className={`${className} bg-blue-600 hover:bg-blue-500 text-white`}>
      {t(locale, "adminHub.actionManage")}
    </Link>
  );
}

// Panel organisateur : serveurs gérables (OAuth ou rôle TO), bot installé ou non, avec l'étape à traiter.
export default async function AdminHubPage() {
  const locale = await getServerLocale();
  const viewer = await getViewer();
  if (!viewer.discordId) redirect("/");

  if (viewer.guildsError || !viewer.guilds) {
    return (
      <div className="p-8 text-center text-red-400 font-medium bg-red-950/30 border border-red-900/50 mt-12 rounded-xl max-w-xl mx-4 sm:mx-auto">
        <p>{t(locale, "servers.sessionExpired")}</p>
        <Link href="/admin" className="mt-4 inline-block underline">
          {t(locale, "access.retry")}
        </Link>
      </div>
    );
  }

  const { managedServers } = await loadServerOverview({ ...viewer, discordId: viewer.discordId, guilds: viewer.guilds });

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] bg-[#0a0a0f] p-4 sm:p-8 pt-12 text-slate-200">
      <div className="max-w-[1600px] mx-auto">
        <div className="mb-10">
          <h1 className="text-4xl font-extrabold text-white tracking-tight">{t(locale, "adminHub.title")}</h1>
          <p className="text-slate-400 mt-3 text-lg max-w-2xl">{t(locale, "adminHub.subtitle")}</p>
        </div>

        {managedServers.length === 0 ? (
          <div className="bg-[#151722] p-12 text-center rounded-2xl border border-slate-800/50 max-w-xl mx-auto">
            <ShieldCheck className="w-12 h-12 text-slate-600 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-slate-200">{t(locale, "adminHub.empty")}</h2>
            <p className="text-slate-400 mt-4 leading-relaxed">{t(locale, "adminHub.emptyDesc")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {managedServers.map(({ guild, state }) => (
              <div key={guild.id} className="bg-[#151722] rounded-2xl border border-slate-800/50 p-6 flex flex-col gap-4">
                <div className="flex items-center gap-4 min-w-0">
                  <GuildAvatar id={guild.id} name={guild.name} icon={guild.icon} />
                  <div className="min-w-0">
                    <h3 className="font-bold text-lg text-slate-100 truncate" title={guild.name}>
                      {guild.name}
                    </h3>
                    <span className={`inline-block mt-1 text-xs font-semibold px-2 py-0.5 rounded ${STATE_STYLE[state]}`}>
                      {t(locale, STATE_LABEL[state])}
                    </span>
                  </div>
                </div>
                {state === "install" && <p className="text-xs text-slate-500">{t(locale, "adminHub.installHint")}</p>}
                <div className="mt-auto">
                  <PrimaryAction guild={guild} state={state} locale={locale} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
