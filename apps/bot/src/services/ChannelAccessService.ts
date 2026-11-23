import { PermissionFlagsBits, type GuildMember, type GuildBasedChannel, type Guild } from "discord.js";
import { logger } from "../utils/logger";

export interface ChannelAccessResult {
  ok: boolean;
  code?: "CHANNEL_NOT_ACCESSIBLE";
  error?: string;
}

export interface MinimalGuildChannel {
  id: string;
  name: string;
  guild?: { ownerId: string };
  isTextBased(): boolean;
  permissionsFor(memberOrRole: any): { has(permission: bigint | bigint[]): boolean } | null;
}

export interface MinimalGuildMember {
  id: string;
  permissions: { has(permission: bigint | bigint[]): boolean };
}

export interface MinimalGuild {
  id: string;
  ownerId: string;
  channels: {
    cache: {
      get(id: string): MinimalGuildChannel | undefined;
      values(): IterableIterator<MinimalGuildChannel>;
    };
    fetch?(): Promise<unknown>;
  };
  members: {
    me?: MinimalGuildMember | null;
    fetch(options: string | { limit: number }): Promise<any>;
    fetchMe?(): Promise<MinimalGuildMember | null>;
  };
}

export interface ChannelAccessClient {
  guilds: {
    fetch(guildId: string): Promise<MinimalGuild>;
  };
  user?: { id: string } | null;
}

export class ChannelAccessService {
  /**
   * Vérifie si un membre et le bot peuvent tous les deux accéder à un salon texte.
   * - Membre : doit pouvoir voir le salon (ViewChannel).
   * - Bot : doit pouvoir voir le salon ET envoyer des messages (ViewChannel + SendMessages).
   */
  static canMemberAndBotAccessChannel(
    channel: MinimalGuildChannel,
    member: MinimalGuildMember,
    botMember: MinimalGuildMember | null,
  ): boolean {
    if (!channel.isTextBased()) {
      return false;
    }

    if (!botMember) {
      return false;
    }

    // Bot : doit pouvoir voir et écrire
    const botPerms = channel.permissionsFor(botMember);
    if (!botPerms || !botPerms.has(PermissionFlagsBits.ViewChannel) || !botPerms.has(PermissionFlagsBits.SendMessages)) {
      return false;
    }

    // Membre : doit pouvoir voir
    // Note : si le membre a Administrator ou est Owner, permissionsFor(member).has(ViewChannel) est vrai
    const memberPerms = channel.permissionsFor(member);
    if (!memberPerms || !memberPerms.has(PermissionFlagsBits.ViewChannel)) {
      return false;
    }

    return true;
  }

  /**
   * Récupère la liste des salons texte accessibles à un membre et au bot.
   */
  static async fetchAccessibleChannels(
    guild: MinimalGuild,
    member: MinimalGuildMember,
  ): Promise<{ id: string; name: string }[]> {
    if (typeof guild.channels.fetch === "function") {
      await guild.channels.fetch().catch((err) => {
        logger.warn(`[ChannelAccessService] Échec guild.channels.fetch pour ${guild.id}:`, err);
      });
    }

    let botMember: MinimalGuildMember | null = guild.members.me ?? null;
    if (!botMember && typeof guild.members.fetchMe === "function") {
      botMember = await guild.members.fetchMe().catch(() => null);
    }

    const channels: { id: string; name: string }[] = [];
    for (const channel of guild.channels.cache.values()) {
      if (this.canMemberAndBotAccessChannel(channel, member, botMember)) {
        channels.push({ id: channel.id, name: channel.name });
      }
    }

    return channels.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Valide que le membre et le bot ont tous les deux accès à tous les salons demandés.
   * Les IDs nuls, vides ou non définis sont ignorés.
   */
  static async validateChannelAccess(params: {
    client: ChannelAccessClient;
    guildId: string;
    discordId: string;
    channelIds: (string | null | undefined)[];
  }): Promise<ChannelAccessResult> {
    const rawIds = params.channelIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    if (rawIds.length === 0) {
      return { ok: true };
    }

    const guild = await params.client.guilds.fetch(params.guildId).catch(() => null);
    if (!guild) {
      return {
        ok: false,
        code: "CHANNEL_NOT_ACCESSIBLE",
        error: "Guild not found",
      };
    }

    if (typeof guild.channels.fetch === "function") {
      await guild.channels.fetch().catch((err) => {
        logger.warn(`[ChannelAccessService] Échec guild.channels.fetch pour ${params.guildId}:`, err);
      });
    }

    const member: MinimalGuildMember | null = await guild.members.fetch(params.discordId).catch(() => null);
    if (!member) {
      return {
        ok: false,
        code: "CHANNEL_NOT_ACCESSIBLE",
        error: "Member not found in guild",
      };
    }

    let botMember: MinimalGuildMember | null = guild.members.me ?? null;
    if (!botMember && typeof guild.members.fetchMe === "function") {
      botMember = await guild.members.fetchMe().catch(() => null);
    }
    if (!botMember && params.client.user?.id) {
      botMember = await guild.members.fetch(params.client.user.id).catch(() => null);
    }

    if (!botMember) {
      return {
        ok: false,
        code: "CHANNEL_NOT_ACCESSIBLE",
        error: "Bot member not found in guild",
      };
    }

    for (const channelId of rawIds) {
      const channel = guild.channels.cache.get(channelId);
      if (!channel || !this.canMemberAndBotAccessChannel(channel, member, botMember)) {
        return {
          ok: false,
          code: "CHANNEL_NOT_ACCESSIBLE",
          error: `Le salon Discord (${channelId}) n'est pas accessible.`,
        };
      }
    }

    return { ok: true };
  }
}
