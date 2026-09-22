// Chat-triggered card viewer.
//
//   viewer:  !card kennen
//   bot:     @viewer did you mean: 1) Kennen, Heart of the Tempest
//            2) Kennen, Storm of Shuriken  3) Kennen, Keeper of Balance
//   viewer:  2            -> Storm of Shuriken goes on air
//   (or 5s passes)        -> option 1 goes on air, so the stream never waits
//
// Policy is auto-show for everyone, rate-limited by ONE global cooldown. That
// is the knob that actually stops a raid: per-user limits are useless when 200
// throwaway accounts each send a single request.
//
// Cards go to slot 3 (/display/card/view/3), which has its own OBS browser
// source the operator can hide instantly. Note that slot 3 ALSO lands on the
// main scoreboard's right-hand viewer: scoreboard.js:1868 routes by
// `card-id === '1' ? left : right`, so anything that is not 1 renders right —
// it is not a 1/2 whitelist. That is why the operator-yield guard below keys
// on the SIDE rather than the card id.
//
// Reading uses anonymous IRC (features/chat/twitch-irc.js). Sending prompts is
// injected as `say` so this module stays testable and works read-only when no
// Twitch credentials are configured.
//
//   viewer:  !decklists
//   bot:     @viewer On stream now — Match 1: justmilkey (Jayce) vs Blank (LeBlanc). Decklists below:
//   bot:     justmilkey (Jayce): https://piltoverarchive.com/deckbuilder?code=…
//   bot:     Blank (LeBlanc): https://piltoverarchive.com/deckbuilder?code=…
//   bot:     All lists here: https://docs.google.com/document/d/…
//
// A chat reply only — it never touches anything on air. It answers for the
// match OBS has on program, reading the same data that match's header is
// showing, and only once that header has been sent this server's data since
// boot. Anything it can't vouch for, it says nothing about.
//
//   admin:   !p1 https://piltoverarchive.com/decks/view/<id>
//   bot:     @admin Player 1 (Match 1) now has Kennen, Heart of the Tempest — 40 cards, 10 in the sideboard.
//
// Admins only (DEFAULTS.admins, Twitch): loads a Piltover deck onto that
// player in the match on program, as master control's Add Decklist would.

import { emitCardView } from './cards.js';
import { getGameSelection, getPlayerCount } from '../config/constants.js';
import { getControlsTracker, getControlData, getBroadcastTracker, isScoreboardInSync } from './control.js';
import { getCurrentProgramScene } from './obs-websocket.js';
import { findRiftboundCard } from './riftbound/cards.js';
import { verifiedDeckCode, PILTOVER_BUILDER } from './riftbound/deck-code.js';
import { loadPiltoverDeckIntoControl } from './riftbound/load-piltover-deck.js';
import { connectTwitchChat } from './chat/twitch-irc.js';
import { connectYouTubeChat } from './chat/youtube-live.js';
import { resolveCardName } from './chat/resolve.js';
import { createPendingStore } from './chat/pending.js';
import { createTwitchSender } from './chat/twitch-send.js';
import { claimSlot, releaseSlot, slotOwner } from './card-slot-owner.js';

const CARD_SLOT = '3';
const DEFAULTS = {
    // Deliberately equal: the card comes down exactly when the next one is
    // allowed up, so the viewer is never sitting on the card back waiting out a
    // cooldown nobody can see. At 18s/8s there was a 10s dead gap after every
    // card. Keep these in step if you change either.
    cooldownMs: 10000,      // global gap between on-air cards
    dwellMs: 10000,         // how long a chat card stays up
    promptWindowMs: 5000,   // wait for a disambiguation reply
    maxPerStream: 200,      // hard ceiling for one session
    announceCooldown: true, // reply once per cooldown window, not per request
    maxHoldMs: 30000,       // drop a queued request older than this
    // !decklists answers everyone at once, so one reply per window is plenty —
    // the matchup changes between games, not between chat messages. Requests
    // inside the window are dropped silently: a raid gets one answer, not 200.
    // A reply is four messages, so this also caps the bot at 4 a minute.
    decklistsCooldownMs: 60000,
    // Twitch logins that skip every cooldown and can use !p1 / !p2. Matched on
    // the login Twitch itself puts on each message, which can't be spoofed —
    // and only on Twitch: YouTube names are free text. Override with
    // CHAT_ADMINS in .env (comma-separated).
    admins: ['anzidmtg', 'notveryrichard'],
    // Every !decklists reply ends with this: the operator's "stream decklists"
    // Google Doc, public to anyone with the link. It is also what a viewer gets
    // when the bot can't confirm what is on air, rather than silence. Override
    // with DECKLISTS_DOC_URL in .env; set it empty to leave the line out.
    listsUrl: 'https://docs.google.com/document/d/1417NC3vjNUJbROWBqp0tPlFJY7asy-fdsFAMjlBMmzQ',
};

