import { describe, expect, it } from "vitest";
import { CreateTeamSchema } from "@hub/shared";

const valid = {
  tournament_id: "6f1c2a6e-3b7d-4c8e-9f10-112233445566",
  name: "  Les Bolides  ",
  captain_discord_id: "123456789012345678",
  members: [{ user_id: "123456789012345678", ingame_name: "Cap", friend_code: "SW-1234-5678-9012", is_captain: true }],
};

describe("CreateTeamSchema — REG-09 validation du corps de POST /api/teams", () => {
  it("accepte un corps valide, normalise le nom et ignore les clés inconnues", () => {
    const parsed = CreateTeamSchema.parse({ ...valid, guildId: "111" });
    expect(parsed.name).toBe("Les Bolides");
    expect(parsed).not.toHaveProperty("guildId");
    expect(parsed.is_checked_in).toBeUndefined();
  });

  it("membres absents ➜ liste vide, is_captain absent ➜ false", () => {
    expect(CreateTeamSchema.parse({ ...valid, members: undefined }).members).toEqual([]);
    const parsed = CreateTeamSchema.parse({ ...valid, members: [{ ingame_name: "P2", friend_code: "" }] });
    expect(parsed.members[0]).toEqual({ user_id: null, ingame_name: "P2", friend_code: "", is_captain: false });
  });

  it.each([
    ["tournament_id non UUID", { tournament_id: "t-1" }],
    ["nom vide", { name: "   " }],
    ["nom > 32 caractères", { name: "x".repeat(33) }],
    ["capitaine absent", { captain_discord_id: undefined }],
    ["capitaine non snowflake", { captain_discord_id: "999999999123" }],
    ["is_checked_in non booléen", { is_checked_in: "yes" }],
    ["members non tableau", { members: "oops" }],
    ["trop de membres", { members: Array.from({ length: 11 }, () => ({ ingame_name: "P", friend_code: "" })) }],
    ["pseudo > 50", { members: [{ ingame_name: "x".repeat(51), friend_code: "" }] }],
    ["code ami > 25", { members: [{ ingame_name: "P", friend_code: "x".repeat(26) }] }],
    ["user_id non snowflake", { members: [{ user_id: "abc", ingame_name: "P", friend_code: "" }] }],
  ])("rejette : %s", (_label, patch) => {
    expect(CreateTeamSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
