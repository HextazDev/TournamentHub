import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import {
  AcceptInviteSchema,
  canPerform,
  CreateInviteSchema,
  CreateOrganizationSchema,
  DeleteOrganizationSchema,
  IntegrationProviderSchema,
  MAX_OWNED_ORGANIZATIONS,
  TransferOwnershipSchema,
  UpdateIntegrationSchema,
  UpdateOrganizationSchema,
  UpsertOrganizationMemberSchema,
  UpsertTournamentStaffSchema,
  type OrganizationAction,
} from "@hub/shared";
import { supabase } from "../lib/supabase";
import { encryptSecretPayload } from "../utils/crypto";
import { DomainError, sendServerError } from "../utils/serverError";
import { resolveOrganization, verifyTournamentGuild, type ResolvedOrganization } from "../utils/tenant";
import {
  checkGuildManageRights,
  invalidateGuildAccess,
  resolveMemberAccess,
  type DiscordClientLike,
} from "../services/MemberAccessService";
import { refreshGuildAccess, type GuildFetcher } from "../services/AccessRefreshService";
import { discordIntegrationPlugin } from "../services/integrations/DiscordIntegrationPlugin";
import { logger } from "../utils/logger";

export const organizationRouter = Router();

const UNIQUE_VIOLATION = "23505";
const QUOTA_EXCEEDED = "HT001";
const LAST_OWNER = "HT002";
const INVALID_INVITE = "HT003";
const INVALID_TRANSFER = "HT004";

const NATIVE_MANAGER_ROLES: ReadonlySet<string> = new Set(["ORG_OWNER", "OWNER", "ORG_ADMIN", "ADMIN"]);

function getCallerId(req: Request): string | null {
  const fromCheck = req.adminCheck?.discordId;
  if (fromCheck) return fromCheck;
  const fromHeader = req.headers["x-discord-user-id"];
  return typeof fromHeader === "string" && fromHeader.length > 0 ? fromHeader : null;
}

const FALLBACK_DISCORD_CLIENT: DiscordClientLike = {
  guilds: {
    fetch: () => Promise.reject(new Error("Unknown Guild")),
  },
};

const discordClientOf = (req: Request): DiscordClientLike =>
  (req.app?.locals?.discordClient as DiscordClientLike | undefined) ?? FALLBACK_DISCORD_CLIENT;

async function resolveCallerOrgAccess(req: Request, orgIdentifier: string) {
  const callerId = getCallerId(req);
  if (!callerId) return { ok: false as const, status: 401, code: "NOT_LOGGED_IN", error: "User identity required" };

  const org = await resolveOrganization(orgIdentifier);
  if (!org) return { ok: false as const, status: 404, code: "NO_RIGHTS", error: "Organization not found" };

  if (
    req.adminCheck &&
    (req.adminCheck.guildId === org.id ||
      req.adminCheck.guildId === org.slug ||
      req.adminCheck.guildId === org.discordGuildId)
  ) {
    return { ok: true as const, callerId, org, access: req.adminCheck.access };
  }

  const decision = await resolveMemberAccess(discordClientOf(req), org.id, callerId);
  if (!decision.allowed) {
    return {
      ok: false as const,
      status: decision.code === "CHECK_FAILED" ? 503 : 403,
      code: decision.code,
      error: "Access denied",
    };
  }
  return { ok: true as const, callerId, org, access: decision.access };
}

/** Authentifie l'appelant et exige une action sur l'organisation ; répond lui-même en cas de refus. */
async function authorize(req: Request, res: Response, orgId: string, action: OrganizationAction, tournamentId?: string) {
  const auth = await resolveCallerOrgAccess(req, orgId);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error, code: auth.code });
    return null;
  }
  if (!canPerform(auth.access, action, tournamentId)) {
    const code = action === "MANAGE_TOURNAMENT_ROLES" ? "TOURNAMENT_ROLES_RESERVED" : "SERVER_SETTINGS_RESERVED";
    res.status(403).json({ error: "Action reserved to organization administrators", code });
    return null;
  }
  return auth;
}

