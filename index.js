require('dotenv').config();
const fs = require('fs');
const path = require('path');
const music = require('./music');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActivityType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags, REST, Routes, SlashCommandBuilder,
} = require('discord.js');

// ── Boss data ─────────────────────────────────────────────────
const BOSSES_FILE = path.join(__dirname, 'bosses.json');
const BOSSES_DEFAULT = path.join(__dirname, 'bosses.default.json');
if (!fs.existsSync(BOSSES_FILE)) fs.copyFileSync(BOSSES_DEFAULT, BOSSES_FILE);
let BOSSES;
try { BOSSES = JSON.parse(fs.readFileSync(BOSSES_FILE, 'utf8')); }
catch { console.error('[Bot] bosses.json corrupted — restoring from default'); fs.copyFileSync(BOSSES_DEFAULT, BOSSES_FILE); BOSSES = JSON.parse(fs.readFileSync(BOSSES_FILE, 'utf8')); }

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

// ── Pending announcements (setup state per user) ──────────────
const pendingAnnouncements = new Map();
const waitingForImage     = new Map(); // userId → { channelId, setupInteraction }
// key: userId, value: { showResponses, tagEveryone, roleIds: string[], responsesByRole: bool }

const pendingRetry = new Map();
// key: userId, value: { text, dateStr } — stored when modal has a date error

function buildAnnounceSetupEmbed(state) {
  const roles = (state.roleIds ?? []);
  const embed = new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('📢 New Announcement')
    .setDescription('Toggle options below, then click **✏️ Write Announcement**.')
    .addFields({ name: 'Tag Roles', value: roles.length ? roles.map(id => `<@&${id}>`).join(' ') : '*None*', inline: true });
  // attachment:// URLs only work when the file is sent — skip thumbnail in setup preview
  return embed;
}

