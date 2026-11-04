import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({ current: null as FakeSupabase | null }));

vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (!db.current) throw new Error("FakeSupabase non initialisé");
      return db.current.from(table);
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (!db.current) throw new Error("FakeSupabase non initialisé");
      return db.current.rpc(fn, args);
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
import { tBot } from "../i18n";

function seedDatabase(matchStatus = "PENDING", matchOverrides: Record<string, unknown> = {}) {
  db.current = new FakeSupabase({
    matches: [
      {
        id: "match-1",
        phase_id: "phase-1",
        group_id: null,
        round_number: 1,
        match_number: 1,
        team1_id: "team-a",
        team2_id: "team-b",
        teamA: { id: "team-a", name: "Alpha", captain_discord_id: "captain-a" },
        teamB: { id: "team-b", name: "Bravo", captain_discord_id: "captain-b" },
        team1_score: 0,
        team2_score: 0,
        status: matchStatus,
        next_match_winner_id: "match-final",
        next_match_loser_id: "match-lb",
        ...matchOverrides,
      },
      {
        id: "match-final",
        phase_id: "phase-1",
        round_number: 2,
        match_number: 2,
        team1_id: null,
        team2_id: null,
        status: "PENDING",
      },
      {
        id: "match-lb",
        phase_id: "phase-1",
        round_number: 11,
        match_number: 3,
        team1_id: null,
        team2_id: null,
        status: "PENDING",
      },
    ],
    teams: [
      { id: "team-a", name: "Alpha", captain_discord_id: "captain-a", tournament_id: "tourney-1" },
      { id: "team-b", name: "Bravo", captain_discord_id: "captain-b", tournament_id: "tourney-1" },
    ],
    phases: [
      { id: "phase-1", tournament_id: "tourney-1", format: "SINGLE_ELIM" },
    ],
    tournaments: [
      { id: "tourney-1", guild_id: "guild-1", language: "fr" },
    ],
    server_settings: [
      { guild_id: "guild-1", language: "fr", to_role_id: "role-to" },
    ],
  });
  return db.current;
}

