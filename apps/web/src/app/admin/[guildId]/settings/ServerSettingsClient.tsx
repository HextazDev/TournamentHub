"use client";

import { useEffect, useState } from "react";
import { botApiFetch } from '@/utils/api';
import { Save, Loader2, RefreshCw, AlertTriangle } from "lucide-react";
import { useTranslation } from "@/i18n/LanguageContext";
import { getErrorMessage, readApiError } from "@/utils/errors";
import { DiscordInviteUrlSchema, isDiscordSnowflake } from "@hub/shared";
import { ConfirmModal } from "@/components/ui/ConfirmModal";

/** Formulaire des paramètres du serveur : rendu uniquement si canPerform(..., "MANAGE_SERVER_SETTINGS") (SEC-16). */
export function ServerSettingsClient({
  guildId,
  manageableGuilds,
}: {
  guildId: string;
  manageableGuilds: readonly { id: string; name: string }[];
}) {
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });

  const [settings, setSettings] = useState({
    captain_role_id: "",
    to_role_id: "",
    checkin_channel_id: "",
    announcement_channel_id: "",
    registration_channel_id: "",
    language: "fr",
    invite_url: "",
  });

  const [discordRoles, setDiscordRoles] = useState<{ id: string; name: string }[]>([]);
  const [discordChannels, setDiscordChannels] = useState<{ id: string; name: string }[]>([]);
  const [discordEnabled, setDiscordEnabled] = useState(true);
  const [hasOrgRecord, setHasOrgRecord] = useState(false);
  const [togglingDiscord, setTogglingDiscord] = useState(false);
  const [apiError, setApiError] = useState("");
  const [linkedGuildId, setLinkedGuildId] = useState("");
  const [showDisableModal, setShowDisableModal] = useState(false);
  const [cleanupDiscord, setCleanupDiscord] = useState(false);

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      try {
        let activeDiscord = isDiscordSnowflake(guildId);
        let targetDiscordGuildId: string | null = isDiscordSnowflake(guildId) ? guildId : null;

        try {
          const orgRes = await fetch(`/api/bot/organizations/${guildId}`);
          if (orgRes.ok) {
            const orgData = (await orgRes.json()) as {
              language?: string;
              invite_url?: string;
              public_contact_url?: string;
              discordEnabled?: boolean;
              discordGuildId?: string | null;
              discordConfig?: Record<string, string | null>;
            };
            setHasOrgRecord(true);
            activeDiscord = Boolean(orgData.discordEnabled);
            setDiscordEnabled(activeDiscord);
            targetDiscordGuildId = orgData.discordGuildId || (isDiscordSnowflake(guildId) ? guildId : null);
            setLinkedGuildId(orgData.discordGuildId ?? "");
            const cfg = orgData.discordConfig ?? {};
            setSettings({
              captain_role_id: cfg.captain_role_id || "",
              to_role_id: cfg.to_role_id || "",
              checkin_channel_id: cfg.checkin_channel_id || "",
              announcement_channel_id: cfg.announcement_channel_id || "",
              registration_channel_id: cfg.registration_channel_id || "",
              language: orgData.language || "fr",
              invite_url: orgData.invite_url || orgData.public_contact_url || "",
            });
          }
        } catch (orgErr) {
          console.error(orgErr);
        }

        if (activeDiscord && targetDiscordGuildId && isDiscordSnowflake(targetDiscordGuildId)) {
          try {
            const rolesRes = await fetch(`/api/bot/discord/roles?guildId=${targetDiscordGuildId}`);
            if (rolesRes.ok) {
              const roles = await rolesRes.json();
              setDiscordRoles(roles);
            }
          } catch {
            setApiError(t("adminSettings.botError"));
          }

          try {
            const channelsRes = await fetch(`/api/bot/discord/channels?guildId=${targetDiscordGuildId}`);
            if (channelsRes.ok) {
              const channels = await channelsRes.json();
              setDiscordChannels(channels);
            }
          } catch {}
        }
      } catch (err) {
        console.error(err);
      }
      setLoading(false);
    }
    loadData();
  // Ne dépend que du serveur : la session NextAuth est relue à chaque retour sur l'onglet, et la relancer
  // ici rechargeait la base par-dessus les modifications non enregistrées.
  }, [guildId, t]);

  const updateDiscordIntegration = async (body: Record<string, unknown>, nextState: boolean) => {
    setTogglingDiscord(true);
    setMessage({ type: "", text: "" });
    try {
      const res = await botApiFetch(`/api/organizations/${guildId}/integrations/DISCORD`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("common.unknown"));
      }
      setDiscordEnabled(nextState);
      setMessage({ type: "success", text: t("adminSettings.savedSuccess") });
    } catch (err: unknown) {
      setMessage({ type: "error", text: t("adminSettings.saveError", { message: getErrorMessage(err) ?? t("common.unknown") }) });
    } finally {
      setTogglingDiscord(false);
    }
  };

  const handleEnableDiscord = () => updateDiscordIntegration({ enabled: true, external_id: linkedGuildId }, true);

  const handleDisableDiscord = async () => {
    await updateDiscordIntegration({ enabled: false, cleanupExternalResources: cleanupDiscord }, false);
    setShowDisableModal(false);
    setCleanupDiscord(false);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setSettings((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage({ type: "", text: "" });
    if (settings.invite_url.trim() && !DiscordInviteUrlSchema.safeParse(settings.invite_url).success) {
      setMessage({ type: "error", text: t("adminSettings.inviteInvalid") });
      return;
    }
    setSaving(true);

    try {
      if (hasOrgRecord) {
        const [orgRes, intRes] = await Promise.all([
          botApiFetch(`/api/organizations/${guildId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              language: settings.language,
              invite_url: settings.invite_url.trim() || null,
            }),
          }),
          // Une organisation sans Discord n'a aucune configuration d'intégration à écrire.
          discordEnabled
            ? botApiFetch(`/api/organizations/${guildId}/integrations/DISCORD`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  config: {
                    captain_role_id: settings.captain_role_id || null,
                    to_role_id: settings.to_role_id || null,
                    checkin_channel_id: settings.checkin_channel_id || null,
                    announcement_channel_id: settings.announcement_channel_id || null,
                    registration_channel_id: settings.registration_channel_id || null,
                  },
                }),
              })
            : null,
        ]);

        if (!orgRes.ok) {
          throw new Error((await readApiError(orgRes)) ?? t("common.unknown"));
        }
        if (intRes && !intRes.ok) {
          throw new Error((await readApiError(intRes)) ?? t("common.unknown"));
        }
      } else {
        const res = await botApiFetch(`/api/server-settings?guildId=${guildId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            guildId: guildId,
            guild_id: guildId,
            captain_role_id: settings.captain_role_id,
            to_role_id: settings.to_role_id,
            checkin_channel_id: settings.checkin_channel_id,
            announcement_channel_id: settings.announcement_channel_id,
            registration_channel_id: settings.registration_channel_id,
            language: settings.language,
            invite_url: settings.invite_url.trim(),
          }),
        });

        if (!res.ok) {
          throw new Error((await readApiError(res)) ?? t("common.unknown"));
        }
      }

      setMessage({ type: "success", text: t("adminSettings.savedSuccess") });
    } catch (err: unknown) {
      console.error(err);
      setMessage({ type: "error", text: t("adminSettings.saveError", { message: getErrorMessage(err) ?? t("common.unknown") }) });
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64 text-slate-400">
        <Loader2 className="w-8 h-8 animate-spin" />
        <span className="ml-4">{t("adminSettings.loading")}</span>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8 w-full max-w-[1600px] mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">
          {hasOrgRecord ? t("adminSettings.orgTitle") : t("adminSettings.title")}
        </h1>
        <p className="text-slate-400">
          {hasOrgRecord ? t("adminSettings.orgSubtitle") : t("adminSettings.subtitle")}
        </p>

        {apiError && (
          <div className="mt-4 bg-yellow-900/30 border border-yellow-700/50 p-4 rounded-xl text-yellow-400 text-sm flex items-center">
            <RefreshCw className="w-4 h-4 mr-2" />
            {apiError}
          </div>
        )}
      </div>

      <form onSubmit={handleSave} className="bg-slate-800 p-8 rounded-2xl border border-slate-700 shadow-xl space-y-6">
        {/* INTÉGRATIONS OPTIONNELLES (RFC 0001) */}
        {hasOrgRecord && (
          <div className="space-y-4 pb-4 border-b border-slate-700">
            <h2 className="text-xl font-semibold text-slate-200">{t("organizations.integrationsTitle")}</h2>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-900/70 p-4 rounded-xl border border-slate-700">
              <div>
                <h3 className="text-sm font-bold text-white">{t("organizations.discordIntegrationTitle")}</h3>
                <p className="text-xs text-slate-400 mt-1">{t("organizations.discordIntegrationDesc")}</p>
              </div>
              {discordEnabled ? (
                <button
                  type="button"
                  disabled={togglingDiscord}
                  onClick={() => setShowDisableModal(true)}
                  className="px-4 py-2 rounded-lg text-xs font-bold transition-colors bg-emerald-600/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-600/30"
                >
                  {t("organizations.disableDiscord")}
                </button>
              ) : (
                <div className="flex flex-col sm:flex-row gap-2">
                  <select
                    aria-label={t("organizations.chooseGuild")}
                    value={linkedGuildId}
                    onChange={(e) => setLinkedGuildId(e.target.value)}
                    className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                  >
                    <option value="">{t("organizations.chooseGuild")}</option>
                    {manageableGuilds.map((guild) => (
                      <option key={guild.id} value={guild.id}>{guild.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={togglingDiscord || !linkedGuildId}
                    onClick={handleEnableDiscord}
                    className="px-4 py-2 rounded-lg text-xs font-bold transition-colors bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white"
                  >
                    {t("organizations.connectDiscord")}
                  </button>
                </div>
              )}
            </div>
            {!discordEnabled && manageableGuilds.length === 0 && (
              <p className="text-xs text-slate-400">{t("organizations.noManageableGuild")}</p>
            )}
          </div>
        )}

        {/* RÔLES ET SALONS DISCORD */}
        {discordEnabled ? (
          <>
            {/* RÔLES */}
            <div className="space-y-6">
              <h2 className="text-xl font-semibold text-slate-200 border-b border-slate-700 pb-2">{t("adminSettings.rolesSection")}</h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="flex flex-col gap-2">
                  <label htmlFor="captain_role_id" className="text-sm font-medium text-slate-400">{t("adminSettings.captainRole")}</label>
                  {discordRoles.length > 0 ? (
                    <select
                      id="captain_role_id"
                      name="captain_role_id"
                      value={settings.captain_role_id}
                      onChange={handleChange}
                      className="w-full bg-slate-900 border border-slate-600 rounded-lg p-3 text-white focus:border-blue-500 focus:outline-none"
                    >
                      <option value="">{t("adminSettings.selectRole")}</option>
                      {discordRoles.map((role) => (
                        <option key={role.id} value={role.id}>{role.name}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id="captain_role_id"
                      type="text"
                      name="captain_role_id"
                      value={settings.captain_role_id}
                      onChange={handleChange}
                      placeholder={t("adminSettings.roleIdPlaceholder")}
                      className="w-full bg-slate-900 border border-slate-600 rounded-lg p-3 text-white"
                    />
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <label htmlFor="to_role_id" className="text-sm font-medium text-slate-400">{t("adminSettings.toRole")}</label>
                  {discordRoles.length > 0 ? (
                    <select
                      id="to_role_id"
                      name="to_role_id"
                      value={settings.to_role_id}
                      onChange={handleChange}
                      className="w-full bg-slate-900 border border-slate-600 rounded-lg p-3 text-white focus:border-blue-500 focus:outline-none"
                    >
                      <option value="">{t("adminSettings.selectRole")}</option>
                      {discordRoles.map((role) => (
                        <option key={role.id} value={role.id}>{role.name}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id="to_role_id"
                      type="text"
                      name="to_role_id"
                      value={settings.to_role_id}
                      onChange={handleChange}
                      placeholder={t("adminSettings.roleIdPlaceholder")}
                      className="w-full bg-slate-900 border border-slate-600 rounded-lg p-3 text-white"
                    />
                  )}
                </div>
              </div>
            </div>

            {/* SALONS */}
            <div className="space-y-6 pt-4">
              <h2 className="text-xl font-semibold text-slate-200 border-b border-slate-700 pb-2">{t("adminSettings.channelsSection")}</h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="flex flex-col gap-2">
                  <label htmlFor="checkin_channel_id" className="text-sm font-medium text-slate-400">{t("adminSettings.checkinChannel")}</label>
                  {discordChannels.length > 0 ? (
                    <>
                      <select
                        id="checkin_channel_id"
                        name="checkin_channel_id"
                        value={settings.checkin_channel_id}
                        onChange={handleChange}
                        className="w-full bg-slate-900 border border-slate-600 rounded-lg p-3 text-white focus:border-blue-500 focus:outline-none"
                      >
                        <option value="">{t("adminSettings.selectChannel")}</option>
                        {settings.checkin_channel_id &&
                          !discordChannels.some((ch) => ch.id === settings.checkin_channel_id) && (
                            <option value={settings.checkin_channel_id} disabled className="text-amber-400 bg-slate-800">
                              {t("adminSettings.channelInaccessibleOption")} (#{settings.checkin_channel_id})
                            </option>
                          )}
                        {discordChannels.map((ch) => (
                          <option key={ch.id} value={ch.id}>#{ch.name}</option>
                        ))}
                      </select>
                      {settings.checkin_channel_id &&
                        !discordChannels.some((ch) => ch.id === settings.checkin_channel_id) && (
                          <p className="text-xs text-amber-300 flex items-center gap-1.5 mt-1">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            {t("adminSettings.channelInaccessibleNotice")}
                          </p>
                        )}
                    </>
                  ) : (
                    <input
                      id="checkin_channel_id"
                      type="text"
                      name="checkin_channel_id"
                      value={settings.checkin_channel_id}
                      onChange={handleChange}
                      placeholder={t("adminSettings.channelIdPlaceholder")}
                      className="w-full bg-slate-900 border border-slate-600 rounded-lg p-3 text-white"
                    />
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <label htmlFor="announcement_channel_id" className="text-sm font-medium text-slate-400">{t("adminSettings.announcementChannel")}</label>
                  {discordChannels.length > 0 ? (
                    <>
                      <select
                        id="announcement_channel_id"
                        name="announcement_channel_id"
                        value={settings.announcement_channel_id}
                        onChange={handleChange}
                        className="w-full bg-slate-900 border border-slate-600 rounded-lg p-3 text-white focus:border-blue-500 focus:outline-none"
                      >
                        <option value="">{t("adminSettings.selectChannel")}</option>
                        {settings.announcement_channel_id &&
                          !discordChannels.some((ch) => ch.id === settings.announcement_channel_id) && (
                            <option value={settings.announcement_channel_id} disabled className="text-amber-400 bg-slate-800">
                              {t("adminSettings.channelInaccessibleOption")} (#{settings.announcement_channel_id})
                            </option>
                          )}
                        {discordChannels.map((ch) => (
                          <option key={ch.id} value={ch.id}>#{ch.name}</option>
                        ))}
                      </select>
                      {settings.announcement_channel_id &&
                        !discordChannels.some((ch) => ch.id === settings.announcement_channel_id) && (
                          <p className="text-xs text-amber-300 flex items-center gap-1.5 mt-1">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            {t("adminSettings.channelInaccessibleNotice")}
                          </p>
                        )}
                    </>
                  ) : (
                    <input
                      id="announcement_channel_id"
                      type="text"
                      name="announcement_channel_id"
                      value={settings.announcement_channel_id}
                      onChange={handleChange}
                      placeholder={t("adminSettings.channelIdPlaceholder")}
                      className="w-full bg-slate-900 border border-slate-600 rounded-lg p-3 text-white"
                    />
                  )}
                </div>

                <div className="flex flex-col gap-2 md:col-span-2">
                  <label htmlFor="registration_channel_id" className="text-sm font-medium text-slate-400">{t("adminSettings.registrationChannel")}</label>
                  {discordChannels.length > 0 ? (
                    <>
                      <select
                        id="registration_channel_id"
                        name="registration_channel_id"
                        value={settings.registration_channel_id}
                        onChange={handleChange}
                        className="w-full bg-slate-900 border border-slate-600 rounded-lg p-3 text-white focus:border-blue-500 focus:outline-none"
                      >
                        <option value="">{t("adminSettings.selectRegistrationChannel")}</option>
                        {settings.registration_channel_id &&
                          !discordChannels.some((ch) => ch.id === settings.registration_channel_id) && (
                            <option value={settings.registration_channel_id} disabled className="text-amber-400 bg-slate-800">
                              {t("adminSettings.channelInaccessibleOption")} (#{settings.registration_channel_id})
                            </option>
                          )}
                        {discordChannels.map((ch) => (
                          <option key={ch.id} value={ch.id}>#{ch.name}</option>
                        ))}
                      </select>
                      {settings.registration_channel_id &&
                        !discordChannels.some((ch) => ch.id === settings.registration_channel_id) && (
                          <p className="text-xs text-amber-300 flex items-center gap-1.5 mt-1">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            {t("adminSettings.channelInaccessibleNotice")}
                          </p>
                        )}
                    </>
                  ) : (
                    <input
                      id="registration_channel_id"
                      type="text"
                      name="registration_channel_id"
                      value={settings.registration_channel_id}
                      onChange={handleChange}
                      placeholder={t("adminSettings.channelIdPlaceholder")}
                      className="w-full bg-slate-900 border border-slate-600 rounded-lg p-3 text-white"
                    />
                  )}
                </div>
              </div>
            </div>
          </>
        ) : hasOrgRecord ? (
          <div className="bg-slate-900/50 border border-slate-700/60 p-4 rounded-xl text-slate-400 text-sm">
            {t("adminSettings.discordSectionNotice")}
          </div>
        ) : null}

        {/* INVITATION PUBLIQUE OU CONTACT */}
        <div className="space-y-4 pt-4">
          <h2 className="text-xl font-semibold text-slate-200 border-b border-slate-700 pb-2">
            {discordEnabled ? t("adminSettings.inviteSection") : t("adminSettings.contactLabel")}
          </h2>
          <div className="flex flex-col gap-2 max-w-xl">
            <label htmlFor="invite_url" className="text-sm font-medium text-slate-400">
              {discordEnabled ? t("adminSettings.inviteLabel") : t("adminSettings.contactLabel")}
            </label>
            <input
              id="invite_url"
              type="url"
              name="invite_url"
              value={settings.invite_url}
              onChange={handleChange}
              placeholder={discordEnabled ? t("adminSettings.invitePlaceholder") : "https://..."}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg p-3 text-white focus:border-blue-500 focus:outline-none"
            />
            <p className="text-xs text-slate-400">
              {discordEnabled ? t("adminSettings.inviteDesc") : t("adminSettings.contactDesc")}
            </p>
          </div>
        </div>

        {/* BOT LANGUAGE */}
        <div className="space-y-4 pt-4">
          <h2 className="text-xl font-semibold text-slate-200 border-b border-slate-700 pb-2">{t("adminSettings.botLanguage")}</h2>
          <p className="text-xs text-slate-400">{t("adminSettings.botLanguageDesc")}</p>
          <div className="max-w-xs">
            <select
              id="server_language"
              name="language"
              aria-label={t("adminSettings.botLanguage")}
              value={settings.language}
              onChange={handleChange}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg p-3 text-white focus:border-blue-500 focus:outline-none"
            >
              <option value="fr">🇫🇷 Français</option>
              <option value="en">🇬🇧 English</option>
            </select>
          </div>
        </div>

        {/* MESSAGES & VALIDATION */}
        {message.text && (
          <div className={`p-4 rounded-lg flex items-center ${
            message.type === 'success' ? 'bg-green-900/30 text-green-400 border border-green-800' : 'bg-red-900/30 text-red-500 border border-red-800'
          }`}>
            {message.text}
          </div>
        )}

        <div className="pt-6 flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="bg-blue-600 hover:bg-blue-500 text-white px-8 py-3 rounded-lg font-bold flex items-center gap-2 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
            {saving ? t("adminSettings.saving") : t("adminSettings.save")}
          </button>
        </div>
      </form>
      <ConfirmModal
        isOpen={showDisableModal}
        onClose={() => setShowDisableModal(false)}
        onConfirm={handleDisableDiscord}
        title={t("organizations.disableDiscord")}
        description={
          <span className="space-y-3 block">
            <span className="block">{t("organizations.disableDiscordConfirm")}</span>
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input type="checkbox" checked={cleanupDiscord} onChange={(e) => setCleanupDiscord(e.target.checked)} />
              {t("organizations.cleanupDiscordChannels")}
            </label>
          </span>
        }
        confirmText={t("organizations.disableDiscord")}
        variant="warning"
        isLoading={togglingDiscord}
      />
    </div>
  );
}
