import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { canPerform } from "@hub/shared";
import { getGuildAdminAccess } from "@/lib/viewer";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const guildId = new URL(request.url).searchParams.get("guildId");
  if (!guildId || !id) {
    return NextResponse.json({ error: "Requête invalide" }, { status: 400 });
  }

  // SEC-11 / SEC-15 : même décision que le panel (propriétaire, Administrateur, Gérer le serveur ou rôle TO du serveur).
  const access = await getGuildAdminAccess(guildId);
  if (!access.allowed) {
    const status = access.reason === "NOT_LOGGED_IN" ? 401 : access.reason === "CHECK_FAILED" ? 503 : 403;
    return NextResponse.json({ error: access.reason }, { status });
  }
  if (!canPerform(access.access, "DELETE_TOURNAMENT", id)) {
    return NextResponse.json({ error: "NO_RIGHTS" }, { status: 403 });
  }

  // SEC-01 : le filtre guild_id empêche de supprimer le tournoi d'un autre serveur.
  const { data, error } = await supabaseAdmin
    .from("tournaments")
    .delete()
    .eq("id", id)
    .eq("guild_id", guildId)
    .select("id");

  if (error) {
    console.error("[DELETE tournament]", error);
    return NextResponse.json({ error: "Impossible de supprimer le tournoi en base de données" }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Tournoi introuvable" }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
