import { z } from "zod";

// Game Types Supported
export type GameType = "GENERIC" | "SPLATOON_3" | "ROCKET_LEAGUE" | "SMASH_BROS" | string;

// Tournament Status
export type TournamentStatus = "DRAFT" | "REGISTRATION" | "ACTIVE" | "COMPLETED" | "ARCHIVED";

// Phase Types
export type PhaseType = "ROUND_ROBIN" | "SINGLE_ELIM" | "SWISS" | "DOUBLE_ELIM";

// Supported Languages (tournaments.language / server_settings.language)
export const LocaleSchema = z.enum(["fr", "en"]);
export type Locale = z.infer<typeof LocaleSchema>;

// Mode de check-in (tournaments.checkin_mode) : ENABLED (défaut) ou DISABLED (#15)
export const CheckinModeSchema = z.enum(["ENABLED", "DISABLED"]);
export type CheckinMode = z.infer<typeof CheckinModeSchema>;

// Plafond de génération d'équipes fictives (back-office de test) : borne l'UI et l'API bot.
export const MAX_FAKE_TEAMS = 64;

// SEC-27 / RFC 0001 : plafond d'organisations possédées (ORG_OWNER) par un même utilisateur.
export const MAX_OWNED_ORGANIZATIONS = 5;

export const OrganizationSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/, "Slug d'organisation invalide (3 à 48 caractères alphanumériques ou tirets)");

export const OrganizationRoleSchema = z.enum(["ORG_OWNER", "ORG_ADMIN", "ORG_TO"]);
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;

export const OrganizationMemberRoleSchema = z.enum(["ORG_OWNER", "ORG_ADMIN", "ORG_TO", "MEMBER"]);
export type OrganizationMemberRole = z.infer<typeof OrganizationMemberRoleSchema>;

export const TournamentStaffRoleSchema = z.enum(["TOURNAMENT_TO", "CASTER", "STATISTICIAN"]);
export type TournamentStaffRole = z.infer<typeof TournamentStaffRoleSchema>;

export const IntegrationProviderSchema = z.enum(["DISCORD", "TWITCH", "AI"]);
export type IntegrationProvider = z.infer<typeof IntegrationProviderSchema>;

export const IntegrationStatusSchema = z.enum(["CONNECTED", "DEGRADED", "REVOKED", "DISCONNECTED"]);
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

export const AccessSourceSchema = z.enum(["NATIVE", "DISCORD", "TWITCH", "AI"]);
export type AccessSource = z.infer<typeof AccessSourceSchema>;

