// Load a Piltover Archive deck onto a player's slot in master control — what
// the chat bot's admin commands "!p1 <link>" / "!p2 <link>" do.
//
// The deck REPLACES the slot's deck. riftboundDeckFields() only emits the
// sections a list contains (right for a partial paste into master control),
// which here would leave the previous player's sideboard, or a third
// battlefield, sitting under the new player's name — and in !decklists' link.
// So every deck field for the side is written, blank where the new list has
// nothing.

import { parseDeckString, riftboundDeckFields } from '../../public/js/shared/deck-parse.js';
import { exportPiltoverDeck, parsePiltoverLink } from './piltover.js';
import { getControlData, updateFieldsFromServer } from '../control.js';

const deckFieldNames = (side) => [
    `player-legend-${side}`, `player-champion-${side}`,
    `player-battlefield-1-${side}`, `player-battlefield-2-${side}`, `player-battlefield-3-${side}`,
    `player-battlefield-${side}`,
    `player-rune-color-1-${side}`, `player-rune-qty-1-${side}`,
    `player-rune-color-2-${side}`, `player-rune-qty-2-${side}`,
    `player-main-deck-${side}`, `player-side-deck-${side}`,
];

const cardCount = (lines = []) => lines.reduce((n, l) => n + (Number(String(l).split(' ')[0]) || 0), 0);

// The latest load started for each slot. Loads take as long as Piltover does
// (up to 15s), so a correction sent a moment after a wrong link can come back
// first; the older one must not then land on top of it.
let loadsStarted = 0;
const latestLoad = new Map();   // "<round>|<match>|<side>" -> load number

// Why Piltover didn't hand a deck over, as something the admin can act on.
function fetchFailure(e) {
    const status = e?.response?.status || null;
    const detail = String(e?.response?.data?.message || e?.message || e || '').slice(0, 200);
    if (/PILTOVER_API_KEY/.test(detail) || status === 401 || status === 403) return { reason: 'not-configured', status, detail };
    if (status === 404) return { reason: 'not-found', status, detail };
    if (status === 400 || status === 422) return { reason: 'bad-link', status, detail };
    return { reason: 'fetch-failed', status: status || e?.status || null, detail };
}

/**
 * @param {object} a
 * @param {string} a.round_id, a.match_id   the match to write to
 * @param {'left'|'right'} a.side
 * @param {() => boolean} [a.shouldCommit]  checked after the fetch; false = write nothing
 * @returns {Promise<
 *   { ok: true, round_id, match_id, legend, cards, sideboard } |
 *   { ok: false, reason: 'not-piltover' | 'no-match' | 'not-configured' | 'not-found' | 'bad-link'
 *                      | 'fetch-failed' | 'not-a-deck' | 'superseded' | 'paused', status?, detail? }>}
 */
export async function loadPiltoverDeckIntoControl({ round_id, match_id, side, link, io, fetchText = exportPiltoverDeck, shouldCommit = () => true }) {
    if (side !== 'left' && side !== 'right') throw new Error(`bad side: ${side}`);
    const ref = parsePiltoverLink(link);
    if (!ref) return { ok: false, reason: 'not-piltover' };
    // Only into a match master control has set up — never a new, empty one.
    if (!round_id || !match_id || !getControlData()?.[round_id]?.[match_id]) return { ok: false, reason: 'no-match' };

    const slot = `${round_id}|${match_id}|${side}`;
    const mine = ++loadsStarted;
    latestLoad.set(slot, mine);

    let text;
    try {
        text = await fetchText(ref);
    } catch (e) {
        return { ok: false, ...fetchFailure(e) };
    }
    if (latestLoad.get(slot) !== mine) return { ok: false, reason: 'superseded' };
    if (!shouldCommit()) return { ok: false, reason: 'paused' };

    const parsed = parseDeckString(text);
    const fields = riftboundDeckFields(parsed, side);
    if (!fields[`player-legend-${side}`] || !fields[`player-main-deck-${side}`]) {
        return { ok: false, reason: 'not-a-deck' };
    }
    const all = Object.fromEntries(deckFieldNames(side).map(k => [k, '']));
    Object.assign(all, fields);
    // The showdown tracker names this player's battlefield (left -> BF 1,
    // right -> BF 2). Master control and the iPad both copy the active
    // battlefield into it; without this it would keep the last player's.
    all[`showdown-bf-${side === 'left' ? 1 : 2}-name`] = all[`player-battlefield-${side}`];

    await updateFieldsFromServer(round_id, match_id, all, io);
    return {
        ok: true, round_id, match_id,
        legend: all[`player-legend-${side}`],
        // The champion sits outside the main list in Piltover's text; count it
        // back in so a legal deck reads 40.
        cards: cardCount(parsed.maindeck) + cardCount(parsed.champion),
        sideboard: cardCount(parsed.sideboard),
    };
}
