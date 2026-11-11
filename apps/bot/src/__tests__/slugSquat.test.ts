import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({ current: null as FakeSupabase | null }));
vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (t: string) => {
      if (!db.current) throw new Error("no db");
      return db.current.from(t);
    },
  },
}));
vi.mock("../utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { clearMemberAccessCache, resolveMemberAccess } from "../services/MemberAccessService";
import { resolveOrganization, verifyTournamentGuild } from "../utils/tenant";
import { OrganizationSlugSchema } from "@hub/shared";

const VICTIM_GUILD = "123456789012345678";
const VICTIM_ORG = "00000000-0000-0000-0000-0000000000aa";
const ATTACKER_ORG = "00000000-0000-0000-0000-0000000000bb";

beforeEach(() => {
  clearMemberAccessCache();
  db.current = new FakeSupabase({
    organizations: [
      { id: VICTIM_ORG, slug: "victim-org", name: "Victim Org", language: "fr" },
      { id: ATTACKER_ORG, slug: VICTIM_GUILD, name: "Attacker Org", language: "fr" },
    ],
    organization_members: [{ organization_id: ATTACKER_ORG, user_id: "attacker", role: "ORG_OWNER" }],
    organization_integrations: [
      { id: "i1", organization_id: VICTIM_ORG, provider: "DISCORD", external_id: VICTIM_GUILD, enabled: true, config: {} },
    ],
    tournaments: [{ id: "t-victim", guild_id: VICTIM_GUILD, organization_id: VICTIM_ORG, status: "DRAFT" }],
    tournament_staff: [],
  });
});

describe("SEC-01: Protection contre le squat de slug et collision snowflake Discord", () => {
  it("OrganizationSlugSchema refuse les slugs 100% numériques (snowflakes Discord) et les UUID", () => {
    // Snowflakes Discord (17-20 chiffres) interdits
    expect(OrganizationSlugSchema.safeParse(VICTIM_GUILD).success).toBe(false);
    expect(OrganizationSlugSchema.safeParse("123456").success).toBe(false);
    // UUIDs interdits comme slugs
    expect(OrganizationSlugSchema.safeParse(VICTIM_ORG).success).toBe(false);
    expect(OrganizationSlugSchema.safeParse("550e8400-e29b-41d4-a716-446655440000").success).toBe(false);
    // Slugs alphanumériques avec lettres valides
    expect(OrganizationSlugSchema.safeParse("victim-org").success).toBe(true);
    expect(OrganizationSlugSchema.safeParse("splat-cup-2026").success).toBe(true);
    expect(OrganizationSlugSchema.safeParse("team-123").success).toBe(true);
  });

  it("SEC-39: le slug discord-<serveur> est réservé aux organisations créées à l'installation du bot", () => {
    expect(OrganizationSlugSchema.safeParse(`discord-${VICTIM_GUILD}`).success).toBe(false);
    expect(OrganizationSlugSchema.safeParse("discord-42").success).toBe(false);
    expect(OrganizationSlugSchema.safeParse("discord-fans").success).toBe(true);
  });

  it("resolveOrganization résout l'external_id Discord avant le slug en cas de conflit", async () => {
    // Si un identifiant correspond à la fois à un external_id Discord et à un slug (cas hérité/anomalie),
    // l'intégration Discord doit prévaloir sur le slug.
    const resolved = await resolveOrganization(VICTIM_GUILD);
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(VICTIM_ORG);
    expect(resolved?.slug).toBe("victim-org");
  });

  it("un attaquant ne peut pas prendre le contrôle du serveur victime ni accéder à ses tournois", async () => {
    const client = { guilds: { fetch: () => Promise.reject(new Error("bot not in guild")) } };
    // L'attaquant interroge les droits sur VICTIM_GUILD : il ne doit PAS être considéré OWNER
    const decision = await resolveMemberAccess(client as any, VICTIM_GUILD, "attacker");
    expect(decision.allowed).toBe(false);

    // verifyTournamentGuild doit refuser l'accès au tournoi victime depuis le tenant attaquant
    const attackerAccess = await verifyTournamentGuild("t-victim", ATTACKER_ORG);
    expect(attackerAccess).toBe(false);
  });
});
