// Riftbound deck codes — the open format Piltover Archive reads
// (@piltoverarchive/riftbound-deck-codes, Apache-2.0; not Riot's).
//
// A code opens the exact list, with nothing created and no account, at
//   https://piltoverarchive.com/deckbuilder?code=<code>
// which is how the chat bot links a player's deck (features/chat-bridge.js).
//
// Only format version 3 is implemented — plain "SET-123" card codes, at most 12
// copies in the main list and 3 in the sideboard, no variant letters. That is
// the path Piltover verified card-for-card against its own export. Anything
// outside it (a token such as "UNL-T01", a count over the limit, a set this
// table doesn't know) makes encodeDeck() return null: no link beats a link to
// a different list. Every code is decoded again before it is handed out.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// Set order is part of the format; append, never reorder.
const SET_INDEX = { OGN: 0, OGS: 1, ARC: 2, SFD: 3, UNL: 4, VEN: 5, RAD: 6 };
const SET_NAME = Object.fromEntries(Object.entries(SET_INDEX).map(([k, v]) => [v, k]));
const FORMAT = 1, VERSION = 3;
const MAIN_MAX = 12, SIDE_MAX = 3;
const CODE_RE = /^([A-Z]{3})-(\d+)$/;

function varint(n) {
    const out = [];
    do {
        let b = n & 127;
        n = Math.floor(n / 128);
        if (n) b |= 128;
        out.push(b);
    } while (n);
    return out;
}

function toBase32(bytes) {
    let out = '', buf = 0, bits = 0;
    for (const b of bytes) {
        buf = (buf << 8) | b; bits += 8;
        while (bits >= 5) { bits -= 5; out += ALPHABET[(buf >> bits) & 31]; }
        buf &= (1 << bits) - 1;
    }
    if (bits > 0) out += ALPHABET[(buf << (5 - bits)) & 31];
    return out;
}

function fromBase32(text) {
    const out = [];
    let buf = 0, bits = 0;
    for (const ch of text) {
        const v = ALPHABET.indexOf(ch.toUpperCase());
        if (v < 0) throw new Error('not a deck code');
        buf = (buf << 5) | v; bits += 5;
        if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 255); }
        buf &= (1 << bits) - 1;
    }
    return out;
}

// [[code, count]] -> the section's bytes: counts high to low, then per set.
function encodeSection(cards, max) {
    const out = [];
    for (let c = max; c >= 1; c--) {
        const bySet = new Map();
        for (const [code, n] of cards) {
            if (n !== c) continue;
            const [, set, num] = code.match(CODE_RE);
            const k = SET_INDEX[set];
            if (!bySet.has(k)) bySet.set(k, []);
            bySet.get(k).push(Number(num));
        }
        const groups = [...bySet.entries()].sort((a, b) => a[0] - b[0]);
        out.push(...varint(groups.length));
        for (const [set, nums] of groups) {
            nums.sort((a, b) => a - b);
            out.push(...varint(nums.length), set, 0);     // 0 = base printing
            for (const n of nums) out.push(...varint(n));
        }
    }
    return out;
}

const pad3 = (n) => String(n).padStart(3, '0');

/**
 * { main: [[code, count]], side: [[code, count]], champion: code|null } -> code,
 * or null when the deck is outside what this encoder can represent exactly.
 * `main` holds everything outside the sideboard — legend, champion, main list,
 * battlefields, runes — with the champion's slot included in its count.
 */
export function encodeDeck({ main = [], side = [], champion = null } = {}) {
    const ok = (list, max) => list.every(([code, n]) =>
        CODE_RE.test(code) && SET_INDEX[code.split('-')[0]] !== undefined && Number.isInteger(n) && n >= 1 && n <= max);
    if (!main.length || !ok(main, MAIN_MAX) || !ok(side, SIDE_MAX)) return null;
    if (champion && !(CODE_RE.test(champion) && SET_INDEX[champion.split('-')[0]] !== undefined)) return null;

    const bytes = [(FORMAT << 4) | VERSION, ...encodeSection(main, MAIN_MAX), ...encodeSection(side, SIDE_MAX)];
    if (champion) {
        const [, set, num] = champion.match(CODE_RE);
        bytes.push(1, SET_INDEX[set], 0, ...varint(Number(num)));
    } else {
        bytes.push(0);
    }
    return toBase32(bytes);
}

/** code -> { main, side, champion } (version 3 only), or null. */
export function decodeDeck(code) {
    let bytes;
    try { bytes = fromBase32(String(code || '')); } catch { return null; }
    let i = 0;
    const byte = () => { if (i >= bytes.length) throw new Error('short'); return bytes[i++]; };
    const vi = () => {
        let n = 0, mul = 1;
        for (;;) { const b = byte(); n += (b & 127) * mul; if (!(b & 128)) return n; mul *= 128; }
    };
    try {
        const head = byte();
        if (head >> 4 !== FORMAT || (head & 15) !== VERSION) return null;
        const section = (max) => {
            const out = [];
            for (let c = max; c >= 1; c--) {
                for (let g = vi(); g > 0; g--) {
                    const k = vi(), set = byte(), variant = byte();
                    if (variant !== 0 || SET_NAME[set] === undefined) throw new Error('unsupported');
                    for (let j = 0; j < k; j++) out.push([`${SET_NAME[set]}-${pad3(vi())}`, c]);
                }
            }
            return out;
        };
        const main = section(MAIN_MAX), side = section(SIDE_MAX);
        let champion = null;
        if (byte() === 1) {
            const set = byte(), variant = byte();
            if (variant !== 0 || SET_NAME[set] === undefined) return null;
            champion = `${SET_NAME[set]}-${pad3(vi())}`;
        }
        return { main, side, champion };
    } catch {
        return null;
    }
}

export const PILTOVER_BUILDER = 'https://piltoverarchive.com/deckbuilder?code=';

/** The code, but only once it decodes back to exactly this deck. */
export function verifiedDeckCode(deck) {
    const code = encodeDeck(deck);
    if (!code) return null;
    const back = decodeDeck(code);
    const key = (list) => list.map(([c, n]) => `${c}x${n}`).sort().join(',');
    if (!back || key(back.main) !== key(deck.main) || key(back.side) !== key(deck.side || [])
        || back.champion !== (deck.champion || null)) return null;
    return code;
}
