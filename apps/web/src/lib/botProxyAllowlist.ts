// SEC-13 : seules les routes de gestion (toutes protégées par requireGuildAdmin côté bot) sont joignables
// depuis le navigateur via /api/bot/*. Les routes internes (permissions, webhook, planification) restent
// réservées aux appels serveur-à-serveur.
const SEGMENT = "[A-Za-z0-9_-]+";
const ALLOWED = [
  /^discord\/(roles|channels|members)$/,
  new RegExp(`^tournaments(/${SEGMENT}(/(settings|visibility|launch|close|registrations|checkin/stop|integrations/sync|invite-link))?)?$`),
  new RegExp(`^(teams|phases|matches)(/${SEGMENT})*$`),
  /^organizations\/invites\/accept$/,
  new RegExp(`^organizations(/${SEGMENT}(/(transfer|members(/${SEGMENT})?|invites(/${SEGMENT})?|tournaments/${SEGMENT}/staff(/${SEGMENT})?|integrations(/${SEGMENT})?))?)?$`),
  new RegExp(`^player/(tournaments/${SEGMENT}/(register|checkin)|matches/${SEGMENT}/(report-score|contest-score))$`),
];
const BLOCKED = /^tournaments\/archive-and-init$/;
const PLAYER_REGISTER_PATTERN = new RegExp(`^player/tournaments/(${SEGMENT})/register$`);

export function isBotProxyPathAllowed(path: string): boolean {
  if (BLOCKED.test(path)) return false;
  return ALLOWED.some((pattern) => pattern.test(path));
}

/** WEB-01 / SEC-41 : seul POST /api/player/tournaments/:id/register consomme le cookie httpOnly d'invitation. */
export function extractPlayerRegisterTournamentId(method: string, path: string): string | null {
  if (method !== "POST") return null;
  const match = PLAYER_REGISTER_PATTERN.exec(path);
  return match?.[1] ?? null;
}

/** Injecte `invite_token` issu du cookie httpOnly dans le corps JSON d'inscription, sans jamais l'exposer au client. */
export function injectTournamentInviteToken(textBody: string, inviteToken: string | null): string {
  if (!inviteToken || !textBody) return textBody;
  const parsed: unknown = JSON.parse(textBody);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return textBody;
  const record = parsed as Record<string, unknown>;
  if (typeof record.invite_token === "string" && record.invite_token.length > 0) return textBody;
  return JSON.stringify({ ...record, invite_token: inviteToken });
}
