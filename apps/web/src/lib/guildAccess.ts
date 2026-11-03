import { z } from "zod";
import type { GuildAccess, GuildAdminReason } from "@hub/shared";

// Décision d'accès au back-office côté web (SEC-11 / SEC-17) : seul le bot décide, avec la même source et le
// même cache que ses routes de mutation. guild_admins n'est qu'un annuaire pour le hub, jamais une autorisation.

export type GuildAdminAccess =
  | { allowed: true; access: GuildAccess }
  | { allowed: false; reason: "NOT_LOGGED_IN" | "NOT_A_MEMBER" | "NO_RIGHTS" | "BOT_NOT_IN_GUILD" | "CHECK_FAILED" };

// Miroir local des types @hub/shared (@hub/shared embarque zod 3, le web zod 4 : les schémas ne se mélangent pas).
const GuildAdminReasonSchema = z.enum(["SERVER_OWNER", "ADMINISTRATOR", "MANAGE_GUILD", "TO_ROLE"]) satisfies z.ZodType<GuildAdminReason>;

const GuildAccessSchema = z.discriminatedUnion("level", [
  z.object({ level: z.literal("SERVER"), reason: GuildAdminReasonSchema }),
  z.object({ level: z.literal("TOURNAMENT"), tournamentIds: z.array(z.string().min(1)) }),
]) satisfies z.ZodType<GuildAccess>;

const PermissionResponseSchema = z.discriminatedUnion("hasPermission", [
  z.object({ hasPermission: z.literal(true), access: GuildAccessSchema }),
  z.object({ hasPermission: z.literal(false), reason: z.enum(["NOT_A_MEMBER", "NO_RIGHTS", "BOT_NOT_IN_GUILD"]) }),
]);

export interface GuildAccessCheckInput {
  guildId: string;
  discordId: string | null;
  botApiUrl: string;
  botApiSecret: string | undefined;
  fetchImpl: typeof fetch;
}

const CHECK_FAILED: GuildAdminAccess = { allowed: false, reason: "CHECK_FAILED" };

/** Fermée par défaut : secret manquant, bot injoignable, panne ou réponse inattendue ➜ CHECK_FAILED. */
export async function checkGuildAdminAccess(input: GuildAccessCheckInput): Promise<GuildAdminAccess> {
  if (!input.discordId) return { allowed: false, reason: "NOT_LOGGED_IN" };
  if (!input.botApiSecret) {
    console.error("[access] BOT_API_SECRET is missing");
    return CHECK_FAILED;
  }

  const params = new URLSearchParams({ guildId: input.guildId, userId: input.discordId });
  const res = await input
    .fetchImpl(`${input.botApiUrl}/api/discord/permissions?${params}`, {
      headers: { Authorization: `Bearer ${input.botApiSecret}` },
      cache: "no-store",
    })
    .catch((error: unknown) => {
      console.error("[access] Bot unreachable:", error);
      return null;
    });
  if (!res?.ok) {
    if (res) console.error("[access] Bot permission check failed:", res.status);
    return CHECK_FAILED;
  }

  const body: unknown = await res.json().catch(() => null);
  const parsed = PermissionResponseSchema.safeParse(body);
  if (!parsed.success) {
    console.error("[access] Unexpected bot permission payload:", parsed.error.message);
    return CHECK_FAILED;
  }
  return parsed.data.hasPermission
    ? { allowed: true, access: parsed.data.access }
    : { allowed: false, reason: parsed.data.reason };
}
