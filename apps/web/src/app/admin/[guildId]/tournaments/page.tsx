import { notFound } from "next/navigation";
import type { Tournament } from "@hub/shared";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getGuildAdminAccess, getServerProfile } from "@/lib/viewer";
import { managedTournamentIds, panelCapabilities } from "@/lib/accessRules";
import { TournamentsClient } from "./TournamentsClient";

export default async function TournamentsPage({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  const [access, profile] = await Promise.all([getGuildAdminAccess(guildId), getServerProfile(guildId)]);
  if (!access.allowed) notFound();

  // SEC-21 : un TO de tournoi ne lit que ses tournois.
  const scope = managedTournamentIds(access.access);
  let query = supabaseAdmin.from("tournaments").select("*");
  if (profile?.organization_id) {
    query = query.or(`organization_id.eq.${profile.organization_id},guild_id.eq.${guildId}`);
  } else {
    query = query.eq("guild_id", guildId);
  }
  if (scope) query = query.in("id", [...scope]);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw new Error(`tournaments read failed: ${error.message}`);

  const { canCreate, canDelete } = panelCapabilities(access.access);
  return <TournamentsClient guildId={guildId} tournaments={(data ?? []) as Tournament[]} canCreate={canCreate} canDelete={canDelete} />;
}
