import { AccessDeniedCodeSchema, INTERNAL_ERROR_CODE, type AccessDeniedCode } from "@hub/shared";
import { t } from "../i18n";
import type { Locale } from "../i18n/types";

/** Corps d'erreur utilisé par les proxys quand le bot ne répond pas : traité comme une vérification impossible. */
export const BOT_UNREACHABLE = { code: "CHECK_FAILED" } as const;

/**
 * SEC-18 : un refus d'accès du bot (`{ error, code }`) devient un message traduit pour l'utilisateur.
 * Renvoie null pour toute autre erreur (erreur métier), qui est relayée telle quelle.
 */
export function botAccessError(payload: unknown, locale: Locale): { error: string; code: AccessDeniedCode } | null {
  if (!payload || typeof payload !== "object" || !("code" in payload)) return null;
  const code = AccessDeniedCodeSchema.safeParse(payload.code);
  if (!code.success) return null;
  return { error: t(locale, `access.${code.data}`), code: code.data };
}

/**
 * SEC-19 : un échec serveur du bot (`{ error: "Internal Server Error", code: "INTERNAL_ERROR" }`) devient
 * un message générique traduit. Renvoie null pour tout autre corps.
 */
export function botInternalError(payload: unknown, locale: Locale): { error: string } | null {
  if (!payload || typeof payload !== "object" || !("code" in payload) || payload.code !== INTERNAL_ERROR_CODE) return null;
  return { error: t(locale, "common.internalError") };
}

/**
 * Corps d'erreur renvoyé au navigateur par un proxy dédié à partir du corps brut du bot :
 * refus d'accès ou échec serveur traduit, sinon le message métier `{ error }` du bot, sinon un message générique traduit.
 */
export function relayedBotError(rawBody: string, locale: Locale): { error: string; code?: AccessDeniedCode } {
  let payload: unknown = null;
  try {
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    // Corps non JSON (page d'erreur d'un proxy intermédiaire) : jamais affiché tel quel.
    payload = null;
  }
  const access = botAccessError(payload, locale);
  if (access) return access;
  const internal = botInternalError(payload, locale);
  if (internal) return internal;
  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" && payload.error) {
    return { error: payload.error };
  }
  return { error: t(locale, "common.unknown") };
}
