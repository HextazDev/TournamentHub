import { notFound } from "next/navigation";
import type { Tournament } from "@hub/shared";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getGuildAdminAccess, getServerProfile } from "@/lib/viewer";
import { managedTournamentIds, panelCapabilities } from "@/lib/accessRules";
import { TournamentsClient } from "./TournamentsClient";

export default async function TournamentsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug: guildId } = await params;
  const [access, profile] = await Promise.all([getGuildAdminAccess(guildId), getServerProfile(guildId)]);
  if (!access.allowed) notFound();

  // SEC-21 / SEC-40 / UX-04 : un TO de tournoi ne lit que ses tournois gérables (casteurs exclus).
  const scope = managedTournamentIds(access.access);
  let tournaments: Tournament[] = [];
  if (profile?.organization_id && (!scope || scope.length > 0)) {
    let query = supabaseAdmin
      .from("tournaments")
      .select("*")
      .eq("organization_id", profile.organization_id);
    if (scope) query = query.in("id", [...scope]);
    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw new Error(`tournaments read failed: ${error.message}`);
    tournaments = (data ?? []) as Tournament[];
  }

  const { canCreate, canDelete } = panelCapabilities(access.access);
  return <TournamentsClient guildId={guildId} tournaments={tournaments} canCreate={canCreate} canDelete={canDelete} />;
}