/** Une même décision d'accès est mise en cache sous chaque identifiant de l'organisation (UUID, slug, serveur). */
function invalidateOrganizationCaches(org: ResolvedOrganization, extraGuildId?: string | null): void {
  invalidateGuildAccess(org.id);
  invalidateGuildAccess(org.slug);
  if (org.discordGuildId) invalidateGuildAccess(org.discordGuildId);
  if (extraGuildId) invalidateGuildAccess(extraGuildId);
}

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

// POST /api/organizations — Créer une organisation 100 % Web sans serveur Discord (SEC-27)
organizationRouter.post("/", async (req, res) => {
  try {
    const callerId = getCallerId(req);
    if (!callerId) {
      return res.status(401).json({ error: "User identity required", code: "NOT_LOGGED_IN" });
    }

    const parsed = CreateOrganizationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
    }

    // SEC-06 : organisation et propriétaire dans une seule transaction, quota sérialisé par le trigger SQL.
    const { data, error } = await supabase.rpc("create_organization_with_owner", {
      p_slug: parsed.data.slug,
      p_name: parsed.data.name,
      p_language: parsed.data.language,
      p_logo_url: parsed.data.logo_url ?? null,
      p_invite_url: parsed.data.invite_url ?? null,
      p_owner_id: callerId,
    });

    if (error?.code === QUOTA_EXCEEDED) {
      return res.status(403).json({
        error: `Quota atteint : vous ne pouvez posséder que ${MAX_OWNED_ORGANIZATIONS} organisations maximum.`,
        code: "QUOTA_EXCEEDED",
      });
    }
    if (error?.code === UNIQUE_VIOLATION) {
      return res.status(409).json({ error: "Ce slug d'organisation est déjà utilisé.", code: "SLUG_TAKEN" });
    }
    if (error) throw error;

    return res.status(201).json(data);
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.create");
  }
});

// POST /api/organizations/invites/accept — Accepter une invitation à usage unique (RFC Q2.4)
organizationRouter.post("/invites/accept", async (req, res) => {
  try {
    const callerId = getCallerId(req);
    if (!callerId) {
      return res.status(401).json({ error: "User identity required", code: "NOT_LOGGED_IN" });
    }
    const parsed = AcceptInviteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid invitation", code: "INVALID_INVITE" });
    }

    const { data, error } = await supabase.rpc("accept_organization_invite", {
      p_token_hash: hashToken(parsed.data.token),
      p_user_id: callerId,
    });
    if (error?.code === INVALID_INVITE) {
      return res.status(410).json({ error: "Invitation invalide, expirée ou déjà utilisée.", code: "INVALID_INVITE" });
    }
    if (error) throw error;

    const accepted = (Array.isArray(data) ? data[0] : data) as { organization_id: string; slug: string } | undefined;
    if (!accepted) throw new Error("accept_organization_invite n'a renvoyé aucune organisation");
    const org = await resolveOrganization(accepted.organization_id);
    if (org) invalidateOrganizationCaches(org);
    return res.status(200).json(accepted);
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.acceptInvite");
  }
});

// GET /api/organizations/:orgId — Profil, membres et intégrations, réservés aux gestionnaires (SEC-04, SEC-19)
organizationRouter.get("/:orgId", async (req, res) => {
  try {
    const auth = await authorize(req, res, req.params.orgId, "MANAGE_ORG_SETTINGS");
    if (!auth) return undefined;

    const [membersRes, integrationsRes] = await Promise.all([
      supabase.from("organization_members").select("*").eq("organization_id", auth.org.id),
      supabase.from("organization_integrations").select("*").eq("organization_id", auth.org.id),
    ]);
    if (membersRes.error) throw membersRes.error;
    if (integrationsRes.error) throw integrationsRes.error;

    const integrations = (integrationsRes.data ?? []) as { id: string }[];
    const { data: secrets, error: secretsError } = integrations.length
      ? await supabase
          .from("organization_integration_secrets")
          .select("integration_id")
          .in("integration_id", integrations.map((i) => i.id))
      : { data: [], error: null };
    if (secretsError) throw secretsError;
    const withSecret = new Set(((secrets ?? []) as { integration_id: string }[]).map((s) => s.integration_id));

    return res.status(200).json({
      ...auth.org,
      organization: auth.org,
      members: membersRes.data ?? [],
      integrations: integrations.map((integration) => ({ ...integration, has_secret: withSecret.has(integration.id) })),
    });
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.get");
  }
});

