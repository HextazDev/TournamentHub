"use client";

import { useState } from "react";
import { Plus, Trophy, AlertTriangle, Loader2, Trash2, Settings } from "lucide-react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { botApiFetch } from '@/utils/api';
import { useToast } from "@/context/ToastContext";
import { ConfirmModal } from "@/components/ui/ConfirmModal";
import { useTranslation } from "@/i18n/LanguageContext";
import { getErrorMessage, readApiError } from "@/utils/errors";
import type { Tournament } from "@hub/shared";

const formSchema = z.object({
  name: z.string().min(3, "Le nom doit contenir au moins 3 caractères"),
  description: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

export function TournamentsClient({ guildId, tournaments }: { guildId: string; tournaments: Tournament[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const { t, locale } = useTranslation();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [tournamentToDelete, setTournamentToDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { register, handleSubmit, formState: { errors }, reset } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
  });

  const activePublishedTournament = tournaments.find(t => ['REGISTRATION', 'ACTIVE'].includes(t.status));

  const handleDelete = async () => {
    if (!tournamentToDelete) return;
    try {
      setDeleting(true);

      const response = await fetch(`/api/tournaments/${tournamentToDelete.id}?guildId=${guildId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error((await readApiError(response)) ?? t("adminTournaments.deleteForbidden"));
      }

      setTournamentToDelete(null);
      toast.success(t("adminTournaments.deletedSuccess"));
      router.refresh();
    } catch (err: unknown) {
      console.error("Delete Error:", err);
      toast.error(t("feedback.deleteFailed", { message: getErrorMessage(err) ?? t("common.unknown") }));
    } finally {
      setDeleting(false);
    }
  };

  const onSubmit = async (data: FormValues) => {
    setCreating(true);

    try {
      const res = await botApiFetch('/api/tournaments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guildId: guildId,
          name: data.name,
          description: data.description || null,
        }),
      });

      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("common.unknown"));
      }

      const created = await res.json();

      setShowCreateModal(false);
      reset();
      toast.success(t("adminTournaments.createdSuccess"));
      router.push(`/admin/${guildId}/tournaments/${created.id}`);

    } catch (err: unknown) {
      console.error(err);
      toast.error(t("feedback.createTournamentFailed", { message: getErrorMessage(err) ?? t("common.unknown") }));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="p-6 md:p-8 w-full max-w-[1600px] mx-auto space-y-8">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">{t("adminTournaments.title")}</h1>
          <p className="text-slate-400">{t("adminTournaments.subtitle")}</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-xl font-medium flex items-center gap-2 transition-colors"
        >
          <Plus className="w-5 h-5" />
          {t("adminTournaments.createButton")}
        </button>
      </div>

      {activePublishedTournament && (
        <div className="bg-yellow-900/20 border border-yellow-700/50 rounded-xl p-4 flex gap-4 items-center text-yellow-500">
          <AlertTriangle className="w-6 h-6 shrink-0" />
          <p>
            <strong>{t("common.note")}</strong> {t("adminTournaments.activeNotice", { name: activePublishedTournament.name })}
          </p>
        </div>
      )}

      {tournaments.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {tournaments.map((tournament) => (
            <div key={tournament.id} className="bg-slate-900 border border-slate-700/50 rounded-2xl overflow-hidden shadow-xl flex flex-col justify-between">
              <div className="bg-slate-800 p-6 border-b border-slate-700">
                <div className="flex justify-between items-start mb-4">
                  <div className="flex flex-col items-start gap-2">
                    <span className={`text-xs font-bold px-2 py-1 rounded ${
                      tournament.status === 'ACTIVE' || tournament.status === 'REGISTRATION' ? 'bg-green-500/20 text-green-400' :
                      tournament.status === 'COMPLETED' ? 'bg-blue-500/20 text-blue-400' :
                      tournament.status === 'ARCHIVED' ? 'bg-slate-500/20 text-slate-400' : 'bg-yellow-500/20 text-yellow-400'
                    }`}>
                      {tournament.status}
                    </span>
                    <h2 className="text-2xl font-bold text-white leading-tight">{tournament.name}</h2>
                  </div>
                  <button
                    onClick={() => setTournamentToDelete({ id: tournament.id, name: tournament.name })}
                    title={t("adminTournaments.deleteTitle")}
                    className="p-2 ml-4 bg-slate-700/50 hover:bg-red-500/20 text-slate-400 hover:text-red-400 rounded-lg transition-colors shrink-0 cursor-pointer"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                </div>
                {tournament.description && (
                  <p className="text-slate-400 mb-4 line-clamp-2">{tournament.description}</p>
                )}
                <div className="flex flex-wrap gap-4 text-sm text-slate-500">
                  <span>ID: {tournament.id.split('-')[0]}...</span>
                  <span>📅 {tournament.start_at ? new Date(tournament.start_at).toLocaleDateString(locale === "en" ? "en-US" : "fr-FR") : t("adminTournaments.draft")}</span>
                </div>
              </div>
              <div className="p-4 bg-slate-900/50">
                <button
                  onClick={() => router.push(`/admin/${guildId}/tournaments/${tournament.id}`)}
                  className="w-full bg-slate-700 hover:bg-slate-600 text-white px-6 py-3 rounded-xl font-bold transition-colors flex justify-center items-center gap-2"
                >
                  <Settings className="w-5 h-5" /> {t("adminTournaments.controlRoom")}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-slate-800/30 border border-slate-700/50 border-dashed rounded-2xl p-12 text-center">
          <Trophy className="w-16 h-16 text-slate-600 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-slate-300 mb-2">{t("adminTournaments.noActiveTitle")}</h2>
          <p className="text-slate-500 max-w-md mx-auto mb-6">
            {t("adminTournaments.noActiveDesc")}
          </p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 mx-auto transition-colors"
          >
            <Plus className="w-5 h-5" />
            {t("adminTournaments.createDraftButton")}
          </button>
        </div>
      )}

      {showCreateModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center">
              <h2 className="text-xl font-bold text-white">{t("adminTournaments.newEditionModal")}</h2>
              <button onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <form onSubmit={handleSubmit(onSubmit)} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">{t("adminTournaments.tournamentNameLabel")} <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  {...register("name")}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2 text-white outline-none focus:border-blue-500"
                  placeholder={t("adminTournaments.namePlaceholder")}
                />
                {errors.name && <p className="text-red-400 text-xs mt-1">{errors.name.message}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">{t("adminTournaments.descLabel")}</label>
                <textarea
                  {...register("description")}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2 text-white outline-none focus:border-blue-500 h-28 resize-none"
                  placeholder={t("adminTournaments.descPlaceholder")}
                />
              </div>

              <div className="bg-blue-950/40 border border-blue-800/50 rounded-lg p-4 flex gap-3 text-sm text-blue-400 my-4">
                <AlertTriangle className="w-5 h-5 shrink-0 text-blue-400" />
                <p>{t("adminTournaments.draftWarning")}</p>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded-xl font-medium transition-colors"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 disabled:text-white/50 text-white px-4 py-2 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors shadow-lg shadow-blue-900/20"
                >
                  {creating ? <><Loader2 className="w-5 h-5 animate-spin" /> {t("adminTournaments.creating")}</> : t("adminTournaments.createDraftSubmit")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Suppression Tournoi */}
      <ConfirmModal
        isOpen={!!tournamentToDelete}
        onClose={() => setTournamentToDelete(null)}
        onConfirm={handleDelete}
        title={t("adminTournaments.deleteModalTitle")}
        description={tournamentToDelete ? t("adminTournaments.deleteConfirm", { name: tournamentToDelete.name }) : ""}
        confirmText={t("common.deletePermanently")}
        variant="danger"
        icon={Trash2}
        isLoading={deleting}
      />
    </div>
  );
}