export interface Organization {
  id: string;
  slug: string;
  name: string;
  logo_url?: string | null;
  icon_url?: string | null;
  language: Locale;
  invite_url?: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrganizationMember {
  organization_id: string;
  user_id: string;
  role: OrganizationMemberRole;
  created_at: string;
}

export interface TournamentStaff {
  tournament_id: string;
  user_id: string;
  role: TournamentStaffRole;
  created_at: string;
}

export interface OrganizationIntegration {
  id: string;
  organization_id: string;
  provider: IntegrationProvider;
  type?: IntegrationProvider;
  external_id: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
  status: IntegrationStatus;
  last_error?: string | null;
  last_sync_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrganizationInvite {
  id: string;
  organization_id: string;
  role: "ORG_ADMIN" | "ORG_TO" | "MEMBER";
  created_by: string;
  expires_at: string;
  used_by?: string | null;
  used_at?: string | null;
  created_at: string;
}

// Common Domain Interfaces
export interface Tournament {
  id: string;
  organization_id?: string;
  guild_id: string;
  name: string;
  description?: string | null;
  is_public: boolean;
  status: TournamentStatus;
  game_type: GameType;
  language: Locale;
  checkin_mode?: CheckinMode;
  start_at?: string | null;
  start_date?: string | null;
  is_registration_open?: boolean | null;
  checkin_message_id?: string | null;
  discord_category_id?: string | null;
  tie_breaker_method?: string | null;
  checkin_start_at?: string | null;
  checkin_end_at?: string | null;
  discord_announcement_channel_id?: string | null;
  discord_registration_channel_id?: string | null;
  discord_checkin_channel_id?: string | null;
  discord_captain_role_id?: string | null;
  discord_to_role_id?: string | null;
  discord_config?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Phase {
  id: string;
  tournament_id: string;
  name: string;
  phase_order: number;
  format: PhaseType;
  max_groups?: number | null;
  allow_asymmetric_groups?: boolean;
  bracket_size?: number;
  settings?: Record<string, any>;
  discord_channel_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Team {
  id: string;
  tournament_id: string;
  name: string;
  captain_discord_id: string;
  is_checked_in: boolean;
  created_at: string;
  updated_at: string;
}

export interface Match {
  id: string;
  phase_id: string;
  team1_id?: string | null;
  team2_id?: string | null;
  team1_score: number;
  team2_score: number;
  status: string;
  round_number?: number;
  match_number?: number;
  group_id?: string | null;
  next_match_winner_id?: string | null;
  next_match_loser_id?: string | null;
  created_at: string;
  updated_at: string;
}

// Invitation Discord publique configurée par les TO (doublée par la contrainte SQL server_settings_invite_url_check).
export const DiscordInviteUrlSchema = z
  .string()
  .trim()
  .regex(/^https:\/\/(discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]+$/, "Invitation Discord invalide");

export interface ServerSettings {
  guild_id: string;
  guild_name: string | null;
  guild_icon: string | null;
  bot_present: boolean;
  invite_url: string | null;
  language: Locale;
  to_role_id: string | null;
  captain_role_id: string | null;
  checkin_channel_id: string | null;
  announcement_channel_id: string | null;
  registration_channel_id: string | null;
  updated_at: string;
}

const OptionalDiscordId = z
  .union([z.string().regex(/^\d{1,25}$/, "Identifiant Discord invalide"), z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

// Corps de PUT /api/server-settings. Les champs absents ne sont pas modifiés (sauf les rôles et salons, envoyés en bloc par le formulaire).
export const ServerSettingsUpdateSchema = z.object({
  guild_id: z.string().regex(/^\d{1,25}$/, "guild_id invalide"),
  to_role_id: OptionalDiscordId,
  captain_role_id: OptionalDiscordId,
  checkin_channel_id: OptionalDiscordId,
  announcement_channel_id: OptionalDiscordId,
  registration_channel_id: OptionalDiscordId,
  language: LocaleSchema.optional(),
  invite_url: z
    .union([DiscordInviteUrlSchema, z.literal(""), z.null()])
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null)),
});
export type ServerSettingsUpdate = z.infer<typeof ServerSettingsUpdateSchema>;

// Motif d'accès au back-office d'un serveur (colonne guild_admins.reason).
export const GuildAdminReasonSchema = z.enum(["SERVER_OWNER", "ADMINISTRATOR", "MANAGE_GUILD", "TO_ROLE"]);
export type GuildAdminReason = z.infer<typeof GuildAdminReasonSchema>;

/**
 * Motif d'une ligne de l'annuaire guild_admins (serveurs affichés dans le hub). TOURNAMENT_TO_ROLE : le membre ne
 * porte que le rôle TO d'un tournoi non archivé. Ce motif n'est jamais un motif d'accès SERVER (SEC-24) :
 * GuildAccessSchema le refuse, et seul le bot décide de l'accès (SEC-17).
 */
export const GuildDirectoryReasonSchema = z.enum([...GuildAdminReasonSchema.options, "TOURNAMENT_TO_ROLE"]);
export type GuildDirectoryReason = z.infer<typeof GuildDirectoryReasonSchema>;

/**
 * Accès d'un membre au back-office d'un serveur (SEC-11) :
 * - SERVER : propriétaire, Administrateur, Gérer le serveur ou rôle TO du serveur (server_settings.to_role_id) ;
 * - TOURNAMENT : rôle TO propre à certains tournois (tournaments.discord_to_role_id), limité à ces tournois.
 */
export type GuildAccess =
  | { level: "SERVER"; reason: GuildAdminReason; nativeRole?: OrganizationRole; source?: AccessSource }
  | {
      level: "TOURNAMENT";
      tournamentIds: readonly string[];
      tournamentRoles?: Readonly<Record<string, TournamentStaffRole>>;
      source?: AccessSource;
    };

/**
 * Accès généralisé à une organisation (RFC 0001 / #97) :
 * - ORGANIZATION : rôle natif (ORG_OWNER, ORG_ADMIN, ORG_TO) ou issu d'une intégration active ;
 * - SERVER : alias historique (compatible avec GuildAccess) ;
 * - TOURNAMENT : accès limité à certains tournois (TOURNAMENT_TO, CASTER, STATISTICIAN).
 */
export type OrganizationAccess =
  | { level: "ORGANIZATION"; role: OrganizationRole; source?: AccessSource; reason?: GuildAdminReason }
  | GuildAccess;

/** Validation de `GuildAccess` reçu d'un tiers (réponse du bot côté web). */
export const GuildAccessSchema = z.discriminatedUnion("level", [
  z.object({
    level: z.literal("SERVER"),
    reason: GuildAdminReasonSchema,
    nativeRole: OrganizationRoleSchema.optional(),
    source: AccessSourceSchema.optional(),
  }),
  z.object({
    level: z.literal("TOURNAMENT"),
    tournamentIds: z.array(z.string().min(1)),
    tournamentRoles: z.record(z.string(), TournamentStaffRoleSchema).optional(),
    source: AccessSourceSchema.optional(),
  }),
]);

export const OrganizationAccessSchema = z.discriminatedUnion("level", [
  z.object({
    level: z.literal("ORGANIZATION"),
    role: OrganizationRoleSchema,
    source: AccessSourceSchema.optional(),
    reason: GuildAdminReasonSchema.optional(),
  }),
  z.object({
    level: z.literal("SERVER"),
    reason: GuildAdminReasonSchema,
    nativeRole: OrganizationRoleSchema.optional(),
    source: AccessSourceSchema.optional(),
  }),
  z.object({
    level: z.literal("TOURNAMENT"),
    tournamentIds: z.array(z.string().min(1)),
    tournamentRoles: z.record(z.string(), TournamentStaffRoleSchema).optional(),
    source: AccessSourceSchema.optional(),
  }),
]);

/**
 * MANAGE_TOURNAMENT_ROLES : modifier les rôles d'un tournoi (discord_to_role_id, discord_captain_role_id).
 * Le rôle TO d'un tournoi désigne qui le gère : un TO de tournoi ne peut donc pas le changer (SEC-22).
 */
export const GUILD_ACTIONS = [
  "MANAGE_SERVER_SETTINGS",
  "CREATE_TOURNAMENT",
  "DELETE_TOURNAMENT",
  "MANAGE_TOURNAMENT",
  "MANAGE_TOURNAMENT_ROLES",
] as const;
export type GuildAction = (typeof GUILD_ACTIONS)[number];

export const ORGANIZATION_ACTIONS = [
  ...GUILD_ACTIONS,
  "MANAGE_ORG_SETTINGS",
  "MANAGE_INTEGRATIONS",
  "MANAGE_ORG_MEMBERS",
  "TRANSFER_OWNERSHIP",
  "SCORE_MATCH",
  "VIEW_PRIVATE_TOURNAMENT",
] as const;
export type OrganizationAction = (typeof ORGANIZATION_ACTIONS)[number];

/** Motifs de refus d'accès, partagés par le bot (champ `code` des réponses) et le web (messages traduits). */
export const AccessDeniedCodeSchema = z.enum([
  "NOT_LOGGED_IN",
  "NOT_A_MEMBER",
  "NO_RIGHTS",
  "BOT_NOT_IN_GUILD",
  "CHECK_FAILED",
  "SERVER_SETTINGS_RESERVED",
  // SEC-21 : route réservée au niveau SERVER (création, archivage, paramètres serveur…), refusée au TO de tournoi.
  "SERVER_LEVEL_REQUIRED",
  // SEC-22 : modification des rôles d'un tournoi refusée au TO de ce tournoi.
  "TOURNAMENT_ROLES_RESERVED",
  // SEC-21 (#88) : salon Discord inaccessible au membre demandeur ou au bot.
  "CHANNEL_NOT_ACCESSIBLE",
]);
export type AccessDeniedCode = z.infer<typeof AccessDeniedCodeSchema>;

/**
 * SEC-19 : code stable d'une réponse 5xx du bot (`{ error: "Internal Server Error", code }`).
 * Le détail de l'erreur reste dans les logs du bot ; le web affiche un message générique traduit.
 */
export const INTERNAL_ERROR_CODE = "INTERNAL_ERROR";
export type InternalErrorCode = typeof INTERNAL_ERROR_CODE;

/** Les paramètres du serveur décident qui est TO : ils restent hors de portée du rôle TO (SEC-16). */
const SERVER_SETTINGS_REASONS: ReadonlySet<GuildAdminReason> = new Set(["SERVER_OWNER", "ADMINISTRATOR", "MANAGE_GUILD"]);

function resolveEffectiveOrgRole(access: Exclude<OrganizationAccess, { level: "TOURNAMENT" }>): OrganizationRole {
  if (access.level === "ORGANIZATION") return access.role;
  if (access.nativeRole) return access.nativeRole;
  if (access.reason === "SERVER_OWNER") return "ORG_OWNER";
  if (SERVER_SETTINGS_REASONS.has(access.reason)) return "ORG_ADMIN";
  return "ORG_TO";
}

/** Règle pure des actions autorisées (SEC-15 / SEC-16 / RFC 0001), partagée par le bot et le web. Fermée par défaut. */
export function canPerform(
  access: OrganizationAccess,
  action: OrganizationAction,
  tournamentId?: string,
): boolean {
  if (access.level === "TOURNAMENT") {
    if (tournamentId === undefined || !access.tournamentIds.includes(tournamentId)) return false;
    const role: TournamentStaffRole = access.tournamentRoles?.[tournamentId] ?? "TOURNAMENT_TO";
    switch (action) {
      case "MANAGE_TOURNAMENT":
        return role === "TOURNAMENT_TO";
      case "SCORE_MATCH":
        return role === "TOURNAMENT_TO" || role === "STATISTICIAN";
      case "VIEW_PRIVATE_TOURNAMENT":
        return role === "TOURNAMENT_TO" || role === "STATISTICIAN" || role === "CASTER";
      default:
        return false;
    }
  }

  const orgRole = resolveEffectiveOrgRole(access);
  switch (action) {
    case "TRANSFER_OWNERSHIP":
      return orgRole === "ORG_OWNER";
    case "MANAGE_SERVER_SETTINGS":
    case "MANAGE_ORG_SETTINGS":
    case "MANAGE_INTEGRATIONS":
    case "MANAGE_ORG_MEMBERS":
      return orgRole === "ORG_OWNER" || orgRole === "ORG_ADMIN";
    case "CREATE_TOURNAMENT":
    case "DELETE_TOURNAMENT":
    case "MANAGE_TOURNAMENT":
    case "MANAGE_TOURNAMENT_ROLES":
    case "SCORE_MATCH":
    case "VIEW_PRIVATE_TOURNAMENT":
      return orgRole === "ORG_OWNER" || orgRole === "ORG_ADMIN" || orgRole === "ORG_TO";
    default:
      return false;
  }
}

export const CreateOrganizationSchema = z.object({
  name: z.string().trim().min(2, "Le nom de l'organisation doit comporter au moins 2 caractères").max(100),
  slug: OrganizationSlugSchema,
  language: LocaleSchema.optional().default("fr"),
  logo_url: z.string().url().optional().nullable(),
  invite_url: z
    .union([DiscordInviteUrlSchema, z.literal(""), z.null()])
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null)),
});
export type CreateOrganizationInput = z.infer<typeof CreateOrganizationSchema>;

export const UpdateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  slug: OrganizationSlugSchema.optional(),
  language: LocaleSchema.optional(),
  logo_url: z.string().url().optional().nullable(),
  invite_url: z
    .union([DiscordInviteUrlSchema, z.literal(""), z.null()])
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null)),
});
export type UpdateOrganizationInput = z.infer<typeof UpdateOrganizationSchema>;

