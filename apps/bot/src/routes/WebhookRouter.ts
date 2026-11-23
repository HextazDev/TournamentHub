import { timingSafeEqual } from "crypto";
import { Router } from "express";
import type { Client } from "discord.js";
import { WebhookRolesService } from "../services/WebhookRolesService";
import { logger } from "../utils/logger";
import { sendServerError } from "../utils/serverError";

function matchesSecret(received: string | undefined, expected: string): boolean {
  if (!received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createWebhookRouter(client: Client) {
  const router = Router();

  router.post("/webhook/team-update", async (req, res) => {
    try {
      const webhookSecret = process.env.WEBHOOK_SECRET || process.env.BOT_API_SECRET;
      if (!webhookSecret) {
        logger.error("[Webhook] Secret non configuré dans l'environnement");
        return res.status(500).json({ error: "Server authentication misconfiguration" });
      }

      const rawHeader = req.headers["x-webhook-secret"];
      const receivedSecret = typeof rawHeader === "string" ? rawHeader : undefined;
      if (!matchesSecret(receivedSecret, webhookSecret)) {
        return res.status(401).json({ error: "Unauthorized: Invalid webhook secret" });
      }

      const webhookService = new WebhookRolesService(client);
      const result = await webhookService.handleTeamUpdate(req.body);

      if (result.success) {
        return res.status(200).json({ received: true });
      }
      sendServerError(res, result.error, "Webhook.teamUpdate");
    } catch (error: unknown) {
      sendServerError(res, error, "Webhook.teamUpdate");
    }
  });

  return router;
}
