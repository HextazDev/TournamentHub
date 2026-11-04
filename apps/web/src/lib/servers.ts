import { cache } from "react";
import { GuildDirectoryReasonSchema, type GuildDirectoryReason, type ServerSettings } from "@hub/shared";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { splitServers } from "@/lib/accessRules";
import type { Viewer } from "@/lib/viewer";

/** Vues « Mes serveurs » et « Panel organisateur » du visiteur connecté (lectures service_role bornées à ses serveurs). */
export const loadServerOverview = cache(async (viewer: Viewer & { discordId: string; guilds: NonNullable<Viewer["guilds"]> }) => {
  const ids = viewer.guilds.map((g) => g.id);
  const [settingsRes, adminRes] = await Promise.all([
    supabaseAdmin.from("server_settings").select("*").in("guild_id", ids),
    supabaseAdmin.from("guild_admins").select("guild_id, reason").eq("discord_id", viewer.discordId),
  ]);
  if (settingsRes.error) throw new Error(`server_settings read failed: ${settingsRes.error.message}`);
  if (adminRes.error) throw new Error(`guild_admins read failed: ${adminRes.error.message}`);

  const settings = new Map(((settingsRes.data ?? []) as ServerSettings[]).map((s) => [s.guild_id, s]));
  // Les rôles TO (serveur ou tournoi) n'apparaissent pas dans l'OAuth Discord : guild_admins (synchronisée par le
  // bot) les complète. Annuaire seulement : l'accès reste décidé par le bot (SEC-17 / SEC-24).
  const directory = new Map<string, GuildDirectoryReason>();
  for (const row of adminRes.data ?? []) {
    const reason = GuildDirectoryReasonSchema.safeParse(row.reason);
    if (reason.success && typeof row.guild_id === "string") directory.set(row.guild_id, reason.data);
  }
  return splitServers(viewer.guilds, settings, directory);
});
