import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/supabase", () => ({
  supabase: { from: vi.fn() },
}));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { supabase } from "../lib/supabase";
import { ScoreService } from "../services/ScoreService";

function mockTables(rows: Record<string, unknown>) {
  vi.mocked(supabase.from).mockImplementation(((table: string) => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      single: () =>
        Promise.resolve(
          table in rows
            ? { data: rows[table], error: null }
            : { data: null, error: { code: "PGRST116", message: "no rows" } },
        ),
      maybeSingle: () =>
        Promise.resolve(
          table in rows
            ? { data: rows[table], error: null }
            : { data: null, error: null },
        ),
    };
    return builder;
  }) as unknown as typeof supabase.from);
}

function selectMenuInteraction() {
  return {
    customId: "select_match_to_score",
    values: ["match-1"],
    user: { id: "captain-1" },
    guildId: "guild-1",
    deferReply: vi.fn(),
    editReply: vi.fn(),
  };
}

describe("ScoreService - I18N-03 localized replies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers in English when the server language is en", async () => {
    mockTables({
      organizations: { id: "org-1", slug: "org-1", language: "en" },
      organization_integrations: { organization_id: "org-1", provider: "DISCORD", external_id: "guild-1", enabled: true },
    });
    const interaction = selectMenuInteraction();

    await ScoreService.handleSelectMenu(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledWith({ content: "❌ Match not found." });
  });

  it("answers in French when the server language is fr", async () => {
    mockTables({
      organizations: { id: "org-1", slug: "org-1", language: "fr" },
      organization_integrations: { organization_id: "org-1", provider: "DISCORD", external_id: "guild-1", enabled: true },
    });
    const interaction = selectMenuInteraction();

    await ScoreService.handleSelectMenu(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledWith({ content: "❌ Match introuvable." });
  });
});
