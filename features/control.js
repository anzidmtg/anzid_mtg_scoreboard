import {promises as fs} from 'fs';
import {controlDataPath, DEFAULT_GAME_SELECTION, setGameSelection, getGameSelection, getVendorSelection, setVendorSelection, getPlayerCount, setPlayerCount, getSideboardVisible, setSideboardVisible, getScoreboardDecklistsVisible, setScoreboardDecklistsVisible} from '../config/constants.js';
import {getSortedArchetypes} from './archetypes.js';
import {emitBroadcastStandings} from "./standings.js";
import { RoomUtils } from '../utils/room-utils.js';
import { transformAndEmitAllDecks } from './transformAllDecks.js';

let controlData = {};
let controlsTracker = {
    '1': {round_id: '1', match_id: 'match1'},
    '2': {round_id: '1', match_id: 'match2'},
    '3': {round_id: '1', match_id: 'match3'},
    '4': {round_id: '1', match_id: 'match4'}
};
let broadcastTracker = {
    round_id: null
};

// Write lock to prevent concurrent file writes that corrupt JSON
let isWriting = false;
let pendingWrite = false;

// make scoreboard state tracker - wins show/hide for now - can take other things later
let scoreboardState = Object.fromEntries(Array.from({length: 20}, (_, i) => [i + 1, {
    match1: {showWins: true},
    match2: {showWins: true},
    match3: {showWins: true},
    match4: {showWins: true}
}]));

// Visibility flags for the /scoreboard L3 battlefields row (.riftbound-bf-row
// — see scoreboard.js / scoreboard.css). The strip shows up to four
// battlefield cards (one per 2v2 player slot) cropped into the lower-third;
// the operator can hide individual ones via inline master-control "Hide"
// checkboxes without touching match data. Slot keys mirror the
// `player-battlefield-*` fields in controlData so the renderer can index
// into both with the same key. Default: all visible. Resets on server
// restart — intentional; the operator usually wants a fresh "everything
// visible" state per stream.
let battlefieldVisibility = {
    'left':    true,
    'left-2':  true,
    'right':   true,
    'right-2': true
};

// Which Live scoreboards have been sent this server's data since it booted.
// After a restart the OBS pages rejoin their rooms but go on showing the old
// show until the server next pushes to them, so until then the server's state
// is not what's on screen. The chat bot's !decklists relies on this: it must
// never describe a match that isn't what viewers are looking at.
const scoreboardsPushedSinceBoot = new Set();
export function noteScoreboardPushed(control_id) { scoreboardsPushedSinceBoot.add(String(control_id)); }
export function isScoreboardInSync(control_id) { return scoreboardsPushedSinceBoot.has(String(control_id)); }


// Load control data from file
export async function loadControlData() {
    try {
        const data = await fs.readFile(controlDataPath, 'utf8');
        controlData = JSON.parse(data);
        console.log('Control data loaded.');
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('No control data found. Starting fresh.');
            controlData = {};
        } else {
            console.error('Error loading control data:', error);
            controlData = {};
        }
    }
}

// Save control data to file with write lock to prevent concurrent writes
export async function saveControlData() {
    if (isWriting) {
        pendingWrite = true;
        return;
    }

    isWriting = true;
    try {
        await fs.writeFile(controlDataPath, JSON.stringify(controlData, null, 2));
        // console.log('Control data saved.');
    } catch (error) {
        console.error('Error saving control data:', error);
    } finally {
        isWriting = false;
        if (pendingWrite) {
            pendingWrite = false;
            await saveControlData();
        }
    }
}

// Get trackers
export function getControlData() {
    return controlData;
}

export function getControlsTracker() {
    return controlsTracker;
}

export function getBroadcastTracker() {
    return broadcastTracker;
}

export function getScoreboardState() {
    return scoreboardState;
}

export function updateBroadcastTracker(round_id) {
    broadcastTracker.round_id = round_id;
}

// Returns a shallow copy so callers can't mutate the live state by reference.
// Commentator L3 remote-mode flag (ephemeral, like battlefield visibility).
// in-person (false) = classic bottom row; remote (true) = per-segment layout.
let commL3Remote = false;
export function getCommL3Remote() { return commL3Remote; }

