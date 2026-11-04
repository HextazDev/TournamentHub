import type { Tournament } from "@hub/shared";

export type ManualAddTournament = Pick<Tournament, "status"> & {
  checkin_start_at: string | null;
  checkin_mode?: Tournament["checkin_mode"];
};

const STARTED_STATUSES: ReadonlySet<Tournament["status"]> = new Set(["ACTIVE", "COMPLETED", "ARCHIVED"]);

/**
 * REG-09 : état de check-in par défaut d'une équipe ajoutée à la main par un TO.
 * Si checkin_mode === "DISABLED", l'équipe est toujours check-in (#15).
 * Sinon, check-in si le tournoi est lancé (ou terminé) ou si la fenêtre de check-in est ouverte ; sinon non,
 * comme une équipe inscrite par le bot (le TO force ensuite via `PATCH /api/teams/:id/checkin`).
 */
export function defaultCheckedInOnManualAdd(tournament: ManualAddTournament, now: Date): boolean {
  if (tournament.checkin_mode === "DISABLED") return true;
  if (STARTED_STATUSES.has(tournament.status)) return true;
  if (!tournament.checkin_start_at) return false;
  const checkinStart = new Date(tournament.checkin_start_at).getTime();
  return !Number.isNaN(checkinStart) && now.getTime() >= checkinStart;
}
