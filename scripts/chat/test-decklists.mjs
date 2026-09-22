#!/usr/bin/env node
// Run from the repo root:  node scripts/chat/test-decklists.mjs
// Drives the REAL chat bridge with a fake chat + fake Twitch sender.
// Fixtures are the exact control data read off the box on 2026-09-20,
// including the "&nbsp;" name and the stale 2v2 slots. Every defect the
// adversarial review confirmed has a test here ("REVIEW:" prefix).
import { createHash } from 'crypto';
import { readFileSync as readFile, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// The deck loader saves through control.js. Point that at a scratch file so a
// test can never overwrite the real match data — and prove it wasn't touched.
const REAL_CONTROL_DATA = new URL('../../data/controlData.json', import.meta.url);
const realHash = () => existsSync(REAL_CONTROL_DATA) ? createHash('sha256').update(readFile(REAL_CONTROL_DATA)).digest('hex') : 'absent';
const REAL_BEFORE = realHash();
process.env.CONTROL_DATA_PATH = join(tmpdir(), `decklists-test-controlData-${process.pid}.json`);
delete process.env.CHAT_ADMINS;
process.env.CHAT_BRIDGE_ENABLED = 'true';
process.env.TWITCH_CHANNEL = 'test';
process.env.TWITCH_BOT_LOGIN = 'anzidbot';


const { setGameSelection } = await import('../../config/constants.js');
const { loadCardListData } = await import('../../features/riftbound/cards.js');
await loadCardListData();
setGameSelection('riftbound');
const { initChatBridge, describeOnAir, _internal } = await import('../../features/chat-bridge.js');
const control = await import('../../features/control.js');
const { releaseSlot } = await import('../../features/card-slot-owner.js');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `\n        ${detail}` : ''}`);
};

// ── live box data ────────────────────────────────────────────────────────────
const tracker = { 1: { round_id: '1', match_id: 'match1' }, 2: { round_id: '1', match_id: 'match2' } };
const box = {
    1: {
        match1: {
            'player-name-left': 'Anu', 'player-legend-left': 'Rengar, Pridestalker',
            'player-name-right': 'Asc Samdsherman&nbsp;', 'player-legend-right': 'LeBlanc, Deceiver',
            'player-name-left-2': 'peterpark', 'player-legend-left-2': 'Vex, Gloomist',
            'player-name-right-2': 'Emilyywang', 'player-legend-right-2': 'Jhin, Virtuoso',
        },
        match2: {
            'player-name-left': 'Dragon4890', 'player-legend-left': 'Azir, Emperor of the Sands',
            'player-name-right': 'ALPHAKUPUS', 'player-legend-right': 'Ezreal, Prodigal Explorer',
            'player-name-left-2': 'Sofia', 'player-name-right-2': 'Persephone Valentine',
        },
    },
    4: {
        match1: { 'player-name-left': 'R4Alpha', 'player-legend-left': 'Jinx, Loose Cannon',
                  'player-name-right': 'R4Bravo', 'player-legend-right': 'Viktor, Herald of the Arcane' },
        match2: { 'player-name-left': 'R4Charlie', 'player-legend-left': "Kai'Sa, Daughter of the Void",
                  'player-name-right': 'R4Delta', 'player-legend-right': 'Volibear, Relentless Storm' },
    },
};
const synced = () => true, notSynced = () => false;
const base = { tracker, data: box, inSync: synced, broadcast: { round_id: '1' }, game: 'riftbound', playerCount: '1v1' };
const on = (scene, extra = {}) => describeOnAir({ ...base, scene, ...extra });

// ── 1. command parsing ──────────────────────────────────────────────────────
const { isDecklistsCommand, parseCommand, plainText } = _internal;
for (const t of ['!decklists', '!decklist', '!decks', '!DECKLISTS', '  !decklists  '])
    check(`matches "${t}"`, isDecklistsCommand(t));
for (const t of ['!decklistsx', '!deck', 'decklists', '!c decklists', 'what are the !decklists', '', '!decklists please'])
    check(`ignores "${t}"`, !isDecklistsCommand(t));
check('!decklists is not mistaken for a card request', parseCommand('!decklists') === null);
check('!c kennen still parses as a card', parseCommand('!c kennen') === 'kennen');
check('REVIEW: "!decks [[kennen]]" is a card request, not swallowed',
    !isDecklistsCommand('!decks [[kennen]]') && parseCommand('!decks [[kennen]]') === 'kennen');

// ── 2. names are plain text, and can't reach past themselves ────────────────
const pt = (v, want, name) => { const got = plainText(v); check(name, got === want, JSON.stringify(got)); };
pt('Asc Samdsherman&nbsp;', 'Asc Samdsherman', '&nbsp; decoded and trimmed');
pt('<b>Anu</b><br>', 'Anu', 'tags stripped');
pt('A&amp;B &lt;3 &#39;x&#39; &#x41;', "A&B <3 'x' A", 'entities decoded');
check('long name capped at 40 characters', Array.from(plainText('x'.repeat(90))).length === 40);
pt('🔥'.repeat(45), '🔥'.repeat(40), 'cap never splits an emoji');
let threw = null;
try { plainText('Anu&#x110000;&#1114112;&#99999999999999999999;'); } catch (e) { threw = e.message; }
check('REVIEW: out-of-range numeric entity cannot throw', threw === null, threw || 'no throw');
pt('Anu&#x110000;', 'Anu', 'REVIEW: out-of-range entity becomes nothing visible');
pt('Anu&#xD800;', 'Anu', 'REVIEW: lone-surrogate entity dropped');
pt('‮Anu', 'Anu', 'REVIEW: RLO bidi override stripped');
pt('An​u', 'Anu', 'REVIEW: zero-width space stripped');
pt('Anu&#x202e;', 'Anu', 'REVIEW: bidi override via entity stripped');
pt('Anu\nBee', 'An u Bee', 'REVIEW: control chars become spaces, not glue');
pt('[[Loose Cannon]]', 'Loose Cannon', 'REVIEW: brackets stripped, so a name cannot carry card syntax');
pt(`${'y'.repeat(39)} z`, 'y'.repeat(39), 'REVIEW: no trailing space left by the 40-char cap');

// ── 3. what is on air ───────────────────────────────────────────────────────
check('OBS program scene unknown -> stay quiet', on(null) === null);
check('break / slides scene -> says no match is on air', on('Break - Be Right Back') === 'no match is on air right now.', on('Break - Be Right Back'));
check('"Match 10" is not Match 1', on('Match 10 - Live') === 'no match is on air right now.', on('Match 10 - Live'));

const m1 = on('Match 1 - Live + Hand Blue');
check('Match 1 on air, against live box data', m1 === 'Match 1: Anu (Rengar) vs Asc Samdsherman (LeBlanc)', m1);
for (const stale of ['Sofia', 'Persephone', 'peterpark', 'Emilyywang', 'nbsp', 'Dragon4890'])
    check(`Match 1 reply never leaks "${stale}"`, !m1.includes(stale));

check('REVIEW: after a restart, Match 1 is not described until its scoreboard was sent data',
    on('Match 1 - Live + Hand Blue', { inSync: notSynced }) === null);

// The reviewer's exact F1 repro: Broadcast on round 4, Control 1 remapped to
// 4/match1, Control 2 never remapped (still 1/match2 = Dragon4890).
const f1 = { tracker: { 1: { round_id: '4', match_id: 'match1' }, 2: { round_id: '1', match_id: 'match2' } }, broadcast: { round_id: '4' } };
const m2 = on('Match 2 - Live*', f1);
check('REVIEW: Match 2 reads the Broadcast round (what its header shows), not Control 2',
    m2 === "Match 2: R4Charlie (Kai'Sa) vs R4Delta (Volibear)", m2);
check('REVIEW: Control 2\'s stale round-1 pairing never reaches chat', !/Dragon4890|ALPHAKUPUS|Sofia|Persephone/.test(m2), m2);
check('REVIEW: nothing broadcast since boot -> Match 2 stays quiet', on('Match 2 - Live*', { broadcast: { round_id: null } }) === null);
check('Match 1 follows a Control remap', on('Match 1 - Live', f1) === 'Match 1: R4Alpha (Jinx) vs R4Bravo (Viktor)', on('Match 1 - Live', f1));

const two = on('Match 1 - Live', { playerCount: '2v2' });
check('REVIEW: 2v2 lists names only (partner decks are hidden on screen)',
    two === 'Match 1: Anu & peterpark vs Asc Samdsherman & Emilyywang', two);
const mtg2 = on('Match 1 - Live', { game: 'mtg', playerCount: '2v2',
    data: { 1: { match1: { 'player-name-left': 'Baddie', 'player-archetype-left': 'Esper Control', 'player-name-left-2': 'LS',
                           'player-name-right': 'Reynad', 'player-archetype-right': 'Mono-Red', 'player-name-right-2': 'Nemo' } } } });
check('REVIEW: MTG 2v2 shows no archetypes (the row is hidden)', mtg2 === 'Match 1: Baddie & LS vs Reynad & Nemo', mtg2);
const ffa = on('Match 1 - Live', { game: 'mtg', playerCount: 'ffa',
    data: { 1: { match1: { 'player-name-left': 'Seat1', 'player-archetype-left': "Esika, God of the Tree // The Prismatic Bridge",
                           'player-name-left-2': 'Seat2', 'player-name-right': 'Seat3', 'player-name-right-2': 'Seat4' } } } });
check('REVIEW: FFA lists all four seats, no head-to-head, no decks', ffa === 'Match 1: Seat1, Seat2, Seat3, Seat4', ffa);
const swu = on('Match 1 - Live', { game: 'starwars',
    data: { 1: { match1: { 'player-name-left': 'A', 'player-archetype-left': 'Vader Aggro', 'player-name-right': 'B' } } } });
check('REVIEW: Star Wars shows names only (screen shows leader/base, not archetype)', swu === 'Match 1: A vs B', swu);
const mtg1 = on('Match 1 - Live', { game: 'mtg',
    data: { 1: { match1: { 'player-name-left': 'A', 'player-archetype-left': 'Izzet Prowess', 'player-name-right': 'B', 'player-archetype-right': 'Mono-Red',
                           'player-legend-left': 'Rengar, Pridestalker' } } } });
check('MTG 1v1 uses the archetype, not a leftover legend', mtg1 === 'Match 1: A (Izzet Prowess) vs B (Mono-Red)', mtg1);
const half = on('Match 1 - Live', { data: { 1: { match1: { 'player-name-left': 'Anu' } } } });
check('half-set-up match is not announced as a pairing', half === "the players aren't on the scoreboard yet.", half);

// ── 4. the in-sync signal in the real control.js ────────────────────────────
const fakeIo = { to: () => ({ emit() {} }), emit() {}, sockets: { emit() {} } };
check('control.js: scoreboard 1 NOT in sync at boot', control.isScoreboardInSync('1') === false);
control.emitSavedStateForControl('1', fakeIo);
check('control.js: in sync once its state has been pushed', control.isScoreboardInSync('1') === true);
check('control.js: other scoreboards unaffected', control.isScoreboardInSync('3') === false);
control.updateControlMapping('3', '1', 'match3', fakeIo);
check('control.js: a remap counts as a push', control.isScoreboardInSync('3') === true);

// ── 5. end to end through the bridge ────────────────────────────────────────
const sent = [];
let liveHandler = null;
const app = { get() {}, post(path, h) { if (path.includes('/live/')) liveHandler = h; } };
const io = { emit() {}, to: () => ({ emit() {} }), sockets: { emit() {} } };
let scene = 'Match 1 - Live + Hand Blue';
const describe = () => on(scene);
const msg = (text, extra = {}) => ({ platform: 'twitch', userId: String(Math.random()), login: 'viewer1', displayName: 'viewer1', text, ...extra });
const bridge = initChatBridge(app, io, { connect: false, cooldownMs: 0, dwellMs: 60000, decklistsCooldownMs: 30000, listsUrl: '',
    say: async (t) => { sent.push(t); }, describeOnAir: describe });
const settle = () => new Promise(r => setTimeout(r, 20));   // replies are sent asynchronously, in order

bridge.handle(msg('!decklists'));
check('replies in chat with an @mention', sent[0] === '@viewer1 Match 1: Anu (Rengar) vs Asc Samdsherman (LeBlanc)', sent[0]);
bridge.handle(msg('!decklists', { displayName: 'viewer2' }));
bridge.handle(msg('!decks', { displayName: 'viewer3' }));
await settle();
check('silent inside the 30s window (a raid gets one answer)', sent.length === 1, `${sent.length} messages`);

const s2 = [];
const fresh = (d = describe, extra = { listsUrl: '' }) => initChatBridge(app, io, { connect: false, cooldownMs: 0, decklistsCooldownMs: 30000,
    say: async (t) => { s2.push(t); }, describeOnAir: d, ...extra });
let b = fresh();
b.handle(msg('!decklists', { firstMsg: true }));
check('ignores brand-new accounts', s2.length === 0);
b.handle(msg('!decklists', { platform: 'youtube' }));
check('stays quiet on YouTube (read-only)', s2.length === 0);

b = fresh();
liveHandler({ params: { state: 'off' } }, { json() {} });
b.handle(msg('!decklists'));
check('kill switch silences it', s2.length === 0, `${s2.length} messages`);
liveHandler({ params: { state: 'on' } }, { json() {} });
b.handle(msg('!decklists'));
check('answers again once switched back on', s2.length === 1);

s2.length = 0;
b = fresh(() => null);
b.handle(msg('!decklists'));
await settle();
check('can\'t confirm what is on air, no lists doc -> posts nothing', s2.length === 0);
s2.length = 0;
b = fresh(() => null, {});
b.handle(msg('!decklists'));
await settle();
check('can\'t confirm what is on air -> the lists doc alone, never silence', JSON.stringify(s2) === JSON.stringify(['@viewer1 All lists here: https://docs.google.com/document/d/1417NC3vjNUJbROWBqp0tPlFJY7asy-fdsFAMjlBMmzQ']), JSON.stringify(s2));

s2.length = 0;
let calls = 0;
b = fresh(() => { calls++; if (calls === 1) throw new Error('boom'); return 'Match 1: A vs B'; });
let escaped = false;
try { b.handle(msg('!decklists')); } catch { escaped = true; }
check('a failing read cannot throw into the IRC loop', !escaped);
b.handle(msg('!decklists', { displayName: 'viewer9' }));
check('REVIEW: a failed read does not spend the 30s window', s2.length === 1 && s2[0] === '@viewer9 Match 1: A vs B', s2[0]);

s2.length = 0;
b = fresh(() => Array.from({ length: 30 }, () => `Match 1: ${'🔥'.repeat(20)}`).join(' | '));
b.handle(msg('!decklists'));
const reply = s2[0] || '';
check('REVIEW: stays inside Twitch\'s 500-char limit', Array.from(reply).length <= 500, `${Array.from(reply).length} code points`);
check('REVIEW: truncation never leaves a lone surrogate', !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(reply));

// ── 6. the bot must not hear itself ─────────────────────────────────────────
const shown = [], cardSent = [];
const ioCards = { emit: (ev, d) => { if (ev === 'chat-card-shown') shown.push(d.name); }, to: () => ({ emit() {} }), sockets: { emit() {} } };
releaseSlot('3');
b = initChatBridge(app, ioCards, { connect: false, cooldownMs: 0, dwellMs: 60000,
    say: async (t) => { cardSent.push(t); }, describeOnAir: describe });
b.handle({ platform: 'twitch', userId: '1534157386', login: 'anzidbot', displayName: 'anzidbot', text: '@viewer1 Match 1: Anu vs [[Jinx]] (LeBlanc)' });
b.handle({ platform: 'twitch', userId: '1534157386', login: 'AnzidBot', displayName: 'AnzidBot', text: '!c kennen' });
check('REVIEW: the bot\'s own lines never trigger a card or a prompt', shown.length === 0 && cardSent.length === 0,
    `shown=${JSON.stringify(shown)} sent=${JSON.stringify(cardSent)}`);

// ── 7. !card still works, and an open prompt survives !decklists ────────────
releaseSlot('3');
b = initChatBridge(app, ioCards, { connect: false, cooldownMs: 0, dwellMs: 60000,
    say: async (t) => { cardSent.push(t); }, describeOnAir: describe });
const same = { platform: 'twitch', userId: 'u-kennen', login: 'kfan', displayName: 'kfan' };
b.handle({ ...same, text: '!c kennen' });
const prompted = cardSent.some(t => t.includes('did you mean'));
b.handle({ ...same, text: '!decklists' });
b.handle({ ...same, text: '2' });
check('!c still works (ambiguous name prompts)', prompted, cardSent.find(t => t.includes('did you mean')));
check('!decklists does not cancel an open card prompt', shown.length === 1, `shown: ${JSON.stringify(shown)}`);

releaseSlot('3');
shown.length = 0;
b = initChatBridge(app, ioCards, { connect: false, cooldownMs: 0, dwellMs: 60000, say: async () => {}, describeOnAir: describe });
b.handle({ platform: 'twitch', userId: 'u-x', login: 'x', displayName: 'x', text: '!decks [[Loose Cannon]]' });
check('REVIEW: "!decks [[card]]" puts the card on air', shown.length === 1 && /Loose Cannon/.test(shown[0]), JSON.stringify(shown));

// ── 8. the status page previews the reply without posting ──────────────────
let statusHandler = null;
const s8 = [];
initChatBridge({ get(path, h) { if (path.endsWith('/status')) statusHandler = h; }, post() {} }, io,
    { connect: false, say: async (t) => { s8.push(t); }, describeOnAir: describe });
let status = null;
statusHandler({}, { json: (o) => { status = o; } });
check('status page previews what !decklists would say',
    JSON.stringify(status?.decklists?.messages) === JSON.stringify(['@viewer Match 1: Anu (Rengar) vs Asc Samdsherman (LeBlanc)', 'All lists here: https://docs.google.com/document/d/1417NC3vjNUJbROWBqp0tPlFJY7asy-fdsFAMjlBMmzQ']), JSON.stringify(status?.decklists));
check('the preview posts nothing to chat', s8.length === 0);
statusHandler = null;
initChatBridge({ get(path, h) { if (path.endsWith('/status')) statusHandler = h; }, post() {} }, io,
    { connect: false, say: async () => {}, describeOnAir: () => { throw new Error('boom'); } });
statusHandler({}, { json: (o) => { status = o; } });
check('a failing read cannot break the status page', status?.decklists?.error === 'boom', JSON.stringify(status?.decklists));


// ── 9. deck links ────────────────────────────────────────────────────────────
// The two decks on the box's Match 1 board on 2026-09-21. GOLDEN_* are the codes
// Piltover Archive decoded back to these exact lists, card for card, via its own
// POST /v1/decks/export/text {deckCode}.
const ONAIR = {"player-name-left": "Anu", "player-name-right": "Asc Samdsherman&nbsp;", "player-battlefield-left": "Emperor's Dais", "player-battlefield-right": "Windswept Hillock", "player-main-deck-left": "3 Grim Apothecary\n3 Inferna\n3 Irresistible Faefolk\n3 Kai'Sa, Survivor\n3 Kinkou Initiate\n3 Noxus Hopeful\n3 Pit Rookie\n3 Punch First\n3 Thrill of the Hunt\n2 First Mate\n2 Nidalee, Cat Form\n2 Rampage\n2 Sabotage\n1 Darius, Trifarian\n1 Ferrous Forerunner\n1 Pakaa Cub\n1 Pyke, Dockside Butcher", "player-side-deck-left": "2 Decree of Strength\n2 Ferrous Forerunner\n1 Brittle Steel\n1 Brynhir Thundersong\n1 Noxian Demolitionist\n1 Pyke, Dockside Butcher\n1 Rampage\n1 Sabotage", "player-main-deck-right": "3 Cull the Weak\n3 Deathgrip\n3 Glasc Mixologist\n3 Hidden Blade\n3 Karthus, Eternal\n3 Mirror Image\n3 Ruined Rex\n3 Soaring Scout\n3 Watchful Sentry\n2 Honest Broker\n2 Thousand-Tailed Watcher\n1 B.F. Sword\n1 Black Rose Dignitary\n1 Chakram Dancer\n1 Kennen, Keeper of Balance\n1 Ki Barrier\n1 Sacrifice\n1 Stupefy\n1 Vi, Peacekeeper", "player-side-deck-right": "3 Decree of Unity\n2 Decree of Insight\n2 Salvage\n1 Black Rose Dignitary\n1 LeBlanc, Everywhere at Once\n1 Time Warp", "player-legend-left": "Rengar, Pridestalker", "player-champion-left": "Rengar, Trophy Hunter", "player-rune-color-1-left": "r", "player-rune-qty-1-left": "4", "player-rune-color-2-left": "o", "player-rune-qty-2-left": "8", "player-battlefield-1-left": "Emperor's Dais", "player-battlefield-2-left": "Seat of Power", "player-battlefield-3-left": "Star Spring", "player-legend-right": "LeBlanc, Deceiver", "player-champion-right": "LeBlanc, Fragmented", "player-rune-color-1-right": "b", "player-rune-qty-1-right": "4", "player-rune-color-2-right": "y", "player-rune-qty-2-right": "8", "player-battlefield-1-right": "Dusk Rose Lab", "player-battlefield-2-right": "Star Spring", "player-battlefield-3-right": "Windswept Hillock"};
const GOLDEN_LEFT = 'CMAAAAAAAEAQAAD6AAAAAAIBAAAAOAYDAAAAYJ4IAEAQGADBAUCAAAQVMFYLQAIDAIAABBABTQAQCBAAOIAQKACTAMBAAAA3Q4AQGAYACXHQDWIBAQCAAHDYW4A5OAIAAIAQGAAVAECQAVIDAIAAAGU4AEAQIAA4AMCQAA2QKMAQIADY';
const GOLDEN_RIGHT = 'CMAAAAAAAEAQAAGWAEAAAAABAEAAAWIDAUAAAYGRAHKQDWAB5QAQEAYAUMA2KAICAQAEHSABAIAQAADUAEBQBGYBAQBAAAC7VEBACAYAUEAQQBAAI6MADLABVUA3AAOHAHIQDVYBAICQA7UHAEAQCBIAQMAQEAIAADQACAIFAA6QEAIAAB5AEBAALKMACAIEACWAC';
const BUILDER = 'https://piltoverarchive.com/deckbuilder?code=';
const { decklistMessages } = await import('../../features/chat-bridge.js');
const { decodeDeck, encodeDeck } = await import('../../features/riftbound/deck-code.js');
const air = (extra = {}) => ({ ...base, scene: 'Match 1 - Live + Hand Blue', data: { 1: { match1: ONAIR } }, ...extra });

const three = decklistMessages(air(), '@viewer');
check('reply is three messages: match line, then one per player', Array.isArray(three) && three.length === 3, JSON.stringify(three?.map(m => m.slice(0, 60))));
check('match line says it is what is on stream, and that decklists follow', three?.[0] === '@viewer On stream now — Match 1: Anu (Rengar) vs Asc Samdsherman (LeBlanc). Decklists below:', three?.[0]);
check('Anu\'s line links the exact Piltover-verified list', three?.[1] === `Anu (Rengar): ${BUILDER}${GOLDEN_LEFT}`, three?.[1]?.slice(0, 90));
check('Asc Samdsherman\'s line links the exact Piltover-verified list', three?.[2] === `Asc Samdsherman (LeBlanc): ${BUILDER}${GOLDEN_RIGHT}`, three?.[2]?.slice(0, 90));
check('every message fits Twitch\'s 500-char limit', three?.every(m => Array.from(m).length <= 500), JSON.stringify(three?.map(m => m.length)));

// the link IS the board: decode it and compare with what the board holds
const { boardDeck } = _internal;
for (const side of ['left', 'right']) {
    const deck = boardDeck(ONAIR, side);
    const url = three?.[side === 'left' ? 1 : 2] || '';
    const back = decodeDeck(url.split('code=')[1] || '');
    const key = (l) => l.map(([c, n]) => `${c}x${n}`).sort().join(',');
    check(`the ${side} link decodes to exactly the board's deck`, !!back && key(back.main) === key(deck.main) && key(back.side) === key(deck.side) && back.champion === deck.champion);
}

