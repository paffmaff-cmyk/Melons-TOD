const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType,
} = require('@discordjs/voice');
const play      = require('play-dl');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { execSync } = require('child_process');
let ffmpegPath;
try { execSync('ffmpeg -version', { stdio: 'ignore' }); ffmpegPath = 'ffmpeg'; }
catch { ffmpegPath = require('ffmpeg-static'); }
const { spawn } = require('child_process');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');

const YTDLP_PATH   = path.join(__dirname, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const STATE_FILE   = path.join(__dirname, 'music_state.json');
const HISTORY_FILE = path.join(__dirname, 'music_history.json');
const IDLE_TIMEOUT = 2 * 60 * 1000;

// ── yt-dlp bootstrap ──────────────────────────────────────────

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP_PATH)) return;
  console.log('[Music] Downloading yt-dlp.exe …');
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(YTDLP_PATH);
    const get  = (url, hops = 0) => {
      if (hops > 5) return reject(new Error('Too many redirects'));
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location, hops + 1);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        res.pipe(file);
        file.on('finish', () => { file.close(); if (process.platform !== 'win32') fs.chmodSync(YTDLP_PATH, 0o755); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    };
    const asset = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    get(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`);
  });
  console.log('[Music] yt-dlp.exe ready.');
}

function updateYtDlp() {
  if (!fs.existsSync(YTDLP_PATH)) return;
  console.log('[Music] Checking yt-dlp for updates …');
  spawn(YTDLP_PATH, ['-U'], { stdio: 'inherit' }).on('error', () => {});
}

// ── Persistence ───────────────────────────────────────────────

let musicState   = fs.existsSync(STATE_FILE)   ? JSON.parse(fs.readFileSync(STATE_FILE,   'utf8')) : {};
let musicHistory = fs.existsSync(HISTORY_FILE) ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) : {};

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(musicState, null, 2));
}
function saveHistory() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(musicHistory, null, 2));
}

function addToHistory(guildId, track) {
  if (!musicHistory[guildId]) musicHistory[guildId] = [];
  // avoid consecutive duplicates
  const last = musicHistory[guildId].at(-1);
  if (last?.url === track.url) return;
  musicHistory[guildId].push({ ...track, playedAt: new Date().toISOString() });
  saveHistory();
}

// ── Radio stations ────────────────────────────────────────────
const RADIO_FILE = path.join(__dirname, 'radio_stations.json');
if (!fs.existsSync(RADIO_FILE)) fs.copyFileSync(path.join(__dirname, 'radio_stations.default.json'), RADIO_FILE);
let radioStations = JSON.parse(fs.readFileSync(RADIO_FILE, 'utf8'));

// ── Provider state ────────────────────────────────────────────
const PROVIDER_FILE = path.join(__dirname, 'music_provider.json');
let providerState = fs.existsSync(PROVIDER_FILE) ? JSON.parse(fs.readFileSync(PROVIDER_FILE, 'utf8')) : {};

function getProvider(guildId) { return providerState[guildId] ?? 'youtube'; }
function setProvider(guildId, provider) {
  providerState[guildId] = provider;
  fs.writeFileSync(PROVIDER_FILE, JSON.stringify(providerState, null, 2));
}

// ── Pending searches ──────────────────────────────────────────
const pendingSearches = new Map(); // userId → { results, expires }

// ── Sessions ──────────────────────────────────────────────────
const sessions = new Map(); // guildId → Session

class Session {
  constructor(guildId) {
    this.guildId      = guildId;
    this.queue        = (musicState[guildId]?.queue ?? []).slice(); // restore queue from state
    this.currentIndex = 0;
    this.player       = createAudioPlayer();
    this.connection   = null;
    this.listMessage  = null;  // resolved on first updateListMessage
    this.listChannel  = null;
    this.playing      = false;
    this._loading      = false; // guard against concurrent _playNext calls
    this._idleTimer    = null;
    this._idleDeadline = null; // unix ms when queue will be wiped

    this.player.on('stateChange', (o, n) =>
      console.log(`[Music] Player: ${o.status} → ${n.status}`)
    );

    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this._loading) return;
      const current = this.queue[this.currentIndex];
      if (current?.isRadio) { setTimeout(() => this._playNext(), 3000); return; }
      this.currentIndex++;
      this._playNext();
    });

    this.player.on('error', err => {
      console.error('[Music] Player error:', err.message);
      if (this._loading) return;
      const current = this.queue[this.currentIndex];
      if (current?.isRadio) { setTimeout(() => this._playNext(), 3000); return; }
      this.currentIndex++;
      this._playNext();
    });
  }

  _startIdleTimer() {
    this._clearIdleTimer();
    this._idleDeadline = Date.now() + IDLE_TIMEOUT;
    this._idleTimer = setTimeout(async () => {
      console.log('[Music] Idle timeout — disconnecting.');
      this._disconnect();
      sessions.delete(this.guildId);
      delete musicState[this.guildId];
      saveState();
      await this.updateListMessage();
    }, IDLE_TIMEOUT);
  }

  _clearIdleTimer() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    this._idleDeadline = null;
  }

  _disconnect() {
    this._clearIdleTimer();
    this.player.stop(true);
    this.connection?.destroy();
    this.connection = null;
    this.playing    = false;
  }

  async _playNext() {
    if (this._loading) return;

    if (this.currentIndex >= this.queue.length) {
      this.playing = false;
      this._saveQueueState();
      await this.updateListMessage();
      this._startIdleTimer();
      return;
    }

    this._loading = true;
    this._clearIdleTimer();

    const track = this.queue[this.currentIndex];
    console.log(`[Music] Playing: ${track.title}`);
    addToHistory(this.guildId, track);
    this._saveQueueState();

    try {
      const resource = track.isRadio
        ? await createRadioResource(track.url)
        : await createStreamResource(track.url, track.provider ?? 'youtube');
      this._loading = false;
      this.player.play(resource);
      this.playing = true;
      await this.updateListMessage();
    } catch (err) {
      console.error('[Music] Stream error:', err.message);
      this._loading = false;
      this.currentIndex++;
      await this._playNext();
    }
  }

  async connect(voiceChannel) {
    if (this.connection) return; // already connected
    this.connection = joinVoiceChannel({
      channelId:      voiceChannel.id,
      guildId:        voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 10_000);
    } catch {
      this.connection.destroy();
      this.connection = null;
      throw new Error('Could not connect to voice channel.');
    }
    this.connection.subscribe(this.player);
  }

  async startFrom(index, voiceChannel) {
    await this.connect(voiceChannel);
    this.currentIndex = index;
    await this._playNext();
  }

  async jumpTo(index) {
    if (index < 0 || index >= this.queue.length) return;
    this._clearIdleTimer();
    this._loading = true;       // block the Idle handler that player.stop() will trigger
    this.player.stop();
    this.currentIndex = index;
    this._loading = false;
    await this._playNext();
  }

  skip() {
    if (this._loading) return;
    this.player.stop(); // triggers Idle → currentIndex++ → _playNext
  }

  async stopPlayback() {
    this._disconnect();
    this._startIdleTimer(); // queue wipes after 2 min of inactivity
    this._saveQueueState();
    await this.updateListMessage();
  }

  clearQueue() {
    this._disconnect();
    this.queue        = [];
    this.currentIndex = 0;
    this._saveQueueState();
  }

  addTrack(track) {
    this.queue.push(track);
    this._clearIdleTimer();
    this._saveQueueState();
  }

  _saveQueueState() {
    musicState[this.guildId] = {
      queue:        this.queue,
      currentIndex: this.currentIndex,
      listChannelId:  this.listChannel?.id ?? musicState[this.guildId]?.listChannelId,
      listMessageId:  this.listMessage?.id  ?? musicState[this.guildId]?.listMessageId,
    };
    saveState();
  }

  async resolveListMessage(guild) {
    // Try to restore the existing message from saved state
    if (this.listMessage) return;
    const saved = musicState[this.guildId];
    if (saved?.listChannelId && saved?.listMessageId) {
      try {
        const ch = await guild.channels.fetch(saved.listChannelId);
        this.listChannel = ch;
        this.listMessage = await ch.messages.fetch(saved.listMessageId);
        return;
      } catch { /* message deleted or channel gone */ }
    }
    // Fall back: find any channel with "music" in name
    this.listChannel = guild.channels.cache.find(c => c.isTextBased() && c.name.toLowerCase().includes('music')) ?? null;
  }

  async updateListMessage() {
    if (!this.listChannel) return;
    const embed      = buildQueueEmbed(this);
    const components = buildQueueComponents(this);
    try {
      if (this.listMessage) {
        await this.listMessage.edit({ embeds: [embed], components });
      } else {
        this.listMessage = await this.listChannel.send({ embeds: [embed], components });
        this._saveQueueState();
      }
    } catch {
      try {
        this.listMessage = await this.listChannel.send({ embeds: [embed], components });
        this._saveQueueState();
      } catch { /* ignore */ }
    }
  }
}

// ── yt-dlp audio resource ─────────────────────────────────────

function createYtDlpResource(url) {
  return new Promise((resolve, reject) => {
    const cookiesFile = path.join(__dirname, 'cookies.txt');
    // Multiple player clients + Deno JS runtime for JS challenge solving
    const ytdlpArgs = [
      '-f', 'bestaudio*/best',
      '--no-playlist',
      '-o', '-',
      '--quiet',
      '--extractor-args', 'youtube:player_client=ios,android',
      '--js-runtimes', 'deno:node',
    ];
    if (fs.existsSync(cookiesFile)) ytdlpArgs.push('--cookies', cookiesFile);
    ytdlpArgs.push(url);
    // Ensure Deno is in PATH when spawned from Node (not inherited by default)
    const spawnEnv = {
      ...process.env,
      PATH: `${process.env.PATH}:/root/.deno/bin:/root/.local/bin`,
    };
    const ytdlp = spawn(YTDLP_PATH, ytdlpArgs, { env: spawnEnv });
    const ffmpeg = spawn(ffmpegPath, [
      '-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'ignore'] });

    ytdlp.stdout.pipe(ffmpeg.stdin);
    ytdlp.on('error',       () => {});
    ffmpeg.on('error',      () => {});
    ffmpeg.stdin.on('error',() => {});
    ytdlp.stdout.on('error',() => {});
    ytdlp.stderr.on('data', d => { const m = d.toString(); if (m.includes('ERROR')) console.error('[yt-dlp]', m.trim()); });

    ffmpeg.stdout.once('readable', () => {
      resolve(createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw }));
    });
    ffmpeg.stdout.on('error', () => {});

    // Reject if yt-dlp exits with no data
    ytdlp.on('close', code => { if (code !== 0) reject(new Error(`yt-dlp exited with code ${code}`)); });
  });
}

async function createStreamResource(url, provider) {
  if (provider === 'soundcloud') {
    const stream = await play.stream(url);
    return createAudioResource(stream.stream, { inputType: stream.type });
  }
  return createYtDlpResource(url);
}

function createRadioResource(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const ffmpeg = spawn(ffmpegPath, [
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', url,
      '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrBuf = '';
    ffmpeg.stderr.on('data', d => {
      const s = d.toString();
      stderrBuf += s;
      console.error('[Radio ffmpeg]', s.trim());
    });
    ffmpeg.stdout.once('readable', () => {
      done(resolve, createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw }));
    });
    ffmpeg.on('error', err => done(reject, err));
    ffmpeg.stdout.on('error', () => {});
    ffmpeg.on('close', code => {
      if (code !== 0) done(reject, new Error(`ffmpeg exited (${code}): ${stderrBuf.split('\n').pop()?.trim() ?? ''}`));
    });
  });
}

// ── Embed / component builders ────────────────────────────────

function fmt(sec) {
  if (!sec) return '?:??';
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function buildQueueEmbed(session) {
  const embed = new EmbedBuilder().setColor(0x1db954).setTitle('🎵 Music Queue');

  if (!session.queue.length) {
    return embed.setDescription('Queue is empty — use `/play <song>` to add tracks.');
  }

  const lines = session.queue.map((t, i) => {
    const isCurrent = i === session.currentIndex;
    const prefix = isCurrent && session.playing ? '▶️' : `\`${i + 1}.\``;
    return `${prefix} **${t.title}** (${fmt(t.duration)}) — <@${t.requestedBy}>`;
  });

  embed.setDescription(lines.join('\n'));

  const current = session.queue[session.currentIndex];
  if (current && session.playing) {
    embed.setThumbnail(current.thumbnail ?? null);
    embed.setFooter({ text: `Now playing: ${current.title}` });
  } else if (session._idleDeadline) {
    const ts = Math.floor(session._idleDeadline / 1000);
    embed.setFooter({ text: `Queue clears <t:${ts}:R> — click a song or /play to resume.` });
  } else {
    embed.setFooter({ text: 'Queue cleared.' });
  }
  return embed;
}

