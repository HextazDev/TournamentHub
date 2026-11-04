import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";
import { FakeSupabase } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({ current: null as FakeSupabase | null }));
const access = vi.hoisted(() => ({ invalidateGuildAccess: vi.fn() }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (!db.current) throw new Error("FakeSupabase non initialisé");
      return db.current.from(table);
    },
  },
}));
vi.mock("../utils/logger", () => ({ logger: log }));
// L'appartenance au serveur (SEC-01) est couverte ailleurs : ici, tout appartient au même serveur.
vi.mock("../utils/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/tenant")>()),
  verifyTournamentGuild: async () => true,
  verifyPhaseGuild: async () => true,
  verifyTeamGuild: async () => true,
  verifyMatchGuild: async () => true,
}));
vi.mock("../services/MemberAccessService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/MemberAccessService")>()),
  invalidateGuildAccess: access.invalidateGuildAccess,
}));
vi.mock("../services/LifecycleService", () => ({
  LifecycleService: { launchTournament: vi.fn(), closeTournament: vi.fn(), syncPhaseChannels: vi.fn() },
}));
vi.mock("../services/SchedulerService", () => ({
  SchedulerService: { scheduleTournament: vi.fn(), cancelTournamentJobs: vi.fn(), handleCloseCheckin: vi.fn() },
}));
vi.mock("../services/RegistrationService", () => ({ RegistrationService: { sendRegistrationEmbed: vi.fn() } }));
vi.mock("../services/ArchiveService", () => ({ ArchiveService: { backgroundDiscordCleanup: vi.fn(async () => undefined) } }));
vi.mock("../services/CaptainPresenceService", () => ({
  applyPresence: vi.fn(),
  removePresence: vi.fn(),
  hasPresenceFailure: vi.fn(() => false),
}));

import type { AdminCheck } from "../middleware/auth";
import { routeGuardKind } from "../middleware/auth";
import { tournamentRouter } from "../routes/TournamentRouter";
import { phaseRouter } from "../routes/PhaseRouter";
import { matchRouter } from "../routes/MatchRouter";
import { teamRouter } from "../routes/TeamRouter";
import { callRoute } from "./helpers/route";

const GUILD = "111";
const T_A = "tournament-a";
const T_B = "tournament-b";
const ROLE_A = "222222222222222222";
const CAPTAIN_A = "333333333333333333";

const toOfA: AdminCheck = { discordId: "to-a", guildId: GUILD, access: { level: "TOURNAMENT", tournamentIds: [T_A] } };
const serverTo: AdminCheck = { discordId: "to", guildId: GUILD, access: { level: "SERVER", reason: "TO_ROLE" } };

const tournamentRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  guild_id: GUILD,
  name: id,
  status: "ACTIVE",
  language: "fr",
  is_public: false,
  is_registration_open: false,
  discord_to_role_id: ROLE_A,
  discord_captain_role_id: CAPTAIN_A,
  checkin_start_at: null,
  checkin_end_at: null,
  ...extra,
});

function seed(tournaments = [tournamentRow(T_A), tournamentRow(T_B, { discord_to_role_id: "444444444444444444" })]) {
  db.current = new FakeSupabase({
    tournaments,
    phases: [
      { id: "phase-a", tournament_id: T_A, format: "SINGLE_ELIM", settings: {} },
      { id: "phase-b", tournament_id: T_B, format: "SINGLE_ELIM", settings: {} },
    ],
    matches: [
      { id: "match-a", phase_id: "phase-a" },
      { id: "match-b", phase_id: "phase-b" },
    ],
    teams: [
      { id: "team-a", tournament_id: T_A, name: "A", captain_discord_id: "1", is_checked_in: false },
      { id: "team-b", tournament_id: T_B, name: "B", captain_discord_id: "2", is_checked_in: false },
    ],
    team_members: [],
    server_settings: [{ guild_id: GUILD }],
  });
}

const writes = () => db.current?.writes ?? [];

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
interface RouteCase {
  router: Router;
  name: string;
  method: Method;
  path: (target: "a" | "b") => string;
  body?: (target: "a" | "b") => unknown;
}

const tid = (t: "a" | "b") => (t === "a" ? T_A : T_B);

