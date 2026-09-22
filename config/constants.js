import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root project directory
const rootDir = path.resolve(__dirname, '..');

// === File Paths ===
// CONTROL_DATA_PATH lets a test point saves at a scratch file instead of the
// real match data (scripts/chat/test-decklists.mjs does). Unset in production.
export const controlDataPath     = process.env.CONTROL_DATA_PATH || path.join(rootDir, 'data', 'controlData.json');
export const bracketDataPath     = path.join(rootDir, 'data', 'bracketData.json');
export const standingsDataPath   = path.join(rootDir, 'data', 'standingsData.json');
export const archetypeListPath   = path.join(rootDir, 'data', 'archetypeList.json');
export const playerRosterPath    = path.join(rootDir, 'data', 'playerRoster.json');
// Team→group mapping for the flyquest 2v2 standings layout (two brackets on
// one 1920×1080 canvas). Set once at event start via master-control and then
// left alone for the duration. Consumed by the broadcast-round-standings
// layout to split incoming standings rows into GROUP 1 / GROUP 2 columns.
export const groupAssignmentPath = path.join(rootDir, 'data', 'groupAssignment.json');

// === Data Dictionaries ===
// Consulted once by features/roster.js when playerRoster.json is empty AND
// the current selections are mtg + flyquest + 2v2. Keys are portrait filename
// slugs in public/assets/images/mtg/shared/player-portraits/flyquest-2v2/.
// Values are the display names written into the roster. Any slug not listed
// below falls back to a generic title-case deslug at auto-seed time.
export const FLYQUEST_2V2_ROSTER_SEED = {
    'baddie':               'Baddie',
    'joel-r-magic':         'Joel R. Magic',
    'danny':                'Danny',
    'yamina':               'Yamina',
    'zabracus':             'Zabracus',
    'biqtch-puddin':        "Biqtch Puddin'",
    'gavin-verhey':         'Gavin Verhey',
    'persephone-valentine': 'Persephone Valentine',
    'taalia-vess':          'Taalia Vess',
    'nemo':                 'Nemo',
    'ls':                   'LS',
    'reynad':               'Reynad',
    'lua-stardust':         'Lua Stardust',
    'anna-margaret':        'Anna Margaret',
    'sofia':                'Sofia',
    'brodin':               'Brodin',
    'peterpark':            'peterpark',
    'atrioc':               'Atrioc',
};

// === Defaults ===
export let DEFAULT_INITIAL_TIME = 50 * 60 * 1000; // 50 minutes in ms
export let DEFAULT_GAME_SELECTION = 'riftbound';  // mtg, riftbound
export let DEFAULT_VENDOR_SELECTION = 'anu';
export let DEFAULT_PLAYER_COUNT = '1v1';

export function getInitialTime() {
  return DEFAULT_INITIAL_TIME;
}

export function setInitialTime(ms) {
  DEFAULT_INITIAL_TIME = ms;
}

export function getGameSelection() {
  return DEFAULT_GAME_SELECTION;
}

export function setGameSelection(gameType) {
  DEFAULT_GAME_SELECTION = gameType.toLowerCase();
}

export function getVendorSelection() {
  return DEFAULT_VENDOR_SELECTION;
}

export function setVendorSelection(vendor) {
  DEFAULT_VENDOR_SELECTION = vendor.toLowerCase();
}

export function getPlayerCount() {
  return DEFAULT_PLAYER_COUNT;
}

export function setPlayerCount(count) {
  DEFAULT_PLAYER_COUNT = count.toLowerCase();
}

// Global "show sideboard on the decklist broadcast" flag (default: hidden).
export let DEFAULT_SIDEBOARD_VISIBLE = false;

export function getSideboardVisible() {
  return DEFAULT_SIDEBOARD_VISIBLE;
}

export function setSideboardVisible(visible) {
  DEFAULT_SIDEBOARD_VISIBLE = !!visible;
}

// Scoreboard decklists: both players' vertical lists slid onto the riftbound
// scoreboard. In-memory, off after a restart (like Card Vision) — a stream
// never starts with decklists covering the game.
export let DEFAULT_SCOREBOARD_DECKLISTS_VISIBLE = false;
export function getScoreboardDecklistsVisible() { return DEFAULT_SCOREBOARD_DECKLISTS_VISIBLE; }
export function setScoreboardDecklistsVisible(visible) { DEFAULT_SCOREBOARD_DECKLISTS_VISIBLE = !!visible; }
