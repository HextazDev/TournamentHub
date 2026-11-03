import { redirect } from "next/navigation";
import Link from "next/link";
import { Server } from "lucide-react";
import { getViewer } from "@/lib/viewer";
import { loadServerOverview } from "@/lib/servers";
import { GuildAvatar } from "@/components/GuildAvatar";
import { t } from "@/i18n";
import { getServerLocale } from "@/i18n/server";

// « Mes serveurs » : serveurs dont le visiteur est membre et où le bot est installé, quels que soient ses droits.
export default async function ServersPage() {
  const locale = await getServerLocale();
  const viewer = await getViewer();
  if (!viewer.discordId) redirect("/");

  if (viewer.guildsError || !viewer.guilds) {
    return (
      <div className="p-8 text-center text-red-400 font-medium bg-red-950/30 border border-red-900/50 mt-12 rounded-xl max-w-xl mx-4 sm:mx-auto">
        <p>{t(locale, "servers.sessionExpired")}</p>
        <Link href="/servers" className="mt-4 inline-block underline">
          {t(locale, "access.retry")}
        </Link>
      </div>
    );
  }

  const { memberServers, managedServers } = await loadServerOverview({ ...viewer, discordId: viewer.discordId, guilds: viewer.guilds });
  const managed = new Set(managedServers.map((s) => s.guild.id));

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] bg-[#0a0a0f] p-4 sm:p-8 pt-12 text-slate-200">
      <div className="max-w-[1600px] mx-auto">
        <div className="mb-10">
          <h1 className="text-4xl font-extrabold text-white tracking-tight">{t(locale, "servers.title")}</h1>
          <p className="text-slate-400 mt-3 text-lg max-w-2xl">{t(locale, "servers.subtitle")}</p>
        </div>

        {memberServers.length === 0 ? (
          <div className="bg-[#151722] p-12 text-center rounded-2xl border border-slate-800/50 max-w-xl mx-auto">
            <Server className="w-12 h-12 text-slate-600 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-slate-200">{t(locale, "servers.noServersFound")}</h2>
            <p className="text-slate-400 mt-4 leading-relaxed">{t(locale, "servers.noServersDesc")}</p>
            <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
              <Link href="/tournaments" className="text-blue-400 hover:text-blue-300 font-semibold">
                {t(locale, "home.browseTournaments")}
              </Link>
              {managedServers.length > 0 && (
                <Link href="/admin" className="text-blue-400 hover:text-blue-300 font-semibold">
                  {t(locale, "nav.organizerPanel")}
                </Link>
              )}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {memberServers.map((guild) => (
              <Link
                key={guild.id}
                href={`/${guild.id}`}
                className="group bg-[#151722] rounded-2xl border border-slate-800/50 p-6 flex items-center gap-4 min-w-0 hover:border-slate-700 transition-colors"
              >
                <GuildAvatar id={guild.id} name={guild.name} icon={guild.icon} />
                <div className="min-w-0">
                  <h3 className="font-bold text-lg text-slate-100 truncate group-hover:text-white" title={guild.name}>
                    {guild.name}
                  </h3>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-blue-400">{t(locale, "servers.actionView")} →</span>
                    {managed.has(guild.id) && (
                      <span className="text-xs font-semibold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
                        {t(locale, "servers.organizerBadge")}
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
