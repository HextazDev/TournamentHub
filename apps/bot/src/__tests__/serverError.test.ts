import { describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../utils/logger", () => ({ logger: log }));

import { Router } from "express";
import { INTERNAL_ERROR_CODE } from "@hub/shared";
import { DomainError, sendServerError } from "../utils/serverError";
import { callRoute } from "./helpers/route";

function failingRouter(error: unknown, status?: number) {
  const router = Router();
  router.get("/", (_req, res) => {
    sendServerError(res, error, "TestRouter.fail", status);
  });
  return router;
}

describe("sendServerError — SEC-19", () => {
  it("SEC-19: renvoie un 500 générique avec un code stable, jamais le message interne", async () => {
    const error = new Error('relation "public.teams" does not exist');
    const out = await callRoute(failingRouter(error), { method: "GET", path: "/" });
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: "Internal Server Error", code: INTERNAL_ERROR_CODE });
    expect(JSON.stringify(out.body)).not.toContain("public.teams");
  });

  it("SEC-19: journalise l'objet d'erreur complet avec son contexte", async () => {
    const error = new Error("boom");
    await callRoute(failingRouter(error), { method: "GET", path: "/" });
    expect(log.error).toHaveBeenCalledWith("[TestRouter.fail]", error);
  });

  it("SEC-19: une erreur Supabase (objet non-Error) n'est pas divulguée", async () => {
    const pgError = { message: "permission denied for table guild_admins", code: "42501", details: null, hint: null };
    const out = await callRoute(failingRouter(pgError), { method: "GET", path: "/" });
    expect(JSON.stringify(out.body)).not.toContain("guild_admins");
    expect(log.error).toHaveBeenCalledWith("[TestRouter.fail]", pgError);
  });

  it("SEC-19: accepte un statut 5xx explicite (échec Discord ➜ 502)", async () => {
    const out = await callRoute(failingRouter(new Error("Missing Access"), 502), { method: "GET", path: "/" });
    expect(out.status).toBe(502);
    expect(out.body).toEqual({ error: "Internal Server Error", code: INTERNAL_ERROR_CODE });
  });

  it("SEC-19: une erreur métier explicite (DomainError) est relayée avec son statut et son message", async () => {
    const error = new DomainError(409, "Matches already exist for phase p-1. Delete them before regenerating.");
    const out = await callRoute(failingRouter(error), { method: "GET", path: "/" });
    expect(out.status).toBe(409);
    expect(out.body).toEqual({ error: "Matches already exist for phase p-1. Delete them before regenerating." });
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("[TestRouter.fail]", error);
  });

  it("SEC-19: une Error ordinaire au message « métier » reste générique", async () => {
    const out = await callRoute(failingRouter(new Error("Matches already exist")), { method: "GET", path: "/" });
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: "Internal Server Error", code: INTERNAL_ERROR_CODE });
  });
});