// PUT /api/organizations/:orgId — Modifier les paramètres de l'organisation
organizationRouter.put("/:orgId", async (req, res) => {
  try {
    const auth = await authorize(req, res, req.params.orgId, "MANAGE_ORG_SETTINGS");
    if (!auth) return undefined;

    const parsed = UpdateOrganizationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
    }

    if (parsed.data.slug && parsed.data.slug !== auth.org.slug) {
      const { data: taken, error: takenError } = await supabase
        .from("organizations")
        .select("id")
        .eq("slug", parsed.data.slug)
        .maybeSingle();
      if (takenError) throw takenError;
      if (taken) return res.status(409).json({ error: "Ce slug d'organisation est déjà utilisé.", code: "SLUG_TAKEN" });
    }

    const payload = Object.fromEntries(
      Object.entries({
        ...parsed.data,
        ...(parsed.data.logo_url !== undefined ? { icon_url: parsed.data.logo_url } : {}),
        updated_at: new Date().toISOString(),
      }).filter(([, v]) => v !== undefined),
    );

    const { data, error } = await supabase
      .from("organizations")
      .update(payload)
      .eq("id", auth.org.id)
      .select()
      .maybeSingle();

    if (error?.code === UNIQUE_VIOLATION) {
      return res.status(409).json({ error: "Ce slug d'organisation est déjà utilisé.", code: "SLUG_TAKEN" });
    }
    if (error) throw error;
    invalidateOrganizationCaches(auth.org);
    return res.status(200).json(data ?? { ...auth.org, ...payload });
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.update");
  }
});

// DELETE /api/organizations/:orgId — Suppression définitive, réservée au propriétaire (RFC Q2)
organizationRouter.delete("/:orgId", async (req, res) => {
  try {
    const auth = await authorize(req, res, req.params.orgId, "DELETE_ORGANIZATION");
    if (!auth) return undefined;

    const parsed = DeleteOrganizationSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.confirm_slug !== auth.org.slug) {
      return res.status(400).json({ error: "Confirmation incorrecte.", code: "CONFIRMATION_MISMATCH" });
    }

    const { error } = await supabase.from("organizations").delete().eq("id", auth.org.id);
    if (error) throw error;
    invalidateOrganizationCaches(auth.org);
    return res.status(200).json({ success: true });
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.delete");
  }
});

// POST /api/organizations/:orgId/transfer — Transfert de propriété atomique (RFC Q2.4)
organizationRouter.post("/:orgId/transfer", async (req, res) => {
  try {
    const auth = await authorize(req, res, req.params.orgId, "TRANSFER_OWNERSHIP");
    if (!auth) return undefined;

    const parsed = TransferOwnershipSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
    }

    const { error } = await supabase.rpc("transfer_organization_ownership", {
      p_organization_id: auth.org.id,
      p_from_user_id: auth.callerId,
      p_to_user_id: parsed.data.new_owner_id,
      p_demote_self: parsed.data.demote_self,
    });
    if (error?.code === INVALID_TRANSFER) {
      return res.status(400).json({ error: "Le nouveau propriétaire doit être un administrateur de l'organisation.", code: "INVALID_TRANSFER" });
    }
    if (error?.code === QUOTA_EXCEEDED) {
      return res.status(400).json({ error: `Ce membre possède déjà ${MAX_OWNED_ORGANIZATIONS} organisations.`, code: "QUOTA_EXCEEDED" });
    }
    if (error) throw error;

    invalidateOrganizationCaches(auth.org);
    return res.status(200).json({ success: true });
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.transfer");
  }
});