// a deck swap changes the link on its own — nothing stored that could go stale
const swapped = { ...ONAIR, 'player-legend-left': ONAIR['player-legend-right'], 'player-champion-left': ONAIR['player-champion-right'],
    'player-main-deck-left': ONAIR['player-main-deck-right'], 'player-side-deck-left': ONAIR['player-side-deck-right'],
    'player-battlefield-1-left': ONAIR['player-battlefield-1-right'], 'player-battlefield-2-left': ONAIR['player-battlefield-2-right'],
    'player-battlefield-3-left': ONAIR['player-battlefield-3-right'], 'player-rune-color-1-left': ONAIR['player-rune-color-1-right'],
    'player-rune-qty-1-left': ONAIR['player-rune-qty-1-right'], 'player-rune-color-2-left': ONAIR['player-rune-color-2-right'],
    'player-rune-qty-2-left': ONAIR['player-rune-qty-2-right'] };
const sw = decklistMessages(air({ data: { 1: { match1: swapped } } }), '@viewer');
check('swapping the deck on the board swaps the link (no stale link possible)', sw?.[1] === `Anu (LeBlanc): ${BUILDER}${GOLDEN_RIGHT}`, sw?.[1]?.slice(0, 60));

// fallbacks: anything not exactly identifiable -> "no link available", never a guess
const noLink = (mutate, name) => {
    const d = { ...ONAIR, ...mutate };
    const m = decklistMessages(air({ data: { 1: { match1: d } } }), '@viewer');
    check(`no link when ${name}`, m?.[1] === 'Anu (Rengar): no link available' && m?.[2]?.startsWith('Asc Samdsherman (LeBlanc): https://'), m?.[1]);
};
noLink({ 'player-main-deck-left': ONAIR['player-main-deck-left'] + '\n1 Totally Made Up Card' }, 'a card is not in the card database');
noLink({ 'player-main-deck-left': '' }, 'the board has no main deck');
noLink({ 'player-champion-left': '' }, 'the champion is missing');
noLink({ 'player-rune-color-1-left': 'z' }, 'a rune colour is unknown');
noLink({ 'player-side-deck-left': '4 Brittle Steel' }, 'a sideboard count exceeds the format (4 > 3)');
noLink({ 'player-main-deck-left': ONAIR['player-main-deck-left'] + '\n13 Pit Rookie' }, 'a main-deck count exceeds the format (>12)');
check('a token card code cannot be encoded', encodeDeck({ main: [['UNL-T01', 1]], side: [], champion: null }) === null);
check('near-miss card names never resolve (no fuzzy match)', boardDeck({ ...ONAIR, 'player-main-deck-left': '3 Pit Rooki' }, 'left') === null);

