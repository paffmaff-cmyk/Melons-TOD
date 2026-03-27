require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActivityType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags,
} = require('discord.js');

const BOSSES_FILE = path.join(__dirname, 'bosses.json');

// Load bosses from JSON file
let BOSSES = JSON.parse(fs.readFileSync(BOSSES_FILE, 'utf8'));

function saveBosses() {
  fs.writeFileSync(BOSSES_FILE, JSON.stringify(BOSSES, null, 2));
}

function findBoss(name) {
  return BOSSES.find(b => b.name.toLowerCase() === name.toLowerCase());
}

function discordTime(date, format = 'F') {
  return `<t:${Math.floor(date.getTime() / 1000)}:${format}>`;
}

function buildOptionsEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('Boss Options')
    .setDescription(BOSSES.map(b => `• **${b.name}** — spawn ${b.spawnHours}h | window ${b.windowHours}h`).join('\n'));
}

function buildOptionsComponents() {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('select_boss_edit')
    .setPlaceholder('Select a boss to edit or delete...')
    .addOptions(
      BOSSES.slice(0, 25).map(b => ({
        label: b.name,
        description: `Spawn: ${b.spawnHours}h | Window: ${b.windowHours}h`,
        value: b.name,
      }))
    );

  const addButton = new ButtonBuilder()
    .setCustomId('add_boss')
    .setLabel('➕ Add Boss')
    .setStyle(ButtonStyle.Success);

  return [
    new ActionRowBuilder().addComponents(selectMenu),
    new ActionRowBuilder().addComponents(addButton),
  ];
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity('Boss Timers', { type: ActivityType.Watching });
});

