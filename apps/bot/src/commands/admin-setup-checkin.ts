import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { supabase } from "../lib/supabase";
import { tBot, getGuildLanguage, discordLocalizations } from "../i18n";
import { resolveOrganization } from "../utils/tenant";

export const data = new SlashCommandBuilder()
  .setName("admin-setup-checkin")
  .setDescription(tBot("en", "checkin.commandDescription"))
  .setDescriptionLocalizations(discordLocalizations("checkin.commandDescription"))
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.isChatInputCommand()) return;
  const lang = await getGuildLanguage(interaction.guildId);

  // 1. Fetch current organization settings to verify TO rights
  let toRoleId: string | null = null;
  if (interaction.guildId) {
    const org = await resolveOrganization(interaction.guildId);
    toRoleId = typeof org?.discordConfig?.to_role_id === "string" ? org.discordConfig.to_role_id : null;
  }

  // 2. Control permissions (Admins or TOs only)
  const isSetupAdmin = interaction.memberPermissions?.has(
    PermissionFlagsBits.Administrator,
  );

  // To verify if they have the TO role we must fetch the member from the guild
  let hasToRole = false;
  if (toRoleId && interaction.member && "roles" in interaction.member) {
    // interaction.member is GuildMember API
    hasToRole = (interaction.member as any).roles.cache.has(toRoleId);
  }

  if (!isSetupAdmin && !hasToRole) {
    return interaction.reply({
      content: tBot(lang, "checkin.noPermission"),
      ephemeral: true,
    });
  }

  // 3. Build UI
  const checkinEmbed = new EmbedBuilder()
    .setColor("#2ECC71")
    .setTitle(tBot(lang, "checkin.panelTitle"))
    .setDescription(tBot(lang, "checkin.panelDescription"));

  const checkinButton = new ButtonBuilder()
    .setCustomId("btn_checkin")
    .setLabel(tBot(lang, "checkin.confirmButton"))
    .setStyle(ButtonStyle.Success)
    .setEmoji("✅");

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    checkinButton,
  );

  // 4. Send Message to the Channel
  if (interaction.channel && "send" in interaction.channel) {
    const msg = await interaction.channel.send({
      embeds: [checkinEmbed],
      components: [row],
    });

    // 4.5 Mettre à jour la base de données avec le message_id
    const { data: latestTournament } = await supabase
      .from("tournaments")
      .select("id")
      .eq("guild_id", interaction.guildId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (latestTournament) {
      await supabase
        .from("tournaments")
        .update({ checkin_message_id: msg.id })
        .eq("id", latestTournament.id);
    }

    // 5. Reply to the TO
    await interaction.reply({
      content: tBot(lang, "checkin.panelDeployed"),
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      content: tBot(lang, "checkin.cannotDeploy"),
      ephemeral: true,
    });
  }
}