// links only where the match line names decks: not 2v2, FFA, or other games
for (const [label, extra] of [['2v2', { playerCount: '2v2' }], ['FFA', { playerCount: 'ffa' }], ['MTG', { game: 'mtg' }]]) {
    const m = decklistMessages(air(extra), '@viewer');
    check(`${label}: a single message, no links`, m?.length === 1 && !/https?:/.test(m[0]), JSON.stringify(m));
}
check('break scene: one message, no links', JSON.stringify(decklistMessages(air({ scene: 'Break - Be Right Back' }), '@viewer')) === JSON.stringify(['@viewer no match is on air right now.']));
check('can\'t confirm what is on air -> null (quiet)', decklistMessages(air({ inSync: notSynced }), '@viewer') === null);

// sending: in order, stops at the first refusal, and says so on the status page
let statusH = null;
const sendApp = { get(path, h) { if (path.endsWith('/status')) statusH = h; }, post() {} };
const got = [];
let refuseAt = -1;
const fake = async (t) => { if (got.length === refuseAt) return { ok: false, reason: 'automod_held' }; got.push(t); return { ok: true }; };
let bb = initChatBridge(sendApp, io, { connect: false, decklistsCooldownMs: 30000, say: fake,
    decklistMessages: (mention) => decklistMessages(air(), mention) });
bb.handle(msg('!decklists', { displayName: 'fan' }));
await new Promise(r => setTimeout(r, 50));
check('all four messages sent, in order', got.length === 4 && got[0].startsWith('@fan On stream now — Match 1:') && got[1].startsWith('Anu (Rengar):') && got[2].startsWith('Asc Samdsherman') && got[3] === 'All lists here: https://docs.google.com/document/d/1417NC3vjNUJbROWBqp0tPlFJY7asy-fdsFAMjlBMmzQ', JSON.stringify(got.map(m => m.slice(0, 30))));
let st = null; statusH({}, { json: (o) => { st = o; } });
check('status page records a clean delivery', st?.decklists?.lastSend?.ok === true && st.decklists.lastSend.sent === 4, JSON.stringify(st?.decklists?.lastSend));
check('status page previews all four messages', st?.decklists?.messages?.length === 4, JSON.stringify(st?.decklists?.messages?.map(m => m.slice(0, 30))));

got.length = 0; refuseAt = 1;
bb = initChatBridge(sendApp, io, { connect: false, decklistsCooldownMs: 30000, say: fake,
    decklistMessages: (mention) => decklistMessages(air(), mention) });
bb.handle(msg('!decklists', { displayName: 'fan' }));
await new Promise(r => setTimeout(r, 50));
check('stops at the first message Twitch refuses (no orphan player lines)', got.length === 1, `${got.length} sent`);
statusH({}, { json: (o) => { st = o; } });
check('a refused reply shows on the status page instead of vanishing',
    st?.decklists?.lastSend?.ok === false && st.decklists.lastSend.sent === 1 && st.decklists.lastSend.reason === 'automod_held', JSON.stringify(st?.decklists?.lastSend));

// a line that would overflow keeps its words and drops the link, never half a URL
got.length = 0; refuseAt = -1;
const huge = `${'W'.repeat(300)} (Rengar): ${BUILDER}${GOLDEN_LEFT}`;
bb = initChatBridge(sendApp, io, { connect: false, decklistsCooldownMs: 30000, say: fake, decklistMessages: () => ['@fan Match 1: A vs B', huge] });
bb.handle(msg('!decklists'));
await new Promise(r => setTimeout(r, 50));
check('an over-long line never carries a cut link', got[1] === `${'W'.repeat(300)} (Rengar): no link available`, got[1]?.slice(-40));