// What each match's on-air header renders, per the scene collection on the box
// (checked 2026-09-20). This table is the whole contract — if the OBS wiring
// changes, change it here:
//   "Match 1 …" scenes -> /scoreboard/match1                 = Control 1
//   "Match 2 …" scenes -> /broadcast/round/scoreboard/match2 = the Broadcast round's match2
// Note Match 2 is NOT Control 2: nothing Control-2-driven is enabled on air.
const ON_AIR = [
    { label: 'Match 1', scene: /\bmatch\s*1\b/i, from: 'control', control: '1' },
    { label: 'Match 2', scene: /\bmatch\s*2\b/i, from: 'broadcast', match: 'match2' },
];
// Twitch rejects messages over 500 characters; leave room for the @mention.
const MAX_REPLY = 450;

const log = (m) => console.log(`[chat-bridge] ${m}`);

// "!card kennen" | "!c kennen" | "[[kennen]]"
function parseCommand(text) {
    const s = String(text ?? '').trim();
    const bang = s.match(/^!(?:card|c)\s+(.{2,80})$/i);
    if (bang) return bang[1].trim();
    const brackets = s.match(/\[\[\s*(.{2,80}?)\s*\]\]/);
    if (brackets) return brackets[1].trim();
    return null;
}

// "!p1 <link>" | "!p2 <link>" -> { player, side, link }. Admin-only (see
// handleInner): loads a Piltover deck onto that player's slot in the match on
// program (see deckTarget). P1 is the left player, as master control labels it.
function parsePlayerDeckCommand(text) {
    const m = String(text ?? '').trim().match(/^!p([12])(?:\s+([\s\S]*))?$/i);
    if (!m) return null;
    return { player: Number(m[1]), side: m[1] === '1' ? 'left' : 'right', link: (m[2] || '').trim() };
}

// "!decklists" | "!decklist" | "!decks" — the bare command only. Anything after
// it means the line is something else ("!decks [[kennen]]" is a card request),
// so it falls through to parseCommand untouched.
function isDecklistsCommand(text) {
    return /^!(?:decklists?|decks)$/i.test(String(text ?? '').trim());
}

// Scoreboard names are edited in a contenteditable field, so they arrive as
// HTML — "Asc Samdsherman&nbsp;" is real data from the box. Chat is plain text
// and one line shared by every name, so beyond decoding entities and dropping
// markup, remove anything that reaches past its own name: control and
// bidi/format characters (an RLO reverses the rest of the line) and square
// brackets (the card command's syntax — the bot hears its own lines).
const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function codePoint(n) {
    return Number.isInteger(n) && n > 0 && n <= 0x10FFFF && !(n >= 0xD800 && n <= 0xDFFF)
        ? String.fromCodePoint(n) : ' ';
}
function plainText(v) {
    return String(v ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
            const k = e.toLowerCase();
            if (k.startsWith('#x')) return codePoint(parseInt(k.slice(2), 16));
            if (k.startsWith('#')) return codePoint(parseInt(k.slice(1), 10));
            return ENTITIES[k] ?? m;
        })
        .replace(/\p{Cc}/gu, ' ')
        .replace(/[\p{Cf}\p{Cs}[\]]/gu, '')
        .replace(/\s+/g, ' ')
        .trim()
        // By code point, so a long name can't be cut through an emoji.
        .replace(/^(.{40})[\s\S]+$/u, '$1')
        .trim();
}

// "Rengar, Pridestalker" -> "Rengar": the champion is how chat talks about a
// deck, and the full title doubles the length of every reply.
function shortLegend(legend) {
    return plainText(String(legend ?? '').split(',')[0]);
}

// One match, never saying more than its header shows. Decks only where the
// page renders one — Riftbound legends and MTG archetypes, 1v1. In 2v2 the
// partner decks are hidden (MTG 2v2 hides the whole row); FFA seats are drawn
// four-up; other games show leader/base rather than an archetype. All of
// those get names only. The "-2" slots are read only in 2v2/FFA: in 1v1 they
// hold whatever was typed the last time the show ran 2v2.
function describeMatch(d, game, playerCount) {
    const name = (slot) => plainText(d[`player-name-${slot}`]);
    if (playerCount === 'ffa') {
        const seats = ['left', 'left-2', 'right', 'right-2'].map(name).filter(Boolean);
        return seats.length >= 2 ? seats.join(', ') : null;
    }
    if (playerCount === '2v2') {
        const team = (a, b) => [name(a), name(b)].filter(Boolean).join(' & ');
        const l = team('left', 'left-2'), r = team('right', 'right-2');
        return l && r ? `${l} vs ${r}` : null;
    }
    const decks = playerCount === '1v1' && (game === 'riftbound' || game === 'mtg');
    const player = (slot) => {
        const n = name(slot);
        if (!n || !decks) return n;
        const deck = game === 'riftbound'
            ? shortLegend(d[`player-legend-${slot}`])
            : plainText(d[`player-archetype-${slot}`]);
        return deck ? `${n} (${deck})` : n;
    };
    // Somebody has to be named on BOTH sides — half a pairing is setup in
    // progress, not something to announce.
    const l = player('left'), r = player('right');
    return l && r ? `${l} vs ${r}` : null;
}