// Commentator L3 visibility — server-held so master control, Companion and
// every L3 page agree, and so a Stream Deck button can light up. The 5s
// auto-hide that used to live in the L3 page runs HERE now: the page just
// follows comm-l3-visible-updated, so one press shows on every L3 source and
// they all hide together. In-memory; hidden after restart.
const COMM_L3_AUTO_HIDE_MS = 5000;
let commL3Visible = false;
let commL3HideTimer = null;
export function getCommL3Visible() { return commL3Visible; }
export function emitCommL3Visible(io) {
    io.emit('comm-l3-visible-updated', { visible: commL3Visible });
}
export function setCommL3Visible(visible, io) {
    if (commL3HideTimer) { clearTimeout(commL3HideTimer); commL3HideTimer = null; }
    commL3Visible = !!visible;
    if (commL3Visible) {
        commL3HideTimer = setTimeout(() => {
            commL3HideTimer = null;
            commL3Visible = false;
            emitCommL3Visible(io);
        }, COMM_L3_AUTO_HIDE_MS);
    }
    emitCommL3Visible(io);
}
export function toggleCommL3(io) { setCommL3Visible(!commL3Visible, io); }
export function setCommL3Remote(v) { commL3Remote = !!v; }

export function getBattlefieldVisibility() {
    return { ...battlefieldVisibility };
}

// Returns true when the requested slot exists and a write actually changed
// the state — lets the handler skip a redundant broadcast when the value
// is unchanged. Unknown slot keys are silently rejected (defensive against
// stale clients sending old field names).
export function setBattlefieldVisibilitySlot(slot, visible) {
    if (!(slot in battlefieldVisibility)) return false;
    const next = !!visible;
    if (battlefieldVisibility[slot] === next) return false;
    battlefieldVisibility[slot] = next;
    return true;
}

// Emit control data update - master-control listening to update matches
export function emitControlData(io) {
    RoomUtils.emitWithRoomMapping(io, 'control-data-updated', controlData);
}

// Update server with control data from control - goes to scoreboard / master-control
export async function updateFromControl(round_id, match_id, newState, io) {
    if (!controlData[round_id]) controlData[round_id] = {};
    controlData[round_id][match_id] = newState;
    await saveControlData();

    Object.entries(controlsTracker).forEach(([control_id, control]) => {
        if (control.round_id === round_id && control.match_id === match_id) {
            noteScoreboardPushed(control_id);
            RoomUtils.emitToRoom(io, `scoreboard-${control_id}`, `scoreboard-${control_id}-saved-state`, {
                data: controlData[round_id][match_id],
                round_id,
                match_id,
                archetypeList: getSortedArchetypes()
            });
        }
    });
    // send update to master-control
    emitControlData(io);
}

// Fields the server wrote itself (updateFieldsFromServer), kept until master
// control shows it has them. Master sends its whole copy of every match on each
// edit, so a copy sent before it heard about a server write would put the old
// value straight back. Its copy carries the _timestamps it has seen: once a
// field's is at least the server write's, master has caught up.
//   "<round>|<match>" -> Map(field -> timestamp)
const serverWrites = new Map();
const serverWriteKey = (round_id, match_id) => `${round_id}|${match_id}`;

