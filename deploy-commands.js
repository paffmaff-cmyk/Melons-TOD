// Run this script ONCE to register the slash commands with Discord.
// Command: node deploy-commands.js

require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const BOSSES = require('./bosses.js');

const commands = [
  new SlashCommandBuilder()
    .setName('tod')
    .setDescription('Record a boss Time of Death and calculate spawn window')
    .addStringOption(option =>
      option
        .setName('boss_name')
        .setDescription('Name of the boss that was killed')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addBooleanOption(option =>
      option
        .setName('drop')
        .setDescription('Did the boss drop an item?')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('who_killed')
        .setDescription('Who killed the boss?')
        .setRequired(false)
        .addChoices(
          { name: 'Ally ✅', value: 'ally' },
          { name: 'Enemy ❌', value: 'enemy' },
        )
    )
    .addIntegerOption(option =>
      option
        .setName('tod_offset')
        .setDescription('Minutes ago the boss was killed (0 = right now)')
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1440)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('bosses')
    .setDescription('List all bosses and their respawn times')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('todoptions')
    .setDescription('Add, edit or delete bosses from the list')
    .toJSON(),

  new SlashCommandBuilder().setName('out').setDescription('Report an absence').toJSON(),
  new SlashCommandBuilder().setName('absences').setDescription('Show upcoming absences').toJSON(),

  new SlashCommandBuilder().setName('announce').setDescription('Post an announcement').toJSON(),

  new SlashCommandBuilder().setName('play').setDescription('Search a song or paste a Spotify/SoundCloud link')
    .addStringOption(o => o.setName('query').setDescription('Song name, Spotify link, or SoundCloud URL').setRequired(true))
    .toJSON(),
  new SlashCommandBuilder().setName('stop').setDescription('Stop music and disconnect from voice').toJSON(),
  new SlashCommandBuilder().setName('radio').setDescription('Play a live radio station')
    .addStringOption(o => o.setName('station').setDescription('Radio station name').setRequired(true).setAutocomplete(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('gratz')
    .setDescription('Congratulate a player on an epic drop')
    .addRoleOption(o => o.setName('player').setDescription('Select the role/player to congratulate').setRequired(true))
    .addStringOption(o => o.setName('item').setDescription('Epic item').setRequired(true)
      .addChoices(
        { name: 'Queen Ant Ring',     value: 'QUEEN ANT RING'     },
        { name: 'Core Ring',          value: 'CORE RING'          },
        { name: 'Orfen Ring',         value: 'ORFEN RING'         },
        { name: 'Baium Ring',         value: 'BAIUM RING'         },
        { name: 'Antharas Earring',   value: 'ANTHARAS EARRING'   },
        { name: 'Valakas Necklace',   value: 'VALAKAS NECKLACE'   },
        { name: 'Fraya Necklace',     value: 'FRAYA NECKLACE'     },
        { name: 'Frintezza Necklace', value: 'FRINTEZZA NECKLACE' },
        { name: 'Beleth Ring',        value: 'BELETH RING'        },
      ))
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands },
    );
    console.log('✅ Slash commands registered successfully!');
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }
})();
