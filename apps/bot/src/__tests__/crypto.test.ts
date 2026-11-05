import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptSecretPayload, decryptSecretPayload } from "../utils/crypto.js";

describe("crypto utils - AES-256-GCM (SEC-01 & SEC-28)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("Chiffrement et déchiffrement nominal", () => {
    it("chiffre et déchiffre fidèlement un objet JSON complexe avec clé dérivée par défaut en dev/test", () => {
      delete process.env.INTEGRATION_ENCRYPTION_KEY;
      delete process.env.BOT_API_SECRET;
      process.env.NODE_ENV = "test";

      const payload = {
        apiKey: "sk-live-1234567890abcdef",
        endpoint: "https://api.start.gg/gql",
        nested: { count: 42, active: true, tags: ["esport", "splatoon"] },
        empty: null,
      };

      const encrypted = encryptSecretPayload(payload);
      expect(encrypted).toMatch(/^v1:\d+:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);

      const decrypted = decryptSecretPayload<typeof payload>(encrypted);
      expect(decrypted).toEqual(payload);
    });

    it("utilise une clé hexadécimale de 64 caractères (32 octets) brute", () => {
      const hexKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const payload = { token: "secret-token-xyz" };

      const encrypted = encryptSecretPayload(payload, hexKey);
      const decrypted = decryptSecretPayload<typeof payload>(encrypted, hexKey);

      expect(decrypted).toEqual(payload);
    });

    it("accepte une clé base64 de 32 octets", () => {
      const base64Key = Buffer.alloc(32, 7).toString("base64");
      const payload = { webhookSecret: "whsec_abcdef" };
      expect(decryptSecretPayload<typeof payload>(encryptSecretPayload(payload, base64Key), base64Key)).toEqual(payload);
    });

    it("SEC-07: refuse une clé qui ne fait pas 32 octets (pas de dérivation silencieuse d'une phrase)", () => {
      expect(() => encryptSecretPayload({ a: 1 }, "my-super-secret-passphrase-with-high-entropy")).toThrowError("32 octets");
    });

    it("génère des IV uniques produisant des ciphertexts distincts pour le même payload", () => {
      const payload = { secret: "same-content" };

      const enc1 = encryptSecretPayload(payload);
      const enc2 = encryptSecretPayload(payload);

      expect(enc1).not.toBe(enc2);
      expect(decryptSecretPayload(enc1)).toEqual(payload);
      expect(decryptSecretPayload(enc2)).toEqual(payload);
    });
  });

  describe("Garde-fou de production et SEC-03", () => {
    it("lève une exception bloquante si NODE_ENV !== 'test' et qu'aucune clé n'est configurée (chiffrement)", () => {
      process.env.NODE_ENV = "production";
      delete process.env.INTEGRATION_ENCRYPTION_KEY;
      delete process.env.BOT_API_SECRET;

      expect(() => {
        encryptSecretPayload({ secret: "should-not-encrypt" });
      }).toThrowError("SEC-03: Variable INTEGRATION_ENCRYPTION_KEY obligatoire pour le chiffrement des intégrations");
    });

    it("lève une exception bloquante si NODE_ENV !== 'test' et qu'aucune clé n'est configurée (déchiffrement)", () => {
      process.env.NODE_ENV = "production";
      delete process.env.INTEGRATION_ENCRYPTION_KEY;
      delete process.env.BOT_API_SECRET;

      const dummyEncrypted = "v1:1:0123456789abcdef01234567:0123456789abcdef0123456789abcdef:01234567";

      expect(() => {
        decryptSecretPayload(dummyEncrypted);
      }).toThrowError("SEC-03: Variable INTEGRATION_ENCRYPTION_KEY obligatoire pour le chiffrement des intégrations");
    });

    it("fonctionne en production si INTEGRATION_ENCRYPTION_KEY est défini", () => {
      process.env.NODE_ENV = "production";
      process.env.INTEGRATION_ENCRYPTION_KEY = "a".repeat(64);
      delete process.env.BOT_API_SECRET;

      const payload = { clientSecret: "prod-secret" };
      const encrypted = encryptSecretPayload(payload);
      const decrypted = decryptSecretPayload<typeof payload>(encrypted);

      expect(decrypted).toEqual(payload);
    });

    it("SEC-03: refuse BOT_API_SECRET comme repli et exige INTEGRATION_ENCRYPTION_KEY", () => {
      process.env.NODE_ENV = "production";
      delete process.env.INTEGRATION_ENCRYPTION_KEY;
      process.env.BOT_API_SECRET = "prod-bot-secret-fallback-12345";

      expect(() => {
        encryptSecretPayload({ clientSecret: "prod-secret" });
      }).toThrowError("SEC-03: Variable INTEGRATION_ENCRYPTION_KEY obligatoire pour le chiffrement des intégrations");
    });

    it("fonctionne en production si une rawKey explicite est transmise", () => {
      process.env.NODE_ENV = "production";
      delete process.env.INTEGRATION_ENCRYPTION_KEY;
      delete process.env.BOT_API_SECRET;

      const payload = { clientSecret: "prod-secret-rawkey" };
      const explicitKey = "b".repeat(64);
      const encrypted = encryptSecretPayload(payload, explicitKey);
      const decrypted = decryptSecretPayload<typeof payload>(encrypted, explicitKey);

      expect(decrypted).toEqual(payload);
    });
  });

  describe("Détection d'intégrité et rejets AES-256-GCM", () => {
    it("rejette un payload au format invalide (version différente ou structure tronquée)", () => {
      expect(() => decryptSecretPayload("invalid-payload")).toThrowError("Format de secret chiffré invalide");
      expect(() => decryptSecretPayload("v2:iv:tag:cipher")).toThrowError("Format de secret chiffré invalide");
      expect(() => decryptSecretPayload("v1:iv:tag")).toThrowError("Format de secret chiffré invalide");
    });

    it("rejette des composants de secret vides", () => {
      expect(() => decryptSecretPayload("v1::tag:cipher")).toThrowError("Composants du secret chiffré manquants");
      expect(() => decryptSecretPayload("v1:iv::cipher")).toThrowError("Composants du secret chiffré manquants");
      expect(() => decryptSecretPayload("v1:iv:tag:")).toThrowError("Composants du secret chiffré manquants");
    });

    it("échoue lors du déchiffrement avec un tag GCM corrompu", () => {
      const payload = { test: "tamper-proof" };
      const encrypted = encryptSecretPayload(payload);
      const parts = encrypted.split(":");
      // altérer le tag d'authentification
      const corruptedTag = parts[2]!.replace(/^[0-9a-f]/, (c) => (c === "0" ? "1" : "0"));
      const corruptedPayload = `${parts[0]}:${parts[1]}:${corruptedTag}:${parts[3]}`;

      expect(() => decryptSecretPayload(corruptedPayload)).toThrow();
    });

    it("échoue lors du déchiffrement avec un ciphertext altéré", () => {
      const payload = { test: "tamper-proof" };
      const encrypted = encryptSecretPayload(payload);
      const parts = encrypted.split(":");
      // altérer le ciphertext
      const corruptedCipher = parts[3]!.replace(/^[0-9a-f]/, (c) => (c === "0" ? "1" : "0"));
      const corruptedPayload = `${parts[0]}:${parts[1]}:${parts[2]}:${corruptedCipher}`;

      expect(() => decryptSecretPayload(corruptedPayload)).toThrow();
    });

    it("échoue lors du déchiffrement avec une mauvaise clé", () => {
      const payload = { test: "wrong-key" };
      const encrypted = encryptSecretPayload(payload, "a".repeat(64));

      expect(() => decryptSecretPayload(encrypted, "b".repeat(64))).toThrow();
    });
  });
});
