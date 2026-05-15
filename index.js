require('dotenv').config();
const fs = require('fs');
const path = require('path');

// ── Async write queue — one file write at a time, no overlaps ──
let _writeQueue = Promise.resolve();
function saveFile(filePath, data) {
  _writeQueue = _writeQueue.then(() =>
    fs.promises.writeFile(filePath, JSON.stringify(data, null, 2))
  ).catch(err => console.error(`[saveFile] Failed to write ${filePath}:`, err));
}
const music = require('./music');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActivityType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags, REST, Routes, SlashCommandBuilder,
} = require('discord.js');

// ── Boss data (per-guild) ─────────────────────────────────────
const BOSSES_FILE = path.join(__dirname, 'bosses.json');
const BOSSES_DEFAULT = path.join(__dirname, 'bosses.default.json');

let bossesByGuild = {};
let _legacyBosses = null; // set if bosses.json is old flat-array format

if (fs.existsSync(BOSSES_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(BOSSES_FILE, 'utf8'));
    if (Array.isArray(raw)) {
      _legacyBosses = raw;
      console.log('[Bosses] Legacy flat format detected — will migrate to per-guild on startup');
    } else {
      bossesByGuild = raw;
    }
  } catch { console.error('[Bot] bosses.json corrupted — will seed guilds from default'); }
}

function getDefaultBosses() {
  return JSON.parse(fs.readFileSync(BOSSES_DEFAULT, 'utf8'));
}

function getGuildBosses(guildId) {
  if (!bossesByGuild[guildId]) {
    bossesByGuild[guildId] = getDefaultBosses();
    saveBosses();
  }
  return bossesByGuild[guildId];
}

function saveBosses() { saveFile(BOSSES_FILE, bossesByGuild); }

function findBoss(guildId, name) {
  return getGuildBosses(guildId).find(b => b.name.toLowerCase() === name.toLowerCase());
}

// ── Absence data (per-guild) ───────────────────────────────────
const ABSENCES_FILE = path.join(__dirname, 'absences.json');
// Format: { [guildId]: [ ...entries ] }
let absencesDB = fs.existsSync(ABSENCES_FILE)
  ? (() => { const d = JSON.parse(fs.readFileSync(ABSENCES_FILE, 'utf8')); return Array.isArray(d) ? {} : d; })()
  : {};

function getAbsences(guildId) {
  if (!Array.isArray(absencesDB[guildId])) absencesDB[guildId] = [];
  return absencesDB[guildId];
}

function saveAbsences() { saveFile(ABSENCES_FILE, absencesDB); }

function purgePastAbsences() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let changed = false;
  for (const guildId of Object.keys(absencesDB)) {
    const before = absencesDB[guildId].length;
    absencesDB[guildId] = absencesDB[guildId].filter(a => isoToDate(a.type === 'day' ? a.date : a.endDate) >= today);
    if (absencesDB[guildId].length !== before) changed = true;
  }
  if (changed) saveAbsences();
}

// Purge on startup and daily at midnight
purgePastAbsences();
setInterval(purgePastAbsences, 24 * 60 * 60 * 1000);

// ── Boss alert data ───────────────────────────────────────────
const BOSS_ALERTS_FILE = path.join(__dirname, 'boss_alerts.json');
let bossAlerts = fs.existsSync(BOSS_ALERTS_FILE) ? JSON.parse(fs.readFileSync(BOSS_ALERTS_FILE, 'utf8')) : {};
function saveBossAlerts() { saveFile(BOSS_ALERTS_FILE, bossAlerts); }
const alertTimers      = new Map();
const closeAlertTimers = new Map();

// ── Drop history (per-guild, per-boss kill/drop stats) ────────
const DROP_HISTORY_FILE = path.join(__dirname, 'drop_history.json');
let dropHistory = fs.existsSync(DROP_HISTORY_FILE) ? JSON.parse(fs.readFileSync(DROP_HISTORY_FILE, 'utf8')) : {};
function saveDropHistory() { saveFile(DROP_HISTORY_FILE, dropHistory); }
function recordDrop(guildId, bossName, killedBy, dropped) {
  if (!dropHistory[guildId]) dropHistory[guildId] = {};
  if (!dropHistory[guildId][bossName]) dropHistory[guildId][bossName] = { allyKills: 0, enemyKills: 0, unknownKills: 0, drops: 0, noDrops: 0 };
  const s = dropHistory[guildId][bossName];
  if (killedBy === 'ally') s.allyKills++;
  else if (killedBy === 'enemy') s.enemyKills++;
  else s.unknownKills++;
  if (dropped) s.drops++; else s.noDrops++;
  saveDropHistory();
}

// ── Market listings (per-guild, per-message) ──────────────────
const LISTINGS_FILE = path.join(__dirname, 'listings.json');
let listings = fs.existsSync(LISTINGS_FILE) ? JSON.parse(fs.readFileSync(LISTINGS_FILE, 'utf8')) : {};
function saveListings() { saveFile(LISTINGS_FILE, listings); }
const listingTimers = new Map(); // key: "guildId:messageId" → { expiry, delete }