function buildQueueComponents(session) {
  if (!session.queue.length) return [];
  const rows = [];

  // Row 1: playback controls
  const controls = [
    new ButtonBuilder().setCustomId('music_stop').setLabel('⏹ Stop').setStyle(ButtonStyle.Danger).setDisabled(!session.playing),
    new ButtonBuilder().setCustomId('music_clear').setLabel('🗑 Clear Queue').setStyle(ButtonStyle.Secondary),
  ];
  if (session.playing) {
    controls.unshift(new ButtonBuilder().setCustomId('music_skip').setLabel('⏭ Skip').setStyle(ButtonStyle.Primary));
  }
  rows.push(new ActionRowBuilder().addComponents(...controls));

  // Rows 2-5: one button per queued song (skip currently playing, show all others)
  // One song per row (vertical list), max 4 rows left after controls row
  const buttons = session.queue
    .map((t, i) => ({ t, i }))
    .filter(({ i }) => !(i === session.currentIndex && session.playing))
    .slice(0, 4);

  for (const { t, i } of buttons) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`music_jump_${i}`)
        .setLabel(`${i + 1}. ${t.title.slice(0, 77)}`)
        .setStyle(i < session.currentIndex ? ButtonStyle.Secondary : ButtonStyle.Success)
    ));
  }

  return rows.slice(0, 5);
}

