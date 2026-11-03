import { cache } from "react";
import type { ServerSettings } from "@hub/shared";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { splitServers } from "@/lib/accessRules";
import type { Viewer } from "@/lib/viewer";

/** Vues « Mes serveurs » et « Panel organisateur » du visiteur connecté (lectures service_role bornées à ses serveurs). */
export const loadServerOverview = cache(async (viewer: Viewer & { discordId: string; guilds: NonNullable<Viewer["guilds"]> }) => {
  const ids = viewer.guilds.map((g) => g.id);
  const [settingsRes, adminRes] = await Promise.all([
    supabaseAdmin.from("server_settings").select("*").in("guild_id", ids),
    supabaseAdmin.from("guild_admins").select("guild_id").eq("discord_id", viewer.discordId),
  ]);
  if (settingsRes.error) throw new Error(`server_settings read failed: ${settingsRes.error.message}`);
  if (adminRes.error) throw new Error(`guild_admins read failed: ${adminRes.error.message}`);

  const settings = new Map(((settingsRes.data ?? []) as ServerSettings[]).map((s) => [s.guild_id, s]));
  // Le rôle TO n'apparaît pas dans l'OAuth Discord : guild_admins (synchronisée par le bot) le complète.
  const adminOf = new Set((adminRes.data ?? []).map((row) => row.guild_id as string));
  return splitServers(viewer.guilds, settings, adminOf);
});
