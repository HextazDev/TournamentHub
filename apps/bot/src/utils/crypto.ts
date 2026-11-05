import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function resolveKey(rawKey?: string): Buffer {
  const configured = rawKey ?? process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!configured) {
    if (process.env.NODE_ENV === "test") {
      return createHash("sha256").update("test-integration-key").digest();
    }
    throw new Error(
      "SEC-03: Variable INTEGRATION_ENCRYPTION_KEY obligatoire pour le chiffrement des intégrations",
    );
  }
  if (/^[0-9a-fA-F]{64}$/.test(configured)) {
    return Buffer.from(configured, "hex");
  }
  return createHash("sha256").update(configured).digest();
}

/**
 * SEC-28 / SEC-03: Chiffre un objet secret en AES-256-GCM.
 * Format du blob: v1:<key_version>:<iv>:<tag>:<ciphertext>
 */
export function encryptSecretPayload(payload: unknown, rawKey?: string, keyVersion = 1): string {
  const key = resolveKey(rawKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${keyVersion}:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * SEC-28 / SEC-03: Déchiffre et vérifie l'authenticité GCM d'un secret.
 * Supporte le format v1:<key_version>:<iv>:<tag>:<ciphertext> (5 segments)
 * et rétro-compatible avec v1:<iv>:<tag>:<ciphertext> (4 segments).
 */
export function decryptSecretPayload<T = Record<string, unknown>>(encryptedPayload: string, rawKey?: string): T {
  const parts = encryptedPayload.split(":");
  if (parts[0] !== "v1") {
    throw new Error("Format de secret chiffré invalide");
  }

  let ivHex: string | undefined;
  let tagHex: string | undefined;
  let cipherHex: string | undefined;

  if (parts.length === 5) {
    // Format v1:<key_version>:<iv>:<tag>:<cipher>
    [, , ivHex, tagHex, cipherHex] = parts;
  } else if (parts.length === 4) {
    // Format legacy v1:<iv>:<tag>:<cipher>
    [, ivHex, tagHex, cipherHex] = parts;
  } else {
    throw new Error("Format de secret chiffré invalide");
  }

  if (!ivHex || !tagHex || !cipherHex) {
    throw new Error("Composants du secret chiffré manquants");
  }
  const key = resolveKey(rawKey);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(cipherHex, "hex")), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}