// ── Search embed ──────────────────────────────────────────────

function buildSearchComponents(results) {
  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('music_search_select')
      .setPlaceholder('Choose a song…')
      .addOptions(results.map((v, i) => ({
        label:       `${(v.name ?? v.title)?.slice(0, 90) ?? 'Unknown'}`,
        description: `${fmt(v.durationInSec ?? 0)} — ${v.channel?.name?.slice(0, 40) ?? ''}`,
        value:       String(i),
      })))
  )];
}

// ── Auto-delete helper ────────────────────────────────────────
function autoDelete(interaction, ms = 8000) {
  setTimeout(() => interaction.deleteReply().catch(() => {}), ms);
}

// ── Session helpers ───────────────────────────────────────────

function getOrCreateSession(guildId) {
  const isNew = !sessions.has(guildId);
  if (isNew) sessions.set(guildId, new Session(guildId));
  return { session: sessions.get(guildId), isNew };
}

// ── Public API ────────────────────────────────────────────────

async function handlePlay(interaction) {
  const query      = interaction.options.getString('query');
  const voiceState = interaction.member.voice;

  if (!voiceState?.channel) {
    await interaction.reply({ content: '❌ Join a voice channel first.', flags: 64 });
    autoDelete(interaction);
    return;
  }

  await interaction.deferReply({ flags: 64 });

  const provider = getProvider(interaction.guildId);
  if (provider === 'youtube') await ensureYtDlp();

  let results;
  try {
    if (provider === 'soundcloud') {
      results = await play.search(query, { limit: 10, source: { soundcloud: 'tracks' } });
    } else {
      results = await play.search(query, { limit: 10, source: { youtube: 'video' } });
    }
  } catch (err) {
    await interaction.editReply(`❌ Search failed: ${err.message}`);
    autoDelete(interaction);
    return;
  }

  if (!results.length) {
    await interaction.editReply('❌ No results found.');
    autoDelete(interaction);
    return;
  }

  pendingSearches.set(interaction.user.id, { results, provider, expires: Date.now() + 60_000 });

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(0x1db954).setTitle('🔍 Search Results').setDescription('Select a song to add to the queue:')],
    components: buildSearchComponents(results),
  });
}

