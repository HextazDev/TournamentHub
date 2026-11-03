import { notFound } from "next/navigation";
import { ExternalLink, Users, Settings2, GitMerge } from "lucide-react";
import Link from "next/link";
import { t } from "@/i18n";
import { getServerLocale } from "@/i18n/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getManagedTournament, getServerProfile } from "@/lib/viewer";
import { isServerSetupComplete, tournamentNextStep } from "@/lib/accessRules";
import { NextStepCard } from "@/components/admin/NextStepCard";
import { VisibilityToggle } from "./VisibilityToggle";
import { OpenRegistrationButton } from "./OpenRegistrationButton";
import { TournamentLifecycleManager } from "./TournamentLifecycleManager";

export default async function TournamentDashboard({ params }: { params: Promise<{ guildId: string; id: string }> }) {
  const { guildId, id: tournamentId } = await params;
  const locale = await getServerLocale();

  const tournament = await getManagedTournament(guildId, tournamentId);
  if (!tournament) notFound();

  const [phasesRes, teamsRes, profile] = await Promise.all([
    supabaseAdmin
      .from('phases')
      .select('*, matches(id, status)')
      .eq('tournament_id', tournamentId)
      .order('phase_order', { ascending: true }),
    supabaseAdmin
      .from('teams')
      .select('*', { count: 'exact', head: true })
      .eq('tournament_id', tournamentId),
    getServerProfile(guildId),
  ]);
  if (phasesRes.error) throw new Error(`phases read failed: ${phasesRes.error.message}`);
  if (teamsRes.error) throw new Error(`teams count failed: ${teamsRes.error.message}`);
  const phases = phasesRes.data;
  const participantsCount = teamsRes.count ?? 0;

  const nextStep = tournamentNextStep(
    {
      status: tournament.status,
      is_registration_open: tournament.is_registration_open ?? false,
      checkin_start_at: tournament.checkin_start_at ?? null,
      checkin_end_at: tournament.checkin_end_at ?? null,
      discord_registration_channel_id: tournament.discord_registration_channel_id ?? null,
    },
    { phasesCount: phases?.length ?? 0, teamsCount: participantsCount, serverSetupComplete: isServerSetupComplete(profile) },
  );

  // États Configuration pour Carte 4
  const hasDiscordRoles = !!tournament.discord_captain_role_id || !!tournament.discord_to_role_id;
  const hasDiscordChannels = !!tournament.discord_announcement_channel_id || !!tournament.discord_checkin_channel_id;

  const now = new Date();
  const startDate = tournament.start_at ? new Date(tournament.start_at) : (tournament.start_date ? new Date(tournament.start_date) : null);
  const checkinStart = tournament.checkin_start_at ? new Date(tournament.checkin_start_at) : null;
  const hasStartedOrCheckin = !!((checkinStart && now >= checkinStart) || (startDate && now >= startDate) || tournament.status === 'ACTIVE' || tournament.status === 'COMPLETED' || tournament.status === 'ARCHIVED');

  return (
    <div className="p-6 md:p-8 space-y-6 min-h-full bg-slate-950 text-slate-200">
      <header className="flex flex-col md:flex-row justify-between md:items-center gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">{t(locale, "admin.overviewTitle")}</h1>
          <p className="text-slate-400">{t(locale, "admin.overviewSubtitle")}</p>
        </div>
        <Link 
          href={`/${guildId}/tournaments/${tournamentId}`} 
          target="_blank"
          className="inline-flex items-center gap-2 text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors"
        >
          {t(locale, "nav.publicPage")} <ExternalLink className="w-4 h-4" />
        </Link>
      </header>

      <NextStepCard guildId={guildId} tournamentId={tournamentId} step={nextStep} locale={locale} />

      {/* Tournament Lifecycle Manager */}
      <TournamentLifecycleManager 
        tournamentId={tournamentId} 
        guildId={guildId} 
        status={tournament.status} 
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        {/* Card 1: Statut (Haut Gauche) */}
        <div className="bg-slate-900 rounded-xl p-6 border border-slate-800 shadow-sm flex flex-col justify-between">
          <div className="flex justify-between items-start mb-6">
            <div>
              <div className="flex items-center gap-3 mb-1">
                 <h2 className="text-xl font-bold text-white leading-tight">{tournament.name}</h2>
              </div>
              <p className="text-slate-400 text-sm font-medium">Splatoon 3</p>
            </div>
            {/* Composant Client */}
            <VisibilityToggle tournamentId={tournamentId} guildId={guildId} initialIsPublic={!!tournament.is_public} />
          </div>
          <div className="mt-4 pt-4 border-t border-slate-800 space-y-4">
            <p className="text-xs text-slate-500">
              {tournament.is_public 
                ? t(locale, "admin.publicTournamentNotice")
                : t(locale, "admin.privateTournamentNotice")}
            </p>
            <OpenRegistrationButton
              tournamentId={tournamentId}
              guildId={guildId}
              isRegistrationOpen={!!tournament.is_registration_open}
              hasRegistrationChannel={!!tournament.discord_registration_channel_id}
              hasStartedOrCheckin={hasStartedOrCheckin}
            />
          </div>
        </div>

        {/* Card 2: Participants (Haut Droite) */}
        <div className="bg-slate-900 rounded-xl p-6 border border-slate-800 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <Users className="w-5 h-5 text-slate-400" />
                {t(locale, "publicNav.participants")}
              </h2>
              <Link 
                href={`/admin/${guildId}/tournaments/${tournamentId}/participants`}
                className="text-sm font-medium text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors"
              >
                {t(locale, "admin.manage")}
              </Link>
            </div>
            <p className="text-slate-400 text-sm mb-6 leading-relaxed">
              {t(locale, "admin.manageParticipants")}
            </p>
          </div>
          <div className="bg-slate-950 rounded-lg p-4 border border-slate-800/50 flex justify-between items-center text-sm">
             <span className="text-slate-400">{t(locale, "admin.registeredTeams")}</span>
             <span className="font-bold text-white bg-slate-800 px-3 py-1 rounded-md">{participantsCount}</span>
          </div>
        </div>

        {/* Card 3: Structure (Bas Gauche) */}
        <div className="bg-slate-900 rounded-xl p-6 border border-slate-800 shadow-sm flex flex-col">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <GitMerge className="w-5 h-5 text-slate-400" />
              {t(locale, "admin.structure")}
            </h2>
            <Link 
              href={`/admin/${guildId}/tournaments/${tournamentId}/structure`}
              className="text-sm font-medium text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors"
            >
              {t(locale, "admin.newPhase")}
            </Link>
          </div>
          
          <div className="flex-1 space-y-3">
            {!phases || phases.length === 0 ? (
              <div className="text-center py-8 rounded-lg border border-dashed border-slate-800 bg-slate-950/50">
                <p className="text-sm text-slate-500">{t(locale, "admin.noPhasesConfigured")}</p>
              </div>
            ) : (
              phases.map((phase) => (
                <div key={phase.id} className="flex justify-between items-center p-3 rounded-lg bg-slate-950 border border-slate-800/50">
                  <div>
                    <h3 className="text-sm font-bold text-white mb-0.5">{phase.phase_order}. {phase.name}</h3>
                    <p className="text-xs text-slate-500 font-medium">
                      {phase.format === "ROUND_ROBIN" ? t(locale, "adminStructure.roundRobin") : (phase.format === "SWISS" ? t(locale, "adminStructure.swiss") : (phase.format === "DOUBLE_ELIM" ? t(locale, "adminStructure.doubleElim") : t(locale, "adminStructure.singleElim")))} • {phase.max_groups ? t(locale, "admin.groupsCountSummary", { count: phase.max_groups }) : t(locale, "admin.treeSizeSummary", { size: phase.bracket_size })}
                    </p>
                  </div>
                  <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-slate-800 text-slate-300">
                    {!phase.matches || phase.matches.length === 0 
                      ? t(locale, "tournaments.statusDraft") 
                      : phase.matches.every((m: any) => m.status === 'COMPLETED') 
                        ? t(locale, "tournaments.statusCompleted") 
                        : t(locale, "tournaments.statusActive")}
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="mt-4 pt-4 border-t border-slate-800 text-center">
            <Link href={`/admin/${guildId}/tournaments/${tournamentId}/structure`} className="text-sm text-blue-400 hover:text-blue-300 font-medium transition-colors">
              {t(locale, "admin.manageBracket")}
            </Link>
          </div>
        </div>

        {/* Card 4: Paramètres (Bas Droite) */}
        <div className="bg-slate-900 rounded-xl p-6 border border-slate-800 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2 mb-4">
              <Settings2 className="w-5 h-5 text-slate-400" />
              <h2 className="text-lg font-semibold text-white flex-1">{t(locale, "admin.vitalSettings")}</h2>
            </div>
            <p className="text-slate-400 text-sm mb-6 leading-relaxed">
              {t(locale, "admin.vitalSettingsDesc")}
            </p>
            
            <ul className="space-y-3 mb-6">
              <li className="flex justify-between items-center text-sm p-3 rounded-lg bg-slate-950 border border-slate-800/50">
                <span className="text-slate-400">{t(locale, "admin.channelsLinked")}</span>
                {hasDiscordChannels ? <span className="text-emerald-400 font-medium">{t(locale, "admin.linked")}</span> : <span className="text-orange-400 font-medium">{t(locale, "admin.missing")}</span>}
              </li>
              <li className="flex justify-between items-center text-sm p-3 rounded-lg bg-slate-950 border border-slate-800/50">
                <span className="text-slate-400">{t(locale, "admin.rolesLinked")}</span>
                {hasDiscordRoles ? <span className="text-emerald-400 font-medium">{t(locale, "admin.active")}</span> : <span className="text-orange-400 font-medium">{t(locale, "admin.missing")}</span>}
              </li>
            </ul>
          </div>
          
          <Link href={`/admin/${guildId}/tournaments/${tournamentId}/settings`} className="block w-full">
            <button className="w-full bg-slate-800 hover:bg-slate-700 text-white font-semibold py-2.5 px-4 rounded-lg transition-colors flex items-center justify-center gap-2 border border-slate-700">
              <Settings2 className="w-4 h-4" />
              {t(locale, "admin.continueConfig")}
            </button>
          </Link>
        </div>

      </div>
    </div>
  );
}