export const UpsertOrganizationMemberSchema = z.object({
  user_id: z.string().trim().min(1),
  role: OrganizationMemberRoleSchema,
});
export type UpsertOrganizationMemberInput = z.infer<typeof UpsertOrganizationMemberSchema>;

export const UpsertTournamentStaffSchema = z.object({
  user_id: z.string().trim().min(1),
  role: TournamentStaffRoleSchema,
});
export type UpsertTournamentStaffInput = z.infer<typeof UpsertTournamentStaffSchema>;

export const UpdateIntegrationSchema = z.object({
  provider: IntegrationProviderSchema,
  enabled: z.boolean().optional(),
  external_id: z.string().trim().min(1).optional().nullable(),
  config: z.record(z.string(), z.unknown()).optional(),
  secret_payload: z.string().trim().min(1).optional(),
  cleanupExternalResources: z.boolean().optional().default(false),
});
export type UpdateIntegrationInput = z.infer<typeof UpdateIntegrationSchema>;

// Common Zod Schemas
export const CreateTournamentSchema = z.object({
  name: z.string().min(2, "Le nom du tournoi doit comporter au moins 2 caractères"),
  guild_id: z.string().min(1, "guild_id obligatoire").optional(),
  organization_id: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  game_type: z.string().default("GENERIC"),
  language: LocaleSchema.optional(),
  checkin_mode: CheckinModeSchema.default("ENABLED"),
  start_at: z.string().optional().nullable(),
  checkin_start_at: z.string().optional().nullable(),
  checkin_end_at: z.string().optional().nullable(),
});