client.on('interactionCreate', async interaction => {

  // ── Autocomplete ──────────────────────────────────────────────
  if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused().toLowerCase();
    const choices = BOSSES
      .filter(b => b.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map(b => ({ name: b.name, value: b.name }));
    await interaction.respond(choices);
    return;
  }

  // ── Slash commands ────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {

    // /tod
    if (interaction.commandName === 'tod') {
      const bossName  = interaction.options.getString('boss_name');
      const dropped   = interaction.options.getBoolean('drop');
      const whoKilled = interaction.options.getString('who_killed');
      const offset    = interaction.options.getInteger('tod_offset') ?? 0;

      const boss = findBoss(bossName);
      if (!boss) {
        await interaction.reply({ content: `❌ Boss **${bossName}** not found. Use \`/bosses\` to see the list.`, flags: MessageFlags.Ephemeral });
        return;
      }

      const now         = new Date();
      const todTime     = new Date(now.getTime() - offset * 60 * 1000);
      const windowStart = new Date(todTime.getTime() + boss.spawnHours * 60 * 60 * 1000);
      const windowEnd   = new Date(windowStart.getTime() + boss.windowHours * 60 * 60 * 1000);

      const killedBy    = whoKilled === 'ally' ? 'Ally ✅' : whoKilled === 'enemy' ? 'Enemy ❌' : null;
      const embedColor  = whoKilled === 'ally' ? 0x57F287 : whoKilled === 'enemy' ? 0xED4245 : (dropped ? 0x57F287 : 0xED4245);

      const embed = new EmbedBuilder()
        .setColor(embedColor)
        .setTitle(killedBy ? `${boss.name} — Killed by ${killedBy}` : boss.name)
        .addFields(
          { name: 'Reported by',    value: `${interaction.user}`,                                              inline: false },
          { name: 'TOD',            value: `${discordTime(todTime, 'F')} | TOD offset: 🕐 ${offset} min`,     inline: false },
          { name: 'Spawn time',     value: `${boss.spawnHours} hours`,                                        inline: true  },
          { name: 'Window',         value: `${boss.windowHours} hours`,                                       inline: true  },
          { name: '\u200B',         value: '\u200B',                                                           inline: false },
          { name: 'Window start',   value: discordTime(windowStart, 'F'),                                      inline: false },
          { name: 'Window end',     value: discordTime(windowEnd, 'F'),                                        inline: false },
          { name: 'Drop',           value: dropped ? 'Dropped ✅' : 'Did not drop ❌',                        inline: false },
        )
        .setFooter({ text: `Melon's TOD Bot`, iconURL: client.user.displayAvatarURL() })
        .setTimestamp(todTime);

      await interaction.reply({ embeds: [embed] });
      return;
    }

    // /bosses
    if (interaction.commandName === 'bosses') {
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Boss Respawn List')
        .setDescription(BOSSES.map(b => `• **${b.name}** — spawn in ${b.spawnHours}h, window ${b.windowHours}h`).join('\n'))
        .setFooter({ text: `Melon's TOD Bot` });
      await interaction.reply({ embeds: [embed] });
      return;
    }

    // /todoptions
    if (interaction.commandName === 'todoptions') {
      await interaction.reply({
        embeds: [buildOptionsEmbed()],
        components: buildOptionsComponents(),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  // ── Select menu: pick boss to edit/delete ─────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_boss_edit') {
    const bossName = interaction.values[0];
    const boss = findBoss(bossName);

    const editBtn = new ButtonBuilder()
      .setCustomId(`edit_boss|${boss.name}`)
      .setLabel(`✏️ Edit ${boss.name}`)
      .setStyle(ButtonStyle.Primary);

    const deleteBtn = new ButtonBuilder()
      .setCustomId(`delete_boss|${boss.name}`)
      .setLabel(`🗑️ Delete ${boss.name}`)
      .setStyle(ButtonStyle.Danger);

    const backBtn = new ButtonBuilder()
      .setCustomId('back_to_options')
      .setLabel('← Back')
      .setStyle(ButtonStyle.Secondary);

    await interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`${boss.name}`)
        .setDescription(`Spawn time: **${boss.spawnHours}h**\nWindow duration: **${boss.windowHours}h**`)
      ],
      components: [new ActionRowBuilder().addComponents(editBtn, deleteBtn, backBtn)],
    });
    return;
  }

  // ── Buttons ───────────────────────────────────────────────────
  if (interaction.isButton()) {

    // Back button
    if (interaction.customId === 'back_to_options') {
      await interaction.update({
        embeds: [buildOptionsEmbed()],
        components: buildOptionsComponents(),
      });
      return;
    }

    // Add boss → show modal
    if (interaction.customId === 'add_boss') {
      const modal = new ModalBuilder()
        .setCustomId('modal_add_boss')
        .setTitle('Add New Boss')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('boss_name').setLabel('Boss Name').setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('spawn_hours').setLabel('Spawn Time (hours)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 17')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('window_hours').setLabel('Window Duration (hours)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 4')
          ),
        );
      await interaction.showModal(modal);
      return;
    }

    // Edit boss → show modal pre-filled
    if (interaction.customId.startsWith('edit_boss|')) {
      const bossName = interaction.customId.split('|')[1];
      const boss = findBoss(bossName);

      const modal = new ModalBuilder()
        .setCustomId(`modal_edit_boss|${bossName}`)
        .setTitle(`Edit ${bossName}`)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('boss_name').setLabel('Boss Name').setStyle(TextInputStyle.Short).setRequired(true).setValue(boss.name)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('spawn_hours').setLabel('Spawn Time (hours)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(boss.spawnHours))
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('window_hours').setLabel('Window Duration (hours)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(boss.windowHours))
          ),
        );
      await interaction.showModal(modal);
      return;
    }

    // Delete boss
    if (interaction.customId.startsWith('delete_boss|')) {
      const bossName = interaction.customId.split('|')[1];
      const index = BOSSES.findIndex(b => b.name === bossName);
      if (index !== -1) {
        BOSSES.splice(index, 1);
        saveBosses();
      }
      await interaction.update({
        embeds: [buildOptionsEmbed()],
        components: buildOptionsComponents(),
        content: `✅ **${bossName}** deleted.`,
      });
      return;
    }
  }

  // ── Modals ────────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {

    // Add boss modal
    if (interaction.customId === 'modal_add_boss') {
      const name        = interaction.fields.getTextInputValue('boss_name').trim();
      const spawnHours  = parseInt(interaction.fields.getTextInputValue('spawn_hours'));
      const windowHours = parseInt(interaction.fields.getTextInputValue('window_hours'));

      if (isNaN(spawnHours) || isNaN(windowHours)) {
        await interaction.reply({ content: '❌ Spawn time and window must be numbers.', flags: MessageFlags.Ephemeral });
        return;
      }

      BOSSES.push({ name, spawnHours, windowHours });
      saveBosses();

      await interaction.reply({ content: `✅ **${name}** added! (${spawnHours}h spawn, ${windowHours}h window)`, flags: MessageFlags.Ephemeral });
      return;
    }

    // Edit boss modal
    if (interaction.customId.startsWith('modal_edit_boss|')) {
      const oldName     = interaction.customId.split('|')[1];
      const newName     = interaction.fields.getTextInputValue('boss_name').trim();
      const spawnHours  = parseInt(interaction.fields.getTextInputValue('spawn_hours'));
      const windowHours = parseInt(interaction.fields.getTextInputValue('window_hours'));

      if (isNaN(spawnHours) || isNaN(windowHours)) {
        await interaction.reply({ content: '❌ Spawn time and window must be numbers.', flags: MessageFlags.Ephemeral });
        return;
      }

      const boss = BOSSES.find(b => b.name === oldName);
      if (boss) {
        boss.name        = newName;
        boss.spawnHours  = spawnHours;
        boss.windowHours = windowHours;
        saveBosses();
      }

      await interaction.reply({ content: `✅ **${oldName}** updated to **${newName}** (${spawnHours}h spawn, ${windowHours}h window)`, flags: MessageFlags.Ephemeral });
      return;
    }
  }

});

client.login(process.env.TOKEN);
