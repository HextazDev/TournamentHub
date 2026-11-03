import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { ServerSidebarWrapper } from "@/components/ServerSidebarWrapper";
import { AdminSidebarNav } from "@/components/AdminSidebarNav";
import { getGuildAdminAccess } from "@/lib/viewer";
import { buildBotInviteUrl } from "@/lib/accessRules";
import { t } from "@/i18n";
import { getServerLocale } from "@/i18n/server";

export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  // SEC-11 : même règle que le bouton « Panel » du hub et que requireGuildAdmin côté bot.
  const access = await getGuildAdminAccess(guildId);

  if (!access.allowed) {
    const locale = await getServerLocale();
    const clientId = process.env.DISCORD_CLIENT_ID;
    return (
      <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-4 bg-slate-900">
        <div className="max-w-lg w-full bg-slate-800 border border-slate-700 rounded-2xl p-8 text-center space-y-4">
          <ShieldAlert className="w-12 h-12 text-amber-400 mx-auto" />
          <h1 className="text-2xl font-bold text-white">{t(locale, "access.deniedTitle")}</h1>
          <p className="text-slate-300">{t(locale, `access.${access.reason}`)}</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
            {access.reason === "CHECK_FAILED" && (
              <Link href={`/admin/${guildId}`} className="rounded-lg bg-blue-600 hover:bg-blue-500 px-4 py-2 font-semibold text-white">
                {t(locale, "access.retry")}
              </Link>
            )}
            {access.reason === "BOT_NOT_IN_GUILD" && clientId && (
              <a href={buildBotInviteUrl(clientId, guildId)} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 font-semibold text-white">
                {t(locale, "access.installBot")}
              </a>
            )}
            {access.reason === "NOT_LOGGED_IN" ? (
              <Link href="/" className="rounded-lg bg-blue-600 hover:bg-blue-500 px-4 py-2 font-semibold text-white">
                {t(locale, "access.login")}
              </Link>
            ) : (
              <Link href={`/${guildId}`} className="rounded-lg bg-slate-700 hover:bg-slate-600 px-4 py-2 font-semibold text-white">
                {t(locale, "access.backToServer")}
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row min-h-[calc(100vh-4rem)] bg-slate-900 text-white relative">
      <ServerSidebarWrapper>
        <AdminSidebarNav guildId={guildId} />
      </ServerSidebarWrapper>

      <main className="flex-1 overflow-y-auto flex flex-col">
        {children}
      </main>
    </div>
  );
}
