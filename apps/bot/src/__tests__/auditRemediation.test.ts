import { beforeEach, describe, expect, it, vi } from "vitest";
import { canPerform } from "@hub/shared";
import type { Client } from "discord.js";
import { FakeSupabase } from "./helpers/fakeSupabase";
import { callRoute } from "./helpers/route";
import type { AdminCheck } from "../middleware/auth";

const db = vi.hoisted(() => ({ current: null as FakeSupabase | null }));
vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (!db.current) throw new Error("FakeSupabase non initialisé");
      return db.current.from(table);
    },
    rpc: (name: string, args: Record<string, unknown>) => db.current!.rpc(name, args),
  },
}));
vi.mock("../utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../services/ScoreService", () => ({ ScoreService: { progressTeams: vi.fn(async () => undefined) } }));
vi.mock("../services/LeaderboardService", () => ({ LeaderboardService: { calculateGroupStandings: vi.fn(async () => undefined) } }));
vi.mock("../utils/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/tenant")>()),
  verifyMatchGuild: async () => true,
}));
vi.mock("../i18n", () => ({
  tBot: (_lang: string, key: string) => key,
  getGuildLanguage: async () => "fr",
  getPhaseLanguage: async () => "fr",
}));

import { clearMemberAccessCache, resolveMemberAccess, type DiscordClientLike } from "../services/MemberAccessService";
import { matchRouter } from "../routes/MatchRouter";
import { RegistrationService } from "../services/RegistrationService";
import { LifecycleService } from "../services/LifecycleService";
import { SchedulerService } from "../services/SchedulerService";

const ORG = "00000000-0000-0000-0000-000000000011";
const T1 = "00000000-0000-0000-0000-0000000000a1";
const T_ARCHIVED = "00000000-0000-0000-0000-0000000000a2";
const GUILD = "111111111111111111";
const noDiscord: DiscordClientLike = { guilds: { fetch: () => Promise.reject(new Error("Unknown Guild")) } };

beforeEach(() => {
  vi.clearAllMocks();
  clearMemberAccessCache();
  db.current = new FakeSupabase({
    organizations: [{ id: ORG, slug: "org", name: "Org", language: "fr" }],
    organization_members: [],
    organization_integrations: [
      { id: "i1", organization_id: ORG, provider: "DISCORD", external_id: GUILD, enabled: true, status: "CONNECTED", config: {} },
    ],
    tournaments: [
      { id: T1, organization_id: ORG, guild_id: GUILD, status: "ACTIVE", name: "Cup", discord_registration_channel_id: "c1", discord_config: {} },
      { id: T_ARCHIVED, organization_id: ORG, guild_id: GUILD, status: "ARCHIVED", name: "Old" },
    ],
    tournament_staff: [],
    phases: [{ id: "p1", tournament_id: T1, format: "SINGLE_ELIM" }],
    matches: [
      { id: "m1", phase_id: "p1", team1_id: "a", team2_id: "b", status: "PENDING", phases: { tournament_id: T1 } },
      { id: "m-tbd", phase_id: "p1", team1_id: "a", team2_id: null, status: "PENDING" },
    ],
  });
});

describe("ROLE-01 : rôles casteur et statisticien (RFC Q2, 5.1)", () => {
  it.each([
    ["CASTER", false],
    ["STATISTICIAN", true],
  ] as const)("%s d'organisation : niveau TOURNAMENT sur chaque tournoi non archivé, sans droit de gestion", async (role, canScore) => {
    db.current!.tables.organization_members!.push({ organization_id: ORG, user_id: "u", role });
    const decision = await resolveMemberAccess(noDiscord, ORG, "u");
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.access.level).toBe("TOURNAMENT");
    expect(canPerform(decision.access, "VIEW_PRIVATE_TOURNAMENT", T1)).toBe(true);
    expect(canPerform(decision.access, "SCORE_MATCH", T1)).toBe(canScore);
    expect(canPerform(decision.access, "MANAGE_TOURNAMENT", T1)).toBe(false);
    expect(canPerform(decision.access, "VIEW_PRIVATE_TOURNAMENT", T_ARCHIVED)).toBe(false);
    expect(canPerform(decision.access, "MANAGE_ORG_SETTINGS")).toBe(false);
  });

  const scoped = (role: "CASTER" | "STATISTICIAN"): AdminCheck => ({
    discordId: "u",
    guildId: ORG,
    access: { level: "TOURNAMENT", tournamentIds: [T1], tournamentRoles: { [T1]: role } },
  });
  const force = (adminCheck: AdminCheck, matchId = "m1") =>
    callRoute(matchRouter, { method: "PUT", path: `/${matchId}/force-score`, adminCheck, body: { team1_score: 2, team2_score: 0, status: "COMPLETED" } });

  it("RFC 5.1 : le statisticien force un score, le casteur reçoit 403", async () => {
    expect((await force(scoped("STATISTICIAN"))).status).toBe(200);
    expect((await force(scoped("CASTER"))).status).toBe(403);
  });

  it("SEC-31 : force-score refuse un match sans ses deux équipes", async () => {
    const out = await force({ discordId: "to", guildId: ORG, access: { level: "SERVER", reason: "SERVER_OWNER" } }, "m-tbd");
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ code: "MATCH_NOT_READY" });
    expect(db.current?.tables.matches?.find((m) => m.id === "m-tbd")?.status).toBe("PENDING");
  });
});