async function handleSearchSelect(interaction) {
  const pending = pendingSearches.get(interaction.user.id);
  if (!pending || Date.now() > pending.expires) {
    await interaction.update({ content: '⚠️ Search expired — run `/play` again.', embeds: [], components: [] });
    autoDelete(interaction);
    return;
  }

  const voiceChannel = interaction.member.voice?.channel;
  if (!voiceChannel) {
    await interaction.update({ content: '❌ Join a voice channel first.', embeds: [], components: [] });
    autoDelete(interaction);
    return;
  }

  const video = pending.results[parseInt(interaction.values[0])];
  const provider = pending.provider ?? 'youtube';
  pendingSearches.delete(interaction.user.id);

  const track = {
    title:       video.name ?? video.title ?? 'Unknown',
    url:         video.url ?? `https://www.youtube.com/watch?v=${video.id}`,
    thumbnail:   video.thumbnail ?? video.thumbnails?.[0]?.url ?? null,
    duration:    video.durationInSec ?? 0,
    requestedBy: interaction.user.id,
    provider,
  };

  await interaction.update({ content: `✅ Added **${track.title}** to the queue.`, embeds: [], components: [] });
  autoDelete(interaction);

  const { session, isNew } = getOrCreateSession(interaction.guildId);
  await session.resolveListMessage(interaction.guild);

  if (isNew) {
    // Bot had left voice — start a brand new playlist with only this song
    session.queue        = [];
    session.currentIndex = 0;
  }

  session.addTrack(track);

  if (!session.playing) {
    // Start from the newly added song regardless of what was in the queue before
    try {
      await session.startFrom(session.queue.length - 1, voiceChannel);
    } catch (err) {
      sessions.delete(interaction.guildId);
      await interaction.editReply(`❌ ${err.message}`).catch(() => {});
    }
  } else {
    // Already playing — just append to queue and update the message
    await session.updateListMessage();
  }
}

