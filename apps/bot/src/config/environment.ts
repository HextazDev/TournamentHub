import { z } from "zod";
import { parseIntegrationKey } from "../utils/crypto";

const httpUrl = z.string().url().refine((value) => /^https?:\/\//.test(value));
const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().regex(/^\d+$/),
  SUPABASE_URL: httpUrl,
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  BOT_API_SECRET: z.string().min(1),
  FRONTEND_URL: httpUrl.optional(),
  INTEGRATION_ENCRYPTION_KEY: z.string().optional(),
});

/** Report field names only: Zod diagnostics can include supplied credentials. */
export function readBotEnvironment(env: NodeJS.ProcessEnv) {
  const production = env.NODE_ENV === "production";
  const result = schema.safeParse({
    ...env,
    ...(production ? {} : {
      DISCORD_TOKEN: env.DISCORD_TOKEN || "development-not-configured",
      DISCORD_CLIENT_ID: env.DISCORD_CLIENT_ID || "0",
      SUPABASE_URL: env.SUPABASE_URL || "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY || "dummy_key_for_testing",
      BOT_API_SECRET: env.BOT_API_SECRET || "development-only-not-for-production",
    }),
  });
  if (!result.success) {
    throw new Error(`Invalid bot environment: ${[...new Set(result.error.issues.map((issue) => issue.path.join(".")))].join(", ")}`);
  }
  const encryptionKey = result.data.INTEGRATION_ENCRYPTION_KEY;
  if (encryptionKey && !parseIntegrationKey(encryptionKey)) throw new Error("Invalid bot environment: INTEGRATION_ENCRYPTION_KEY");
  if (production) {
    if (!encryptionKey) throw new Error("Invalid bot environment: INTEGRATION_ENCRYPTION_KEY");
    if (result.data.BOT_API_SECRET.length < 32) throw new Error("Invalid bot environment: BOT_API_SECRET");
    const placeholders = /dummy|placeholder|ton_token|ta_cle|dev-bot-secret/i;
    for (const key of ["DISCORD_TOKEN", "SUPABASE_SERVICE_ROLE_KEY", "BOT_API_SECRET"] as const) {
      if (placeholders.test(result.data[key])) throw new Error(`Invalid bot environment: ${key}`);
    }
  }
  return result.data;
}
