#!/usr/bin/env node
// Run from the repo root:  node scripts/chat/test-decklists.mjs
// Drives the REAL chat bridge with a fake chat + fake Twitch sender.
// Fixtures are the exact control data read off the box on 2026-09-20,
// including the "&nbsp;" name and the stale 2v2 slots. Every defect the
// adversarial review confirmed has a test here ("REVIEW:" prefix).
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

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
