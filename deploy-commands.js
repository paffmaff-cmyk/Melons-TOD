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
