import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getManagedTournament } from "@/lib/viewer";
import MatchesTabs from "./MatchesTabs";
import { cookies } from "next/headers";
import { t } from "@/i18n";
import { Locale } from "@/i18n/types";

export default async function MatchesLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ guildId: string; id: string }>;
}) {
  const { guildId, id: tournamentId } = await params;
  const tournament = await getManagedTournament(guildId, tournamentId);
  if (!tournament) notFound();
  const cookieStore = await cookies();
  const locale = (cookieStore.get("NEXT_LOCALE")?.value as Locale) || "fr";

  // Fetch all phases for this tournament to generate the tabs
  const { data: phases } = await supabaseAdmin
    .from("phases")
    .select("*")
    .eq("tournament_id", tournamentId)
    .order("phase_order", { ascending: true });

  return (
    <div className="p-6 md:p-8 space-y-6 min-h-[calc(100vh-2rem)] flex flex-col">
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">{t(locale, "adminHeaders.matchesTitle")}</h1>
        <p className="text-slate-400">{t(locale, "adminHeaders.matchesSubtitle")}</p>
      </div>

      <MatchesTabs guildId={guildId} tournamentId={tournamentId} phases={phases || []} />

      <div className="pt-4">
        {children}
      </div>
    </div>
  );
}