/** Déclaration de score Web par le capitaine d'une équipe participante ou un membre du staff (SEC-30 / INT-02). */
export const WebReportScoreSchema = z.object({
  team1_score: z.number().int().min(0).max(99),
  team2_score: z.number().int().min(0).max(99),
});
export type WebReportScoreInput = z.infer<typeof WebReportScoreSchema>;

/** Inscription autonome d'une équipe depuis le portail Web (INT-02). */
export const WebRegisterTeamSchema = z.object({
  name: z.string().trim().min(1, "Le nom de l'équipe est obligatoire").max(32),
  captain_ingame_name: z.string().trim().min(1, "Le pseudo en jeu du capitaine est obligatoire").max(50),
  captain_friend_code: z.string().trim().min(1, "Le code ami du capitaine est obligatoire").max(25),
  members: z
    .array(
      z.object({
        ingame_name: z.string().trim().min(1).max(50),
        friend_code: z.string().trim().min(1).max(25),
      }),
    )
    .max(9)
    .default([]),
});
export type WebRegisterTeamInput = z.infer<typeof WebRegisterTeamSchema>;

/** Corps de `PUT /api/tournaments/:id/settings` (mise à jour des paramètres du tournoi, #15). */
export const TournamentSettingsUpdateSchema = z.object({
  start_at: z.string().optional().nullable(),
  checkin_start_at: z.string().optional().nullable(),
  checkin_end_at: z.string().optional().nullable(),
  checkin_mode: CheckinModeSchema.default("ENABLED"),
  discord_registration_channel_id: z.string().optional().nullable(),
  discord_announcement_channel_id: z.string().optional().nullable(),
  discord_checkin_channel_id: z.string().optional().nullable(),
  discord_captain_role_id: z.string().optional().nullable(),
  discord_to_role_id: z.string().optional().nullable(),
  language: LocaleSchema.optional().nullable(),
});
export type TournamentSettingsUpdateInput = z.infer<typeof TournamentSettingsUpdateSchema>;

