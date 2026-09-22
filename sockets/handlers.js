import {
    emitMTGCardList,
    emitCardView,
    transformDraftList,
    transformMainDeckPure,
    transformSideDeckPure
} from '../features/cards.js';

import { getAllCachedTransforms } from '../features/transformCache.js';
import { getGameSelection, getScoreboardDecklistsVisible } from '../config/constants.js';
import { transformAndEmitAllDecks, buildMainDeckPayload, deckLines} from '../features/transformAllDecks.js';

import {
    emitVibesCardList,
    emitVibesCardView,
    handleVibesIncomingDeckData
} from '../features/vibes/cards.js';

import {
    updateFromControl,
    updateFieldFromControl,
    emitSavedStateForControl,
    updateControlMapping,
    emitControlTrackers,
    updateFromMaster,
    emitControlData,
    getControlData,
    saveControlData,
    updateBroadcastTracker,
    getBroadcastTracker,
    getBattlefieldVisibility,
    getCommL3Remote, setCommL3Remote,
    setBattlefieldVisibilitySlot,
    emitScoreboardState,
    updateScoreboardSate, emitCurrentGameSelection, updateGameSelection, emitUpdatedGameSelection,
    emitCurrentVendorSelection, updateVendorSelection,
    emitCurrentPlayerCount, updatePlayerCount,
    emitCurrentSideboardVisible, updateSideboardVisible,
    updateScoreboardDecklistsVisible, toggleCommL3, setCommL3Visible, getCommL3Visible} from '../features/control.js';

import { savePreset, restorePreset } from '../features/obs-websocket.js';

import {
    emitGlobalMatchData,
    updateBaseTimerDefault,
    updateCommentators,
    updateEventInformation
} from '../features/globalData.js';

import {
    emitTimerState,
    getTimerState,
    updateTimerAction
} from '../features/timers.js';

import {
    emitStandings,
    updateStandings,
    emitBroadcastStandings,
    getCurrentBroadcastStandings
} from '../features/standings.js';

import {
    emitBracketData,
    handleBracketUpdate
} from '../features/brackets.js';
import {
    updateDeckDisplay
} from "../features/decks.js";
import {
    emitOverlayBackgrounds
} from "../features/overlays.js";
import {
    getSortedArchetypes,
    saveArchetypeList,
    addArchetype,
    addMultipleArchetypes,
    deleteArchetype,
    updateArchetypeImage
} from "../features/archetypes.js";
import { noteOperatorCard } from '../features/card-slot-owner.js';
import {
    getSortedRoster,
    saveRoster,
    addPlayer,
    addMultiplePlayers,
    deletePlayer,
    clearRoster,
    updatePlayerPortrait,
    maybeAutoSeedRoster
} from "../features/roster.js";
import {
    getGroupAssignment,
    setGroupAssignment,
    saveGroupAssignment
} from "../features/group-assignment.js";
import {
    handleIncomingMetaBreakdownData,
    calculateMetagame,
    getCachedBroadcastData,
    metagameResultToBroadcastData,
    emitMetaBreakdownData
} from "../features/metaBreakdown.js";
import {
    emitRiftboundCardList,
    emitRiftboundCardView,
    handleRiftboundIncomingDeckData
} from "../features/riftbound/cards.js";

import {
    emitStarWarsCardList,
    emitStarWarsCardView,
    handleStarWarsIncomingDeckData,
    emitSWULeadersAndBases,
    lookupCardByName
} from "../features/starwars/cards.js";

import { RoomUtils } from '../utils/room-utils.js';
import {
    getPlatformConfig,
    setPlatformConfig,
    emitPlatformConfig,
    fetchTournamentStandings,
    fetchMatchByTable,
    fetchMeleeDecklists,
    fetchMeleeDecklist,
    parseMeleeDecklist,
    fetchMeleePairings,
    fetchCardeioDecklist,
    fetchCardeioPairings,
    fetchCardeioRegistrations,
    fetchCardeioRoundData,
    fetchCardeioEventDetail,
    fetchSpicerackMatches,
    loadCachedDecklist,
    loadCachedRegistrations
} from '../features/tournament-platforms.js';

import {
    getAllPairingsData,
    setPairingsForRound,
    emitAllPairings,
    loadPairingsData
} from '../features/pairings.js';

import {
    getRecordGoingIntoRound,
    hasStandingsApiData,
    loadStandingsApiData,
    getStandingsRowsForRound,
    getStandingsRoundNumbers
} from '../features/standings-api.js';

import {
    getLegendForPlayer,
    hasDecklistsForEvent,
    loadAllCachedDecklists
} from '../features/decklist-lookup.js';

import {
    computeBestOfLegendAllRounds
} from '../features/best-of-legend.js';

import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    getDeckLibrary,
    saveDeckEntry,
    deleteDeckEntry,
    noteDeckUsed,
} from '../features/riftbound/deck-library.js';

const __handlersFilename = fileURLToPath(import.meta.url);
const __handlersDirname = path.dirname(__handlersFilename);
// data/cardeio/ — same path other features use; cached as a constant
// so the fetch-missing-pairings handler can scan for existing per-event
// round files without re-resolving on every call.
const CARDEIO_DIR_PATH = path.join(__handlersDirname, '..', 'data', 'cardeio');


// Augment a round's matches with extras the pairings table needs:
//   - pre_round_record  → record going INTO this round (from standings-api)
//   - legend            → the player's deck legend (from cached decklists)
//
// Returns SHALLOW copies so the in-memory pairings cache stays untouched —
// downstream consumers may mutate the emitted payload, and we don't want
// per-emit mutations to leak back into setPairingsForRound's data. The
// underlying relationship/user_event_status objects are shared by reference;
// only the relationship-level wrapper is duplicated to add new fields.
//
// `eventId` is the active tournament ID — used to scope the legend
// lookup to the right event when the operator has cached decklists
// for multiple events. Pass null/undefined and legend stays empty.
function augmentMatches(matches, roundNumber, eventId) {
    if (!Array.isArray(matches)) return matches;
    const wantsLegends = eventId != null && hasDecklistsForEvent(eventId);
    return matches.map(match => {
        const rels = match.player_match_relationships || [];
        const augmentedRels = rels.map(rel => {
            const playerId = rel?.player?.id ?? rel?.user_event_status?.user?.id;
            const pre_round_record = getRecordGoingIntoRound(roundNumber, playerId);
            const legend = wantsLegends ? getLegendForPlayer(eventId, playerId) : '';
            return { ...rel, pre_round_record, legend };
        });
        return { ...match, player_match_relationships: augmentedRels };
    });
}


