import { canPerform } from "@hub/shared";
import { getGuildAdminAccess, getManagedTournament } from "@/lib/viewer";
import { discordListQuery } from "@/lib/accessRules";
import { notFound } from "next/navigation";
import { SettingsClient } from "./SettingsClient";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { resolveServerBotApiUrl } from "@/lib/config";

export default async function TournamentSettingsPage({
  params
}: {
  params: Promise<{ guildId: string; id: string }>;
}) {
  const { guildId, id: tournamentId } = await params;
  const tournament = await getManagedTournament(guildId, tournamentId);
  if (!tournament) notFound();
  // SEC-22 : les rôles du tournoi (TO, Capitaine) restent réservés au niveau SERVER.
  const access = await getGuildAdminAccess(guildId);
  const canManageRoles = access.allowed && canPerform(access.access, "MANAGE_TOURNAMENT_ROLES", tournamentId);


  // Fetch Discord data server-side using BOT_API_SECRET and user session headers
  let channels: any[] = [];
  let roles: any[] = [];

  const botApiUrl = resolveServerBotApiUrl();
  const botApiSecret = process.env.BOT_API_SECRET;

  if (!botApiSecret) {
    console.error("BOT_API_SECRET is not configured on the web server. Discord data cannot be fetched.");
  } else {
    try {
      const session = await getServerSession(authOptions);
      const discordId = (session?.user as any)?.id || "";

      const headers: HeadersInit = {
        'Authorization': `Bearer ${botApiSecret}`,
        'X-Discord-User-Id': discordId,
        'X-Guild-Id': guildId
      };

      const [channelsRes, rolesRes] = await Promise.all([
        fetch(`${botApiUrl}/api/discord/channels?${discordListQuery(guildId, tournamentId)}`, { headers }),
        fetch(`${botApiUrl}/api/discord/roles?${discordListQuery(guildId, tournamentId)}`, { headers })
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
    <SettingsClient
      tournament={tournament}
      guildId={guildId}
      canManageRoles={canManageRoles}
      initialChannels={channels}
      initialRoles={roles}
    />
  );
}