export const ReportScoreSchema = z.object({
  match_id: z.uuid(),
  team1_score: z.number().min(0),
  team2_score: z.number().min(0),
  reported_by_team_id: z.string().optional(),
});

/** Bornes d'un score saisi (alignées sur `isValidScore` côté Discord et la contrainte SQL `>= 0`). */
const MATCH_SCORE_MAX = 99;
const MatchScoreSchema = z.number().int().min(0).max(MATCH_SCORE_MAX);

/** Statuts qu'un TO peut imposer via un score forcé : résultat ordinaire ou forfait (SCR-10). */
export const FORCE_SCORE_STATUSES = ["COMPLETED", "FF"] as const;

/** Corps de `PUT /api/matches/:id/force-score` (back-office). Les clés inconnues (`guildId`) sont retirées. */
export const ForceScoreSchema = z.object({
  team1_score: MatchScoreSchema,
  team2_score: MatchScoreSchema,
  status: z.enum(FORCE_SCORE_STATUSES),
});
export type ForceScoreInput = z.infer<typeof ForceScoreSchema>;

// Bornes alignées sur le schéma SQL (`teams.name VARCHAR(32)`, `team_members` VARCHAR(50) / VARCHAR(25)).
export const TEAM_NAME_MAX_LENGTH = 32;
export const TEAM_MEMBERS_MAX = 10;
export const DiscordSnowflakeSchema = z.string().regex(/^\d{17,20}$/, "Identifiant Discord invalide");

/**
 * Génère un identifiant Discord synthétique (18 chiffres, préfixe 000000)
 * pour les équipes manuelles ou tournois fermés sans compte Discord (#15).
 * Les snowflakes Discord réels étant des entiers sans zéro de tête, le préfixe 000000
 * garantit l'absence de collision avec de vrais comptes.
 */
export function generateSyntheticDiscordId(): string {
  const randomPart = Math.floor(100000000000 + Math.random() * 900000000000).toString();
  return `000000${randomPart}`;
}

export function isSyntheticDiscordId(id: string | null | undefined): boolean {
  return typeof id === "string" && (id.startsWith("000000") || id.startsWith("999999"));
}

export const CreateTeamMemberSchema = z.object({
  user_id: DiscordSnowflakeSchema.nullable().default(null),
  ingame_name: z.string().trim().max(50),
  friend_code: z.string().trim().max(25),
  is_captain: z.boolean().default(false),
});

/**
 * Corps de `POST /api/teams` (ajout manuel d'une équipe par un TO, REG-09).
 * `is_checked_in` absent ➜ le bot applique la règle par défaut selon l'état du tournoi.
 */
export const CreateTeamSchema = z.object({
  tournament_id: z.uuid(),
  name: z.string().trim().min(1, "Le nom de l'équipe est obligatoire").max(TEAM_NAME_MAX_LENGTH),
  captain_discord_id: DiscordSnowflakeSchema,
  is_checked_in: z.boolean().optional(),
  members: z.array(CreateTeamMemberSchema).max(TEAM_MEMBERS_MAX).default([]),
});
export type CreateTeamInput = z.infer<typeof CreateTeamSchema>;

/**
 * Corps de `PUT /api/teams/:id` (modification d'une équipe par un TO, REG-10).
 * `captain_discord_id` absent ➜ inchangé (jamais `null` : colonne NOT NULL) ;
 * `members` absent ou vide ➜ roster inchangé, sinon il est remplacé en entier.
 */
