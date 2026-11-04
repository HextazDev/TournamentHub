import { PermissionResponseSchema, type OrganizationAccess } from "@hub/shared";

// Décision d'accès au back-office côté web (SEC-11 / SEC-17) : seul le bot décide, avec la même source et le
// même cache que ses routes de mutation. guild_admins / organization_members ne sert qu'à lister les serveurs du hub.

export type GuildAdminAccess =
  | { allowed: true; access: OrganizationAccess }
  | { allowed: false; reason: "NOT_LOGGED_IN" | "NOT_A_MEMBER" | "NO_RIGHTS" | "BOT_NOT_IN_GUILD" | "CHECK_FAILED" };

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
