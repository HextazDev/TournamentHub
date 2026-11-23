import { isFinishedMatchStatus, type ServerSettings } from "@hub/shared";

export interface DashboardPhase {
  id: string;
  name: string;
  phase_order: number;
  format: string;
  bracket_size?: number | null;
}

export interface DashboardTournament {
  id: string;
  name: string;
  status: string;
  is_registration_open?: boolean | null;
  start_at?: string | null;
  created_at: string;
  phases?: DashboardPhase[];
}

export interface DashboardStats {
  totalTournaments: number;
  activeTournamentsCount: number;
  totalTeams: number;
  totalPlayers: number;
  pendingMatchesCount: number;
}

/**
 * Calcule les indicateurs opérationnels du tableau de bord d'administration.
 * Conformément aux spécifications (#38), les tournois au statut ACTIVE et REGISTRATION
 * sont comptabilisés comme tournois en cours/actifs.
 */
export function calculateDashboardStats(params: {
  tournaments: DashboardTournament[];
  totalTeams: number;
  totalPlayers: number;
  pendingMatchesCount: number;
}): DashboardStats {
  const { tournaments, totalTeams, totalPlayers, pendingMatchesCount } = params;

  const activeTournamentsCount = tournaments.filter(
    (t) => t.status === "ACTIVE" || t.status === "REGISTRATION",
  ).length;

  return {
    totalTournaments: tournaments.length,
    activeTournamentsCount,
    totalTeams,
    totalPlayers,
    pendingMatchesCount,
  };
}

export interface PhaseMatchInfo {
  phase_id: string;
  status: string;
}

export interface PhaseProgressionResult {
  totalPhases: number;
  totalMatches: number;
  completedMatches: number;
  progressPercent: number;
  currentPhaseName: string | null;
}

/**
 * Calcule l'avancement d'un tournoi (nombre de matchs terminés sur le total de matchs, pourcentage
 * et identification de la phase active actuelle).
 */
export function computePhaseProgression(
  phases: DashboardPhase[] | undefined | null,
  matches?: PhaseMatchInfo[] | undefined | null,
): PhaseProgressionResult {
  if (!phases || phases.length === 0) {
    return {
      totalPhases: 0,
      totalMatches: 0,
      completedMatches: 0,
      progressPercent: 0,
      currentPhaseName: null,
    };
  }

  const sortedPhases = [...phases].sort((a, b) => a.phase_order - b.phase_order);
  const allMatches = matches ?? [];
  const totalMatches = allMatches.length;

  if (totalMatches === 0) {
    const firstPhase = sortedPhases[0];
    return {
      totalPhases: phases.length,
      totalMatches: 0,
      completedMatches: 0,
      progressPercent: 0,
      currentPhaseName: firstPhase ? firstPhase.name : null,
    };
  }

  const completedMatches = allMatches.filter((m) => isFinishedMatchStatus(m.status)).length;

  const progressPercent = totalMatches > 0 ? Math.round((completedMatches / totalMatches) * 100) : 0;

  // Trouver la phase en cours : première phase ayant des matchs non terminés ou sans match
  let currentPhaseName: string | null = null;
  for (const phase of sortedPhases) {
    const phaseMatches = allMatches.filter((m) => m.phase_id === phase.id);
    const hasUnfinishedMatches = phaseMatches.some((m) => !isFinishedMatchStatus(m.status));
    if (phaseMatches.length === 0 || hasUnfinishedMatches) {
      currentPhaseName = phase.name;
      break;
    }
  }

  // Si toutes les phases ont leurs matchs terminés, la phase affichée est la dernière
  if (!currentPhaseName && sortedPhases.length > 0) {
    const lastPhase = sortedPhases[sortedPhases.length - 1];
    currentPhaseName = lastPhase ? lastPhase.name : null;
  }

  return {
    totalPhases: phases.length,
    totalMatches,
    completedMatches,
    progressPercent,
    currentPhaseName,
  };
}

export type DiscordHealthItemKey =
  | "to_role_id"
  | "captain_role_id"
  | "announcement_channel_id"
  | "checkin_channel_id"
  | "registration_channel_id";

export interface DiscordHealthItem {
  key: DiscordHealthItemKey;
  type: "role" | "channel";
  configured: boolean;
  value: string | null;
}

export interface DiscordHealthResult {
  botPresent: boolean;
  items: DiscordHealthItem[];
  isAllConfigured: boolean;
  configuredCount: number;
  totalItems: number;
}

/**
 * Évalue la santé de la configuration Discord du serveur pour l'organisateur :
 * - Présence du bot (bot_present)
 * - Rôles requis (to_role_id, captain_role_id)
 * - Salons requis (announcement_channel_id, checkin_channel_id, registration_channel_id)
 */
export function checkDiscordHealth(settings: ServerSettings | null | undefined): DiscordHealthResult {
  const botPresent = settings?.bot_present !== false && !!settings;

  const items: DiscordHealthItem[] = [
    {
      key: "to_role_id",
      type: "role",
      configured: !!settings?.to_role_id,
      value: settings?.to_role_id ?? null,
    },
    {
      key: "captain_role_id",
      type: "role",
      configured: !!settings?.captain_role_id,
      value: settings?.captain_role_id ?? null,
    },
    {
      key: "announcement_channel_id",
      type: "channel",
      configured: !!settings?.announcement_channel_id,
      value: settings?.announcement_channel_id ?? null,
    },
    {
      key: "checkin_channel_id",
      type: "channel",
      configured: !!settings?.checkin_channel_id,
      value: settings?.checkin_channel_id ?? null,
    },
    {
      key: "registration_channel_id",
      type: "channel",
      configured: !!settings?.registration_channel_id,
      value: settings?.registration_channel_id ?? null,
    },
  ];

  const configuredCount = items.filter((i) => i.configured).length;
  const isAllConfigured = botPresent && configuredCount === items.length;

  return {
    botPresent,
    items,
    isAllConfigured,
    configuredCount,
    totalItems: items.length,
  };
}