function buildAnnounceSetupComponents(state) {
  const roleCount = (state.roleIds ?? []).length;
  const row1 = [];

  // Responses and Role Responses are mutually exclusive:
  // show Role Responses (if ≥2 roles) right next to Responses; hide Responses when Role Responses is ON
  if (!state.responsesByRole) {
    row1.push(
      new ButtonBuilder()
        .setCustomId('ann_toggle_responses')
        .setLabel(`📋 Responses: ${state.showResponses ? 'ON ✅' : 'OFF ❌'}`)
        .setStyle(state.showResponses ? ButtonStyle.Success : ButtonStyle.Secondary),
    );
  }
  if (roleCount >= 2) {
    row1.push(
      new ButtonBuilder()
        .setCustomId('ann_toggle_role_responses')
        .setLabel(`🎭 Role Responses: ${state.responsesByRole ? 'ON ✅' : 'OFF ❌'}`)
        .setStyle(state.responsesByRole ? ButtonStyle.Success : ButtonStyle.Secondary),
    );
  }
  row1.push(
    new ButtonBuilder()
      .setCustomId('ann_toggle_everyone')
      .setLabel(`👥 @everyone: ${state.tagEveryone ? 'ON ✅' : 'OFF ❌'}`)
      .setStyle(state.tagEveryone ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ann_roles_screen')
      .setLabel(roleCount ? `🏷️ Roles (${roleCount})` : '🏷️ Add Roles')
      .setStyle(roleCount ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
  return [
    new ActionRowBuilder().addComponents(...row1),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ann_add_image')
        .setLabel(state.imageUrl ? '🖼️ Image ✅' : '🖼️ Add Image')
        .setStyle(state.imageUrl ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('ann_continue')
        .setLabel('✏️ Write Announcement')
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

function buildRoleToggleComponents(state, allRoles) {
  // allRoles = [{id, name}] sorted by position desc, @everyone excluded
  const selected = new Set(state.roleIds ?? []);
  const rows = [];

  // Up to 4 rows of 5 toggle buttons (max 20 roles)
  for (let i = 0; i < Math.min(allRoles.length, 20); i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      ...allRoles.slice(i, i + 5).map(r =>
        new ButtonBuilder()
          .setCustomId(`ann_toggle_role|${r.id}`)
          .setLabel(r.name.slice(0, 80))
          .setStyle(selected.has(r.id) ? ButtonStyle.Success : ButtonStyle.Danger)
      )
    ));
  }

  // Accept/Back on last row
  rows.push(new ActionRowBuilder().addComponents(
    selected.size > 0
      ? new ButtonBuilder().setCustomId('ann_roles_confirm').setLabel('✅ Accept').setStyle(ButtonStyle.Success)
      : new ButtonBuilder().setCustomId('ann_roles_back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
  ));

  return rows;
}

// ── Ephemeral reply + auto-delete helper ─────────────────────
function autoDelete(interaction, secs = 300) {
  setTimeout(async () => {
    try {
      await interaction.deleteReply();
    } catch (_) {
      // deletion failed — at least clear content and buttons so it's visually gone
      try { await interaction.editReply({ content: '\u200B', embeds: [], components: [] }); } catch (__) {}
    }
  }, secs * 1000);
}
async function replyEph(interaction, payload, secs = 300) {
  await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  autoDelete(interaction, secs);
}

// ── Announcement data ─────────────────────────────────────────
const ANNOUNCEMENTS_FILE = path.join(__dirname, 'announcements.json');
let announcements = fs.existsSync(ANNOUNCEMENTS_FILE)
  ? JSON.parse(fs.readFileSync(ANNOUNCEMENTS_FILE, 'utf8'))
  : {};

function saveAnnouncements() {
  fs.writeFileSync(ANNOUNCEMENTS_FILE, JSON.stringify(announcements, null, 2));
}

// Times entered by users are always treated as Europe/Vilnius (Lithuania) time.
const BOT_TIMEZONE = 'Europe/Vilnius';

// Convert a calendar date/time in BOT_TIMEZONE to a UTC Date object.
function zonedToUtc(year, month, day, hours, mins, tz) {
  // Build a naive UTC date using the given numbers, then measure how far off
  // the target timezone is at that moment, and correct for it.
  const naive = new Date(Date.UTC(year, month, day, hours, mins));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(naive).reduce((acc, p) => { if (p.type !== 'literal') acc[p.type] = parseInt(p.value); return acc; }, {});
  const tzH = parts.hour === 24 ? 0 : parts.hour;
  const tzAsUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, tzH, parts.minute));
  return new Date(naive.getTime() + (naive.getTime() - tzAsUtc.getTime()));
}

function parseDateTime(str) {
  const tz = BOT_TIMEZONE;
  if (!str) return null;
  const s = str.trim();

  // Split off optional time at the end: space + HH:MM or HHMM (24h)
  const timeMatch = s.match(/^(.*?)\s+(\d{1,2}):?(\d{2})$/);
  let hours = 0, mins = 0, datePart = s;
  if (timeMatch) {
    hours    = parseInt(timeMatch[2]);
    mins     = parseInt(timeMatch[3]);
    datePart = timeMatch[1].trim();
    if (hours > 23 || mins > 59) return null;
  }

  let year, month, day;
  const now = new Date();

  // 3-part date: YYYY/MM/DD or YY/MM/DD  (separators / - .)
  const m3 = datePart.match(/^(\d{2,4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
  if (m3) {
    let y = parseInt(m3[1]);
    if (y < 100) y += 2000;   // YY → 20YY
    year  = y;
    month = parseInt(m3[2]) - 1;
    day   = parseInt(m3[3]);
  } else {
    // 2-part date: MM/DD  (use current year)
    const m2 = datePart.match(/^(\d{1,2})[\/\-\.](\d{1,2})$/);
    if (!m2) return null;
    year  = now.getFullYear();
    month = parseInt(m2[1]) - 1;
    day   = parseInt(m2[2]);
  }

  const d = zonedToUtc(year, month, day, hours, mins, tz);
  // Validate by checking the date in the given timezone
  const check = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, month: 'numeric', day: 'numeric',
  }).formatToParts(d).reduce((acc, p) => { if (p.type !== 'literal') acc[p.type] = parseInt(p.value); return acc; }, {});
  if (check.month - 1 !== month || check.day !== day) return null;
  return d;
}

function buildAnnouncementEmbeds(data) {
  let accepts, denies, unknowns;

  if (data.responsesByRole && data.userRoles) {
    const buckets = { accept: new Set(), deny: new Set(), unknown: new Set() };
    for (const [uid, vote] of Object.entries(data.responses)) {
      for (const rid of (data.userRoles[uid] ?? [])) buckets[vote].add(rid);
    }
    accepts  = [...buckets.accept] .map(id => `<@&${id}>`);
    denies   = [...buckets.deny]   .map(id => `<@&${id}>`);
    unknowns = [...buckets.unknown].map(id => `<@&${id}>`);
  } else {
    accepts  = Object.entries(data.responses).filter(([,v]) => v === 'accept') .map(([uid]) => `<@${uid}>`);
    denies   = Object.entries(data.responses).filter(([,v]) => v === 'deny')   .map(([uid]) => `<@${uid}>`);
    unknowns = Object.entries(data.responses).filter(([,v]) => v === 'unknown').map(([uid]) => `<@${uid}>`);
  }

  const hasDate      = !!data.date;
  const hasResponses = !!data.showResponses;
  const hasExtra     = hasDate || hasResponses;

  // Embed 1: title + text + image (image always at bottom of this embed)
  const embed1 = new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('📢 Announcement')
    .setDescription(data.text);
  if (data.imageUrl) embed1.setImage(data.imageUrl);

  if (!hasExtra) {
    embed1.setFooter({ text: `Posted by ${data.authorName}` }).setTimestamp(new Date(data.timestamp));
    return [embed1];
  }

  // Embed 2: date + responses (visually appears below the image)
  const embed2 = new EmbedBuilder()
    .setColor(0xF1C40F)
    .setFooter({ text: `Posted by ${data.authorName}` })
    .setTimestamp(new Date(data.timestamp));

  if (hasDate) {
    embed2.addFields({ name: '📅 Date & Time', value: data.date, inline: false });
  }
  if (hasResponses) {
    if (hasDate) embed2.addFields({ name: '\u200B', value: '\u200B', inline: false });
    embed2.addFields(
      { name: `✅ Accept (${accepts.length})`,      value: accepts.length  ? accepts.join('\n') : '*—*', inline: true },
      { name: `❌ Deny (${denies.length})`,          value: denies.length   ? denies.join('\n') : '*—*', inline: true },
      { name: `❓ Don't Know (${unknowns.length})`, value: unknowns.length ? unknowns.join('\n'): '*—*', inline: true },
    );
  }

  return [embed1, embed2];
}

function buildAnnouncementButtons() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ann_accept') .setLabel('✅ Accept')     .setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ann_deny')   .setLabel('❌ Deny')       .setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ann_unknown').setLabel("❓ Don't Know") .setStyle(ButtonStyle.Secondary),
  )];
}