// NEW: Update a single field from control - granular updates
// Several fields at once, set by the server itself (the chat bot's !p1/!p2
// loading a Piltover deck). Same effect as a master-control edit: stored,
// master-control told field by field (it keeps its own copy of every match and
// sends all of it back on its next edit), and control pages + scoreboards
// pushed the new state — but one save and one push, not one per field.
export async function updateFieldsFromServer(round_id, match_id, fields, io) {
    if (!controlData[round_id]) controlData[round_id] = {};
    if (!controlData[round_id][match_id]) controlData[round_id][match_id] = {};
    const match = controlData[round_id][match_id];
    if (!match._timestamps) match._timestamps = {};
    const key = serverWriteKey(round_id, match_id);
    if (!serverWrites.has(key)) serverWrites.set(key, new Map());
    const now = Date.now();
    for (const [field, value] of Object.entries(fields)) {
        // Newer than anything stored: timestamps come from clients' clocks too,
        // and one running ahead of the server's must not make this lose the
        // "only if newer" check here or in master-control.
        const timestamp = Math.max(now, (match._timestamps[field] || 0) + 1);
        match[field] = value;
        match._timestamps[field] = timestamp;
        serverWrites.get(key).set(field, timestamp);
        // Before the save, so master control hears as early as possible.
        RoomUtils.emitWithRoomMapping(io, 'field-updated', { round_id, match_id, field, value, timestamp });
    }
    await saveControlData();
    // Read the match again: a master-control update during the save replaces
    // the object, and what goes on air must be what the server now holds.
    const data = controlData[round_id]?.[match_id] || {};
    Object.entries(controlsTracker).forEach(([control_id, ctrl]) => {
        if (ctrl.round_id !== round_id || ctrl.match_id !== match_id) return;
        const payload = { data, round_id, match_id, archetypeList: getSortedArchetypes() };
        RoomUtils.emitToRoom(io, `control-${control_id}`, `control-${control_id}-saved-state`, payload);
        noteScoreboardPushed(control_id);
        RoomUtils.emitToRoom(io, `scoreboard-${control_id}`, `scoreboard-${control_id}-saved-state`, payload);
    });
}

export async function updateFieldFromControl(round_id, match_id, field, value, timestamp, io) {
    if (!controlData[round_id]) controlData[round_id] = {};
    if (!controlData[round_id][match_id]) controlData[round_id][match_id] = {};
    if (!controlData[round_id][match_id]._timestamps) {
        controlData[round_id][match_id]._timestamps = {};
    }
    
    // Conflict resolution: only update if newer timestamp
    const currentTimestamp = controlData[round_id][match_id]._timestamps[field] || 0;
    if (timestamp > currentTimestamp) {
        controlData[round_id][match_id][field] = value;
        controlData[round_id][match_id]._timestamps[field] = timestamp;
        await saveControlData();
        
        // Emit granular update to master-control
        RoomUtils.emitWithRoomMapping(io, 'field-updated', {
            round_id,
            match_id,
            field,
            value,
            timestamp
        });

        // Also emit full state to scoreboard(s) tracking this round/match
        Object.entries(controlsTracker).forEach(([control_id, control]) => {
            if (control.round_id === round_id && control.match_id === match_id) {
                noteScoreboardPushed(control_id);
                RoomUtils.emitToRoom(io, `scoreboard-${control_id}`, `scoreboard-${control_id}-saved-state`, {
                    data: controlData[round_id][match_id],
                    round_id,
                    match_id,
                    archetypeList: getSortedArchetypes()
                });
            }
        });
    }
}

// Emit a control's saved state - called by scoreboard
export function emitSavedStateForControl(control_id, io) {
    let {round_id = '1', match_id = 'match1'} = controlsTracker[control_id] || {};
    if (!controlsTracker[control_id]) {
        controlsTracker[control_id] = {round_id, match_id};
    }

    RoomUtils.emitToRoom(io, `control-${control_id}`, `control-${control_id}-saved-state`, {
        data: controlData[round_id]?.[match_id] || {},
        round_id,
        match_id,
        archetypeList: getSortedArchetypes()
    });
    noteScoreboardPushed(control_id);
    RoomUtils.emitToRoom(io, `scoreboard-${control_id}`, `scoreboard-${control_id}-saved-state`, {
        data: controlData[round_id]?.[match_id] || {},
        round_id,
        match_id,
        archetypeList: getSortedArchetypes()
    });
}

// Update control mapping
export function updateControlMapping(controlId, round_id, match_id, io) {
    controlsTracker[controlId] = {round_id, match_id};

    RoomUtils.emitToRoom(io, `control-${controlId}`, `control-${controlId}-saved-state`, {
        data: controlData[round_id]?.[match_id] || {},
        round_id,
        match_id,
        archetypeList: getSortedArchetypes()
    });
    noteScoreboardPushed(controlId);
    RoomUtils.emitToRoom(io, `scoreboard-${controlId}`, `scoreboard-${controlId}-saved-state`, {
        data: controlData[round_id]?.[match_id] || {},
        round_id,
        match_id,
        archetypeList: getSortedArchetypes()
    });
    // Anything that addresses a slot rather than a round/match — the Companion
    // module's slot buttons, master control's own pills — needs the new
    // mapping. Without this the trackers only ever go out on request, so a
    // remap mid-show left those clients acting on the previous match.
    emitControlTrackers(io);
}

