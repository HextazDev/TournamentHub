import { notFound } from "next/navigation";
import type { Tournament } from "@hub/shared";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getGuildAdminAccess } from "@/lib/viewer";
import { TournamentsClient } from "./TournamentsClient";

export default async function TournamentsPage({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  if (!(await getGuildAdminAccess(guildId)).allowed) notFound();

  const { data, error } = await supabaseAdmin
    .from("tournaments")
    .select("*")
    .eq("guild_id", guildId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`tournaments read failed: ${error.message}`);

  return <TournamentsClient guildId={guildId} tournaments={(data ?? []) as Tournament[]} />;
}