const EPIC_ITEMS = [
  { name: 'Queen Ant Ring',      value: 'QUEEN ANT RING'      },
  { name: 'Core Ring',           value: 'CORE RING'           },
  { name: 'Orfen Ring',          value: 'ORFEN RING'          },
  { name: 'Baium Ring',          value: 'BAIUM RING'          },
  { name: 'Antharas Earring',    value: 'ANTHARAS EARRING'    },
  { name: 'Valakas Necklace',    value: 'VALAKAS NECKLACE'    },
  { name: 'Fraya Necklace',      value: 'FRAYA NECKLACE'      },
  { name: 'Frintezza Necklace',  value: 'FRINTEZZA NECKLACE'  },
];

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

  new SlashCommandBuilder().setName('announce').setDescription('Post an announcement').toJSON(),

  new SlashCommandBuilder().setName('play').setDescription('Search and add a song to the queue')
    .addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true))
    .toJSON(),
  new SlashCommandBuilder().setName('stop').setDescription('Stop music and disconnect from voice').toJSON(),
  new SlashCommandBuilder().setName('radio').setDescription('Play a live radio station')
    .addStringOption(o => o.setName('station').setDescription('Radio station name').setRequired(true).setAutocomplete(true))
    .toJSON(),
  new SlashCommandBuilder().setName('provider').setDescription('Set the music provider for this server')
    .addStringOption(o => o.setName('source').setDescription('Music provider').setRequired(true)
      .addChoices(
        { name: 'YouTube', value: 'youtube' },
        { name: 'SoundCloud', value: 'soundcloud' },
      ))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('gratz')
    .setDescription('Congratulate a player on an epic drop')
    .addRoleOption(o => o.setName('player').setDescription('Select the role/player to congratulate').setRequired(true))
    .addStringOption(o => o.setName('item').setDescription('Epic item').setRequired(true)
      .addChoices(...EPIC_ITEMS))
    .toJSON(),
];

