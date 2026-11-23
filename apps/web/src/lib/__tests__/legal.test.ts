import { describe, expect, it } from "vitest";
import { resolveLegalConfig } from "../legal";

describe("resolveLegalConfig", () => {
  it("resolves trimmed operator fields and siteUrl from environment variables", () => {
    const config = resolveLegalConfig({
      LEGAL_PUBLISHER_NAME: "  TournamentHub Assoc  ",
      LEGAL_CONTACT_EMAIL: "  contact@tournamenthub.example  ",
      LEGAL_HOST_NAME: "  Hetzner Online GmbH ",
      LEGAL_HOST_ADDRESS: "  Industriestr. 25, 91710 Gunzenhausen, Germany  ",
      NEXTAUTH_URL: "https://hub.example.com/",
    });

    expect(config).toEqual({
      publisherName: "TournamentHub Assoc",
      contactEmail: "contact@tournamenthub.example",
      hostName: "Hetzner Online GmbH",
      hostAddress: "Industriestr. 25, 91710 Gunzenhausen, Germany",
      siteUrl: "https://hub.example.com",
    });
  });

  it("returns null for absent, empty, or whitespace-only environment variables", () => {
    const config = resolveLegalConfig({
      LEGAL_PUBLISHER_NAME: "",
      LEGAL_CONTACT_EMAIL: "   ",
      LEGAL_HOST_NAME: undefined,
      LEGAL_HOST_ADDRESS: "\t\n",
      NEXTAUTH_URL: "",
    });

    expect(config).toEqual({
      publisherName: null,
      contactEmail: null,
      hostName: null,
      hostAddress: null,
      siteUrl: null,
    });
  });

  it("rejects malformed or unsafe contact emails to prevent broken mailto links", () => {
    for (const invalidEmail of [
      "not-an-email",
      "contact@example.com?subject=test",
      "javascript:alert(1)",
      "foo@bar",
      "user name@example.com",
    ]) {
      const config = resolveLegalConfig({ LEGAL_CONTACT_EMAIL: invalidEmail });
      expect(config.contactEmail).toBeNull();
    }
  });

  it("rejects non-http(s) or invalid NEXTAUTH_URL values", () => {
    for (const invalidUrl of [
      "javascript:alert(1)",
      "ftp://files.example.com",
      "not a url",
    ]) {
      const config = resolveLegalConfig({ NEXTAUTH_URL: invalidUrl });
      expect(config.siteUrl).toBeNull();
    }
  });
});