// Fill in any rounds for the current event that don't have a cached
// pairings file yet, AND refresh any cached rounds whose file still
// contains IN_PROGRESS matches (i.e. was fetched mid-round before
// results were finalized). Called as a side-effect of every per-round
// Fetch Pairings click so the operator never has to manually fetch
// rounds one by one — pressing Fetch on ANY round also tops up missing
// rounds and refreshes stale ones for the rest of the event.
//
// "Stale" = a cached file with at least one non-bye match whose
// `status === 'IN_PROGRESS'` (or any non-draw match missing a
// `winning_player_id` that matches either side). The matchup-matrix
// drops these matches entirely since it can't tell who won, so
// keeping them fresh is critical for matrix accuracy after rounds
// finish.
//
// Skips:
//   - the round the operator just explicitly refreshed (passed as
//     `skipRound`) so we don't double-fetch it
//   - non-cardeio platforms (no-op)
//
// Streams progress via `fetch-missing-pairings-progress` and a final
// `fetch-missing-pairings-complete` on the requesting socket so the
// status line in the Pairings tab can show what's happening. Per-round
// `tournament-pairings-fetched` broadcasts (already wired client-side
// to repaint each round's table) are emitted via RoomUtils so any
// co-operator's open master-control tab also repaints in real time.
async function fetchMissingPairingsForEvent(io, socket, tournamentIdOverride, { skipRound } = {}) {
    const cfg = getPlatformConfig();
    const tournamentId = tournamentIdOverride || cfg.tournamentId;
    if (!tournamentId) return;
    if (cfg.platform && cfg.platform !== 'cardeio') return;

    const roundMap = cfg.cardeioRoundMap || {};
    const expectedRounds = Object.keys(roundMap)
        .map(Number)
        .filter(n => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
    if (expectedRounds.length === 0) return;

    // Which rounds already have a cached pairings file for THIS event?
    // Reuse the same event-scoped filename pattern as the loader.
    const cachedRounds = new Map();  // roundNumber → filename
    try {
        const entries = await fsPromises.readdir(CARDEIO_DIR_PATH);
        const idEsc = String(tournamentId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const fileRe = new RegExp(`^pairings-api-event-${idEsc}-round-(\\d+)\\.json$`);
        for (const fname of entries) {
            const m = fname.match(fileRe);
            if (m) cachedRounds.set(Number(m[1]), fname);
        }
    } catch (e) {
        // Missing dir → no cached rounds, treat as all missing
    }

    const skipRoundNum = skipRound != null ? Number(skipRound) : null;
    const missingRounds = expectedRounds.filter(n => !cachedRounds.has(n) && n !== skipRoundNum);

    // Inspect each cached round (other than the one we just refreshed)
    // for stale data — any non-bye match whose status is still
    // IN_PROGRESS, or any non-draw match without a clear
    // winning_player_id. These can't be used by the matchup matrix and
    // a re-fetch will usually pick up finalized results.
    const staleRounds = [];
    for (const [roundNum, fname] of cachedRounds.entries()) {
        if (roundNum === skipRoundNum) continue;
        try {
            const raw = await fsPromises.readFile(path.join(CARDEIO_DIR_PATH, fname), 'utf8');
            const matches = JSON.parse(raw);
            if (roundHasInProgressMatches(matches)) staleRounds.push(roundNum);
        } catch {
            // Unreadable / malformed cache → treat as stale so we
            // re-fetch and overwrite it.
            staleRounds.push(roundNum);
        }
    }

    // Combined list — missing first (gaps), then stale (refreshes).
    // De-duped via Set just in case the same round shows up twice.
    const toFetch = [...new Set([...missingRounds, ...staleRounds])]
        .sort((a, b) => a - b);
    if (toFetch.length === 0) return;

    if (socket) {
        socket.emit('fetch-missing-pairings-progress', {
            phase: 'start',
            totalExpected: expectedRounds.length,
            alreadyCached: cachedRounds.size - staleRounds.length,
            missing: missingRounds,
            stale: staleRounds,
            toFetch
        });
    }

    let fetched = 0;
    const failures = [];
    for (const roundId of toFetch) {
        const isRefresh = !missingRounds.includes(roundId);
        if (socket) {
            socket.emit('fetch-missing-pairings-progress', {
                phase: 'fetching',
                roundId,
                refresh: isRefresh,
                index: fetched + failures.length + 1,
                total: toFetch.length
            });
        }
        try {
            const matches = await fetchCardeioPairings(roundId);
            setPairingsForRound(roundId, matches);
            const augmented = augmentMatches(matches, roundId, tournamentId);
            RoomUtils.emitWithRoomMapping(io, 'tournament-pairings-fetched', {
                roundId,
                success: true,
                count: augmented.length,
                matches: augmented
            });
            fetched++;
            if (socket) {
                socket.emit('fetch-missing-pairings-progress', {
                    phase: 'fetched',
                    roundId,
                    refresh: isRefresh,
                    count: augmented.length,
                    index: fetched + failures.length,
                    total: toFetch.length
                });
            }
        } catch (e) {
            failures.push({ roundId, error: e.message });
            if (socket) {
                socket.emit('fetch-missing-pairings-progress', {
                    phase: 'failed',
                    roundId,
                    refresh: isRefresh,
                    error: e.message,
                    index: fetched + failures.length,
                    total: toFetch.length
                });
            }
        }
        // Small inter-round gap so we don't hammer the Carde API
        // (matches the bulk script's pacing).
        await new Promise(r => setTimeout(r, 500));
    }

    if (socket) {
        const filledCount = missingRounds.length === 0 ? 0
            : missingRounds.filter(r => !failures.find(f => f.roundId === r)).length;
        const refreshedCount = staleRounds.length === 0 ? 0
            : staleRounds.filter(r => !failures.find(f => f.roundId === r)).length;
        const summaryParts = [];
        if (filledCount > 0) summaryParts.push(`filled ${filledCount} missing`);
        if (refreshedCount > 0) summaryParts.push(`refreshed ${refreshedCount} stale`);
        if (summaryParts.length === 0) summaryParts.push(`fetched ${fetched}`);
        const failTail = failures.length > 0 ? `; ${failures.length} failed` : '';
        socket.emit('fetch-missing-pairings-complete', {
            success: failures.length === 0,
            fetched,
            filled: filledCount,
            refreshed: refreshedCount,
            failed: failures.length,
            failures,
            totalExpected: expectedRounds.length,
            message: `Auto-fill done — ${summaryParts.join(', ')} round(s)${failTail}.`
        });
    }
}

// One row of the Player View roster — joins one registration entry
// with the matching cached decklist (if any). Falls back gracefully
// when either side is missing: a registration without a decklist still
// shows up (no legend yet), and a decklist without a matching
// registration still shows up (player name from best_identifier only).
function slimRosterEntry(userId, reg, dl) {
    const firstName = reg?.['First Name'] || '';
    const lastName = reg?.['Last Name'] || '';
    const displayName = reg?.['Display Name'] || '';
    const realName = (firstName || lastName) ? `${firstName} ${lastName}`.trim() : '';
    const bestIdentifier = dl?.user?.best_identifier || displayName || realName || '';
    const battlefields = extractAuxCards(dl, 'battlefield');
    return {
        userId,
        firstName,
        lastName,
        realName,
        displayName,
        bestIdentifier,
        legend: extractAuxCard(dl, 'legend'),
        champion: extractAuxCard(dl, 'champion'),
        // Roster joins all 3 battlefields into one searchable string so
        // operators can find a player by any battlefield they brought.
        // Detail view (slimDecklist) sends the array form for rendering.
        battlefield: battlefields.join(' / '),
        battlefields,
        deckName: dl?.deck_name || '',
        hasDecklist: !!dl
    };
}

// Pull the first card name from a Carde decklist auxiliary section.
// Used for sections that always carry exactly one card (legend,
// champion). For battlefields use `extractAuxCards` — players bring
// THREE battlefields to the table. Returns '' when missing so the
// client doesn't have to null-check.
function extractAuxCard(decklistEntry, typeCode) {
    if (!decklistEntry) return '';
    const aux = decklistEntry.auxiliary_sections || [];
    const sec = aux.find(s => s?.type_code === typeCode);
    return sec?.cards?.[0]?.name || '';
}

// Pull every card name from a Carde decklist auxiliary section. Used
// for battlefield (3 cards per player in Riftbound). Returns [] when
// the section is missing.
function extractAuxCards(decklistEntry, typeCode) {
    if (!decklistEntry) return [];
    const aux = decklistEntry.auxiliary_sections || [];
    const sec = aux.find(s => s?.type_code === typeCode);
    return (sec?.cards || []).map(c => c?.name).filter(Boolean);
}

// Slim one full decklist down to just the fields the Player View
// renderer touches. Drops Carde card IDs and other heavy metadata so
// the per-player emit stays small.
function slimDecklist(dl) {
    if (!dl) return null;
    const slimCard = c => ({
        name: c?.name || '',
        quantity: Number(c?.quantity ?? 1),
        domains: Array.isArray(c?.domains) ? c.domains : undefined
    });
    const sections = (dl.sections || []).map(s => ({
        key: s?.section_key || '',
        label: s?.section_label || '',
        cards: (s?.cards || []).map(slimCard)
    }));
    return {
        userId: Number(dl?.user?.id),
        bestIdentifier: dl?.user?.best_identifier || '',
        deckName: dl?.deck_name || '',
        format: dl?.format || '',
        domainIdentity: Array.isArray(dl?.domain_identity) ? dl.domain_identity : [],
        validationStatus: dl?.validation_status || '',
        legend: extractAuxCard(dl, 'legend'),
        champion: extractAuxCard(dl, 'champion'),
        // Players bring 3 battlefields to the table — send all of them
        // so the detail view can list each one.
        battlefields: extractAuxCards(dl, 'battlefield'),
        sections
    };
}

// True if the round's cached matches contain at least one non-bye,
// non-ghost, two-player match whose result hasn't been finalized —
// either the status is still IN_PROGRESS, or the match isn't a draw
// and the `winning_player_id` doesn't match either side's player.id.
// These are the matches the matchup matrix drops because it can't
// tell who won, so they're the right signal for "this round's cache
// is stale, re-fetch it."
//
// Single-player relationships (rels.length < 2) are skipped — those
// are Carde's "forced loss" entries for no-shows / DQs at table -1,
// which carry `match_is_loss=true` and never have a winner. The
// matrix already ignores them; without the same skip here we'd re-
// fetch the same round on every click for no benefit.
function roundHasInProgressMatches(matches) {
    if (!Array.isArray(matches)) return false;
    for (const m of matches) {
        if (m?.match_is_bye) continue;
        if (m?.match_is_ghost_match) continue;
        const rels = m?.player_match_relationships || [];
        if (rels.length < 2) continue;
        if (m?.status === 'IN_PROGRESS') return true;
        const isDraw = !!(m?.match_is_intentional_draw || m?.match_is_unintentional_draw);
        if (isDraw) continue;
        const p1 = rels[0]?.player?.id;
        const p2 = rels[1]?.player?.id;
        const w = m?.winning_player_id;
        if (w !== p1 && w !== p2) return true;
    }
    return false;
}

export default function registerSocketHandlers(io) {
    io.on('connection', (socket) => {
        console.log('User connected:', socket.id);

        // Room management handlers
        socket.on('join-room', (roomName) => {
            socket.join(roomName);
            console.log(`[ROOM] Client ${socket.id} joined room: ${roomName}`);
        });
        
        socket.on('leave-room', (roomName) => {
            socket.leave(roomName);
            console.log(`[ROOM] Client ${socket.id} left room: ${roomName}`);
        });

        // Send the current overlay background images to the newly connected client
        emitOverlayBackgrounds(io);

        // emit full control data
        emitControlData(io);

        // Scoreboard: match state updates - comes from control - use to update master-control / scoreboard
        socket.on('control-data-updated', ({round_id, match_id, current_state}) => {
            updateFromControl(round_id, match_id, current_state, io);
        });

        // NEW: Granular field updates from control
        socket.on('field-updated', ({round_id, match_id, field, value, timestamp}) => {
            updateFieldFromControl(round_id, match_id, field, value, timestamp, io);
        });

        socket.on('getSavedControlState', ({control_id}) => {
            emitSavedStateForControl(control_id, io);
        });

        // comes from master control - use to update control / scoreboard
        socket.on('master-control-matches-updated', (allControlData) => {
            updateFromMaster(allControlData, io);
        });

        socket.on('control-mapping-update', ({controlId, round_id, match_id}) => {
            updateControlMapping(controlId, round_id, match_id, io);
        });

        socket.on('get-control-broadcast-trackers', () => {
            emitControlTrackers(io);
        });

        // Control data
        socket.on('get-all-control-data', () => {
            emitControlData(io);
        })

        // Scoreboard state (wins only for now)
        socket.on('get-scoreboard-state', () => {
            emitScoreboardState(io);
        })

        socket.on('update-scoreboard-state', ({round_id, match_id, action, value}) => {
            updateScoreboardSate(io, round_id, match_id, action, value);
        })

        // Timer control
        socket.on('update-timer-state', ({round_id, match_id, action}) => {
            updateTimerAction(io, round_id, match_id, action);
            emitTimerState(io);
        });

        socket.on('get-all-timer-states', () => {
            emitTimerState(io);
        });

        // Overlays
        socket.on('getOverlays', () => {
            emitOverlayBackgrounds(io);
        })

        // Archetype list
        socket.on('getArchetypeList', () => {
            RoomUtils.emitWithRoomMapping(io, 'archetypeListUpdated', getSortedArchetypes());
        });

        socket.on('addArchetype', (name) => {
            if (addArchetype(name)) {
                RoomUtils.emitWithRoomMapping(io, 'archetypeListUpdated', getSortedArchetypes());
            }
        });

        socket.on('addArchetypes', async (names) => {
            if (addMultipleArchetypes(names)) {
                await saveArchetypeList();
                RoomUtils.emitWithRoomMapping(io, 'archetypeListUpdated', getSortedArchetypes());
            }
        });

        socket.on('deleteArchetype', async (name) => {
            if (deleteArchetype(name)) {
                await saveArchetypeList();
                RoomUtils.emitWithRoomMapping(io, 'archetypeListUpdated', getSortedArchetypes());
            }
        });

        socket.on('upload-archetype-image', async (name, url) => {
            if (updateArchetypeImage(name, url)) {
                await saveArchetypeList();
                RoomUtils.emitWithRoomMapping(io, 'archetypeListUpdated', getSortedArchetypes());
            }
        });

        // Player roster (mirrors archetype flow — shape: { name, portraitUrl })
        socket.on('getPlayerRoster', () => {
            RoomUtils.emitWithRoomMapping(io, 'playerRosterUpdated', getSortedRoster());
        });

        socket.on('addPlayer', async (name) => {
            if (addPlayer(name)) {
                await saveRoster();
                RoomUtils.emitWithRoomMapping(io, 'playerRosterUpdated', getSortedRoster());
            }
        });

        socket.on('addPlayers', async (names) => {
            if (addMultiplePlayers(names)) {
                await saveRoster();
                RoomUtils.emitWithRoomMapping(io, 'playerRosterUpdated', getSortedRoster());
            }
        });

        socket.on('deletePlayer', async (name) => {
            if (deletePlayer(name)) {
                await saveRoster();
                RoomUtils.emitWithRoomMapping(io, 'playerRosterUpdated', getSortedRoster());
            }
        });

        // Wholesale clear (master-control "Delete All Players" button). No-op
        // when already empty so we don't churn the disk + every connected page.
        socket.on('clearPlayerRoster', async () => {
            if (clearRoster()) {
                await saveRoster();
                RoomUtils.emitWithRoomMapping(io, 'playerRosterUpdated', getSortedRoster());
            }
        });

        socket.on('upload-player-portrait', async (name, url) => {
            if (updatePlayerPortrait(name, url)) {
                await saveRoster();
                RoomUtils.emitWithRoomMapping(io, 'playerRosterUpdated', getSortedRoster());
            }
        });

        // Group assignment (flyquest 2v2 standings layout). Single full-list
        // replace flow — operators edit both group rosters at once in
        // master-control and hit save. The standings renderer listens for
        // groupAssignmentUpdated and re-splits its bracket columns.
        socket.on('getGroupAssignment', () => {
            socket.emit('groupAssignmentUpdated', getGroupAssignment());
        });

        socket.on('setGroupAssignment', async (payload) => {
            setGroupAssignment(payload || {});
            await saveGroupAssignment();
            RoomUtils.emitWithRoomMapping(io, 'groupAssignmentUpdated', getGroupAssignment());
        });

        // Global match data
        socket.on('get-match-global-data', () => {
            emitGlobalMatchData(io);
        });

        socket.on('update-commentators-requested', ({commentatorData}) => {
            updateCommentators(commentatorData, io);
        });

        socket.on('update-event-information-requested', ({eventInformationData}) => {
            updateEventInformation(eventInformationData, io, getTimerState());
        });


        // Global base timer
        socket.on('update-event-information-base-timer-requested', ({eventInformationData}) => {
            updateBaseTimerDefault(eventInformationData, getTimerState());
        });

        // Global game selection
        socket.on('update-game-selection', async ({gameSelection}) => {
            updateGameSelection(gameSelection, io);
            // Roster auto-seed is gated on mtg+flyquest+2v2. Each selection
            // change re-checks the gate — first time all three match (with
            // roster still empty), the seed fires and playerRosterUpdated
            // broadcasts so open master-control tabs repopulate live.
            if (await maybeAutoSeedRoster()) {
                RoomUtils.emitWithRoomMapping(io, 'playerRosterUpdated', getSortedRoster());
            }
        })

        socket.on('get-game-selection', () => {
            emitCurrentGameSelection(io);
        })

        // Global vendor selection
        socket.on('update-vendor-selection', async ({vendorSelection}) => {
            updateVendorSelection(vendorSelection, io);
            // Per-vendor rosters: switching vendor changes which bucket
            // getSortedRoster() reads, so always re-broadcast. Auto-seed
            // attempt happens too — no-op unless the new selection happens
            // to be mtg+flyquest+2v2 with that bucket still empty.
            await maybeAutoSeedRoster();
            RoomUtils.emitWithRoomMapping(io, 'playerRosterUpdated', getSortedRoster());
        })

        socket.on('get-vendor-selection', () => {
            emitCurrentVendorSelection(io);
        })

        // Global player count
        socket.on('update-player-count', async ({playerCount}) => {
            updatePlayerCount(playerCount, io);
            // Same as vendor change — count is part of the bucket key, so
            // 1v1↔2v2 also swaps the visible roster.
            await maybeAutoSeedRoster();
            RoomUtils.emitWithRoomMapping(io, 'playerRosterUpdated', getSortedRoster());
        })

        socket.on('get-player-count', () => {
            emitCurrentPlayerCount(io);
        })

        // Global sideboard visibility (decklist broadcast show/hide)
        socket.on('update-sideboard-visible', ({sideboardVisible}) => {
            updateSideboardVisible(sideboardVisible, io);
        })

        socket.on('get-sideboard-visible', () => {
            emitCurrentSideboardVisible(io);
        })

        // Scoreboard decklists (both players' vertical lists slid onto the
        // riftbound scoreboard). 'current' goes to the asker only; updates go
        // to everyone.
        socket.on('update-scoreboard-decklists-visible', ({scoreboardDecklistsVisible} = {}) => {
            updateScoreboardDecklistsVisible(scoreboardDecklistsVisible, io);
        })

        socket.on('get-scoreboard-decklists-visible', () => {
            socket.emit('server-current-scoreboard-decklists-visible', { scoreboardDecklistsVisible: getScoreboardDecklistsVisible() });
        })

        // OBS Presets
        socket.on('save-obs-preset', async () => {
            const result = await savePreset();
            socket.emit('obs-preset-saved', result);
        })

        socket.on('restore-obs-preset', async ({ game, vendor, playerCount }) => {
            await restorePreset(game, vendor, playerCount);
        })

        // Commentator L3 — server-held visibility (auto-hides after 5s server-side).
        // 'toggle-commentator-l3' is what master control and Companion have always
        // sent; the L3 pages now follow comm-l3-visible-updated instead of a pulse.
        socket.on('toggle-commentator-l3', () => {
            toggleCommL3(io);
        })
        socket.on('update-comm-l3-visible', ({ visible } = {}) => {
            setCommL3Visible(!!visible, io);
        })
        socket.on('get-comm-l3-visible', () => {
            socket.emit('server-comm-l3-visible', { visible: getCommL3Visible() });
        })

        // Commentator L3 remote mode (server-held so late-joining pages sync;
        // in-person = bottom row, remote = one L3 centered per cam segment)
        socket.on('get-comm-l3-remote', () => {
            socket.emit('server-comm-l3-remote', { remote: getCommL3Remote() });
        })
        socket.on('update-comm-l3-remote', ({ remote }) => {
            setCommL3Remote(!!remote);
            io.emit('comm-l3-remote-updated', { remote: getCommL3Remote() });
        })

        // Card viewer
        socket.on('mtg-get-card-list-data', () => {
            emitMTGCardList(io);
        });

        socket.on('view-selected-card', ({cardSelected}) => {
            noteOperatorCard(cardSelected);
            console.log('[VIEW] view-selected-card from', socket.id, cardSelected);
            emitCardView(io, cardSelected);
        });

        // VIBES

        // Vibes - Card viewer
        socket.on('vibes-get-card-list-data', () => {
            emitVibesCardList(io);
        });

        socket.on('vibes-card-view-view-card', ({cardSelected}) => {
            noteOperatorCard(cardSelected);
            emitVibesCardView(io, cardSelected);
        });

        // Vibes - Deck Display
        socket.on('vibes-main-deck-display-clicked', (deckListData) => {
            handleVibesIncomingDeckData(io, deckListData)
        })

        // END VIBES

        // RIFTBOUND

        // riftbound - Card viewer
        // ── Piltover deck library ───────────────────────────────────────
        // A pre-built set of deck links per legend so the operator can pull a
        // deck onto a board from the iPad instead of pasting a link at the
        // laptop. Broadcast globally on every change so an edit made on
        // master-control shows up on a running admin-control immediately.
        const emitDeckLibrary = () => io.emit('deck-library-updated', getDeckLibrary());

        socket.on('get-deck-library', () => {
            socket.emit('deck-library-updated', getDeckLibrary());
        });

        socket.on('save-deck-library-entry', (entry, ack) => {
            const res = saveDeckEntry(entry || {});
            if (res.ok) emitDeckLibrary();
            if (typeof ack === 'function') ack(res);
        });

        socket.on('delete-deck-library-entry', ({ id } = {}, ack) => {
            const res = deleteDeckEntry(id);
            if (res.ok) emitDeckLibrary();
            if (typeof ack === 'function') ack(res);
        });

        // Bumps lastUsedAt so the dropdown floats the decks actually being used
        // to the top. Fire-and-forget; a failure here must never block a load.
        socket.on('note-deck-library-used', ({ id } = {}) => {
            noteDeckUsed(id);
            emitDeckLibrary();
        });

        socket.on('riftbound-get-card-list-data', () => {
            emitRiftboundCardList(io);
        });

        socket.on('riftbound-card-view-view-card', ({cardSelected}) => {
            noteOperatorCard(cardSelected);
            emitRiftboundCardView(io, cardSelected);
        });

        // riftbound - Deck Display
        socket.on('riftbound-main-deck-display-clicked', (deckListData) => {
            handleRiftboundIncomingDeckData(io, deckListData)
        })

        // END RIFTBOUND

        // STARWARS

        // starwars - Card list
        socket.on('starwars-get-card-list-data', () => {
            emitStarWarsCardList(io);
        });

        // starwars - Deck Display
        socket.on('starwars-main-deck-display-clicked', (deckListData) => {
            handleStarWarsIncomingDeckData(io, deckListData)
        })

        // starwars - Leaders and Bases list for dropdowns
        socket.on('starwars-get-leaders-and-bases', () => {
            emitSWULeadersAndBases(io);
        });

        // END STARWARS

        // Standings
        socket.on('get-all-standings', () => {
            emitStandings(io);
        });

        socket.on('standings-updated', async ({round_id, textData}) => {
            await updateStandings(round_id, textData);
        });

        socket.on('get-broadcast-standings', () => {
            const standings = getCurrentBroadcastStandings();
            if (standings) {
                socket.emit('broadcast-round-standings-data', standings);
            }
        });

        // ── Dev hook — bypass the text-parser pipeline to broadcast a
        // pre-baked standings payload directly (including per-team
        // player1/player2 fields that the FlyQuest 2v2 layout needs but
        // parseStandingsRawData doesn't produce). Used by
        // scripts/emit-dummy-2v2-standings.mjs while we're not yet linked
        // to Melee for 2v2. Rebroadcasts to every standings display so the
        // /broadcast/round/standings-combined page renders the test data.
        socket.on('dev-inject-broadcast-standings', (payload) => {
            console.log('[dev] inject-broadcast-standings from', socket.id, '— rebroadcasting');
            RoomUtils.emitWithRoomMapping(io, 'broadcast-round-standings-data', payload);
        });

        // Broadcast
        socket.on('broadcast-requested', async ({round_id}) => {
            console.log(`[Broadcast] broadcast-requested from ${socket.id} for round ${round_id}`);
            const controlData = getControlData();
            if (controlData[round_id]) {
                updateBroadcastTracker(round_id);
                RoomUtils.emitWithRoomMapping(io, 'broadcast-round-data', controlData[round_id]);
                RoomUtils.emitToRoom(io, 'broadcast-scoreboard', 'broadcast-scoreboard-round-id', { round_id });
                // The Controls tab's per-match pills and the Companion module follow the live round.
                RoomUtils.emitToRoom(io, 'master-control', 'broadcast-scoreboard-round-id', { round_id });
                // Server-side transforms — transform all decks and push results
                transformAndEmitAllDecks(round_id, controlData, io);
            }
            emitBroadcastStandings(io, round_id);
        });

        // Broadcast scoreboard - request current broadcast data on page load
        socket.on('get-broadcast-scoreboard-data', () => {
            console.log(`[Broadcast] get-broadcast-scoreboard-data from ${socket.id}`);
            const bt = getBroadcastTracker();
            const cd = getControlData();
            if (bt.round_id && cd[bt.round_id]) {
                socket.emit('broadcast-round-data', cd[bt.round_id]);
                socket.emit('broadcast-scoreboard-round-id', { round_id: bt.round_id });
                // Send cached transforms for late joiners
                const cached = getAllCachedTransforms();
                Object.values(cached).forEach(({ main, side }) => {
                    if (main) socket.emit('transformed-main-deck-data', main);
                    if (side) socket.emit('transformed-side-deck-data', side);
                });
            }
        });

        // Scoreboard decklists: transform BOTH sides of one match straight from
        // control data and reply to the asker only. Independent of the transform
        // cache (empty after a restart until the next Broadcast press) and of the
        // broadcast round, so live-mode /scoreboard/N pages get their own round.
        // Same event names as the Broadcast path → one client listener pair.
        socket.on('get-scoreboard-decklists', ({ round_id, match_id } = {}) => {
            const matchData = getControlData()?.[round_id]?.[match_id];
            if (!matchData) return;
            const gameType = getGameSelection();
            for (const sideID of ['left', 'right']) {
                try {
                    const main = transformMainDeckPure(buildMainDeckPayload(matchData, sideID, gameType, match_id));
                    socket.emit('transformed-main-deck-data', main);
                    // Always sent, empty included: the page keeps the last
                    // sideboard it was given, so a new deck with none would
                    // otherwise show the previous player's.
                    const sideRaw = deckLines(matchData[`player-side-deck-${sideID}`]);
                    socket.emit('transformed-side-deck-data', sideRaw.length > 0
                        ? transformSideDeckPure({ deckData: sideRaw, gameType, sideID, matchID: match_id })
                        : { deckData: [], gameType, sideID, matchID: match_id });
                } catch (e) {
                    console.error(`[Scoreboard decklists] transform failed for ${round_id}/${match_id}/${sideID}:`, e.message);
                }
            }
        });

        // ── /scoreboard L3 battlefields-row visibility ──────────────────
        // Operator toggles a per-slot Hide checkbox in master-control to
        // hide a battlefield card from the .riftbound-bf-row strip without
        // touching match data. State lives in features/control.js (resets
        // on server restart; intentional — fresh "all visible" per stream).
        // Broadcast to every page so the scoreboard reflows in real time.
        socket.on('get-battlefield-visibility', () => {
            socket.emit('battlefield-visibility-updated', getBattlefieldVisibility());
        });
        socket.on('update-battlefield-visibility', ({ slot, visible }) => {
            // Validation lives inside the setter so clients can't poison the
            // state by sending arbitrary slot keys.
            if (setBattlefieldVisibilitySlot(slot, visible)) {
                RoomUtils.emitWithRoomMapping(io, 'battlefield-visibility-updated', getBattlefieldVisibility());
            }
        });

        socket.on('transform-draft-list', (data) => {
            transformDraftList(data, io);
        });

        // Request current draft list data (for page refresh)
        socket.on('get-draft-list-data', ({ slotId }) => {
            console.log('[DraftList] Data requested for slot:', slotId);
            const controlData = getControlData();

            if (controlData.draftLists && controlData.draftLists[slotId]) {
                const data = controlData.draftLists[slotId];
                socket.emit('draft-list-data', {
                    slotId,
                    playerName: data.playerName || '',
                    playerPronouns: data.playerPronouns || '',
                    playerArchetype: data.playerArchetype || '',
                    playerManaSymbols: data.playerManaSymbols || '',
                    cards: data.cards || []
                });
            }
        });

        // Draft list update from master control (real-time)
        // Stored separately from match data - completely independent
        socket.on('update-draft-list', async ({ slotId, playerName, playerPronouns, playerArchetype, playerManaSymbols, draftList }) => {
            console.log('[DraftList] Update received for slot:', slotId, playerName, draftList?.length, 'cards');

            // Get current control data
            const controlData = getControlData();

            // Store draft lists in separate 'draftLists' structure
            if (!controlData.draftLists) controlData.draftLists = {};
            controlData.draftLists[slotId] = {
                playerName: playerName || '',
                playerPronouns: playerPronouns || '',
                playerArchetype: playerArchetype || '',
                playerManaSymbols: playerManaSymbols || '',
                cards: draftList
            };

            // Save to persist the data
            await saveControlData();

            // Emit dedicated draft list event (not broadcast-round-data)
            RoomUtils.emitWithRoomMapping(io, 'draft-list-data', {
                slotId,
                playerName: playerName || '',
                playerPronouns: playerPronouns || '',
                playerArchetype: playerArchetype || '',
                playerManaSymbols: playerManaSymbols || '',
                cards: draftList
            });
        });

        // Bracket
        socket.on('get-bracket-data', () => {
            emitBracketData(io);
        });

        socket.on('bracket-updated', async ({bracketValues}) => {
            await handleBracketUpdate(bracketValues, io);
        });

        // Decks
        socket.on('display-deck', (payload) => {
            updateDeckDisplay(io, payload);
        });

        // Meta Breakdown
        socket.on('send-meta-breakdown-data', (payload) => {
            handleIncomingMetaBreakdownData(io, payload);
        });

        socket.on('calculate-metagame', async ({ day1Round, day2Round, day2Cutoff, gameType, showCount }) => {
            try {
                const result = await calculateMetagame({ day1Round, day2Round, day2Cutoff, gameType });
                socket.emit('metagame-calculated', result);

                // Auto-cache broadcast data so the broadcast page can load it on init
                const broadcastData = metagameResultToBroadcastData(result, gameType, showCount);
                emitMetaBreakdownData(io, broadcastData);
            } catch (error) {
                socket.emit('metagame-calculated', { error: error.message });
            }
        });

        socket.on('get-meta-breakdown-data', () => {
            const cached = getCachedBroadcastData();
            if (cached) {
                socket.emit('receive-meta-breakdown-data', cached);
            }
        });

        // Tournament Platform
        socket.on('get-tournament-platform', () => {
            socket.emit('tournament-platform-config', getPlatformConfig());
        });

        socket.on('set-tournament-platform', async (config) => {
            const prevTournamentId = getPlatformConfig().tournamentId;
            setPlatformConfig(config);
            emitPlatformConfig(io);

            // If the operator switched to a different event, reload the
            // per-event pairings + standings caches so the in-memory
            // state matches the new event. Without this, the loaders
            // would still hold the previous event's rounds and any
            // matrix / standings UI would mix data from both events.
            const newTournamentId = getPlatformConfig().tournamentId;
            if (newTournamentId && newTournamentId !== prevTournamentId) {
                try {
                    await loadPairingsData();
                    await loadStandingsApiData();
                    emitAllPairings(io);
                    console.log(`[Platform] Reloaded caches after event switch ${prevTournamentId || '(none)'} → ${newTournamentId}`);
                } catch (e) {
                    console.error('[Platform] Failed to reload caches after event switch:', e.message);
                }
            }
        });

        socket.on('fetch-tournament-standings', async ({ platform, tournamentId, roundId }) => {
            try {
                // Update config before fetching
                setPlatformConfig({ platform, tournamentId });
                // Pass roundId to fetch standings for that specific round
                const standings = await fetchTournamentStandings(roundId);
                socket.emit('tournament-standings-fetched', { standings });

                // ── Auto-refresh side effects ─────────────────────────
                // The cardeio fetch wrote a fresh standings JSON to
                // disk (anti-spoiler convention writes round N-1 when
                // we ask for round N). Reload the standings-api
                // in-memory cache + recompute Best of Legend so any
                // master-control tab listening for the BoL snapshot
                // sees the just-fetched round populate without a page
                // reload. Broadcast (not socket.emit) so co-operator
                // tabs watching the same event also refresh.
                if ((platform || getPlatformConfig().platform) === 'cardeio') {
                    try {
                        await loadStandingsApiData();
                        const activeEventId = getPlatformConfig()?.tournamentId || null;
                        if (activeEventId && hasDecklistsForEvent(activeEventId)) {
                            const byRound = computeBestOfLegendAllRounds(activeEventId);
                            RoomUtils.emitWithRoomMapping(io, 'best-of-legend-data', { byRound, eventId: activeEventId });
                        }
                    } catch (e) {
                        console.error('[BoL] Auto-refresh after standings fetch failed:', e.message);
                    }
                }
            } catch (error) {
                socket.emit('tournament-standings-fetched', { error: error.message });
            }
        });

        // Full per-round standings (EVERY player) for the master-control
        // standings search — so mid-field players that aren't in the broadcast
        // cut/textarea are still findable by handle or real name. Reads the
        // already-loaded standings-api cache; joins each player's legend from
        // the cached decklists.
        socket.on('get-full-standings', ({ roundNumber }) => {
            const eventId = getPlatformConfig()?.tournamentId || null;
            // Carde files standings a round behind (anti-spoiler: in round N the
            // file is round N-1, see tournament-platforms.js). So the current
            // round's tab often has no exact file yet. Fall back to the most
            // recent cached round at or before the requested one (else the
            // latest overall) so live searches always hit real data.
            const requested = Number(roundNumber);
            let roundUsed = requested;
            let rows = getStandingsRowsForRound(roundNumber);
            if (!rows || rows.length === 0) {
                const cached = getStandingsRoundNumbers()
                    .map(Number).filter(Number.isFinite).sort((a, b) => a - b);
                const atOrBefore = cached.filter(n => n <= requested);
                const pick = atOrBefore.length ? atOrBefore[atOrBefore.length - 1]
                    : (cached.length ? cached[cached.length - 1] : null);
                if (pick != null) { roundUsed = pick; rows = getStandingsRowsForRound(String(pick)); }
            }
            const players = (rows || []).map(r => ({
                rank: Number.isFinite(r.rank) ? r.rank : null,
                name: r.displayName || r.bestIdentifier || r.realName || 'Unknown',
                legend: eventId ? (getLegendForPlayer(eventId, r.playerId) || '') : '',
                record: r.record || '',
                // searchable across handle/Riot game name + real name + best identifier
                search: [r.displayName, r.realName, r.bestIdentifier].filter(Boolean).join(' ').toLowerCase()
            })).sort((a, b) => (a.rank ?? Number.POSITIVE_INFINITY) - (b.rank ?? Number.POSITIVE_INFINITY));
            socket.emit('full-standings-data', {
                roundNumber: String(roundNumber),
                roundUsed: String(roundUsed),
                players
            });
        });

        // ── Pairings (Carde-only for now) ──────────────────────────────
        // Fetches one round's matches from Carde via the v2 matches-list
        // endpoint, caches to disk + in-memory, broadcasts the full round
        // payload to every master-control client so a sibling tab opened
        // by a co-operator can repaint without retriggering its own fetch.
        // Failure path emits to the requesting socket only (no point
        // broadcasting an error specific to one operator's click).
        socket.on('fetch-tournament-pairings', async ({ platform, tournamentId, roundId }) => {
            try {
                if (platform && platform !== 'cardeio') {
                    socket.emit('tournament-pairings-fetched', {
                        roundId,
                        success: false,
                        error: 'Pairings fetch is currently only supported for Carde.io. Switch the platform in Global Settings.'
                    });
                    return;
                }
                if (platform || tournamentId) {
                    // Mirror the standings flow — let the operator's most
                    // recent platform/tournament selection win on each click.
                    setPlatformConfig({ platform, tournamentId });
                }

                // Step 1 — always refresh the clicked round. This is the
                // operator's primary intent: "give me the latest matches
                // for round N." Done first so the per-round status line
                // updates immediately instead of waiting on the
                // missing-fill loop.
                const matches = await fetchCardeioPairings(roundId);
                setPairingsForRound(roundId, matches);
                const augmented = augmentMatches(matches, roundId, tournamentId);
                RoomUtils.emitWithRoomMapping(io, 'tournament-pairings-fetched', {
                    roundId,
                    success: true,
                    count: augmented.length,
                    matches: augmented
                });

                // Step 2 — fill in any OTHER rounds that don't have a
                // cached pairings file yet for this event. Saves the
                // operator from clicking Fetch on every round tab when
                // the event is freshly switched or new rounds just
                // unlocked. Errors per round are tracked but don't
                // abort the loop — best-effort fill.
                await fetchMissingPairingsForEvent(io, socket, tournamentId, {
                    skipRound: roundId
                });
            } catch (error) {
                socket.emit('tournament-pairings-fetched', {
                    roundId,
                    success: false,
                    error: error.message
                });
            }
        });


        // Snapshot of every cached round's pairings — fired on master-control
        // page load so the Pairings tab can repaint instantly without
        // refetching. Each round's matches are augmented with:
        //   - pre_round_record (from standings-api cache)
        //   - legend (from cached decklists for the active event)
        // The active event ID comes from platformConfig.tournamentId,
        // which is set when the operator clicks Save in Global Settings.
        // If neither cache is loaded the raw data is sent through and
        // the client falls back to the embedded values.
        socket.on('get-all-pairings', () => {
            const raw = getAllPairingsData();
            const activeEventId = getPlatformConfig()?.tournamentId || null;
            const needsAugment = hasStandingsApiData() || (activeEventId && hasDecklistsForEvent(activeEventId));
            if (!needsAugment) {
                socket.emit('all-pairings-data', { pairingsData: raw });
                return;
            }
            const augmented = {};
            for (const [roundNumber, matches] of Object.entries(raw)) {
                augmented[roundNumber] = augmentMatches(matches, roundNumber, activeEventId);
            }
            socket.emit('all-pairings-data', { pairingsData: augmented });
        });

        // ── Best of Legend ─────────────────────────────────────────────
        // Per-round, per-Legend top-5 leaderboard for the active event
        // (riftbound-only feature). Computed on demand from the cached
        // standings + decklists; reads standings JSON fresh from disk
        // on each request so post-boot Fetch Standings clicks reflect
        // immediately. Sent as a single payload keyed by round number.
        socket.on('get-best-of-legend', async () => {
            try {
                const activeEventId = getPlatformConfig()?.tournamentId || null;
                if (!activeEventId) {
                    socket.emit('best-of-legend-data', { byRound: {}, eventId: null });
                    return;
                }
                if (!hasDecklistsForEvent(activeEventId)) {
                    // No decklists cached for the active event — feature
                    // can't compute Legends without that join. Tell the
                    // client so it can render an "unavailable" state.
                    socket.emit('best-of-legend-data', {
                        byRound: {},
                        eventId: activeEventId,
                        error: 'No cached decklists for the active event. Run Fetch Event Data → Decklists first.'
                    });
                    return;
                }
                const byRound = computeBestOfLegendAllRounds(activeEventId);
                socket.emit('best-of-legend-data', { byRound, eventId: activeEventId });
            } catch (e) {
                console.error('[BoL] computeBestOfLegendAllRounds failed:', e);
                socket.emit('best-of-legend-data', {
                    byRound: {},
                    error: e.message
                });
            }
        });

        // ── Player View ───────────────────────────────────────────────
        // Roster lookup for the Player View tab. Joins the active event's
        // cached registrations (canonical name source) with the cached
        // decklists (legend / champion / battlefield / deck name). Returns
        // a slim per-player payload so the client-side search can filter
        // ~1500 rows without re-fetching. Decklist details are fetched on
        // demand via `get-player-decklist` when the operator picks a row.
        socket.on('get-event-player-roster', async () => {
            try {
                const eventId = getPlatformConfig()?.tournamentId || null;
                if (!eventId) {
                    socket.emit('event-player-roster', { players: [], eventId: null });
                    return;
                }
                const [decklistData, registrations] = await Promise.all([
                    loadCachedDecklist(eventId),
                    loadCachedRegistrations(eventId)
                ]);
                const decklists = decklistData?.decklists || (Array.isArray(decklistData) ? decklistData : []);
                // Build user.id → decklist for quick join
                const dlByUser = new Map();
                for (const dl of decklists) {
                    const uid = dl?.user?.id;
                    if (uid == null) continue;
                    dlByUser.set(Number(uid), dl);
                }

                // Use registrations as the source-of-truth roster (every
                // entrant is listed there, even those who didn't submit
                // a decklist). Players without a registration but with
                // a decklist are still included as a fallback so we
                // don't lose anyone.
                const seen = new Set();
                const players = [];
                if (Array.isArray(registrations)) {
                    for (const reg of registrations) {
                        const uid = reg['User ID'];
                        if (uid == null || uid === '') continue;
                        const uidNum = Number(uid);
                        seen.add(uidNum);
                        const dl = dlByUser.get(uidNum);
                        players.push(slimRosterEntry(uidNum, reg, dl));
                    }
                }
                // Catch any decklist-only entries (no matching reg)
                for (const [uidNum, dl] of dlByUser.entries()) {
                    if (seen.has(uidNum)) continue;
                    players.push(slimRosterEntry(uidNum, null, dl));
                }

                // Sort by display name / real name for consistent order
                players.sort((a, b) => {
                    const an = (a.displayName || a.realName || a.bestIdentifier || '').toLowerCase();
                    const bn = (b.displayName || b.realName || b.bestIdentifier || '').toLowerCase();
                    return an.localeCompare(bn);
                });

                socket.emit('event-player-roster', {
                    eventId,
                    players,
                    decklistCount: dlByUser.size,
                    registrationCount: Array.isArray(registrations) ? registrations.length : 0
                });
            } catch (e) {
                console.error('[PlayerView] roster failed:', e);
                socket.emit('event-player-roster', { players: [], error: e.message });
            }
        });

        // Full decklist for one player in the active event. Returns a
        // slimmed shape (per-card { name, quantity, domains } only —
        // drops Carde card IDs + nested metadata that bloats the
        // payload). Operator gets sub-100KB per decklist this way.
        socket.on('get-player-decklist', async ({ userId } = {}) => {
            try {
                const eventId = getPlatformConfig()?.tournamentId || null;
                if (!eventId) {
                    socket.emit('player-decklist', { error: 'No active event.' });
                    return;
                }
                if (userId == null) {
                    socket.emit('player-decklist', { error: 'Missing userId.' });
                    return;
                }
                const data = await loadCachedDecklist(eventId);
                const decklists = data?.decklists || (Array.isArray(data) ? data : []);
                const uidNum = Number(userId);
                const dl = decklists.find(d => Number(d?.user?.id) === uidNum);
                if (!dl) {
                    socket.emit('player-decklist', {
                        eventId,
                        userId: uidNum,
                        error: 'No decklist cached for this player.'
                    });
                    return;
                }
                socket.emit('player-decklist', {
                    eventId,
                    userId: uidNum,
                    decklist: slimDecklist(dl)
                });
            } catch (e) {
                console.error('[PlayerView] player decklist failed:', e);
                socket.emit('player-decklist', { error: e.message });
            }
        });

        // Fetch and cache Carde decklist export for an event.
        // After writing to disk, ALSO refresh the in-memory
        // `decklistsByEvent` map so downstream consumers (BoL,
        // pairings legend augmentation) see the new event without
        // requiring a server restart. Without the refresh, the
        // in-memory map only reflects what was on disk at server
        // boot — fetching a new event mid-session would leave BoL
        // stuck on "No cached decklists" forever. The reload is
        // O(N) over cache files (handful, so trivial overhead).
        socket.on('fetch-cardeio-decklists', async ({ eventId }) => {
            try {
                const data = await fetchCardeioDecklist(eventId);
                const count = data?.decklists?.length || 0;
                await loadAllCachedDecklists();
                socket.emit('cardeio-decklists-fetched', { success: true, count });
            } catch (error) {
                const msg = error.response?.status === 401
                    ? 'Authentication failed — CARDEIO_TOKEN may be expired. Update .env and restart.'
                    : error.message;
                socket.emit('cardeio-decklists-fetched', { success: false, error: msg });
            }
        });

        // Fetch and cache Carde registrations CSV for an event
        socket.on('fetch-cardeio-registrations', async ({ eventId, gameSlug }) => {
            try {
                const result = await fetchCardeioRegistrations(eventId, gameSlug);
                socket.emit('cardeio-registrations-fetched', { success: true, count: result.count });
            } catch (error) {
                const msg = error.response?.status === 401
                    ? 'Authentication failed — CARDEIO_TOKEN/SESSION may be expired. Update .env and restart.'
                    : error.message;
                socket.emit('cardeio-registrations-fetched', { success: false, error: msg });
            }
        });

        // Fetch Carde round data (CSV pairings/standings + match API) by round ID
        socket.on('fetch-cardeio-round', async ({ roundId, roundNumber }) => {
            try {
                // Fetch CSV and match API in parallel — await both before responding
                const [results] = await Promise.all([
                    fetchCardeioRoundData(roundId, roundNumber),
                    fetchSpicerackMatches(roundId, roundNumber)
                        .then(r => { console.log(`[Carde] Match API fetch: ${r.count} matches`); return r; })
                        .catch(e => { console.warn(`[Carde] Match API fetch failed: ${e.message}`); return null; })
                ]);
                socket.emit('cardeio-round-fetched', results);
            } catch (error) {
                socket.emit('cardeio-round-fetched', {
                    matches: { success: false, error: error.message },
                    standings: { success: false, error: error.message }
                });
            }
        });

        // Manually fetch Spicerack match API data for a round
        socket.on('fetch-spicerack-matches', async ({ roundId, roundNumber }) => {
            try {
                const result = await fetchSpicerackMatches(roundId, roundNumber);
                socket.emit('spicerack-matches-fetched', result);
            } catch (error) {
                socket.emit('spicerack-matches-fetched', { success: false, error: error.message });
            }
        });

        // Fetch event detail to get round number → round ID mapping
        socket.on('fetch-cardeio-event-detail', async ({ eventId }) => {
            try {
                const roundMap = await fetchCardeioEventDetail(eventId);
                socket.emit('cardeio-event-detail-fetched', { success: true, roundMap });
            } catch (error) {
                socket.emit('cardeio-event-detail-fetched', { success: false, error: error.message });
            }
        });

        // Fetch match data by table number
        socket.on('fetch-match-by-table', async ({ tournamentId, roundNumber, tableNumber, platform }) => {
            try {
                const matchData = await fetchMatchByTable(tournamentId, roundNumber, tableNumber, platform);
                socket.emit('match-by-table-fetched', { matchData });
            } catch (error) {
                socket.emit('match-by-table-fetched', { error: error.message });
            }
        });

        // Fetch a single decklist by ID and parse it into categorized card lists
        socket.on('fetch-decklist-by-id', async ({ decklistId, side, matchId, roundId, game }) => {
            try {
                const raw = await fetchMeleeDecklist(decklistId);
                const parsed = parseMeleeDecklist(raw, game || 'starwars');

                // SWU-specific: enrich leader/base with aspects and HP from local card data
                if (game === 'starwars' || !game) {
                    if (parsed.leader) {
                        const cardInfo = lookupCardByName(parsed.leader.name);
                        if (cardInfo) {
                            parsed.leader.aspects = cardInfo.aspects;
                        }
                    }
                    if (parsed.base) {
                        const cardInfo = lookupCardByName(parsed.base.name);
                        if (cardInfo) {
                            parsed.base.aspects = cardInfo.aspects;
                            parsed.base.hp = cardInfo.hp;
                        }
                    }
                }

                socket.emit('decklist-fetched', { side, matchId, roundId, game: game || 'starwars', ...parsed });
            } catch (error) {
                socket.emit('decklist-fetched', { side, matchId, roundId, error: error.message });
            }
        });

        // Lookup SWU card info (aspects, HP) by name
        socket.on('lookup-swu-card', ({ name }, callback) => {
            const info = lookupCardByName(name);
            if (typeof callback === 'function') {
                callback(info);
            }
        });

        // Fetch all decklists for a tournament (for debugging/exploration)
        socket.on('fetch-decklists', async ({ tournamentId }) => {
            try {
                const decklists = await fetchMeleeDecklists(tournamentId);
                socket.emit('decklists-fetched', { decklists });
            } catch (error) {
                socket.emit('decklists-fetched', { error: error.message });
            }
        });

        // Fetch pairings for a round (for debugging/exploration)
        socket.on('fetch-pairings', async ({ tournamentId, roundNumber }) => {
            try {
                const pairings = await fetchMeleePairings(tournamentId, roundNumber);
                socket.emit('pairings-fetched', { pairings });
            } catch (error) {
                socket.emit('pairings-fetched', { error: error.message });
            }
        });

        // Disconnect
        socket.on('disconnect', () => {
            console.log('User disconnected:', socket.id);
        });
    });
}