// ── Deck links ──────────────────────────────────────────────────────────────
// Each player's link comes from the first source below that can produce one.
// Today there is one: Piltover Archive's deck builder, opened with a deck code
// built from the list ON THE BOARD — so the link is always the exact deck the
// scoreboard is showing, it can't go stale when a deck is swapped, and it needs
// nothing created anywhere. A future source (a Carde.io or Riftdecks page, say)
// is one more function in this list, tried in order.
//
// The board's runes are colour letters plus counts; this is the inverse of
// RUNE_NAME_TO_LETTER in public/js/shared/deck-parse.js, which writes them.
const RUNE_LETTER_TO_NAME = { r: 'Fury', g: 'Calm', b: 'Mind', o: 'Body', p: 'Chaos', y: 'Order' };

// The board's deck for one slot as { main, side, champion } card codes, or null
// if any part is missing or any card can't be identified exactly.
function boardDeck(d, slot) {
    const lines = (v) => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map(s => String(s).trim()).filter(Boolean);
    const legend = String(d[`player-legend-${slot}`] || '').trim();
    const champion = String(d[`player-champion-${slot}`] || '').trim();
    const mainLines = lines(d[`player-main-deck-${slot}`]);
    if (!legend || !champion || !mainLines.length) return null;

    const code = (name) => findRiftboundCard(name)?.card?.publicCode || null;
    const main = new Map(), side = new Map();
    const add = (into, qty, name) => {
        const c = code(name), n = Number(qty);
        if (!c || !Number.isInteger(n) || n < 1) return false;
        into.set(c, (into.get(c) || 0) + n);
        return true;
    };
    const parsed = (line) => line.match(/^(\d+)\s+(.+)$/);
    if (!add(main, 1, legend) || !add(main, 1, champion)) return null;
    for (const line of mainLines) { const m = parsed(line); if (!m || !add(main, m[1], m[2])) return null; }
    for (const i of [1, 2, 3]) {
        const bf = String(d[`player-battlefield-${i}-${slot}`] || '').trim();
        if (bf && !add(main, 1, bf)) return null;
    }
    for (const i of [1, 2]) {
        const letter = d[`player-rune-color-${i}-${slot}`], qty = d[`player-rune-qty-${i}-${slot}`];
        if (!letter && !qty) continue;
        if (!RUNE_LETTER_TO_NAME[letter] || !add(main, qty, `${RUNE_LETTER_TO_NAME[letter]} Rune`)) return null;
    }
    for (const line of lines(d[`player-side-deck-${slot}`])) { const m = parsed(line); if (!m || !add(side, m[1], m[2])) return null; }
    return { main: [...main], side: [...side], champion: code(champion) };
}

function piltoverBuilderLink(d, slot) {
    const deck = boardDeck(d, slot);
    const code = deck && verifiedDeckCode(deck);
    return code ? `${PILTOVER_BUILDER}${code}` : null;
}

const DECK_LINK_SOURCES = [piltoverBuilderLink];

function deckLink(d, slot) {
    for (const source of DECK_LINK_SOURCES) {
        try { const url = source(d, slot); if (url) return url; }
        catch (e) { log(`deck link source failed (skipped): ${e && e.message}`); }
    }
    return null;
}

// Everything !decklists needs about what is on air, or null when that can't be
// known: the OBS link is down, or the on-air header hasn't been sent this
// server's data since boot (after a restart it goes on showing the old show).
// null = stay quiet rather than guess. `decks` lists one entry per player for
// matches that get links (Riftbound 1v1), with url:null when there is none.
export function readOnAir({
    scene = getCurrentProgramScene(),
    tracker = getControlsTracker(), broadcast = getBroadcastTracker(),
    data = getControlData(), inSync = isScoreboardInSync,
    game = getGameSelection(), playerCount = getPlayerCount(),
} = {}) {
    if (!scene) return null;
    const live = ON_AIR.filter(m => m.scene.test(scene));
    if (!live.length) return { text: 'no match is on air right now.', decks: [] };
    const lines = [], decks = [], said = new Set();
    for (const m of live) {
        let d;
        if (m.from === 'control') {
            if (!inSync(m.control)) return null;
            const { round_id, match_id } = tracker?.[m.control] || {};
            d = data?.[round_id]?.[match_id];
        } else {
            const round_id = broadcast?.round_id;
            if (round_id == null) return null;       // nothing broadcast since boot
            d = data?.[round_id]?.[m.match];
        }
        const text = d && describeMatch(d, game, playerCount);
        if (!text || said.has(text)) continue;
        said.add(text);
        lines.push(`${m.label}: ${text}`);
        // Links only where the match line names each player with their deck —
        // the same rule as describeMatch, so a link never outruns the screen.
        if (game === 'riftbound' && playerCount === '1v1') {
            for (const slot of ['left', 'right']) {
                const who = `${plainText(d[`player-name-${slot}`])} (${shortLegend(d[`player-legend-${slot}`]) || '?'})`;
                decks.push({ who, url: deckLink(d, slot) });
            }
        }
    }
    return lines.length ? { text: lines.join(' | '), decks, live: true } : { text: "the players aren't on the scoreboard yet.", decks: [] };
}

