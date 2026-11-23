import { z } from "zod";

export const LEGAL_LAST_UPDATED_ISO = "2026-11-23";

export interface LegalConfig {
  publisherName: string | null;
  contactEmail: string | null;
  hostName: string | null;
  hostAddress: string | null;
  siteUrl: string | null;
}

const emailSchema = z.string().email().refine((val) => !/[?&#\s]/.test(val));

function readTrimmedEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string | null {
  const raw = Reflect.get(env, key);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeHttpUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return raw.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Resolves optional instance-specific legal metadata from server environment variables.
 * Never hardcodes personal operator information in the repository so self-hosted
 * instances can configure their own publisher, contact, and hosting details at runtime.
 */
export function resolveLegalConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LegalConfig {
  const rawEmail = readTrimmedEnv(env, "LEGAL_CONTACT_EMAIL");
  const parsedEmail = rawEmail ? emailSchema.safeParse(rawEmail) : null;

  return {
    publisherName: readTrimmedEnv(env, "LEGAL_PUBLISHER_NAME"),
    contactEmail: parsedEmail?.success ? parsedEmail.data : null,
    hostName: readTrimmedEnv(env, "LEGAL_HOST_NAME"),
    hostAddress: readTrimmedEnv(env, "LEGAL_HOST_ADDRESS"),
    siteUrl: normalizeHttpUrl(readTrimmedEnv(env, "NEXTAUTH_URL")),
  };
}