// ── Bot ───────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates] });

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
      if (interaction.commandName === 'radio') { await music.handleRadio(interaction); return; }
      const focused = interaction.options.getFocused().toLowerCase();
      const choices = BOSSES
        .filter(b => b.name.toLowerCase().includes(focused))
        .slice(0, 25)
        .map(b => ({ name: b.name, value: b.name }));
      await interaction.respond(choices).catch(() => {});
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
          await replyEph(interaction, { content: `❌ Boss **${bossName}** not found. Use \`/bosses\` to see the list.` });
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

      // ── /play ──
      if (interaction.commandName === 'play') { await music.handlePlay(interaction); return; }

      // ── /stop ──
      if (interaction.commandName === 'stop') { await music.handleStop(interaction); return; }

      // ── /radio ──
      if (interaction.commandName === 'radio') { await music.handleRadio(interaction); return; }


      // ── /announce ──
      if (interaction.commandName === 'announce') {
        const state = { showResponses: false, tagEveryone: false, roleIds: [], roleNames: {}, responsesByRole: false, imageUrl: null };
        pendingAnnouncements.set(interaction.user.id, state);
        await replyEph(interaction, { embeds: [buildAnnounceSetupEmbed(state)], components: buildAnnounceSetupComponents(state) });
        return;
      }


      // ── /gratz ──
      if (interaction.commandName === 'gratz') {
        const player = interaction.options.getRole('player');
        const item   = interaction.options.getString('item');
        await interaction.reply(`🎉 **GRATZ ${player} WITH ${item}!** 🎉`);
        return;
      }

      // ── /todoptions ──
      if (interaction.commandName === 'todoptions') {
        await replyEph(interaction, { embeds: [buildOptionsEmbed()], components: buildOptionsComponents() });
        return;
      }

      // ── /out ──
      if (interaction.commandName === 'out') {
        if (!isAbsenceChannel(interaction)) {
          await replyEph(interaction, { content: '❌ This command can only be used in an absences channel.' });
          return;
        }
        await replyEph(interaction, {
          embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('Report Absence').setDescription('Choose absence type:')],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('type_day').setLabel('📅 Day Off').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('type_period').setLabel('📆 Period').setStyle(ButtonStyle.Secondary),
          )],
        });
        return;
      }

      // ── /absences ──
      if (interaction.commandName === 'absences') {
        if (!isAbsenceChannel(interaction)) {
          await replyEph(interaction, { content: '❌ This command can only be used in an absences channel.' });
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
          await replyEph(interaction, { content: '✅ No upcoming absences.' });
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
    if (interaction.isStringSelectMenu() && interaction.customId === 'music_search_select') {
      await music.handleSearchSelect(interaction); return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'music_queue_select') {
      await music.handleQueueSelect(interaction); return;
    }

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

      // Music buttons
      if (id.startsWith('music_') || id === 'radio_stop') { await music.handleButton(interaction); return; }


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

      // Announce setup toggles
      if (id === 'ann_toggle_responses' || id === 'ann_toggle_everyone' || id === 'ann_toggle_role_responses') {
        waitingForImage.delete(interaction.user.id);
        const state = pendingAnnouncements.get(interaction.user.id);
        if (!state) { await interaction.update({ content: '⚠️ Session expired. Please run `/announce` again.', embeds: [], components: [] }); return; }
        if (id === 'ann_toggle_responses')      state.showResponses   = !state.showResponses;
        if (id === 'ann_toggle_everyone')       state.tagEveryone     = !state.tagEveryone;
        if (id === 'ann_toggle_role_responses') {
          state.responsesByRole = !state.responsesByRole;
          // Role Responses and Responses are mutually exclusive
          if (state.responsesByRole) state.showResponses = false;
        }
        await interaction.update({ embeds: [buildAnnounceSetupEmbed(state)], components: buildAnnounceSetupComponents(state) });
        return;
      }

      if (id === 'ann_roles_screen') {
        const state = pendingAnnouncements.get(interaction.user.id);
        if (!state) { await interaction.update({ content: '⚠️ Session expired. Please run `/announce` again.', embeds: [], components: [] }); return; }
        const allRoles = [...interaction.guild.roles.cache.values()]
          .filter(r => r.id !== interaction.guild.id)
          .sort((a, b) => b.position - a.position);
        const roleList = (state.roleIds ?? []).length ? state.roleIds.map(r => `<@&${r}>`).join(' ') : '*None yet*';
        await interaction.update({
          embeds: [new EmbedBuilder().setColor(0xF1C40F).setTitle('🏷️ Select Roles').setDescription(`**Selected:** ${roleList}\n\nClick a role to toggle it. Green = added, Red = not added.`)],
          components: buildRoleToggleComponents(state, allRoles),
        });
        return;
      }

      if (id.startsWith('ann_toggle_role|')) {
        const roleId = id.split('|')[1];
        const state  = pendingAnnouncements.get(interaction.user.id);
        if (!state) { await interaction.update({ content: '⚠️ Session expired. Please run `/announce` again.', embeds: [], components: [] }); return; }
        if (state.roleIds.includes(roleId)) {
          state.roleIds = state.roleIds.filter(r => r !== roleId);
          delete state.roleNames[roleId];
        } else {
          state.roleIds.push(roleId);
          const role = interaction.guild.roles.cache.get(roleId);
          if (role) state.roleNames[roleId] = role.name;
        }
        const allRoles = [...interaction.guild.roles.cache.values()]
          .filter(r => r.id !== interaction.guild.id)
          .sort((a, b) => b.position - a.position);
        const roleList = state.roleIds.length ? state.roleIds.map(r => `<@&${r}>`).join(' ') : '*None yet*';
        await interaction.update({
          embeds: [new EmbedBuilder().setColor(0xF1C40F).setTitle('🏷️ Select Roles').setDescription(`**Selected:** ${roleList}\n\nClick a role to toggle it. Green = added, Red = not added.`)],
          components: buildRoleToggleComponents(state, allRoles),
        });
        return;
      }

      if (id === 'ann_roles_back' || id === 'ann_roles_confirm') {
        const state = pendingAnnouncements.get(interaction.user.id);
        if (!state) { await interaction.update({ content: '⚠️ Session expired. Please run `/announce` again.', embeds: [], components: [] }); return; }
        await interaction.update({ embeds: [buildAnnounceSetupEmbed(state)], components: buildAnnounceSetupComponents(state) });
        return;
      }

      if (id === 'ann_retry') {
        const retry = pendingRetry.get(interaction.user.id);
        await interaction.showModal(
          new ModalBuilder().setCustomId('modal_announce').setTitle('📢 Write Announcement').addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('text').setLabel('Announcement text').setStyle(TextInputStyle.Paragraph).setRequired(true)
                .setValue(retry?.text ?? ''),
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('date').setLabel('Date & Time — optional').setStyle(TextInputStyle.Short).setRequired(false)
                .setValue(retry?.dateStr ?? '').setPlaceholder('e.g. 04/01  or  26/04/01  or  2026.04.01 2100'),
            ),
          )
        );
        return;
      }

      if (id === 'ann_add_image') {
        const state = pendingAnnouncements.get(interaction.user.id);
        if (!state) { await interaction.update({ content: '⚠️ Session expired. Please run `/announce` again.', embeds: [], components: [] }); return; }
        waitingForImage.set(interaction.user.id, { channelId: interaction.channelId, setupInteraction: interaction });
        await interaction.update({
          embeds: [new EmbedBuilder().setColor(0xF1C40F).setTitle('🖼️ Upload Image')
            .setDescription('**Drop or paste your image in this channel now.**\nThe bot will capture it automatically and return to the setup screen.\n\n*Send any other message or wait 2 minutes to cancel.*')],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ann_cancel_image').setLabel('✖ Cancel').setStyle(ButtonStyle.Danger),
          )],
        });
        // Auto-cancel after 2 minutes if no image received
        setTimeout(() => {
          if (waitingForImage.has(interaction.user.id)) {
            waitingForImage.delete(interaction.user.id);
            interaction.editReply({ embeds: [buildAnnounceSetupEmbed(state)], components: buildAnnounceSetupComponents(state) }).catch(() => {});
          }
        }, 2 * 60 * 1000);
        return;
      }

      if (id === 'ann_cancel_image') {
        const state = pendingAnnouncements.get(interaction.user.id);
        waitingForImage.delete(interaction.user.id);
        if (!state) { await interaction.update({ content: '⚠️ Session expired. Please run `/announce` again.', embeds: [], components: [] }); return; }
        await interaction.update({ embeds: [buildAnnounceSetupEmbed(state)], components: buildAnnounceSetupComponents(state) });
        return;
      }

      if (id === 'ann_continue') {
        const state = pendingAnnouncements.get(interaction.user.id);
        if (!state) { await interaction.update({ content: '⚠️ Session expired. Please run `/announce` again.', embeds: [], components: [] }); return; }
        await interaction.showModal(
          new ModalBuilder().setCustomId('modal_announce').setTitle('📢 Write Announcement').addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('text').setLabel('Announcement text').setStyle(TextInputStyle.Paragraph).setRequired(true),
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('date').setLabel('Date & Time — optional').setStyle(TextInputStyle.Short).setRequired(false)
                .setPlaceholder('e.g. 04/01  or  26/04/01  or  2026.04.01 2100'),
            ),
          )
        );
        return;
      }

      // Announcement response buttons
      if (id === 'ann_accept' || id === 'ann_deny' || id === 'ann_unknown') {
        const msgId = interaction.message.id;
        const data  = announcements[msgId];
        if (!data) { await replyEph(interaction, { content: '❌ Announcement data not found.' }); return; }

        const vote = id === 'ann_accept' ? 'accept' : id === 'ann_deny' ? 'deny' : 'unknown';
        const uid  = interaction.user.id;

        if (data.responses[uid] === vote) {
          delete data.responses[uid];
          if (data.responsesByRole) delete data.userRoles[uid];
        } else {
          data.responses[uid] = vote;
          if (data.responsesByRole) {
            const memberRoles = new Set(interaction.member.roles.cache.keys());
            data.userRoles[uid] = (data.roleIds ?? []).filter(rid => memberRoles.has(rid));
          }
        }

        saveAnnouncements();
        await interaction.update({ embeds: buildAnnouncementEmbeds(data), components: buildAnnouncementButtons() });
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

      // Announce
      if (interaction.customId === 'modal_announce') {
        const state = pendingAnnouncements.get(interaction.user.id);
        if (!state) { await replyEph(interaction, { content: '⚠️ Session expired. Please run `/announce` again.' }); return; }

        const text     = interaction.fields.getTextInputValue('text');
        const dateStr  = interaction.fields.getTextInputValue('date').trim();
        const imageUrl = state.imageUrl || null;

        let dateDisplay = null;
        if (dateStr) {
          const parsedDate = parseDateTime(dateStr);
          if (!parsedDate) {
            pendingRetry.set(interaction.user.id, { text, dateStr, imageUrl });
            await replyEph(interaction, {
              content: '❌ Invalid date. Accepted formats (separators `/` `-` `.` all work):\n`MM/DD` · `YY/MM/DD` · `YYYY/MM/DD`\nOptionally add time: `HH:MM` or `HHMM` (24h)\nExamples: `04/01`, `26/04/01`, `2026/04/01`, `2026-04-01 21:00`, `04.01 2100`',
              components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('ann_retry').setLabel('✏️ Edit Again').setStyle(ButtonStyle.Primary),
              )],
            });
            return;
          }
          dateDisplay = `<t:${Math.floor(parsedDate.getTime() / 1000)}:F>`;
        }

        pendingAnnouncements.delete(interaction.user.id);
        pendingRetry.delete(interaction.user.id);

        const mentions = state.tagEveryone
          ? '@everyone'
          : (state.roleIds ?? []).map(id => `<@&${id}>`).join(' ');

        const data = {
          text,
          date: dateDisplay,
          imageUrl: imageUrl || null,
          authorName: interaction.member?.displayName || interaction.user.username,
          showResponses: state.showResponses || state.responsesByRole,
          responsesByRole: state.responsesByRole ?? false,
          roleIds: state.roleIds ?? [],
          mentions: mentions || '',
          responses: {},
          userRoles: {},
          timestamp: new Date().toISOString(),
        };

        await interaction.deferUpdate();

        const files = state.imageBuffer
          ? [new AttachmentBuilder(state.imageBuffer, { name: state.imageFileName })]
          : [];
        const msg = await interaction.channel.send({
          content: data.mentions || undefined,
          embeds: buildAnnouncementEmbeds(data),
          components: (state.showResponses || state.responsesByRole) ? buildAnnouncementButtons() : [],
          files,
        });

        try { await interaction.deleteReply(); } catch (_) {} // already gone if autoDelete fired first

        announcements[msg.id] = data;
        saveAnnouncements();
        return;
      }

      // Add boss
      if (interaction.customId === 'modal_add_boss') {
        const name        = interaction.fields.getTextInputValue('boss_name').trim();
        const spawnHours  = parseInt(interaction.fields.getTextInputValue('spawn_hours'));
        const windowHours = parseInt(interaction.fields.getTextInputValue('window_hours'));
        if (isNaN(spawnHours) || isNaN(windowHours)) {
          await replyEph(interaction, { content: '❌ Spawn time and window must be numbers.' });
          return;
        }
        BOSSES.push({ name, spawnHours, windowHours });
        saveBosses();
        await replyEph(interaction, { content: `✅ **${name}** added! (${spawnHours}h spawn, ${windowHours}h window)` });
        return;
      }

      // Edit boss
      if (interaction.customId.startsWith('modal_edit_boss|')) {
        const oldName     = interaction.customId.split('|')[1];
        const newName     = interaction.fields.getTextInputValue('boss_name').trim();
        const spawnHours  = parseInt(interaction.fields.getTextInputValue('spawn_hours'));
        const windowHours = parseInt(interaction.fields.getTextInputValue('window_hours'));
        if (isNaN(spawnHours) || isNaN(windowHours)) {
          await replyEph(interaction, { content: '❌ Spawn time and window must be numbers.' });
          return;
        }
        const boss = BOSSES.find(b => b.name === oldName);
        if (boss) { boss.name = newName; boss.spawnHours = spawnHours; boss.windowHours = windowHours; saveBosses(); }
        await replyEph(interaction, { content: `✅ **${oldName}** updated to **${newName}** (${spawnHours}h spawn, ${windowHours}h window)` });
        return;
      }

      // Day off
      if (interaction.customId === 'modal_day') {
        const dateStr = interaction.fields.getTextInputValue('date');
        const reason  = interaction.fields.getTextInputValue('reason').trim() || null;
        const date    = parseDate(dateStr);

        if (!date) {
          await replyEph(interaction, { content: '❌ Invalid date. Use MM/DD (e.g. 03/28).' });
          return;
        }
        if (isPast(date)) {
          await replyEph(interaction, {
            content: '❌ Date cannot be in the past.',
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('retry_day').setLabel('✏️ Edit Again').setStyle(ButtonStyle.Primary),
            )],
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
          await replyEph(interaction, { content: '❌ Invalid start date. Use MM/DD (e.g. 03/28).' });
          return;
        }
        if (isPast(startDate)) {
          await replyEph(interaction, {
            content: '❌ Start date cannot be in the past.',
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('retry_period').setLabel('✏️ Edit Again').setStyle(ButtonStyle.Primary),
            )],
          });
          return;
        }
        if (!endDate) {
          await replyEph(interaction, { content: '❌ Invalid end date. Use MM/DD (e.g. 04/05).' });
          return;
        }
        if (endDate < startDate) {
          await replyEph(interaction, { content: '❌ End date must be after start date.' });
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
    if (err.code === 10062) return; // interaction expired before bot could respond — nothing to do
    if (err.code === 50001) {
      console.error(`Missing Access: bot lacks Send Messages permission in channel ${interaction.channelId}`);
      try {
        const msg = { content: '❌ The bot is missing "Send Messages" permission in this channel.', flags: MessageFlags.Ephemeral };
        if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
        else { await interaction.reply(msg); autoDelete(interaction); }
      } catch (_) {}
      return;
    }
    console.error('Interaction error:', err);
    try {
      const errPayload = { content: '❌ Something went wrong.', flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(errPayload);
      else { await interaction.reply(errPayload); autoDelete(interaction); }
    } catch (_) {}
  }
});

