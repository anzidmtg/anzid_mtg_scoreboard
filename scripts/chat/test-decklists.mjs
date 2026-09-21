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
const bridge = initChatBridge(app, io, { connect: false, cooldownMs: 0, dwellMs: 60000, decklistsCooldownMs: 30000,
    say: async (t) => { sent.push(t); }, describeOnAir: describe });

bridge.handle(msg('!decklists'));
check('replies in chat with an @mention', sent[0] === '@viewer1 Match 1: Anu (Rengar) vs Asc Samdsherman (LeBlanc)', sent[0]);
bridge.handle(msg('!decklists', { displayName: 'viewer2' }));
bridge.handle(msg('!decks', { displayName: 'viewer3' }));
check('silent inside the 30s window (a raid gets one answer)', sent.length === 1, `${sent.length} messages`);

const s2 = [];
const fresh = (d = describe) => initChatBridge(app, io, { connect: false, cooldownMs: 0, decklistsCooldownMs: 30000,
    say: async (t) => { s2.push(t); }, describeOnAir: d });
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
check('can\'t confirm what is on air -> posts nothing', s2.length === 0);

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

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
