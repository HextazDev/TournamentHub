// SEC-13 : seules les routes de gestion (toutes protégées par requireGuildAdmin côté bot) sont joignables
// depuis le navigateur via /api/bot/*. Les routes internes (permissions, webhook, planification) restent
// réservées aux appels serveur-à-serveur.
const SEGMENT = "[A-Za-z0-9_-]+";
const ALLOWED = [
  /^discord\/(roles|channels|members)$/,
  /^server-settings$/,
  new RegExp(`^tournaments(/${SEGMENT}(/(settings|visibility|launch|close|registrations|checkin/stop))?)?$`),
  new RegExp(`^(teams|phases|matches)(/${SEGMENT})*$`),
];
const BLOCKED = /^tournaments\/archive-and-init$/;

export function isBotProxyPathAllowed(path: string): boolean {
  if (BLOCKED.test(path)) return false;
  return ALLOWED.some((pattern) => pattern.test(path));
}
