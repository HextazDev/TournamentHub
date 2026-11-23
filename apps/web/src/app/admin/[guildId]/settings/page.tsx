import Link from "next/link";
import { notFound } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { canPerform } from "@hub/shared";
import { getGuildAdminAccess, getServerProfile, getViewer } from "@/lib/viewer";
import { canManageFromOAuth } from "@/lib/accessRules";
import { OrganizationMembersPanel } from "@/components/admin/OrganizationMembersPanel";
import { t } from "@/i18n";
import { getServerLocale } from "@/i18n/server";
import { ServerSettingsClient } from "./ServerSettingsClient";

export default async function SettingsPage({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  const access = await getGuildAdminAccess(guildId);
  // Le layout admin affiche déjà le motif d'un refus d'accès au panel.
  if (!access.allowed) notFound();

  // SEC-16 : le rôle TO ne décide pas qui est TO ; le bot applique la même règle sur PUT /api/server-settings.
  if (!canPerform(access.access, "MANAGE_SERVER_SETTINGS")) {
    const locale = await getServerLocale();
    return (
      <div className="p-6 md:p-8 w-full max-w-3xl mx-auto">
        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-8 text-center space-y-4">
          <ShieldAlert className="w-12 h-12 text-amber-400 mx-auto" />
          <h1 className="text-2xl font-bold text-white">{t(locale, "access.settingsDeniedTitle")}</h1>
          <p className="text-slate-300">{t(locale, "access.SERVER_SETTINGS_RESERVED")}</p>
          <Link
            href={`/admin/${guildId}/tournaments`}
            className="inline-block rounded-lg bg-blue-600 hover:bg-blue-500 px-4 py-2 font-semibold text-white"
          >
            {t(locale, "adminSidebar.manageTournaments")}
          </Link>
        </div>
      </div>
    );
  }

  const [viewer, profile] = await Promise.all([getViewer(), getServerProfile(guildId)]);
  // Liste indicative : le bot revérifie les droits réels sur le serveur choisi (SEC-18).
  const manageableGuilds = (viewer.guilds ?? [])
    .filter(canManageFromOAuth)
    .map((guild) => ({ id: guild.id, name: guild.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <ServerSettingsClient guildId={guildId} manageableGuilds={manageableGuilds} />
      {profile?.organization_id && profile.slug && viewer.discordId && (
        <div className="p-6 md:p-8 pt-0 w-full max-w-[1600px] mx-auto">
          <OrganizationMembersPanel
            organizationId={profile.organization_id}
            slug={profile.slug}
            viewerId={viewer.discordId}
            canManageOwnership={canPerform(access.access, "TRANSFER_OWNERSHIP")}
          />
        </div>
      )}
    </div>
  );
}