/** Toutes les routes de gestion d'un tournoi, par type de ressource (tournoi, phase, match, équipe). */
const ROUTES: RouteCase[] = [
  { router: tournamentRouter, name: "PUT /tournaments/:id/settings", method: "PUT", path: (t) => `/${tid(t)}/settings`, body: () => ({ language: "fr" }) },
  { router: tournamentRouter, name: "PATCH /tournaments/:id/visibility", method: "PATCH", path: (t) => `/${tid(t)}/visibility`, body: () => ({ is_public: true }) },
  { router: tournamentRouter, name: "POST /tournaments/:id/launch", method: "POST", path: (t) => `/${tid(t)}/launch` },
  { router: tournamentRouter, name: "POST /tournaments/:id/close", method: "POST", path: (t) => `/${tid(t)}/close` },
  { router: tournamentRouter, name: "POST /tournaments/:id/registrations", method: "POST", path: (t) => `/${tid(t)}/registrations`, body: () => ({ open: true }) },
  { router: tournamentRouter, name: "POST /tournaments/:id/checkin/stop", method: "POST", path: (t) => `/${tid(t)}/checkin/stop` },
  { router: phaseRouter, name: "POST /phases (corps)", method: "POST", path: () => "/", body: (t) => ({ tournament_id: tid(t), name: "P" }) },
  { router: phaseRouter, name: "GET /phases/:tournamentId", method: "GET", path: (t) => `/${tid(t)}` },
  { router: phaseRouter, name: "PUT /phases/:id/seeding", method: "PUT", path: (t) => `/phase-${t}/seeding`, body: () => ({ seeding: [] }) },
  { router: phaseRouter, name: "GET /phases/:id/seeding", method: "GET", path: (t) => `/phase-${t}/seeding` },
  { router: phaseRouter, name: "PUT /phases/:id", method: "PUT", path: (t) => `/phase-${t}`, body: () => ({ name: "P2" }) },
  { router: phaseRouter, name: "DELETE /phases/:id", method: "DELETE", path: (t) => `/phase-${t}` },
  { router: phaseRouter, name: "POST /phases/:id/sync", method: "POST", path: (t) => `/phase-${t}/sync` },
  { router: matchRouter, name: "PUT /matches/:id/force-score", method: "PUT", path: (t) => `/match-${t}/force-score`, body: () => ({}) },
  { router: teamRouter, name: "POST /teams (corps)", method: "POST", path: () => "/", body: (t) => ({ tournament_id: tid(t), name: "Team", captain_discord_id: "123456789012345678", members: [] }) },
  { router: teamRouter, name: "POST /teams/generate-fake (corps)", method: "POST", path: () => "/generate-fake", body: (t) => ({ tournament_id: tid(t), count: 1 }) },
  { router: teamRouter, name: "PUT /teams/:id", method: "PUT", path: (t) => `/team-${t}`, body: () => ({ name: "Renamed" }) },
  { router: teamRouter, name: "PATCH /teams/:id/checkin", method: "PATCH", path: (t) => `/team-${t}/checkin`, body: () => ({ is_checked_in: true }) },
  { router: teamRouter, name: "DELETE /teams/:id", method: "DELETE", path: (t) => `/team-${t}` },
];

const call = (route: RouteCase, target: "a" | "b", adminCheck: AdminCheck) => {
  const body = route.body?.(target);
  return callRoute(route.router, {
    method: route.method,
    path: route.path(target),
    adminCheck,
    locals: { discordClient: {} },
    ...(body === undefined ? {} : { body: { guildId: GUILD, ...(body as Record<string, unknown>) } }),
  });
};