// ── TOD state (live window tracking, separate from alerts) ────
const TOD_STATE_FILE = path.join(__dirname, 'tod_state.json');
let todState = fs.existsSync(TOD_STATE_FILE) ? JSON.parse(fs.readFileSync(TOD_STATE_FILE, 'utf8')) : {};
function saveTodState() { saveFile(TOD_STATE_FILE, todState); }
function setTodState(guildId, bossName, data) {
  if (!todState[guildId]) todState[guildId] = {};
  todState[guildId][bossName] = data;
  saveTodState();
}
function getTodState(guildId, bossName) {
  return todState[guildId]?.[bossName] ?? null;
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
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const year = now.getFullYear();
  const m = str.trim().match(/^(\d{1,2})[\/\-\.](\d{1,2})$/);
  if (!m) return null;
  const month = parseInt(m[1]) - 1, day = parseInt(m[2]);
  let d = new Date(year, month, day);
  if (d.getMonth() !== month || d.getDate() !== day) return null;
  // If the date is in the past, assume the user meant next year
  if (d < now) d = new Date(year + 1, month, day);
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

function getMemberTimeDot(member) {
  if (!member) return '';
  let hasFull = false, hasPart = false;
  for (const role of member.roles.cache.values()) {
    const name = role.name.trim().toUpperCase();
    if (name.includes('FULL TIME')) hasFull = true;
    if (name.includes('PART TIME')) hasPart = true;
  }
  if (hasFull && !hasPart) return '🔵';
  if (hasPart && !hasFull) return '🟡';
  return '';
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

const pendingTodUndos  = new Map();
const pendingFortUndos = new Map(); // userId → { messageId, channelId }
const pendingShops     = new Map(); // userId → { interaction, timer }
const fortMessages    = new Map(); // msgId → { fort, action, timeDisplay, nextFortTs, userId, channelId, postedAt }
// key: userId, value: { messageId, channelId, guildId, bossName, alertKey }

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

function saveAnnouncements() { saveFile(ANNOUNCEMENTS_FILE, announcements); }

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
    embed2.addFields({ name: data.date?.includes(':F>') ? '📅 Date & Time' : '📅 Date', value: data.date, inline: false });
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
function buildOptionsEmbed(guildId) {
  const bosses = getGuildBosses(guildId);
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('Boss Options')
    .setDescription(bosses.map(b => `• **${b.name}** — spawn ${b.spawnHours}h | window ${b.windowHours}h`).join('\n'));
}

function buildOptionsComponents(guildId) {
  const bosses = getGuildBosses(guildId);
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('select_boss_edit')
    .setPlaceholder('Select a boss to edit or delete...')
    .addOptions(bosses.slice(0, 25).map(b => ({
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

// ── Chars signup ──────────────────────────────────────────────
// charsState: sessionKey → { boss, slots, messageId, startedAt, expireTimer, deleteTimer, customSlots?, crystalsEnabled? }
// sessionKey = channelId for QA/Zaken/Mages (one per channel); channelId:userId for Custom (multiple per channel)
const charsState = new Map();
// messageToSession: messageId → sessionKey (for Custom rosters, to route slot-button clicks)
const messageToSession = new Map();
// pendingOverrides: userId → { sessionKey, channelId, slotNum, displayName, promptMsgId?, promptDeleteTimer? }
const pendingOverrides = new Map();

// Persist chars sessions across bot restarts
const CHARS_PERSIST_FILE = path.join(__dirname, 'chars_state.json');
let charsPersisted = fs.existsSync(CHARS_PERSIST_FILE)
  ? (() => { try { return JSON.parse(fs.readFileSync(CHARS_PERSIST_FILE, 'utf8')); } catch { return {}; } })()
  : {};

function saveCharsPersisted() { saveFile(CHARS_PERSIST_FILE, charsPersisted); }

const MAGES_SLOTS  = ['BP1', 'BP2', 'SE', 'BD', 'SWS', 'OL', 'DD1', 'DD2', 'DD3', 'PONY', 'SPOIL', 'PRANA', 'JUDI'];
const ZAKEN_SLOTS       = ['DA-1', 'DA-3', 'DA-4', 'DA-6', 'SLH-8', 'BD-7', 'SWS-5', 'SE-9', 'BP-2', 'WC', 'CAT', 'JUDI', 'PHANTOM', 'WS', 'OL'];
const HIGH_ZAKEN_SLOTS  = ['WC', 'BD', 'SWS', 'SE', 'BP', 'PONY', 'JUDI', 'DOD1', 'DOD2', 'TYR', 'SOS'];
const CUSTOM_SLOT_TYPES = ['BP','SWS','BD','SORC','SPS','OL','SE','SPOIL','ARBA','JUDI','PONY','DOD','CAT','PHANTOM','WC','DESTR','TYR','WS','SOS','STUN'];

function parseCustomSlots(input) {
  const typesSorted = [...CUSTOM_SLOT_TYPES].sort((a, b) => b.length - a.length);
  const slots = [];
  const invalid = [];
  for (const token of input.trim().split(/[\s\/]+/)) {
    if (!token) continue;
    const upper = token.toUpperCase();
    let matched = false;
    for (const type of typesSorted) {
      const m = upper.match(new RegExp(`^${type}(\\d*)$`));
      if (m) {
        if (m[1]) {
          slots.push(`${type} ${m[1]}`);
        } else {
          const count = slots.filter(s => s.startsWith(type + ' ')).length;
          slots.push(`${type} ${count + 1}`);
        }
        matched = true;
        break;
      }
    }
    if (!matched) invalid.push(token);
  }
  return { slots, invalid };
}

// pendingCustomBuilders: userId → { slots: string[], crystalsEnabled: bool }
const pendingCustomBuilders = new Map();
// pendingCustomEditors: userId → { sessionKey, slots: [{id, name}], crystalsEnabled, view: 'add'|'remove' }
// id = 'orig_N' for original slots (N = 0-based index), 'new_X' for added slots
const pendingCustomEditors = new Map();

const CRYSTAL_EMOJI  = { blue: '🔵', green: '🟢', red: '🔴' };
const CRYSTAL_LABEL  = { blue: 'B', green: 'G', red: 'R' };
const CRYSTAL_LEVELS = ['11', '12', '13', '14', '15', '16'];
const CRYSTAL_OPTIONS = [
  ...CRYSTAL_LEVELS.map(l => ({ label: `🔵 B-${l}`, value: `blue_${l}` })),
  ...CRYSTAL_LEVELS.map(l => ({ label: `🟢 G-${l}`, value: `green_${l}` })),
  ...CRYSTAL_LEVELS.map(l => ({ label: `🔴 R-${l}`, value: `red_${l}` })),
  { label: '❌ Clear crystal', value: 'clear' },
];

function parseCrystalInput(text) {
  const m = text.trim().match(/^(blue?|b|gr(?:een?)?|g|red?|r)[-\s]?(1[1-6])$/i);
  if (!m) return null;
  const c = m[1].toLowerCase();
  const color = (c === 'b' || c.startsWith('bl')) ? 'blue'
              : (c === 'g' || c.startsWith('gr')) ? 'green'
              : 'red';
  return { color, level: parseInt(m[2]) };
}

function charsSlotCount(boss, customSlots) {
  if (customSlots) return customSlots.length;
  if (boss === 'Queen Ant')  return 11;
  if (boss === 'Main Mages') return MAGES_SLOTS.length;
  if (boss === 'Custom')     return 0;
  if (boss === 'High Zaken') return HIGH_ZAKEN_SLOTS.length;
  return ZAKEN_SLOTS.length; // Low Zaken
}

function charsSlotName(boss, slotNum, customSlots) {
  if (customSlots) return customSlots[slotNum - 1];
  if (boss === 'Queen Ant')  return slotNum <= 9 ? `AQ${slotNum}` : `PK${slotNum - 9}`;
  if (boss === 'Main Mages') return MAGES_SLOTS[slotNum - 1];
  if (boss === 'Custom')     return String(slotNum);
  if (boss === 'High Zaken') return HIGH_ZAKEN_SLOTS[slotNum - 1];
  return ZAKEN_SLOTS[slotNum - 1]; // Low Zaken
}

// Returns the slot name list for any boss (used to seed the editor for predefined rosters)
function getBossSlotList(boss, existingCustomSlots) {
  if (existingCustomSlots) return existingCustomSlots;
  const total = charsSlotCount(boss);
  return Array.from({ length: total }, (_, i) => charsSlotName(boss, i + 1));
}

// Parse a chat message into a slot number (or null).
function parseCharsInput(boss, text) {
  const s = text.trim();
  if (boss === 'Queen Ant') {
    if (/^(?:pk|karma)\s*1?$/i.test(s)) return 10;
    if (/^(?:pk|karma)\s*2$/i.test(s))  return 11;
    if (/^aq\s*10$/i.test(s)) return 10;
    if (/^aq\s*11$/i.test(s)) return 11;
    const m = s.match(/^(?:aq\s*)?([1-9])$/i);
    if (m) return parseInt(m[1]);
  } else if (boss === 'Main Mages') {
    // By role name (bp1, se, dd2, pony, etc.)
    const idx = MAGES_SLOTS.findIndex(n => n.toLowerCase() === s.toLowerCase());
    if (idx !== -1) return idx + 1;
    // By number 1-13
    const m = s.match(/^(\d{1,2})$/);
    if (m) { const n = parseInt(m[1]); if (n >= 1 && n <= MAGES_SLOTS.length) return n; }
  } else if (boss === 'High Zaken') {
    const idx = HIGH_ZAKEN_SLOTS.findIndex(n => n.toLowerCase() === s.toLowerCase());
    if (idx !== -1) return idx + 1;
    const m = s.match(/^(\d{1,2})$/);
    if (m) { const n = parseInt(m[1]); if (n >= 1 && n <= HIGH_ZAKEN_SLOTS.length) return n; }
  } else {
    // Low Zaken — by slot name (e.g. da-1, slh-8, bd-7)
    const idx = ZAKEN_SLOTS.findIndex(n => n.toLowerCase() === s.toLowerCase());
    if (idx !== -1) return idx + 1;
    // By number 1-9
    const m = s.match(/^(\d)$/);
    if (m) { const n = parseInt(m[1]); if (n >= 1 && n <= ZAKEN_SLOTS.length) return n; }
  }
  return null;
}

function buildCharsEmbed(boss, slots, expired = false, crystals = new Map(), customSlots = undefined) {
  const total = charsSlotCount(boss, customSlots);
  const lines = [];
  for (let i = 1; i <= total; i++) {
    const entry = slots.get(i);
    const name  = charsSlotName(boss, i, customSlots);
    if (entry) {
      const override = entry.overriddenFromId ? ` → ~~<@${entry.overriddenFromId}>~~` : '';
      const crystal  = (boss === 'Low Zaken' || boss === 'High Zaken' || boss === 'Custom') && crystals.get(entry.userId);
      const crystalStr = crystal ? ` ${CRYSTAL_EMOJI[crystal.color]} **${CRYSTAL_LABEL[crystal.color]}-${crystal.level}**` : '';
      lines.push(`**${name}** — <@${entry.userId}>${override}${crystalStr}`);
    } else {
      lines.push(`**${name}** — *empty*`);
    }
  }
  const hint = boss === 'Queen Ant'
    ? 'Type `1`–`9` for AQ slots, `pk`/`pk2` or `karma`/`karma2` for PK slots, or use the buttons below.'
    : boss === 'Main Mages'
    ? 'Type the role name (e.g. `se`, `bd`, `dd1`, `pony`) or its number `1`–`13`, or use the buttons below.'
    : boss === 'Custom'
    ? 'Use the buttons below to sign up for a slot.'
    : boss === 'High Zaken'
    ? 'Type the role name (e.g. `wc`, `bp`, `tyr`) or its number `1`–`10`, or use the buttons below. Type your crystal (e.g. `blue 11`, `b-13`, `green 12`, `r14`) to set it.'
    : 'Type the slot name (e.g. `da-1`, `slh-8`, `wc`) or its number `1`–`15`, or use the buttons below. Type your crystal (e.g. `blue 11`, `b-13`, `green 12`, `r14`) to set it.';
  const instructions = expired
    ? ''
    : `-# **How to sign up:** ${hint}\n-# Click your own slot again to leave it. If a slot is taken you will be asked to confirm an override.\n\n`;

  const color = expired ? 0x95a5a6 : boss === 'Queen Ant' ? 0xED4245 : boss === 'Main Mages' ? 0xE67E22 : boss === 'Custom' ? 0x57F287 : 0x5865F2;
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(expired ? `${boss} — Char Signup  ⚠️ EXPIRED` : `${boss} — Char Signup`)
    .setDescription(instructions + lines.join('\n'))
    .setFooter({ text: expired ? 'This roster has expired. Leader can use /chars to start a new one.' : boss === 'Custom' ? 'Expires in 4h • Use buttons to sign up' : 'Expires in 4h • Use buttons or type slot number in chat' });
}

function buildCharsComponents(boss, slots, disabled = false, customSlots = undefined, crystalsEnabled = false, sessionKey = null) {
  const total = charsSlotCount(boss, customSlots);
  const rows  = [];
  let   row   = new ActionRowBuilder();
  for (let i = 1; i <= total; i++) {
    const entry = slots.get(i);
    const name  = charsSlotName(boss, i, customSlots);
    const label = entry ? `${name} — @${entry.displayName}`.slice(0, 80) : name;
    // Custom rosters embed sessionKey in slot button so multi-session routing works
    const slotBtnId = (boss === 'Custom' && sessionKey) ? `chars_slot|${sessionKey}|${i}` : `chars_slot|${i}`;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(slotBtnId)
        .setLabel(label)
        .setStyle(entry ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(disabled),
    );
    // 5 buttons per row
    if (i % 5 === 0 || i === total) { rows.push(row); row = new ActionRowBuilder(); }
  }
  const hasCrystalRow = !disabled && (boss === 'Low Zaken' || boss === 'High Zaken' || (boss === 'Custom' && crystalsEnabled));
  if (hasCrystalRow) {
    const crystalBtnId = (boss === 'Custom' && sessionKey) ? `chars_crystal|${sessionKey}` : 'chars_crystal';
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(crystalBtnId).setLabel('💎 SET CRYSTAL').setStyle(ButtonStyle.Primary)
    ));
  }
  // Edit button for any active roster that has a sessionKey
  if (!disabled && sessionKey) {
    const editBtn = new ButtonBuilder().setCustomId(`chars_edit|${sessionKey}`).setLabel('✏️ EDIT ROSTER').setStyle(ButtonStyle.Secondary);
    if (hasCrystalRow) {
      rows[rows.length - 1].addComponents(editBtn);
    } else if (rows.length < 5) {
      rows.push(new ActionRowBuilder().addComponents(editBtn));
    } else if (rows[rows.length - 1].components.length < 5) {
      rows[rows.length - 1].addComponents(editBtn);
    }
  }
  return rows;
}

function buildCustomBuilderEmbed(builder) {
  const { slots, crystalsEnabled } = builder;
  const maxSlots = crystalsEnabled ? 20 : 25;
  const description = slots.length === 0
    ? '*No slots added yet. Press the class buttons below to add.*'
    : slots.map((s, i) => `**${i + 1}.** ${s}`).join('\n');
  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('Custom Char Signup — Builder')
    .setDescription(description)
    .addFields(
      { name: 'Slots', value: `${slots.length} / ${maxSlots}`, inline: true },
      { name: 'Crystals', value: crystalsEnabled ? '✅ Enabled' : '❌ Disabled', inline: true },
    )
    .setFooter({ text: `Press class buttons to add • Undo removes last • Accept to post roster\n💎 Crystals ON = 20 slots max (1 row used by crystal button) • Crystals OFF = 25 slots max` });
}

function buildCustomBuilderComponents(builder) {
  const { slots, crystalsEnabled } = builder;
  const maxSlots = crystalsEnabled ? 20 : 25;
  const atLimit  = slots.length >= maxSlots;
  // Build slot-type rows dynamically (5 per row); control row takes the last slot
  const rows = [];
  for (let i = 0; i < CUSTOM_SLOT_TYPES.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      ...CUSTOM_SLOT_TYPES.slice(i, i + 5).map(t =>
        new ButtonBuilder().setCustomId(`custom_add|${t}`).setLabel(t).setStyle(ButtonStyle.Secondary).setDisabled(atLimit)
      )
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('custom_undo').setLabel('↩ UNDO').setStyle(ButtonStyle.Secondary).setDisabled(slots.length === 0),
    new ButtonBuilder().setCustomId('custom_crystal_toggle').setLabel(`💎 CRYSTALS: ${crystalsEnabled ? 'ON' : 'OFF'}`).setStyle(crystalsEnabled ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('custom_accept').setLabel('✅ ACCEPT').setStyle(ButtonStyle.Success).setDisabled(slots.length === 0),
    new ButtonBuilder().setCustomId('custom_cancel').setLabel('❌ CANCEL').setStyle(ButtonStyle.Danger),
  ));
  return rows;
}


function buildCharsEditEmbed(editor, state) {
  const isCustom = editor.boss === 'Custom';
  const maxSlots = isCustom ? (editor.crystalsEnabled ? 20 : 25) : 25;
  const lines = editor.slots.map((s, i) => {
    let suffix = ' — *empty*';
    if (s.id.startsWith('orig_')) {
      const origSlotNum = parseInt(s.id.slice(5)) + 1;
      const entry = state.slots.get(origSlotNum);
      if (entry) suffix = ` — ${entry.displayName}`;
    }
    return `**${i + 1}.** ${s.name}${suffix}`;
  });
  const isRemove = editor.view === 'remove';
  const fields = [{ name: 'Slots', value: `${editor.slots.length} / ${maxSlots}`, inline: true }];
  if (isCustom) fields.push({ name: 'Crystals', value: editor.crystalsEnabled ? '✅ Enabled' : '❌ Disabled', inline: true });
  return new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle(isRemove ? `✏️ Edit Roster — Remove a Slot` : `✏️ Edit Roster — ${state.boss}`)
    .setDescription(lines.length ? lines.join('\n') : '*No slots yet. Add some below.*')
    .addFields(...fields)
    .setFooter({ text: isRemove
      ? 'Select a slot to remove it • Taken slots can be removed (signup will be cleared)'
      : 'Add slots with class buttons • Remove to pick a slot to delete • Apply to save' });
}

function buildCharsEditAddComponents(editor, sessionKey) {
  const isCustom = editor.boss === 'Custom';
  const maxSlots = isCustom ? (editor.crystalsEnabled ? 20 : 25) : 25;
  const atLimit = editor.slots.length >= maxSlots;
  const hasNew = editor.slots.some(s => !s.id.startsWith('orig_'));
  const rows = [];
  for (let i = 0; i < CUSTOM_SLOT_TYPES.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      ...CUSTOM_SLOT_TYPES.slice(i, i + 5).map(t =>
        new ButtonBuilder().setCustomId(`chars_edit_type|${t}|${sessionKey}`).setLabel(t).setStyle(ButtonStyle.Secondary).setDisabled(atLimit)
      )
    ));
  }
  const controlBtns = [
    new ButtonBuilder().setCustomId(`chars_edit_undo|${sessionKey}`).setLabel('↩ UNDO').setStyle(ButtonStyle.Secondary).setDisabled(!hasNew),
    new ButtonBuilder().setCustomId(`chars_edit_remove_view|${sessionKey}`).setLabel('🗑️ REMOVE SLOT').setStyle(ButtonStyle.Danger).setDisabled(editor.slots.length === 0),
    ...(isCustom ? [new ButtonBuilder().setCustomId(`chars_edit_crystal|${sessionKey}`).setLabel(`💎 CRYSTALS: ${editor.crystalsEnabled ? 'ON' : 'OFF'}`).setStyle(editor.crystalsEnabled ? ButtonStyle.Primary : ButtonStyle.Secondary)] : []),
    new ButtonBuilder().setCustomId(`chars_edit_apply|${sessionKey}`).setLabel('✅ APPLY').setStyle(ButtonStyle.Success).setDisabled(editor.slots.length === 0),
    new ButtonBuilder().setCustomId(`chars_edit_cancel|${sessionKey}`).setLabel('❌ CANCEL').setStyle(ButtonStyle.Danger),
  ];
  rows.push(new ActionRowBuilder().addComponents(...controlBtns));
  return rows;
}

function buildCharsEditRemoveComponents(editor, state, sessionKey) {
  const rows = [];
  let row = new ActionRowBuilder();
  editor.slots.forEach((s, i) => {
    let label = `${i + 1}. ${s.name}`;
    if (s.id.startsWith('orig_')) {
      const origSlotNum = parseInt(s.id.slice(5)) + 1;
      const entry = state.slots.get(origSlotNum);
      if (entry) label += ` [${entry.displayName}]`;
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`chars_edit_remove_slot|${s.id}|${sessionKey}`)
        .setLabel(label.slice(0, 80))
        .setStyle(ButtonStyle.Danger)
    );
    if ((i + 1) % 5 === 0 || i === editor.slots.length - 1) { rows.push(row); row = new ActionRowBuilder(); }
  });
  const backBtn = new ButtonBuilder().setCustomId(`chars_edit_back|${sessionKey}`).setLabel('← BACK').setStyle(ButtonStyle.Secondary);
  if (rows.length < 5) {
    rows.push(new ActionRowBuilder().addComponents(backBtn));
  } else if (rows[rows.length - 1].components.length < 5) {
    rows[rows.length - 1].addComponents(backBtn);
  }
  return rows;
}

function applyCharsEdit(sessionKey, editor) {
  const state = charsState.get(sessionKey);
  if (!state) return false;

  const newCustomSlots = editor.slots.map(s => s.name);

  // Build old slot number → new slot number mapping for signup remapping
  const oldToNew = new Map();
  editor.slots.forEach((s, newIdx) => {
    if (s.id.startsWith('orig_')) {
      const origIdx = parseInt(s.id.slice(5));
      oldToNew.set(origIdx + 1, newIdx + 1);
    }
  });

  // Rebuild signups with new slot numbers; drop signups for removed slots
  const newSlotsMap = new Map();
  for (const [oldSlotNum, entry] of state.slots.entries()) {
    const newSlotNum = oldToNew.get(oldSlotNum);
    if (newSlotNum !== undefined) newSlotsMap.set(newSlotNum, entry);
  }

  // Remove crystals for users who no longer have a slot
  if (state.crystals) {
    const activeUserIds = new Set([...newSlotsMap.values()].map(e => e.userId));
    for (const userId of [...state.crystals.keys()]) {
      if (!activeUserIds.has(userId)) state.crystals.delete(userId);
    }
  }

  // Crystal toggle only affects Custom rosters (Zaken crystals are always on via boss name)
  if (state.boss === 'Custom') {
    const wasEnabled = state.crystalsEnabled;
    state.crystalsEnabled = editor.crystalsEnabled;
    if (wasEnabled && !editor.crystalsEnabled) state.crystals = new Map();
  }

  state.customSlots = newCustomSlots;
  state.slots = newSlotsMap;

  if (charsPersisted[sessionKey]) {
    charsPersisted[sessionKey].customSlots = newCustomSlots;
    charsPersisted[sessionKey].slots = [...newSlotsMap.entries()];
    charsPersisted[sessionKey].crystals = [...(state.crystals?.entries() ?? [])];
    charsPersisted[sessionKey].crystalsEnabled = state.crystalsEnabled;
    saveCharsPersisted();
  }
  return true;
}

// Low Zaken slots 10+ (WC/CAT/JUDI/PHANTOM/WS/OL) allow one user to fill multiple
function isMultiSlot(boss, slotNum) {
  return boss === 'Low Zaken' && slotNum >= 10;
}

// Returns 'assigned'|'removed'|'taken'|'expired'
async function applyCharsSlot(sessionKey, userId, displayName, slotNum, override = false) {
  const state = charsState.get(sessionKey);
  if (!state) return 'expired';

  const multi = isMultiSlot(state.boss, slotNum);

  if (multi) {
    // Multi-slot: user can hold several of these slots independently
    const thisEntry = state.slots.get(slotNum);
    if (thisEntry?.userId === userId) {
      // Click own slot → leave it
      state.slots.delete(slotNum);
      const stillHasSlot = [...state.slots.values()].some(e => e.userId === userId);
      if (!stillHasSlot) state.crystals?.delete(userId);
      if (charsPersisted[sessionKey]) { charsPersisted[sessionKey].slots = [...state.slots.entries()]; charsPersisted[sessionKey].crystals = [...(state.crystals?.entries() ?? [])]; saveCharsPersisted(); }
      return 'removed';
    }
    if (thisEntry && !override) return 'taken';
    state.slots.set(slotNum, { userId, displayName, overriddenFromId: (thisEntry && override) ? thisEntry.userId : undefined, overriddenFromName: (thisEntry && override) ? thisEntry.displayName : undefined });
    if (charsPersisted[sessionKey]) { charsPersisted[sessionKey].slots = [...state.slots.entries()]; saveCharsPersisted(); }
    return 'assigned';
  }

  // Single-slot: user can only occupy one slot at a time
  let userCurrentSlot = null;
  for (const [num, entry] of state.slots.entries()) {
    if (entry.userId === userId && !isMultiSlot(state.boss, num)) { userCurrentSlot = num; break; }
  }

  if (userCurrentSlot === slotNum) {
    state.slots.delete(slotNum);
    state.crystals?.delete(userId);
    if (charsPersisted[sessionKey]) { charsPersisted[sessionKey].slots = [...state.slots.entries()]; charsPersisted[sessionKey].crystals = [...(state.crystals?.entries() ?? [])]; saveCharsPersisted(); }
    return 'removed';
  }

  const existing = state.slots.get(slotNum);
  if (existing && !override) return 'taken';

  if (userCurrentSlot !== null) state.slots.delete(userCurrentSlot);
  state.slots.set(slotNum, {
    userId,
    displayName,
    overriddenFromId: (existing && override) ? existing.userId : undefined,
    overriddenFromName: (existing && override) ? existing.displayName : undefined,
  });
  if (charsPersisted[sessionKey]) { charsPersisted[sessionKey].slots = [...state.slots.entries()]; saveCharsPersisted(); }
  return 'assigned';
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
  new SlashCommandBuilder().setName('remove-absence').setDescription('Remove an absence entry').toJSON(),

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

  new SlashCommandBuilder()
    .setName('chars')
    .setDescription('Open a char signup sheet')
    .addStringOption(o => o.setName('composition').setDescription('Choose preset or custom').setRequired(true)
      .addChoices(
        { name: 'Queen Ant',    value: 'Queen Ant'  },
        { name: 'Low Zaken',    value: 'Low Zaken'  },
        { name: 'High Zaken',   value: 'High Zaken' },
        { name: 'Main Mages',   value: 'Main Mages' },
        { name: 'Custom Chars', value: 'Custom'     },
      ))
    .addStringOption(o => o.setName('slots').setDescription('Types: BP SWS BD SORC SPS OL SE SPOIL ARBA JUDI PONY DOD CAT PHANTOM WC DESTR TYR WS SOS STUN').setRequired(false))
    .addBooleanOption(o => o.setName('crystals').setDescription('Custom only: enable crystal tracking (limits roster to 20 slots)').setRequired(false))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('drops')
    .setDescription('Show drop statistics for a boss')
    .addStringOption(o => o.setName('boss').setDescription('Boss name').setRequired(true).setAutocomplete(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('scandrops')
    .setDescription('Scan this channel for past TOD records and rebuild drop history')
    .toJSON(),
];

// ── Bot ───────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates] });

function scheduleAlert(alertKey, bossName, channelId, windowStartMs) {
  if (alertTimers.has(alertKey)) clearTimeout(alertTimers.get(alertKey));
  const delayMs = Math.max(0, windowStartMs - Date.now());
  console.log(`[Alert] Scheduled ${bossName} in ${Math.round(delayMs / 1000)}s (channel ${channelId})`);
  const timer = setTimeout(async () => {
    console.log(`[Alert] Firing for ${bossName} in channel ${channelId}`);
    try {
      const channel = await client.channels.fetch(channelId);
      await channel.send({ content: `@everyone 🔔 **${bossName}** window has started!`, allowedMentions: { parse: ['everyone'] } });
      console.log(`[Alert] Sent for ${bossName}`);
    } catch (e) { console.error(`[Alert] Failed to send alert for ${bossName}:`, e.message); }
    delete bossAlerts[alertKey];
    alertTimers.delete(alertKey);
    saveBossAlerts();
  }, delayMs);
  alertTimers.set(alertKey, timer);
}

function scheduleCloseAlert(alertKey, bossName, channelId, windowEndMs) {
  if (closeAlertTimers.has(alertKey)) clearTimeout(closeAlertTimers.get(alertKey));
  const delayMs = windowEndMs - Date.now();
  if (delayMs <= 0) return;
  const timer = setTimeout(async () => {
    try {
      const channel = await client.channels.fetch(channelId);
      await channel.send({ content: `@everyone 🔴 **${bossName}** window has CLOSED!`, allowedMentions: { parse: ['everyone'] } });
    } catch (e) { console.error(`[CloseAlert] Failed for ${bossName}:`, e.message); }
    closeAlertTimers.delete(alertKey);
  }, delayMs);
  closeAlertTimers.set(alertKey, timer);
}

// ── Market listing helpers ────────────────────────────────────
function listingExpiresStr(listing) {
  const remaining = listing.expiresAt - Date.now();
  if (remaining > 0 && remaining < 24 * 60 * 60 * 1000) {
    const totalMins = Math.floor(remaining / 60000);
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  return `<t:${Math.floor(listing.expiresAt / 1000)}:R>`;
}

function buildListingMsg(listing) {
  const isWts = listing.type === 'wts';
  if (listing.status === 'active') {
    const icon  = isWts ? '🟣' : '🟡';
    const label = isWts ? 'WTS' : 'WTB';
    const lines = [`${icon} **${label}**`, ``, `**${listing.item}**`, ``];
    if (listing.price) lines.push(`${isWts ? 'Price' : 'Offering'}: ${listing.price}`);
    lines.push(`Expires: ${listingExpiresStr(listing)}`);
    lines.push(`${isWts ? 'Seller' : 'Buyer'}: <@${listing.userId}>`);
    return { content: lines.join('\n'), embeds: [] };
  }
  const suffix = listing.status === 'sold' ? 'SOLD' : listing.status === 'found' ? 'FOUND' : 'EXPIRED';
  const lines = [
    `🔴 **${isWts ? 'WTS' : 'WTB'} — ${suffix}**`,
    `~~${listing.item}~~`,
    `${isWts ? 'Seller' : 'Buyer'}: <@${listing.userId}>`,
  ];
  return { content: lines.join('\n'), embeds: [] };
}

function buildListingComponents(listing, messageId) {
  const uid = listing.userId;
  const isWts = listing.type === 'wts';
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`listing_close:${uid}:${messageId}`).setLabel(isWts ? '✅ Mark as Sold' : '✅ Mark as Found').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`listing_remove:${uid}:${messageId}`).setLabel('🗑️ Remove').setStyle(ButtonStyle.Danger),
  )];
}

async function markListingExpired(guildId, messageId) {
  const listing = listings[guildId]?.[messageId];
  if (!listing || listing.status !== 'active') return;
  listing.status = 'expired';
  saveListings();
  try {
    const ch = await client.channels.fetch(listing.channelId);
    const msg = await ch.messages.fetch(messageId);
    await msg.edit({ ...buildListingMsg(listing), components: [] });
  } catch (_) {}
}

async function deleteListingMessage(guildId, messageId) {
  const listing = listings[guildId]?.[messageId];
  if (listing) {
    try {
      const ch = await client.channels.fetch(listing.channelId);
      const msg = await ch.messages.fetch(messageId);
      await msg.delete();
    } catch (_) {}
    delete listings[guildId][messageId];
    saveListings();
  }
  listingTimers.delete(`${guildId}:${messageId}`);
}

function scheduleListingTimers(guildId, messageId) {
  const listing = listings[guildId]?.[messageId];
  if (!listing) return;
  const key = `${guildId}:${messageId}`;
  const existing = listingTimers.get(key);
  if (existing) { clearTimeout(existing.expiry); clearTimeout(existing.delete); }
  const now = Date.now();
  const timers = {};
  if (listing.status === 'active') {
    const expireIn = listing.expiresAt - now;
    if (expireIn <= 0) { markListingExpired(guildId, messageId); return; }
    timers.expiry = setTimeout(() => markListingExpired(guildId, messageId), expireIn);
  }
  const deleteIn = listing.deletesAt - now;
  if (deleteIn <= 0) { deleteListingMessage(guildId, messageId); return; }
  timers.delete = setTimeout(() => deleteListingMessage(guildId, messageId), deleteIn);
  listingTimers.set(key, timers);
}

function buildFortEmbed(data) {
  const icon = data.action === 'Farm' ? '🌾' : '⭐';
  const fields = [
    { name: '⏰ Starts',      value: data.timeDisplay },
    { name: `${icon} Action`, value: data.action },
    { name: '👤 By',          value: `<@${data.userId}>` },
  ];
  if (data.nextFortTs) {
    const remaining = data.nextFortTs * 1000 - Date.now();
    let cooldownStr;
    if (remaining <= 0) {
      cooldownStr = 'Available now';
    } else {
      const totalSecs = Math.ceil(remaining / 1000);
      const h = Math.floor(totalSecs / 3600);
      const m = Math.floor((totalSecs % 3600) / 60);
      const s = totalSecs % 60;
      cooldownStr = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    fields.push(
      { name: '⏳ Cooldown ends', value: cooldownStr },
      { name: '🔜 Next fort available', value: `<t:${data.nextFortTs}:t>` },
    );
  }
  return new EmbedBuilder()
    .setColor(data.action === 'Farm' ? 0xE67E22 : 0x9B59B6)
    .setTitle(`🏰 ${data.fort}`)
    .addFields(fields)
    .setTimestamp(new Date(data.postedAt))
    .setFooter({ text: "Melon's Bot" });
}

client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity('Boss Timers & Absences', { type: ActivityType.Watching });

  // Re-register guild commands on every startup (use fetch so cache state doesn't matter)
  setTimeout(async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    try {
      const botGuilds = await client.guilds.fetch();

      // Migrate legacy flat boss list to every guild
      if (_legacyBosses) {
        for (const [guildId] of botGuilds) {
          if (!bossesByGuild[guildId]) bossesByGuild[guildId] = JSON.parse(JSON.stringify(_legacyBosses));
        }
        _legacyBosses = null;
        saveBosses();
        console.log('[Bosses] Migrated legacy boss list to all guilds');
      }

      console.log(`📋 Registering slash commands for ${botGuilds.size} guild(s)...`);
      for (const [guildId, guild] of botGuilds) {
        try {
          await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId), { body: COMMANDS });
          console.log(`✅ Commands registered: ${guild.name}`);
        } catch (err) {
          console.error(`❌ Registration failed for ${guildId}:`, err.message);
        }
      }
    } catch (err) {
      console.error('❌ Failed to fetch guilds for command registration:', err.message);
    }
  }, 3000);

  // Restore or clean up chars sessions that survived a restart
  const now = Date.now();
  const EXPIRE_MS = 4 * 60 * 60 * 1000;
  const DELETE_MS = 5 * 60 * 60 * 1000;
  for (const [sessionKey, entry] of Object.entries(charsPersisted)) {
    const elapsed = now - new Date(entry.startedAt).getTime();
    // Custom sessions store channelId explicitly; QA/Zaken/Mages use the key as channelId
    const realChannelId = entry.channelId ?? sessionKey;
    let channel;
    try { channel = await client.channels.fetch(realChannelId); } catch { delete charsPersisted[sessionKey]; continue; }

    if (elapsed >= DELETE_MS) {
      // Past 5h — delete message and remove
      try { const m = await channel.messages.fetch(entry.messageId); await m.delete(); } catch (_) {}
      delete charsPersisted[sessionKey];
      messageToSession.delete(entry.messageId);
    } else {
      const slots          = new Map(entry.slots ?? []);
      const crystals       = new Map(entry.crystals ?? []);
      const customSlots    = entry.customSlots ?? undefined;
      const crystalsEnabled = entry.crystalsEnabled ?? false;
      const state = { boss: entry.boss, slots, crystals, messageId: entry.messageId, startedAt: entry.startedAt, expireTimer: null, deleteTimer: null, customSlots, crystalsEnabled };

      const scheduleDelete = (delay) => {
        state.deleteTimer = setTimeout(async () => {
          try { const m = await channel.messages.fetch(entry.messageId); await m.delete(); } catch (_) {}
          charsState.delete(sessionKey);
          messageToSession.delete(entry.messageId);
          delete charsPersisted[sessionKey];
          saveCharsPersisted();
        }, delay);
      };

      if (elapsed >= EXPIRE_MS) {
        // Past 4h but not 5h — mark expired, schedule delete for remaining time
        try {
          const m = await channel.messages.fetch(entry.messageId);
          await m.edit({ embeds: [buildCharsEmbed(entry.boss, slots, true, crystals, customSlots)], components: buildCharsComponents(entry.boss, slots, true, customSlots, crystalsEnabled, sessionKey) });
        } catch (_) {}
        scheduleDelete(DELETE_MS - elapsed);
      } else {
        // Still active — restore state and schedule both timers
        charsState.set(sessionKey, state);
        if (entry.boss === 'Custom') messageToSession.set(entry.messageId, sessionKey);
        state.expireTimer = setTimeout(async () => {
          charsState.delete(sessionKey);
          try {
            const m = await channel.messages.fetch(entry.messageId);
            await m.edit({ embeds: [buildCharsEmbed(entry.boss, slots, true, crystals, customSlots)], components: buildCharsComponents(entry.boss, slots, true, customSlots, crystalsEnabled, sessionKey) });
          } catch (_) {}
          scheduleDelete(60 * 60 * 1000);
        }, EXPIRE_MS - elapsed);
      }
    }
  }
  saveCharsPersisted();

  // Restore boss window alerts
  for (const [alertKey, alert] of Object.entries(bossAlerts)) {
    const windowEndMs = alert.windowEnd ? new Date(alert.windowEnd).getTime() : Infinity;
    if (windowEndMs <= Date.now()) { delete bossAlerts[alertKey]; continue; }
    scheduleAlert(alertKey, alert.bossName, alert.channelId, new Date(alert.windowStart).getTime());
    scheduleCloseAlert(alertKey, alert.bossName, alert.channelId, new Date(alert.windowEnd).getTime());
    console.log(`[Alert] Restored alert for ${alert.bossName}`);
  }
  saveBossAlerts();

  // Restore listing timers
  for (const [guildId, guildListings] of Object.entries(listings)) {
    for (const messageId of Object.keys(guildListings)) {
      scheduleListingTimers(guildId, messageId);
    }
  }

  // Every minute: update HH:MM countdown on listings with < 24h remaining
  setInterval(async () => {
    const now = Date.now();
    for (const [, guildListings] of Object.entries(listings)) {
      for (const [messageId, listing] of Object.entries(guildListings)) {
        if (listing.status !== 'active') continue;
        const remaining = listing.expiresAt - now;
        if (remaining <= 0 || remaining >= 24 * 60 * 60 * 1000) continue;
        try {
          const ch  = await client.channels.fetch(listing.channelId);
          const msg = await ch.messages.fetch(messageId);
          await msg.edit({ content: buildListingMsg(listing).content });
        } catch (_) {}
      }
    }
  }, 60 * 1000);

  // Every 30s: update H:MM:SS countdown on fort cooldown messages
  setInterval(async () => {
    const now = Date.now();
    for (const [msgId, data] of fortMessages) {
      if (data.nextFortTs * 1000 <= now) {
        // Cooldown expired — do a final edit to show "Available now" then remove
        try {
          const ch  = await client.channels.fetch(data.channelId);
          const msg = await ch.messages.fetch(msgId);
          await msg.edit({ embeds: [buildFortEmbed(data)] });
        } catch (_) {}
        fortMessages.delete(msgId);
        continue;
      }
      try {
        const ch  = await client.channels.fetch(data.channelId);
        const msg = await ch.messages.fetch(msgId);
        await msg.edit({ embeds: [buildFortEmbed(data)] });
      } catch (_) { fortMessages.delete(msgId); }
    }
  }, 30 * 1000);
});

