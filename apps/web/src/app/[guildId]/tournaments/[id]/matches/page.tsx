import { supabaseAdmin } from "@/lib/supabase-admin";
import { getReadableTournament } from "@/lib/viewer";
import { notFound } from "next/navigation";
import { RealtimeMatchesList } from "@/components/RealtimeMatchesList";
import { cookies } from "next/headers";
import { t } from "@/i18n";
import { Locale } from "@/i18n/types";

export default async function PublicMatchesPage({
  params,
}: {
  params: Promise<{ guildId: string; id: string }>;
}) {
  const { guildId, id } = await params;
  const tournament = await getReadableTournament(guildId, id);
  if (!tournament) notFound();
  const cookieStore = await cookies();
  const locale = (cookieStore.get("NEXT_LOCALE")?.value as Locale) || "fr";

  // Get phase IDs via tournament
  const { data: phases } = await supabaseAdmin.from("phases").select("id").eq("tournament_id", id);
  
  let matches: any[] = [];
  if (phases && phases.length > 0) {
    const phaseIds = phases.map(p => p.id);
    const { data } = await supabaseAdmin
      .from("matches")
      .select("*, team1:team1_id(*), team2:team2_id(*), phase:phase_id(name, phase_order)")
      .in("phase_id", phaseIds);
    if (data) matches = data;
  }

  if (!matches || matches.length === 0) {
    return (
      <div className="py-12 bg-[#151722] rounded-xl border border-slate-800/50 flex flex-col items-center justify-center text-slate-500 animate-in fade-in duration-300">
        <p>{t(locale, "matches.noMatchesAvailable")}</p>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in duration-300">
      <RealtimeMatchesList initialMatches={matches} tournamentId={id} />
    </div>
  );
}