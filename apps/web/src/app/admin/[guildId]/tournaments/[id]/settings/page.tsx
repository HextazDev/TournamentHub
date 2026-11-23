import { canPerform, isDiscordSnowflake } from "@hub/shared";
import { getGuildAdminAccess, getManagedTournament, getServerProfile } from "@/lib/viewer";
import { discordListQuery } from "@/lib/accessRules";
import { notFound } from "next/navigation";
import { SettingsClient } from "./SettingsClient";
import { TournamentAccessPanel } from "@/components/admin/TournamentAccessPanel";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { resolveServerBotApiUrl } from "@/lib/config";

export default async function TournamentSettingsPage({
  params
}: {
  params: Promise<{ guildId: string; id: string }>;
}) {
  const { guildId, id: tournamentId } = await params;
  const [tournament, access, profile] = await Promise.all([
    getManagedTournament(guildId, tournamentId),
    getGuildAdminAccess(guildId),
    getServerProfile(guildId),
  ]);
  if (!tournament) notFound();
  // SEC-22 : les rôles du tournoi (TO, Capitaine) restent réservés au niveau SERVER.
  const canManageRoles = access.allowed && canPerform(access.access, "MANAGE_TOURNAMENT_ROLES", tournamentId);
  const discordEnabled = profile?.discord_enabled !== false && (isDiscordSnowflake(guildId) || Boolean(profile?.guild_id && isDiscordSnowflake(profile.guild_id)));
  const targetDiscordId = isDiscordSnowflake(guildId) ? guildId : (profile?.guild_id && isDiscordSnowflake(profile.guild_id) ? profile.guild_id : null);

  // Fetch Discord data server-side using BOT_API_SECRET and user session headers
  let channels: { id: string; name: string }[] = [];
  let roles: { id: string; name: string }[] = [];

  const botApiUrl = resolveServerBotApiUrl();
  const botApiSecret = process.env.BOT_API_SECRET;

  if (discordEnabled && targetDiscordId && botApiSecret) {
    try {
      const session = await getServerSession(authOptions);
      const discordId = (session?.user as { id?: string } | undefined)?.id ?? "";

      const headers: HeadersInit = {
        'Authorization': `Bearer ${botApiSecret}`,
        'X-Discord-User-Id': discordId,
        'X-Guild-Id': targetDiscordId,
      };

      const [channelsRes, rolesRes] = await Promise.all([
        fetch(`${botApiUrl}/api/discord/channels?${discordListQuery(targetDiscordId, tournamentId)}`, { headers }),
        fetch(`${botApiUrl}/api/discord/roles?${discordListQuery(targetDiscordId, tournamentId)}`, { headers })
      ]);

      if (channelsRes.ok) {
        channels = await channelsRes.json();
      } else {
        console.error("Failed to fetch Discord channels:", await channelsRes.text());
      }

      if (rolesRes.ok) {
        roles = await rolesRes.json();
      } else {
        console.error("Failed to fetch Discord roles:", await rolesRes.text());
      }
    } catch (e) {
      console.error("Error fetching Discord data on server:", e);
    }
  }

  return (
    <div className="space-y-6">
      <SettingsClient
        tournament={tournament}
        guildId={guildId}
        discordGuildId={targetDiscordId ?? undefined}
        discordEnabled={discordEnabled}
        canManageRoles={canManageRoles}
        initialChannels={channels}
        initialRoles={roles}
      />
      <div className="px-6 md:px-8 pb-8">
        <TournamentAccessPanel
          guildId={guildId}
          tournamentId={tournamentId}
          isPublic={Boolean(tournament.is_public)}
          canManageStaff={canManageRoles}
        />
      </div>
    </div>
  );
}