// Where !p1 / !p2 load a deck: the match OBS has on program, by the same table
// as !decklists.
//   Match 1 on program -> Control 1's match (its header follows it live)
//   Match 2 on program -> match2 of the Broadcast round; its header only
//                         changes when Broadcast is pressed, so the reply says to
//   anything else      -> Match 1, and the reply says why
// Returns { round_id, match_id, label, broadcast, note } or { refuse }.
export function deckTarget({
    scene = getCurrentProgramScene(),
    tracker = getControlsTracker(), broadcast = getBroadcastTracker(),
} = {}) {
    const live = scene ? ON_AIR.filter(m => m.scene.test(scene)) : [];
    if (live.length > 1) return { refuse: "both matches are on program, so I can't tell which one you mean." };
    const m = live[0] || ON_AIR.find(o => o.label === 'Match 1');
    const note = live.length ? null
        : scene ? 'No match is on program, so it went to Match 1.'
        : "I can't see OBS right now, so it went to Match 1.";
    if (m.from === 'control') {
        const { round_id, match_id } = tracker?.[m.control] || {};
        return { round_id, match_id, label: m.label, broadcast: false, note };
    }
    const round_id = broadcast?.round_id;
    if (round_id == null) return { refuse: `${m.label} is on program, but nothing has been broadcast since the server started — press Broadcast, then try again.` };
    return { round_id: String(round_id), match_id: m.match, label: m.label, broadcast: true, note };
}

// The match line on its own (the first message of a reply), or null.
export function describeOnAir(opts) {
    const r = readOnAir(opts);
    return r ? r.text : null;
}

// The on-air part of the reply, one string per chat message, or null to stay
// quiet:
//   @viewer On stream now — Match 1: Anu (Rengar) vs Blank (LeBlanc). Decklists below:
//   Anu (Rengar): https://piltoverarchive.com/deckbuilder?code=…
//   Blank (LeBlanc): no link available
// Separate messages because two deck links don't fit in one (a code link is
// ~220 characters; Twitch's limit is 500). The bridge adds the "all lists"
// line after these.
export function decklistMessages(opts, mention) {
    const r = readOnAir(opts);
    if (!r) return null;
    // "Match 1:" alone reads like a label; say it is what is on stream.
    const head = r.live ? `${mention} On stream now — ${r.text}` : `${mention} ${r.text}`;
    if (!r.decks.length) return [head];
    return [`${head}. Decklists below:`, ...r.decks.map(p => `${p.who}: ${p.url || 'no link available'}`)];
}

