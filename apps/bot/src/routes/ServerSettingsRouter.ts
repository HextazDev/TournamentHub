import { Router } from "express";
import { supabase } from "../lib/supabase";
import { sendServerError } from "../utils/serverError";
import { getAuthenticatedGuildId } from "../utils/tenant";
import { ServerSettingsUpdateSchema } from "@hub/shared";
import { GuildRegistryService, readToRoleId } from "../services/GuildRegistryService";
import { invalidateGuildAccess } from "../services/MemberAccessService";
import { requireGuildAction } from "../middleware/auth";
import { ChannelAccessService } from "../services/ChannelAccessService";

export const serverSettingsRouter = Router();

// SEC-16 : les paramètres du serveur (dont to_role_id, donc qui est TO) sont hors de portée du rôle TO.
// La garde vit dans le routeur pour ne pas dépendre du montage dans index.ts (requireGuildAdmin reste requis avant).
serverSettingsRouter.use(requireGuildAction("MANAGE_SERVER_SETTINGS"));

// PUT /api/server-settings — Upsert server settings
serverSettingsRouter.put("/", async (req, res) => {
  const authGuildId = getAuthenticatedGuildId(req);
  if (!authGuildId || req.body?.guild_id !== authGuildId) {
    return res.status(403).json({ error: "Accès refusé : vous ne pouvez modifier que les paramètres de votre propre serveur." });
  }

  const parsed = ServerSettingsUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
  }

  const previous = await readToRoleId(authGuildId);
  if (!previous.ok) {
    return res.status(503).json({ error: "Lecture des paramètres impossible, réessayez." });
  }

  // SEC-21 (#88) : un salon serveur spécifié ou modifié doit être accessible au membre demandeur et au bot.
  const { data: currentSettings } = await supabase
    .from("server_settings")
    .select("registration_channel_id, announcement_channel_id, checkin_channel_id")
    .eq("guild_id", authGuildId)
    .maybeSingle();

  const discordId = req.adminCheck?.discordId ?? (req.headers["x-discord-user-id"] as string | undefined);
  const channelChanged = (requested: unknown, current: string | null | undefined) =>
    requested !== undefined && (requested || null) !== (current || null) && typeof requested === "string" && requested.trim().length > 0;

  const modifiedChannels: string[] = [];
  if (channelChanged(parsed.data.registration_channel_id, currentSettings?.registration_channel_id)) {
    modifiedChannels.push(parsed.data.registration_channel_id!);
  }
  if (channelChanged(parsed.data.announcement_channel_id, currentSettings?.announcement_channel_id)) {
    modifiedChannels.push(parsed.data.announcement_channel_id!);
  }
  if (channelChanged(parsed.data.checkin_channel_id, currentSettings?.checkin_channel_id)) {
    modifiedChannels.push(parsed.data.checkin_channel_id!);
  }

  if (modifiedChannels.length > 0) {
    if (!discordId || !req.app.locals.discordClient) {
      return res.status(403).json({ error: "Access denied: missing Discord client or user", code: "CHANNEL_NOT_ACCESSIBLE" });
    }
    const channelCheck = await ChannelAccessService.validateChannelAccess({
      client: req.app.locals.discordClient,
      guildId: authGuildId,
      discordId,
      channelIds: modifiedChannels,
    });
    if (!channelCheck.ok) {
      return res.status(403).json({ error: channelCheck.error, code: channelCheck.code ?? "CHANNEL_NOT_ACCESSIBLE" });
    }
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
    sendServerError(res, error, `ServerSettingsRouter: upsert échoué pour ${authGuildId}`);
    return;
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
