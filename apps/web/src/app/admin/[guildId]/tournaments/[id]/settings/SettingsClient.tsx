"use client";

import { useForm } from "react-hook-form";
import { botApiFetch, getBotApiUrl } from '@/utils/api';
import { CheckinTimeManager } from "./CheckinTimeManager";

import dayjs from "dayjs";
import { Save, CalendarDays, RefreshCw, MessageSquare, Shield } from "lucide-react";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "@/i18n/LanguageContext";
import { getErrorMessage, readApiError } from "@/utils/errors";

export function SettingsClient({ tournament, guildId, initialChannels = [], initialRoles = [] }: { tournament: any; guildId: string; initialChannels?: any[]; initialRoles?: any[] }) {
  const router = useRouter();
  const { t } = useTranslation();
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{type: 'success' | 'error', text: string} | null>(null);

  const [channels, setChannels] = useState<any[]>(initialChannels);
  const [roles, setRoles] = useState<any[]>(initialRoles);
  const [isLoadingDiscord, setIsLoadingDiscord] = useState(true);
  const [discordError, setDiscordError] = useState<string | null>(null);

  useEffect(() => {
    const fetchDiscordData = async () => {

      if (!guildId) {
        setIsLoadingDiscord(false);
        return;
      }
      try {
        const [channelsRes, rolesRes] = await Promise.all([
          fetch(`/api/bot/discord/channels?guildId=${guildId}`),
          fetch(`/api/bot/discord/roles?guildId=${guildId}`)
        ]);

        if (channelsRes.ok) {
          const channelsData = await channelsRes.json();
          setChannels(channelsData);
        } else {
          const errText = await channelsRes.text();
          console.error("Failed to fetch Discord channels:", errText);
          setDiscordError(t("adminSettingsPage.loadChannelsError"));
        }

        if (rolesRes.ok) {
          const rolesData = await rolesRes.json();
          setRoles(rolesData);
        } else {
          const errText = await rolesRes.text();
          console.error("Failed to fetch Discord roles:", errText);
          setDiscordError(t("adminSettingsPage.loadRolesError"));
        }
      } catch (e) {
        console.error("Failed to fetch Discord data", e);
        setDiscordError(t("adminSettingsPage.discordDataError"));
      } finally {
        setIsLoadingDiscord(false);
      }
    };

    fetchDiscordData();
  // Ne dépend que du serveur : la session NextAuth est relue à chaque retour sur l'onglet, et la relancer
  // ici rechargeait la base par-dessus les modifications non enregistrées.
  }, [guildId, t]);

  const { register, handleSubmit } = useForm({
    defaultValues: {
      start_at: tournament.start_at ? dayjs(tournament.start_at).format('YYYY-MM-DDTHH:mm') : "",
      checkin_start_at: tournament.checkin_start_at ? dayjs(tournament.checkin_start_at).format('YYYY-MM-DDTHH:mm') : "",
      checkin_end_at: tournament.checkin_end_at ? dayjs(tournament.checkin_end_at).format('YYYY-MM-DDTHH:mm') : "",
      discord_registration_channel_id: tournament.discord_registration_channel_id || "",
      discord_announcement_channel_id: tournament.discord_announcement_channel_id || "",
      discord_checkin_channel_id: tournament.discord_checkin_channel_id || "",
      discord_captain_role_id: tournament.discord_captain_role_id || "",
      discord_to_role_id: tournament.discord_to_role_id || "",
      language: tournament.language || "fr",
    }
  });

  const onSubmit = async (data: any) => {
    setIsSaving(true);
    setMessage(null);

    try {
      const res = await botApiFetch(`/api/tournaments/${tournament.id}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guildId,
          start_at: data.start_at ? new Date(data.start_at).toISOString() : null,
          checkin_start_at: data.checkin_start_at ? new Date(data.checkin_start_at).toISOString() : null,
          checkin_end_at: data.checkin_end_at ? new Date(data.checkin_end_at).toISOString() : null,
          discord_registration_channel_id: data.discord_registration_channel_id || null,
          discord_announcement_channel_id: data.discord_announcement_channel_id || null,
          discord_checkin_channel_id: data.discord_checkin_channel_id || null,
          discord_captain_role_id: data.discord_captain_role_id || null,
          discord_to_role_id: data.discord_to_role_id || null,
          language: data.language || "fr",
        }),
      });

      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("common.unknown"));
      }

      setMessage({ type: 'success', text: t("adminSettings.savedSuccess") });
      router.refresh();
    } catch (err: unknown) {
      setMessage({ type: 'error', text: t("adminSettings.saveError", { message: getErrorMessage(err) ?? t("common.unknown") }) });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-4xl">
      <div className="flex justify-between items-center bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-xl">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2 flex items-center gap-3">
            <CalendarDays className="w-8 h-8 text-blue-400" />
            {t("adminSettingsPage.title")}
          </h1>
          <p className="text-slate-400">{t("adminSettingsPage.subtitle")}</p>
        </div>
      </div>

      {message && (
        <div className={`p-4 rounded-lg font-medium border ${message.type === 'success' ? 'bg-green-500/20 text-green-400 border-green-500/50' : 'bg-red-500/20 text-red-400 border-red-500/50'}`}>
          {message.text}
        </div>
      )}

      {discordError && (
        <div className="p-4 rounded-lg font-medium border bg-amber-500/20 text-amber-400 border-amber-500/50">
          ⚠️ {discordError}
        </div>
      )}

      <CheckinTimeManager tournament={tournament} guildId={guildId} />

      <form onSubmit={handleSubmit(onSubmit)} className="bg-slate-800 rounded-xl p-8 border border-slate-700 space-y-6 shadow-xl">
        <h2 className="text-xl font-bold text-white mb-4">{t("adminSettingsPage.datesSection")}</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-3 md:col-span-2">
            <label className="block text-sm font-semibold text-slate-300">{t("adminSettingsPage.startDate")}</label>
            <input
              type="datetime-local"
              {...register("start_at")}
              className="w-full bg-slate-900/80 border border-slate-700 rounded-lg p-3 text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
            />
          </div>

          <div className="space-y-3">
            <label className="block text-sm font-semibold text-slate-300">{t("adminSettingsPage.checkinStart")}</label>
            <input
              type="datetime-local"
              {...register("checkin_start_at")}
              className="w-full bg-slate-900/80 border border-slate-700 rounded-lg p-3 text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
            />
          </div>

          <div className="space-y-3">
            <label className="block text-sm font-semibold text-slate-300">{t("adminSettingsPage.checkinEnd")}</label>
            <input
              type="datetime-local"
              {...register("checkin_end_at")}
              className="w-full bg-slate-900/80 border border-slate-700 rounded-lg p-3 text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
            />
          </div>
        </div>

        <h2 className="text-xl font-bold text-white mb-4 mt-8 flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-indigo-400" />
          {t("adminSettingsPage.channelsSection")}
        </h2>

        {isLoadingDiscord ? (
          <div className="text-slate-400 text-sm animate-pulse">{t("adminSettingsPage.loadingDiscord")}</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

            <div className="space-y-3">
              <label className="block text-sm font-semibold text-slate-300">{t("adminSettingsPage.regChannel")}</label>
              <select
                {...register("discord_registration_channel_id")}
                className="w-full bg-slate-900/80 border border-slate-700 rounded-lg p-3 text-white focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all outline-none"
              >
                <option value="">{t("adminSettingsPage.noChannel")}</option>
                {channels.map((ch: any) => (
                  <option key={ch.id} value={ch.id}>#{ch.name}</option>
                ))}
              </select>
            </div>

            <div className="space-y-3">
              <label className="block text-sm font-semibold text-slate-300">{t("adminSettingsPage.annChannel")}</label>
              <select
                {...register("discord_announcement_channel_id")}
                className="w-full bg-slate-900/80 border border-slate-700 rounded-lg p-3 text-white focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all outline-none"
              >
                <option value="">{t("adminSettingsPage.noChannel")}</option>
                {channels.map((ch: any) => (
                  <option key={ch.id} value={ch.id}>#{ch.name}</option>
                ))}
              </select>
            </div>

            <div className="space-y-3">
              <label className="block text-sm font-semibold text-slate-300">{t("adminSettingsPage.checkinChannelLabel")}</label>
              <select
                {...register("discord_checkin_channel_id")}
                className="w-full bg-slate-900/80 border border-slate-700 rounded-lg p-3 text-white focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all outline-none"
              >
                <option value="">{t("adminSettingsPage.noChannel")}</option>
                {channels.map((ch: any) => (
                  <option key={ch.id} value={ch.id}>#{ch.name}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        <h2 className="text-xl font-bold text-white mb-4 mt-8 flex items-center gap-2">
          <Shield className="w-5 h-5 text-purple-400" />
          {t("adminSettingsPage.rolesSection")}
        </h2>

        {!isLoadingDiscord && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-3">
              <label className="block text-sm font-semibold text-slate-300">{t("adminSettingsPage.captainRoleLabel")}</label>
              <select
                {...register("discord_captain_role_id")}
                className="w-full bg-slate-900/80 border border-slate-700 rounded-lg p-3 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all outline-none"
              >
                <option value="">{t("adminSettingsPage.noRole")}</option>
                {roles.map((ro: any) => (
                  <option key={ro.id} value={ro.id}>@{ro.name}</option>
                ))}
              </select>
            </div>

            <div className="space-y-3">
              <label className="block text-sm font-semibold text-slate-300">{t("adminSettingsPage.toRoleLabel")}</label>
              <select
                {...register("discord_to_role_id")}
                className="w-full bg-slate-900/80 border border-slate-700 rounded-lg p-3 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all outline-none"
              >
                <option value="">{t("adminSettingsPage.noRole")}</option>
                {roles.map((ro: any) => (
                  <option key={ro.id} value={ro.id}>@{ro.name}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        <h2 className="text-xl font-bold text-white mb-2 mt-8 flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-indigo-400" />
          {t("adminSettingsPage.tournamentLanguage")}
        </h2>
        <p className="text-xs text-slate-400 mb-4">{t("adminSettingsPage.tournamentLanguageDesc")}</p>

        <div className="max-w-xs mb-6">
          <select
            {...register("language")}
            className="w-full bg-slate-900/80 border border-slate-700 rounded-lg p-3 text-white focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all outline-none"
          >
            <option value="fr">🇫🇷 Français</option>
            <option value="en">🇬🇧 English</option>
          </select>
        </div>

        <div className="pt-6 mt-6 border-t border-slate-700/80 flex justify-end">
          <button
            type="submit"
            disabled={isSaving}
            className="flex items-center justify-center gap-2 px-8 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold transition-all disabled:opacity-50 shadow-lg shadow-blue-500/20"
          >
            {isSaving ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
            {isSaving ? t("adminSettingsPage.savingButton") : t("adminSettingsPage.saveButton")}
          </button>
        </div>
      </form>
    </div>
  );
}