export function initChatBridge(app, io, opts = {}) {
    const flag = (process.env.CHAT_BRIDGE_ENABLED || '').trim().toLowerCase();
    if (!['1', 'true', 'on', 'yes'].includes(flag)) {
        log('disabled (set CHAT_BRIDGE_ENABLED=true to turn on)');
        return { enabled: false };
    }
    const channel = (process.env.TWITCH_CHANNEL || '').trim();
    if (!channel) { log('TWITCH_CHANNEL not set — not starting'); return { enabled: false }; }

    // .env is read here, at start-up, like the rest of the bridge's settings.
    const envLists = process.env.DECKLISTS_DOC_URL;
    const envAdmins = process.env.CHAT_ADMINS;
    const cfg = {
        ...DEFAULTS,
        ...(envLists !== undefined ? { listsUrl: envLists.trim() } : {}),
        ...(envAdmins !== undefined ? { admins: envAdmins.split(',') } : {}),
        ...opts,
    };
    const admins = new Set((cfg.admins || []).map(a => String(a).trim().toLowerCase()).filter(Boolean));
    const isAdmin = (msg) => msg.platform === 'twitch' && admins.has(String(msg.login || '').toLowerCase());
    // Sending is optional: with no Twitch app credentials the bridge still
    // reads chat and shows cards, it just can't post disambiguation prompts
    // (ambiguous names then fall through to the timeout auto-pick).
    const sender = opts.say ? null : createTwitchSender();
    const say = opts.say || (sender ? sender.say : async () => {});
    // Can we actually put a numbered menu in front of THIS viewer? Only on a
    // platform we can post to. YouTube is read-only by design (sending costs
    // ~50 quota units a message and needs OAuth), so a YouTube viewer must
    // never be made to wait on a prompt they cannot see — and their menu must
    // not be dumped into Twitch chat, where it is noise addressed to someone
    // who is not there.
    const canSend = !!opts.say || !!(sender && sender.configured);
    const canPromptOn = (platform) => platform === 'twitch' && canSend;
    if (sender) {
        if (sender.configured) sender.warmup().then(r => log(r.ok ? 'chat sending ready' : `chat sending unavailable: ${r.reason}`));
        else log('chat sending not configured — prompts disabled, timeout auto-pick still works');
    }
    let lastShownAt = 0, shownThisStream = 0, live = true;
    let lastCooldownNoticeAt = 0;
    let lastDecklistsAt = 0;
    let lastDecklistsSend = null;   // { at, messages, sent, ok, reason } — on the status page
    // Tests inject the whole reply (decklistMessages) or just the match line
    // (describeOnAir); production reads what is on air.
    const onAirMessages = opts.decklistMessages
        || (opts.describeOnAir
            ? (mention) => { const t = opts.describeOnAir(); return t ? [`${mention} ${t}`] : null; }
            : (mention) => decklistMessages(undefined, mention));
    // The on-air messages, then the "all lists" line. When what is on air can't
    // be confirmed, the lists line alone — it's never wrong, and it beats silence.
    const messagesFor = (mention) => {
        const base = onAirMessages(mention);
        const lists = cfg.listsUrl ? `All lists here: ${cfg.listsUrl}` : null;
        if (!base || !base.length) return lists ? [`${mention} ${lists}`] : null;
        return lists ? [...base, lists] : base;
    };
    const botLogin = String(opts.botLogin ?? process.env.TWITCH_BOT_LOGIN ?? '').trim().toLowerCase();

    // One chat message, cut by code point (a UTF-16 slice can split an emoji
    // and send a lone surrogate) — and never through a link: a line whose link
    // won't fit says "no link available" instead of carrying half a URL.
    function fitMessage(m) {
        if (Array.from(m).length <= MAX_REPLY) return m;
        const url = m.match(/https?:\/\/\S+$/);
        if (url) return fitMessage(`${m.slice(0, url.index)}no link available`);
        return `${Array.from(m).slice(0, MAX_REPLY - 1).join('')}…`;
    }

    const loadDeck = opts.loadPlayerDeck || ((args) => loadPiltoverDeckIntoControl({ ...args, io }));
    const resolveDeckTarget = opts.deckTarget || (() => deckTarget());

    // !p1 / !p2 from an admin: load a Piltover deck onto the left / right
    // player of the match on program (deckTarget). Every outcome gets a reply,
    // so the admin knows whether it landed — unless the kill switch was hit
    // meanwhile: then nothing is written and nothing is said.
    function loadPlayerDeck(msg, cmd) {
        const who = `@${msg.displayName}`;
        const tell = (text) => (live ? say(`${who} ${text}`).catch(() => {}) : Promise.resolve());
        const cmdName = `!p${cmd.player}`;
        if (getGameSelection() !== 'riftbound') { tell(`${cmdName} only works for Riftbound.`); return; }
        if (!cmd.link) { tell(`usage: ${cmdName} <Piltover Archive deck link>`); return; }
        const target = resolveDeckTarget();
        if (target.refuse) { log(`admin ${msg.login}: ${cmdName} refused — ${target.refuse}`); tell(target.refuse); return; }
        const where = target.broadcast ? `${target.label}, round ${target.round_id}` : target.label;
        (async () => {
            const r = await loadDeck({ round_id: target.round_id, match_id: target.match_id, side: cmd.side, link: cmd.link, shouldCommit: () => live });
            if (r.ok) {
                const sb = r.sideboard ? `, ${r.sideboard} in the sideboard` : '';
                log(`admin ${msg.login}: P${cmd.player} deck -> ${r.legend} (round ${r.round_id}, ${r.match_id})`);
                await tell(`Player ${cmd.player} (${where}) now has ${plainText(r.legend)} — ${r.cards} cards${sb}.${target.note ? ` ${target.note}` : ''}`);
                // Match 2's header shows the Broadcast round as it was when
                // Broadcast was last pressed.
                if (target.broadcast) await tell(`press Broadcast to put it on the ${target.label} header.`);
                return;
            }
            log(`admin ${msg.login}: P${cmd.player} deck not loaded (${r.reason}${r.status ? ` ${r.status}` : ''}${r.detail ? `: ${r.detail}` : ''})`);
            const why = {
                'not-piltover': "that isn't a Piltover Archive deck link. Use one like https://piltoverarchive.com/decks/view/<id>",
                'not-found': "Piltover couldn't find that deck — is it public, and not a draft?",
                'bad-link': "Piltover says that isn't a valid deck — check the link is complete.",
                'not-configured': "the server's Piltover API key is missing or was rejected (PILTOVER_API_KEY in .env), so decks can't be loaded.",
                'fetch-failed': `couldn't get that deck from Piltover${r.status ? ` (${r.status})` : ''} — try again.`,
                'not-a-deck': 'that Piltover deck has no legend or main deck.',
                'no-match': `${where} isn't set up in master control.`,
                'superseded': `not loaded — a newer ${cmdName} for that player replaced it.`,
            }[r.reason];
            if (r.reason === 'paused') return;
            tell(why || 'that deck could not be loaded.');
        })().catch((e) => { log(`admin deck load failed: ${e && e.message}`); tell('that deck could not be loaded.'); });
    }

    function answerDecklists(msg) {
        // Nothing to do where we can't post (YouTube is read-only), and brand
        // new accounts are ignored exactly as they are for !card.
        if (!canPromptOn(msg.platform) || msg.firstMsg) return;
        if (!isAdmin(msg) && Date.now() - lastDecklistsAt < cfg.decklistsCooldownMs) return;
        // Read BEFORE spending the window, so a read that throws leaves the
        // next viewer free to ask. "Can't tell" still spends it: during a raid
        // that is one quiet check per window, not one per message.
        const messages = messagesFor(`@${msg.displayName}`);
        lastDecklistsAt = Date.now();
        if (!messages || !messages.length) {
            log("decklists: staying quiet — can't confirm what is on air (OBS link down, or nothing sent to that scoreboard since the server started), and no lists doc is set");
            return;
        }
        const out = messages.map(fitMessage);
        log(`decklists for ${msg.displayName}: ${out.length} message(s) — ${out[0]}`);
        // In order and one at a time (the sender spaces them ~1s apart),
        // stopping at the first one Twitch refuses so a player's line never
        // arrives without the match line above it. The outcome goes on the
        // status page: a refused reply used to vanish without a trace.
        (async () => {
            let sent = 0, reason = null;
            for (const m of out) {
                const r = await say(m);
                if (r && r.ok === false) { reason = r.reason || 'refused'; break; }
                sent++;
            }
            lastDecklistsSend = { at: new Date().toISOString(), messages: out.length, sent, ok: sent === out.length, reason };
            if (reason) log(`decklists: Twitch did not deliver message ${sent + 1} of ${out.length} (${reason})`);
        })().catch((e) => {
            lastDecklistsSend = { at: new Date().toISOString(), messages: out.length, sent: 0, ok: false, reason: (e && e.message) || 'error' };
        });
    }

    // ── Cross-platform fairness ──────────────────────────────────────────────
    // The cooldown is global, so whoever lands first takes the slot and locks
    // everyone else out for a full window. Twitch arrives instantly while
    // YouTube arrives on a poll, so on a busy Twitch chat YouTube would lose
    // essentially every race — not on latency, on volume — and the loss is
    // invisible there because we cannot post to YouTube.
    //
    // So a request that arrives during a cooldown is PARKED instead of dropped,
    // one slot per platform (most recent wins), and when the window expires the
    // platform that was NOT served last goes first. Twitch still gets every
    // slot nobody else is waiting for.
    const waiting = new Map();      // platform -> { card, who, at }
    let lastServedPlatform = null;
    let drainTimer = null;

    const clearSlot = () => {
        try {
            emitCardView(io, { 'game-id': getGameSelection(), 'card-selected': '', 'card-id': CARD_SLOT });
        } catch (e) { log(`clear failed: ${e && e.message}`); }
    };

    let dwellTimer = null;
    // "Chat yields": the operator owns the viewer. On the anu scoreboard the
    // left overlay is hidden, so the operator's card-id 2 and our card-id 3
    // land on the SAME right-hand viewer — without this guard a viewer could
    // stomp a card the operator just put up.
    function operatorHasSlot() { return slotOwner(CARD_SLOT) === 'operator'; }

    function show(card, who, platform = null) {
        // Only ever pass a canonical key that came out of our own card map —
        // raw chat text must never reach emitCardView. variant-url is left
        // unset on purpose: features/cards.js feeds it straight to img.src.
        try {
            emitCardView(io, {
                'game-id': getGameSelection(), 'card-selected': card.name, 'card-id': CARD_SLOT,
            });
        } catch (e) {
            log(`emit failed (card not shown): ${e && e.message}`);
            return;
        }
        claimSlot(CARD_SLOT, 'chat');
        lastShownAt = Date.now();
        if (platform) lastServedPlatform = platform;
        shownThisStream++;
        scheduleDrain();                 // anyone parked gets the next window
        log(`showing "${card.name}" (${who})`);
        io.emit('chat-card-shown', { name: card.name, requestedBy: who, at: lastShownAt });
        clearTimeout(dwellTimer);
        dwellTimer = setTimeout(() => {
            // Dwell and cooldown are equal, so this fires at the same instant a
            // parked request becomes eligible. Hand straight over rather than
            // clearing first — otherwise the viewer blinks back to the card back
            // for the few ms between the two timers, and with a 400ms crossfade
            // that reads as a visible stutter between cards.
            if (waiting.size && Date.now() - lastShownAt >= cfg.cooldownMs && drain()) return;
            // Only clear if the card up there is still OURS — the operator may
            // have taken the slot back in the meantime.
            if (releaseSlot(CARD_SLOT, 'chat')) clearSlot();
        }, cfg.dwellMs);
        dwellTimer.unref?.();
    }

    function scheduleDrain() {
        if (drainTimer || !waiting.size) return;
        const wait = Math.max(0, cfg.cooldownMs - (Date.now() - lastShownAt));
        drainTimer = setTimeout(() => { drainTimer = null; drain(); }, wait + 25);
        drainTimer.unref?.();
    }

    // Returns true when it actually put a card on air.
    function drain() {
        if (!live || !waiting.size) return false;
        if (Date.now() - lastShownAt < cfg.cooldownMs) { scheduleDrain(); return false; }
        // The operator owns the viewer — parked chat requests are stale by the
        // time they would land, and chat yields to the operator either way.
        if (operatorHasSlot()) { waiting.clear(); return false; }
        for (const [p, e] of [...waiting]) {
            if (Date.now() - e.at > cfg.maxHoldMs) waiting.delete(p);
        }
        if (!waiting.size) return false;
        const platforms = [...waiting.keys()];
        const pick = platforms.find(p => p !== lastServedPlatform) ?? platforms[0];
        const entry = waiting.get(pick);
        waiting.delete(pick);
        log(`serving parked ${pick} request "${entry.card.name}"`);
        show(entry.card, entry.who, pick);
        return true;
    }

    const pending = createPendingStore({
        windowMs: cfg.promptWindowMs,
        onResolve: (card, meta) => {
            if (!card) return;
            if (operatorHasSlot()) return;   // operator took the slot while we waited
            // An UNANSWERED prompt must not fire into a screen that has moved on.
            // Without this, a viewer who opened a prompt and then asked for
            // something else got the abandoned pick slapped over the card they
            // actually wanted five seconds later. An explicit numeric reply is
            // still honoured — that is a current request, not a stale one.
            if (meta.reason === 'timeout' && lastShownAt > (meta.requestedAt || 0)) {
                log(`dropping stale auto-pick "${card.name}" — screen moved on`);
                return;
            }
            if (card.contentWarning) { log(`blocked (content warning): ${card.name}`); return; }
            // The pending store keys by "<platform>:<userId>", which is the only
            // place the platform survives a parked prompt.
            show(card, meta.displayName, String(meta.userId || '').split(':')[0] || null);
        },
    });

    function handle(msg) {
        // NEVER throw back into the transport. This runs inside the IRC socket's
        // message loop; an exception here would abort the rest of that frame and
        // can surface as an uncaughtException that kills the whole server —
        // taking the scoreboard down with it. A chat command failing must cost
        // one message, not the broadcast.
        try { handleInner(msg); }
        catch (e) { log(`handler error (ignored): ${e && e.message}`); }
    }

    function handleInner(msg) {
        if (!live) return;
        if (!msg || typeof msg !== 'object') return;
        if (typeof msg.text !== 'string' || !msg.userId) return;
        // Chat clients make a repeated message unique so Twitch will accept it
        // again: 7TV and Chatterino add " \u{E0000}", others U+034F. Invisible
        // and never part of a command — without this, re-sending "!p1 <link>"
        // after an error is read as a broken link, and a second "!decklists"
        // as no command at all.
        msg = { ...msg, text: msg.text.replace(/[\p{Cf}͏\u{E0000}-\u{E007F}]/gu, '').trim() };
        // The IRC reader is anonymous, so it hears the bot's own messages too.
        // Those are never requests — and a !decklists reply carries scoreboard
        // text, which must not be able to put a card on air.
        if (botLogin && String(msg.login || '').toLowerCase() === botLogin) return;
        // A bare number resolves this user's own open prompt, and is never
        // treated as a card name.
        // Key by platform+id: a Twitch id and a YouTube id could otherwise
        // collide and let one viewer resolve another's prompt.
        const key = `${msg.platform}:${msg.userId}`;
        if (pending.tryPick(key, msg.text)) return;

        // Admin deck loading. Anyone else's "!p1 …" is just a chat line — no
        // reply advertising a command they can't use, and a [[card]] in it
        // still works.
        const deckCmd = isAdmin(msg) && parsePlayerDeckCommand(msg.text);
        if (deckCmd) { if (canPromptOn(msg.platform)) loadPlayerDeck(msg, deckCmd); return; }

        // Checked before the card command, and deliberately leaves this
        // viewer's open card prompt alone — asking who's playing is not a new
        // card request.
        if (isDecklistsCommand(msg.text)) { answerDecklists(msg); return; }

        const query = parseCommand(msg.text);
        if (!query) return;
        // A new command from this viewer supersedes any prompt they left open,
        // whatever happens to the new request below.
        pending.clear(key);
        if (msg.firstMsg) return;                               // drop brand-new accounts silently
        if (shownThisStream >= cfg.maxPerStream) return;

        if (operatorHasSlot()) return;      // operator's card is up — chat yields, silently

        // Resolve BEFORE the cooldown check so a request that has to wait can be
        // parked as a real card rather than as raw text to re-parse later.
        const game = getGameSelection();
        const hit = resolveCardName(game, query);
        if (!hit) return;                                       // unknown name -> no-op, no reply
        if (hit.contentWarning) { log(`blocked (content warning): ${hit.name}`); return; }

        const since = Date.now() - lastShownAt;
        if (since < cfg.cooldownMs && !isAdmin(msg)) {
            // Park it for the next window instead of dropping it. One slot per
            // platform: the most recent request from a platform replaces that
            // platform's parked one, so a busy chat cannot build a backlog.
            // Ambiguous names park as the top-ranked printing — a prompt whose
            // answer could not be shown for another 18s is worse than no prompt.
            waiting.set(msg.platform, { card: hit, who: msg.displayName, at: Date.now() });
            scheduleDrain();
            // Tell chat once per cooldown window, not once per request — 30
            // people typing during an 18s cooldown must not become 30 bot
            // messages. Everyone after the first is parked silently.
            if (cfg.announceCooldown && canPromptOn(msg.platform) && lastCooldownNoticeAt <= lastShownAt) {
                lastCooldownNoticeAt = Date.now();
                const wait = Math.ceil((cfg.cooldownMs - since) / 1000);
                say(`@${msg.displayName} card viewer is busy — yours is queued (${wait}s)`).catch(() => {});
            }
            return;
        }

        if (hit.ambiguous && Array.isArray(hit.alternatives) && hit.alternatives.length > 1) {
            const opts = hit.alternatives
                .map(n => resolveCardName(game, n))
                .filter(c => c && !c.contentWarning);
            if (opts.length > 1 && canPromptOn(msg.platform)) {
                const listed = pending.open(key, msg.displayName, opts);
                const menu = listed.map((c, i) => `${i + 1}) ${c.name}`).join('  ');
                say(`@${msg.displayName} did you mean: ${menu}`).catch(() => {});
                return;
            }
            // No way to ask: show the top-ranked printing straight away rather
            // than stalling for a reply that was never invited.
            if (opts.length > 1) { show(opts[0], msg.displayName, msg.platform); return; }
        }
        show(hit, msg.displayName, msg.platform);
    }

    // One bridge, many chat sources. Each adapter only has to call handle()
    // with { platform, userId, displayName, text, firstMsg }; resolution,
    // cooldown, disambiguation and the denylist are transport-agnostic.
    // opts.connect === false lets tests drive handle() directly. Production
    // never passes it.
    const sources = [];
    if (opts.connect !== false) {
        sources.push({
            name: 'twitch',
            conn: connectTwitchChat({ channel, onMessage: handle, onStatus: (m) => log(`twitch: ${m}`) }),
        });
        // YouTube is optional and read-only: an API key is all it needs, but
        // sending would cost ~50 quota units a message AND drag in OAuth, so
        // YouTube viewers get the card on screen rather than a chat reply.
        const ytKey = (process.env.YOUTUBE_API_KEY || '').trim();
        const ytVideo = (process.env.YOUTUBE_VIDEO_ID || '').trim();
        const ytChannel = (process.env.YOUTUBE_CHANNEL_ID || '').trim();
        if (ytKey && (ytVideo || ytChannel)) {
            sources.push({
                name: 'youtube',
                conn: connectYouTubeChat({
                    apiKey: ytKey, videoId: ytVideo || undefined, channelId: ytChannel || undefined,
                    pollMs: Number(process.env.YOUTUBE_POLL_MS) || undefined,
                    onMessage: handle, onStatus: (m) => log(`youtube: ${m}`),
                }),
            });
        } else if (ytKey) {
            log('youtube: YOUTUBE_API_KEY set but no YOUTUBE_VIDEO_ID / YOUTUBE_CHANNEL_ID — skipping');
        }
    }

    app.get('/api/chat-bridge/status', (_req, res) => res.json({
        enabled: true, live, channel,
        sources: sources.map(s => ({
            name: s.name,
            connected: s.conn.isConnected(),
            ...(s.conn.quotaUsed ? { quotaUsed: s.conn.quotaUsed() } : {}),
        })),
        connected: sources.some(s => s.conn.isConnected()),
        shownThisStream, cooldownMs: cfg.cooldownMs,
        cooldownRemainingMs: Math.max(0, cfg.cooldownMs - (Date.now() - lastShownAt)),
        slotOwner: slotOwner(CARD_SLOT),
        pendingPrompts: pending.size(),
        queued: [...waiting.entries()].map(([p, e]) => ({ platform: p, card: e.card.name, waitingMs: Date.now() - e.at })),
        lastServedPlatform,
        // What !decklists would send right now, without posting to chat — so it
        // can be checked from here before anyone relies on it. messages:null
        // means it would stay quiet (see readOnAir); lastSend is what Twitch
        // did with the last real reply.
        decklists: (() => {
            try { return { programScene: getCurrentProgramScene(), messages: messagesFor('@viewer'), lastSend: lastDecklistsSend }; }
            catch (e) { return { error: e && e.message, lastSend: lastDecklistsSend }; }
        })(),
    }));

    // Kill switch — flip without restarting the server mid-show.
    app.post('/api/chat-bridge/live/:state', (req, res) => {
        live = req.params.state === 'on';
        log(`kill switch: ${live ? 'LIVE' : 'PAUSED'}`);
        if (!live) { pending.shutdown(); waiting.clear(); clearTimeout(drainTimer); drainTimer = null; clearSlot(); }
        res.json({ live });
    });

    log(`live on #${channel} — cooldown ${cfg.cooldownMs}ms, dwell ${cfg.dwellMs}ms, slot ${CARD_SLOT}`);
    return {
        enabled: true,
        stop() { for (const s of sources) s.conn.stop(); pending.shutdown(); clearTimeout(dwellTimer); clearTimeout(drainTimer); waiting.clear(); },
        addSource(name, conn) { sources.push({ name, conn }); },
        handle,
        _test: { handle, parseCommand, status: () => ({ shownThisStream, lastShownAt }) },
    };
}

export const _internal = { DEFAULTS, parseCommand, isDecklistsCommand, parsePlayerDeckCommand, plainText, shortLegend, describeMatch, ON_AIR, boardDeck, deckLink, deckTarget };
