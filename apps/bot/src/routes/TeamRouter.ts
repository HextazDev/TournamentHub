import { Router } from "express";
import { supabase } from "../lib/supabase";
import { getAuthenticatedGuildId, verifyTeamGuild, verifyTournamentGuild } from "../utils/tenant";
import { MAX_FAKE_TEAMS } from "@hub/shared";
import type { Client } from "discord.js";
import { applyPresence, removePresence } from "../services/CaptainPresenceService";

export const teamRouter = Router();

// POST /api/teams — Create a team with its members
teamRouter.post("/", async (req, res) => {
  try {
    const { tournament_id, name, captain_discord_id, is_checked_in, members } = req.body;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyTournamentGuild(tournament_id, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : ce tournoi n'appartient pas à votre serveur." });
    }

    if (!tournament_id || !name) {
      return res.status(400).json({ error: "tournament_id and name are required" });
    }

    const { data: team, error: teamError } = await supabase
      .from("teams")
      .insert({
        tournament_id,
        name,
        captain_discord_id: captain_discord_id || null,
        is_checked_in: is_checked_in ?? true,
      })
      .select()
      .single();

    if (teamError) throw teamError;

    let insertedMembers: any[] = [];
    if (members && members.length > 0) {
      const membersToInsert = members.map((m: any) => ({
        team_id: team.id,
        user_id: m.user_id || null,
        ingame_name: m.ingame_name || "",
        friend_code: m.friend_code || "",
        is_captain: m.is_captain ?? false,
      }));

      const { data: mData, error: mError } = await supabase
        .from("team_members")
        .insert(membersToInsert)
        .select();

      if (mError) throw mError;
      insertedMembers = mData || [];
    }

    res.status(201).json({ ...team, team_members: insertedMembers });
  } catch (error: any) {
    console.error("[TeamRouter] Create error:", error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/teams/generate-fake — Generate fake teams for testing
teamRouter.post("/generate-fake", async (req, res) => {
  try {
    const { tournament_id, count } = req.body;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyTournamentGuild(tournament_id, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : ce tournoi n'appartient pas à votre serveur." });
    }

    if (!tournament_id || typeof count !== "number" || count <= 0) {
      return res.status(400).json({ error: "tournament_id and a positive count integer are required" });
    }

    // Plafonner la génération d'équipes fictives pour éviter le DoS / Memory Exhaustion
    const safeCount = Math.min(Math.max(1, count), MAX_FAKE_TEAMS);

    const fakeTeams = Array.from({ length: safeCount }).map(() => ({
      tournament_id,
      name: `Equipe Fictive ${Math.floor(Math.random() * 10000)}`,
      captain_discord_id: `999999999${Math.floor(Math.random() * 10000)}`,
      is_checked_in: true,
    }));

    const { data: teams, error: teamsError } = await supabase
      .from("teams")
      .insert(fakeTeams)
      .select();

    if (teamsError) throw teamsError;

    const allFakeMembers: any[] = [];
    teams.forEach((t: any) => {
      const memberCount = Math.floor(Math.random() * 3) + 4;
      for (let i = 0; i < memberCount; i++) {
        const isCaptain = i === 0;
        const fakeFC = `SW-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`;
        allFakeMembers.push({
          team_id: t.id,
          user_id: isCaptain ? t.captain_discord_id : null,
          ingame_name: `Joueur ${Math.floor(Math.random() * 1000)}`,
          friend_code: fakeFC,
          is_captain: isCaptain,
        });
      }
    });

    let insertedMembers: any[] = [];
    if (allFakeMembers.length > 0) {
      const { data: mData, error: mError } = await supabase
        .from("team_members")
        .insert(allFakeMembers)
        .select();

      if (mError) {
        console.error("[TeamRouter] Fake members insert error:", mError);
      } else {
        insertedMembers = mData || [];
      }
    }

    const result = teams.map((t: any) => ({
      ...t,
      team_members: insertedMembers.filter((m: any) => m.team_id === t.id),
    }));

    res.status(201).json(result);
  } catch (error: any) {
    console.error("[TeamRouter] Generate-fake error:", error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/teams/:id — Update a team (name, captain, replace all members)
teamRouter.put("/:id", async (req, res) => {
  try {
    const teamId = req.params.id;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyTeamGuild(teamId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : cette équipe n'appartient pas à votre serveur." });
    }

    const { name, captain_discord_id, members } = req.body;

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const { data: updatedTeam, error: updateError } = await supabase
      .from("teams")
      .update({ name, captain_discord_id: captain_discord_id || null })
      .eq("id", teamId)
      .select()
      .single();

    if (updateError) throw updateError;
    if (!updatedTeam) return res.status(404).json({ error: "Team not found" });

    // Replace all members if provided
    let updatedMembers: any[] = [];
    if (members && members.length > 0) {
      await supabase.from("team_members").delete().eq("team_id", teamId);

      const membersToInsert = members.map((m: any) => ({
        team_id: teamId,
        user_id: m.user_id || null,
        ingame_name: m.ingame_name || "",
        friend_code: m.friend_code || "",
        is_captain: m.is_captain ?? false,
      }));

      const { data: inserted, error: insertError } = await supabase
        .from("team_members")
        .insert(membersToInsert)
        .select();

      if (insertError) throw insertError;
      updatedMembers = inserted || [];
    }

    res.json({ ...updatedTeam, team_members: updatedMembers });
  } catch (error: any) {
    console.error("[TeamRouter] Update error:", error);
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/teams/:id/checkin — Toggle check-in status
teamRouter.patch("/:id/checkin", async (req, res) => {
  try {
    const teamId = req.params.id;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyTeamGuild(teamId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : cette équipe n'appartient pas à votre serveur." });
    }

    const { is_checked_in } = req.body;

    if (typeof is_checked_in !== "boolean") {
      return res.status(400).json({ error: "is_checked_in (boolean) is required" });
    }

    const { data: updated, error } = await supabase
      .from("teams")
      .update({ is_checked_in })
      .eq("id", teamId)
      .select()
      .single();

    if (error) throw error;
    if (!updated) return res.status(404).json({ error: "Team not found" });

    // DISC-11 : la présence (pseudo + rôle Capitaine) est appliquée ici, sans dépendre du webhook Supabase.
    // Un refus Discord est journalisé par CaptainPresenceService et n'annule pas le check-in.
    if (updated.captain_discord_id) {
      const client: Client = req.app.locals.discordClient;
      const team = {
        id: updated.id,
        tournament_id: updated.tournament_id,
        name: updated.name,
        captain_discord_id: updated.captain_discord_id,
      };
      await (is_checked_in ? applyPresence(client, team) : removePresence(client, team));
    }

    res.json(updated);
  } catch (error: any) {
    console.error("[TeamRouter] Checkin error:", error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/teams/:id — Delete a team
teamRouter.delete("/:id", async (req, res) => {
  try {
    const teamId = req.params.id;
    const authGuildId = getAuthenticatedGuildId(req);
    if (!authGuildId || !(await verifyTeamGuild(teamId, authGuildId))) {
      return res.status(403).json({ error: "Accès refusé : cette équipe n'appartient pas à votre serveur." });
    }

    // team_members cascade or we delete manually
    await supabase.from("team_members").delete().eq("team_id", teamId);

    const { error } = await supabase.from("teams").delete().eq("id", teamId);
    if (error) throw error;

    res.json({ success: true });
  } catch (error: any) {
    console.error("[TeamRouter] Delete error:", error);
    res.status(500).json({ error: error.message });
  }
});