client.on('guildCreate', async guild => {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guild.id), { body: COMMANDS });
    console.log(`✅ Commands registered for: ${guild.name}`);
    if (!bossesByGuild[guild.id]) {
      bossesByGuild[guild.id] = getDefaultBosses();
      saveBosses();
    }
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
      const choices = getGuildBosses(interaction.guildId)
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

        const boss = findBoss(interaction.guildId, bossName);
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

        // Record kill/drop for history statistics
        recordDrop(interaction.guildId, boss.name, whoKilled ?? null, dropped);

        // Save TOD state for live /bosses display (independent of alert system)
        setTodState(interaction.guildId, boss.name, {
          windowStart: windowStart.toISOString(),
          windowEnd: windowEnd.toISOString(),
          killedBy: whoKilled ?? null,
          dropped: dropped,
          recordedAt: new Date().toISOString(),
        });

        // Schedule window-open and window-close alerts
        const alertKey = `${interaction.guildId}:${boss.name}`;
        if (windowEnd.getTime() > Date.now()) {
          bossAlerts[alertKey] = { bossName: boss.name, channelId: interaction.channelId, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() };
          saveBossAlerts();
          scheduleAlert(alertKey, boss.name, interaction.channelId, windowStart.getTime());
          scheduleCloseAlert(alertKey, boss.name, interaction.channelId, windowEnd.getTime());
        }

        // Ephemeral undo button (60s window)
        const todMsg = await interaction.fetchReply();
        pendingTodUndos.set(interaction.user.id, { messageId: todMsg.id, channelId: interaction.channelId, guildId: interaction.guildId, bossName: boss.name, alertKey, todTime, windowStart, windowEnd });
        setTimeout(() => pendingTodUndos.delete(interaction.user.id), 60 * 1000);
        const undoMsg = await interaction.followUp({
          content: '↩️ Recorded! You have 60s to undo:',
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tod_undo').setLabel('↩ Undo TOD').setStyle(ButtonStyle.Danger)
          )],
          flags: MessageFlags.Ephemeral,
          fetchReply: true,
        });
        setTimeout(async () => {
          try { await interaction.deleteReply(undoMsg.id); } catch (_) {
            try { await undoMsg.edit({ content: '​', components: [] }); } catch (__) {}
          }
        }, 60 * 1000);
        return;
      }

      // ── /bosses ──
      if (interaction.commandName === 'bosses') {
        const now = Date.now();
        const guildTod = todState[interaction.guildId] ?? {};

        const lines = getGuildBosses(interaction.guildId).map(b => {
          const tod = guildTod[b.name];
          if (!tod) return `⚫ **${b.name}** — spawn ${b.spawnHours}h, window ${b.windowHours}h`;
          const wStart = new Date(tod.windowStart).getTime();
          const wEnd   = new Date(tod.windowEnd).getTime();
          const by     = tod.killedBy === 'ally' ? ' (ally)' : tod.killedBy === 'enemy' ? ' (enemy)' : '';
          if (now < wStart) return `🟡 **${b.name}** — window opens ${discordTime(new Date(wStart), 'R')}${by}`;
          if (now < wEnd)   return `🟢 **${b.name}** — WINDOW OPEN, closes ${discordTime(new Date(wEnd), 'R')}${by}`;
          return `⚫ **${b.name}** — window ended ${discordTime(new Date(wEnd), 'R')}${by}`;
        });

        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('Boss Respawn Windows')
            .setDescription(lines.join('\n'))
            .setFooter({ text: `🟢 In window  🟡 Upcoming  ⚫ No data / ended` })
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

      // ── /move ──
      if (interaction.commandName === 'move') {
        const from = interaction.options.getString('from');
        const gear = interaction.options.getString('gear');
        const to   = interaction.options.getString('to');
        await interaction.reply(`⚙️ **${from}** ➜ **${gear}** ➜ **${to}**`);
        return;
      }

      // ── /fort ──
      if (interaction.commandName === 'fort') {
        const fort   = interaction.options.getString('fort');
        const time   = interaction.options.getString('time');
        const action = interaction.options.getString('action');

        let timeDisplay = time;
        let nextFortTs  = null;
        const cleanTime = time.trim().replace(/^:/, ''); // strip leading colon so ":40" works same as "40"
        const minsOnly  = cleanTime.match(/^(\d{1,2})$/);
        const fullMatch = cleanTime.match(/^(\d{1,2}):(\d{2})$/);
        if (minsOnly || fullMatch) {
          const now = new Date();
          const nowParts = new Intl.DateTimeFormat('en-US', {
            timeZone: BOT_TIMEZONE,
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', hour12: false,
          }).formatToParts(now).reduce((a, p) => { if (p.type !== 'literal') a[p.type] = parseInt(p.value); return a; }, {});
          const h = minsOnly ? (nowParts.hour === 24 ? 0 : nowParts.hour) : parseInt(fullMatch[1]);
          const m = minsOnly ? parseInt(minsOnly[1]) : parseInt(fullMatch[2]);
          const utc    = zonedToUtc(nowParts.year, nowParts.month - 1, nowParts.day, h, m, BOT_TIMEZONE);
          const fortTs = Math.floor(utc.getTime() / 1000);
          timeDisplay  = `<t:${fortTs}:t>`;
          nextFortTs   = fortTs + 5 * 60 * 60;
        }

        const fortData = { fort, action, timeDisplay, nextFortTs, userId: interaction.user.id, postedAt: Date.now() };
        const msg = await interaction.reply({ embeds: [buildFortEmbed(fortData)], fetchReply: true });
        if (nextFortTs) {
          fortMessages.set(msg.id, { ...fortData, channelId: msg.channelId });
        }

        // Ephemeral undo button (60s window)
        pendingFortUndos.set(interaction.user.id, { messageId: msg.id, channelId: msg.channelId });
        setTimeout(() => pendingFortUndos.delete(interaction.user.id), 60 * 1000);
        const fortUndoMsg = await interaction.followUp({
          content: '↩️ Registered! You have 60s to undo:',
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('fort_undo').setLabel('↩ Undo Fort').setStyle(ButtonStyle.Danger)
          )],
          flags: MessageFlags.Ephemeral,
          fetchReply: true,
        });
        setTimeout(async () => {
          try { await interaction.deleteReply(fortUndoMsg.id); } catch (_) {
            try { await fortUndoMsg.edit({ content: '​', components: [] }); } catch (__) {}
          }
        }, 60 * 1000);
        return;
      }

      // ── /wts ──
      if (interaction.commandName === 'wts' || interaction.commandName === 'wtb') {
        const type  = interaction.commandName;
        const item  = interaction.options.getString('item');
        const price = interaction.options.getString('price');
        const daysInput = interaction.options.getInteger('list_for_days') ?? 7;
        const now       = Date.now();
        const expiresAt = now + Math.min(daysInput, 7) * 24 * 60 * 60 * 1000;
        const deletesAt = expiresAt + 24 * 60 * 60 * 1000;
        const listing = {
          type, item, price, userId: interaction.user.id, username: interaction.user.username,
          channelId: interaction.channelId, messageId: null,
          postedAt: now, expiresAt, deletesAt, status: 'active',
        };
        const msg = await interaction.reply({ ...buildListingMsg(listing), components: [], fetchReply: true });
        listing.messageId = msg.id;
        if (!listings[interaction.guildId]) listings[interaction.guildId] = {};
        listings[interaction.guildId][msg.id] = listing;
        saveListings();
        await msg.edit({ components: buildListingComponents(listing, msg.id) });
        scheduleListingTimers(interaction.guildId, msg.id);
        return;
      }

      // ── /shops ──
      if (interaction.commandName === 'shops') {
        // Delete previous shops message for this user if still active
        const prev = pendingShops.get(interaction.user.id);
        if (prev) {
          clearTimeout(prev.timer);
          try { await prev.interaction.deleteReply(); } catch (_) {}
          pendingShops.delete(interaction.user.id);
        }

        const guildListings = listings[interaction.guildId] ?? {};
        const active = Object.values(guildListings).filter(l => l.status === 'active');
        if (active.length === 0) {
          await interaction.reply({ content: '📭 No active listings.', flags: MessageFlags.Ephemeral });
          const timer = setTimeout(async () => {
            try { await interaction.deleteReply(); } catch (_) {}
            pendingShops.delete(interaction.user.id);
          }, 300 * 1000);
          pendingShops.set(interaction.user.id, { interaction, timer });
          return;
        }
        const wts = active.filter(l => l.type === 'wts');
        const wtb = active.filter(l => l.type === 'wtb');
        const lines = [];
        const listingLine = (l) => {
          const price = l.price ? ` — ${l.price}` : '';
          const url   = `https://discord.com/channels/${interaction.guildId}/${l.channelId}/${l.messageId}`;
          return `• **${l.item}**${price} | <@${l.userId}> | expires <t:${Math.floor(l.expiresAt / 1000)}:R> — [→ go to listing](${url})`;
        };
        if (wts.length) {
          lines.push(`**WTS (${wts.length})**`);
          for (const l of wts) lines.push(listingLine(l));
        }
        if (wtb.length) {
          if (wts.length) lines.push('');
          lines.push(`**WTB (${wtb.length})**`);
          for (const l of wtb) lines.push(listingLine(l));
        }
        await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
        const timer = setTimeout(async () => {
          try { await interaction.deleteReply(); } catch (_) {}
          pendingShops.delete(interaction.user.id);
        }, 300 * 1000);
        pendingShops.set(interaction.user.id, { interaction, timer });
        return;
      }

      // ── /todoptions ──
      if (interaction.commandName === 'todoptions') {
        await replyEph(interaction, { embeds: [buildOptionsEmbed(interaction.guildId)], components: buildOptionsComponents(interaction.guildId) });
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
        const todayISO = toISO(today);

        function isAbsenceActiveToday(a) {
          if (a.type === 'day') return a.date === todayISO;
          return a.startDate <= todayISO && a.endDate >= todayISO;
        }

        const upcoming = getAbsences(interaction.guildId)
          .filter(a => isoToDate(a.type === 'day' ? a.date : a.endDate) >= today)
          .sort((a, b) => {
            const aToday = isAbsenceActiveToday(a) ? 0 : 1;
            const bToday = isAbsenceActiveToday(b) ? 0 : 1;
            if (aToday !== bToday) return aToday - bToday;
            return isoToDate(a.type === 'day' ? a.date : a.startDate) - isoToDate(b.type === 'day' ? b.date : b.startDate);
          });

        if (upcoming.length === 0) {
          await replyEph(interaction, { content: '✅ No upcoming absences.' });
          return;
        }

        // Fetch current roles for all members so the dot reflects live role state
        const uniqueIds = [...new Set(upcoming.map(a => a.userId))];
        const memberMap = new Map();
        await Promise.all(uniqueIds.map(async id => {
          const m = await interaction.guild.members.fetch(id).catch(() => null);
          if (m) memberMap.set(id, m);
        }));

        const hasToday = upcoming.some(isAbsenceActiveToday);

        function formatAbsenceLine(a) {
          const isToday    = isAbsenceActiveToday(a);
          const icon       = isToday ? '⚠️' : a.type === 'day' ? '📅' : '📆';
          const dateStr    = a.type === 'day'
            ? formatAbsenceDate(a.date)
            : `${formatAbsenceDate(a.startDate)} → ${formatAbsenceDate(a.endDate)}`;
          const liveMember = memberMap.get(a.userId);
          const dot        = liveMember ? getMemberTimeDot(liveMember) : (a.colorDot ?? '');
          const todayTag   = isToday ? ' **[TODAY]**' : '';
          return `${icon} ${dot ? dot + ' ' : ''}**${a.username}**${todayTag} | ${dateStr}${a.reason ? ` — *${a.reason}*` : ''}`;
        }

        const todayLines  = upcoming.filter(isAbsenceActiveToday).map(formatAbsenceLine);
        const futureLines = upcoming.filter(a => !isAbsenceActiveToday(a)).map(formatAbsenceLine);
        const parts = [];
        if (todayLines.length)  parts.push(todayLines.join('\n'));
        if (futureLines.length) parts.push(futureLines.join('\n'));
        const description = parts.join('\n\n');

        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(hasToday ? 0xFEE75C : 0x5865F2)
            .setTitle('Upcoming Absences')
            .setDescription(description)
            .setFooter({ text: "Melon's Bot" })
          ],
        });
        return;
      }
      // ── /remove-absence ──
      if (interaction.commandName === 'remove-absence') {
        if (!isAbsenceChannel(interaction)) {
          await replyEph(interaction, { content: '❌ This command can only be used in an absences channel.' });
          return;
        }
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const list = getAbsences(interaction.guildId)
          .filter(a => isoToDate(a.type === 'day' ? a.date : a.endDate) >= today)
          .sort((a, b) =>
            isoToDate(a.type === 'day' ? a.date : a.startDate) -
            isoToDate(b.type === 'day' ? b.date : b.startDate)
          );
        if (list.length === 0) {
          await replyEph(interaction, { content: '✅ No absences to remove.' });
          return;
        }
        const options = list.slice(0, 25).map(a => {
          const dateStr = a.type === 'day'
            ? formatAbsenceDate(a.date)
            : `${formatAbsenceDate(a.startDate)} → ${formatAbsenceDate(a.endDate)}`;
          return { label: `${a.username} — ${dateStr}`, description: a.reason ?? undefined, value: a.id };
        });
        await replyEph(interaction, {
          content: 'Select an absence to remove:',
          components: [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('remove_absence_select').setPlaceholder('Choose absence…').addOptions(options)
          )],
        });
        return;
      }

      // ── /drops ──
      if (interaction.commandName === 'drops') {
        const bossName = interaction.options.getString('boss');
        const stats = dropHistory[interaction.guildId]?.[bossName];
        if (!stats) {
          await replyEph(interaction, { content: `❌ No recorded kills for **${bossName}** yet. Use \`/tod\` to start tracking, or \`/scandrops\` to import channel history.` });
          return;
        }
        const total = stats.allyKills + stats.enemyKills + stats.unknownKills;
        const dropPct = total > 0 ? Math.round((stats.drops / total) * 100) : 0;
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`📊 ${bossName} — Drop Statistics`)
            .addFields(
              { name: 'Ally kills',    value: String(stats.allyKills),    inline: true },
              { name: 'Enemy kills',   value: String(stats.enemyKills),   inline: true },
              { name: 'Unknown',       value: String(stats.unknownKills), inline: true },
              { name: 'Total kills',   value: String(total),              inline: false },
              { name: 'Dropped ✅',   value: `${stats.drops} (${dropPct}%)`,            inline: true },
              { name: 'No drop ❌',   value: `${stats.noDrops} (${100 - dropPct}%)`,    inline: true },
            )
            .setFooter({ text: "Melon's Bot" })
          ],
        });
        return;
      }

      // ── /scandrops ──
      if (interaction.commandName === 'scandrops') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const guildBosses = getGuildBosses(interaction.guildId);
        const bossNames = new Map(guildBosses.map(b => [b.name.toLowerCase(), b.name]));
        const newHistory = {};
        let lastId = null;
        let scanned = 0;

        while (true) {
          const opts = { limit: 100 };
          if (lastId) opts.before = lastId;
          const messages = await interaction.channel.messages.fetch(opts).catch(() => null);
          if (!messages || messages.size === 0) break;

          for (const msg of messages.values()) {
            for (const embed of msg.embeds) {
              if (!embed.title) continue;
              const footer = embed.footer?.text ?? '';
              const isRedAlert = embed.title.includes(' Killed by ');
              if (!footer.includes("Melon's Bot") && !isRedAlert) continue;
              const rawName = isRedAlert
                ? embed.title.split(' Killed by ')[0].trim()
                : embed.title.split(' — ')[0].trim();
              const bossName = bossNames.get(rawName.toLowerCase());
              if (!bossName) continue;
              const dropField = embed.fields?.find(f => f.name === 'Drop');
              if (!dropField) continue;
              const killedBy = embed.title.includes('Ally') ? 'ally' : embed.title.includes('Enemy') ? 'enemy' : null;
              const dropped  = dropField.value.includes('✅');
              if (!newHistory[bossName]) newHistory[bossName] = { allyKills: 0, enemyKills: 0, unknownKills: 0, drops: 0, noDrops: 0 };
              const s = newHistory[bossName];
              if (killedBy === 'ally') s.allyKills++;
              else if (killedBy === 'enemy') s.enemyKills++;
              else s.unknownKills++;
              if (dropped) s.drops++; else s.noDrops++;
              scanned++;
            }
          }
          lastId = messages.last()?.id;
          if (messages.size < 100) break;
        }

        dropHistory[interaction.guildId] = newHistory;
        saveDropHistory();

        const bossCount = Object.keys(newHistory).length;
        await interaction.editReply({
          embeds: [new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle('✅ Drop History Scan Complete')
            .setDescription(bossCount > 0
              ? Object.entries(newHistory).map(([name, s]) => {
                  const total = s.allyKills + s.enemyKills + s.unknownKills;
                  const pct   = total > 0 ? Math.round((s.drops / total) * 100) : 0;
                  return `• **${name}** — ${total} kills, ${s.drops} drops (${pct}%)`;
                }).join('\n')
              : '*No TOD records found in this channel.*')
            .addFields({ name: 'Records processed', value: String(scanned), inline: true })
            .setFooter({ text: "Melon's Bot" })
          ],
        });
        return;
      }

      // ── /chars ──
      if (interaction.commandName === 'chars') {
        const boss = interaction.options.getString('composition');

        // Custom: fast-path via text slots, or open ephemeral builder
        if (boss === 'Custom') {
          const slotsInput = interaction.options.getString('slots');
          if (slotsInput) {
            const crystalsEnabled = interaction.options.getBoolean('crystals') ?? false;
            const maxSlots = crystalsEnabled ? 20 : 25;
            const { slots: customSlots, invalid } = parseCustomSlots(slotsInput);
            if (customSlots.length === 0) {
              await replyEph(interaction, { content: `❌ No valid slot types found. Valid: ${CUSTOM_SLOT_TYPES.join(', ')}` });
              return;
            }
            const trimmed = customSlots.slice(0, maxSlots);
            const slots = new Map();
            const startedAt = new Date().toISOString();
            const sessionKey = `${interaction.channelId}:${interaction.user.id}`;
            const state = { boss: 'Custom', slots, crystals: new Map(), messageId: null, startedAt, expireTimer: null, deleteTimer: null, customSlots: trimmed, crystalsEnabled };
            charsState.set(sessionKey, state);

            const note = invalid.length ? `\n⚠️ Skipped unknown: ${invalid.join(', ')}` : '';
            await replyEph(interaction, { content: `✅ Roster posted!${note}` });

            const msg = await interaction.channel.send({
              content: '@everyone',
              embeds: [buildCharsEmbed('Custom', slots, false, new Map(), trimmed)],
              components: buildCharsComponents('Custom', slots, false, trimmed, crystalsEnabled, sessionKey),
            });
            state.messageId = msg.id;
            messageToSession.set(msg.id, sessionKey);

            charsPersisted[sessionKey] = { messageId: msg.id, boss: 'Custom', slots: [], crystals: [], startedAt, customSlots: trimmed, crystalsEnabled, channelId: interaction.channelId };
            saveCharsPersisted();

            state.expireTimer = setTimeout(async () => {
              charsState.delete(sessionKey);
              try {
                const m = await interaction.channel.messages.fetch(state.messageId);
                await m.edit({ embeds: [buildCharsEmbed('Custom', state.slots, true, state.crystals, trimmed)], components: buildCharsComponents('Custom', state.slots, true, trimmed, crystalsEnabled, sessionKey) });
              } catch (_) {}
              state.deleteTimer = setTimeout(async () => {
                try { const m = await interaction.channel.messages.fetch(state.messageId); await m.delete(); } catch (_) {}
                messageToSession.delete(state.messageId);
                delete charsPersisted[sessionKey];
                saveCharsPersisted();
              }, 60 * 60 * 1000);
            }, 4 * 60 * 60 * 1000);

            return;
          }

          pendingCustomBuilders.set(interaction.user.id, { slots: [], crystalsEnabled: false });
          const builder = pendingCustomBuilders.get(interaction.user.id);
          await replyEph(interaction, {
            embeds: [buildCustomBuilderEmbed(builder)],
            components: buildCustomBuilderComponents(builder),
          });
          return;
        }

        // Cancel any existing session in this channel (in-memory or persisted from before restart)
        const old = charsState.get(interaction.channelId);
        if (old) {
          clearTimeout(old.expireTimer);
          clearTimeout(old.deleteTimer);
          try { const oldMsg = await interaction.channel.messages.fetch(old.messageId); await oldMsg.delete(); } catch (_) {}
        } else if (charsPersisted[interaction.channelId]) {
          // Session existed before restart — clean up its orphaned message
          try { const oldMsg = await interaction.channel.messages.fetch(charsPersisted[interaction.channelId].messageId); await oldMsg.delete(); } catch (_) {}
        }
        delete charsPersisted[interaction.channelId];

        const slots = new Map();
        const startedAt = new Date().toISOString();
        const state = { boss, slots, crystals: new Map(), messageId: null, startedAt, expireTimer: null, deleteTimer: null, customSlots: undefined, crystalsEnabled: false };
        charsState.set(interaction.channelId, state);

        await interaction.reply({
          content: '@everyone',
          embeds: [buildCharsEmbed(boss, slots)],
          components: buildCharsComponents(boss, slots, false, undefined, false, interaction.channelId),
        });

        const msg = await interaction.fetchReply();
        state.messageId = msg.id;
        charsPersisted[interaction.channelId] = { messageId: msg.id, boss, slots: [], crystals: [], startedAt };
        saveCharsPersisted();

        // After 4h: disable buttons and mark expired
        state.expireTimer = setTimeout(async () => {
          charsState.delete(interaction.channelId);
          try {
            const m = await interaction.channel.messages.fetch(state.messageId);
            await m.edit({
              embeds: [buildCharsEmbed(boss, slots, true, state.crystals)],
              components: buildCharsComponents(boss, slots, true),
            });
          } catch (_) {}
          // After 1 more hour (5h total): delete message
          state.deleteTimer = setTimeout(async () => {
            try {
              const m = await interaction.channel.messages.fetch(state.messageId);
              await m.delete();
            } catch (_) {}
            delete charsPersisted[interaction.channelId];
            saveCharsPersisted();
          }, 60 * 60 * 1000);
        }, 4 * 60 * 60 * 1000);

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

    if (interaction.isStringSelectMenu() && (interaction.customId === 'chars_crystal_select' || interaction.customId.startsWith('chars_crystal_select|'))) {
      const sessionKey = interaction.customId.includes('|') ? interaction.customId.slice('chars_crystal_select|'.length) : interaction.channelId;
      const state = charsState.get(sessionKey);
      if (!state) { await interaction.update({ content: '❌ Roster has expired.', components: [] }); return; }
      const value = interaction.values[0];
      if (value === 'clear') {
        state.crystals.delete(interaction.user.id);
      } else {
        const [color, level] = value.split('_');
        state.crystals.set(interaction.user.id, { color, level: parseInt(level) });
      }
      if (charsPersisted[sessionKey]) {
        charsPersisted[sessionKey].crystals = [...state.crystals.entries()];
        saveCharsPersisted();
      }
      try {
        const m = await interaction.channel.messages.fetch(state.messageId);
        await m.edit({ embeds: [buildCharsEmbed(state.boss, state.slots, false, state.crystals, state.customSlots)], components: buildCharsComponents(state.boss, state.slots, false, state.customSlots, state.crystalsEnabled, sessionKey) });
      } catch (_) {}
      await interaction.update({ content: '✅ Crystal updated!', components: [] }); autoDelete(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'remove_absence_select') {
      const id = interaction.values[0];
      const guildAbsences = getAbsences(interaction.guildId);
      const idx = guildAbsences.findIndex(a => a.id === id);
      if (idx === -1) {
        await interaction.update({ content: '⚠️ Absence not found (already removed?).', components: [] }); autoDelete(interaction);
        return;
      }
      const removed = guildAbsences.splice(idx, 1)[0];
      saveAbsences();
      const dateStr = removed.type === 'day'
        ? formatAbsenceDate(removed.date)
        : `${formatAbsenceDate(removed.startDate)} → ${formatAbsenceDate(removed.endDate)}`;
      await interaction.update({ content: `✅ Removed: **${removed.username}** — ${dateStr}`, components: [] }); autoDelete(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'select_boss_edit') {
      const boss = findBoss(interaction.guildId, interaction.values[0]);
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

      // ── TOD undo ──
      if (id === 'tod_undo') {
        const undo = pendingTodUndos.get(interaction.user.id);
        pendingTodUndos.delete(interaction.user.id);
        if (!undo) {
          await interaction.update({ content: '⏱️ Undo window has expired.', components: [] });
          return;
        }
        if (alertTimers.has(undo.alertKey))      { clearTimeout(alertTimers.get(undo.alertKey));      alertTimers.delete(undo.alertKey); }
        if (closeAlertTimers.has(undo.alertKey)) { clearTimeout(closeAlertTimers.get(undo.alertKey)); closeAlertTimers.delete(undo.alertKey); }
        delete bossAlerts[undo.alertKey]; saveBossAlerts();
        if (todState[undo.guildId]?.[undo.bossName]) { delete todState[undo.guildId][undo.bossName]; saveTodState(); }
        try { const ch = await client.channels.fetch(undo.channelId); const msg = await ch.messages.fetch(undo.messageId); await msg.delete(); } catch (_) {}

        // Public notification in the TOD channel
        try {
          const ch = await client.channels.fetch(undo.channelId);
          await ch.send({ embeds: [new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle(`↩️ TOD Undone — ${undo.bossName}`)
            .addFields(
              { name: 'Undone by',    value: `${interaction.user}`, inline: false },
              { name: 'TOD was',      value: discordTime(undo.todTime, 'F'),      inline: false },
              { name: 'Window start', value: discordTime(undo.windowStart, 'F'),  inline: true  },
              { name: 'Window end',   value: discordTime(undo.windowEnd, 'F'),    inline: true  },
            )
            .setTimestamp()
          ]});
        } catch (_) {}

        await interaction.update({ content: '✅ TOD undone.', components: [] });
        autoDelete(interaction, 5);
        return;
      }

      // ── Fort undo ──
      if (id === 'fort_undo') {
        const undo = pendingFortUndos.get(interaction.user.id);
        pendingFortUndos.delete(interaction.user.id);
        if (!undo) {
          await interaction.update({ content: '⏱️ Undo window has expired.', components: [] });
          return;
        }
        fortMessages.delete(undo.messageId);
        try { const ch = await client.channels.fetch(undo.channelId); const msg = await ch.messages.fetch(undo.messageId); await msg.delete(); } catch (_) {}
        await interaction.update({ content: '✅ Fort registration undone.', components: [] });
        autoDelete(interaction, 5);
        return;
      }

      // ── WTS / WTB close buttons ──
      if (id.startsWith('listing_close:') || id.startsWith('listing_remove:')) {
        const parts     = id.split(':');
        const action    = parts[0];
        const ownerId   = parts[1];
        const messageId = parts[2];
        if (interaction.user.id !== ownerId) {
          await replyEph(interaction, { content: '❌ Only the person who posted this listing can do that.' });
          return;
        }
        const guildId = interaction.guildId;
        const listing = listings[guildId]?.[messageId];
        if (action === 'listing_remove') {
          const tk = `${guildId}:${messageId}`;
          const t  = listingTimers.get(tk);
          if (t) { clearTimeout(t.expiry); clearTimeout(t.delete); listingTimers.delete(tk); }
          if (listing) { delete listings[guildId][messageId]; saveListings(); }
          await interaction.message.delete().catch(() => {});
          return;
        }
        // listing_close
        if (!listing || listing.status !== 'active') {
          await replyEph(interaction, { content: '❌ Listing is already closed.' });
          return;
        }
        listing.status = listing.type === 'wts' ? 'sold' : 'found';
        saveListings();
        const tk = `${guildId}:${messageId}`;
        const t  = listingTimers.get(tk);
        if (t?.expiry) { clearTimeout(t.expiry); t.expiry = null; }
        await interaction.update({
          ...buildListingMsg(listing),
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`listing_remove:${ownerId}:${messageId}`).setLabel('🗑️ Remove').setStyle(ButtonStyle.Danger)
          )],
        });
        return;
      }

      // Music buttons
      if (id.startsWith('music_') || id === 'radio_stop') { await music.handleButton(interaction); return; }

      // Chars slot buttons: format is chars_slot|{slotNum} (QA/Zaken/Mages) or chars_slot|{sessionKey}|{slotNum} (Custom)
      if (id.startsWith('chars_slot|')) {
        const parts = id.split('|');
        let sessionKey, slotNum;
        if (parts.length === 3) {
          // Custom: embedded sessionKey
          sessionKey = parts[1];
          slotNum    = parseInt(parts[2]);
        } else {
          // QA/Zaken/Mages: keyed by channelId
          sessionKey = interaction.channelId;
          slotNum    = parseInt(parts[1]);
        }
        const displayName = interaction.member?.displayName ?? interaction.user.username;
        const result      = await applyCharsSlot(sessionKey, interaction.user.id, displayName, slotNum);

        if (result === 'expired') {
          await interaction.reply({ content: '❌ This roster has expired.', flags: MessageFlags.Ephemeral }); autoDelete(interaction);
          return;
        }
        if (result === 'taken') {
          const state     = charsState.get(sessionKey);
          const takenById = state?.slots.get(slotNum)?.userId;
          const slotLabel = state ? charsSlotName(state.boss, slotNum, state.customSlots) : String(slotNum);
          if (pendingOverrides.has(interaction.user.id)) {
            const oldP = pendingOverrides.get(interaction.user.id);
            clearTimeout(oldP.promptDeleteTimer);
            if (oldP.promptMsgId) interaction.channel.messages.fetch(oldP.promptMsgId).then(m => m.delete()).catch(() => {});
          }
          pendingOverrides.set(interaction.user.id, { sessionKey, channelId: interaction.channelId, slotNum, displayName, promptMsgId: null, promptDeleteTimer: null });
          await interaction.deferUpdate();
          const notif = await interaction.channel.send({
            content: `<@${interaction.user.id}> **${slotLabel}** is taken by <@${takenById}>. Override?`,
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('chars_override_yes').setLabel('Yes, override').setStyle(ButtonStyle.Danger),
              new ButtonBuilder().setCustomId('chars_override_no').setLabel('No').setStyle(ButtonStyle.Secondary),
            )],
          });
          const pending = pendingOverrides.get(interaction.user.id);
          if (pending) {
            pending.promptMsgId = notif.id;
            pending.promptDeleteTimer = setTimeout(async () => {
              pendingOverrides.delete(interaction.user.id);
              try { await notif.delete(); } catch (_) {}
            }, 4 * 60 * 60 * 1000);
          }
          return;
        }

        const state = charsState.get(sessionKey);
        await interaction.update({
          embeds: [buildCharsEmbed(state.boss, state.slots, false, state.crystals, state.customSlots)],
          components: buildCharsComponents(state.boss, state.slots, false, state.customSlots, state.crystalsEnabled, sessionKey),
        });
        return;
      }

      if (id === 'chars_override_yes' || id === 'chars_override_no') {
        const pending = pendingOverrides.get(interaction.user.id);
        pendingOverrides.delete(interaction.user.id);
        if (pending?.promptDeleteTimer) clearTimeout(pending.promptDeleteTimer);
        if (!pending) {
          await interaction.update({ content: '❌ Override request expired.', components: [] });
          return;
        }
        if (id === 'chars_override_no') {
          await interaction.deferUpdate();
          await interaction.message.delete().catch(() => {});
          return;
        }
        // Confirm override
        const result = await applyCharsSlot(pending.sessionKey, interaction.user.id, pending.displayName, pending.slotNum, true);
        if (result === 'expired') {
          await interaction.update({ content: '❌ This roster has expired.', components: [] });
          return;
        }
        const state = charsState.get(pending.sessionKey);
        try {
          const ch = await client.channels.fetch(pending.channelId);
          const m  = await ch.messages.fetch(state.messageId);
          await m.edit({
            embeds: [buildCharsEmbed(state.boss, state.slots, false, state.crystals, state.customSlots)],
            components: buildCharsComponents(state.boss, state.slots, false, state.customSlots, state.crystalsEnabled, pending.sessionKey),
          });
        } catch (_) {}
        await interaction.deferUpdate();
        await interaction.message.delete().catch(() => {});
        return;
      }


      // ── Custom builder buttons ──────────────────────────────────
      if (id.startsWith('custom_add|')) {
        const type    = id.split('|')[1];
        const builder = pendingCustomBuilders.get(interaction.user.id);
        if (!builder) { await interaction.update({ content: '❌ Builder session expired.', embeds: [], components: [] }); return; }
        const maxSlots = builder.crystalsEnabled ? 20 : 25;
        if (builder.slots.length < maxSlots) {
          const count = builder.slots.filter(s => s.startsWith(type + ' ')).length;
          builder.slots.push(`${type} ${count + 1}`);
        }
        await interaction.update({ embeds: [buildCustomBuilderEmbed(builder)], components: buildCustomBuilderComponents(builder) });
        return;
      }

      if (id === 'custom_undo') {
        const builder = pendingCustomBuilders.get(interaction.user.id);
        if (!builder) { await interaction.update({ content: '❌ Builder session expired.', embeds: [], components: [] }); return; }
        builder.slots.pop();
        await interaction.update({ embeds: [buildCustomBuilderEmbed(builder)], components: buildCustomBuilderComponents(builder) });
        return;
      }

      if (id === 'custom_crystal_toggle') {
        const builder = pendingCustomBuilders.get(interaction.user.id);
        if (!builder) { await interaction.update({ content: '❌ Builder session expired.', embeds: [], components: [] }); return; }
        builder.crystalsEnabled = !builder.crystalsEnabled;
        // If we now have more slots than the new limit, trim the excess
        const maxSlots = builder.crystalsEnabled ? 20 : 25;
        if (builder.slots.length > maxSlots) builder.slots.length = maxSlots;
        await interaction.update({ embeds: [buildCustomBuilderEmbed(builder)], components: buildCustomBuilderComponents(builder) });
        return;
      }

      if (id === 'custom_accept') {
        const builder = pendingCustomBuilders.get(interaction.user.id);
        if (!builder || builder.slots.length === 0) { await interaction.deferUpdate(); return; }
        pendingCustomBuilders.delete(interaction.user.id);

        const customSlots    = builder.slots;
        const crystalsEnabled = builder.crystalsEnabled;
        const slots          = new Map();
        const startedAt      = new Date().toISOString();
        // Custom rosters are per-user — key on channelId + userId to allow multiples
        const sessionKey = `${interaction.channelId}:${interaction.user.id}`;
        const state = { boss: 'Custom', slots, crystals: new Map(), messageId: null, startedAt, expireTimer: null, deleteTimer: null, customSlots, crystalsEnabled };
        charsState.set(sessionKey, state);

        // Dismiss ephemeral builder
        await interaction.update({ content: '✅ Roster posted!', embeds: [], components: [] });

        // Post public roster
        const msg = await interaction.channel.send({
          content: '@everyone',
          embeds: [buildCharsEmbed('Custom', slots, false, new Map(), customSlots)],
          components: buildCharsComponents('Custom', slots, false, customSlots, crystalsEnabled, sessionKey),
        });
        state.messageId = msg.id;
        messageToSession.set(msg.id, sessionKey);

        // Persist
        charsPersisted[sessionKey] = { messageId: msg.id, boss: 'Custom', slots: [], crystals: [], startedAt, customSlots, crystalsEnabled, channelId: interaction.channelId };
        saveCharsPersisted();

        // 4h expire
        state.expireTimer = setTimeout(async () => {
          charsState.delete(sessionKey);
          try {
            const m = await interaction.channel.messages.fetch(state.messageId);
            await m.edit({ embeds: [buildCharsEmbed('Custom', state.slots, true, state.crystals, customSlots)], components: buildCharsComponents('Custom', state.slots, true, customSlots, crystalsEnabled, sessionKey) });
          } catch (_) {}
          // 5h total: delete
          state.deleteTimer = setTimeout(async () => {
            try { const m = await interaction.channel.messages.fetch(state.messageId); await m.delete(); } catch (_) {}
            messageToSession.delete(state.messageId);
            delete charsPersisted[sessionKey];
            saveCharsPersisted();
          }, 60 * 60 * 1000);
        }, 4 * 60 * 60 * 1000);

        return;
      }

      if (id === 'custom_cancel') {
        pendingCustomBuilders.delete(interaction.user.id);
        await interaction.update({ content: '❌ Cancelled.', embeds: [], components: [] });
        autoDelete(interaction);
        return;
      }

      // ── Roster edit buttons ──────────────────────────────────────
      if (id.startsWith('chars_edit|')) {
        const sessionKey = id.slice('chars_edit|'.length);
        const state = charsState.get(sessionKey);
        if (!state) { await interaction.reply({ content: '❌ This roster has expired.', flags: MessageFlags.Ephemeral }); autoDelete(interaction); return; }
        // Unified editor for all boss types — seed with the boss's current slot list
        const initialSlots = getBossSlotList(state.boss, state.customSlots);
        const editorSlots  = initialSlots.map((name, i) => ({ id: `orig_${i}`, name }));
        pendingCustomEditors.set(interaction.user.id, { sessionKey, boss: state.boss, slots: editorSlots, crystalsEnabled: state.crystalsEnabled, view: 'add' });
        const editor = pendingCustomEditors.get(interaction.user.id);
        await interaction.reply({ embeds: [buildCharsEditEmbed(editor, state)], components: buildCharsEditAddComponents(editor, sessionKey), flags: MessageFlags.Ephemeral });
        autoDelete(interaction, 15 * 60);
        return;
      }

      if (id.startsWith('chars_edit_type|')) {
        const parts = id.split('|');
        const type = parts[1];
        const sessionKey = parts[2];
        const editor = pendingCustomEditors.get(interaction.user.id);
        if (!editor || editor.sessionKey !== sessionKey) { await interaction.update({ content: '❌ Editor session expired.', embeds: [], components: [] }); return; }
        const state = charsState.get(sessionKey);
        if (!state) { await interaction.update({ content: '❌ Roster has expired.', embeds: [], components: [] }); return; }
        const maxSlots = editor.crystalsEnabled ? 20 : 25;
        if (editor.slots.length < maxSlots) {
          const count = editor.slots.filter(s => s.name.startsWith(type + ' ')).length;
          editor.slots.push({ id: `new_${Date.now()}${Math.random().toString(36).slice(2, 6)}`, name: `${type} ${count + 1}` });
        }
        await interaction.update({ embeds: [buildCharsEditEmbed(editor, state)], components: buildCharsEditAddComponents(editor, sessionKey) });
        return;
      }

      if (id.startsWith('chars_edit_undo|')) {
        const sessionKey = id.slice('chars_edit_undo|'.length);
        const editor = pendingCustomEditors.get(interaction.user.id);
        if (!editor || editor.sessionKey !== sessionKey) { await interaction.update({ content: '❌ Editor session expired.', embeds: [], components: [] }); return; }
        const state = charsState.get(sessionKey);
        if (!state) { await interaction.update({ content: '❌ Roster has expired.', embeds: [], components: [] }); return; }
        // Only undo newly added slots (not original ones)
        const lastNewIdx = editor.slots.map((s, i) => s.id.startsWith('orig_') ? -1 : i).filter(i => i >= 0).pop();
        if (lastNewIdx !== undefined) editor.slots.splice(lastNewIdx, 1);
        await interaction.update({ embeds: [buildCharsEditEmbed(editor, state)], components: buildCharsEditAddComponents(editor, sessionKey) });
        return;
      }

      if (id.startsWith('chars_edit_remove_view|')) {
        const sessionKey = id.slice('chars_edit_remove_view|'.length);
        const editor = pendingCustomEditors.get(interaction.user.id);
        if (!editor || editor.sessionKey !== sessionKey) { await interaction.update({ content: '❌ Editor session expired.', embeds: [], components: [] }); return; }
        const state = charsState.get(sessionKey);
        if (!state) { await interaction.update({ content: '❌ Roster has expired.', embeds: [], components: [] }); return; }
        editor.view = 'remove';
        await interaction.update({ embeds: [buildCharsEditEmbed(editor, state)], components: buildCharsEditRemoveComponents(editor, state, sessionKey) });
        return;
      }

      if (id.startsWith('chars_edit_remove_slot|')) {
        const parts = id.split('|');
        const slotId = parts[1];
        const sessionKey = parts[2];
        const editor = pendingCustomEditors.get(interaction.user.id);
        if (!editor || editor.sessionKey !== sessionKey) { await interaction.update({ content: '❌ Editor session expired.', embeds: [], components: [] }); return; }
        const state = charsState.get(sessionKey);
        if (!state) { await interaction.update({ content: '❌ Roster has expired.', embeds: [], components: [] }); return; }
        const idx = editor.slots.findIndex(s => s.id === slotId);
        if (idx !== -1) editor.slots.splice(idx, 1);
        editor.view = 'add';
        await interaction.update({ embeds: [buildCharsEditEmbed(editor, state)], components: buildCharsEditAddComponents(editor, sessionKey) });
        return;
      }

      if (id.startsWith('chars_edit_back|')) {
        const sessionKey = id.slice('chars_edit_back|'.length);
        const editor = pendingCustomEditors.get(interaction.user.id);
        if (!editor || editor.sessionKey !== sessionKey) { await interaction.update({ content: '❌ Editor session expired.', embeds: [], components: [] }); return; }
        const state = charsState.get(sessionKey);
        if (!state) { await interaction.update({ content: '❌ Roster has expired.', embeds: [], components: [] }); return; }
        editor.view = 'add';
        await interaction.update({ embeds: [buildCharsEditEmbed(editor, state)], components: buildCharsEditAddComponents(editor, sessionKey) });
        return;
      }

      if (id.startsWith('chars_edit_crystal|')) {
        const sessionKey = id.slice('chars_edit_crystal|'.length);
        const editor = pendingCustomEditors.get(interaction.user.id);
        if (!editor || editor.sessionKey !== sessionKey) { await interaction.update({ content: '❌ Editor session expired.', embeds: [], components: [] }); return; }
        const state = charsState.get(sessionKey);
        if (!state) { await interaction.update({ content: '❌ Roster has expired.', embeds: [], components: [] }); return; }
        editor.crystalsEnabled = !editor.crystalsEnabled;
        const maxSlots = editor.crystalsEnabled ? 20 : 25;
        if (editor.slots.length > maxSlots) editor.slots.length = maxSlots;
        editor.view = 'add';
        await interaction.update({ embeds: [buildCharsEditEmbed(editor, state)], components: buildCharsEditAddComponents(editor, sessionKey) });
        return;
      }

      if (id.startsWith('chars_edit_apply|')) {
        const sessionKey = id.slice('chars_edit_apply|'.length);
        const editor = pendingCustomEditors.get(interaction.user.id);
        if (!editor || editor.sessionKey !== sessionKey) { await interaction.update({ content: '❌ Editor session expired.', embeds: [], components: [] }); return; }
        pendingCustomEditors.delete(interaction.user.id);
        const ok = applyCharsEdit(sessionKey, editor);
        if (!ok) { await interaction.update({ content: '❌ Roster has expired.', embeds: [], components: [] }); return; }
        const state = charsState.get(sessionKey);
        // Update the public roster message
        try {
          const channelId = charsPersisted[sessionKey]?.channelId ?? sessionKey.split(':')[0];
          const ch = await client.channels.fetch(channelId);
          const m  = await ch.messages.fetch(state.messageId);
          await m.edit({
            embeds: [buildCharsEmbed('Custom', state.slots, false, state.crystals, state.customSlots)],
            components: buildCharsComponents('Custom', state.slots, false, state.customSlots, state.crystalsEnabled, sessionKey),
          });
        } catch (_) {}
        await interaction.update({ content: '✅ Roster updated!', embeds: [], components: [] });
        autoDelete(interaction);
        return;
      }

      if (id.startsWith('chars_edit_cancel|')) {
        const sessionKey = id.slice('chars_edit_cancel|'.length);
        pendingCustomEditors.delete(interaction.user.id);
        await interaction.update({ content: '❌ Edit cancelled. No changes made.', embeds: [], components: [] });
        autoDelete(interaction);
        return;
      }

      // Crystal button — show select menu. Format: chars_crystal (Zaken) or chars_crystal|{sessionKey} (Custom)
      if (id === 'chars_crystal' || id.startsWith('chars_crystal|')) {
        const sessionKey = id.includes('|') ? id.slice('chars_crystal|'.length) : interaction.channelId;
        const state = charsState.get(sessionKey);
        if (!state) { await interaction.reply({ content: '❌ This roster has expired.', flags: MessageFlags.Ephemeral }); autoDelete(interaction); return; }
        const hasSlot = [...state.slots.values()].some(e => e.userId === interaction.user.id);
        if (!hasSlot) { await interaction.reply({ content: '❌ You need to sign up for a slot first.', flags: MessageFlags.Ephemeral }); autoDelete(interaction); return; }
        // Embed sessionKey in the select menu so the handler knows which session to update
        const selectId = id.includes('|') ? `chars_crystal_select|${sessionKey}` : 'chars_crystal_select';
        await interaction.reply({
          content: 'Select your crystal:',
          flags: MessageFlags.Ephemeral,
          components: [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(selectId).setPlaceholder('Choose crystal…').addOptions(CRYSTAL_OPTIONS)
          )],
        });
        autoDelete(interaction);
        return;
      }

      // Boss options
      if (id === 'back_to_options') {
        await interaction.update({ embeds: [buildOptionsEmbed(interaction.guildId)], components: buildOptionsComponents(interaction.guildId) });
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
        const boss = findBoss(interaction.guildId, id.split('|')[1]);
        await interaction.showModal(new ModalBuilder().setCustomId(`modal_edit_boss|${boss.name}`).setTitle(`Edit ${boss.name}`).addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('boss_name').setLabel('Boss Name').setStyle(TextInputStyle.Short).setRequired(true).setValue(boss.name)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('spawn_hours').setLabel('Spawn Time (hours)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(boss.spawnHours))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('window_hours').setLabel('Window Duration (hours)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(boss.windowHours))),
        ));
        return;
      }

      if (id.startsWith('delete_boss|')) {
        const bossName = id.split('|')[1];
        const guildBosses = getGuildBosses(interaction.guildId);
        const deleted = guildBosses.find(b => b.name === bossName);
        const index = guildBosses.findIndex(b => b.name === bossName);
        if (index !== -1) { guildBosses.splice(index, 1); saveBosses(); }
        await interaction.update({ content: `✅ **${bossName}** deleted.`, embeds: [buildOptionsEmbed(interaction.guildId)], components: buildOptionsComponents(interaction.guildId) });
        const actor = interaction.member?.displayName ?? interaction.user.username;
        const ch = interaction.channel ?? await client.channels.fetch(interaction.channelId);
        await ch.send({
          embeds: [new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle('Boss Removed')
            .setDescription(`**${actor}** removed **${bossName}**${deleted ? `\n**Spawn time:** ${deleted.spawnHours}h\n**Window time:** ${deleted.windowHours}h` : ''}`)
            .setTimestamp()
          ],
        });
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
          const hasTime = /\s+\d{1,2}:?\d{2}$/.test(dateStr);
          dateDisplay = `<t:${Math.floor(parsedDate.getTime() / 1000)}:${hasTime ? 'F' : 'D'}>`;
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
        getGuildBosses(interaction.guildId).push({ name, spawnHours, windowHours });
        saveBosses();
        await interaction.deferUpdate();
        const actor = interaction.member?.displayName ?? interaction.user.username;
        const addCh = await client.channels.fetch(interaction.channelId);
        await addCh.send({
          embeds: [new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle('Boss Added')
            .setDescription(`**${actor}** added a new boss:\n**Boss name:** ${name}\n**Spawn time:** ${spawnHours}h\n**Window time:** ${windowHours}h`)
            .setTimestamp()
          ],
        });
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
        const boss = getGuildBosses(interaction.guildId).find(b => b.name === oldName);
        const oldSpawn  = boss?.spawnHours;
        const oldWindow = boss?.windowHours;
        if (boss) { boss.name = newName; boss.spawnHours = spawnHours; boss.windowHours = windowHours; saveBosses(); }
        await interaction.deferUpdate();
        const actor = interaction.member?.displayName ?? interaction.user.username;
        const lines = [];
        if (oldName !== newName)       lines.push(`**Boss name:** ${oldName} → ${newName}`);
        if (oldSpawn  !== spawnHours)  lines.push(`**Spawn time:** ${oldSpawn}h → ${spawnHours}h`);
        if (oldWindow !== windowHours) lines.push(`**Window time:** ${oldWindow}h → ${windowHours}h`);
        if (lines.length > 0) {
          const editCh = await client.channels.fetch(interaction.channelId);
          await editCh.send({
            embeds: [new EmbedBuilder()
              .setColor(0xFEE75C)
              .setTitle('Boss Updated')
              .setDescription(`**${actor}** updated **${oldName !== newName ? `${oldName} → ${newName}` : newName}**:\n${lines.join('\n')}`)
              .setTimestamp()
            ],
          });
        }
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

        const dayDot = getMemberTimeDot(interaction.member);
        getAbsences(interaction.guildId).push({ id: Date.now().toString(), userId: interaction.user.id, username: interaction.member?.displayName || interaction.user.username, colorDot: dayDot, type: 'day', date: toISO(date), reason, timestamp: new Date().toISOString() });
        saveAbsences();

        await interaction.channel.send({
          embeds: [new EmbedBuilder()
            .setColor(interaction.member?.displayColor || 0x5865F2).setTitle('📅 Day Off Reported')
            .addFields(
              { name: 'Who',  value: `${dayDot ? dayDot + ' ' : ''}${interaction.user}`,         inline: true },
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

        const periodDot = getMemberTimeDot(interaction.member);
        getAbsences(interaction.guildId).push({ id: Date.now().toString(), userId: interaction.user.id, username: interaction.member?.displayName || interaction.user.username, colorDot: periodDot, type: 'period', startDate: toISO(startDate), endDate: toISO(endDate), reason, timestamp: new Date().toISOString() });
        saveAbsences();

        await interaction.channel.send({
          embeds: [new EmbedBuilder()
            .setColor(interaction.member?.displayColor || 0xFFA500).setTitle('📆 Absence Period Reported')
            .addFields(
              { name: 'Who',  value: `${periodDot ? periodDot + ' ' : ''}${interaction.user}`,                  inline: false },
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
      if (interaction.replied || interaction.deferred) {
        const msg = await interaction.followUp(errPayload);
        setTimeout(() => msg.delete().catch(() => {}), 2 * 60 * 1000);
      } else { await interaction.reply(errPayload); autoDelete(interaction); }
    } catch (_) {}
  }
});

// ── Image upload listener ──────────────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  // ── Chars chat shortcut (QA/Zaken/Mages only — Custom is button-only) ─
  const charsSession = charsState.get(message.channelId);
  if (charsSession && charsSession.boss !== 'Custom') {
    const sessionKey = message.channelId;
    // Crystal input (Zaken only)
    if (charsSession.boss === 'Low Zaken' || charsSession.boss === 'High Zaken') {
      const crystal = parseCrystalInput(message.content);
      if (crystal) {
        const hasSlot = [...charsSession.slots.values()].some(e => e.userId === message.author.id);
        if (hasSlot) {
          charsSession.crystals.set(message.author.id, crystal);
          if (charsPersisted[sessionKey]) {
            charsPersisted[sessionKey].crystals = [...charsSession.crystals.entries()];
            saveCharsPersisted();
          }
          try { await message.delete(); } catch (_) {}
          try {
            const m = await message.channel.messages.fetch(charsSession.messageId);
            await m.edit({ embeds: [buildCharsEmbed(charsSession.boss, charsSession.slots, false, charsSession.crystals)], components: buildCharsComponents(charsSession.boss, charsSession.slots) });
          } catch (_) {}
          return;
        }
      }
    }

    const slotNum = parseCharsInput(charsSession.boss, message.content);

    if (slotNum !== null) {
      try { await message.delete(); } catch (_) {}

      const member      = await message.guild?.members.fetch(message.author.id).catch(() => null);
      const displayName = member?.displayName ?? message.author.username;
      const result      = await applyCharsSlot(sessionKey, message.author.id, displayName, slotNum);

      if (result === 'taken') {
        const takenById = charsSession.slots.get(slotNum)?.userId;
        const slotLabel = charsSlotName(charsSession.boss, slotNum);
        // Cancel any previous override prompt for this user
        if (pendingOverrides.has(message.author.id)) {
          const oldP = pendingOverrides.get(message.author.id);
          clearTimeout(oldP.promptDeleteTimer);
          if (oldP.promptMsgId) { message.channel.messages.fetch(oldP.promptMsgId).then(m => m.delete()).catch(() => {}); }
        }
        pendingOverrides.set(message.author.id, { sessionKey, channelId: message.channelId, slotNum, displayName, promptMsgId: null, promptDeleteTimer: null });
        const notif = await message.channel.send({
          content: `<@${message.author.id}> **${slotLabel}** is taken by <@${takenById}>. Override?`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('chars_override_yes').setLabel('Yes, override').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('chars_override_no').setLabel('No').setStyle(ButtonStyle.Secondary),
          )],
        });
        const pending = pendingOverrides.get(message.author.id);
        if (pending) {
          pending.promptMsgId = notif.id;
          pending.promptDeleteTimer = setTimeout(async () => {
            pendingOverrides.delete(message.author.id);
            try { await notif.delete(); } catch (_) {}
          }, 4 * 60 * 60 * 1000);
        }
        return;
      }

      if (result !== 'expired') {
        try {
          const m = await message.channel.messages.fetch(charsSession.messageId);
          await m.edit({
            embeds: [buildCharsEmbed(charsSession.boss, charsSession.slots, false, charsSession.crystals)],
            components: buildCharsComponents(charsSession.boss, charsSession.slots),
          });
        } catch (_) {}
      }
      return;
    }
  }

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