describe("INT-02 : effets Discord idempotents et bornés au serveur lié", () => {
  const channelClient = (channel: unknown) => ({ channels: { fetch: async () => channel } }) as unknown as Client;
  const send = vi.fn(async () => ({ id: "msg-1" }));
  const textChannel = (guildId: string, existing: unknown = null) => ({
    guildId,
    send,
    messages: { fetch: async () => existing },
  });

  it("REG-08 : sans salon configuré, rien à publier et aucune erreur", async () => {
    db.current!.tables.tournaments![0]!.discord_registration_channel_id = null;
    await expect(RegistrationService.publishRegistrationEmbed(T1, channelClient(null), GUILD)).resolves.toBe(false);
  });

  it("SEC-08 : refuse un salon appartenant à un autre serveur", async () => {
    await expect(RegistrationService.publishRegistrationEmbed(T1, channelClient(textChannel("999")), GUILD)).rejects.toThrow("serveur lié");
    expect(send).not.toHaveBeenCalled();
  });

  it("publie une fois, puis le rejeu ne renvoie pas l'embed", async () => {
    await expect(RegistrationService.publishRegistrationEmbed(T1, channelClient(textChannel(GUILD)), GUILD)).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.current?.tables.tournaments?.[0]?.discord_config).toEqual({ registration_message_id: "msg-1" });

    await expect(RegistrationService.publishRegistrationEmbed(T1, channelClient(textChannel(GUILD, { id: "msg-1" })), GUILD)).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("le rejeu du lancement ne recrée pas une catégorie existante", async () => {
    db.current!.tables.tournaments![0]!.discord_category_id = "cat-1";
    db.current!.tables.phases = [];
    const create = vi.fn();
    const guild = { channels: { fetch: async () => ({ id: "cat-1" }), create }, roles: { everyone: { id: "e" } } };
    const client = { guilds: { cache: new Map([[GUILD, guild]]), fetch: async () => guild } } as unknown as Client;
    await LifecycleService.syncDiscordLaunch(T1, GUILD, client);
    expect(create).not.toHaveBeenCalled();
  });

  it("DISC-02 : un serveur introuvable fait échouer l'effet, sans toucher au statut du tournoi", async () => {
    const client = { guilds: { cache: new Map(), fetch: async () => { throw new Error("Unknown Guild"); } } } as unknown as Client;
    await expect(LifecycleService.syncDiscordLaunch(T1, GUILD, client)).rejects.toThrow("not found");
    expect(db.current?.tables.tournaments?.[0]?.status).toBe("ACTIVE");
  });
});

describe("CHK-01 : le planificateur respecte l'état de l'intégration", () => {
  it("SEC-26 : intégration coupée ➜ aucun appel Discord à la fermeture du check-in", async () => {
    db.current!.tables.organization_integrations![0]!.enabled = false;
    db.current!.tables.tournaments![0]!.checkin_message_id = "msg";
    db.current!.tables.tournaments![0]!.discord_checkin_channel_id = "c2";
    const fetchChannel = vi.fn();
    Reflect.set(SchedulerService, "client", { channels: { fetch: fetchChannel } });
    await SchedulerService.handleCloseCheckin(T1);
    expect(fetchChannel).not.toHaveBeenCalled();
  });
});
