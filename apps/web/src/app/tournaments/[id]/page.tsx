import { notFound, permanentRedirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getReadableTournament } from "@/lib/viewer";

// Ancienne URL sans organisation : redirige vers l'URL canonique, qui applique elle-même le contrôle d'accès (SEC-10).
export default async function LegacyTournamentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data, error } = await supabaseAdmin
    .from("tournaments")
    .select("organization_id, organizations(slug)")
    .eq("id", id)
    .maybeSingle();
  if (error && error.code !== "22P02") throw new Error(`tournament read failed: ${error.message}`);
  const orgRow = data ? (Array.isArray(data.organizations) ? data.organizations[0] : data.organizations) : null;
  const orgSlug = typeof (orgRow as { slug?: unknown } | null)?.slug === "string" ? (orgRow as { slug: string }).slug : null;
  // Ne révèle même pas l'organisation d'un tournoi privé à un non-membre.
  if (!data || !orgSlug || !(await getReadableTournament(orgSlug, id))) notFound();
  permanentRedirect(`/${orgSlug}/tournaments/${id}`);
}