// ── 10. the "all lists" line ────────────────────────────────────────────────
const LISTS_DOC = 'https://docs.google.com/document/d/1417NC3vjNUJbROWBqp0tPlFJY7asy-fdsFAMjlBMmzQ';
const listsReply = async (bridgeOpts, text = '!decklists') => {
    const out = [];
    const br = initChatBridge(app, io, { connect: false, decklistsCooldownMs: 30000, say: async (t) => { out.push(t); }, ...bridgeOpts });
    br.handle(msg(text, { displayName: 'fan' }));
    await settle();
    return out;
};
const lFour = await listsReply({ decklistMessages: (mention) => decklistMessages(air(), mention) });
check('the 4th message is the lists doc', lFour[3] === `All lists here: ${LISTS_DOC}`, lFour[3]);
check('the lists link is the short form (no /edit?usp=drivesdk)', !/usp=|\/edit/.test(lFour[3]));
check('all four messages fit Twitch\'s 500-char limit', lFour.every(m => Array.from(m).length <= 500), JSON.stringify(lFour.map(m => m.length)));
const lBreak = await listsReply({ decklistMessages: (mention) => decklistMessages(air({ scene: 'Break - Be Right Back' }), mention) });
check('on a break: no match, then the lists doc', JSON.stringify(lBreak) === JSON.stringify(['@fan no match is on air right now.', `All lists here: ${LISTS_DOC}`]), JSON.stringify(lBreak));
const l2v2 = await listsReply({ decklistMessages: (mention) => decklistMessages(air({ playerCount: '2v2' }), mention) });
check('2v2: the match (no deck links), then the lists doc', l2v2.length === 2 && l2v2[0].startsWith('@fan On stream now — Match 1:') && !/piltover/.test(l2v2[0]) && l2v2[1] === `All lists here: ${LISTS_DOC}`, JSON.stringify(l2v2));
process.env.DECKLISTS_DOC_URL = 'https://example.org/other-doc';
const lOver = await listsReply({ decklistMessages: (mention) => decklistMessages(air(), mention) });
check('DECKLISTS_DOC_URL in .env overrides the doc', lOver[3] === 'All lists here: https://example.org/other-doc', lOver[3]);
process.env.DECKLISTS_DOC_URL = '';
const lNone = await listsReply({ decklistMessages: (mention) => decklistMessages(air(), mention) });
check('an empty DECKLISTS_DOC_URL leaves the line out', lNone.length === 3 && !lNone.some(m => m.startsWith('All lists')), JSON.stringify(lNone.map(m => m.slice(0, 20))));
delete process.env.DECKLISTS_DOC_URL;


// ── 11. admins, and !p1 / !p2 ───────────────────────────────────────────────
const { parsePiltoverLink } = await import('../../features/riftbound/piltover.js');
const { loadPiltoverDeckIntoControl } = await import('../../features/riftbound/load-piltover-deck.js');
const { parsePlayerDeckCommand } = _internal;
const VIEW = 'https://piltoverarchive.com/decks/view/3323c3c8-b812-4801-b1ee-8640008f2eb6';
const UUID = '3323c3c8-b812-4801-b1ee-8640008f2eb6';

// strict Piltover links only
for (const [link, want, name] of [
    [VIEW, { deckId: UUID }, 'a deck page link'],
    [`piltoverarchive.com/decks/view/${UUID}`, { deckId: UUID }, 'the same link without https://'],
    [`https://www.piltoverarchive.com/decks/view/${UUID}/?utm_source=x`, { deckId: UUID }, 'www., trailing slash and a query'],
    [`https://piltoverarchive.com/deckbuilder?code=${GOLDEN_LEFT}`, { deckCode: GOLDEN_LEFT }, 'a deck-builder code link (what !decklists posts)'],
]) check(`accepts ${name}`, JSON.stringify(parsePiltoverLink(link)) === JSON.stringify(want), JSON.stringify(parsePiltoverLink(link)));
for (const [link, name] of [
    [`https://evil.example/decks/view/${UUID}`, 'a deck id on another site'],
    [`https://piltoverarchive.com.evil.example/decks/view/${UUID}`, 'a look-alike host'],
    [`https://piltoverarchive.com@evil.example/decks/view/${UUID}`, 'a user@host trick'],
    [`https://evil.piltoverarchive.com/decks/view/${UUID}`, 'another subdomain'],
    [`https://piltoverarchive.com:8443/decks/view/${UUID}`, 'an odd port'],
    [`javascript:alert(1)//piltoverarchive.com/decks/view/${UUID}`, 'a javascript: link'],
    [`https://piltoverarchive.com/decks?legends=${UUID}`, 'a browse page, not a deck'],
    [`https://piltoverarchive.com/cards/${UUID}`, 'a card page'],
    [`https://piltoverarchive.com/decks/view/not-a-uuid`, 'a malformed deck id'],
    [UUID, 'a bare deck id'],
    [`${VIEW} extra`, 'a link followed by more words'],
    ['', 'nothing'],
]) check(`rejects ${name}`, parsePiltoverLink(link) === null);

// command parsing
check('!p1 <link> targets the left player', JSON.stringify(parsePlayerDeckCommand(`!p1 ${VIEW}`)) === JSON.stringify({ player: 1, side: 'left', link: VIEW }));
check('!P2 <link> targets the right player', parsePlayerDeckCommand(`!P2 ${VIEW}`)?.side === 'right');
check('bare !p1 parses with no link (so it can reply with usage)', parsePlayerDeckCommand('!p1')?.link === '');
for (const t of ['!p3 x', '!p1x', 'p1 x', '!p12', '!pl'])
    check(`"${t}" is not a player-deck command`, parsePlayerDeckCommand(t) === null);

// the bot, with a fake loader: who may use it, and what they hear back
const MATCH1 = { round_id: '1', match_id: 'match1', label: 'Match 1', broadcast: false, note: null };
const adminRun = async ({ text, login = 'anzidmtg', platform = 'twitch', game = 'riftbound', result, target = MATCH1, bridge = {} }) => {
    const said = [], calls = [];
    setGameSelection(game);
    const br = initChatBridge(app, io, { connect: false, say: async (t) => { said.push(t); return { ok: true }; },
        loadPlayerDeck: async (args) => { calls.push(args); return result || { ok: true, round_id: args.round_id, match_id: args.match_id, legend: 'Kennen, Heart of the Tempest', cards: 40, sideboard: 10 }; },
        deckTarget: () => target, describeOnAir: describe, listsUrl: '', ...bridge });
    br.handle({ platform, userId: 'u-' + login, login, displayName: login, text });
    await settle();
    setGameSelection('riftbound');
    return { said, calls };
};
let r1 = await adminRun({ text: `!p1 ${VIEW}` });
check('admin anzidmtg: !p1 loads the left player of the match on program', r1.calls.length === 1 && r1.calls[0].round_id === '1' && r1.calls[0].match_id === 'match1' && r1.calls[0].side === 'left' && r1.calls[0].link === VIEW, JSON.stringify(r1.calls));
check('admin gets a confirmation naming the player, match and deck', r1.said[0] === '@anzidmtg Player 1 (Match 1) now has Kennen, Heart of the Tempest — 40 cards, 10 in the sideboard.', r1.said[0]);
check('…and only that one message on Match 1', r1.said.length === 1, JSON.stringify(r1.said));