export const UpdateTeamSchema = z.object({
  name: CreateTeamSchema.shape.name,
  captain_discord_id: DiscordSnowflakeSchema.optional(),
  members: z.array(CreateTeamMemberSchema).max(TEAM_MEMBERS_MAX).optional(),
});
export type UpdateTeamInput = z.infer<typeof UpdateTeamSchema>;

/**
 * Corps de `POST /api/teams/generate-fake` (back-office de test, REG-07). Un `count` au-delà de
 * `MAX_FAKE_TEAMS` reste accepté : la route le plafonne. Les clés inconnues (`guildId`) sont retirées.
 */
export const GenerateFakeTeamsSchema = z.object({
  tournament_id: z.uuid(),
  count: z.number().int().positive(),
});
export type GenerateFakeTeamsInput = z.infer<typeof GenerateFakeTeamsSchema>;

// ─── Placement d'une phase (PUT /api/phases/:id/seeding) ─────────────────────

/** Nombre maximal d'emplacements d'une phase : borne la taille du placement et la valeur absolue d'un seed. */
export const MAX_PHASE_SEEDS = 256;

const PhaseSeedSchema = z.object({
  team_id: z.uuid(),
  // Seed négatif = départ en bracket perdant (double élimination) ; 0 n'est pas un emplacement.
  seed: z.number().int().min(-MAX_PHASE_SEEDS).max(MAX_PHASE_SEEDS).refine((seed) => seed !== 0, "Seed invalide"),
});

/**
 * Corps de `PUT /api/phases/:id/seeding` (PH-02). Tableau vide ➜ la phase est vidée.
 * Une équipe n'occupe qu'un emplacement et un emplacement (|seed|, `3` et `-3` compris) n'a qu'une équipe.
 * Les clés inconnues (`guildId`) sont retirées.
 */
export const PhaseSeedingSchema = z.object({
  participants: z
    .array(PhaseSeedSchema)
    .max(MAX_PHASE_SEEDS)
    .refine((list) => new Set(list.map((p) => p.team_id)).size === list.length, "Équipe placée plusieurs fois")
    .refine((list) => new Set(list.map((p) => Math.abs(p.seed))).size === list.length, "Emplacement attribué plusieurs fois"),
});
export type PhaseSeedingInput = z.infer<typeof PhaseSeedingSchema>;

// ─── Barème de points des poules (phase.settings) ────────────────────────────
// Source unique partagée par le formulaire web, la route PUT /api/phases/:id,
// le classement persisté (LeaderboardService) et le classement web (LeaderboardTable).

export const GROUP_POINTS_MIN = -99;
export const GROUP_POINTS_MAX = 99;

export const GROUP_POINTS_KEYS = ["points_win", "points_draw", "points_loss", "points_forfeit"] as const;
export type GroupPointsKey = (typeof GROUP_POINTS_KEYS)[number];
export type GroupPoints = Record<GroupPointsKey, number>;

export const GROUP_POINTS_DEFAULTS: Readonly<GroupPoints> = Object.freeze({
  points_win: 3,
  points_draw: 1,
  points_loss: 0,
  points_forfeit: 0,
});

/** Une valeur de points : entier borné (le forfait peut être négatif, à titre de pénalité). */
export const GroupPointValueSchema = z.number().int().min(GROUP_POINTS_MIN).max(GROUP_POINTS_MAX);

/**
 * Validation à l'écriture de `phase.settings` : les clés de points présentes doivent être valides,
 * les autres clés (bracket_reset, swiss_rounds_count…) sont conservées telles quelles.
 */
export const GroupPointsSettingsSchema = z
  .object({
    points_win: GroupPointValueSchema.optional(),
    points_draw: GroupPointValueSchema.optional(),
    points_loss: GroupPointValueSchema.optional(),
    points_forfeit: GroupPointValueSchema.optional(),
  })
  .loose();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lecture tolérante du barème : chaque clé valide est conservée, chaque clé absente ou invalide
 * (`""`, `NaN`, chaîne, décimal, hors bornes) retombe sur sa valeur par défaut.
 */
export function resolveGroupPoints(settings: unknown): GroupPoints {
  const source = isPlainObject(settings) ? settings : {};
  const resolved: GroupPoints = { ...GROUP_POINTS_DEFAULTS };
  for (const key of GROUP_POINTS_KEYS) {
    const parsed = GroupPointValueSchema.safeParse(source[key]);
    if (parsed.success) resolved[key] = parsed.data;
  }
  return resolved;
}

// ─── Classement d'une phase (poules & Suisse) ────────────────────────────────
// Calcul unique partagé par le classement persisté (LeaderboardService ➜ phase_teams)
// et le classement web (LeaderboardTable) : bot et web affichent les mêmes valeurs (LB-06).

