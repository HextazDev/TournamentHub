import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { TOURNAMENT_INVITE_COOKIE_PREFIX } from "@/lib/accessRules";

const INVITE_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30;

/**
 * Lien de partage d'un tournoi privé (RFC, décision 3). Le jeton validé passe de l'URL à un cookie httpOnly,
 * pour que toutes les pages du tournoi en bénéficient et qu'il ne reste ni dans l'historique ni dans les Referer.
 */
export async function GET(request: NextRequest) {
  const tournamentId = request.nextUrl.searchParams.get("tournament") ?? "";
  const token = request.nextUrl.searchParams.get("invite") ?? "";
  const home = new URL("/", request.url);
  if (!tournamentId || !token) return NextResponse.redirect(home);

  const { data, error } = await supabaseAdmin
    .from("tournament_invite_tokens")
    .select("tournament_id, tournaments!inner(organizations!inner(slug))")
    .eq("tournament_id", tournamentId)
    .eq("token_hash", createHash("sha256").update(token).digest("hex"))
    .maybeSingle();
  if (error && error.code !== "22P02") {
    console.error("[tournament-invite] Lecture du lien impossible:", error.message);
  }
  if (error || !data) return NextResponse.redirect(home);

  const tournament = (Array.isArray(data.tournaments) ? data.tournaments[0] : data.tournaments) as
    | { organizations?: { slug: string } | { slug: string }[] }
    | undefined;
  const organization = Array.isArray(tournament?.organizations) ? tournament?.organizations[0] : tournament?.organizations;
  if (!organization) return NextResponse.redirect(home);

  const response = NextResponse.redirect(new URL(`/${organization.slug}/tournaments/${tournamentId}`, request.url));
  response.cookies.set(`${TOURNAMENT_INVITE_COOKIE_PREFIX}${tournamentId}`, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: INVITE_COOKIE_MAX_AGE_S,
  });
  return response;
}
