import { t } from "@/i18n";
import type { Locale } from "@/i18n/types";

const KNOWN_GAME_LABELS: Readonly<Record<string, string>> = {
  SPLATOON_3: "Splatoon 3",
  ROCKET_LEAGUE: "Rocket League",
  SMASH_BROS: "Super Smash Bros.",
};

const SNAKE_CASE_ENUM = /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/;

/**
 * Formate le champ `game_type` d'un tournoi en libellé lisible multi-jeux.
 * Retourne le libellé générique traduit (« Multi-jeux » / « Multi-game ») pour `GENERIC` ou absence de valeur.
 */
export function formatGameType(gameType: string | null | undefined, locale: Locale): string {
  const trimmed = gameType?.trim();
  if (!trimmed || trimmed.toUpperCase() === "GENERIC") {
    return t(locale, "tournaments.game");
  }

  const known = KNOWN_GAME_LABELS[trimmed.toUpperCase()];
  if (known) return known;

  if (SNAKE_CASE_ENUM.test(trimmed)) {
    return trimmed
      .split("_")
      .map((part) => (part.length > 0 ? `${part[0]}${part.slice(1).toLowerCase()}` : ""))
      .join(" ");
  }

  return trimmed;
}