/** Statuts de match qui comptent au classement ; tous les autres (PENDING, CONTESTED, DSQ…) sont ignorés. */
export const STANDINGS_MATCH_STATUSES = ["COMPLETED", "FF", "BYE"] as const;

/**
 * Match terminé : son résultat est acquis (`COMPLETED`, `FF`, `BYE`). Sert à la fin de ronde Suisse (SCR-08)
 * et suit exactement les statuts comptés au classement.
 */
export function isFinishedMatchStatus(status: string): boolean {
  return (STANDINGS_MATCH_STATUSES as readonly string[]).includes(status);
}

/** Statut d'un match généré et pas encore joué. */
export const MATCH_INITIAL_STATUS = "PENDING";

/**
 * Match réel (deux équipes) commencé : statut sorti de `PENDING` (joué, forfait, déclaré, contesté…) ou score non nul.
 * Un BYE (une seule équipe) n'est jamais commencé. Garde le placement d'une phase (SCR-09). Tout statut
 * terminé (`isFinishedMatchStatus`) est donc commencé, mais l'inverse est faux (`WAITING_VALIDATION`, `CONTESTED`).
 */
export function isMatchStarted(match: StandingsMatch): boolean {
  if (match.team1_id === null || match.team2_id === null) return false;
  return match.status !== MATCH_INITIAL_STATUS || (match.team1_score ?? 0) > 0 || (match.team2_score ?? 0) > 0;
}

/** Champs d'un match lus par le calcul du classement. */
export interface StandingsMatch {
  team1_id: string | null;
  team2_id: string | null;
  team1_score: number | null;
  team2_score: number | null;
  status: string;
}

export interface TeamStanding {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  forfeits: number;
  score_for: number;
  score_against: number;
  differential: number;
  points: number;
}

type MatchOutcome = "win" | "draw" | "loss" | "forfeit";

function emptyStanding(): TeamStanding {
  return {
    played: 0, wins: 0, draws: 0, losses: 0, forfeits: 0,
    score_for: 0, score_against: 0, differential: 0, points: 0,
  };
}

function isStandingsStatus(status: string): boolean {
  return (STANDINGS_MATCH_STATUSES as readonly string[]).includes(status);
}

function applyOutcome(
  standing: TeamStanding,
  outcome: MatchOutcome,
  scoreFor: number,
  scoreAgainst: number,
  points: GroupPoints,
): void {
  standing.played += 1;
  standing.score_for += scoreFor;
  standing.score_against += scoreAgainst;
  standing.differential = standing.score_for - standing.score_against;
  switch (outcome) {
    case "win":
      standing.wins += 1;
      standing.points += points.points_win;
      break;
    case "draw":
      standing.draws += 1;
      standing.points += points.points_draw;
      break;
    case "loss":
      standing.losses += 1;
      standing.points += points.points_loss;
      break;
    case "forfeit":
      standing.forfeits += 1;
      standing.points += points.points_forfeit;
      break;
  }
}

/**
 * Classement des équipes `teamIds` à partir de leurs matchs.
 * - `COMPLETED` : victoire / nul / défaite selon le score.
 * - `FF` : forfait **exclusif** — le gagnant prend `points_win`, le perdant un forfait et `points_forfeit`
 *   (jamais `points_loss` en plus, LB-05). À égalité, double forfait (LB-07).
 * - `BYE`, ou adversaire `null` : victoire de l'équipe présente au barème `points_win` (LB-08, SWS-05).
 * Les équipes absentes de `teamIds` (autre groupe) ne sont pas créditées.
 */
export function computeStandings(
  teamIds: readonly string[],
  matches: readonly StandingsMatch[],
  points: GroupPoints,
): Map<string, TeamStanding> {
  const standings = new Map<string, TeamStanding>();
  for (const teamId of teamIds) standings.set(teamId, emptyStanding());

  for (const match of matches) {
    if (!isStandingsStatus(match.status)) continue;
    const s1 = match.team1_score ?? 0;
    const s2 = match.team2_score ?? 0;
    const team1 = match.team1_id === null ? undefined : standings.get(match.team1_id);
    const team2 = match.team2_id === null ? undefined : standings.get(match.team2_id);

    const isBye = match.status === "BYE" || match.team1_id === null || match.team2_id === null;
    if (isBye) {
      // Une seule équipe réelle : elle gagne, son score est le plus haut des deux (1-0 à la génération).
      const realTeam = match.team1_id !== null ? team1 : team2;
      if (realTeam) applyOutcome(realTeam, "win", Math.max(s1, s2), Math.min(s1, s2), points);
      continue;
    }

    let outcome1: MatchOutcome;
    let outcome2: MatchOutcome;
    if (match.status === "FF") {
      outcome1 = s1 > s2 ? "win" : "forfeit";
      outcome2 = s2 > s1 ? "win" : "forfeit";
    } else {
      outcome1 = s1 > s2 ? "win" : s1 < s2 ? "loss" : "draw";
      outcome2 = s2 > s1 ? "win" : s2 < s1 ? "loss" : "draw";
    }
    if (team1) applyOutcome(team1, outcome1, s1, s2, points);
    if (team2) applyOutcome(team2, outcome2, s2, s1, points);
  }

  return standings;
}

