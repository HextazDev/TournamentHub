import type { Tournament } from "@hub/shared";

export type ManualAddTournament = Pick<Tournament, "status"> & { checkin_start_at: string | null };

const STARTED_STATUSES: ReadonlySet<Tournament["status"]> = new Set(["ACTIVE", "COMPLETED", "ARCHIVED"]);

/**
 * REG-09 : état de check-in par défaut d'une équipe ajoutée à la main par un TO.
 * Check-in si le tournoi est lancé (ou terminé) ou si la fenêtre de check-in est ouverte ; sinon non,
 * comme une équipe inscrite par le bot (le TO force ensuite via `PATCH /api/teams/:id/checkin`).
 *
 * Point d'extension de #15 : quand le check-in sera désactivable par tournoi (`checkin_mode = DISABLED`),
 * cette fonction devra renvoyer `true` dans ce mode.
 */
export function defaultCheckedInOnManualAdd(tournament: ManualAddTournament, now: Date): boolean {
  if (STARTED_STATUSES.has(tournament.status)) return true;
  if (!tournament.checkin_start_at) return false;
  const checkinStart = new Date(tournament.checkin_start_at).getTime();
  return !Number.isNaN(checkinStart) && now.getTime() >= checkinStart;
}
