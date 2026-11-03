export const dynamic = 'force-dynamic';

import { supabaseAdmin } from "@/lib/supabase-admin";
import { getReadableTournament } from "@/lib/viewer";
import { notFound } from "next/navigation";
import { ParticipantsClientView } from "./ParticipantsClientView";
import { t } from "@/i18n";
import { getServerLocale } from "@/i18n/server";

export default async function PublicParticipantsPage({
  params,
}: {
  params: Promise<{ guildId: string; id: string }>;
}) {
  const { guildId, id } = await params;
  const tournament = await getReadableTournament(guildId, id);
  if (!tournament) notFound();
  const locale = await getServerLocale();

  // Fetch all checked-in teams for the tournament
  const { data: teams } = await supabaseAdmin
    .from("teams")
    .select("*")
    .eq("tournament_id", id)
    .eq("is_checked_in", true)
    .order("created_at", { ascending: true });

  if (!teams || teams.length === 0) {
    return (
      <div className="py-12 bg-[#151722] rounded-xl border border-slate-800/50 flex flex-col items-center justify-center text-slate-500 animate-in fade-in duration-300">
        <p>{t(locale, "participants.noneValidated")}</p>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in duration-300">
      <ParticipantsClientView teams={teams} />
    </div>
  );
}
