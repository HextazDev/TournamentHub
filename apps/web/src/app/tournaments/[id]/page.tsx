import { notFound, permanentRedirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getReadableTournament } from "@/lib/viewer";

// Ancienne URL sans serveur : redirige vers l'URL canonique, qui applique elle-même le contrôle d'accès (SEC-10).
export default async function LegacyTournamentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data, error } = await supabaseAdmin.from("tournaments").select("guild_id").eq("id", id).maybeSingle();
  if (error && error.code !== "22P02") throw new Error(`tournament read failed: ${error.message}`);
  // Ne révèle même pas le serveur d'un tournoi privé à un non-membre.
  if (!data || !(await getReadableTournament(data.guild_id, id))) notFound();
  permanentRedirect(`/${data.guild_id}/tournaments/${id}`);
}
