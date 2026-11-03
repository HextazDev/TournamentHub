import { supabaseAdmin } from "@/lib/supabase-admin";
import { getManagedTournament } from "@/lib/viewer";
import { notFound } from "next/navigation";
import { PhaseConfigClient } from "./PhaseConfigClient";
import { cookies } from "next/headers";
import { t } from "@/i18n";
import { Locale } from "@/i18n/types";

export const dynamic = 'force-dynamic';

export default async function PhaseConfigPage({
  params
}: {
  params: Promise<{ guildId: string; id: string; phaseId: string }>
}) {
  const { guildId, id: tournamentId, phaseId } = await params;
  const tournament = await getManagedTournament(guildId, tournamentId);
  if (!tournament) notFound();
  const cookieStore = await cookies();
  const locale = (cookieStore.get("NEXT_LOCALE")?.value as Locale) || "fr";

  // Retrieve phase data
  const { data: phase, error } = await supabaseAdmin
    .from('phases')
    .select('*')
    .eq('id', phaseId)
    .eq('tournament_id', tournamentId)
    .single();

  if (error || !phase) notFound();

  // For Round-Robin (Groupes) we also need to know the number of teams for size
  const { count: teamsCount } = await supabaseAdmin
    .from('teams')
    .select('*', { count: 'exact', head: true })
    .eq('tournament_id', tournamentId);

  return (
    <div className="space-y-6">
      <header className="mb-6 border-b border-slate-800 pb-4">
        <h1 className="text-2xl font-bold text-white">
          {t(locale, "adminHeaders.configurePhaseTitle", { name: phase.name })}
        </h1>
      </header>

      <PhaseConfigClient 
        phase={phase} 
        tournamentId={tournamentId} 
        guildId={guildId} 
        totalTeams={teamsCount || 0} 
      />
    </div>
  );
}