/** Ordre du classement : points ➜ différence ➜ score marqué (décroissants). */
export function compareStandings(
  a: Pick<TeamStanding, "points" | "differential" | "score_for">,
  b: Pick<TeamStanding, "points" | "differential" | "score_for">,
): number {
  if (b.points !== a.points) return b.points - a.points;
  if (b.differential !== a.differential) return b.differential - a.differential;
  return b.score_for - a.score_for;
}

/**
 * Confrontation directe entre 2 équipes (Head-to-Head).
 * Renvoie un nombre > 0 si teamA a l'avantage sur teamB,
 * < 0 si teamB a l'avantage, ou 0 en cas d'égalité ou si aucun match joué.
 */
export function computeHeadToHead(
  teamAId: string,
  teamBId: string,
  matches: readonly StandingsMatch[],
): number {
  let netWins = 0;
  let netScore = 0;

  for (const m of matches) {
    if (!isStandingsStatus(m.status)) continue;
    const isTeam1A = m.team1_id === teamAId && m.team2_id === teamBId;
    const isTeam2A = m.team2_id === teamAId && m.team1_id === teamBId;
    if (!isTeam1A && !isTeam2A) continue;

    const sA = (isTeam1A ? m.team1_score : m.team2_score) ?? 0;
    const sB = (isTeam1A ? m.team2_score : m.team1_score) ?? 0;

    if (sA > sB) netWins += 1;
    else if (sB > sA) netWins -= 1;

    netScore += sA - sB;
  }

  if (netWins !== 0) return netWins;
  return netScore;
}

/**
 * Calcul du score Buchholz (somme des points de tous les adversaires réels affrontés).
 * Ignore les matchs BYE et statuts non terminés.
 */
export function computeBuchholz(
  teamId: string,
  matches: readonly StandingsMatch[],
  standings: Map<string, Pick<TeamStanding, "points">>,
): number {
  let buchholz = 0;
  const facedOpponents = new Set<string>();

  for (const m of matches) {
    if (!isStandingsStatus(m.status)) continue;
    if (m.status === "BYE" || m.team1_id === null || m.team2_id === null) continue;

    let oppId: string | null = null;
    if (m.team1_id === teamId && m.team2_id) oppId = m.team2_id;
    else if (m.team2_id === teamId && m.team1_id) oppId = m.team1_id;

    if (oppId && !facedOpponents.has(oppId)) {
      facedOpponents.add(oppId);
      const oppStanding = standings.get(oppId);
      if (oppStanding) {
        buchholz += oppStanding.points;
      }
    }
  }

  return buchholz;
}

export interface TiebreakOptions {
  matches?: readonly StandingsMatch[];
  buchholzStandings?: Map<string, Pick<TeamStanding, "points">>;
}

/**
 * Ordre étendu du classement avec critères de départage e-sport :
 * 1. Points décroissants
 * 2. Différence de score (Goal Average direct) décroissante
 * 3. Confrontation directe (Head-to-Head) si match joué entre les 2 équipes
 * 4. Score Buchholz décroissant (en ronde suisse) si disponible
 * 5. Buts / scores marqués décroissants
 */
export function compareStandingsExtended(
  a: Pick<TeamStanding, "points" | "differential" | "score_for"> & { id: string },
  b: Pick<TeamStanding, "points" | "differential" | "score_for"> & { id: string },
  options?: TiebreakOptions,
): number {
  if (b.points !== a.points) return b.points - a.points;
  if (b.differential !== a.differential) return b.differential - a.differential;

  if (options?.matches) {
    const h2h = computeHeadToHead(a.id, b.id, options.matches);
    if (h2h !== 0) return -h2h; // si a a l'avantage (h2h > 0), a doit être placé avant b (négatif)
  }

  if (options?.buchholzStandings && options?.matches) {
    const bBuchholz = computeBuchholz(b.id, options.matches, options.buchholzStandings);
    const aBuchholz = computeBuchholz(a.id, options.matches, options.buchholzStandings);
    if (bBuchholz !== aBuchholz) return bBuchholz - aBuchholz;
  }

  return b.score_for - a.score_for;
}


