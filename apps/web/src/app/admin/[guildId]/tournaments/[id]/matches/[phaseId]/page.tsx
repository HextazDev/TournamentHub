export const dynamic = 'force-dynamic';
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getManagedTournament } from "@/lib/viewer";
import { notFound } from "next/navigation";
import { PhaseMatchesClient } from "./PhaseMatchesClient";

export default async function PhaseMatchesPage({
  params
}: {
  params: Promise<{ guildId: string; id: string; phaseId: string }>;
}) {
  const { guildId, id: tournamentId, phaseId } = await params;
  const tournament = await getManagedTournament(guildId, tournamentId);
  if (!tournament) notFound();

  // 1. Fetch phase
  const { data: phase, error: phaseError } = await supabaseAdmin
    .from("phases")
    .select("*")
    .eq("id", phaseId)
    .eq("tournament_id", tournamentId)
    .single();

  if (phaseError || !phase) {
    return notFound();
  }

  // 2. Fetch matches for that phase
  const { data: matches, error: matchesError } = await supabaseAdmin
    .from("matches")
    .select("*, team1:teams!team1_id(name), team2:teams!team2_id(name)")
    .eq("phase_id", phase.id)
    .order("round_number", { ascending: true })
    .order("match_number", { ascending: true });

  if (matchesError) {
    console.error("Matches Error", matchesError);
  }

  // 3. Fetch phase_teams
  const { data: ptData, error: ptError } = await supabaseAdmin
    .from("phase_teams")
    .select("*, teams(id, name)")
    .eq("phase_id", phase.id);

  if (ptError) {
    console.error("fetch phase_teams error", ptError);
  }

  // 4. Fetch groups
  const { data: groupsData, error: groupsError } = await supabaseAdmin
    .from("groups")
    .select("*")
    .eq("phase_id", phase.id)
    .order("name", { ascending: true });

  if (groupsError) {
    console.error("fetch groups error", groupsError);
  }

  return (
    <PhaseMatchesClient 
      tournamentId={tournamentId} 
      guildId={guildId} 
      phase={phase} 
      initialMatches={matches || []}
      phaseTeams={ptData || []}
      dbGroups={groupsData || []}
    />
  );
}
