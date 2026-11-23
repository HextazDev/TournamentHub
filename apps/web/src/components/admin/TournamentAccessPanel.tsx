"use client";

import { useEffect, useState } from "react";
import { Copy, Link2, Loader2, Trash2, UserPlus } from "lucide-react";
import { useTranslation } from "@/i18n/LanguageContext";
import { useToast } from "@/context/ToastContext";
import { botApiFetch } from "@/utils/api";
import { readApiError } from "@/utils/errors";
import type { TournamentStaffRole } from "@hub/shared";

interface StaffMember {
  user_id: string;
  role: TournamentStaffRole;
}

const STAFF_ROLES: readonly TournamentStaffRole[] = ["TOURNAMENT_TO", "CASTER", "STATISTICIAN"];
const JSON_HEADERS = { "Content-Type": "application/json" };

/** Staff du tournoi et lien de partage d'un tournoi privé. */
export function TournamentAccessPanel({
  guildId,
  tournamentId,
  isPublic,
  canManageStaff,
}: {
  guildId: string;
  tournamentId: string;
  isPublic: boolean;
  canManageStaff: boolean;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(canManageStaff ? "loading" : "ready");
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<TournamentStaffRole>("CASTER");
  const [shareLink, setShareLink] = useState<string | null>(null);

  const staffPath = `organizations/${guildId}/tournaments/${tournamentId}/staff`;

  useEffect(() => {
    if (!canManageStaff) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/bot/${staffPath}`);
        if (!res.ok) throw new Error("load failed");
        const rows = (await res.json()) as StaffMember[];
        if (cancelled) return;
        setStaff(rows);
        setLoadState("ready");
      } catch {
        if (!cancelled) setLoadState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canManageStaff, staffPath, reloadKey]);

  const reload = () => {
    setLoadState("loading");
    setReloadKey((key) => key + 1);
  };

  const run = async (path: string, init: RequestInit): Promise<Response | null> => {
    setBusy(true);
    try {
      const res = await botApiFetch(path, init);
      if (!res.ok) {
        toast.error((await readApiError(res)) ?? t("common.unknown"));
        return null;
      }
      return res;
    } catch {
      toast.error(t("common.internalError"));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const addStaff = async (event: React.FormEvent) => {
    event.preventDefault();
    const res = await run(`/api/${staffPath}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ user_id: userId.trim(), role }),
    });
    if (res) {
      setUserId("");
      toast.success(t("orgMembers.saved"));
      reload();
    }
  };

  const removeStaff = async (target: string) => {
    if (await run(`/api/${staffPath}/${target}`, { method: "DELETE" })) {
      toast.success(t("orgMembers.removed"));
      reload();
    }
  };

  const createLink = async () => {
    const res = await run(`/api/tournaments/${tournamentId}/invite-link`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ guildId }),
    });
    if (res) {
      const { token } = (await res.json()) as { token: string };
      const params = new URLSearchParams({ tournament: tournamentId, invite: token });
      setShareLink(`${window.location.origin}/api/tournament-invite?${params.toString()}`);
    }
  };

  const revokeLink = async () => {
    if (await run(`/api/tournaments/${tournamentId}/invite-link?guildId=${encodeURIComponent(guildId)}`, { method: "DELETE" })) {
      setShareLink(null);
      toast.success(t("tournamentAccess.linkRevoked"));
    }
  };

  const fieldClass = "rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none";
  const roleLabel = (value: TournamentStaffRole) => t(`tournamentAccess.role_${value}` as Parameters<typeof t>[0]);

  return (
    <section className="bg-slate-900 border border-slate-800 p-6 rounded-xl space-y-6">
      {!isPublic && (
        <div className="space-y-3">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Link2 className="w-5 h-5 text-blue-400" />
            {t("tournamentAccess.linkTitle")}
          </h2>
          <p className="text-sm text-slate-400">{t("tournamentAccess.linkHelp")}</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" disabled={busy} onClick={createLink} className="rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white">
              {t("tournamentAccess.generateLink")}
            </button>
            <button type="button" disabled={busy} onClick={revokeLink} className="rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white">
              {t("tournamentAccess.revokeLink")}
            </button>
          </div>
          {shareLink && (
            <div className="flex items-center gap-2 bg-emerald-950/40 border border-emerald-800/50 rounded-lg p-3">
              <code className="text-xs text-emerald-200 break-all flex-1">{shareLink}</code>
              <button
                type="button"
                aria-label={t("orgMembers.copy")}
                onClick={async () => {
                  await navigator.clipboard.writeText(shareLink);
                  toast.success(t("orgMembers.copied"));
                }}
                className="p-2 rounded-lg text-emerald-200 hover:bg-emerald-900/40"
              >
                <Copy className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      )}

      {canManageStaff && (
        <div className="space-y-3">
          <h2 className="text-lg font-bold text-white">{t("tournamentAccess.staffTitle")}</h2>
          <p className="text-sm text-slate-400">{t("tournamentAccess.staffHelp")}</p>
          {loadState === "loading" && <div aria-busy="true" className="h-10 bg-slate-800 rounded animate-pulse" />}
          {loadState === "error" && (
            <div className="flex items-center justify-between gap-3 text-sm text-red-300 bg-red-950/40 border border-red-900/50 rounded-lg p-3">
              <span role="alert">{t("tournamentAccess.staffLoadError")}</span>
              <button type="button" onClick={reload} className="font-semibold underline">{t("access.retry")}</button>
            </div>
          )}
          {loadState === "ready" && staff.length === 0 && (
            <p className="text-sm text-slate-400 bg-slate-800/50 border border-slate-700 rounded-lg p-3">{t("tournamentAccess.staffEmpty")}</p>
          )}
          {loadState === "ready" && staff.length > 0 && (
            <ul className="divide-y divide-slate-800 border border-slate-800 rounded-lg">
              {staff.map((member) => (
                <li key={member.user_id} className="flex items-center justify-between gap-3 p-3">
                  <span className="font-mono text-sm text-slate-200">{member.user_id}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-slate-300">{roleLabel(member.role)}</span>
                    <button type="button" disabled={busy} aria-label={t("orgMembers.remove")} onClick={() => removeStaff(member.user_id)} className="p-2 rounded-lg text-red-300 hover:bg-red-900/30 disabled:opacity-40">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={addStaff} className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-3">
            <input
              required
              inputMode="numeric"
              pattern="\d{17,20}"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              placeholder={t("orgMembers.discordIdPlaceholder")}
              aria-label={t("orgMembers.discordIdPlaceholder")}
              className={fieldClass}
            />
            <select aria-label={t("orgMembers.roleLabel")} value={role} onChange={(event) => setRole(event.target.value as TournamentStaffRole)} className={fieldClass}>
              {STAFF_ROLES.map((value) => (
                <option key={value} value={value}>{roleLabel(value)}</option>
              ))}
            </select>
            <button type="submit" disabled={busy} className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
              {t("orgMembers.add")}
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