describe("SEC-21: portée d'un TO de tournoi sur les routes réelles", () => {
  it.each(ROUTES)("$name : 403 sur un autre tournoi du même serveur, sans aucune écriture", async (route) => {
    const out = await call(route, "b", toOfA);
    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ code: "NO_RIGHTS" });
    expect(writes()).toEqual([]);
  });

  it.each(ROUTES)("$name : la garde laisse passer le TO sur son propre tournoi", async (route) => {
    const out = await call(route, "a", toOfA);
    expect(out.status).not.toBe(403);
  });

  it("le TO de A gère réellement son tournoi (visibilité, suppression d'équipe)", async () => {
    const visibility = await call(ROUTES[1] as RouteCase, "a", toOfA);
    expect(visibility.status).toBe(200);
    expect(db.current?.tables.tournaments?.find((t) => t.id === T_A)?.is_public).toBe(true);

    const removal = await callRoute(teamRouter, { method: "DELETE", path: "/team-a", adminCheck: toOfA });
    expect(removal.status).toBe(200);
    expect(db.current?.tables.teams?.map((t) => t.id)).toEqual(["team-b"]);
  });

  it("une création désigne son tournoi par le corps : le TO de A ne crée rien dans B (POST /teams)", async () => {
    const out = await callRoute(teamRouter, {
      method: "POST",
      path: "/",
      adminCheck: toOfA,
      body: { tournament_id: T_B, name: "Intrus", captain_discord_id: "123456789012345678", members: [] },
    });
    expect(out.status).toBe(403);
    expect(db.current?.tables.teams?.filter((t) => t.tournament_id === T_B)).toHaveLength(1);
  });

  it("SEC-21: la création de tournoi reste réservée au niveau SERVER", async () => {
    const out = await callRoute(tournamentRouter, { method: "POST", path: "/", adminCheck: toOfA, body: { guild_id: GUILD, name: "Nouveau" } });
    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ code: "SERVER_LEVEL_REQUIRED" });
    expect(writes()).toEqual([]);

    const allowed = await callRoute(tournamentRouter, { method: "POST", path: "/", adminCheck: serverTo, body: { guild_id: GUILD, name: "Nouveau" } });
    expect(allowed.status).not.toBe(403);
  });

  it("SEC-21: un adminCheck TOURNAMENT sans garde de portée n'obtient pas de serveur (fermé par défaut)", async () => {
    // Simulation d'une route oubliée : getAuthenticatedGuildId est la source unique des handlers.
    const { getAuthenticatedGuildId } = await import("../utils/tenant");
    const { default: express } = await import("express");
    const forgotten = express.Router();
    forgotten.post("/:id/oops", (req, res) => res.status(getAuthenticatedGuildId(req) ? 200 : 403).json({}));
    const out = await callRoute(forgotten, { method: "POST", path: `/${T_A}/oops`, adminCheck: toOfA });
    expect(out.status).toBe(403);
  });
});

describe("SEC-25: lancement, clôture et synchronisation visent le serveur authentifié", () => {
  it.each([
    ["launch", tournamentRouter, `/${T_A}/launch`, "launchTournament"],
    ["close", tournamentRouter, `/${T_A}/close`, "closeTournament"],
    ["sync", phaseRouter, "/phase-a/sync", "syncPhaseChannels"],
  ] as const)("%s : un guildId du corps n'est jamais relu", async (_name, router, path, method) => {
    const { LifecycleService } = await import("../services/LifecycleService");
    const out = await callRoute(router, { method: "POST", path, adminCheck: serverTo, body: { guildId: { evil: true } } });
    expect(out.status).toBe(200);
    expect(vi.mocked(LifecycleService[method])).toHaveBeenCalledWith(expect.any(String), GUILD, undefined);
  });
});