// PUT /api/organizations/:orgId/members — Ajouter ou modifier un membre natif (SEC-27)
organizationRouter.put("/:orgId/members", async (req, res) => {
  try {
    const auth = await authorize(req, res, req.params.orgId, "MANAGE_ORG_MEMBERS");
    if (!auth) return undefined;

    const parsed = UpsertOrganizationMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
    }

    const { user_id, role } = parsed.data;
    const { data: currentMembers, error: membersErr } = await supabase
      .from("organization_members")
      .select("*")
      .eq("organization_id", auth.org.id);
    if (membersErr) throw membersErr;

    const list = (currentMembers ?? []) as { organization_id: string; user_id: string; role: string }[];
    const targetCurrent = list.find((m) => m.user_id === user_id);
    const isTargetOwner = targetCurrent?.role === "ORG_OWNER" || targetCurrent?.role === "OWNER";

    // Seul ORG_OWNER peut nommer ou modifier un ORG_OWNER
    if ((role === "ORG_OWNER" || isTargetOwner) && !canPerform(auth.access, "TRANSFER_OWNERSHIP")) {
      return res.status(403).json({ error: "Seul un propriétaire (ORG_OWNER) peut gérer le rôle ORG_OWNER.", code: "NO_RIGHTS" });
    }

    // SEC-27 : interdiction de rétrograder le dernier ORG_OWNER
    if (isTargetOwner && role !== "ORG_OWNER") {
      const otherOwners = list.filter(
        (m) => m.user_id !== user_id && (m.role === "ORG_OWNER" || m.role === "OWNER"),
      );
      if (otherOwners.length === 0) {
        return res.status(400).json({ error: "Impossible de rétrograder le dernier propriétaire (ORG_OWNER) de l'organisation.", code: "LAST_OWNER" });
      }
    }

    const { error } = targetCurrent
      ? await supabase
          .from("organization_members")
          .update({ role })
          .eq("organization_id", auth.org.id)
          .eq("user_id", user_id)
      : await supabase.from("organization_members").insert({
          organization_id: auth.org.id,
          user_id,
          role,
          created_at: new Date().toISOString(),
        });
    if (error?.code === QUOTA_EXCEEDED) {
      return res.status(400).json({ error: `Ce membre possède déjà ${MAX_OWNED_ORGANIZATIONS} organisations.`, code: "QUOTA_EXCEEDED" });
    }
    if (error?.code === LAST_OWNER) {
      return res.status(400).json({ error: "Impossible de rétrograder le dernier propriétaire (ORG_OWNER) de l'organisation.", code: "LAST_OWNER" });
    }
    if (error) throw error;

    invalidateOrganizationCaches(auth.org);
    return res.status(200).json({ organization_id: auth.org.id, user_id, role });
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.upsertMember");
  }
});

