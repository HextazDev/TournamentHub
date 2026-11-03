import { Trophy } from "lucide-react";
import type { ServerSettings, Tournament } from "@hub/shared";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getViewer, memberGuildIds } from "@/lib/viewer";
import { TournamentCard } from "@/components/TournamentCard";
import { t } from "@/i18n";
import { getServerLocale } from "@/i18n/server";
import type { Locale } from "@/i18n/types";

async function loadTournaments(guildIds: string[]) {
  const visible = supabaseAdmin
    .from("tournaments")
    .select("*")
    .neq("status", "ARCHIVED")
    .order("created_at", { ascending: false })
    .limit(60);

  const [publicRes, privateRes] = await Promise.all([
    visible.eq("is_public", true),
    guildIds.length > 0
      ? supabaseAdmin
          .from("tournaments")
          .select("*")
          .in("guild_id", guildIds)
          .eq("is_public", false)
          .neq("status", "ARCHIVED")
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (publicRes.error) throw new Error(`public tournaments read failed: ${publicRes.error.message}`);
  if (privateRes.error) throw new Error(`private tournaments read failed: ${privateRes.error.message}`);
  return { publicList: (publicRes.data ?? []) as Tournament[], privateList: (privateRes.data ?? []) as Tournament[] };
}

async function loadProfiles(tournaments: Tournament[]): Promise<Map<string, ServerSettings>> {
  const ids = [...new Set(tournaments.map((t) => t.guild_id))];
  if (ids.length === 0) return new Map();
  const { data, error } = await supabaseAdmin.from("server_settings").select("*").in("guild_id", ids);
  if (error) throw new Error(`server profiles read failed: ${error.message}`);
  return new Map(((data ?? []) as ServerSettings[]).map((p) => [p.guild_id, p]));
}

function Grid({ list, profiles, locale }: { list: Tournament[]; profiles: Map<string, ServerSettings>; locale: Locale }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {list.map((tourn) => (
        <TournamentCard key={tourn.id} tournament={tourn} profile={profiles.get(tourn.guild_id) ?? null} locale={locale} showOrganizer />
      ))}
    </div>
  );
}

export default async function DiscoverTournamentsPage() {
  const locale = await getServerLocale();
  const viewer = await getViewer();
  const { publicList, privateList } = await loadTournaments([...memberGuildIds(viewer)]);
  const profiles = await loadProfiles([...publicList, ...privateList]);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#0f111a] text-slate-200 p-4 sm:p-8">
      <div className="max-w-[1600px] w-full mx-auto space-y-10">
        <header>
          <h1 className="text-4xl font-extrabold text-white tracking-tight">{t(locale, "discover.title")}</h1>
          <p className="text-slate-400 mt-3 text-lg max-w-2xl">{t(locale, "discover.subtitle")}</p>
          {!viewer.discordId && <p className="text-slate-500 mt-2 text-sm">{t(locale, "discover.loginHint")}</p>}
          {viewer.guildsError && (
            <p className="mt-4 rounded-lg border border-amber-700/50 bg-amber-900/20 px-4 py-3 text-sm text-amber-400">
              {t(locale, "discover.guildsUnavailable")}
            </p>
          )}
        </header>

        {viewer.discordId && privateList.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-xl font-bold text-white">{t(locale, "discover.privateSection")}</h2>
            <Grid list={privateList} profiles={profiles} locale={locale} />
          </section>
        )}

        <section className="space-y-4">
          <h2 className="text-xl font-bold text-white">{t(locale, "discover.publicSection")}</h2>
          {publicList.length === 0 ? (
            <div className="bg-[#151722] p-12 text-center rounded-2xl border border-slate-800/50 max-w-xl mx-auto">
              <Trophy className="w-12 h-12 text-slate-600 mx-auto mb-4" />
              <p className="text-slate-200 font-semibold">{t(locale, "discover.empty")}</p>
              <p className="text-slate-500 mt-2 text-sm">{t(locale, "discover.emptyDesc")}</p>
            </div>
          ) : (
            <Grid list={publicList} profiles={profiles} locale={locale} />
          )}
        </section>
      </div>
    </div>
  );
}
