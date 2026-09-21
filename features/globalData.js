import {getControlData, emitControlData, saveControlData, getControlsTracker, noteScoreboardPushed} from './control.js';
import {getSortedArchetypes} from './archetypes.js';
import {DEFAULT_INITIAL_TIME, getInitialTime, setInitialTime} from "../config/constants.js";
import { RoomUtils } from '../utils/room-utils.js';

let globalMatchData = {
    'global-commentator-1': null,
    'global-commentator-1-subtext': null,
    'global-commentator-2': null,
    'global-commentator-2-subtext': null,
    'global-commentator-3': null,
    'global-commentator-3-subtext': null,
    'global-commentator-4': null,
    'global-commentator-4-subtext': null,
    'global-event-name': 'Event',
    'global-event-format': 'Format',
    'global-event-miscellaneous-details': null,
    'global-event-base-life-points': '20',
    'global-event-base-timer': '50',
    'global-event-number-of-rounds': '15'
};

// Get current global data
export function getGlobalMatchData() {
    return globalMatchData;
}

export function getInitialTimer() {
    return DEFAULT_INITIAL_TIME;
}

// Emit global data
export function emitGlobalMatchData(io) {
    RoomUtils.emitWithRoomMapping(io, 'update-match-global-data', {globalData: globalMatchData});
}

// Update commentator data and broadcast it
export function updateCommentators(commentatorData, io) {
    Object.entries(commentatorData).forEach(([key, val]) => {
        if (key in globalMatchData) globalMatchData[key] = val;
    });
    emitGlobalMatchData(io);
}

export function updateBaseTimerDefault(eventInfo, timerState) {
    // Update DEFAULT_INITIAL_TIME if base timer changed
    const baseMinutes = parseInt(eventInfo['global-event-base-timer']);
    if (!isNaN(baseMinutes) && baseMinutes * 60 * 1000 !== DEFAULT_INITIAL_TIME) {

        const newInitialTime = baseMinutes * 60 * 1000;
        setInitialTime(newInitialTime);

        // Update non-running timers with new DEFAULT_INITIAL_TIME
        Object.entries(timerState).forEach(([round_id, roundMatches]) => {
            Object.entries(roundMatches).forEach(([match_id, timer]) => {
                if (timer.status !== 'running') {
                    timer.time = newInitialTime;
                }
            });
        });
    }
}

// Update event info (event name, format, base timer), sync with control data
export async function updateEventInformation(eventInfo, io, timerState) {
    // Update global object
    Object.entries(eventInfo).forEach(([key, val]) => {
        if (key in globalMatchData) globalMatchData[key] = val;
    });

    // emit global event data update
    emitGlobalMatchData(io);

    // Update control data (event-name and event-format) per match
    const controlData = getControlData();

    const numberOfRounds = eventInfo['global-event-number-of-rounds'] || globalMatchData['global-event-number-of-rounds'] || '15';

    Object.entries(controlData).forEach(([round_id, roundData]) => {
        if (isNaN(round_id)) return; // Skip non-round keys like "draftLists"
        // round_id is already the round number (e.g., "1", "2", etc.)
        const eventRoundText = `Round ${round_id} of ${numberOfRounds}`;

        Object.entries(roundData).forEach(([match_id, matchData]) => {
            if ('event-name' in matchData)
                matchData['event-name'] = eventInfo['global-event-name'] || matchData['event-name'];
            if ('event-format' in matchData)
                matchData['event-format'] = eventInfo['global-event-format'] || matchData['event-format'];
            // Auto-populate event-round
            matchData['event-round'] = eventRoundText;

            // Emit updated match data
            // Read controlsTracker from its source of truth (control.js).
            // Previously read `timerState.controlsTracker` which does not
            // exist on the timer-state object — so this loop never iterated
            // and the per-slot saved-state emits below never fired, making
            // live scoreboards miss event-info updates until next page load.
            Object.entries(getControlsTracker()).forEach(([control_id, ctrl]) => {
                if (ctrl.round_id === round_id && ctrl.match_id === match_id) {
                    RoomUtils.emitToRoom(io, `control-${control_id}`, `control-${control_id}-saved-state`, {
                        data: matchData,
                        round_id,
                        match_id,
                        archetypeList: getSortedArchetypes()
                    });
                    noteScoreboardPushed(control_id);
                    RoomUtils.emitToRoom(io, `scoreboard-${control_id}`, `scoreboard-${control_id}-saved-state`, {
                        data: matchData,
                        round_id,
                        match_id,
                        archetypeList: getSortedArchetypes()
                    });
                }
            });
        });
    });

    // Update DEFAULT_INITIAL_TIME if base timer changed
    updateBaseTimerDefault(eventInfo, timerState);

    await saveControlData();
    emitControlData(io);
}

