// ============================================================
//  BOSS LIST — Edit this file to add / remove / change bosses
//  spawnHours  = how many hours until the boss can respawn
//  windowHours = how long the spawn window lasts
// ============================================================

const BOSSES = [
  { name: 'Queen Ant',   spawnHours: 17,  windowHours: 4 },
  { name: 'Core',        spawnHours: 48,  windowHours: 4 },
  { name: 'Orfen',       spawnHours: 33,  windowHours: 4 },
  { name: 'Zaken',       spawnHours: 60,  windowHours: 8 },
  { name: 'Baium',       spawnHours: 125, windowHours: 4 },
  { name: 'Antharas',    spawnHours: 342, windowHours: 4 },
  { name: 'Valakas',     spawnHours: 342, windowHours: 4 },
  { name: 'Beleth',      spawnHours: 342, windowHours: 4 },
  // Add more bosses here in the same format
];

module.exports = BOSSES;
