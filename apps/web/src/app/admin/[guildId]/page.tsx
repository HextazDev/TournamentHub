import { notFound } from "next/navigation";
import { Trophy, CheckCircle } from "lucide-react";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getGuildAdminAccess, getServerProfile } from "@/lib/viewer";
import { ServerSetupChecklist } from "@/components/admin/ServerSetupChecklist";
import { t } from "@/i18n";
import { getServerLocale } from "@/i18n/server";

export default async function AdminDashboard({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  // Le layout bloque déjà l'accès ; la page ne lit des données service_role qu'après la même vérification.
  if (!(await getGuildAdminAccess(guildId)).allowed) notFound();
  const locale = await getServerLocale();

  const [totalRes, activeRes, settings] = await Promise.all([
    supabaseAdmin.from("tournaments").select("id", { count: "exact", head: true }).eq("guild_id", guildId),
    supabaseAdmin.from("tournaments").select("id", { count: "exact", head: true }).eq("guild_id", guildId).eq("status", "ACTIVE"),
    getServerProfile(guildId),
  ]);
  if (totalRes.error) throw new Error(`tournaments count failed: ${totalRes.error.message}`);
  if (activeRes.error) throw new Error(`active tournaments count failed: ${activeRes.error.message}`);

  return (
    <div className="p-6 md:p-8 w-full max-w-[1600px] mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">{t(locale, "admin.dashboardTitle")}</h1>
        <p className="text-slate-400">{t(locale, "admin.dashboardSubtitle")}</p>
      </div>

      <ServerSetupChecklist guildId={guildId} settings={settings} locale={locale} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-md flex items-center justify-between">
          <div>
            <p className="text-slate-400 text-sm mb-1 uppercase tracking-wider">{t(locale, "admin.totalTournaments")}</p>
            <p className="text-3xl font-extrabold text-white">{totalRes.count ?? 0}</p>
          </div>
          <div className="p-3 bg-blue-500/10 rounded-xl">
            <Trophy className="w-8 h-8 text-blue-400" />
          </div>
        </div>

        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-md flex items-center justify-between">
          <div>
            <p className="text-slate-400 text-sm mb-1 uppercase tracking-wider">{t(locale, "admin.inProgress")}</p>
            <p className="text-3xl font-extrabold text-green-400">{activeRes.count ?? 0}</p>
          </div>
          <div className="p-3 bg-green-500/10 rounded-xl">
            <CheckCircle className="w-8 h-8 text-green-400" />
          </div>
        </div>
      </div>
    </div>
  );
}
