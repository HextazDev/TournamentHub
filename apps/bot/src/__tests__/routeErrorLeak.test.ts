import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// SEC-19 (garde-fou statique) : aucune réponse 5xx des routes HTTP du bot ne relaie le message d'une erreur
// interne (`error.message`, `result.error`…). Les échecs serveur passent par `sendServerError`.
const SRC = join(__dirname, "..");
const FILES = [
  ...readdirSync(join(SRC, "routes"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join("routes", f)),
  "index.ts",
];

const SERVER_ERROR_RESPONSE = /\.status\(\s*5\d\d\s*\)\s*\.json\(([\s\S]*?)\);/g;
const LEAKED_DETAIL = /\.message\b|\.error\b|\.details\b|\.hint\b/;

describe("SEC-19 — pas de détail interne dans les réponses 5xx", () => {
  it.each(FILES)("%s", (file) => {
    const source = readFileSync(join(SRC, file), "utf8");
    const leaks = [...source.matchAll(SERVER_ERROR_RESPONSE)]
      .map((m) => m[1] ?? "")
      .filter((payload) => LEAKED_DETAIL.test(payload));
    expect(leaks).toEqual([]);
  });
});