// DELETE /api/organizations/:orgId/members/:userId — Retirer un membre natif (SEC-27)
organizationRouter.delete("/:orgId/members/:userId", async (req, res) => {
  try {
    const auth = await authorize(req, res, req.params.orgId, "MANAGE_ORG_MEMBERS");
    if (!auth) return undefined;

    const targetUserId = req.params.userId;
    const { data: currentMembers, error: membersErr } = await supabase
      .from("organization_members")
      .select("*")
      .eq("organization_id", auth.org.id);
    if (membersErr) throw membersErr;

    const list = (currentMembers ?? []) as { user_id: string; role: string }[];
    const targetCurrent = list.find((m) => m.user_id === targetUserId);
    if (!targetCurrent) {
      return res.status(404).json({ error: "Member not found" });
    }

    const isTargetOwner = targetCurrent.role === "ORG_OWNER" || targetCurrent.role === "OWNER";
    if (isTargetOwner && !canPerform(auth.access, "TRANSFER_OWNERSHIP")) {
      return res.status(403).json({ error: "Seul un propriétaire peut retirer un propriétaire.", code: "NO_RIGHTS" });
    }

    if (isTargetOwner) {
      const otherOwners = list.filter(
        (m) => m.user_id !== targetUserId && (m.role === "ORG_OWNER" || m.role === "OWNER"),
      );
      if (otherOwners.length === 0) {
        return res.status(400).json({ error: "Impossible de supprimer le dernier propriétaire (ORG_OWNER) de l'organisation.", code: "LAST_OWNER" });
      }
    }

    const { error } = await supabase
      .from("organization_members")
      .delete()
      .eq("organization_id", auth.org.id)
      .eq("user_id", targetUserId);
    if (error) throw error;

    invalidateOrganizationCaches(auth.org);
    return res.status(200).json({ success: true });
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.deleteMember");
  }
});

// POST /api/organizations/:orgId/invites — Créer une invitation ; le jeton n'est renvoyé qu'ici (RFC 5.2)
organizationRouter.post("/:orgId/invites", async (req, res) => {
  try {
    const auth = await authorize(req, res, req.params.orgId, "MANAGE_ORG_MEMBERS");
    if (!auth) return undefined;

    const parsed = CreateInviteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
    }
    const { role, tournament_id, expires_in_hours } = parsed.data;
    if (tournament_id && !(await verifyTournamentGuild(tournament_id, auth.org.id))) {
      return res.status(403).json({ error: "Ce tournoi n'appartient pas à cette organisation." });
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + expires_in_hours * 3_600_000).toISOString();
    const { data, error } = await supabase
      .from("organization_invites")
      .insert({
        organization_id: auth.org.id,
        token_hash: hashToken(token),
        role,
        tournament_id: tournament_id ?? null,
        created_by: auth.callerId,
        expires_at: expiresAt,
      })
      .select("id, role, tournament_id, expires_at")
      .single();
    if (error) throw error;

    return res.status(201).json({ ...data, token });
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.createInvite");
  }
});

// GET /api/organizations/:orgId/invites — Invitations en attente, sans jeton ni hash
organizationRouter.get("/:orgId/invites", async (req, res) => {
  try {
    const auth = await authorize(req, res, req.params.orgId, "MANAGE_ORG_MEMBERS");
    if (!auth) return undefined;

    const { data, error } = await supabase
      .from("organization_invites")
      .select("id, role, tournament_id, created_by, expires_at, used_by, used_at, created_at")
      .eq("organization_id", auth.org.id);
    if (error) throw error;
    return res.status(200).json(data ?? []);
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.listInvites");
  }
});

// DELETE /api/organizations/:orgId/invites/:inviteId — Révoquer une invitation
organizationRouter.delete("/:orgId/invites/:inviteId", async (req, res) => {
  try {
    const auth = await authorize(req, res, req.params.orgId, "MANAGE_ORG_MEMBERS");
    if (!auth) return undefined;

    const { error } = await supabase
      .from("organization_invites")
      .delete()
      .eq("id", req.params.inviteId)
      .eq("organization_id", auth.org.id);
    if (error) throw error;
    return res.status(200).json({ success: true });
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.revokeInvite");
  }
});

// GET /api/organizations/:orgId/tournaments/:tournamentId/staff — Staff d'un tournoi
organizationRouter.get("/:orgId/tournaments/:tournamentId/staff", async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const auth = await authorize(req, res, req.params.orgId, "MANAGE_TOURNAMENT_ROLES", tournamentId);
    if (!auth) return undefined;
    if (!(await verifyTournamentGuild(tournamentId, auth.org.id))) {
      return res.status(403).json({ error: "Ce tournoi n'appartient pas à cette organisation." });
    }
    const { data, error } = await supabase.from("tournament_staff").select("*").eq("tournament_id", tournamentId);
    if (error) throw error;
    return res.status(200).json(data ?? []);
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.listTournamentStaff");
  }
});