async function handleStop(interaction) {
  const session = sessions.get(interaction.guildId);
  if (!session || !session.playing) {
    await interaction.reply({ content: '❌ Nothing is playing.', flags: 64 });
    autoDelete(interaction);
    return;
  }
  await session.stopPlayback();
  await interaction.reply({ content: '⏹ Stopped. Queue clears in 2 min if nothing plays.', flags: 64 });
  autoDelete(interaction);
}

async function handleButton(interaction) {
  const id = interaction.customId;

  if (id === 'music_stop') {
    const session = sessions.get(interaction.guildId);
    if (!session || !session.playing) {
      await interaction.reply({ content: '❌ Nothing is playing.', flags: 64 });
      autoDelete(interaction);
      return;
    }
    await session.stopPlayback();
    await interaction.reply({ content: '⏹ Stopped. Queue clears in 2 min if nothing plays.', flags: 64 });
    autoDelete(interaction);
    return;
  }

  if (id === 'music_clear') {
    const session = sessions.get(interaction.guildId);
    if (session) {
      session.clearQueue();
      await session.updateListMessage();
      sessions.delete(interaction.guildId);
    }
    await interaction.reply({ content: '🗑 Queue cleared.', flags: 64 });
    autoDelete(interaction);
    return;
  }

  if (id === 'music_skip') {
    const session = sessions.get(interaction.guildId);
    if (!session || !session.playing) {
      await interaction.reply({ content: '❌ Nothing is playing.', flags: 64 });
      autoDelete(interaction);
      return;
    }
    session.skip();
    await interaction.reply({ content: '⏭ Skipped.', flags: 64 });
    autoDelete(interaction);
    return;
  }

  if (id.startsWith('music_jump_')) {
    const idx     = parseInt(id.split('_')[2]);
    const { session } = getOrCreateSession(interaction.guildId);
    await session.resolveListMessage(interaction.guild);

    const voiceChannel = interaction.member.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({ content: '❌ Join a voice channel first.', flags: 64 });
      autoDelete(interaction);
      return;
    }

    if (session.playing) {
      await session.jumpTo(idx);
    } else {
      // Not connected — connect and start from this index
      try {
        await session.startFrom(idx, voiceChannel);
      } catch (err) {
        await interaction.reply({ content: `❌ ${err.message}`, flags: 64 });
        autoDelete(interaction);
        return;
      }
    }
    await interaction.reply({ content: `⏩ Playing track ${idx + 1}.`, flags: 64 });
    autoDelete(interaction);
    return;
  }
}

