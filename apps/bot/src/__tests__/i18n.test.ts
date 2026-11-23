import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/supabase", () => ({
  supabase: { from: vi.fn() },
}));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { supabase } from "../lib/supabase";
import { logger } from "../utils/logger";
import { tBot, getGuildLanguage, isBotLocale } from "../i18n";
import { fr } from "../i18n/locales/fr";
import { en } from "../i18n/locales/en";

type Row = { data: unknown; error: { code?: string; message: string } | null };

/** Chaque table renvoie la réponse fournie à `.single()` ou `.maybeSingle()`, quel que soit le filtre. */
function mockTables(rows: Record<string, Row>) {
  vi.mocked(supabase.from).mockImplementation(((table: string) => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      single: () => Promise.resolve(rows[table] ?? { data: null, error: { code: "PGRST116", message: "no rows" } }),
      maybeSingle: () => {
        const row = rows[table];
        if (row && row.error) return Promise.resolve(row);
        return Promise.resolve(row ?? { data: null, error: null });
      },
    };
    return builder;
  }) as unknown as typeof supabase.from);
}

function leaves(obj: object, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else for (const [ck, cv] of leaves(v as object, key)) out.set(ck, cv);
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("Bot i18n dictionaries", () => {
  const frLeaves = leaves(fr);
  const enLeaves = leaves(en);

  it("I18N-PAR: fr and en expose exactly the same keys", () => {
    expect([...enLeaves.keys()].sort()).toEqual([...frLeaves.keys()].sort());
  });

  it("I18N-PAR: every key uses the same {placeholders} in fr and en", () => {
    for (const [key, value] of frLeaves) {
      expect(placeholders(enLeaves.get(key) ?? ""), key).toEqual(placeholders(value));
    }
  });

  it("interpolates params and falls back to fr for an unknown locale value", () => {
    expect(tBot("en", "score.swissRoundGenerated", { round: 3 })).toBe("🇨🇭 Round 3 generated!");
    expect(tBot("fr", "score.swissRoundGenerated", { round: 3 })).toBe("🇨🇭 Ronde 3 générée !");
  });
});

describe("isBotLocale", () => {
  it("accepts only supported locales", () => {
    expect(isBotLocale("fr")).toBe(true);
    expect(isBotLocale("en")).toBe(true);
    expect(isBotLocale("de")).toBe(false);
    expect(isBotLocale(undefined)).toBe(false);
  });
});

describe("getGuildLanguage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers the tournament language over the server language", async () => {
    mockTables({
      tournaments: { data: { language: "en" }, error: null },
      organizations: { data: { id: "org-1", slug: "org-1", language: "fr" }, error: null },
      organization_integrations: {
        data: { organization_id: "org-1", provider: "DISCORD", external_id: "guild-1", enabled: true },
        error: null,
      },
    });
    expect(await getGuildLanguage("guild-1", "tourney-1")).toBe("en");
  });

  it("falls back to the server language when the tournament is unknown", async () => {
    mockTables({
      organizations: { data: { id: "org-1", slug: "org-1", language: "en" }, error: null },
      organization_integrations: {
        data: { organization_id: "org-1", provider: "DISCORD", external_id: "guild-1", enabled: true },
        error: null,
      },
    });
    expect(await getGuildLanguage("guild-1", "missing-tourney")).toBe("en");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("I18N-05: logs a warning instead of silently swallowing a database failure", async () => {
    mockTables({
      tournaments: { data: null, error: { code: "08006", message: "connection failure" } },
      organizations: { data: null, error: { code: "08006", message: "connection failure" } },
    });
    expect(await getGuildLanguage("guild-1", "tourney-1")).toBe("fr");
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
