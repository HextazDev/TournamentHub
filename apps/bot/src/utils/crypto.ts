import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function resolveKey(rawKey?: string): Buffer {
  const configured = rawKey ?? process.env.INTEGRATION_ENCRYPTION_KEY ?? process.env.BOT_API_SECRET;
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "SEC-01: Aucune clé de chiffrement valide configurée en production (INTEGRATION_ENCRYPTION_KEY ou BOT_API_SECRET requis)"
      );
    }
  }
  const source = configured ?? "dev-integration-key";
  if (/^[0-9a-fA-F]{64}$/.test(source)) {
    return Buffer.from(source, "hex");
  }
  return createHash("sha256").update(source).digest();
}

/**
 * SEC-28 : chiffre un objet secret (ex: clé API BYOK, refresh token OAuth) en AES-256-GCM
 * avec un IV aléatoire de 96 bits et un tag d'authenticité de 128 bits.
 */
export function encryptSecretPayload(payload: unknown, rawKey?: string): string {
  const key = resolveKey(rawKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * SEC-28 : déchiffre et vérifie l'authenticité GCM d'un secret stocké dans `organization_integration_secrets`.
 */
export function decryptSecretPayload<T = Record<string, unknown>>(encryptedPayload: string, rawKey?: string): T {
  const parts = encryptedPayload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Format de secret chiffré invalide");
  }
  const [, ivHex, tagHex, cipherHex] = parts;
  if (!ivHex || !tagHex || !cipherHex) {
    throw new Error("Composants du secret chiffré manquants");
  }
  const key = resolveKey(rawKey);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(cipherHex, "hex")), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}