// PUT /api/organizations/:orgId/tournaments/:tournamentId/staff — Attribuer un rôle staff de tournoi
organizationRouter.put("/:orgId/tournaments/:tournamentId/staff", async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const auth = await authorize(req, res, req.params.orgId, "MANAGE_TOURNAMENT_ROLES", tournamentId);
    if (!auth) return undefined;
    if (!(await verifyTournamentGuild(tournamentId, auth.org.id))) {
      return res.status(403).json({ error: "Ce tournoi n'appartient pas à cette organisation." });
    }

    const parsed = UpsertTournamentStaffSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
    }

    const { user_id, role } = parsed.data;
    const { data: existing, error: existingError } = await supabase
      .from("tournament_staff")
      .select("*")
      .eq("tournament_id", tournamentId)
      .eq("user_id", user_id)
      .maybeSingle();
    if (existingError) throw existingError;

    const { error } = existing
      ? await supabase
          .from("tournament_staff")
          .update({ role })
          .eq("tournament_id", tournamentId)
          .eq("user_id", user_id)
      : await supabase.from("tournament_staff").insert({
          tournament_id: tournamentId,
          user_id,
          role,
          created_at: new Date().toISOString(),
        });
    if (error) throw error;

    invalidateOrganizationCaches(auth.org);
    return res.status(200).json({ tournament_id: tournamentId, user_id, role });
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.upsertTournamentStaff");
  }
});

// DELETE /api/organizations/:orgId/tournaments/:tournamentId/staff/:userId — Retirer un rôle staff
organizationRouter.delete("/:orgId/tournaments/:tournamentId/staff/:userId", async (req, res) => {
  try {
    const { tournamentId, userId } = req.params;
    const auth = await authorize(req, res, req.params.orgId, "MANAGE_TOURNAMENT_ROLES", tournamentId);
    if (!auth) return undefined;
    if (!(await verifyTournamentGuild(tournamentId, auth.org.id))) {
      return res.status(403).json({ error: "Ce tournoi n'appartient pas à cette organisation." });
    }
    const { error } = await supabase
      .from("tournament_staff")
      .delete()
      .eq("tournament_id", tournamentId)
      .eq("user_id", userId);
    if (error) throw error;
    invalidateOrganizationCaches(auth.org);
    return res.status(200).json({ success: true });
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.deleteTournamentStaff");
  }
});

/**
 * SEC-18 : un serveur ne se rattache qu'avec des droits de gestion vérifiés en direct.
 * Une organisation créée automatiquement à l'installation du bot et encore vide est reprise ; toute autre est un conflit.
 */
async function assertDiscordGuildLinkable(req: Request, org: ResolvedOrganization, guildId: string, callerId: string): Promise<void> {
  const rights = await checkGuildManageRights(discordClientOf(req), guildId, callerId);
  if (rights === "BOT_NOT_IN_GUILD") {
    throw new DomainError(409, "Installez d'abord le bot sur ce serveur Discord.", { code: "BOT_NOT_IN_GUILD" });
  }
  if (rights === "NO_RIGHTS") {
    throw new DomainError(403, "Vous devez pouvoir gérer ce serveur Discord pour le rattacher.", { code: "GUILD_RIGHTS_REQUIRED" });
  }

  const { data: conflict, error } = await supabase
    .from("organization_integrations")
    .select("organization_id")
    .eq("provider", "DISCORD")
    .eq("external_id", guildId)
    .neq("organization_id", org.id)
    .maybeSingle();
  if (error) throw error;
  if (!conflict) return;

  const conflictingId = (conflict as { organization_id: string }).organization_id;
  const alreadyLinked = new DomainError(409, "Cet identifiant externe est déjà rattaché à une autre organisation.", {
    code: "EXTERNAL_ID_ALREADY_LINKED",
  });
  const { data: shell, error: shellError } = await supabase
    .from("organizations")
    .select("id")
    .eq("id", conflictingId)
    .eq("slug", `discord-${guildId}`)
    .maybeSingle();
  if (shellError) throw shellError;
  if (!shell) throw alreadyLinked;

  const { data: shellTournaments, error: tournamentsError } = await supabase
    .from("tournaments")
    .select("id")
    .eq("organization_id", conflictingId)
    .limit(1);
  if (tournamentsError) throw tournamentsError;
  if ((shellTournaments ?? []).length > 0) throw alreadyLinked;

  const { error: deleteError } = await supabase.from("organizations").delete().eq("id", conflictingId);
  if (deleteError) throw deleteError;
}