describe("SEC-22: rôles du tournoi réservés au niveau SERVER (PUT /tournaments/:id/settings)", () => {
  const settings = (adminCheck: AdminCheck, body: Record<string, unknown>) =>
    callRoute(tournamentRouter, { method: "PUT", path: `/${T_A}/settings`, adminCheck, body: { guildId: GUILD, ...body } });

  it.each([
    ["discord_to_role_id", { discord_to_role_id: "555555555555555555" }],
    ["discord_to_role_id vidé", { discord_to_role_id: "" }],
    ["discord_captain_role_id", { discord_captain_role_id: "555555555555555555" }],
  ])("le TO du tournoi ne modifie pas %s : 403 TOURNAMENT_ROLES_RESERVED, aucune écriture", async (_label, body) => {
    const out = await settings(toOfA, body);
    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ code: "TOURNAMENT_ROLES_RESERVED" });
    expect(writes()).toEqual([]);
  });

  it("le TO du tournoi enregistre ses autres paramètres : rôles renvoyés à l'identique ou absents conservés", async () => {
    const same = await settings(toOfA, { discord_to_role_id: ROLE_A, discord_captain_role_id: CAPTAIN_A, language: "en" });
    expect(same.status).toBe(200);
    const absent = await settings(toOfA, { language: "fr" });
    expect(absent.status).toBe(200);
    const row = db.current?.tables.tournaments?.find((t) => t.id === T_A);
    expect(row).toMatchObject({ discord_to_role_id: ROLE_A, discord_captain_role_id: CAPTAIN_A, language: "fr" });
    expect(access.invalidateGuildAccess).not.toHaveBeenCalled();
  });

  it("SEC-05: le niveau SERVER modifie le rôle TO du tournoi et invalide le cache d'accès du serveur", async () => {
    const out = await settings(serverTo, { discord_to_role_id: "555555555555555555", discord_captain_role_id: CAPTAIN_A });
    expect(out.status).toBe(200);
    expect(db.current?.tables.tournaments?.find((t) => t.id === T_A)?.discord_to_role_id).toBe("555555555555555555");
    expect(access.invalidateGuildAccess).toHaveBeenCalledWith(GUILD);
  });

  it("DISC-08: la resynchronisation de guild_admins ne retarde jamais la réponse (synchro bloquée ou en échec)", async () => {
    const body = { guildId: GUILD, discord_to_role_id: "555555555555555555", discord_captain_role_id: CAPTAIN_A };
    const fetchGuild = vi.fn(() => new Promise(() => undefined));
    const hanging = await callRoute(tournamentRouter, {
      method: "PUT", path: `/${T_A}/settings`, adminCheck: serverTo, body, locals: { discordClient: { guilds: { fetch: fetchGuild } } },
    });
    expect(hanging.status).toBe(200);
    expect(fetchGuild).toHaveBeenCalledWith(GUILD);

    const boom = new Error("Unknown Guild");
    const failing = await callRoute(tournamentRouter, {
      method: "PUT", path: `/${T_A}/settings`, adminCheck: serverTo, body: { ...body, discord_to_role_id: "666666666666666666" },
      locals: { discordClient: { guilds: { fetch: () => Promise.reject(boom) } } },
    });
    expect(failing.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining(GUILD), boom);
  });

  it("SEC-21: le TO du tournoi ne déclenche pas l'archivage des autres tournois du serveur", async () => {
    seed([tournamentRow(T_A, { status: "DRAFT" }), tournamentRow(T_B)]);
    const body = { checkin_start_at: "2026-12-01T10:00:00Z", checkin_end_at: "2026-12-01T11:00:00Z" };
    const out = await settings(toOfA, body);
    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ code: "SERVER_LEVEL_REQUIRED" });
    expect(writes()).toEqual([]);

    seed([tournamentRow(T_A, { status: "DRAFT" }), tournamentRow(T_B, { status: "ARCHIVED" })]);
    const alone = await settings(toOfA, body);
    expect(alone.status).toBe(200);
    expect(db.current?.tables.tournaments?.find((t) => t.id === T_A)?.status).toBe("REGISTRATION");
  });
});

describe("SEC-21: chaque route d'un montage ouvert aux TO de tournoi déclare sa garde", () => {
  const routers: [string, Router][] = [
    ["tournaments", tournamentRouter],
    ["phases", phaseRouter],
    ["matches", matchRouter],
    ["teams", teamRouter],
  ];

  it.each(routers)("/api/%s : aucune route sans requireTournamentScope ni requireServerLevel", (_name, router) => {
    const routes = router.stack.flatMap((layer) => (layer.route ? [layer.route] : []));
    expect(routes.length).toBeGreaterThan(0);
    const unguarded = routes.filter((route) => !route.stack.some((l) => routeGuardKind(l.handle) !== null));
    expect(unguarded.map((r) => r.path)).toEqual([]);
  });

  it("index.ts : le niveau TOURNAMENT n'est ouvert que sur les montages prévus ; le reste exige le niveau SERVER", () => {
    const source = readFileSync(join(__dirname, "..", "index.ts"), "utf8");
    const mounts = [...source.matchAll(/app\.(?:get|post|put|patch|delete|use)\(\s*['"]([^'"]+)['"],\s*(?:\.\.\.)?(\w+)/g)].map(
      (m) => [m[1], m[2]] as const,
    );
    const guardOf = new Map(mounts);
    const tournamentLevel = ["/api/phases", "/api/matches", "/api/tournaments", "/api/teams", "/api/discord/sync-schedule"];
    const discordLists = ["/api/discord/roles", "/api/discord/channels", "/api/discord/members"];
    for (const path of tournamentLevel) expect(guardOf.get(path), path).toBe("tournamentLevelGuard");
    for (const path of discordLists) expect(guardOf.get(path), path).toBe("discordListGuard");

    const serverOnly = ["/api/tournaments/archive-and-init", "/api/discord/publish-phase", "/api/discord/auto-setup", "/api/server-settings"];
    for (const path of serverOnly) expect(["guildAdminGuard", "serverSettingsGuard"], path).toContain(guardOf.get(path));

    const opened = mounts.filter(([, guard]) => guard === "tournamentLevelGuard" || guard === "discordListGuard").map(([p]) => p);
    expect(opened.sort()).toEqual([...tournamentLevel, ...discordLists].sort());
  });
});
