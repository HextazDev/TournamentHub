import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getGuildAdminAccess, getServerProfile } from "@/lib/viewer";
import { managedTournamentIds, panelCapabilities } from "@/lib/accessRules";
import { calculateDashboardStats, type DashboardTournament } from "@/lib/adminDashboard";
import { DashboardKpis } from "@/components/admin/DashboardKpis";
import { ActiveTournamentsList, type ActiveTournamentWithDetails } from "@/components/admin/ActiveTournamentsList";
import { DiscordHealthWidget } from "@/components/admin/DiscordHealthWidget";
import { QuickActionsBar } from "@/components/admin/QuickActionsBar";
import { t } from "@/i18n";
import { getServerLocale } from "@/i18n/server";

export default async function AdminDashboard({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  // Le layout bloque déjà l'accès ; la page ne lit des données service_role qu'après la même vérification.
  const access = await getGuildAdminAccess(guildId);
  if (!access.allowed) notFound();
  const locale = await getServerLocale();

  const { canCreate, canConfigureServer } = panelCapabilities(access.access);

  // SEC-21 : un TO de tournoi ne compte que ses tournois et ne voit pas la configuration du serveur.
  const scope = managedTournamentIds(access.access);

  const settings = await getServerProfile(guildId);

  // 1. Requête des tournois du serveur / organisation (filtrés par scope si portée restreinte)
  let tournamentsQuery = supabaseAdmin
    .from("tournaments")
    .select(
      "id, name, status, created_at, start_at, is_registration_open, discord_category_id, phases(id, name, phase_order, format, bracket_size)",
    )
    .order("created_at", { ascending: false });

  if (settings?.organization_id) {
    tournamentsQuery = tournamentsQuery.or(`organization_id.eq.${settings.organization_id},guild_id.eq.${guildId}`);
  } else {
    tournamentsQuery = tournamentsQuery.eq("guild_id", guildId);
  }

  if (scope) {
    tournamentsQuery = tournamentsQuery.in("id", [...scope]);
  }

  const tournamentsRes = await tournamentsQuery;

  if (tournamentsRes.error) {
    throw new Error(`tournaments query failed: ${tournamentsRes.error.message}`);
  }

  const allTournaments = (tournamentsRes.data ?? []) as DashboardTournament[];
  const allTournamentIds = allTournaments.map((t) => t.id);

  // Tournois actifs : ACTIVE et REGISTRATION conformément à l'issue #38
  const activeTournaments = allTournaments.filter(
    (t) => t.status === "ACTIVE" || t.status === "REGISTRATION",
  );

  // 2. Requêtes d'agrégation d'équipes, de joueurs et de matchs en parallèle
  let totalTeams = 0;
  let totalPlayers = 0;
  let pendingMatchesCount = 0;
  let activeTournamentsWithDetails: ActiveTournamentWithDetails[] = activeTournaments;

  if (allTournamentIds.length > 0) {
    // Phases de tous les tournois (pour identifier tous les matchs du serveur)
    const allPhases = allTournaments.flatMap((t) => t.phases ?? []);
    const allPhaseIds = allPhases.map((p) => p.id);

    // Phases des tournois en cours (pour la progression)
    const activePhases = activeTournaments.flatMap((t) => t.phases ?? []);
    const activePhaseIds = activePhases.map((p) => p.id);

    const [teamsRes, activeMatchesRes, pendingMatchesRes] = await Promise.all([
      // Équipes et joueurs inscrits
      supabaseAdmin
        .from("teams")
        .select("id, tournament_id, team_members(id)")
        .in("tournament_id", allTournamentIds),
      // Matchs des tournois actifs pour la progression
      activePhaseIds.length > 0
        ? supabaseAdmin
            .from("matches")
            .select("id, phase_id, status")
            .in("phase_id", activePhaseIds)
        : Promise.resolve({ data: [], error: null }),
      // Matchs en attente de saisie de score (status = 'PENDING')
      allPhaseIds.length > 0
        ? supabaseAdmin
            .from("matches")
            .select("id", { count: "exact", head: true })
            .eq("status", "PENDING")
            .in("phase_id", allPhaseIds)
        : Promise.resolve({ count: 0, error: null }),
    ]);

    if (teamsRes.error) {
      throw new Error(`teams query failed: ${teamsRes.error.message}`);
    }

    const teams = teamsRes.data ?? [];
    totalTeams = teams.length;
    totalPlayers = teams.reduce((acc, team) => acc + (team.team_members?.length ?? 0), 0);
    pendingMatchesCount = pendingMatchesRes.count ?? 0;

    const activeMatches = (activeMatchesRes.data ?? []) as {
      id: string;
      phase_id: string;
      status: string;
    }[];

    // Associer les équipes et les matchs aux tournois actifs
    activeTournamentsWithDetails = activeTournaments.map((t) => {
      const tournamentPhaseIds = new Set((t.phases ?? []).map((p) => p.id));
      const tournamentMatches = activeMatches.filter((m) => tournamentPhaseIds.has(m.phase_id));
      const tournamentTeamsCount = teams.filter((tm) => tm.tournament_id === t.id).length;

      return {
        ...t,
        teamsCount: tournamentTeamsCount,
        matches: tournamentMatches,
      };
    });
  }

  const stats = calculateDashboardStats({
    tournaments: allTournaments,
    totalTeams,
    totalPlayers,
    pendingMatchesCount,
  });

  const clientId = process.env.DISCORD_CLIENT_ID;

  return (
    <div className="p-6 md:p-8 w-full max-w-[1600px] mx-auto space-y-8">
      {/* En-tête principal */}
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">{t(locale, "admin.dashboardTitle")}</h1>
        <p className="text-slate-400">{t(locale, "admin.dashboardSubtitle")}</p>
      </div>

      {/* Raccourcis d'actions rapides */}
      <QuickActionsBar
        guildId={guildId}
        locale={locale}
        canCreate={canCreate}
        canConfigureServer={canConfigureServer}
      />

      {/* Widget de Santé Discord (uniquement niveau SERVER et si Discord est activé, SEC-21) */}
      {access.access.level === "SERVER" && Boolean(settings?.discord_enabled) && (
        <DiscordHealthWidget
          guildId={guildId}
          settings={settings}
          locale={locale}
          clientId={clientId}
          canConfigureServer={canConfigureServer}
        />
      )}

      {/* KPIs Opérationnels */}
      <DashboardKpis stats={stats} locale={locale} />

      {/* Section Tournois en cours */}
      <ActiveTournamentsList
        guildId={guildId}
        tournaments={activeTournamentsWithDetails}
        locale={locale}
        canCreate={canCreate}
      />
    </div>
  );
}
