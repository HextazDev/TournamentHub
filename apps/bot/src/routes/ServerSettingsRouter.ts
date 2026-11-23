import { Router } from "express";
import { supabase } from "../lib/supabase";
import { sendServerError } from "../utils/serverError";
import { getAuthenticatedGuildId, resolveOrganization } from "../utils/tenant";
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

  // ARC-03: Lecture des paramètres depuis organization_integrations (Option 5A)
  const org = await resolveOrganization(authGuildId);
  const discordCfg = (org?.discordConfig ?? {}) as Record<string, unknown>;

  const currentSettings = {
    registration_channel_id: typeof discordCfg.registration_channel_id === "string" ? discordCfg.registration_channel_id : null,
    announcement_channel_id: typeof discordCfg.announcement_channel_id === "string" ? discordCfg.announcement_channel_id : null,
    checkin_channel_id: typeof discordCfg.checkin_channel_id === "string" ? discordCfg.checkin_channel_id : null,
  };

  const discordId = req.adminCheck?.discordId ?? (req.headers["x-discord-user-id"] as string | undefined);
  const channelChanged = (requested: unknown, current: string | null | undefined) =>
    requested !== undefined && (requested || null) !== (current || null) && typeof requested === "string" && requested.trim().length > 0;

  const modifiedChannels: string[] = [];
  if (channelChanged(parsed.data.registration_channel_id, currentSettings.registration_channel_id)) {
    modifiedChannels.push(parsed.data.registration_channel_id!);
  }
  if (channelChanged(parsed.data.announcement_channel_id, currentSettings.announcement_channel_id)) {
    modifiedChannels.push(parsed.data.announcement_channel_id!);
  }
  if (channelChanged(parsed.data.checkin_channel_id, currentSettings.checkin_channel_id)) {
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

  // ARC-03: Sauvegarde dans organization_integrations et organizations
  if (org) {
    const nextConfig: Record<string, unknown> = {
      ...discordCfg,
      ...(parsed.data.to_role_id !== undefined ? { to_role_id: parsed.data.to_role_id } : {}),
      ...(parsed.data.captain_role_id !== undefined ? { captain_role_id: parsed.data.captain_role_id } : {}),
      ...(parsed.data.registration_channel_id !== undefined ? { registration_channel_id: parsed.data.registration_channel_id } : {}),
      ...(parsed.data.announcement_channel_id !== undefined ? { announcement_channel_id: parsed.data.announcement_channel_id } : {}),
      ...(parsed.data.checkin_channel_id !== undefined ? { checkin_channel_id: parsed.data.checkin_channel_id } : {}),
    };

    const { error: intErr } = await supabase
      .from("organization_integrations")
      .update({ config: nextConfig, updated_at: new Date().toISOString() })
      .eq("organization_id", org.id)
      .eq("provider", "DISCORD");
    if (intErr) {
      sendServerError(res, intErr, `ServerSettingsRouter: update organization_integrations échoué pour ${authGuildId}`);
      return;
    }

    const orgUpdates: Record<string, unknown> = {};
    if (parsed.data.language !== undefined) orgUpdates.language = parsed.data.language;
    if (parsed.data.invite_url !== undefined) orgUpdates.invite_url = parsed.data.invite_url;
    if (Object.keys(orgUpdates).length > 0) {
      orgUpdates.updated_at = new Date().toISOString();
      const { error: orgErr } = await supabase.from("organizations").update(orgUpdates).eq("id", org.id);
      if (orgErr) {
        sendServerError(res, orgErr, `ServerSettingsRouter: update organizations échoué pour ${authGuildId}`);
        return;
      }
    }
  }

  // DISC-08 : le nouveau rôle TO doit ouvrir (ou fermer) l'accès au panel sans attendre un redémarrage du bot.
  // SEC-05 : les décisions d'accès en cache reposent sur l'ancien rôle TO.
  if (previous.toRoleId !== parsed.data.to_role_id) {
    invalidateGuildAccess(authGuildId);
    const guild = await req.app.locals.discordClient.guilds.fetch(authGuildId).catch(() => null);
    if (guild) await GuildRegistryService.syncGuildAdmins(guild);
  }

  const responseData = {
    guild_id: authGuildId,
    to_role_id: parsed.data.to_role_id ?? (typeof discordCfg.to_role_id === "string" ? discordCfg.to_role_id : null),
    captain_role_id: parsed.data.captain_role_id ?? (typeof discordCfg.captain_role_id === "string" ? discordCfg.captain_role_id : null),
    registration_channel_id: parsed.data.registration_channel_id ?? currentSettings.registration_channel_id,
    announcement_channel_id: parsed.data.announcement_channel_id ?? currentSettings.announcement_channel_id,
    checkin_channel_id: parsed.data.checkin_channel_id ?? currentSettings.checkin_channel_id,
    language: parsed.data.language ?? org?.language ?? "fr",
    invite_url: parsed.data.invite_url ?? org?.invite_url ?? null,
  };

  res.json(responseData);
});
