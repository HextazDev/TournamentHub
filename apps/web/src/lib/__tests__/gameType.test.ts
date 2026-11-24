import { describe, expect, it } from "vitest";
import { formatGameType } from "../gameType";

describe("formatGameType (#135) : affichage multi-jeux sans mention Splatoon codée en dur", () => {
  it("renvoie le libellé générique traduit pour GENERIC, null ou chaîne vide", () => {
    expect(formatGameType("GENERIC", "fr")).toBe("Multi-jeux");
    expect(formatGameType("GENERIC", "en")).toBe("Multi-game");
    expect(formatGameType(null, "fr")).toBe("Multi-jeux");
    expect(formatGameType(undefined, "en")).toBe("Multi-game");
    expect(formatGameType("   ", "fr")).toBe("Multi-jeux");
  });

  it("formate proprement les jeux connus de GameType", () => {
    expect(formatGameType("SPLATOON_3", "fr")).toBe("Splatoon 3");
    expect(formatGameType("ROCKET_LEAGUE", "en")).toBe("Rocket League");
    expect(formatGameType("SMASH_BROS", "fr")).toBe("Super Smash Bros.");
  });

  it("formate un jeu personnalisé en préservant un nom libre ou en nettoyant un identifiant SNAKE_CASE", () => {
    expect(formatGameType("Counter-Strike 2", "fr")).toBe("Counter-Strike 2");
    expect(formatGameType("STREET_FIGHTER_6", "en")).toBe("Street Fighter 6");
  });
});
