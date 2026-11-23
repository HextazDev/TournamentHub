import type { Request, Response } from "express";
import { getAuthenticatedGuildId } from "../utils/tenant";
import { sendServerError } from "../utils/serverError";
import { ChannelAccessService } from "../services/ChannelAccessService";

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
  permissionsFor(memberOrRole: any): { has(permission: bigint | bigint[]): boolean } | null;
}
interface ListedMember {
  id?: string;
  user?: { id: string; username: string; bot: boolean };
  displayName?: string;
  permissions?: { has(permission: bigint | bigint[]): boolean };
}
interface ListedGuild {
  id?: string;
  ownerId?: string;
  roles: { cache: { values(): IterableIterator<ListedRole> } };
  channels: {
    cache: {
      get?(id: string): ListedChannel | undefined;
      values(): IterableIterator<ListedChannel>;
    };
    fetch?(): Promise<unknown>;
  };
  members: {
    me?: ListedMember | null;
    fetch(options?: any): Promise<any>;
    fetchMe?(): Promise<ListedMember | null>;
  };
}
export interface DiscordListClient {
  guilds: { fetch(guildId: string): Promise<ListedGuild> };
  user?: { id: string } | null;
}

type Lister = (guild: ListedGuild, req: Request) => Promise<unknown[]>;

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

const LISTERS: Record<"roles" | "channels" | "members", Lister> = {
  roles: async (guild) =>
    [...guild.roles.cache.values()]
      .filter((role) => role.name !== "@everyone")
      .map((role) => ({ id: role.id, name: role.name, color: role.hexColor }))
      .sort(byName),
  channels: async (guild, req) => {
    const discordId = req.adminCheck?.discordId ?? (req.headers["x-discord-user-id"] as string | undefined);
    if (!discordId) {
      throw new Error("Missing discord user id");
    }
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) {
      const err = new Error("Member not found in guild");
      (err as any).statusCode = 403;
      (err as any).code = "NOT_A_MEMBER";
      throw err;
    }
    return ChannelAccessService.fetchAccessibleChannels(guild as any, member as any);
  },
  members: async (guild) =>
    [...(await guild.members.fetch({ limit: 1000 })).values()]
      .filter((member: any) => member.user && !member.user.bot)
      .map((member: any) => ({ id: member.user.id, username: member.user.username, displayName: member.displayName }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
};

/**
 * Listes Discord du panel (rôles, salons, membres), montées derrière requireGuildAdmin + requireTournamentScope.
 * SEC-25 : seul le serveur authentifié (req.adminCheck, via getAuthenticatedGuildId) est lu ; un guildId passé en
 * query ou dans le corps n'est jamais relu.
 * SEC-21 (#88) : pour les salons, seuls ceux visibles par le membre demandeur (ViewChannel) et utilisables
 * par le bot (ViewChannel + SendMessages) sont renvoyés.
 */
export function discordListHandlers(client: DiscordListClient) {
  const handler = (list: keyof typeof LISTERS) => async (req: Request, res: Response) => {
    const guildId = getAuthenticatedGuildId(req);
    if (!guildId) return res.status(403).json({ error: "Access denied" });

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return res.status(404).json({ error: "Guild not found. Ensure bot is in the server." });

    try {
      return res.status(200).json(await LISTERS[list](guild, req));
    } catch (error: any) {
      if (error?.statusCode === 403) {
        return res.status(403).json({ error: error.message, code: error.code ?? "NO_RIGHTS" });
      }
      return sendServerError(res, error, `DiscordList.${list}`);
    }
  };
  return { roles: handler("roles"), channels: handler("channels"), members: handler("members") };
}