// Emit control & broadcast trackers
export function emitControlTrackers(io) {
    RoomUtils.emitWithRoomMapping(io, 'control-broadcast-trackers', {
        broadcastTracker,
        controlsTracker
    });
}

// Emit a full update from master control - goes to control / scoreboard
export async function updateFromMaster(allControlData, io) {
    // Fields this merge kept the server's value for (see serverWrites).
    const overridden = [];
    // Merge incoming data with existing data to preserve draft list fields
    Object.entries(allControlData).forEach(([round_id, roundData]) => {
        if (isNaN(round_id)) return; // Skip non-round keys like "draftLists"
        if (!controlData[round_id]) controlData[round_id] = {};
        Object.entries(roundData).forEach(([match_id, matchData]) => {
            if (!controlData[round_id][match_id]) controlData[round_id][match_id] = {};
            // Preserve existing draft list fields
            const existingDraftListLeft = controlData[round_id][match_id]['player-draft-list-left'];
            const existingDraftListRight = controlData[round_id][match_id]['player-draft-list-right'];
            // Merge new data
            const existing = controlData[round_id][match_id];
            const merged = { ...existing, ...matchData };
            // A field the server wrote that this copy predates keeps the
            // server's value (see serverWrites).
            const key = serverWriteKey(round_id, match_id);
            const written = serverWrites.get(key);
            if (written && matchData && typeof matchData === 'object') {
                const seen = matchData._timestamps || {};
                for (const [field, ts] of written) {
                    if ((seen[field] || 0) >= ts) { written.delete(field); continue; }
                    if (!(field in matchData)) continue;
                    const kept = existing._timestamps?.[field] ?? ts;
                    merged[field] = existing[field];
                    merged._timestamps = { ...(merged._timestamps || {}), [field]: kept };
                    overridden.push({ round_id, match_id, field, value: existing[field], timestamp: kept });
                }
                if (!written.size) serverWrites.delete(key);
            }
            controlData[round_id][match_id] = merged;
            // Restore draft list fields if they existed and weren't in incoming data
            if (existingDraftListLeft && !matchData['player-draft-list-left']) {
                controlData[round_id][match_id]['player-draft-list-left'] = existingDraftListLeft;
            }
            if (existingDraftListRight && !matchData['player-draft-list-right']) {
                controlData[round_id][match_id]['player-draft-list-right'] = existingDraftListRight;
            }
        });
    });
    // Master control is holding a value the server has just refused. Send back
    // what was kept so its screen corrects itself rather than silently
    // disagreeing with the scoreboard — and so the copy it sends next carries
    // the right timestamp, which lets the guard go.
    overridden.forEach(p => RoomUtils.emitWithRoomMapping(io, 'field-updated', p));
    await saveControlData();

    Object.entries(allControlData).forEach(([round_id, roundData]) => {
        if (isNaN(round_id)) return; // Skip non-round keys like "draftLists"
        Object.entries(roundData).forEach(([match_id]) => {
            Object.entries(controlsTracker).forEach(([control_id, ctrl]) => {
                if (ctrl.round_id === round_id && ctrl.match_id === match_id) {
                    // Use merged controlData (not incoming data) to avoid async race condition
                    // where saveControlData delay causes stale data to be emitted last
                    const mergedData = controlData[round_id]?.[match_id] || {};
                    RoomUtils.emitToRoom(io, `control-${control_id}`, `control-${control_id}-saved-state`, {
                        data: mergedData,
                        round_id,
                        match_id,
                        archetypeList: getSortedArchetypes()
                    });
                    noteScoreboardPushed(control_id);
                    RoomUtils.emitToRoom(io, `scoreboard-${control_id}`, `scoreboard-${control_id}-saved-state`, {
                        data: mergedData,
                        round_id,
                        match_id,
                        archetypeList: getSortedArchetypes()
                    });
                }
            });
        });
        // NOTE: broadcast-round-data is intentionally NOT re-emitted here.
        // The broadcast scoreboard is a replay view for fixing typos / making
        // corrections to a past round — it must ONLY update when the operator
        // clicks the Broadcast button (see broadcast-requested handler in
        // sockets/handlers.js). For live matches, the non-broadcast URL
        // /scoreboard/matchN is the live view and is updated via the
        // scoreboard-{N}-saved-state emission above.
    });
}

