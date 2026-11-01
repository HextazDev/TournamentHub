import { pathToFileURL } from "node:url";

const PLACEHOLDER_PATTERN =
  /dummy|placeholder|ton_projet|ta_cle|ton_client|dev-bot-secret|un_secret_tres_aleatoire|dev-only-secret/i;

function isHttpUrl(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateWebProductionEnv(env = process.env) {
  const invalid = [];

  const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  if (!isHttpUrl(supabaseUrl) || PLACEHOLDER_PATTERN.test(supabaseUrl)) {
    invalid.push("NEXT_PUBLIC_SUPABASE_URL");
  }

  const supabaseAnonKey = env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (
    typeof supabaseAnonKey !== "string" ||
    supabaseAnonKey.length === 0 ||
    PLACEHOLDER_PATTERN.test(supabaseAnonKey)
  ) {
    invalid.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (
    typeof serviceRoleKey !== "string" ||
    serviceRoleKey.length === 0 ||
    PLACEHOLDER_PATTERN.test(serviceRoleKey)
  ) {
    invalid.push("SUPABASE_SERVICE_ROLE_KEY");
  }

  const botApiUrl = env.BOT_API_URL || env.NEXT_PUBLIC_BOT_API_URL;
  if (!isHttpUrl(botApiUrl)) {
    invalid.push("BOT_API_URL");
  }

  const botApiSecret = env.BOT_API_SECRET;
  if (
    typeof botApiSecret !== "string" ||
    botApiSecret.length < 32 ||
    PLACEHOLDER_PATTERN.test(botApiSecret)
  ) {
    invalid.push("BOT_API_SECRET");
  }

  const nextAuthUrl = env.NEXTAUTH_URL;
  if (!isHttpUrl(nextAuthUrl) || PLACEHOLDER_PATTERN.test(nextAuthUrl)) {
    invalid.push("NEXTAUTH_URL");
  }

  const nextAuthSecret = env.NEXTAUTH_SECRET;
  if (
    typeof nextAuthSecret !== "string" ||
    nextAuthSecret.length < 32 ||
    PLACEHOLDER_PATTERN.test(nextAuthSecret)
  ) {
    invalid.push("NEXTAUTH_SECRET");
  }

  const discordClientId = env.DISCORD_CLIENT_ID;
  if (typeof discordClientId !== "string" || !/^\d+$/.test(discordClientId)) {
    invalid.push("DISCORD_CLIENT_ID");
  }

  const discordClientSecret = env.DISCORD_CLIENT_SECRET;
  if (
    typeof discordClientSecret !== "string" ||
    discordClientSecret.length === 0 ||
    PLACEHOLDER_PATTERN.test(discordClientSecret)
  ) {
    invalid.push("DISCORD_CLIENT_SECRET");
  }

  const port = Number(env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    invalid.push("PORT");
  }

  if (invalid.length > 0) {
    throw new Error(`Invalid web environment: ${invalid.join(", ")}`);
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    validateWebProductionEnv(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid web environment");
    process.exit(1);
  }
  await import("./server.js");
}
