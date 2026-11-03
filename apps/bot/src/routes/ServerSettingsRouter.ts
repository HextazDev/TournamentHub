import { Router } from "express";
import { supabase } from "../lib/supabase";
import { logger } from "../utils/logger";
import { getAuthenticatedGuildId } from "../utils/tenant";
import { ServerSettingsUpdateSchema } from "@hub/shared";
import { GuildRegistryService, readToRoleId } from "../services/GuildRegistryService";
import { invalidateGuildAccess } from "../services/MemberAccessService";

export const serverSettingsRouter = Router();

// PUT /api/server-settings — Upsert server settings
serverSettingsRouter.put("/", async (req, res) => {
  const authGuildId = getAuthenticatedGuildId(req);
  if (!authGuildId || req.body?.guild_id !== authGuildId) {
    return res.status(403).json({ error: "Accès refusé : vous ne pouvez modifier que les paramètres de votre propre serveur." });
  }

  const parsed = ServerSettingsUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid payload" });
  }

  const previous = await readToRoleId(authGuildId);
  if (!previous.ok) {
    return res.status(503).json({ error: "Lecture des paramètres impossible, réessayez." });
  }

  // Les clés absentes (langue, invitation) ne sont pas envoyées : l'upsert conserve leur valeur actuelle.
  const payload = Object.fromEntries(
    Object.entries({ ...parsed.data, updated_at: new Date().toISOString() }).filter(([, v]) => v !== undefined),
  );

  const { data, error } = await supabase
    .from("server_settings")
    .upsert(payload, { onConflict: "guild_id" })
    .select()
    .single();

  if (error) {
    logger.error(`[ServerSettingsRouter] Upsert échoué pour ${authGuildId}:`, error);
    return res.status(500).json({ error: error.message });
  }

  // DISC-08 : le nouveau rôle TO doit ouvrir (ou fermer) l'accès au panel sans attendre un redémarrage du bot.
  // SEC-05 : les décisions d'accès en cache reposent sur l'ancien rôle TO.
  if (previous.toRoleId !== parsed.data.to_role_id) {
    invalidateGuildAccess(authGuildId);
    const guild = await req.app.locals.discordClient.guilds.fetch(authGuildId).catch(() => null);
    if (guild) await GuildRegistryService.syncGuildAdmins(guild);
  }

  res.json(data);
});