describe("ScoreService — Cas limites de scores & progression (SCR-01 à SCR-04, SCR-06, SCR-07)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("SCR-01: Validation des scores Discord [-99, 99]", () => {
    it.each([
      ["-1", "2"],
      ["2", "-1"],
      ["100", "2"],
      ["2", "150"],
      ["abc", "2"],
      ["2", "xyz"],
    ])("rejette le score (%s, %s) avec un message éphémère d'erreur", async (scoreA, scoreB) => {
      seedDatabase("PENDING");

      const interaction = {
        customId: "modal_score_match-1_team-a",
        guildId: "guild-1",
        fields: {
          getTextInputValue: (field: string) => (field === "my_score" ? scoreA : scoreB),
        },
        reply: vi.fn().mockResolvedValue(undefined),
        deferReply: vi.fn().mockResolvedValue(undefined),
      };

      await ScoreService.handleModalSubmit(interaction as never);

      expect(interaction.reply).toHaveBeenCalledWith({
        content: tBot("fr", "score.invalidScore"),
        ephemeral: true,
      });
      expect(interaction.deferReply).not.toHaveBeenCalled();
    });
  });

  describe("SCR-02: Vérification du rôle de capitaine lors du choix de match", () => {
    it("rejette avec un message éphémère si l'utilisateur n'est capitaine d'aucune équipe", async () => {
      seedDatabase("PENDING");

      const interaction = {
        customId: "select_match_to_score",
        values: ["match-1"],
        user: { id: "random-imposter" }, // Ni captain-a ni captain-b
        guildId: "guild-1",
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
        showModal: vi.fn().mockResolvedValue(undefined),
      };

      await ScoreService.handleSelectMenu(interaction as never);

      expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
      expect(interaction.editReply).toHaveBeenCalledWith({
        content: tBot("fr", "score.notCaptain"),
      });
      expect(interaction.showModal).not.toHaveBeenCalled();
    });

    it("affiche la modale de saisie de score si l'utilisateur est le capitaine de l'équipe", async () => {
      seedDatabase("PENDING");

      const interaction = {
        customId: "select_match_to_score",
        values: ["match-1"],
        user: { id: "captain-a" }, // Capitaine légitime de Alpha
        guildId: "guild-1",
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
        showModal: vi.fn().mockResolvedValue(undefined),
      };

      await ScoreService.handleSelectMenu(interaction as never);

      expect(interaction.showModal).toHaveBeenCalledTimes(1);
    });
  });

  describe("SCR-03: Déclaration sur un match non en attente", () => {
    it("rejette si le match n'est ni PENDING ni IN_PROGRESS (ex : COMPLETED)", async () => {
      seedDatabase("COMPLETED");

      const interaction = {
        customId: "modal_score_match-1_team-a",
        guildId: "guild-1",
        fields: {
          getTextInputValue: (field: string) => (field === "my_score" ? "2" : "1"),
        },
        reply: vi.fn().mockResolvedValue(undefined),
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
      };

      await ScoreService.handleModalSubmit(interaction as never);

      expect(interaction.deferReply).toHaveBeenCalledTimes(1);
      expect(interaction.editReply).toHaveBeenCalledWith({
        content: tBot("fr", "score.notPending"),
      });
    });
  });

  describe("SCR-04: Seul le capitaine adverse peut valider ou contester", () => {
    it("rejette si un tiers ou le capitaine déclarant tente de valider le score", async () => {
      seedDatabase("WAITING_VALIDATION");

      // Le bouton btn_score_val_match-1_team-b attend le capitaine de team-b (captain-b)
      const interaction = {
        customId: "btn_score_val_match-1_team-b",
        user: { id: "captain-a" }, // captain-a a déclaré le score, il ne peut pas le valider !
        guildId: "guild-1",
        deferUpdate: vi.fn().mockResolvedValue(undefined),
        followUp: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
      };

      await ScoreService.handleButton(interaction as never);

      expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
      expect(interaction.followUp).toHaveBeenCalledWith({
        content: tBot("fr", "score.onlyOpponentCanValidate"),
        ephemeral: true,
      });
    });
  });

  describe("SCR-06: Blocage de la progression en cas d'égalité en élimination directe", () => {
    it("n'avance aucune équipe et alerte les organisateurs en cas de match nul", async () => {
      const fake = seedDatabase("COMPLETED", {
        team1_score: 2,
        team2_score: 2,
      });

      const channel = {
        guildId: "guild-1",
        send: vi.fn().mockResolvedValue(undefined),
      };

      const match = fake.tables.matches![0]!;

      // En cas d'égalité, winnerId et loserId sont null
      await ScoreService.progressTeams(match, channel as never, null, null);

      // Aucune progression vers match-final
      const finalMatch = fake.tables.matches!.find(m => m.id === "match-final")!;
      expect(finalMatch.team1_id).toBeNull();
      expect(finalMatch.team2_id).toBeNull();

      // Alerte TO "MATCH NUL" envoyée dans le salon
      expect(channel.send).toHaveBeenCalledTimes(1);
      expect(channel.send).toHaveBeenCalledWith(
        expect.stringContaining("MATCH NUL"),
      );
    });
  });

  describe("SCR-07: Progression automatique du vainqueur et du perdant", () => {
    it("progresse le vainqueur vers next_match_winner_id et le perdant vers next_match_loser_id", async () => {
      const fake = seedDatabase("COMPLETED", {
        team1_score: 2,
        team2_score: 1,
      });

      const channel = {
        guildId: "guild-1",
        send: vi.fn().mockResolvedValue(undefined),
      };

      const match = fake.tables.matches![0]!;

      // Alpha a gagné (team-a), Bravo a perdu (team-b)
      await ScoreService.progressTeams(match, channel as never, "team-a", "team-b");

      // match-final reçoit le vainqueur (team-a)
      const finalMatch = fake.tables.matches!.find(m => m.id === "match-final")!;
      expect(finalMatch.team1_id).toBe("team-a");

      // match-lb reçoit le perdant (team-b)
      const lbMatch = fake.tables.matches!.find(m => m.id === "match-lb")!;
      expect(lbMatch.team1_id).toBe("team-b");
    });

    it("utilise le repli non atomique si la RPC assign_team_to_match échoue", async () => {
      const fake = seedDatabase("COMPLETED", {
        team1_score: 3,
        team2_score: 0,
      });

      // Simuler une erreur de la RPC Supabase
      fake.rpcHandler = (_name, _args) => {
        return { data: null, error: { message: "RPC error", code: "PGRST_ERROR" } };
      };

      const channel = {
        guildId: "guild-1",
        send: vi.fn().mockResolvedValue(undefined),
      };

      const match = fake.tables.matches![0]!;

      await ScoreService.progressTeams(match, channel as never, "team-a", "team-b");

      // Grâce au repli, team-a est quand même assignée au match suivant
      const finalMatch = fake.tables.matches!.find(m => m.id === "match-final")!;
      expect(finalMatch.team1_id).toBe("team-a");
    });

    it("notifie quand le match suivant est désormais complet (2 équipes assignées)", async () => {
      const fake = seedDatabase("COMPLETED", {
        team1_score: 2,
        team2_score: 0,
      });

      // match-final a déjà une équipe (team-b) dans team1_id
      const finalMatch = fake.tables.matches!.find(m => m.id === "match-final")!;
      finalMatch.team1_id = "team-b";

      const channel = {
        guildId: "guild-1",
        send: vi.fn().mockResolvedValue(undefined),
      };

      const match = fake.tables.matches![0]!;

      // Assigner team-a comme 2e équipe du match final
      await ScoreService.progressTeams(match, channel as never, "team-a", "team-b");

      // Le match final est maintenant complet : team1_id = team-b, team2_id = team-a
      expect(finalMatch.team1_id).toBe("team-b");
      expect(finalMatch.team2_id).toBe("team-a");

      // Une annonce de nouveau match prêt doit être envoyée
      expect(channel.send).toHaveBeenCalledWith(
        expect.stringContaining("NOUVEAU MATCH DE BRACKET"),
      );
      expect(channel.send).toHaveBeenCalledWith(
        expect.stringContaining("Bravo"),
      );
      expect(channel.send).toHaveBeenCalledWith(
        expect.stringContaining("Alpha"),
      );
    });
  });
});
