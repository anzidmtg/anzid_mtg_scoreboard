// Piltover Archive deck-import proxy (riftbound).
//
// Master-control's "Add Decklist" modal posts a pasted PA deck link here; we
// pull the deck UUID out of it, call Piltover Archive's export/text endpoint
// with our API key, and hand back the human-readable decklist string. That
// string is already in the exact section format master-control's
// parseDeckString understands — Legend / Champion / MainDeck / Battlefields /
// Runes ("N <Color> Rune") / Sideboard — so the operator can review it in the
// textarea and Submit as normal, no client-side mapping required.
//
// Doing the call server-side keeps the API key out of the browser (it lives in
// the gitignored .env as PILTOVER_API_KEY, never in client code) and dodges the
// browser CORS wall on the PA host.
import axios from 'axios';

// api2 is the host that actually resolves; the *declared* production host
// (https://api.piltoverarchive.com/) did NOT resolve as of 2026-08-06. Override
// via PILTOVER_API_HOST in .env if/when the canonical host comes online.
const PA_HOST = (process.env.PILTOVER_API_HOST || 'https://api2.piltoverarchive.com').replace(/\/+$/, '');

// Deck links carry the deck UUID somewhere in the path/query. Pull the first
// UUID we see; also lets an operator paste a bare deck id.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function extractDeckId(link) {
    if (typeof link !== 'string') return null;
    const m = link.match(UUID_RE);
    return m ? m[0].toLowerCase() : null;
}

// Fetch a PA deck as a decklist string. Resolves to { deckId, text }.
// Throws Error with a `.status` for client-facing failures (bad link, missing
// key); surfaces PA's own status/message for upstream failures.
export async function fetchPiltoverDeckText(link) {
    const deckId = extractDeckId(link);
    if (!deckId) {
        const e = new Error('Could not find a deck ID in that link');
        e.status = 400;
        throw e;
    }
    return { deckId, text: await exportPiltoverDeck({ deckId }) };
}

// A deck's text from Piltover's export, by deck id or by deck code (the
// builder's ?code=). Same errors as fetchPiltoverDeckText.
export async function exportPiltoverDeck({ deckId, deckCode } = {}) {
    const apiKey = process.env.PILTOVER_API_KEY || '';
    if (!apiKey) {
        const e = new Error('PILTOVER_API_KEY not set in .env');
        e.status = 500;
        throw e;
    }
    const res = await axios.post(
        `${PA_HOST}/v1/decks/export/text`,
        deckId ? { deckId } : { deckCode },
        {
            headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
            timeout: 15000,
        }
    );
    const text = res.data?.text;
    if (!text || typeof text !== 'string') {
        const e = new Error('Piltover Archive returned no decklist text');
        e.status = 502;
        throw e;
    }
    return text;
}

// Strict: a link from chat counts only if it is really a Piltover Archive deck.
// extractDeckId() above takes the first UUID anywhere, which is right for
// master-control's paste box (it accepts bare ids) but would let
// "https://anything.example/3323c3c8-…" through. This checks the host and path.
// Returns { deckId } for /decks/view/<uuid>, { deckCode } for the builder's
// /deckbuilder?code=<code> (what !decklists itself links), or null.
const VIEW_PATH = /^\/decks\/view\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
export function parsePiltoverLink(raw) {
    let s = String(raw ?? '').trim();
    if (!s || /\s/.test(s)) return null;
    // Chat often drops the scheme: "piltoverarchive.com/decks/view/…".
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
    let u;
    try { u = new URL(s); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!/^(www\.)?piltoverarchive\.com$/i.test(u.hostname)) return null;
    if (u.username || u.password || u.port) return null;
    const view = u.pathname.match(VIEW_PATH);
    if (view) return { deckId: view[1].toLowerCase() };
    if (/^\/deckbuilder\/?$/i.test(u.pathname)) {
        const code = u.searchParams.get('code') || '';
        if (/^[A-Z2-7]{16,1000}$/i.test(code)) return { deckCode: code.toUpperCase() };
    }
    return null;
}
