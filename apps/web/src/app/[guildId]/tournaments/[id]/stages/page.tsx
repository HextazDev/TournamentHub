export const dynamic = 'force-dynamic';

import { supabaseAdmin } from "@/lib/supabase-admin";
import { getReadableTournament } from "@/lib/viewer";
import { notFound } from "next/navigation";
import { StagesClientView } from "./StagesClientView";
import { t } from "@/i18n";
import { getServerLocale } from "@/i18n/server";

export default async function PublicStagesPage({
  params,
}: {
  params: Promise<{ guildId: string; id: string }>;
}) {
  const { guildId, id } = await params;
  const tournament = await getReadableTournament(guildId, id);
  if (!tournament) notFound();
  const locale = await getServerLocale();

  // Parallel fetching for phases and teams
  const [
    { data: phases },
    { data: teams }
  ] = await Promise.all([
    supabaseAdmin.from("phases").select("*").eq("tournament_id", id).order("phase_order", { ascending: true }),
    supabaseAdmin.from("teams").select("*").eq("tournament_id", id).eq("is_checked_in", true)
  ]);

  let matches: any[] = [];
  let phaseTeams: any[] = [];
  if (phases && phases.length > 0) {
    const phaseIds = phases.map(p => p.id);
    const { data } = await supabaseAdmin
      .from("matches")
      .select("*, team1:team1_id(*), team2:team2_id(*)")
      .in("phase_id", phaseIds)
      .order("round_number", { ascending: true });
    if (data) matches = data;

    const { data: ptData } = await supabaseAdmin
      .from("phase_teams")
      .select("*, teams(id, name)")
      .in("phase_id", phaseIds);
    if (ptData) phaseTeams = ptData;
  }

  if (!phases || phases.length === 0) {
    return (
      <div className="py-12 bg-[#151722] rounded-xl border border-slate-800/50 flex flex-col items-center justify-center text-slate-500">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-12 h-12 mb-4 opacity-50"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
        <p>{t(locale, "stages.notPublished")}</p>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in duration-300">
      <StagesClientView 
        phases={phases} 
        matches={matches || []} 
        teams={teams || []}
        phaseTeams={phaseTeams || []}
      />
    </div>
  );
}
