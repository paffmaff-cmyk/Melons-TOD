require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActivityType } = require('discord.js');
const BOSSES = require('./bosses.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── Helper: format a Unix timestamp for Discord (shows in user's local timezone) ──
function discordTime(date, format = 'F') {
  return `<t:${Math.floor(date.getTime() / 1000)}:${format}>`;
}

// ── Helper: find a boss by name (case-insensitive) ──
function findBoss(name) {
  return BOSSES.find(b => b.name.toLowerCase() === name.toLowerCase());
}

// ── Bot ready ──
client.once('clientReady', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity('Boss Timers', { type: ActivityType.Watching });
});

// ── Autocomplete handler ──
client.on('interactionCreate', async interaction => {
  if (interaction.isAutocomplete()) {
    const focusedValue = interaction.options.getFocused().toLowerCase();
    const choices = BOSSES
      .filter(b => b.name.toLowerCase().includes(focusedValue))
      .slice(0, 25)
      .map(b => ({ name: b.name, value: b.name }));
    await interaction.respond(choices);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // ────────────────────────────────────────────────────────────
  //  /tod command
  // ────────────────────────────────────────────────────────────
  if (interaction.commandName === 'tod') {
    const bossName  = interaction.options.getString('boss_name');
    const whoKilled = interaction.options.getString('who_killed');
    const dropped   = interaction.options.getBoolean('drop');
    const offset    = interaction.options.getInteger('tod_offset') ?? 0;

    // Find boss data
    const boss = findBoss(bossName);
    if (!boss) {
      await interaction.reply({
        content: `❌ Boss **${bossName}** not found in the boss list. Use \`/bosses\` to see all available bosses.`,
        ephemeral: true,
      });
      return;
    }

    // Calculate times
    const now       = new Date();
    const todTime   = new Date(now.getTime() - offset * 60 * 1000);   // subtract offset minutes
    const windowStart = new Date(todTime.getTime() + boss.spawnHours * 60 * 60 * 1000);
    const windowEnd   = new Date(windowStart.getTime() + boss.windowHours * 60 * 60 * 1000);

    // Build embed
    const dropStatus = dropped
      ? 'Dropped ✅'
      : 'Did not drop ❌';

    const killedBy = whoKilled === 'ally' ? 'Ally ✅' : whoKilled === 'enemy' ? 'Enemy ❌' : null;

    // Color: ally = green, enemy = red, unknown = based on drop
    const embedColor = whoKilled === 'ally' ? 0x57F287 : whoKilled === 'enemy' ? 0xED4245 : (dropped ? 0x57F287 : 0xED4245);

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle(killedBy ? `${boss.name} — Killed by ${killedBy}` : boss.name)
      .addFields(
        {
          name: 'Reported by',
          value: `${interaction.user}`,
          inline: false,
        },
        {
          name: 'TOD',
          value: `${discordTime(todTime, 'F')} | TOD offset: 🕐 ${offset} min`,
          inline: false,
        },
        {
          name: 'Spawn time',
          value: `${boss.spawnHours} hours`,
          inline: true,
        },
        {
          name: 'Window duration',
          value: `${boss.windowHours} hours`,
          inline: true,
        },
        {
          name: '\u200B',   // blank spacer
          value: '\u200B',
          inline: false,
        },
        {
          name: 'Window start',
          value: discordTime(windowStart, 'F'),
          inline: false,
        },
        {
          name: 'Window end',
          value: discordTime(windowEnd, 'F'),
          inline: false,
        },
        {
          name: 'Drop',
          value: dropStatus,
          inline: false,
        },
      )
      .setFooter({ text: `Melon's TOD Bot`, iconURL: client.user.displayAvatarURL() })
      .setTimestamp(todTime);

    await interaction.reply({ embeds: [embed] });
    return;
  }

  // ────────────────────────────────────────────────────────────
  //  /bosses command
  // ────────────────────────────────────────────────────────────
  if (interaction.commandName === 'bosses') {
    const rows = BOSSES.map(b =>
      `• **${b.name}** — spawn in ${b.spawnHours}h, window ${b.windowHours}h`
    ).join('\n');

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('Boss Respawn List')
      .setDescription(rows)
      .setFooter({ text: `Melon's TOD Bot` });

    await interaction.reply({ embeds: [embed] });
    return;
  }
});

// ── Login ──
client.login(process.env.TOKEN);
