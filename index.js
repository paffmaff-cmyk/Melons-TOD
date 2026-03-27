require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActivityType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags, REST, Routes, SlashCommandBuilder,
} = require('discord.js');

// ── Boss data ─────────────────────────────────────────────────
const BOSSES_FILE = path.join(__dirname, 'bosses.json');
let BOSSES = JSON.parse(fs.readFileSync(BOSSES_FILE, 'utf8'));

function saveBosses() {
  fs.writeFileSync(BOSSES_FILE, JSON.stringify(BOSSES, null, 2));
}

function findBoss(name) {
  return BOSSES.find(b => b.name.toLowerCase() === name.toLowerCase());
}

// ── Absence data ──────────────────────────────────────────────
const ABSENCES_FILE = path.join(__dirname, 'absences.json');
let absences = fs.existsSync(ABSENCES_FILE)
  ? JSON.parse(fs.readFileSync(ABSENCES_FILE, 'utf8'))
  : [];

function saveAbsences() {
  fs.writeFileSync(ABSENCES_FILE, JSON.stringify(absences, null, 2));
}

// ── TOD helpers ───────────────────────────────────────────────
function discordTime(date, format = 'F') {
  return `<t:${Math.floor(date.getTime() / 1000)}:${format}>`;
}

// ── Absence helpers ───────────────────────────────────────────
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function todayString() {
  const d = new Date();
  return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

function parseDate(str) {
  const year = new Date().getFullYear();
  const m = str.trim().match(/^(\d{1,2})[\/\-\.](\d{1,2})$/);
  if (!m) return null;
  const month = parseInt(m[1]) - 1, day = parseInt(m[2]);
  const d = new Date(year, month, day);
  if (d.getMonth() !== month || d.getDate() !== day) return null;
  return d;
}

function isPast(date) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return date < today;
}

function formatAbsenceDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2,'0')} ${MONTH_NAMES[m-1]} ${y}`;
}

function toISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function isoToDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const ABSENCE_CHANNELS = ['absence', 'day off', 'vacation', 'not gonna be'];
function isAbsenceChannel(interaction) {
  const name = interaction.channel?.name?.toLowerCase() ?? '';
  return ABSENCE_CHANNELS.some(kw => name.includes(kw));
}

// ── Boss options UI ───────────────────────────────────────────
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
    .addOptions(BOSSES.slice(0, 25).map(b => ({
      label: b.name,
      description: `Spawn: ${b.spawnHours}h | Window: ${b.windowHours}h`,
      value: b.name,
    })));

  return [
    new ActionRowBuilder().addComponents(selectMenu),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('add_boss').setLabel('➕ Add Boss').setStyle(ButtonStyle.Success)
    ),
  ];
}

// ── Commands ──────────────────────────────────────────────────
const COMMANDS = [
  new SlashCommandBuilder()
    .setName('tod')
    .setDescription('Record a boss Time of Death and calculate spawn window')
    .addStringOption(o => o.setName('boss_name').setDescription('Name of the boss that was killed').setRequired(true).setAutocomplete(true))
    .addBooleanOption(o => o.setName('drop').setDescription('Did the boss drop an item?').setRequired(true))
    .addStringOption(o => o.setName('who_killed').setDescription('Who killed the boss?').setRequired(false).addChoices({ name: 'Ally ✅', value: 'ally' }, { name: 'Enemy ❌', value: 'enemy' }))
    .addIntegerOption(o => o.setName('tod_offset').setDescription('Minutes ago the boss was killed (0 = right now)').setRequired(false).setMinValue(0).setMaxValue(1440))
    .toJSON(),
  new SlashCommandBuilder().setName('bosses').setDescription('List all bosses and their respawn times').toJSON(),
  new SlashCommandBuilder().setName('todoptions').setDescription('Add, edit or delete bosses from the list').toJSON(),
  new SlashCommandBuilder().setName('out').setDescription('Report an absence').toJSON(),
  new SlashCommandBuilder().setName('absences').setDescription('Show upcoming absences').toJSON(),
];

// ── Bot ───────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity('Boss Timers & Absences', { type: ActivityType.Watching });
});

client.on('guildCreate', async guild => {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guild.id), { body: COMMANDS });
    console.log(`✅ Commands registered for: ${guild.name}`);
  } catch (err) {
    console.error(`❌ Failed to register for ${guild.name}:`, err);
  }
});

client.on('interactionCreate', async interaction => {
  try {

    // ── Autocomplete ────────────────────────────────────────────
    if (interaction.isAutocomplete()) {
      const focused = interaction.options.getFocused().toLowerCase();
      const choices = BOSSES
        .filter(b => b.name.toLowerCase().includes(focused))
        .slice(0, 25)
        .map(b => ({ name: b.name, value: b.name }));
      await interaction.respond(choices);
      return;
    }

    // ── Slash commands ──────────────────────────────────────────
    if (interaction.isChatInputCommand()) {

      // ── /tod ──
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

        const killedBy   = whoKilled === 'ally' ? 'Ally ✅' : whoKilled === 'enemy' ? 'Enemy ❌' : null;
        const embedColor = whoKilled === 'ally' ? 0x57F287 : whoKilled === 'enemy' ? 0xED4245 : (dropped ? 0x57F287 : 0xED4245);

        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(embedColor)
            .setTitle(killedBy ? `${boss.name} — Killed by ${killedBy}` : boss.name)
            .addFields(
              { name: 'Reported by',  value: `${interaction.user}`,                                           inline: false },
              { name: 'TOD',          value: `${discordTime(todTime, 'F')} | TOD offset: 🕐 ${offset} min`,  inline: false },
              { name: 'Spawn time',   value: `${boss.spawnHours} hours`,                                      inline: true  },
              { name: 'Window',       value: `${boss.windowHours} hours`,                                     inline: true  },
              { name: '\u200B',       value: '\u200B',                                                         inline: false },
              { name: 'Window start', value: discordTime(windowStart, 'F'),                                    inline: false },
              { name: 'Window end',   value: discordTime(windowEnd, 'F'),                                      inline: false },
              { name: 'Drop',         value: dropped ? 'Dropped ✅' : 'Did not drop ❌',                      inline: false },
            )
            .setFooter({ text: `Melon's Bot`, iconURL: client.user.displayAvatarURL() })
            .setTimestamp(todTime)
          ],
        });
        return;
      }

      // ── /bosses ──
      if (interaction.commandName === 'bosses') {
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('Boss Respawn List')
            .setDescription(BOSSES.map(b => `• **${b.name}** — spawn in ${b.spawnHours}h, window ${b.windowHours}h`).join('\n'))
            .setFooter({ text: `Melon's Bot` })
          ],
        });
        return;
      }

      // ── /todoptions ──
      if (interaction.commandName === 'todoptions') {
        await interaction.reply({
          embeds: [buildOptionsEmbed()],
          components: buildOptionsComponents(),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // ── /out ──
      if (interaction.commandName === 'out') {
        if (!isAbsenceChannel(interaction)) {
          await interaction.reply({ content: '❌ This command can only be used in an absences channel.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({
          embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('Report Absence').setDescription('Choose absence type:')],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('type_day').setLabel('📅 Day Off').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('type_period').setLabel('📆 Period').setStyle(ButtonStyle.Secondary),
          )],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // ── /absences ──
      if (interaction.commandName === 'absences') {
        if (!isAbsenceChannel(interaction)) {
          await interaction.reply({ content: '❌ This command can only be used in an absences channel.', flags: MessageFlags.Ephemeral });
          return;
        }
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const upcoming = absences
          .filter(a => isoToDate(a.type === 'day' ? a.date : a.endDate) >= today)
          .sort((a, b) =>
            isoToDate(a.type === 'day' ? a.date : a.startDate) -
            isoToDate(b.type === 'day' ? b.date : b.startDate)
          );

        if (upcoming.length === 0) {
          await interaction.reply({ content: '✅ No upcoming absences.', flags: MessageFlags.Ephemeral });
          return;
        }

        const lines = upcoming.map(a => {
          const dateStr = a.type === 'day'
            ? formatAbsenceDate(a.date)
            : `${formatAbsenceDate(a.startDate)} → ${formatAbsenceDate(a.endDate)}`;
          return `${a.type === 'day' ? '📅' : '📆'} **${a.username}** | ${dateStr}${a.reason ? ` — *${a.reason}*` : ''}`;
        });

        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('Upcoming Absences')
            .setDescription(lines.join('\n'))
            .setFooter({ text: "Melon's Bot" })
          ],
        });
        return;
      }
    }

    // ── Select menu ─────────────────────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_boss_edit') {
      const boss = findBoss(interaction.values[0]);
      await interaction.update({
        embeds: [new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle(boss.name)
          .setDescription(`Spawn time: **${boss.spawnHours}h**\nWindow duration: **${boss.windowHours}h**`)
        ],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`edit_boss|${boss.name}`).setLabel(`✏️ Edit ${boss.name}`).setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`delete_boss|${boss.name}`).setLabel(`🗑️ Delete ${boss.name}`).setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('back_to_options').setLabel('← Back').setStyle(ButtonStyle.Secondary),
        )],
      });
      return;
    }

    // ── Buttons ─────────────────────────────────────────────────
    if (interaction.isButton()) {
      const id = interaction.customId;

      // Boss options
      if (id === 'back_to_options') {
        await interaction.update({ embeds: [buildOptionsEmbed()], components: buildOptionsComponents() });
        return;
      }

      if (id === 'add_boss') {
        await interaction.showModal(new ModalBuilder().setCustomId('modal_add_boss').setTitle('Add New Boss').addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('boss_name').setLabel('Boss Name').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('spawn_hours').setLabel('Spawn Time (hours)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 17')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('window_hours').setLabel('Window Duration (hours)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 4')),
        ));
        return;
      }

      if (id.startsWith('edit_boss|')) {
        const boss = findBoss(id.split('|')[1]);
        await interaction.showModal(new ModalBuilder().setCustomId(`modal_edit_boss|${boss.name}`).setTitle(`Edit ${boss.name}`).addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('boss_name').setLabel('Boss Name').setStyle(TextInputStyle.Short).setRequired(true).setValue(boss.name)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('spawn_hours').setLabel('Spawn Time (hours)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(boss.spawnHours))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('window_hours').setLabel('Window Duration (hours)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(boss.windowHours))),
        ));
        return;
      }

      if (id.startsWith('delete_boss|')) {
        const bossName = id.split('|')[1];
        const index = BOSSES.findIndex(b => b.name === bossName);
        if (index !== -1) { BOSSES.splice(index, 1); saveBosses(); }
        await interaction.update({ content: `✅ **${bossName}** deleted.`, embeds: [buildOptionsEmbed()], components: buildOptionsComponents() });
        return;
      }

      // Absence buttons
      const today = todayString();

      if (id === 'type_day' || id === 'retry_day') {
        await interaction.showModal(new ModalBuilder().setCustomId('modal_day').setTitle('📅 Report Day Off').addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel('Date (MM/DD)').setStyle(TextInputStyle.Short).setValue(today).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Short).setPlaceholder('e.g. Doctor appointment, sick...').setRequired(false)),
        ));
        return;
      }

      if (id === 'type_period' || id === 'retry_period') {
        await interaction.showModal(new ModalBuilder().setCustomId('modal_period').setTitle('📆 Report Absence Period').addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('start_date').setLabel('Start Date (MM/DD)').setStyle(TextInputStyle.Short).setValue(today).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('end_date').setLabel('End Date (MM/DD)').setStyle(TextInputStyle.Short).setPlaceholder('e.g. 04/05').setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Short).setPlaceholder('e.g. Vacation, sick leave...').setRequired(false)),
        ));
        return;
      }
    }

    // ── Modals ──────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {

      // Add boss
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

      // Edit boss
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
        if (boss) { boss.name = newName; boss.spawnHours = spawnHours; boss.windowHours = windowHours; saveBosses(); }
        await interaction.reply({ content: `✅ **${oldName}** updated to **${newName}** (${spawnHours}h spawn, ${windowHours}h window)`, flags: MessageFlags.Ephemeral });
        return;
      }

      // Day off
      if (interaction.customId === 'modal_day') {
        const dateStr = interaction.fields.getTextInputValue('date');
        const reason  = interaction.fields.getTextInputValue('reason').trim() || null;
        const date    = parseDate(dateStr);

        if (!date) {
          await interaction.reply({ content: '❌ Invalid date. Use MM/DD (e.g. 03/28).', flags: MessageFlags.Ephemeral });
          return;
        }
        if (isPast(date)) {
          await interaction.reply({
            content: '❌ Date cannot be in the past.',
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('retry_day').setLabel('✏️ Edit Again').setStyle(ButtonStyle.Primary),
            )],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        absences.push({ id: Date.now().toString(), userId: interaction.user.id, username: interaction.member?.displayName || interaction.user.username, type: 'day', date: toISO(date), reason, timestamp: new Date().toISOString() });
        saveAbsences();

        await interaction.channel.send({
          embeds: [new EmbedBuilder()
            .setColor(0x5865F2).setTitle('📅 Day Off Reported')
            .addFields(
              { name: 'Who',  value: `${interaction.user}`,         inline: true },
              { name: 'Date', value: formatAbsenceDate(toISO(date)), inline: true },
              ...(reason ? [{ name: 'Reason', value: reason, inline: false }] : []),
            )
            .setFooter({ text: "Melon's Bot" }).setTimestamp()
          ],
        });
        await interaction.update({ content: '✅ Absence posted!', embeds: [], components: [] });
        return;
      }

      // Period
      if (interaction.customId === 'modal_period') {
        const startStr  = interaction.fields.getTextInputValue('start_date');
        const endStr    = interaction.fields.getTextInputValue('end_date');
        const reason    = interaction.fields.getTextInputValue('reason').trim() || null;
        const startDate = parseDate(startStr);
        const endDate   = parseDate(endStr);

        if (!startDate) {
          await interaction.reply({ content: '❌ Invalid start date. Use MM/DD (e.g. 03/28).', flags: MessageFlags.Ephemeral });
          return;
        }
        if (isPast(startDate)) {
          await interaction.reply({
            content: '❌ Start date cannot be in the past.',
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('retry_period').setLabel('✏️ Edit Again').setStyle(ButtonStyle.Primary),
            )],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (!endDate) {
          await interaction.reply({ content: '❌ Invalid end date. Use MM/DD (e.g. 04/05).', flags: MessageFlags.Ephemeral });
          return;
        }
        if (endDate < startDate) {
          await interaction.reply({ content: '❌ End date must be after start date.', flags: MessageFlags.Ephemeral });
          return;
        }

        absences.push({ id: Date.now().toString(), userId: interaction.user.id, username: interaction.member?.displayName || interaction.user.username, type: 'period', startDate: toISO(startDate), endDate: toISO(endDate), reason, timestamp: new Date().toISOString() });
        saveAbsences();

        await interaction.channel.send({
          embeds: [new EmbedBuilder()
            .setColor(0xFFA500).setTitle('📆 Absence Period Reported')
            .addFields(
              { name: 'Who',  value: `${interaction.user}`,                  inline: false },
              { name: 'From', value: formatAbsenceDate(toISO(startDate)),    inline: true  },
              { name: 'To',   value: formatAbsenceDate(toISO(endDate)),      inline: true  },
              ...(reason ? [{ name: 'Reason', value: reason, inline: false }] : []),
            )
            .setFooter({ text: "Melon's Bot" }).setTimestamp()
          ],
        });
        await interaction.update({ content: '✅ Absence posted!', embeds: [], components: [] });
        return;
      }
    }

  } catch (err) {
    console.error('Interaction error:', err);
    try {
      const msg = { content: '❌ Something went wrong.', flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
      else await interaction.reply(msg);
    } catch (_) {}
  }
});

client.login(process.env.TOKEN);
