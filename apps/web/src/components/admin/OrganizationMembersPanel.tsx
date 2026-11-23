"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Link2, Loader2, Trash2, UserPlus, Users } from "lucide-react";
import { useTranslation } from "@/i18n/LanguageContext";
import { useToast } from "@/context/ToastContext";
import { ConfirmModal } from "@/components/ui/ConfirmModal";
import { botApiFetch } from "@/utils/api";
import { readApiError } from "@/utils/errors";
import type { OrganizationMemberRole } from "@hub/shared";

interface Member {
  user_id: string;
  role: string;
}

interface Invite {
  id: string;
  role: string;
  tournament_id: string | null;
  expires_at: string;
  used_at: string | null;
}

const ASSIGNABLE_ROLES = ["ORG_ADMIN", "ORG_TO", "CASTER", "STATISTICIAN", "MEMBER"] as const;
const JSON_HEADERS = { "Content-Type": "application/json" };

/** Membres natifs, invitations, transfert et suppression : parcours d'administration sans Discord (RFC Q2.4). */
export function OrganizationMembersPanel({
  organizationId,
  slug,
  viewerId,
  canManageOwnership,
}: {
  organizationId: string;
  slug: string;
  viewerId: string;
  canManageOwnership: boolean;
}) {
  const { t, locale } = useTranslation();
  const { toast } = useToast();
  const router = useRouter();

  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);

  const [newMemberId, setNewMemberId] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<OrganizationMemberRole>("ORG_TO");
  const [inviteRole, setInviteRole] = useState<(typeof ASSIGNABLE_ROLES)[number]>("ORG_TO");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState("");
  const [demoteSelf, setDemoteSelf] = useState(true);
  const [showTransfer, setShowTransfer] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [orgRes, invitesRes] = await Promise.all([
          fetch(`/api/bot/organizations/${organizationId}`),
          fetch(`/api/bot/organizations/${organizationId}/invites`),
        ]);
        if (!orgRes.ok || !invitesRes.ok) throw new Error("load failed");
        const org = (await orgRes.json()) as { members: Member[] };
        const pending = (await invitesRes.json()) as Invite[];
        if (cancelled) return;
        setMembers(org.members);
        setInvites(pending.filter((invite) => !invite.used_at && new Date(invite.expires_at) > new Date()));
        setLoadState("ready");
      } catch {
        if (!cancelled) setLoadState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, reloadKey]);

  const reload = () => {
    setLoadState("loading");
    setReloadKey((key) => key + 1);
  };

  /** Exécute une mutation : l'erreur traduite du bot s'affiche, et les données sont relues en cas de succès. */
  const mutate = async (path: string, init: RequestInit, successKey: Parameters<typeof t>[0]): Promise<Response | null> => {
    setBusy(true);
    try {
      const res = await botApiFetch(path, init);
      if (!res.ok) {
        toast.error((await readApiError(res)) ?? t("common.unknown"));
        return null;
      }
      toast.success(t(successKey));
      reload();
      return res;
    } catch {
      toast.error(t("common.internalError"));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const base = `/api/organizations/${organizationId}`;
  const owners = members.filter((member) => member.role === "ORG_OWNER");
  const transferable = members.filter((member) => member.role === "ORG_ADMIN");

  const addMember = async (event: React.FormEvent) => {
    event.preventDefault();
    const res = await mutate(
      `${base}/members`,
      { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ user_id: newMemberId.trim(), role: newMemberRole }) },
      "orgMembers.saved",
    );
    if (res) setNewMemberId("");
  };

  const createInvite = async () => {
    const res = await mutate(
      `${base}/invites`,
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ role: inviteRole }) },
      "orgMembers.inviteCreated",
    );
    if (res) {
      const { token } = (await res.json()) as { token: string };
      setInviteLink(`${window.location.origin}/invite#${token}`);
    }
  };

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    toast.success(t("orgMembers.copied"));
  };

  const transfer = async () => {
    const res = await mutate(
      `${base}/transfer`,
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ new_owner_id: transferTarget, demote_self: demoteSelf }) },
      "orgMembers.transferred",
    );
    if (res) {
      setShowTransfer(false);
      router.refresh();
    }
  };

  const deleteOrganization = async () => {
    const res = await mutate(
      base,
      { method: "DELETE", headers: JSON_HEADERS, body: JSON.stringify({ confirm_slug: slug }) },
      "orgMembers.deleted",
    );
    if (res) router.push("/admin");
  };

  if (loadState === "loading") {
    return (
      <section aria-busy="true" className="bg-slate-800 p-8 rounded-2xl border border-slate-700 space-y-3">
        <div className="h-6 w-48 bg-slate-700 rounded animate-pulse" />
        <div className="h-10 bg-slate-700/60 rounded animate-pulse" />
        <div className="h-10 bg-slate-700/60 rounded animate-pulse" />
      </section>
    );
  }

  if (loadState === "error") {
    return (
      <section className="bg-slate-800 p-8 rounded-2xl border border-slate-700 text-center space-y-3">
        <p role="alert" className="text-red-300">{t("orgMembers.loadError")}</p>
        <button type="button" onClick={reload} className="rounded-lg bg-slate-700 hover:bg-slate-600 px-4 py-2 text-sm font-semibold text-white">
          {t("access.retry")}
        </button>
      </section>
    );
  }

  const roleLabel = (role: string) => t(`orgMembers.role_${role}` as Parameters<typeof t>[0]);
  const fieldClass = "rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none";

  return (
    <section className="bg-slate-800 p-8 rounded-2xl border border-slate-700 shadow-xl space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-slate-200 flex items-center gap-2">
          <Users className="w-5 h-5 text-blue-400" />
          {t("orgMembers.title")}
        </h2>
        <p className="text-sm text-slate-400 mt-1">{t("orgMembers.subtitle")}</p>
      </div>

      {members.length === 0 ? (
        <p className="text-sm text-slate-400 bg-slate-900/60 border border-slate-700 rounded-lg p-4">{t("orgMembers.empty")}</p>
      ) : (
        <ul className="divide-y divide-slate-700 border border-slate-700 rounded-xl overflow-hidden">
          {members.map((member) => {
            const lastOwner = member.role === "ORG_OWNER" && owners.length === 1;
            const locked = member.role === "ORG_OWNER" && !canManageOwnership;
            return (
              <li key={member.user_id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 bg-slate-900/40">
                <span className="font-mono text-sm text-slate-200">
                  {member.user_id}
                  {member.user_id === viewerId && <span className="ml-2 text-xs text-blue-300">{t("orgMembers.you")}</span>}
                </span>
                <div className="flex items-center gap-2">
                  {member.role === "ORG_OWNER" ? (
                    <span className="text-xs font-semibold text-amber-300">{roleLabel("ORG_OWNER")}</span>
                  ) : (
                    <select
                      aria-label={t("orgMembers.roleLabel")}
                      disabled={busy}
                      value={member.role}
                      onChange={(event) =>
                        mutate(
                          `${base}/members`,
                          { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ user_id: member.user_id, role: event.target.value }) },
                          "orgMembers.saved",
                        )
                      }
                      className={fieldClass}
                    >
                      {ASSIGNABLE_ROLES.map((role) => (
                        <option key={role} value={role}>{roleLabel(role)}</option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    disabled={busy || lastOwner || locked}
                    aria-label={t("orgMembers.remove")}
                    title={lastOwner ? t("botErrors.LAST_OWNER") : t("orgMembers.remove")}
                    onClick={() => mutate(`${base}/members/${member.user_id}`, { method: "DELETE" }, "orgMembers.removed")}
                    className="p-2 rounded-lg text-red-300 hover:bg-red-900/30 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <form onSubmit={addMember} className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-3">
        <input
          required
          inputMode="numeric"
          pattern="\d{17,20}"
          value={newMemberId}
          onChange={(event) => setNewMemberId(event.target.value)}
          placeholder={t("orgMembers.discordIdPlaceholder")}
          aria-label={t("orgMembers.discordIdPlaceholder")}
          className={fieldClass}
        />
        <select aria-label={t("orgMembers.roleLabel")} value={newMemberRole} onChange={(event) => setNewMemberRole(event.target.value as OrganizationMemberRole)} className={fieldClass}>
          {ASSIGNABLE_ROLES.map((role) => (
            <option key={role} value={role}>{roleLabel(role)}</option>
          ))}
        </select>
        <button type="submit" disabled={busy} className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
          {t("orgMembers.add")}
        </button>
      </form>

      <div className="space-y-3 border-t border-slate-700 pt-6">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Link2 className="w-4 h-4 text-blue-400" />
          {t("orgMembers.invitesTitle")}
        </h3>
        <p className="text-xs text-slate-400">{t("orgMembers.invitesHelp")}</p>
        <div className="flex flex-col sm:flex-row gap-3">
          <select aria-label={t("orgMembers.roleLabel")} value={inviteRole} onChange={(event) => setInviteRole(event.target.value as (typeof ASSIGNABLE_ROLES)[number])} className={fieldClass}>
            {ASSIGNABLE_ROLES.map((role) => (
              <option key={role} value={role}>{roleLabel(role)}</option>
            ))}
          </select>
          <button type="button" disabled={busy} onClick={createInvite} className="rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white">
            {t("orgMembers.createInvite")}
          </button>
        </div>
        {inviteLink && (
          <div className="flex items-center gap-2 bg-emerald-950/40 border border-emerald-800/50 rounded-lg p-3">
            <code className="text-xs text-emerald-200 break-all flex-1">{inviteLink}</code>
            <button type="button" onClick={() => copy(inviteLink)} aria-label={t("orgMembers.copy")} className="p-2 rounded-lg text-emerald-200 hover:bg-emerald-900/40">
              <Copy className="w-4 h-4" />
            </button>
          </div>
        )}
        {invites.length > 0 && (
          <ul className="space-y-2">
            {invites.map((invite) => (
              <li key={invite.id} className="flex items-center justify-between gap-3 text-sm text-slate-300 bg-slate-900/40 border border-slate-700 rounded-lg p-3">
                <span>
                  {roleLabel(invite.role)} · {t("orgMembers.expiresAt", { date: new Date(invite.expires_at).toLocaleString(locale) })}
                </span>
                <button type="button" disabled={busy} onClick={() => mutate(`${base}/invites/${invite.id}`, { method: "DELETE" }, "orgMembers.inviteRevoked")} className="text-xs font-semibold text-red-300 hover:text-red-200">
                  {t("orgMembers.revoke")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {canManageOwnership && (
        <div className="space-y-4 border-t border-slate-700 pt-6">
          <h3 className="text-sm font-bold text-white">{t("orgMembers.ownershipTitle")}</h3>
          {transferable.length === 0 ? (
            <p className="text-xs text-slate-400">{t("orgMembers.noTransferTarget")}</p>
          ) : (
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <select aria-label={t("orgMembers.transferTarget")} value={transferTarget} onChange={(event) => setTransferTarget(event.target.value)} className={fieldClass}>
                <option value="">{t("orgMembers.transferTarget")}</option>
                {transferable.map((member) => (
                  <option key={member.user_id} value={member.user_id}>{member.user_id}</option>
                ))}
              </select>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={demoteSelf} onChange={(event) => setDemoteSelf(event.target.checked)} />
                {t("orgMembers.demoteSelf")}
              </label>
              <button type="button" disabled={busy || !transferTarget} onClick={() => setShowTransfer(true)} className="rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white">
                {t("orgMembers.transfer")}
              </button>
            </div>
          )}
          <button type="button" onClick={() => setShowDelete(true)} className="rounded-lg border border-red-500/40 bg-red-600/20 hover:bg-red-600/30 px-4 py-2 text-sm font-semibold text-red-300">
            {t("orgMembers.deleteOrganization")}
          </button>
        </div>
      )}

      <ConfirmModal
        isOpen={showTransfer}
        onClose={() => setShowTransfer(false)}
        onConfirm={transfer}
        title={t("orgMembers.transfer")}
        description={t("orgMembers.transferConfirm", { user: transferTarget })}
        confirmText={t("orgMembers.transfer")}
        variant="warning"
        isLoading={busy}
      />
      <ConfirmModal
        isOpen={showDelete}
        onClose={() => setShowDelete(false)}
        onConfirm={deleteOrganization}
        title={t("orgMembers.deleteOrganization")}
        description={t("orgMembers.deleteConfirm")}
        confirmText={t("orgMembers.deleteOrganization")}
        confirmPhrase={slug}
        variant="danger"
        isLoading={busy}
      />
    </section>
  );
}