// Match 2 on program: the Broadcast round's match2, then a reminder to press Broadcast
r1 = await adminRun({ text: `!p2 ${VIEW}`, target: { round_id: '4', match_id: 'match2', label: 'Match 2', broadcast: true, note: null } });
check('Match 2 on program: !p2 loads the Broadcast round\'s match2', r1.calls[0]?.round_id === '4' && r1.calls[0]?.match_id === 'match2' && r1.calls[0]?.side === 'right', JSON.stringify(r1.calls));
check('Match 2: the confirmation names the round', r1.said[0] === '@anzidmtg Player 2 (Match 2, round 4) now has Kennen, Heart of the Tempest — 40 cards, 10 in the sideboard.', r1.said[0]);
check('Match 2: a second message says to press Broadcast', r1.said[1] === '@anzidmtg press Broadcast to put it on the Match 2 header.' && r1.said.length === 2, JSON.stringify(r1.said));
r1 = await adminRun({ text: `!p2 ${VIEW}`, target: { round_id: '4', match_id: 'match2', label: 'Match 2', broadcast: true, note: null }, result: { ok: false, reason: 'not-found' } });
check('Match 2: no Broadcast reminder when nothing loaded', r1.said.length === 1 && !/Broadcast/.test(r1.said[0]), JSON.stringify(r1.said));
// not on a match scene: Match 1, and the reply says why
r1 = await adminRun({ text: `!p1 ${VIEW}`, target: { ...MATCH1, note: 'No match is on program, so it went to Match 1.' } });
check('a break scene: loads into Match 1 and says why', r1.said[0]?.endsWith('10 in the sideboard. No match is on program, so it went to Match 1.'), r1.said[0]);
r1 = await adminRun({ text: `!p1 ${VIEW}`, target: { refuse: 'both matches are on program, so I can\'t tell which one you mean.' } });
check('a refusal from the target is said, and nothing is loaded', r1.calls.length === 0 && r1.said[0] === "@anzidmtg both matches are on program, so I can't tell which one you mean.", JSON.stringify(r1));
r1 = await adminRun({ text: `!p2 ${VIEW}`, login: 'NotVeryRichard' });
check('admin NotVeryRichard (any capitalisation): !p2 loads the right side', r1.calls[0]?.side === 'right' && r1.said[0]?.startsWith('@NotVeryRichard Player 2 (Match 1) now has'), JSON.stringify(r1));
r1 = await adminRun({ text: `!p1 ${VIEW}`, login: 'randomviewer' });
check('a non-admin\'s !p1 does nothing and says nothing', r1.calls.length === 0 && r1.said.length === 0, JSON.stringify(r1));
r1 = await adminRun({ text: `!p1 ${VIEW}`, platform: 'youtube' });
check('"anzidmtg" on YouTube is not an admin (names there are free text)', r1.calls.length === 0 && r1.said.length === 0);
r1 = await adminRun({ text: '!p1 https://moxfield.com/decks/abc' , result: { ok: false, reason: 'not-piltover' } });
check('a non-Piltover link gets a clear error', /isn't a Piltover Archive deck link/.test(r1.said[0] || ''), r1.said[0]);
r1 = await adminRun({ text: '!p1' });
check('!p1 with no link gets usage', r1.calls.length === 0 && r1.said[0] === '@anzidmtg usage: !p1 <Piltover Archive deck link>', r1.said[0]);
r1 = await adminRun({ text: `!p1 ${VIEW}`, result: { ok: false, reason: 'not-found', status: 404 } });
check('a private or draft deck says so', /couldn't find that deck — is it public/.test(r1.said[0] || ''), r1.said[0]);
r1 = await adminRun({ text: `!p1 ${VIEW}`, result: { ok: false, reason: 'fetch-failed', status: 503 } });
check('Piltover being down says try again', /\(503\) — try again/.test(r1.said[0] || ''), r1.said[0]);
r1 = await adminRun({ text: `!p1 ${VIEW}`, result: { ok: false, reason: 'not-configured', detail: 'PILTOVER_API_KEY not set in .env' } });
check('REVIEW F12: a missing/rejected API key says so, not "try again"', /API key is missing or was rejected/.test(r1.said[0] || '') && !/try again/.test(r1.said[0]), r1.said[0]);
r1 = await adminRun({ text: `!p1 ${VIEW}`, result: { ok: false, reason: 'bad-link', status: 400 } });
check('REVIEW F12: Piltover rejecting the link says check the link', /isn't a valid deck — check the link/.test(r1.said[0] || ''), r1.said[0]);
r1 = await adminRun({ text: `!p1 ${VIEW}`, result: { ok: false, reason: 'superseded' } });
check('REVIEW F10: a load replaced by a newer !p1 says so', r1.said[0] === '@anzidmtg not loaded — a newer !p1 for that player replaced it.', r1.said[0]);
r1 = await adminRun({ text: `!p1 ${VIEW}`, result: { ok: false, reason: 'no-match' } });
check('a match master control has not set up is named', r1.said[0] === "@anzidmtg Match 1 isn't set up in master control.", r1.said[0]);
// resending: chat clients append an invisible character to a repeated message
r1 = await adminRun({ text: `!p1 ${VIEW} \u{E0000}` });
check('REVIEW F11: a re-sent !p1 (7TV/Chatterino " \\u{E0000}") still reads the link', r1.calls[0]?.link === VIEW, JSON.stringify(r1.calls));
r1 = await adminRun({ text: `!p1 ${VIEW}͏` });
check('REVIEW F11: …and with U+034F', r1.calls[0]?.link === VIEW, JSON.stringify(r1.calls));
r1 = await adminRun({ text: '!p1 \u{E0000}' });
check('REVIEW F11: a re-sent bare !p1 gets usage, not a link error', r1.said[0] === '@anzidmtg usage: !p1 <Piltover Archive deck link>', r1.said[0]);
{
    const said = [];
    const br = initChatBridge(app, io, { connect: false, listsUrl: '', say: async (t) => { said.push(t); }, describeOnAir: describe });
    br.handle({ platform: 'twitch', userId: 'rs', login: 'viewer', displayName: 'viewer', text: '!decklists \u{E0000}' });
    await settle();
    check('REVIEW F11: a re-sent !decklists is still answered', said.length === 1 && said[0].startsWith('@viewer Match 1:'), JSON.stringify(said));
}
// a viewer's "!p1 …" line is ordinary chat: a [[card]] in it still goes up
{
    releaseSlot('3');
    const shownNow = [];
    const ioC = { emit: (ev, d) => { if (ev === 'chat-card-shown') shownNow.push(d.name); }, to: () => ({ emit() {} }), sockets: { emit() {} } };
    const br = initChatBridge(app, ioC, { connect: false, cooldownMs: 0, dwellMs: 60000, say: async () => {}, describeOnAir: describe, loadPlayerDeck: async () => { throw new Error('must not load'); } });
    br.handle({ platform: 'twitch', userId: 'v14', login: 'viewer', displayName: 'viewer', text: '!p1 is cooked [[Loose Cannon]]' });
    check('REVIEW F14: a viewer\'s "!p1 … [[card]]" still shows the card', shownNow.length === 1 && /Loose Cannon/.test(shownNow[0]), JSON.stringify(shownNow));
    releaseSlot('3');
}
{
    // …but an admin's "!p1 <anything>" stays the deck command, whatever is on
    // the line: it is what follows !p1 that is meant to be a deck link, and
    // saying so beats putting a card on air instead.
    releaseSlot('3');
    const shownNow = [], said = [];
    const ioC = { emit: (ev, d) => { if (ev === 'chat-card-shown') shownNow.push(d.name); }, to: () => ({ emit() {} }), sockets: { emit() {} } };
    const br = initChatBridge(app, ioC, { connect: false, cooldownMs: 0, dwellMs: 60000, say: async (t) => { said.push(t); }, describeOnAir: describe,
        deckTarget: () => MATCH1 });
    br.handle({ platform: 'twitch', userId: 'a14', login: 'anzidmtg', displayName: 'anzidmtg', text: '!p1 [[Loose Cannon]]' });
    await settle();
    check('an admin\'s "!p1 [[card]]" is a bad deck link, not a card on air', shownNow.length === 0 && /isn't a Piltover Archive deck link/.test(said[0] || ''), JSON.stringify([shownNow, said]));
    releaseSlot('3');
}
r1 = await adminRun({ text: `!p1 ${VIEW}`, game: 'mtg' });
check('!p1 during an MTG show explains it is Riftbound-only', r1.calls.length === 0 && /only works for Riftbound/.test(r1.said[0] || ''), r1.said[0]);
r1 = await adminRun({ text: `!p1 ${VIEW}`, bridge: { admins: ['someoneelse'] } });
check('admins come from config — a login not on the list is refused', r1.calls.length === 0);
process.env.CHAT_ADMINS = 'OtherMod';
r1 = await adminRun({ text: `!p1 ${VIEW}`, login: 'othermod' });
check('CHAT_ADMINS in .env replaces the list', r1.calls.length === 1);
r1 = await adminRun({ text: `!p1 ${VIEW}` });
check('…and then the defaults no longer apply', r1.calls.length === 0);
delete process.env.CHAT_ADMINS;

// kill switch covers admin commands too
{
    const said = [], calls = [];
    const br = initChatBridge(app, io, { connect: false, say: async (t) => { said.push(t); }, loadPlayerDeck: async (a) => { calls.push(a); return { ok: true }; }, describeOnAir: describe });
    liveHandler({ params: { state: 'off' } }, { json() {} });
    br.handle({ platform: 'twitch', userId: 'a', login: 'anzidmtg', displayName: 'anzidmtg', text: `!p1 ${VIEW}` });
    await settle();
    check('the kill switch stops admin commands too', calls.length === 0 && said.length === 0);
}
{
    // …including one already waiting on Piltover when the switch is hit
    const said = [];
    let release, commitAllowed = null;
    const br = initChatBridge(app, io, { connect: false, listsUrl: '', say: async (t) => { said.push(t); }, describeOnAir: describe, deckTarget: () => MATCH1,
        loadPlayerDeck: async (a) => { await new Promise(r => { release = r; }); commitAllowed = a.shouldCommit(); return commitAllowed ? { ok: true, legend: 'X', cards: 40, sideboard: 0 } : { ok: false, reason: 'paused' }; } });
    br.handle({ platform: 'twitch', userId: 'a', login: 'anzidmtg', displayName: 'anzidmtg', text: `!p1 ${VIEW}` });
    await settle();
    liveHandler({ params: { state: 'off' } }, { json() {} });
    release();
    await settle();
    check('REVIEW F1: a load in flight when the kill switch is hit is told not to write', commitAllowed === false);
    check('REVIEW F1: …and the bot says nothing while paused', said.length === 0, JSON.stringify(said));
}

// where !p1 / !p2 go: the match on program
{
    const { deckTarget } = _internal;
    const t = (scene, extra = {}) => deckTarget({ scene, tracker: { 1: { round_id: '5', match_id: 'match1' } }, broadcast: { round_id: '4' }, ...extra });
    let d = t('Match 1 - Live + Hand Blue');
    check('target: a Match 1 scene -> Control 1\'s match', d.round_id === '5' && d.match_id === 'match1' && d.broadcast === false && d.note === null, JSON.stringify(d));
    d = t('Match 2 - Live*');
    check('target: a Match 2 scene -> the Broadcast round\'s match2, flagged for the reminder', d.round_id === '4' && d.match_id === 'match2' && d.broadcast === true && d.label === 'Match 2', JSON.stringify(d));
    d = t('Match 2 - Live', { broadcast: { round_id: 4 } });
    check('target: a numeric Broadcast round id is used as the controlData key', d.round_id === '4', JSON.stringify(d));
    d = t('Match 2 - Live', { broadcast: { round_id: null } });
    check('target: Match 2 with nothing broadcast since boot is refused', /press Broadcast, then try again/.test(d.refuse || ''), JSON.stringify(d));
    d = t('Break');
    check('target: a break scene -> Match 1, with a note', d.match_id === 'match1' && d.note === 'No match is on program, so it went to Match 1.', JSON.stringify(d));
    d = t(null);
    check('target: OBS not connected -> Match 1, with a note', d.match_id === 'match1' && /can't see OBS/.test(d.note || ''), JSON.stringify(d));
    d = t('Match 1 + Match 2 split');
    check('target: both matches on program is refused', /both matches are on program/.test(d.refuse || ''), JSON.stringify(d));
}

// admins skip cooldowns; everyone else waits the (now 1-minute) window
check('the !decklists window is 1 minute', _internal.DEFAULTS?.decklistsCooldownMs === 60000, String(_internal.DEFAULTS?.decklistsCooldownMs));
{
    const said = [];
    const br = initChatBridge(app, io, { connect: false, listsUrl: '', say: async (t) => { said.push(t); }, describeOnAir: describe });
    const as = (login) => ({ platform: 'twitch', userId: 'u' + login, login, displayName: login, text: '!decklists' });
    br.handle(as('viewer'));      // answered, opens the window
    br.handle(as('viewer2'));     // inside the window: ignored
    br.handle(as('anzidmtg'));    // admin: answered anyway
    br.handle(as('NotVeryRichard'));
    await settle();
    const to = said.map(m => m.split(' ')[0]);
    check('viewers wait out the window; admins do not', JSON.stringify(to) === JSON.stringify(['@viewer', '@anzidmtg', '@NotVeryRichard']), JSON.stringify(to));
}
{
    releaseSlot('3');
    const shownNow = [];
    const ioC = { emit: (ev, d) => { if (ev === 'chat-card-shown') shownNow.push(d.requestedBy); }, to: () => ({ emit() {} }), sockets: { emit() {} } };
    const br = initChatBridge(app, ioC, { connect: false, cooldownMs: 60000, dwellMs: 60000, say: async () => {}, describeOnAir: describe });
    const card = (login) => ({ platform: 'twitch', userId: 'c' + login, login, displayName: login, text: '[[Loose Cannon]]' });
    br.handle(card('viewer'));
    br.handle(card('viewer2'));   // cooldown: parked, not shown
    br.handle(card('anzidmtg'));  // admin: shown now
    check('admins skip the !card cooldown too', JSON.stringify(shownNow) === JSON.stringify(['viewer', 'anzidmtg']), JSON.stringify(shownNow));
    releaseSlot('3');
}

// the real loader, end to end, against real control.js (saving to a scratch file)
{
    const PA_TEXT = `Legend:\n1 Kennen, Heart of the Tempest\n\nChampion:\n1 Kennen, Keeper of Balance\n\nMainDeck:\n3 Stupefy\n3 Pit Rookie\n\nBattlefields:\n1 Star Spring\n1 Seat of Power\n\nRunes:\n6 Chaos Rune\n6 Order Rune\n`;
    const emits = [];
    const ioL = { to: (room) => ({ emit: (ev, d) => emits.push({ room, ev, d }) }), emit: (ev, d) => emits.push({ room: '*', ev, d }) };
    const tracker = control.getControlsTracker();
    tracker['1'] = { round_id: '1', match_id: 'match1' };
    const at = { round_id: '1', match_id: 'match1', io: ioL };
    // the previous player's deck, including a sideboard and a third battlefield the new list lacks
    await control.updateFieldsFromServer('1', 'match1', { 'player-side-deck-left': '3 Old Card', 'player-battlefield-3-left': 'Old Battlefield', 'player-name-left': 'Anu', 'showdown-bf-1-name': 'Old Battlefield', 'player-legend-left': 'Old Legend' }, ioL);
    // a client whose clock runs ahead stamped a field in the future
    control.getControlData()['1'].match1._timestamps['player-main-deck-left'] = Date.now() + 3_600_000;
    emits.length = 0;
    const fetched = [];
    const res = await loadPiltoverDeckIntoControl({ ...at, side: 'left', link: VIEW, fetchText: async (ref) => { fetched.push(ref); return PA_TEXT; } });
    const m = control.getControlData()['1'].match1;
    check('loader: fetched by deck id', JSON.stringify(fetched) === JSON.stringify([{ deckId: UUID }]), JSON.stringify(fetched));
    check('loader: reports the deck', res.ok && res.legend === 'Kennen, Heart of the Tempest' && res.cards === 7 && res.sideboard === 0, JSON.stringify(res));
    check('loader: the new deck is on the board', m['player-legend-left'] === 'Kennen, Heart of the Tempest' && m['player-main-deck-left'] === '3 Stupefy\n3 Pit Rookie' && m['player-rune-color-1-left'] === 'p' && m['player-rune-qty-1-left'] === '6');
    check('loader: the old player\'s sideboard is cleared, not left behind', m['player-side-deck-left'] === '', JSON.stringify(m['player-side-deck-left']));
    check('loader: a battlefield slot the new list lacks is cleared', m['player-battlefield-3-left'] === '', JSON.stringify(m['player-battlefield-3-left']));
    check('REVIEW F7: the showdown tracker\'s BF 1 name follows the new active battlefield', m['showdown-bf-1-name'] === 'Star Spring' && m['player-battlefield-left'] === 'Star Spring', JSON.stringify([m['showdown-bf-1-name'], m['player-battlefield-left']]));
    check('loader: the player name is untouched', m['player-name-left'] === 'Anu');
    check('loader: the right player is untouched', !('player-legend-right' in m) && !('showdown-bf-2-name' in m));
    const mc = emits.filter(e => e.room === 'master-control' && e.ev === 'field-updated');
    check('loader: master control is told field by field', mc.length === 13 && mc.every(e => e.d.round_id === '1' && e.d.match_id === 'match1'), `${mc.length} field-updated`);
    check('loader: an update beats a future client timestamp', mc.find(e => e.d.field === 'player-main-deck-left')?.d.timestamp > Date.now() + 3_000_000);
    check('loader: control page and scoreboard get the new state once each',
        emits.filter(e => e.room === 'control-1').length === 1 && emits.filter(e => e.room === 'scoreboard-1').length === 1);
    check('REVIEW F5: master control hears every field before the state goes out',
        emits.findIndex(e => e.room === 'scoreboard-1') > emits.findLastIndex(e => e.ev === 'field-updated'));
    check('loader: saved to the scratch file, not the real match data', existsSync(process.env.CONTROL_DATA_PATH));

    // REVIEW F5: master control's copy, sent before it heard the load, must not put the old deck back
    const stale = JSON.parse(JSON.stringify(m));
    for (const f of Object.keys(stale)) if (f.endsWith('-left') && f !== 'player-name-left' || f === 'showdown-bf-1-name') { stale[f] = f === 'player-legend-left' ? 'Old Legend' : 'stale'; delete stale._timestamps[f]; }
    stale['player-name-left'] = 'Anu Edited';          // the operator's own edit in that copy
    stale._timestamps['player-name-left'] = m._timestamps['player-name-left'];
    emits.length = 0;
    await control.updateFromMaster({ 1: { match1: stale } }, ioL);
    let now = control.getControlData()['1'].match1;
    check('REVIEW F5: a stale master copy keeps the loaded deck', now['player-legend-left'] === 'Kennen, Heart of the Tempest' && now['player-main-deck-left'] === '3 Stupefy\n3 Pit Rookie' && now['showdown-bf-1-name'] === 'Star Spring', JSON.stringify([now['player-legend-left'], now['player-main-deck-left']]));
    check('REVIEW F5: …and its timestamps', now._timestamps['player-legend-left'] === m._timestamps['player-legend-left']);
    check('REVIEW F5: …while the operator\'s edit in that copy still lands', now['player-name-left'] === 'Anu Edited');
    check('REVIEW F5: the scoreboard gets the loaded deck', emits.find(e => e.room === 'scoreboard-1')?.d.data['player-legend-left'] === 'Kennen, Heart of the Tempest');
    // once master control has heard the load, its edits to those fields land as normal
    const caughtUp = JSON.parse(JSON.stringify(now));
    caughtUp['player-main-deck-left'] = '3 Stupefy\n2 Pit Rookie';
    await control.updateFromMaster({ 1: { match1: caughtUp } }, ioL);
    now = control.getControlData()['1'].match1;
    check('REVIEW F5: a caught-up master edit to a loaded field lands', now['player-main-deck-left'] === '3 Stupefy\n2 Pit Rookie', now['player-main-deck-left']);
    const later = JSON.parse(JSON.stringify(stale));
    later['player-legend-left'] = 'Operator Legend';
    await control.updateFromMaster({ 1: { match1: later } }, ioL);
    check('REVIEW F5: …and after that the protection is gone (master is in charge again)', control.getControlData()['1'].match1['player-legend-left'] === 'Operator Legend');

    // a load racing a master-control update during its save: what goes on air is what the server holds
    await control.updateFieldsFromServer('1', 'match1', { 'player-legend-left': 'Kennen, Heart of the Tempest' }, ioL);
    emits.length = 0;
    const racing = loadPiltoverDeckIntoControl({ ...at, side: 'right', link: VIEW, fetchText: async () => PA_TEXT });
    await new Promise(r => setImmediate(r));
    // master's copy from before the load: the right player's old deck, never stamped
    const staleRight = { ...JSON.parse(JSON.stringify(stale)), 'player-legend-right': 'Old Right', 'player-main-deck-right': '3 Old Card' };
    await control.updateFromMaster({ 1: { match1: staleRight } }, ioL);
    await racing;
    now = control.getControlData()['1'].match1;
    const lastBoard = emits.filter(e => e.room === 'scoreboard-1').at(-1)?.d.data;
    check('REVIEW F5: racing master update — server keeps the new right deck', now['player-legend-right'] === 'Kennen, Heart of the Tempest', now['player-legend-right']);
    check('REVIEW F5: racing master update — the last scoreboard push matches the server', lastBoard && lastBoard['player-legend-right'] === now['player-legend-right'] && lastBoard['player-legend-left'] === now['player-legend-left'], JSON.stringify(lastBoard && [lastBoard['player-legend-left'], lastBoard['player-legend-right']]));
    check('loader: !p2 names BF 2 in the showdown tracker', now['showdown-bf-2-name'] === 'Star Spring');

    // refusals and failures
    const legendBefore = control.getControlData()['1'].match1['player-legend-left'];
    const mustNotFetch = async () => { throw new Error('must not fetch'); };
    const bad = await loadPiltoverDeckIntoControl({ ...at, side: 'left', link: `https://evil.example/decks/view/${UUID}`, fetchText: mustNotFetch });
    check('loader: a non-Piltover link is refused before any network call', bad.reason === 'not-piltover');
    const nomatch = await loadPiltoverDeckIntoControl({ ...at, match_id: 'match9', side: 'left', link: VIEW, fetchText: mustNotFetch });
    check('loader: a match master control has not set up is refused before any network call (no phantom match)', nomatch.reason === 'no-match' && !control.getControlData()['1'].match9, JSON.stringify(nomatch));
    const nothing = await loadPiltoverDeckIntoControl({ round_id: undefined, match_id: undefined, side: 'left', link: VIEW, io: ioL, fetchText: mustNotFetch });
    check('loader: no target at all is refused', nothing.reason === 'no-match');
    const fail = async (make) => loadPiltoverDeckIntoControl({ ...at, side: 'left', link: VIEW, fetchText: async () => { throw make(); } });
    const withStatus = (status, message = `Request failed with status code ${status}`) => () => { const e = new Error(message); e.response = { status }; return e; };
    let f = await fail(withStatus(404));
    check('loader: Piltover 404 -> not-found', f.reason === 'not-found' && f.status === 404, JSON.stringify(f));
    f = await fail(() => { const e = new Error('PILTOVER_API_KEY not set in .env'); e.status = 500; return e; });
    check('REVIEW F12: no API key -> not-configured, with the cause kept for the log', f.reason === 'not-configured' && /PILTOVER_API_KEY not set/.test(f.detail), JSON.stringify(f));
    f = await fail(withStatus(401));
    check('REVIEW F12: a rejected key (401) -> not-configured', f.reason === 'not-configured', JSON.stringify(f));
    f = await fail(withStatus(400));
    check('REVIEW F12: Piltover rejecting the deck (400) -> bad-link', f.reason === 'bad-link', JSON.stringify(f));
    f = await fail(withStatus(503));
    check('loader: Piltover down (503) -> fetch-failed 503', f.reason === 'fetch-failed' && f.status === 503, JSON.stringify(f));
    f = await fail(() => Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' }));
    check('loader: a timeout -> fetch-failed', f.reason === 'fetch-failed' && /timeout/.test(f.detail), JSON.stringify(f));
    const empty = await loadPiltoverDeckIntoControl({ ...at, side: 'left', link: VIEW, fetchText: async () => 'Sideboard:\n1 Stupefy\n' });
    check('loader: a list with no legend or main deck is refused', empty.reason === 'not-a-deck');
    check('loader: a refused load leaves the board as it was', control.getControlData()['1'].match1['player-legend-left'] === legendBefore, legendBefore);

    // REVIEW F10/F13: a slow load overtaken by a newer one for the same player is dropped
    const OTHER = PA_TEXT.replace(/Kennen, Heart of the Tempest/, 'Rengar, Pridestalker').replace(/Kennen, Keeper of Balance/, 'Rengar, Trophy Hunter');
    let releaseSlow;
    const slow = loadPiltoverDeckIntoControl({ ...at, side: 'left', link: VIEW, fetchText: () => new Promise(r => { releaseSlow = () => r(PA_TEXT); }) });
    const quick = await loadPiltoverDeckIntoControl({ ...at, side: 'left', link: VIEW, fetchText: async () => OTHER });
    releaseSlow();
    const slowRes = await slow;
    check('REVIEW F10: the newer !p1 lands', quick.ok && quick.legend === 'Rengar, Pridestalker', JSON.stringify(quick));
    check('REVIEW F10: the older, slower one is dropped as superseded', slowRes.reason === 'superseded', JSON.stringify(slowRes));
    check('REVIEW F10: the board keeps the newer deck', control.getControlData()['1'].match1['player-legend-left'] === 'Rengar, Pridestalker');
    const otherSide = await loadPiltoverDeckIntoControl({ ...at, side: 'right', link: VIEW, fetchText: async () => PA_TEXT });
    check('REVIEW F10: loads for different players don\'t cancel each other', otherSide.ok);

    // REVIEW F1: the kill switch hit while Piltover is answering -> nothing written
    const paused = await loadPiltoverDeckIntoControl({ ...at, side: 'left', link: VIEW, fetchText: async () => PA_TEXT, shouldCommit: () => false });
    check('REVIEW F1: shouldCommit false after the fetch -> paused, nothing written', paused.reason === 'paused' && control.getControlData()['1'].match1['player-legend-left'] === 'Rengar, Pridestalker', JSON.stringify(paused));

    // AUDIT: a load that writes nothing hands its slot back, so a mistyped
    // second link can't cancel the good one still in flight
    let releaseGood;
    const good = loadPiltoverDeckIntoControl({ ...at, side: 'left', link: VIEW, fetchText: () => new Promise(r => { releaseGood = () => r(OTHER); }) });
    const typo = await loadPiltoverDeckIntoControl({ ...at, side: 'left', link: VIEW, fetchText: async () => { const e = new Error('nf'); e.response = { status: 404 }; throw e; } });
    releaseGood();
    const goodRes = await good;
    check('AUDIT: a failed !p1 does not cancel the good one still in flight', typo.reason === 'not-found' && goodRes.ok && control.getControlData()['1'].match1['player-legend-left'] === 'Rengar, Pridestalker', JSON.stringify([typo, goodRes]));

    // AUDIT: when the guard keeps the server's value, master control is TOLD —
    // so the operator sees it, and their next copy is no longer refused
    await control.updateFieldsFromServer('1', 'match1', { 'player-champion-left': 'Bot Champion' }, ioL);
    const blind = JSON.parse(JSON.stringify(control.getControlData()['1'].match1));   // a copy that never heard it
    blind['player-champion-left'] = 'Operator Champion';
    delete blind._timestamps['player-champion-left'];
    emits.length = 0;
    await control.updateFromMaster({ 1: { match1: blind } }, ioL);
    const told = emits.filter(e => e.ev === 'field-updated' && e.d.field === 'player-champion-left');
    check('AUDIT: an overridden field is sent back to master control', told.length === 1 && told[0].d.value === 'Bot Champion' && told[0].room === 'master-control', JSON.stringify(told.map(e => [e.room, e.d.value])));
    check('AUDIT: …the server keeps its value for that one edit', control.getControlData()['1'].match1['player-champion-left'] === 'Bot Champion');
    // master control applies that field-updated (its timestamp is newer), so its next copy carries it
    blind._timestamps['player-champion-left'] = told[0].d.timestamp;
    blind['player-champion-left'] = 'Operator Champion 2';
    await control.updateFromMaster({ 1: { match1: blind } }, ioL);
    check('AUDIT: …and the operator\'s next edit lands, the guard is done', control.getControlData()['1'].match1['player-champion-left'] === 'Operator Champion 2', control.getControlData()['1'].match1['player-champion-left']);
}

// ── 12. a player with no sideboard ───────────────────────────────────────────
// The pages keep the last sideboard they were given, so both deck paths must
// say "this player has none" out loud rather than skipping the message.
{
    const { transformAndEmitAllDecks } = await import('../../features/transformAllDecks.js');
    const noSide = { 1: { match1: {
        'player-legend-left': 'Rengar, Pridestalker', 'player-champion-left': 'Rengar, Trophy Hunter',
        'player-main-deck-left': '3 Pit Rookie', 'player-side-deck-left': '',
        'player-legend-right': 'LeBlanc, Deceiver', 'player-champion-right': 'LeBlanc, Fragmented',
        'player-main-deck-right': '3 Stupefy', 'player-side-deck-right': '2 Salvage',
    } } };
    const out = [];
    const ioD = { to: (room) => ({ emit: (ev, d) => out.push({ room, ev, d }) }), emit: (ev, d) => out.push({ room: '*', ev, d }) };
    transformAndEmitAllDecks('1', noSide, ioD);
    const sides = out.filter(e => e.ev === 'transformed-side-deck-data').map(e => [e.d.sideID, e.d.deckData.length]);
    check('Broadcast: a player with no sideboard is sent an empty one, not nothing',
        JSON.stringify(sides.filter(s => s[0] === 'left')[0]) === JSON.stringify(['left', 0]), JSON.stringify(sides));
    check('Broadcast: the other player\'s sideboard still goes out',
        JSON.stringify(sides.filter(s => s[0] === 'right')[0]) === JSON.stringify(['right', 1]), JSON.stringify(sides));
    const { getCachedTransform } = await import('../../features/transformCache.js');
    const cached = getCachedTransform('match1', 'left');
    check('Broadcast: the empty sideboard is cached, so a page that loads late gets it too',
        !!cached?.side && Array.isArray(cached.side.deckData) && cached.side.deckData.length === 0, JSON.stringify(cached && Object.keys(cached)));
}
rmSync(process.env.CONTROL_DATA_PATH, { force: true });
check('the real data/controlData.json was never touched', realHash() === REAL_BEFORE);

// ── 13. YouTube read pacing (what the daily quota actually buys) ─────────────
{
    const { nextPollMs } = await import('../../features/chat/youtube-live.js');
    const floorMs = 5000;
    check('pacing: chat is talking -> the operator\'s interval',
        nextPollMs({ floorMs, gotMessages: 2, quietMs: 0 }) === 5000);
    check('pacing: a short lull still reads at the operator\'s interval',
        nextPollMs({ floorMs, gotMessages: 0, quietMs: 30000 }) === 5000);
    check('pacing: two minutes of silence -> slow down, stop paying for nothing',
        nextPollMs({ floorMs, gotMessages: 0, quietMs: 150000 }) === 10000);
    check('pacing: a message after the lull -> straight back to speed',
        nextPollMs({ floorMs, gotMessages: 1, quietMs: 150000 }) === 5000);
    check('pacing: paused by the kill switch -> barely read at all',
        nextPollMs({ floorMs, gotMessages: 5, quietMs: 0, paused: true }) === 60000);
    check('pacing: YouTube asking for SLOWER is obeyed',
        nextPollMs({ floorMs, gotMessages: 1, quietMs: 0, apiHintMs: 8000 }) === 8000);
    check('pacing: YouTube asking for faster is not (it would burn the day by lunch)',
        nextPollMs({ floorMs, gotMessages: 1, quietMs: 0, apiHintMs: 1000 }) === 5000);
    check('pacing: an operator floor slower than idle is never sped up',
        nextPollMs({ floorMs: 15000, gotMessages: 0, quietMs: 150000 }) === 15000);
    check('pacing: a long between-rounds lull backs off further',
        nextPollMs({ floorMs, gotMessages: 0, quietMs: 20 * 60000 }) === 30000);
    // an overrunning show costs latency, not the feature
    check('hedge: 80% of the budget spent -> stretch to 10s', nextPollMs({ floorMs, gotMessages: 3, quietMs: 0, spentFrac: 0.82 }) === 10000);
    check('hedge: 90% -> 20s', nextPollMs({ floorMs, gotMessages: 3, quietMs: 0, spentFrac: 0.91 }) === 20000);
    check('hedge: 95% -> 30s, still reading rather than dark', nextPollMs({ floorMs, gotMessages: 3, quietMs: 0, spentFrac: 0.99 }) === 30000);
    check('hedge: an 8-hour show never reaches those tiers', (8 * 3600 / 5) / 9000 < 0.8, `${((8 * 3600 / 5) / 9000 * 100).toFixed(0)}% of budget`);
    check('hedge: a busy chat still wins over a long-quiet backoff', nextPollMs({ floorMs, gotMessages: 4, quietMs: 20 * 60000 }) === 5000);

    // what a real show costs: the number the user actually asked about
    const units = (hours, ms) => Math.round((hours * 3600 * 1000) / ms);
    check('a 6-hour show at 5s fits the daily pool with room to spare', units(6, 5000) === 4320 && units(6, 5000) < 9000, `${units(6, 5000)} units`);
    check('a 6-hour show at 3s still fits', units(6, 3000) === 7200 && units(6, 3000) < 9000, `${units(6, 3000)} units`);
    check('an 8-hour show at 5s fits inside the budget', units(8, 5000) === 5760 && units(8, 5000) < 9000, `${units(8, 5000)} units`);
    check('an 8-hour show at 3s does NOT (this is why 5s is the default)', units(8, 3000) > 9000, `${units(8, 3000)} units`);
}

// ── 14. YouTube replies: one short message, and a quota that can't run away ──
{
    const { youtubeDecklistsMessage, _internal: yti } = await import('../../features/chat-bridge.js');
    const { createYouTubeSender, MAX_MESSAGE, messageLength } = await import('../../features/chat/youtube-send.js');
    const q = await import('../../features/chat/youtube-quota.js');
    const DOC = 'https://docs.google.com/document/d/1417NC3vjNUJbROWBqp0tPlFJY7asy-fdsFAMjlBMmzQ';
    const ytAir = (extra = {}) => ({ ...base, scene: 'Match 1 - Live + Hand Blue', data: { 1: { match1: ONAIR } }, ...extra });

    const one = youtubeDecklistsMessage(ytAir(), '@viewer', DOC);
    check('youtube: one message, naming the match and the lists doc',
        /On stream now — Match 1: Anu \(Rengar\) vs Asc Samdsherman \(LeBlanc\)/.test(one) && one.includes(DOC), one);
    check('youtube: it fits the 200-character limit', messageLength(one) <= 200, `${messageLength(one)} chars`);
    check('youtube: no deck-code link is attempted (they are 221+ chars)', !one.includes('deckbuilder?code='), one);
    // a long pairing must give way to the doc link, never the other way round
    const longNames = { ...ONAIR, 'player-name-left': 'A'.repeat(40), 'player-name-right': 'B'.repeat(40) };
    const squeezed = youtubeDecklistsMessage(ytAir({ data: { 1: { match1: longNames } } }), '@someoneWithALongName', DOC);
    check('youtube: a long pairing is cut, the doc link is kept whole',
        messageLength(squeezed) <= 200 && squeezed.endsWith(DOC) && squeezed.includes('…'), `${messageLength(squeezed)}: ${squeezed}`);
    check('youtube: nothing on air still gets the lists doc rather than silence',
        (youtubeDecklistsMessage({ ...ytAir(), scene: null }, '@v', DOC) || '').includes(DOC));
    check('youtube: no doc configured and nothing on air -> stay quiet',
        youtubeDecklistsMessage({ ...ytAir(), scene: null }, '@v', '') === null);

    // the sender: refuses rather than spending 50 units on a doomed message
    q._reset();
    const calls = [];
    const fakeFetch = async (url, init) => {
        calls.push({ url: String(url), body: init?.body });
        if (String(url).includes('oauth2')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 3600 }) };
        return { ok: true, status: 200, json: async () => ({ id: 'x' }), text: async () => '{}' };
    };
    const live = createYouTubeSender({ clientId: 'c', clientSecret: 's', refreshToken: 'r', liveChatId: () => 'CHAT1', fetchImpl: fakeFetch });
    let sent = await live.say('hello youtube');
    check('youtube sender: posts to the live chat id, as a text message', sent.ok
        && calls.at(-1).url.includes('/liveChat/messages?part=snippet')
        && JSON.parse(calls.at(-1).body).snippet.liveChatId === 'CHAT1'
        && JSON.parse(calls.at(-1).body).snippet.type === 'textMessageEvent', JSON.stringify(sent));
    check('youtube sender: one message costs 50 units on the shared ledger', q.snapshot().sending.units === 50 && q.snapshot().sending.messages === 1, JSON.stringify(q.snapshot().sending));
    const before = calls.length;
    sent = await live.say('x'.repeat(MAX_MESSAGE + 1));
    check('youtube sender: over 200 characters is refused before spending anything',
        sent.ok === false && sent.reason === 'too-long' && calls.length === before && q.snapshot().sending.units === 50, JSON.stringify(sent));
    const offline = createYouTubeSender({ clientId: 'c', clientSecret: 's', refreshToken: 'r', liveChatId: () => null, fetchImpl: fakeFetch });
    sent = await offline.say('nobody is live');
    check('youtube sender: nothing to post to when no broadcast is live', sent.ok === false && sent.reason === 'not-live');
    const unset = createYouTubeSender({ clientId: '', clientSecret: '', refreshToken: '', fetchImpl: fakeFetch });
    check('youtube sender: not configured -> says so, never throws', unset.configured === false && (await unset.say('x')).ok === false);

    // the caps, which are what stop a raid becoming a quota fire
    q._reset();
    for (let i = 0; i < q.SEND_PER_HOUR; i++) q.spend(q.SEND_COST, 'send');
    check('youtube quota: the hourly cap stops further replies', q.canSend().ok === false && q.canSend().reason === 'hourly-cap', JSON.stringify(q.canSend()));
    q._reset();
    q.spend(q.SEND_BUDGET, 'send');
    check('youtube quota: replies cannot eat more than their slice of the day', q.canSend().reason === 'send-budget');
    q._reset();
    q.spend(q.DAILY_BUDGET, 'read');
    check('youtube quota: reading having spent the day also stops replies', q.canSend().reason === 'daily-budget');
    check('youtube quota: reading and sending are counted as one allowance',
        q.snapshot().units.used === q.DAILY_BUDGET && q.snapshot().left.messages === 0, JSON.stringify(q.snapshot().units));
    q._reset();

    // end to end through the bridge: a YouTube viewer asking, and the caps
    const said = [];
    const ytBridge = initChatBridge(app, io, { connect: false, say: async () => {}, describeOnAir: describe,
        youtubeSay: async (t) => { said.push(t); return { ok: true }; },
        youtubeDecklistsMessage: (mention) => `${mention} On stream now — Match 1: Anu vs Blank. All lists here: ${DOC}` });
    const ytViewer = (id) => ({ platform: 'youtube', userId: id, login: id, displayName: id, text: '!decklists' });
    ytBridge.handle(ytViewer('yt-1'));
    ytBridge.handle(ytViewer('yt-2'));
    await settle();
    check('youtube: a viewer there gets an answer', said.length === 1 && said[0].startsWith('@yt-1 On stream now'), JSON.stringify(said));
    check('youtube: the next viewer waits out the longer window', said.length === 1, `${said.length} messages`);
    check('youtube: the window is 15 minutes, not Twitch\'s 1', _internal.DEFAULTS.youtubeDecklistsCooldownMs === 900000);
}

// ── 15. what the review of the YouTube sender found ─────────────────────────
{
    const { youtubeDecklistsMessage } = await import('../../features/chat-bridge.js');
    const { createYouTubeSender, messageLength } = await import('../../features/chat/youtube-send.js');
    const { connectYouTubeChat } = await import('../../features/chat/youtube-live.js');
    const q = await import('../../features/chat/youtube-quota.js');
    const DOC = 'https://docs.google.com/document/d/1417NC3vjNUJbROWBqp0tPlFJY7asy-fdsFAMjlBMmzQ';
    const ytAir = (extra = {}) => ({ ...base, scene: 'Match 1 - Live + Hand Blue', data: { 1: { match1: ONAIR } }, ...extra });

    // REVIEW: an emoji is 1 code point but 2 UTF-16 units — YouTube doesn't say which it counts
    check('REVIEW: the length guard takes the larger of the two counting rules',
        messageLength('👩‍💻👩‍💻') === 'x'.repeat('👩‍💻👩‍💻'.length).length && messageLength('abc') === 3, String(messageLength('👩‍💻👩‍💻')));
    const emojiName = '@' + '🎮'.repeat(30);
    const withEmoji = youtubeDecklistsMessage(ytAir(), emojiName, DOC);
    check('REVIEW: a message is under 200 by BOTH counts, emoji mention included',
        messageLength(withEmoji) <= 200, `${messageLength(withEmoji)} (utf16 ${withEmoji.length}, points ${Array.from(withEmoji).length})`);

    // REVIEW: a viewer's display name reaches a message the bot then reads back
    {
        const said = [], shownNow = [];
        const ioC = { emit: (ev, d) => { if (ev === 'chat-card-shown') shownNow.push(d.name); }, to: () => ({ emit() {} }), sockets: { emit() {} } };
        const br = initChatBridge(app, ioC, { connect: false, say: async () => {}, describeOnAir: describe,
            youtubeSay: async (t) => { said.push(t); return { ok: true }; } });
        br.handle({ platform: 'youtube', userId: 'yt-evil', login: 'yt-evil', displayName: '[[Loose Cannon]]', text: '!decklists' });
        await settle();
        check('REVIEW: a viewer named "[[card]]" cannot put a card on air through the bot\'s own reply',
            said.length === 1 && !said[0].includes('[[') && shownNow.length === 0, JSON.stringify([said[0], shownNow]));
    }

    // REVIEW: a failed send must not spend the next viewer's 15-minute window
    {
        const attempts = [];
        let failNext = true;
        const br = initChatBridge(app, io, { connect: false, say: async () => {}, describeOnAir: describe,
            youtubeSay: async (t) => { attempts.push(t); if (failNext) { failNext = false; return { ok: false, reason: '503' }; } return { ok: true }; },
            youtubeDecklistsMessage: (m) => `${m} On stream now — Match 1.` });
        const ask = (id) => br.handle({ platform: 'youtube', userId: id, login: id, displayName: id, text: '!decklists' });
        ask('a'); await settle();
        ask('b'); await settle();
        check('REVIEW: after a failed reply the next viewer is still answered', attempts.length === 2 && attempts[1].startsWith('@b'), JSON.stringify(attempts));
        ask('c'); await settle();
        check('REVIEW: …but a delivered reply still holds the window', attempts.length === 2, JSON.stringify(attempts));
    }

    // REVIEW: "sending is ON" must not survive a dead refresh token
    {
        const failWarmup = async (url) => String(url).includes('oauth2')
            ? { ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' }
            : { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
        const sender = createYouTubeSender({ clientId: 'c', clientSecret: 's', refreshToken: 'expired', liveChatId: () => 'CHAT', fetchImpl: failWarmup });
        const warm = await sender.warmup();
        check('REVIEW: warmup reports an expired refresh token rather than claiming ready',
            warm.ok === false && /7 days|invalid_grant/.test(warm.reason), JSON.stringify(warm));
        const posted = await sender.say('hello');
        check('REVIEW: …and a send with that token fails without pretending otherwise', posted.ok === false);
    }

    // REVIEW: the kill switch must not fork the poll chain and double the burn
    {
        q._reset();
        let calls = 0;
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url) => {
            calls++;
            if (String(url).includes('/videos')) return { ok: true, json: async () => ({ items: [{ liveStreamingDetails: { activeLiveChatId: 'C' } }] }) };
            return { ok: true, json: async () => ({ items: [], nextPageToken: 'p', pollingIntervalMillis: 0 }) };
        };
        const conn = connectYouTubeChat({ apiKey: 'k', videoId: 'v', pollMs: 1000, onMessage: () => {}, onStatus: () => {} });
        await new Promise(r => setTimeout(r, 60));
        const afterFirst = calls;
        conn.setPaused(true); conn.setPaused(false);   // flipped while a poll may be in flight
        conn.setPaused(true); conn.setPaused(false);
        await new Promise(r => setTimeout(r, 60));
        conn.stop();
        globalThis.fetch = realFetch;
        check('REVIEW: flipping the kill switch does not start a second poll chain',
            calls - afterFirst <= 2, `${calls - afterFirst} extra calls after 4 flips`);
        check('REVIEW: the reader reports its own state for the usage page', typeof conn.state === 'function' && !!conn.state().status, JSON.stringify(conn.state?.()));
        q._reset();
    }

    // REVIEW: an over-long doc URL must not silently turn the answer off
    const hugeDoc = 'https://docs.google.com/document/d/' + 'x'.repeat(180);
    const fallback = youtubeDecklistsMessage(ytAir(), '@v', hugeDoc);
    check('REVIEW: a doc link too long to fit leaves the match line, not silence',
        !!fallback && messageLength(fallback) <= 200 && /Match 1/.test(fallback), `${fallback}`);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
