# Melon's TOD Bot — Claude Reference

Discord bot for a Lineage 2 gaming guild. Tracks boss respawn timers (Time of Death), manages raid rosters, absences, announcements, and music playback.

## Deploy
```
cd /root/bot && git pull && pm2 restart melons-bot
```
Run after every code change. Also run `node deploy-commands.js` after adding/changing slash commands.

## File Map

| File | Purpose |
|------|---------|
| `index.js` | Entire bot (~1800 lines). All slash commands, buttons, modals, selects in one file. |
| `music.js` | Music module — play/queue/radio/yt-dlp. Required by index.js. |
| `bosses.js` | Reference file listing default boss definitions (not required by index.js). |
| `deploy-commands.js` | Registers slash commands with Discord API. Run manually after changes. |
| `bosses.json` | Live boss data (runtime). Auto-created from `bosses.default.json` if missing. |
| `bosses.default.json` | Default boss list — fallback/reset source. |
| `absences.json` | Absence records: `{ [guildId]: [...entries] }` |
| `announcements.json` | Announcement state per guild. |
| `music_state.json` | Music queue state (runtime, do not edit manually). |
| `music_history.json` | Music play history. |
| `radio_stations.json` | Live radio station list. |
| `radio_stations.default.json` | Default radio stations — reset source. |
| `.env` | `DISCORD_TOKEN`, `CLIENT_ID` |

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
| `/gratz` | Congratulate a player on an epic item drop |
| `/chars` | Create a raid roster — preset compositions or custom slot types |

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

**Boss data** — mutated in-memory (`BOSSES` array), persisted via `saveBosses()` → `bosses.json`

**Absence data** — `absencesDB[guildId]` array, persisted via `saveAbsences()` → `absences.json`. Past absences auto-purged on startup and daily at midnight.

## Key Conventions

- **Timezone**: All user times treated as `Europe/Vilnius`. Constant: `BOT_TIMEZONE`
- **Ephemeral replies**: Use `replyEph(interaction, payload, secs=300)` — auto-deletes after timeout
- **Auto-delete helper**: `autoDelete(interaction, secs)` — also clears content/buttons if delete fails
- **Discord timestamps**: `discordTime(date, format)` → `<t:unix:F>` format

## Game Context (Lineage 2)

- **TOD** = Time of Death — when a boss was killed, used to calculate next spawn window
- **Spawn window** = `spawnHours` after kill ± `windowHours` (boss can appear anywhere in the window)
- **`/chars` slot types**: BP SWS BD SORC SPS OL SE SPOIL ARBA JUDI PONY DOD CAT PHANTOM WC DESTR TYR WS SOS STUN
- **Full Time** role → 🔵, **Part Time** role → 🟡 (shown in roster via `getMemberTimeDot`)
