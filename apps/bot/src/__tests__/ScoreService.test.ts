import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({ current: null as FakeSupabase | null }));

vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (!db.current) throw new Error("FakeSupabase non initialisé");
      return db.current.from(table);
    },
  },
}));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../services/LeaderboardService", () => ({
  LeaderboardService: {
    calculateGroupStandings: vi.fn().mockResolvedValue(undefined),
    calculateSwissStandings: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../services/LifecycleService", () => ({
  LifecycleService: { syncPhaseChannels: vi.fn().mockResolvedValue(undefined) },
}));

import { ScoreService } from "../services/ScoreService";
import { LeaderboardService } from "../services/LeaderboardService";
import { LifecycleService } from "../services/LifecycleService";

const OPP_CAPTAIN = "captain-b";

function seed(status: string, overrides: Record<string, unknown> = {}) {
  db.current = new FakeSupabase({
    matches: [{
      id: "match-1",
      phase_id: null,
      group_id: "group-1",
      team1_id: "team-a",
      team2_id: "team-b",
      team1_score: 2,
      team2_score: 1,
      status,
      reported_by_team_id: "team-a",
      ...overrides,
    }],
    teams: [
      { id: "team-a", name: "Alpha", captain_discord_id: "captain-a" },
      { id: "team-b", name: "Bravo", captain_discord_id: OPP_CAPTAIN },
    ],
    server_settings: [{ guild_id: "guild-1", language: "fr", to_role_id: "role-to" }],
  });
  return db.current;
}

function buttonInteraction(action: "val" | "deny", userId = OPP_CAPTAIN) {
  return {
    customId: `btn_score_${action}_match-1_team-b`,
    user: { id: userId },
    guildId: "guild-1",
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    message: { embeds: [{ title: "⏳ Score en attente de validation", description: "Alpha 2 - 1 Bravo" }] },
    channel: { send: vi.fn().mockResolvedValue(undefined) },
    client: {},
  };
}

const matchStatus = (fake: FakeSupabase) => fake.tables.matches?.[0]?.status;

