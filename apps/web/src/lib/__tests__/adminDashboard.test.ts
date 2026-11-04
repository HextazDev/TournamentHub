import { describe, it, expect } from "vitest";
import {
  calculateDashboardStats,
  computePhaseProgression,
  checkDiscordHealth,
  type DashboardTournament,
} from "../adminDashboard";
import type { ServerSettings } from "@hub/shared";

describe("adminDashboard helpers (TDD)", () => {
  describe("calculateDashboardStats", () => {
    it("comptabilise fidèlement les tournois ACTIVE et REGISTRATION comme actifs", () => {
      const tournaments: DashboardTournament[] = [
        { id: "t1", name: "Tournoi 1", status: "ACTIVE", created_at: "2026-01-01" },
        { id: "t2", name: "Tournoi 2", status: "REGISTRATION", created_at: "2026-01-02" },
        { id: "t3", name: "Tournoi 3", status: "DRAFT", created_at: "2026-01-03" },
        { id: "t4", name: "Tournoi 4", status: "COMPLETED", created_at: "2026-01-04" },
        { id: "t5", name: "Tournoi 5", status: "ARCHIVED", created_at: "2026-01-05" },
      ];

      const stats = calculateDashboardStats({
        tournaments,
        totalTeams: 12,
        totalPlayers: 48,
        pendingMatchesCount: 3,
      });

      expect(stats.totalTournaments).toBe(5);
      expect(stats.activeTournamentsCount).toBe(2);
      expect(stats.totalTeams).toBe(12);
      expect(stats.totalPlayers).toBe(48);
      expect(stats.pendingMatchesCount).toBe(3);
    });

    it("gère une liste vide de tournois sans division par zéro ni plantage", () => {
      const stats = calculateDashboardStats({
        tournaments: [],
        totalTeams: 0,
        totalPlayers: 0,
        pendingMatchesCount: 0,
      });

      expect(stats.totalTournaments).toBe(0);
      expect(stats.activeTournamentsCount).toBe(0);
      expect(stats.totalTeams).toBe(0);
      expect(stats.totalPlayers).toBe(0);
      expect(stats.pendingMatchesCount).toBe(0);
    });
  });

  describe("computePhaseProgression", () => {
    it("calcule la progression globale et détermine la phase en cours", () => {
      const phases = [
        { id: "p1", name: "Poules", phase_order: 1, format: "ROUND_ROBIN" },
        { id: "p2", name: "Arbre Final", phase_order: 2, format: "SINGLE_ELIM" },
      ];

      const matches = [
        // Poules : 4 matchs terminés (COMPLETED, FF, BYE selon enum PostgreSQL / @hub/shared)
        { phase_id: "p1", status: "COMPLETED" },
        { phase_id: "p1", status: "COMPLETED" },
        { phase_id: "p1", status: "FF" },
        { phase_id: "p1", status: "BYE" },
        // Arbre Final : 2 matchs en attente
        { phase_id: "p2", status: "PENDING" },
        { phase_id: "p2", status: "PENDING" },
      ];

      const progression = computePhaseProgression(phases, matches);

      expect(progression.totalPhases).toBe(2);
      expect(progression.totalMatches).toBe(6);
      expect(progression.completedMatches).toBe(4);
      expect(progression.progressPercent).toBe(67);
      expect(progression.currentPhaseName).toBe("Arbre Final");
    });

    it("gère un tournoi sans phase ou sans match", () => {
      const progression = computePhaseProgression([], []);
      expect(progression.totalPhases).toBe(0);
      expect(progression.totalMatches).toBe(0);
      expect(progression.completedMatches).toBe(0);
      expect(progression.progressPercent).toBe(0);
      expect(progression.currentPhaseName).toBeNull();
    });

    it("gère des phases dont aucun match n'est encore généré", () => {
      const phases = [{ id: "p1", name: "Ronde Suisse", phase_order: 1, format: "SWISS" }];
      const progression = computePhaseProgression(phases, []);
      expect(progression.totalPhases).toBe(1);
      expect(progression.totalMatches).toBe(0);
      expect(progression.progressPercent).toBe(0);
      expect(progression.currentPhaseName).toBe("Ronde Suisse");
    });
  });

  describe("checkDiscordHealth", () => {
    it("signale le bot absent si settings est null ou bot_present est false", () => {
      const healthNull = checkDiscordHealth(null);
      expect(healthNull.botPresent).toBe(false);
      expect(healthNull.isAllConfigured).toBe(false);

      const healthNotPresent = checkDiscordHealth({
        guild_id: "123",
        guild_name: "Mon Serveur",
        guild_icon: null,
        bot_present: false,
        invite_url: null,
        language: "fr",
        to_role_id: "r1",
        captain_role_id: "r2",
        announcement_channel_id: "c1",
        checkin_channel_id: "c2",
        registration_channel_id: "c3",
        updated_at: "2026-01-01",
      });
      expect(healthNotPresent.botPresent).toBe(false);
      expect(healthNotPresent.isAllConfigured).toBe(false);
    });

    it("signale visuellement chaque salon et rôle configuré ou manquant", () => {
      const settings: ServerSettings = {
        guild_id: "123",
        guild_name: "Test Guild",
        guild_icon: null,
        bot_present: true,
        invite_url: null,
        language: "fr",
        to_role_id: "111",
        captain_role_id: null, // manquant
        announcement_channel_id: "222",
        checkin_channel_id: null, // manquant
        registration_channel_id: "333",
        updated_at: "2026-01-01",
      };

      const health = checkDiscordHealth(settings);
      expect(health.botPresent).toBe(true);
      expect(health.isAllConfigured).toBe(false);
      expect(health.configuredCount).toBe(3);
      expect(health.totalItems).toBe(5);

      const toRole = health.items.find((i) => i.key === "to_role_id");
      expect(toRole?.configured).toBe(true);
      expect(toRole?.type).toBe("role");

      const captainRole = health.items.find((i) => i.key === "captain_role_id");
      expect(captainRole?.configured).toBe(false);
      expect(captainRole?.type).toBe("role");

      const checkinChannel = health.items.find((i) => i.key === "checkin_channel_id");
      expect(checkinChannel?.configured).toBe(false);
      expect(checkinChannel?.type).toBe("channel");
    });

    it("valide isAllConfigured à true quand tous les rôles et salons sont renseignés et bot présent", () => {
      const settings: ServerSettings = {
        guild_id: "123",
        guild_name: "Complet",
        guild_icon: null,
        bot_present: true,
        invite_url: null,
        language: "fr",
        to_role_id: "111",
        captain_role_id: "222",
        announcement_channel_id: "333",
        checkin_channel_id: "444",
        registration_channel_id: "555",
        updated_at: "2026-01-01",
      };

      const health = checkDiscordHealth(settings);
      expect(health.botPresent).toBe(true);
      expect(health.isAllConfigured).toBe(true);
      expect(health.configuredCount).toBe(5);
    });
  });
});
