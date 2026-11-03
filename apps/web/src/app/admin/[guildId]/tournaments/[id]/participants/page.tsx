import { supabaseAdmin } from "@/lib/supabase-admin";
import { getManagedTournament } from "@/lib/viewer";
import { notFound } from "next/navigation";
import { ParticipantsClient } from "./ParticipantsClient";
import { cookies } from "next/headers";
import { t } from "@/i18n";
import { Locale } from "@/i18n/types";

export default async function ParticipantsPage({
  params
}: {
  params: Promise<{ guildId: string; id: string }>;
}) {
  const { guildId, id: tournamentId } = await params;
  const cookieStore = await cookies();
  const locale = (cookieStore.get("NEXT_LOCALE")?.value as Locale) || "fr";

  const tournament = await getManagedTournament(guildId, tournamentId);
  if (!tournament) notFound();

  // Fetch teams
  const { data: teams, error: teamsError } = await supabaseAdmin
    .from("teams")
    .select("*, team_members(*)")
    .eq("tournament_id", tournamentId)
    .order("created_at", { ascending: true });

  if (teamsError) {
    console.error("Teams error", teamsError);
  }

  return (
    <div className="p-6 md:p-8 space-y-6 min-h-full">
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">{t(locale, "adminHeaders.participantsTitle")}</h1>
        <p className="text-slate-400">{t(locale, "adminHeaders.participantsSubtitle")}</p>
      </div>

      <ParticipantsClient 
        tournamentId={tournamentId} 
        guildId={guildId} 
        initialTeams={teams || []} 
      />
    </div>
  );
}