// ── Image upload listener ──────────────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const waiting = waitingForImage.get(message.author.id);
  if (!waiting) return;
  if (message.channelId !== waiting.channelId) return;

  const attachment = message.attachments.find(a =>
    a.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.name ?? '')
  );
  if (!attachment) {
    // Non-image message cancels the wait
    waitingForImage.delete(message.author.id);
    const state = pendingAnnouncements.get(message.author.id);
    if (state) waiting.setupInteraction.editReply({ embeds: [buildAnnounceSetupEmbed(state)], components: buildAnnounceSetupComponents(state) }).catch(() => {});
    return;
  }

  waitingForImage.delete(message.author.id);
  const state = pendingAnnouncements.get(message.author.id);
  if (!state) return;

  try {
    const res    = await fetch(attachment.url);
    const buffer = Buffer.from(await res.arrayBuffer());
    state.imageBuffer   = buffer;
    state.imageFileName = attachment.name ?? 'image.png';
    state.imageUrl      = `attachment://${state.imageFileName}`;
  } catch (_) {}

  try { await message.delete(); } catch (_) {}

  waiting.setupInteraction.editReply({ embeds: [buildAnnounceSetupEmbed(state)], components: buildAnnounceSetupComponents(state) }).catch(() => {});
});

// ── Auto-leave when voice channel empties ─────────────────────
client.on('voiceStateUpdate', (oldState, newState) => {
  music.handleVoiceStateUpdate(oldState, newState).catch(() => {});
});

client.login(process.env.TOKEN);
