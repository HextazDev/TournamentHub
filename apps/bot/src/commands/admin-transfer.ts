import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  AutocompleteInteraction,
  GuildMember,
} from "discord.js";
import { supabase } from "../lib/supabase";
import { tBot, getGuildLanguage, discordLocalizations } from "../i18n";
import { resolveOrganization } from "../utils/tenant";

export const data = new SlashCommandBuilder()
  .setName("admin-transfer")
  .setDescription(tBot("en", "transfer.commandDescription"))
  .setDescriptionLocalizations(discordLocalizations("transfer.commandDescription"))
  .addStringOption((opt) =>
    opt
      .setName("equipe")
      .setDescription(tBot("en", "transfer.teamOptionDescription"))
      .setDescriptionLocalizations(discordLocalizations("transfer.teamOptionDescription"))
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addUserOption((opt) =>
    opt
      .setName("nouveau_capitaine")
      .setDescription(tBot("en", "transfer.captainOptionDescription"))
      .setDescriptionLocalizations(discordLocalizations("transfer.captainOptionDescription"))
      .setRequired(true),
  );

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focusedValue = interaction.options.getFocused();
  const guildId = interaction.guildId;

  if (!guildId) return interaction.respond([]);

  // 1. Trouver d'abord les tournois de ce serveur
  const { data: tournaments } = await supabase
    .from("tournaments")
    .select("id")
    .eq("guild_id", guildId);

  if (!tournaments || tournaments.length === 0) {
    return interaction.respond([]);
  }

  // Extraire la liste des IDs de tournois sur ce Discord
  const tournamentIds = tournaments.map((t) => t.id);

  // 2. Chercher les équipes appartenant à ces tournois et au nom cherché
  const { data: teams } = await supabase
    .from("teams")
    .select("name")
    .in("tournament_id", tournamentIds)
    .ilike("name", `%${focusedValue}%`)
    .limit(25);

  const choices = teams?.map((t) => ({ name: t.name, value: t.name })) || [];
  await interaction.respond(choices);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;

  const teamName = interaction.options.getString("equipe", true);
  const newCaptain = interaction.options.getUser("nouveau_capitaine", true);
  const lang = await getGuildLanguage(interaction.guildId);

  // 1. Autorisation (Sécurité)
  const org = await resolveOrganization(interaction.guildId);
  const toRoleId = typeof org?.discordConfig?.to_role_id === "string" ? org.discordConfig.to_role_id : null;
  const member = interaction.member as GuildMember;

  if (!toRoleId || !member.roles.cache.has(toRoleId)) {
    return interaction.reply({
      content: tBot(lang, "transfer.accessDenied"),
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: false });

  // 2. Trouver l'équipe
  const { data: team, error: teamErr } = await supabase
    .from("teams")
    .select("*, tournaments!inner(guild_id)")
    .eq("name", teamName)
    .eq("tournaments.guild_id", interaction.guildId)
    .single();

  if (teamErr || !team) {
    return interaction.editReply(tBot(lang, "transfer.teamNotFound", { teamName }));
  }

  const oldCaptainId = team.captain_discord_id;
  if (oldCaptainId === newCaptain.id) {
    return interaction.editReply(tBot(lang, "transfer.alreadyCaptain"));
  }

  // 3. Base de données : Transfert logique
  // 3a. Update Teams table
  await supabase
    .from("teams")
    .update({ captain_discord_id: newCaptain.id })
    .eq("id", team.id);

  // 3b. Update old captain (demotion)
  await supabase
    .from("team_members")
    .update({ is_captain: false, user_id: null }) // Remove discord linking for old captain
    .eq("team_id", team.id)
    .eq("user_id", oldCaptainId);

  // 3c. Promote new captain (or create if missing)
  const { data: existingMember } = await supabase
    .from("team_members")
    .select("id")
    .eq("team_id", team.id)
    .eq("ingame_name", newCaptain.username) // Guessing here if they exist without user_id
    .limit(1)
    .single();

  if (existingMember) {
    await supabase
      .from("team_members")
      .update({ user_id: newCaptain.id, is_captain: true })
      .eq("id", existingMember.id);
  } else {
    // If we transfer to someone entirely new to the roster, insert them as captain
    // We set a default friend_code "A_REMPLIR" as we don't know it.
    await supabase.from("team_members").insert({
      team_id: team.id,
      user_id: newCaptain.id,
      ingame_name: newCaptain.username,
      friend_code: "A_Renseigner",
      is_captain: true,
    });
  }

  // 4. Discord Actions : Rename old & new captain
  let renameMessage = "";
  try {
    const oldMember = await interaction.guild?.members
      .fetch(oldCaptainId)
      .catch(() => null);
    if (oldMember) await oldMember.setNickname(null); // Reset
  } catch (e: any) {
    renameMessage += `\n${tBot(lang, "transfer.resetNicknameFailed")}`;
  }

  try {
    const newMember = await interaction.guild?.members
      .fetch(newCaptain.id)
      .catch(() => null);
    if (newMember) await newMember.setNickname(teamName);
  } catch (e: any) {
    renameMessage += `\n${tBot(lang, "transfer.renameFailed")}`;
  }

  // 5. Feedback
  const embed = new EmbedBuilder()
    .setColor("#00FF00")
    .setTitle(tBot(lang, "transfer.successTitle"))
    .setDescription(
      tBot(lang, "transfer.successDescription", { teamName, oldCaptainId, newCaptainId: newCaptain.id }),
    );

  if (renameMessage) {
    embed.setFooter({ text: renameMessage });
  }

  await interaction.editReply({ embeds: [embed] });
}
