import Link from "next/link";
import { Settings, Trophy } from "lucide-react";
import type { Tournament } from "@hub/shared";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getGuildAdminAccess, getServerProfile, getViewer, memberGuildIds } from "@/lib/viewer";
import { OrganizerCard } from "@/components/OrganizerCard";
import { TournamentCard } from "@/components/TournamentCard";
import { t } from "@/i18n";
import { getServerLocale } from "@/i18n/server";

export default async function GuildHubPage({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  const locale = await getServerLocale();

  const [viewer, profile, access] = await Promise.all([getViewer(), getServerProfile(guildId), getGuildAdminAccess(guildId)]);
  const isMember = memberGuildIds(viewer).has(guildId);

  // SEC-10 : les tournois privés ne sont lus que pour les membres du serveur.
  let query = supabaseAdmin
    .from("tournaments")
    .select("*")
    .eq("guild_id", guildId)
    .neq("status", "ARCHIVED")
    .order("created_at", { ascending: false });
  if (!isMember) query = query.eq("is_public", true);
  const { data, error } = await query;
  if (error) throw new Error(`tournaments read failed: ${error.message}`);
  const tournaments = (data ?? []) as Tournament[];

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#0f111a] text-slate-200 p-4 sm:p-8">
      <div className="max-w-[1600px] w-full mx-auto space-y-8">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div className="space-y-3">
            <h1 className="text-3xl sm:text-4xl font-extrabold flex items-center gap-4 text-white">
              <Trophy className="w-10 h-10 text-yellow-500 shrink-0" />
              {t(locale, "discover.serverTournaments", { name: profile?.guild_name || t(locale, "discover.unknownServer") })}
            </h1>
            <OrganizerCard guildId={guildId} profile={profile} locale={locale} />
          </div>

          {access.allowed && (
            <Link
              href={`/admin/${guildId}`}
              className="bg-[#151722] hover:bg-[#1a1d2d] transition-colors border border-slate-800/50 text-white px-6 py-3 rounded-lg font-bold flex items-center gap-3 shadow-lg"
            >
              <Settings className="w-5 h-5 text-slate-300" />
              {t(locale, "nav.adminPanel")}
            </Link>
          )}
        </div>

        {tournaments.length === 0 ? (
          <div className="bg-[#151722] p-12 text-center rounded-2xl border border-slate-800/50 max-w-xl mx-auto">
            <Trophy className="w-12 h-12 text-slate-600 mx-auto mb-4" />
            <p className="text-slate-300 font-semibold">
              {t(locale, isMember ? "discover.serverEmptyMember" : "discover.serverEmpty")}
            </p>
            {!viewer.discordId && <p className="text-slate-500 mt-3 text-sm">{t(locale, "discover.loginHint")}</p>}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {tournaments.map((tourn) => (
              <TournamentCard key={tourn.id} tournament={tourn} profile={profile} locale={locale} showOrganizer={false} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
