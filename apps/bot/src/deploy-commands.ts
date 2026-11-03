import { REST, Routes } from "discord.js";
import { botEnvironment } from "./config/runtime";
import { logger } from "./utils/logger";
import * as adminTransfer from "./commands/admin-transfer";
import * as adminSetupCheckin from "./commands/admin-setup-checkin";
import * as score from "./commands/score";

// Explicit opt-in only: this entrypoint is never called by the container startup.
async function registerCommands() {
  const scope = process.env.DISCORD_COMMAND_SCOPE ?? "global";
  const guildId = process.env.DISCORD_GUILD_ID;
  if (scope !== "global" && scope !== "guild") throw new Error("Invalid DISCORD_COMMAND_SCOPE");
  if (scope === "guild" && (!guildId || !/^\d+$/.test(guildId))) throw new Error("Missing or invalid DISCORD_GUILD_ID");
  const route = scope === "guild" && guildId
    ? Routes.applicationGuildCommands(botEnvironment.DISCORD_CLIENT_ID, guildId)
    : Routes.applicationCommands(botEnvironment.DISCORD_CLIENT_ID);
  const commands = [adminTransfer.data.toJSON(), adminSetupCheckin.data.toJSON(), score.data.toJSON()];
  await new REST({ version: "10" }).setToken(botEnvironment.DISCORD_TOKEN).put(route, { body: commands });
  logger.info(`Registered ${commands.length} application commands (${scope})`);
}

registerCommands().catch(() => {
  // REST exceptions may carry request details; credentials must stay out of logs.
  logger.error("Command registration failed. Check Discord application credentials, scope and permissions.");
  process.exitCode = 1;
});
