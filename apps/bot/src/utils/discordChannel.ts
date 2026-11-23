/**
 * SEC-01 / AUD-SEC-02 : contrôle fail-closed d'appartenance d'un salon Discord à un serveur donné.
 * Refuse tout salon sans `guildId` string (ex. DMChannel, PartialGroupDMChannel) ou rattaché à un autre serveur.
 */
export function isChannelInGuild(channel: unknown, expectedGuildId: string): boolean {
  if (!channel || typeof channel !== "object" || !("guildId" in channel)) return false;
  const { guildId } = channel as { guildId?: unknown };
  return typeof guildId === "string" && guildId === expectedGuildId;
}

export function assertChannelInGuild(channel: unknown, expectedGuildId: string, channelId: string): void {
  if (!isChannelInGuild(channel, expectedGuildId)) {
    throw new Error(`Le salon ${channelId} n'appartient pas au serveur lié.`);
  }
}