async function handleRadio(interaction) {
  if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused().toLowerCase();
    const choices = radioStations
      .filter(s => s.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map(s => ({ name: s.name, value: s.name }));
    await interaction.respond(choices).catch(() => {});
    return;
  }

  const stationName = interaction.options.getString('station');
  const station     = radioStations.find(s => s.name.toLowerCase() === stationName.toLowerCase());
  if (!station) {
    await interaction.reply({ content: `❌ Station **${stationName}** not found.`, flags: 64 });
    return;
  }

  const voiceChannel = interaction.member.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: '❌ Join a voice channel first.', flags: 64 });
    return;
  }

  await interaction.deferReply({ flags: 64 });

  const { session } = getOrCreateSession(interaction.guildId);
  await session.resolveListMessage(interaction.guild);

  // Replace queue with just the radio track
  session.queue        = [{ title: `📻 ${station.name}`, url: station.url, isRadio: true, thumbnail: null, duration: 0, requestedBy: interaction.user.id }];
  session.currentIndex = 0;

  try {
    await session.startFrom(0, voiceChannel);
    await interaction.editReply({ content: `📻 Now streaming **${station.name}**` });
  } catch (err) {
    sessions.delete(interaction.guildId);
    await interaction.editReply({ content: `❌ ${err.message}` });
  }
}

async function handleProvider(interaction) {
  const source = interaction.options.getString('source');
  setProvider(interaction.guildId, source);
  const label = source === 'soundcloud' ? 'SoundCloud' : 'YouTube';
  await interaction.reply({ content: `✅ Music source set to **${label}**.`, flags: 64 });
}

async function handleVoiceStateUpdate(oldState, newState) {
  // Only care about users leaving a channel
  if (!oldState.channel) return;
  const channel = oldState.channel;
  const botId   = oldState.guild.members.me?.id;
  if (!botId) return;

  // Bot must be in that channel
  if (!channel.members.has(botId)) return;

  // Check if any non-bot members remain
  const humans = channel.members.filter(m => !m.user.bot);
  if (humans.size > 0) return;

  // Everyone left — stop and disconnect
  const session = sessions.get(oldState.guild.id);
  if (!session) return;
  console.log('[Music] Voice channel empty — disconnecting.');
  session._disconnect();
  session._clearIdleTimer();
  delete musicState[oldState.guild.id];
  saveState();
  sessions.delete(oldState.guild.id);
  await session.updateListMessage().catch(() => {});
}

ensureYtDlp().then(() => updateYtDlp()).catch(() => {});

play.getFreeClientID().then(id => play.setToken({ soundcloud: { client_id: id } })).catch(() => {});

module.exports = { handlePlay, handleStop, handleButton, handleSearchSelect, handleProvider, handleRadio, handleVoiceStateUpdate };
