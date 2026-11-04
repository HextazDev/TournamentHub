import type { Request, Response } from "express";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { getGuildLanguage, tBot } from "../i18n";
import { getAuthenticatedGuildId } from "../utils/tenant";
import { sendServerError } from "../utils/serverError";

/** Sous-ensemble du client Discord utilisé par l'auto-setup (facilite les tests). */
interface SetupGuild {
  id: string;
  roles: { create(options: { name: string; color: number; reason: string }): Promise<{ id: string }> };
  channels: {
    create(options: {
      name: string;
      type: ChannelType.GuildText;
      reason: string;
      permissionOverwrites: { id: string; allow?: bigint[]; deny?: bigint[] }[];
    }): Promise<{ id: string }>;
  };
}
export interface AutoSetupClient {
  guilds: { fetch(guildId: string): Promise<SetupGuild> };
}

/**
 * POST /api/discord/auto-setup — crée le rôle Capitaine et le salon de check-in. Monté derrière serverSettingsGuard
 * (niveau SERVER + MANAGE_SERVER_SETTINGS, SEC-16). SEC-25 : seul le serveur authentifié (req.adminCheck) est
 * modifié ; un guildId de query ou de corps n'est jamais relu.
 */
export function autoSetupHandler(client: AutoSetupClient) {
  return async (req: Request, res: Response) => {
    const guildId = getAuthenticatedGuildId(req);
    if (!guildId) return res.status(403).json({ error: "Access denied" });

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return res.status(404).json({ error: "Guild not found. Ensure bot is in the server." });

    try {
      const lang = await getGuildLanguage(guildId);
      const captainRole = await guild.roles.create({
        name: tBot(lang, "autoSetup.captainRoleName"),
        color: 0xffa500,
        reason: tBot(lang, "autoSetup.auditReason"),
      });
      const checkinChannel = await guild.channels.create({
        name: tBot(lang, "autoSetup.checkinChannelName"),
        type: ChannelType.GuildText,
        reason: tBot(lang, "autoSetup.auditReason"),
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: captainRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ],
      });
      return res.status(200).json({
        message: "Setup généré avec succès !",
        captain_role_id: captainRole.id,
        checkin_channel_id: checkinChannel.id,
      });
    } catch (error: unknown) {
      return sendServerError(res, error, "DiscordSetup.autoSetup");
    }
  };
}
