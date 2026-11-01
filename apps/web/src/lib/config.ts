import { z } from "zod";

export interface PublicSupabaseConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

declare global {
  interface Window {
    __HUB_PUBLIC_CONFIG__?: Partial<PublicSupabaseConfig>;
  }
}

const httpUrl = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  });

const webServerSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: httpUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  BOT_API_URL: httpUrl,
  BOT_API_SECRET: z.string().min(1),
  NEXTAUTH_URL: httpUrl,
  NEXTAUTH_SECRET: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().regex(/^\d+$/),
  DISCORD_CLIENT_SECRET: z.string().min(1),
});

const PLACEHOLDER_PATTERN =
  /dummy|placeholder|ton_projet|ta_cle|ton_client|dev-bot-secret|un_secret_tres_aleatoire|dev-only-secret/i;

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Resolves the server-to-server Bot API base URL.
 * Prefers internal `BOT_API_URL` (e.g. `http://bot:8080` on the Docker Compose network),
 * then `NEXT_PUBLIC_BOT_API_URL`, and falls back to `http://localhost:8080` outside production.
 */
export function resolveServerBotApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  const production = env.NODE_ENV === "production";
  const candidate =
    env.BOT_API_URL ||
    env.NEXT_PUBLIC_BOT_API_URL ||
    (production ? "" : "http://localhost:8080");
  return trimTrailingSlash(candidate);
}

/**
 * Resolves public Supabase URL and anon key for client/server usage.
 * Prefers runtime-injected browser config (`window.__HUB_PUBLIC_CONFIG__`) when present and non-placeholder,
 * allowing pre-built Docker images to be configured at runtime without rebuilding.
 */
export function resolvePublicSupabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
  runtimeConfig?: Partial<PublicSupabaseConfig>,
): PublicSupabaseConfig {
  const browserConfig =
    runtimeConfig ??
    (typeof window !== "undefined" ? window.__HUB_PUBLIC_CONFIG__ : undefined);

  const envUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "";
  const envAnonKey = env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

  const isPlaceholderUrl = !envUrl || PLACEHOLDER_PATTERN.test(envUrl);
  const isPlaceholderKey = !envAnonKey || PLACEHOLDER_PATTERN.test(envAnonKey);

  const supabaseUrl =
    (browserConfig?.supabaseUrl && !PLACEHOLDER_PATTERN.test(browserConfig.supabaseUrl)
      ? browserConfig.supabaseUrl
      : !isPlaceholderUrl
        ? envUrl
        : browserConfig?.supabaseUrl || envUrl) || "https://placeholder.supabase.co";

  const supabaseAnonKey =
    (browserConfig?.supabaseAnonKey &&
    !PLACEHOLDER_PATTERN.test(browserConfig.supabaseAnonKey)
      ? browserConfig.supabaseAnonKey
      : !isPlaceholderKey
        ? envAnonKey
        : browserConfig?.supabaseAnonKey || envAnonKey) || "placeholder-anon-key";

  return { supabaseUrl, supabaseAnonKey };
}

/**
 * Validates web server runtime configuration.
 * Reports only variable names on error so credentials never leak into logs or responses.
 */
export function readWebServerEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === "production";
  const rawBotApiUrl = resolveServerBotApiUrl(env);
  const rawSupabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const rawSupabaseAnonKey = env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const parsed = webServerSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL:
      rawSupabaseUrl || (production ? undefined : "http://127.0.0.1:54321"),
    NEXT_PUBLIC_SUPABASE_ANON_KEY:
      rawSupabaseAnonKey || (production ? undefined : "dev-anon-key"),
    SUPABASE_SERVICE_ROLE_KEY:
      env.SUPABASE_SERVICE_ROLE_KEY || (production ? undefined : "dev-service-role-key"),
    BOT_API_URL: rawBotApiUrl || undefined,
    BOT_API_SECRET:
      env.BOT_API_SECRET || (production ? undefined : "dev-bot-secret-key-123"),
    NEXTAUTH_URL:
      env.NEXTAUTH_URL || (production ? undefined : "http://localhost:3000"),
    NEXTAUTH_SECRET:
      env.NEXTAUTH_SECRET || (production ? undefined : "dev-nextauth-secret"),
    DISCORD_CLIENT_ID:
      env.DISCORD_CLIENT_ID || (production ? undefined : "0"),
    DISCORD_CLIENT_SECRET:
      env.DISCORD_CLIENT_SECRET || (production ? undefined : "dev-discord-secret"),
  });

  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join("."))),
    ];
    throw new Error(`Invalid web environment: ${fields.join(", ")}`);
  }

  if (production) {
    if (parsed.data.BOT_API_SECRET.length < 32) {
      throw new Error("Invalid web environment: BOT_API_SECRET");
    }
    if (parsed.data.NEXTAUTH_SECRET.length < 32) {
      throw new Error("Invalid web environment: NEXTAUTH_SECRET");
    }
    for (const key of [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "BOT_API_SECRET",
      "NEXTAUTH_SECRET",
      "DISCORD_CLIENT_SECRET",
    ] as const) {
      if (PLACEHOLDER_PATTERN.test(parsed.data[key])) {
        throw new Error(`Invalid web environment: ${key}`);
      }
    }
  }

  return parsed.data;
}
