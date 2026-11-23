import { describe, expect, it } from "vitest";
import { mergeTournamentDiscordConfig, readTournamentDiscordConfig } from "@hub/shared";

describe("Tournament discord_config helpers (#101)", () => {
  it("reads populated discord_config keys cleanly", () => {
    const cfg = readTournamentDiscordConfig({
      category_id: "111111111111111111",
      announcement_channel_id: "222222222222222222",
      registration_channel_id: "333333333333333333",
      checkin_channel_id: "444444444444444444",
      captain_role_id: "555555555555555555",
      to_role_id: "666666666666666666",
      registration_message_id: "777777777777777777",
    });

    expect(cfg).toEqual({
      category_id: "111111111111111111",
      announcement_channel_id: "222222222222222222",
      registration_channel_id: "333333333333333333",
      checkin_channel_id: "444444444444444444",
      captain_role_id: "555555555555555555",
      to_role_id: "666666666666666666",
      registration_message_id: "777777777777777777",
    });
  });

  it("returns nulls for missing, empty, or malformed discord_config", () => {
    const empty = {
      category_id: null,
      announcement_channel_id: null,
      registration_channel_id: null,
      checkin_channel_id: null,
      captain_role_id: null,
      to_role_id: null,
      registration_message_id: null,
    };

    expect(readTournamentDiscordConfig(null)).toEqual(empty);
    expect(readTournamentDiscordConfig(undefined)).toEqual(empty);
    expect(readTournamentDiscordConfig("bad")).toEqual(empty);
    expect(readTournamentDiscordConfig([])).toEqual(empty);
    expect(readTournamentDiscordConfig({ category_id: "", to_role_id: 123 })).toEqual(empty);
  });

  it("merges partial patches while preserving unrelated keys and stripping cleared keys", () => {
    const merged = mergeTournamentDiscordConfig(
      {
        registration_message_id: "msg-1",
        category_id: "cat-1",
        to_role_id: "role-old",
        checkin_channel_id: "chan-checkin",
      },
      {
        to_role_id: "role-new",
        checkin_channel_id: null,
        registration_channel_id: "",
      },
    );

    expect(merged).toEqual({
      registration_message_id: "msg-1",
      category_id: "cat-1",
      to_role_id: "role-new",
    });
  });
});
