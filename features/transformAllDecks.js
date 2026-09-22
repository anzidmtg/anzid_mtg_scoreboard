import { transformMainDeckPure, transformSideDeckPure, emitTransformedMainDeck, emitTransformedSideDeck } from './cards.js';
import { cacheTransform, invalidateCache } from './transformCache.js';
import { getGameSelection } from '../config/constants.js';

// A deck field is normally an array of "N Card Name" lines, but older control
// data (and hand-typed entries) can hold the raw textarea string instead —
// newline-separated, occasionally comma-separated. The transforms iterate the
// deck, so a string here threw `deckArray.forEach is not a function` and took
// down every deck in the round with it. Same split card-vision uses.
export function deckLines(raw) {
    if (Array.isArray(raw)) return raw;
    if (raw == null) return [];
    return String(raw).split(/\n|,(?=\s*\d+\s)/).map(s => s.trim()).filter(Boolean);
}

// The main-deck transform input for one side of one match. Shared with the
// scoreboard's on-demand request so both paths produce identical deckData.
export function buildMainDeckPayload(matchData, sideID, gameType, matchID) {
    const payload = { deckData: deckLines(matchData[`player-main-deck-${sideID}`]), gameType, sideID, matchID };
    if (gameType === 'riftbound') {
        payload.riftboundMeta = {
            legend: matchData[`player-legend-${sideID}`] || '',
            champion: matchData[`player-champion-${sideID}`] || '',
            battlefields: [
                matchData[`player-battlefield-1-${sideID}`] || '',
                matchData[`player-battlefield-2-${sideID}`] || '',
                matchData[`player-battlefield-3-${sideID}`] || ''
            ],
            runeColor1: matchData[`player-rune-color-1-${sideID}`] || '',
            runeQty1: matchData[`player-rune-qty-1-${sideID}`] || '',
            runeColor2: matchData[`player-rune-color-2-${sideID}`] || '',
            runeQty2: matchData[`player-rune-qty-2-${sideID}`] || '',
            runesString: matchData[`player-runes-${sideID}`] || ''
        };
    }
    return payload;
}

// Server-side transform: transforms all decks for a round and emits + caches results
export function transformAndEmitAllDecks(roundId, controlData, io) {
    const gameType = getGameSelection();
    const matchIds = ['match1', 'match2', 'match3', 'match4'];
    const sideIds = ['left', 'right'];

    invalidateCache();

    for (const matchID of matchIds) {
        const matchData = controlData[roundId]?.[matchID];
        if (!matchData) continue;

        for (const sideID of sideIds) {
            // Main deck
            const payload = buildMainDeckPayload(matchData, sideID, gameType, matchID);
            if (payload.deckData.length > 0 || gameType === 'riftbound') {
                const mainResult = transformMainDeckPure(payload);
                emitTransformedMainDeck(mainResult.deckData, mainResult.gameType, mainResult.sideID, mainResult.matchID, io);
                cacheTransform(roundId, matchID, sideID, mainResult, null);
            }

            // Side deck
            // Always sent, empty included — same reason as
            // get-scoreboard-decklists in sockets/handlers.js: the decklist
            // pages keep the last sideboard they were given, so a player
            // without one would otherwise be shown the previous player's.
            // The empty payload is built here rather than through
            // transformSideDeckPure, which would rebuild the whole card-name
            // map to transform nothing.
            const sideDeckRaw = deckLines(matchData[`player-side-deck-${sideID}`]);
            const sideResult = sideDeckRaw.length > 0
                ? transformSideDeckPure({ deckData: sideDeckRaw, gameType, sideID, matchID })
                : { deckData: [], gameType, sideID, matchID };
            emitTransformedSideDeck(sideResult.deckData, sideResult.gameType, sideResult.sideID, sideResult.matchID, io);
            cacheTransform(roundId, matchID, sideID, null, sideResult);
        }
    }
    console.log(`[Broadcast] Server-side transforms complete for round ${roundId}`);
}
