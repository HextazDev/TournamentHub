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
  const key = parseIntegrationKey(configured);
  if (!key) throw new Error("SEC-03: INTEGRATION_ENCRYPTION_KEY doit contenir 32 octets (64 caractères hex ou base64)");
  return key;
}

/**
 * CLN-03: Résout la clé correspondant à la version du blob (`v1:<key_version>:...`).
 * Version 1 : INTEGRATION_ENCRYPTION_KEY ; versions suivantes : INTEGRATION_ENCRYPTION_KEY_V<n>.
 * Une `rawKey` explicite court-circuite la résolution (tests et appels internes). En test sans clé
 * configurée, la clé dérivée de dev s'applique à toutes les versions.
 */
function resolveKeyForVersion(keyVersion: number, rawKey?: string): Buffer {
  if (rawKey) return resolveKey(rawKey);
  if (keyVersion === 1) return resolveKey();

  const versioned = process.env[`INTEGRATION_ENCRYPTION_KEY_V${keyVersion}`];
  if (!versioned) {
    if (!process.env.INTEGRATION_ENCRYPTION_KEY && process.env.NODE_ENV === "test") {
      return resolveKey();
    }
    throw new Error(
      `SEC-03: Aucune clé configurée pour la version ${keyVersion} (INTEGRATION_ENCRYPTION_KEY_V${keyVersion})`,
    );
  }
  const key = parseIntegrationKey(versioned);
  if (!key) {
    throw new Error(
      `SEC-03: INTEGRATION_ENCRYPTION_KEY_V${keyVersion} doit contenir 32 octets (64 caractères hex ou base64)`,
    );
  }
  return key;
}

/** Clé maîtresse de 32 octets en hexadécimal ou en base64 (RFC 5.2) ; `null` pour tout autre format. */
export function parseIntegrationKey(value: string): Buffer | null {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "") ? decoded : null;
}

/**
 * SEC-28 / SEC-03: Chiffre un objet secret en AES-256-GCM.
 * Format du blob: v1:<key_version>:<iv>:<tag>:<ciphertext>
 */
export function encryptSecretPayload(payload: unknown, rawKey?: string, keyVersion = 1): string {
  const key = resolveKeyForVersion(keyVersion, rawKey);
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

  let keyVersion = 1;

  if (parts.length === 5) {
    // Format v1:<key_version>:<iv>:<tag>:<cipher>
    const parsedVersion = Number.parseInt(parts[1] ?? "", 10);
    if (!Number.isInteger(parsedVersion) || parsedVersion < 1) {
      throw new Error("Version de clé de chiffrement invalide");
    }
    keyVersion = parsedVersion;
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
  const key = resolveKeyForVersion(keyVersion, rawKey);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(cipherHex, "hex")), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}