describe("ScoreService.handleButton - SCR-05 idempotence valider / contester", () => {
  let progressSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    progressSpy = vi.spyOn(ScoreService, "progressTeams").mockResolvedValue(undefined);
  });

  it("SCR-05: validation ➜ COMPLETED, boutons retirés du message d'origine (deferUpdate), une progression", async () => {
    const fake = seed("WAITING_VALIDATION");
    const interaction = buttonInteraction("val");

    await ScoreService.handleButton(interaction as never);

    expect(matchStatus(fake)).toBe("COMPLETED");
    expect(fake.tables.matches?.[0]).toMatchObject({ winner_id: "team-a", loser_id: "team-b" });
    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
    expect(progressSpy).toHaveBeenCalledTimes(1);
    expect(LeaderboardService.calculateGroupStandings).toHaveBeenCalledTimes(1);
  });

  it("SCR-05: double clic « Valider » ➜ une seule progression, second clic refusé en éphémère", async () => {
    const fake = seed("WAITING_VALIDATION");
    const first = buttonInteraction("val");
    const second = buttonInteraction("val");

    await ScoreService.handleButton(first as never);
    await ScoreService.handleButton(second as never);

    expect(progressSpy).toHaveBeenCalledTimes(1);
    expect(LeaderboardService.calculateGroupStandings).toHaveBeenCalledTimes(1);
    expect(fake.writesTo("matches", "update").filter(w => w.affected > 0)).toHaveLength(1);
    expect(second.followUp).toHaveBeenCalledWith({ content: "⚠️ Ce score a déjà été traité.", ephemeral: true });
  });

  it("SCR-05: clics concurrents (même état lu) ➜ l'update conditionnel n'en laisse passer qu'un", async () => {
    const fake = seed("WAITING_VALIDATION");
    // Le second clic a lu le match avant que le premier n'écrive : il voit encore WAITING_VALIDATION.
    fake.staleReads.matches = fake.tables.matches?.map(r => ({ ...r })) ?? [];
    const first = buttonInteraction("val");
    const second = buttonInteraction("val");

    await ScoreService.handleButton(first as never);
    await ScoreService.handleButton(second as never);

    expect(progressSpy).toHaveBeenCalledTimes(1);
    expect(LeaderboardService.calculateGroupStandings).toHaveBeenCalledTimes(1);
    expect(second.followUp).toHaveBeenCalledWith({ content: "⚠️ Ce score a déjà été traité.", ephemeral: true });
    expect(second.editReply).toHaveBeenCalledWith({ components: [] });
  });

  it("SCR-05: valider un match CONTESTED ➜ refus éphémère, aucune écriture", async () => {
    const fake = seed("CONTESTED");
    const interaction = buttonInteraction("val");

    await ScoreService.handleButton(interaction as never);

    expect(fake.writesTo("matches", "update").filter(w => w.affected > 0)).toHaveLength(0);
    expect(matchStatus(fake)).toBe("CONTESTED");
    expect(progressSpy).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith({ content: "⚠️ Ce score a déjà été traité.", ephemeral: true });
  });

  it("SCR-05: valider un match COMPLETED (forcé par un TO) ➜ refus, aucune progression", async () => {
    const fake = seed("COMPLETED", { team1_score: 0, team2_score: 3, winner_id: "team-b", loser_id: "team-a" });
    const interaction = buttonInteraction("val");

    await ScoreService.handleButton(interaction as never);

    expect(fake.tables.matches?.[0]).toMatchObject({ status: "COMPLETED", winner_id: "team-b", loser_id: "team-a" });
    expect(fake.writesTo("matches", "update").filter(w => w.affected > 0)).toHaveLength(0);
    expect(progressSpy).not.toHaveBeenCalled();
    expect(LeaderboardService.calculateGroupStandings).not.toHaveBeenCalled();
  });

  it("SCR-05: contester ➜ CONTESTED, boutons retirés du message d'origine", async () => {
    const fake = seed("WAITING_VALIDATION");
    const interaction = buttonInteraction("deny");

    await ScoreService.handleButton(interaction as never);

    expect(matchStatus(fake)).toBe("CONTESTED");
    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
    expect(progressSpy).not.toHaveBeenCalled();
  });

  it("SCR-05: contester un match COMPLETED ➜ refus, le match reste COMPLETED", async () => {
    const fake = seed("COMPLETED", { winner_id: "team-a", loser_id: "team-b" });
    const interaction = buttonInteraction("deny");

    await ScoreService.handleButton(interaction as never);

    expect(matchStatus(fake)).toBe("COMPLETED");
    expect(fake.writesTo("matches", "update").filter(w => w.affected > 0)).toHaveLength(0);
    expect(interaction.followUp).toHaveBeenCalledWith({ content: "⚠️ Ce score a déjà été traité.", ephemeral: true });
  });

  it("SCR-04: un joueur autre que le capitaine adverse ➜ refus éphémère, message d'origine intact", async () => {
    const fake = seed("WAITING_VALIDATION");
    const interaction = buttonInteraction("val", "captain-a");

    await ScoreService.handleButton(interaction as never);

    expect(matchStatus(fake)).toBe("WAITING_VALIDATION");
    expect(fake.writesTo("matches", "update")).toHaveLength(0);
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: "❌ Seul le capitaine adverse peut valider ou contester ce score.",
      ephemeral: true,
    });
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(progressSpy).not.toHaveBeenCalled();
  });
});

describe("ScoreService.progressTeams - SWS-06 ronde suisse déjà générée", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("SWS-06: dernier match d'une ronde revalidé alors que la ronde suivante existe ➜ ni insertion ni annonce", async () => {
    const fake = new FakeSupabase({
      phases: [{ id: "phase-s", format: "SWISS", tournament_id: "tour-1", settings: { swiss_rounds_count: 3 } }],
      tournaments: [{ id: "tour-1", guild_id: "guild-1", language: "fr" }],
      phase_teams: [
        { phase_id: "phase-s", team_id: "t1", points: 3, wins: 1 },
        { phase_id: "phase-s", team_id: "t2", points: 0, wins: 0 },
      ],
      matches: [
        { id: "r1", phase_id: "phase-s", round_number: 1, team1_id: "t1", team2_id: "t2", status: "COMPLETED" },
        { id: "r2", phase_id: "phase-s", round_number: 2, team1_id: "t1", team2_id: "t2", status: "PENDING" },
      ],
    });
    db.current = fake;
    const channel = { guildId: "guild-1", send: vi.fn().mockResolvedValue(undefined) };
    const match = fake.tables.matches?.[0];

    await ScoreService.progressTeams(match, channel as never, "t1", "t2", {});

    expect(fake.writesTo("matches", "insert")).toHaveLength(0);
    expect(channel.send).not.toHaveBeenCalled();
    expect(LifecycleService.syncPhaseChannels).not.toHaveBeenCalled();
  });
});
