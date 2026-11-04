import type { Request, Response } from "express";
import { getAuthenticatedGuildId } from "../utils/tenant";
import { sendServerError } from "../utils/serverError";

/** Sous-ensemble du client Discord lu par les listes (facilite les tests). */
interface ListedRole {
  id: string;
  name: string;
  hexColor: string;
}
interface ListedChannel {
  id: string;
  name: string;
  isTextBased(): boolean;
}
interface ListedMember {
  user: { id: string; username: string; bot: boolean };
  displayName: string;
}
interface ListedGuild {
  roles: { cache: { values(): IterableIterator<ListedRole> } };
  channels: { cache: { values(): IterableIterator<ListedChannel> } };
  members: { fetch(options: { limit: number }): Promise<{ values(): IterableIterator<ListedMember> }> };
}
export interface DiscordListClient {
  guilds: { fetch(guildId: string): Promise<ListedGuild> };
}

type Lister = (guild: ListedGuild) => Promise<unknown[]>;

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

const LISTERS: Record<"roles" | "channels" | "members", Lister> = {
  roles: async (guild) =>
    [...guild.roles.cache.values()]
      .filter((role) => role.name !== "@everyone")
      .map((role) => ({ id: role.id, name: role.name, color: role.hexColor }))
      .sort(byName),
  channels: async (guild) =>
    [...guild.channels.cache.values()]
      .filter((channel) => channel.isTextBased())
      .map((channel) => ({ id: channel.id, name: channel.name }))
      .sort(byName),
  members: async (guild) =>
    [...(await guild.members.fetch({ limit: 1000 })).values()]
      .filter((member) => !member.user.bot)
      .map((member) => ({ id: member.user.id, username: member.user.username, displayName: member.displayName }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
};

/**
 * Listes Discord du panel (rôles, salons, membres), montées derrière requireGuildAdmin + requireTournamentScope.
 * SEC-25 : seul le serveur authentifié (req.adminCheck, via getAuthenticatedGuildId) est lu ; un guildId passé en
 * query ou dans le corps n'est jamais relu.
 */
export function discordListHandlers(client: DiscordListClient) {
  const handler = (list: keyof typeof LISTERS) => async (req: Request, res: Response) => {
    const guildId = getAuthenticatedGuildId(req);
    if (!guildId) return res.status(403).json({ error: "Access denied" });

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return res.status(404).json({ error: "Guild not found. Ensure bot is in the server." });

    try {
      return res.status(200).json(await LISTERS[list](guild));
    } catch (error: unknown) {
      return sendServerError(res, error, `DiscordList.${list}`);
    }
  };
  return { roles: handler("roles"), channels: handler("channels"), members: handler("members") };
}
