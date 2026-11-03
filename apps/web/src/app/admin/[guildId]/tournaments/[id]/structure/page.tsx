import { supabaseAdmin } from "@/lib/supabase-admin";
import { getManagedTournament } from "@/lib/viewer";
import { notFound } from "next/navigation";
import { StructureClient } from "./StructureClient";
import { cookies } from "next/headers";
import { t } from "@/i18n";
import { Locale } from "@/i18n/types";

export const dynamic = 'force-dynamic';

export default async function TournamentStructurePage({
  params,
}: {
  params: Promise<{ guildId: string; id: string }>;
}) {
  const { guildId, id: tournamentId } = await params;
  const cookieStore = await cookies();
  const locale = (cookieStore.get("NEXT_LOCALE")?.value as Locale) || "fr";

  const tournament = await getManagedTournament(guildId, tournamentId);
  if (!tournament) notFound();

  // Fetch existing phases for this tournament
  const { data: phases, error: pErr } = await supabaseAdmin
    .from("phases")
    .select("*")
    .eq("tournament_id", tournamentId)
    .order("created_at", { ascending: true });
  if (pErr) throw new Error(`phases read failed: ${pErr.message}`);

  const currentPhases = phases || [];

  return (
    <div className="p-6 md:p-8 space-y-6 min-h-full">
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">{t(locale, "adminHeaders.structureTitle")}</h1>
        <p className="text-slate-400">
          {t(locale, "adminHeaders.structureSubtitle")}
        </p>
      </header>

      <StructureClient 
        tournamentId={tournamentId} 
        guildId={guildId} 
        initialPhases={currentPhases} 
      />
    </div>
  );
}