// emit scoreboardState
export function emitScoreboardState(io) {
    RoomUtils.emitWithRoomMapping(io, 'scoreboard-state-data', {scoreboardState});
}

// update scoreboard states from incoming data
export function updateScoreboardSate(io, round_id, match_id, action, value) {
    // console.log(round_id, match_id, action, value);
    if (action === 'showWins') {
        if (!scoreboardState[round_id]) {
            scoreboardState[round_id] = { match1: {showWins: true}, match2: {showWins: true}, match3: {showWins: true}, match4: {showWins: true} };
        }
        scoreboardState[round_id][match_id]['showWins'] = value;
        // emit updated scoreboard state
        emitScoreboardState(io);
    }
}

// game selection handlers
export function emitCurrentGameSelection(io) {
    RoomUtils.emitWithRoomMapping(io, 'server-current-game-selection', {gameSelection: getGameSelection()})
}

export function emitUpdatedGameSelection(io) {
    RoomUtils.emitWithRoomMapping(io, 'game-selection-updated', {gameSelection: getGameSelection()})
}

export function updateGameSelection(gameSelection, io) {
    setGameSelection(gameSelection);
    emitUpdatedGameSelection(io);
}

// vendor selection handlers
export function emitCurrentVendorSelection(io) {
    RoomUtils.emitWithRoomMapping(io, 'server-current-vendor-selection', {vendorSelection: getVendorSelection()})
}

export function emitUpdatedVendorSelection(io) {
    RoomUtils.emitWithRoomMapping(io, 'vendor-selection-updated', {vendorSelection: getVendorSelection()})
}

export function updateVendorSelection(vendorSelection, io) {
    setVendorSelection(vendorSelection);
    emitUpdatedVendorSelection(io);
}

// player count handlers
export function emitCurrentPlayerCount(io) {
    RoomUtils.emitWithRoomMapping(io, 'server-current-player-count', {playerCount: getPlayerCount()})
}

export function emitUpdatedPlayerCount(io) {
    RoomUtils.emitWithRoomMapping(io, 'player-count-updated', {playerCount: getPlayerCount()})
}

export function updatePlayerCount(playerCount, io) {
    setPlayerCount(playerCount);
    emitUpdatedPlayerCount(io);
}

// sideboard-visible handlers (global show/hide of the decklist sideboard)
export function emitCurrentSideboardVisible(io) {
    RoomUtils.emitWithRoomMapping(io, 'server-current-sideboard-visible', {sideboardVisible: getSideboardVisible()})
}

export function emitUpdatedSideboardVisible(io) {
    RoomUtils.emitWithRoomMapping(io, 'sideboard-visible-updated', {sideboardVisible: getSideboardVisible()})
}

export function updateSideboardVisible(sideboardVisible, io) {
    setSideboardVisible(sideboardVisible);
    emitUpdatedSideboardVisible(io);
}

// Scoreboard decklists toggle. Unmapped event → global, so every scoreboard
// page (broadcast and live modes) and every master-control tab hears it.
export function emitUpdatedScoreboardDecklistsVisible(io) {
    RoomUtils.emitWithRoomMapping(io, 'scoreboard-decklists-visible-updated', {scoreboardDecklistsVisible: getScoreboardDecklistsVisible()});
}
export function updateScoreboardDecklistsVisible(visible, io) {
    setScoreboardDecklistsVisible(visible);
    emitUpdatedScoreboardDecklistsVisible(io);
}


