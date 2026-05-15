# Melon's TOD Bot — Claude Reference

Discord bot for a Lineage 2 gaming guild. Tracks boss respawn timers (Time of Death), manages raid rosters, absences, announcements, music playback, and boss window alerts.

## Deploy
```
cd /root/bot && git pull && pm2 restart melons-bot
```
Run after every code change. Also run `node deploy-commands.js` after adding/changing slash commands.

## File Map

| File | Purpose |
|------|---------|
| `index.js` | Entire bot (~1900 lines). All slash commands, buttons, modals, selects in one file. |
| `music.js` | Music module — play/queue/radio/yt-dlp. Required by index.js. |
| `bosses.js` | Reference file listing default boss definitions (not required by index.js). |
| `deploy-commands.js` | Registers slash commands with Discord API. Run manually after changes. |
| `bosses.json` | Live boss data (runtime, gitignored). Auto-created from `bosses.default.json` if missing. |
| `bosses.default.json` | Default boss list — fallback/reset source. Includes `Test Boss` (0.0167h spawn+window ≈ 1 min, for alert testing). |
| `boss_alerts.json` | Pending window alerts (runtime, gitignored). Format: `{ "guildId:bossName": { bossName, channelId, windowStart, windowEnd } }` |
| `listings.json` | Market listings: `{ [guildId]: { [messageId]: { type, item, price, userId, channelId, postedAt, expiresAt, deletesAt, status } } }` |
| `fort_stats.json` | Fort run counts: `{ [guildId]: { [userId]: { count, username } } }` |
| `absences.json` | Absence records: `{ [guildId]: [...entries] }` |
| `announcements.json` | Announcement state per guild. |
| `music_state.json` | Music queue state (runtime, do not edit manually). |
| `music_history.json` | Music play history. |
| `radio_stations.json` | Live radio station list. |
| `radio_stations.default.json` | Default radio stations — reset source. |
| `.env` | `TOKEN`, `CLIENT_ID`, `GUILD_ID` |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/tod` | Record boss kill time. Options: `boss_name`, `drop`, `who_killed`, `tod_offset` (minutes ago) |
| `/bosses` | List all bosses and their respawn windows |
| `/todoptions` | Add / edit / delete bosses from the list |
| `/out` | Report a personal absence |
| `/absences` | Show upcoming absences for the guild |
| `/remove-absence` | Remove an absence entry |
| `/announce` | Post announcement (supports image, role tags, response collection, @everyone) |
| `/play` | Add song to queue — YouTube via yt-dlp |
| `/stop` | Stop music and disconnect from voice |
| `/radio` | Play a live radio station (autocomplete) |
| `/provider` | Set music provider for the server |
| `/wts` | Post a Want To Sell listing — `item` (req), `price`/`days` (opt, default 7d max) — purple embed |
| `/wtb` | Post a Want To Buy listing — `item` (req), `price`/`days` (opt, default 7d max) — yellow embed |
| `/shops` | Show all active WTS/WTB listings for the server (ephemeral) |
| `/fort log` | Register a fortress run — `fort`, `time`, `action` (Farm/Fame). Time accepts `HH:MM`, `HHMM`, `MM`, `:MM`. Orange embed for Farm, purple for Fame. Posts ephemeral 60s undo button. |
| `/fort stats` | Show per-player fort run counts for this server with FORT KING highlight (ephemeral) |
| `/move` | Record a gear transfer — `from`, `gear`, `to` — posts `⚙️ From ➜ Gear ➜ To` |
| `/gratz` | Congratulate a player on an epic item drop |
| `/chars` | Create a raid roster — preset compositions or custom slot types |
| `/drops` | Show drop stats for a specific boss |
| `/scandrops` | Scan current channel history and rebuild drop stats from Melon's Bot + Red Alert Bot embeds |

## Architecture

**index.js structure** — one giant `client.on('interactionCreate')` handler, checked in this order:
1. `isAutocomplete()` → boss/radio autocomplete
2. `isModalSubmit()` → form submissions
3. `isButton()` → all button interactions
4. `isStringSelectMenu()` → dropdowns
5. `isChatInputCommand()` → slash commands (if-else chain by `commandName`)

**music.js exports**: `handlePlay`, `handleStop`, `handleRadio`, `handleButton`, `handleSelect`, `handleAutocomplete`, `getState`

**Multi-step flows use in-memory Maps** (lost on restart):
- `pendingAnnouncements` — announcement builder state per user
- `waitingForImage` — image upload state
- `pendingRetry` — modal retry with date error
- `pendingTodUndos` — TOD undo window (60s), keyed by userId
- `pendingFortUndos` — fort undo window (60s), keyed by userId → `{ messageId, channelId, guildId }`
- `pendingShops` — deduplicates /shops ephemeral per user

**Boss data** — mutated in-memory (`bossesByGuild`), persisted via `saveBosses()` → `bosses.json`

**Boss window alerts** — when `/tod` is recorded, a `setTimeout` fires `@everyone 🔔 **BossName** window has started!` in the same channel when the window opens.
- Keyed by `guildId:bossName` — each server tracks its own alerts independently
- Persisted in `boss_alerts.json` and restored on startup via `scheduleAlert()`
- Fires immediately if window already open (offset ≥ spawnHours); skipped only if window already ended
- `scheduleAlert(alertKey, bossName, channelId, windowStartMs)` — defined just above `clientReady`
- If spawn hours change via `/todoptions` after TOD is recorded, re-run `/tod` to reschedule

**Absence data** — `absencesDB[guildId]` array, persisted via `saveAbsences()` → `absences.json`. Past absences auto-purged on startup and daily at midnight.

**Market listings** — per-guild, per-message. Active 7 days, expired state for 1 more day, then deleted. Timers restored on startup via `scheduleListingTimers()`. Expiry display uses Discord native `<t:R>` timestamp — no bot edits for countdowns.

**Fort system**
- `/fort log` posts an embed with start time, action, who registered, and a 5h cooldown field using Discord native `<t:R>` (counts from fort start time, zero bot edits)
- `recordFort(guildId, userId, username)` increments `fort_stats.json` on each log; undo decrements it
- `buildFortEmbed(data)` — all fields vertical (no inline), called once at post time only
- Fort stats are per-guild (`fortStats[guildId][userId]`)

**scandrops two-pass logic**
- Pass 1: collect all matching embeds from channel history, tag source (`melon` vs `alert`)
  - Melon's Bot identified by `footer.includes("Melon's Bot")` — takes priority
  - Red Alert Bot: `!isMelonBot && title.includes(' Killed by ')`
  - Boss name split: Melon's Bot on ` — `, Red Alert on ` Killed by `
- Pass 2: group by boss, sort by timestamp, deduplicate within ±10 min window (prefer Melon's Bot record)
- Result shows: Records found / After dedup / Duplicates removed

## Key Conventions

- **Timezone**: All user times treated as `Europe/Vilnius`. Constant: `BOT_TIMEZONE`
- **Ephemeral replies**: Use `replyEph(interaction, payload, secs=300)` — auto-deletes after timeout
- **Auto-delete helper**: `autoDelete(interaction, secs)` — also clears content/buttons if delete fails
- **Discord timestamps**: `discordTime(date, format)` → `<t:unix:F>` format. Use `<t:unix:R>` for live countdowns — no bot edits needed.
- **Async write queue**: All file saves go through `saveFile(filePath, data)` which serialises writes to prevent corruption under concurrent access.
- **No countdown intervals**: All time displays use Discord native `<t:R>` timestamps. The only active intervals are the listing expiry/delete timers (setTimeout, not setInterval).

## Game Context (Lineage 2)

- **TOD** = Time of Death — when a boss was killed, used to calculate next spawn window
- **Spawn window** = `spawnHours` after kill ± `windowHours` (boss can appear anywhere in the window)
- **`/chars` slot types**: BP SWS BD SORC SPS OL SE SPOIL ARBA JUDI PONY DOD CAT PHANTOM WC DESTR TYR WS SOS STUN
- **Full Time** role → 🔵, **Part Time** role → 🟡 (shown in roster via `getMemberTimeDot`)
- **Fort cooldown** = 5 hours from fort start time
