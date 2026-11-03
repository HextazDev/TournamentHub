import type { Client } from "discord.js";
import { z } from "zod";
import { logger } from "../utils/logger";
import { applyPresence, hasPresenceFailure, removePresence, type PresenceReport } from "./CaptainPresenceService";

/**
 * Webhook Supabase optionnel sur `teams` : resynchronise la présence des capitaines quand une équipe est
 * modifiée hors du bot (édition directe en base). Les check-ins faits via le bot appliquent déjà la présence
 * eux-mêmes (DISC-11). Toute opération Discord refusée renvoie un échec (OPS-05).
 */
const teamRecordSchema = z.object({
  id: z.string().min(1),
  tournament_id: z.string().min(1),
  name: z.string(),
  captain_discord_id: z.string().min(1).nullable(),
  is_checked_in: z.boolean(),
});

const teamWebhookSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("INSERT"), record: teamRecordSchema }),
  z.object({ type: z.literal("UPDATE"), record: teamRecordSchema }),
  z.object({ type: z.literal("DELETE"), old_record: teamRecordSchema }),
]);

type TeamRecord = z.infer<typeof teamRecordSchema>;

export type WebhookResult = { success: true } | { success: false; error: string };

export class WebhookRolesService {
  constructor(private readonly client: Client) {}

  async handleTeamUpdate(payload: unknown): Promise<WebhookResult> {
    const parsed = teamWebhookSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn("[WebhookRoles] Invalid team webhook payload", { issues: parsed.error.issues.map((i) => i.path.join(".")) });
      return { success: false, error: "Invalid webhook payload" };
    }

    const event = parsed.data;
    const record = event.type === "DELETE" ? event.old_record : event.record;
    logger.info(`[WebhookRoles] ${event.type} received`, { teamId: record.id, checkedIn: record.is_checked_in });

    const report = await this.sync(event.type, record);
    if (report && hasPresenceFailure(report)) {
      return { success: false, error: "Discord role synchronization failed" };
    }
    return { success: true };
  }

  private async sync(type: "INSERT" | "UPDATE" | "DELETE", record: TeamRecord): Promise<PresenceReport | null> {
    const captainId = record.captain_discord_id;
    if (!captainId) return null;
    const team = { id: record.id, tournament_id: record.tournament_id, name: record.name, captain_discord_id: captainId };

    if (type === "DELETE") return record.is_checked_in ? removePresence(this.client, team) : null;
    if (record.is_checked_in) return applyPresence(this.client, team);
    // Un INSERT non checké n'a aucune présence à retirer ; un UPDATE peut être un check-out.
    return type === "UPDATE" ? removePresence(this.client, team) : null;
  }
}