/** ACC-01 : couper Discord ne doit jamais laisser l'organisation sans personne pour l'administrer. */
async function assertHasNativeManager(orgId: string): Promise<void> {
  const { data, error } = await supabase.from("organization_members").select("role").eq("organization_id", orgId);
  if (error) throw error;
  if (!((data ?? []) as { role: string }[]).some((member) => NATIVE_MANAGER_ROLES.has(member.role))) {
    throw new DomainError(409, "Nommez d'abord un propriétaire ou un administrateur natif de l'organisation.", {
      code: "NO_NATIVE_MANAGER",
    });
  }
}

// PUT /api/organizations/:orgId/integrations/:provider — Activer/configurer/désactiver une intégration (SEC-26/28/29)
organizationRouter.put("/:orgId/integrations/:provider", async (req, res) => {
  try {
    const auth = await authorize(req, res, req.params.orgId, "MANAGE_INTEGRATIONS");
    if (!auth) return undefined;

    const providerParse = IntegrationProviderSchema.safeParse(req.params.provider);
    if (!providerParse.success) {
      return res.status(400).json({ error: "Unknown integration provider" });
    }
    const provider = providerParse.data;

    const parsed = UpdateIntegrationSchema.safeParse({ ...req.body, provider });
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
    }

    const { data: existing, error: existingError } = await supabase
      .from("organization_integrations")
      .select("*")
      .eq("organization_id", auth.org.id)
      .eq("provider", provider)
      .maybeSingle();
    if (existingError) throw existingError;

    const existingRow = existing as {
      id: string;
      enabled: boolean;
      external_id: string | null;
      config: Record<string, unknown> | null;
    } | null;
    const now = new Date().toISOString();
    const previousExternalId = existingRow?.external_id ?? null;
    const externalId = parsed.data.external_id !== undefined ? parsed.data.external_id : previousExternalId;
    // Sans serveur, une intégration Discord ne peut pas rester active : délier revient à la couper.
    const enabled = parsed.data.enabled ?? (parsed.data.external_id === null ? false : (existingRow?.enabled ?? true));
    const wasActive = Boolean(existingRow?.enabled);

    if (provider === "DISCORD") {
      if (enabled && !externalId) {
        return res.status(400).json({ error: "Choisissez un serveur Discord à rattacher.", code: "GUILD_REQUIRED" });
      }
      if (wasActive && !enabled) await assertHasNativeManager(auth.org.id);
      if (enabled && externalId && (!wasActive || externalId !== previousExternalId)) {
        await assertDiscordGuildLinkable(req, auth.org, externalId, auth.callerId);
      }
    } else if (externalId && externalId !== previousExternalId) {
      const { data: conflict, error: conflictError } = await supabase
        .from("organization_integrations")
        .select("organization_id")
        .eq("provider", provider)
        .eq("external_id", externalId)
        .neq("organization_id", auth.org.id)
        .maybeSingle();
      if (conflictError) throw conflictError;
      if (conflict) {
        return res.status(409).json({ error: "Cet identifiant externe est déjà rattaché à une autre organisation.", code: "EXTERNAL_ID_ALREADY_LINKED" });
      }
    }

    // SEC-07 : chiffrer d'abord. Une clé absente ou invalide échoue avant toute écriture.
    const encryptedPayload = parsed.data.secret_payload ? encryptSecretPayload({ secret: parsed.data.secret_payload }) : null;

    const config = { ...(existingRow?.config ?? {}), ...(parsed.data.config ?? {}) };
    const integrationId = existingRow?.id ?? randomUUID();
    const status = enabled ? "CONNECTED" : "DISCONNECTED";

    const { error: writeError } = existingRow
      ? await supabase
          .from("organization_integrations")
          .update({ external_id: externalId, enabled, config, status, last_error: null, updated_at: now })
          .eq("id", integrationId)
      : await supabase.from("organization_integrations").insert({
          id: integrationId,
          organization_id: auth.org.id,
          provider,
          type: provider,
          external_id: externalId,
          enabled,
          config,
          status,
          created_at: now,
          updated_at: now,
        });
    if (writeError?.code === UNIQUE_VIOLATION) {
      return res.status(409).json({ error: "Cet identifiant externe est déjà rattaché à une autre organisation.", code: "EXTERNAL_ID_ALREADY_LINKED" });
    }
    if (writeError) throw writeError;

    // Les tournois suivent le serveur lié : les rôles TO et le nettoyage Discord s'appuient sur guild_id.
    if (provider === "DISCORD" && externalId !== previousExternalId) {
      const { error: tournamentsError } = await supabase
        .from("tournaments")
        .update({ guild_id: externalId })
        .eq("organization_id", auth.org.id);
      if (tournamentsError) throw tournamentsError;
    }

    // SEC-28 : stockage chiffré AES-256-GCM dans la table dédiée organization_integration_secrets
    if (encryptedPayload) {
      const { data: existingSecret, error: secretReadError } = await supabase
        .from("organization_integration_secrets")
        .select("integration_id")
        .eq("integration_id", integrationId)
        .maybeSingle();
      if (secretReadError) throw secretReadError;

      const { error: secretError } = existingSecret
        ? await supabase
            .from("organization_integration_secrets")
            .update({ encrypted_payload: encryptedPayload, updated_at: now })
            .eq("integration_id", integrationId)
        : await supabase.from("organization_integration_secrets").insert({
            integration_id: integrationId,
            encrypted_payload: encryptedPayload,
            key_version: 1,
            updated_at: now,
          });
      if (secretError) throw secretError;
    }

    // SEC-26 : révocation immédiate des accès issus de l'intégration et invalidation du cache
    if (!enabled) {
      const { error: grantsError } = await supabase
        .from("integration_access_grants")
        .delete()
        .eq("organization_id", auth.org.id)
        .eq("provider", provider);
      if (grantsError) throw grantsError;

      if (parsed.data.cleanupExternalResources && provider === "DISCORD" && previousExternalId) {
        const client = req.app?.locals?.discordClient;
        discordIntegrationPlugin
          .cleanupExternalResources?.({
            organizationId: auth.org.id,
            guildId: previousExternalId,
            discordClient: client,
            integration: {
              id: integrationId,
              organization_id: auth.org.id,
              provider,
              external_id: previousExternalId,
              enabled,
              config,
              status,
              created_at: now,
              updated_at: now,
            },
          })
          .catch((err: unknown) => logger.error("[OrganizationRouter] Nettoyage Discord échoué:", err));
      }
    }

    invalidateOrganizationCaches(auth.org, externalId);
    if (provider === "DISCORD" && enabled && req.app?.locals?.discordClient) {
      refreshGuildAccess(req.app.locals.discordClient as GuildFetcher, auth.org.id);
    }

    return res.status(200).json({
      id: integrationId,
      organization_id: auth.org.id,
      provider,
      external_id: externalId,
      enabled,
      config,
      status,
      has_secret: encryptedPayload !== null,
      updated_at: now,
    });
  } catch (error: unknown) {
    return sendServerError(res, error, "OrganizationRouter.updateIntegration");
  }
});
