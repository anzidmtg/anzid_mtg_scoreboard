import OBSWebSocket from 'obs-websocket-js';
import { RoomUtils } from '../utils/room-utils.js';
import { getGameSelection, getVendorSelection, getPlayerCount } from '../config/constants.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRESETS_DIR = path.join(__dirname, '..', 'data', 'obs exports');
const BACKUPS_DIR = path.join(PRESETS_DIR, 'backups');
const LOGS_DIR = path.join(PRESETS_DIR, 'logs');

let _logStream = null;

function startLog(action, configName) {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    const now = new Date();
    const timestamp = now.getFullYear().toString() + String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0') + '-' + String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0') + String(now.getSeconds()).padStart(2,'0');
    const logPath = path.join(LOGS_DIR, `${timestamp}_${action}_${configName}.txt`);
    _logStream = logPath;
    fs.writeFileSync(logPath, '');
}

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    if (_logStream) fs.appendFileSync(_logStream, line + '\n');
}

const OBS_WS_URL = 'ws://localhost:4455';
const OBS_WS_PASSWORD = 'RRWtUPVpGf6myRvx';
const RECONNECT_INTERVAL = 5000;

// Scene name mappings. Note: Metagame intentionally lives OUTSIDE the
// "Event Slides - *" group — operator's OBS uses the full stinger transition
// into Metagame (rather than the fast inter-Event-Slides crossfade). The
// entrance delay is now read live from that transition (computeScheduleDelay),
// so it tracks whatever stinger is configured — no fixed per-scene number.
const METAGAME_SCENE = 'Metagame - Current Round';
const BRACKET_SCENE = 'Bracket - Top 8';
const SCHEDULE_SCENE = 'Event Slides - Schedule';
// Scene names use generic "P1/P2/P3/P4" suffixes (renamed from
// "1-16"/"17-32"/etc.) because the rank-per-page count is now vendor-
// aware on the display side: default vendor 1v1 (CSL Bologna) shows
// 10 ranks per page (P1=1-10, P2=11-20, P3=21-30, P4=31-40); every
// other vendor/playerCount keeps the legacy 16 per page (P1=1-16,
// P2=17-32, P3=33-48, P4=49-64). Naming by page number avoids having
// to maintain two scene-name sets in OBS.
const STANDINGS_SCENE_MAP = {
    'Standings - Current Round P1': 1,
    'Standings - Current Round P2': 2,
    'Standings - Current Round P3': 3,
    'Standings - Current Round P4': 4,
};

let obs = null;
let io = null;
let reconnectTimer = null;
let wasOnStandings = false;
let lastProgramScene = null;

// What OBS has on program right now, for anything that needs to know what
// viewers are watching (the chat bot's !decklists). Kept apart from
// lastProgramScene on purpose: that one drives the stinger and animation
// timing and must only move on a real scene change, whereas this is also read
// at connect and cleared when the link drops. null = not known.
let currentProgramScene = null;
export function getCurrentProgramScene() { return currentProgramScene; }

// Standings leave-reset delay (off-screen, ms). Kept fixed on purpose — it's
// about when to reset the standings data AFTER cutting away, not an entrance.
const STANDINGS_DELAY = 2000;
// NOTE: metagame, bracket, and decklist entrance delays are no longer fixed
// constants. They all run through computeScheduleDelay(transitionInfo) — the
// same live-transition-aware path the schedule uses — so they auto-adapt to the
// stinger with zero hand-tuning. The single stinger knob is SCHEDULE_STINGER_OFFSET
// (the stinger's visual tail past transition_point); transition_point itself is
// read live from OBS per cut.
// Schedule scene — delay before the entrance animation fires. Computed
// per-transition based on what OBS reports for the transition that
// just started. Three cases (computeScheduleDelay below):
//
//   - cut_transition         → 0ms.
//                              The cut is instant; the schedule scene
//                              is onscreen the moment SceneTransition-
//                              Started fires, so any delay would leave
//                              the data layer hidden for that long.
//
//   - obs_stinger_transition → transition_point + SCHEDULE_STINGER_OFFSET.
//                              transition_point is OBS's mark for when
//                              the new scene starts rendering. Most
//                              stinger videos continue animating past
//                              that point (the new scene is visually
//                              obscured by the stinger overlay until
//                              the stinger video ends), so the
//                              entrance animation should fire AFTER
//                              the stinger video finishes its visual
//                              animation. The offset is the gap
//                              between transition_point and the visual
//                              end-of-stinger — empirically ~1300ms
//                              for the operator's flyquest stinger
//                              (transition_point=1000, visually-done
//                              ~2300ms).
//
//   - fade/swipe/slide/move  → transitionDuration.
//                              These transitions don't have a separate
//                              "new-scene-visible" mark — duration IS
//                              when the new scene is fully revealed.
//
// SCHEDULE_DELAY_FALLBACK covers the case where the transition info
// query fails (rare — only if OBS WS goes weird mid-transition).
const SCHEDULE_STINGER_OFFSET = 1300;
const SCHEDULE_DELAY_FALLBACK = 2300;

// Pending animation timer for the schedule scene — if the operator
// transitions THROUGH schedule faster than SCHEDULE_DELAY (e.g. fat-
// finger TO schedule then immediately AWAY), the queued emit would fire
// on a scene that's no longer current. Cancelling on every scene change
// keeps the emit aligned with the program scene actually visible at
// the SCHEDULE_DELAY mark.
let scheduleAnimateTimer = null;

// Schedule leave-emit delay (ms) — gap between the operator starting a
// transition AWAY from the schedule scene and the display page resetting
// the data layer to its hidden default. Lets the data layer remain
// onscreen for the first SCHEDULE_LEAVE_DELAY ms of the transition out
// (so the operator sees the schedule scene briefly during the stinger
// fade-out before the data layer disappears, rather than blinking off
// the moment the transition starts). Paired with `scheduleLeaveTimer`
// cancellation so a fast Schedule → Other → Schedule round-trip
// doesn't accidentally reset the data after the operator has already
// cut back.
const SCHEDULE_LEAVE_DELAY = 400;
let scheduleLeaveTimer = null;

// Decklist entrance emit timer — cancelled on every scene change (like the
// schedule timer) so rapid cuts between decklist scenes (e.g. Match 1 Red →
// Match 1 Blue) only fire the latest one, never a stale emit on a scene
// that's no longer in program.
let deckAnimateTimer = null;

// Compute the schedule entrance-animation delay from the transition
// info that OBS reports. transitionInfo shape:
//   { transitionName, transitionKind, transitionDuration, transitionSettings }
// (matches GetCurrentSceneTransition's response).
//
// Stingers can express transition_point in either time (ms) or frame
// count via tp_type (0 = time, 1 = frame). For frame-based, we'd
// strictly need the project FPS to convert; in practice the operator
// uses time-based, but we read GetVideoSettings.fpsNumerator /
// fpsDenominator if available, falling back to 60fps if not.
function computeScheduleDelay(transitionInfo, videoFps = 60) {
    if (!transitionInfo) return SCHEDULE_DELAY_FALLBACK;
    const { transitionKind, transitionDuration, transitionSettings } = transitionInfo;
    if (transitionKind === 'cut_transition') return 0;
    if (transitionKind === 'obs_stinger_transition') {
        const s = transitionSettings ?? {};
        // Per-scene transition overrides don't expose the stinger's settings
        // (transition_point) via the API — only its duration. When there's no
        // transition_point, fall back to the configured duration (fire when the
        // stinger completes).
        const hasTp = s.tp_type === 1 ? (s.transition_point_frame != null) : (s.transition_point != null);
        if (!hasTp) return transitionDuration ?? SCHEDULE_DELAY_FALLBACK;
        let tp;
        if (s.tp_type === 1) {
            const frames = s.transition_point_frame ?? 0;
            tp = Math.round((frames / videoFps) * 1000);
        } else {
            tp = s.transition_point ?? 0;
        }
        return tp + SCHEDULE_STINGER_OFFSET;
    }
    // fade/swipe/slide/move/etc — use the transition's configured duration.
    return transitionDuration ?? SCHEDULE_DELAY_FALLBACK;
}

// Same idea for the leave timer. Cuts have no stinger video to keep
// the data layer onscreen during, so reset immediately. For any other
// transition (stinger/fade/swipe), keep the data visible for
// SCHEDULE_LEAVE_DELAY before resetting so the operator sees the
// schedule scene briefly during the transition out.
function computeScheduleLeaveDelay(transitionInfo) {
    if (transitionInfo?.transitionKind === 'cut_transition') return 0;
    return SCHEDULE_LEAVE_DELAY;
}

// Cached video framerate (OBS's "FPS" canvas setting). Read once at
// connect via GetVideoSettings — used by computeScheduleDelay to
// convert frame-based stinger transition_points to ms. Refreshed
// on InputSettingsChanged or VideoSettingsChanged events if needed.
let cachedVideoFps = 60;

// Map<transitionName, transitionKind> cached at connect from
// GetSceneTransitionList. Per-scene transition OVERRIDES only report a name +
// duration (not the kind), so we look the kind up here to decide cut vs
// stinger vs fade for the delay.
let transitionKindByName = {};

function handleSceneChange(sceneName, transitionInfo = null) {
    currentProgramScene = sceneName;
    if (sceneName === lastProgramScene) return;
    // Capture the FROM scene before we overwrite lastProgramScene — the
    // schedule-delay branch below needs to know what we're transitioning
    // FROM (another Event Slides scene vs. anything else) to pick the
    // right post-stinger delay.
    const fromScene = lastProgramScene;
    console.log(`[OBS] Scene change: "${fromScene}" → "${sceneName}"`);
    lastProgramScene = sceneName;

    // Cancel any pending schedule emit — if we're leaving the schedule
    // scene before the stinger completes, the queued
    // obs-animate-schedule would arrive after the cut to a different
    // scene and try to animate a hidden source for no reason. Re-cleared
    // here even if the new scene is also schedule — the next branch
    // below requeues a fresh timer so the animation fires once per cut.
    if (scheduleAnimateTimer) {
        clearTimeout(scheduleAnimateTimer);
        scheduleAnimateTimer = null;
    }
    // Cancel any pending schedule LEAVE emit — same idea but the other
    // direction. If the operator cut Schedule → Other → Schedule faster
    // than SCHEDULE_LEAVE_DELAY, the queued reset would fire AFTER the
    // operator was already back on schedule and the entrance animation
    // had begun, snapping the data layer back to opacity 0 mid-fade.
    // Cancelling on every scene change ensures the leave reset only
    // ever fires while the operator is genuinely off the schedule scene.
    if (scheduleLeaveTimer) {
        clearTimeout(scheduleLeaveTimer);
        scheduleLeaveTimer = null;
    }
    if (deckAnimateTimer) {
        clearTimeout(deckAnimateTimer);
        deckAnimateTimer = null;
    }

    // Metagame — entrance delay now computed from the live transition
    // (was a fixed METAGAME_DELAY) so it tracks the stinger automatically.
    if (sceneName === METAGAME_SCENE) {
        setTimeout(() => {
            RoomUtils.emitWithRoomMapping(io, 'obs-animate-metagame', {});
        }, computeScheduleDelay(transitionInfo, cachedVideoFps));
    }

    // Bracket — replay the QF→SF→F reveal animation on every cut to the
    // Top 8 bracket scene. Display page listener is in
    // public/js/bracket-full-display.js.
    if (sceneName === BRACKET_SCENE) {
        setTimeout(() => {
            RoomUtils.emitWithRoomMapping(io, 'obs-animate-bracket', {});
        }, computeScheduleDelay(transitionInfo, cachedVideoFps));
    }

    // Decklist — match-specific scenes ("Match 1 - Decklist - Red", etc.).
    // Pattern-matched on "Decklist" so all four (and any future ones) work
    // without registering each name. Same transition-aware delay; the display
    // page (broadcast-round-main-deck.js) plays its staggered card entrance on
    // obs-animate-decklist. Broadcast globally like metagame/bracket — only the
    // decklist sources carry the handler. Cancelled on scene change via
    // deckAnimateTimer so Match 1 Red → Blue fires only the latest.
    if (sceneName.includes('Decklist')) {
        const delay = computeScheduleDelay(transitionInfo, cachedVideoFps);
        console.log(`[OBS] Decklist scene "${sceneName}" — emitting obs-animate-decklist (delay=${delay}ms)`);
        deckAnimateTimer = setTimeout(() => {
            deckAnimateTimer = null;
            RoomUtils.emitWithRoomMapping(io, 'obs-animate-decklist', {});
        }, delay);
    }

    // Leave schedule — when transitioning AWAY from the schedule scene,
    // tell the display page to "reset" the data layer (snap to opacity 0
    // + translateY(40px), the from-state of the entrance animation).
    // This happens off-screen during the cut/stinger out, so by the time
    // the operator next cuts back TO schedule, the data layer is already
    // hidden and the animate-schedule trigger can fade it in cleanly
    // without the visible "snap from end-state to start-state" flash
    // we'd otherwise get from doing reset+animate together inside a
    // single trigger AFTER the scene is already onscreen.
    //
    // Delay is now transition-aware (see computeScheduleLeaveDelay):
    // 0ms for cuts (schedule is gone immediately, no point holding the
    // data visible), SCHEDULE_LEAVE_DELAY (400ms) for stingers/fades
    // so the operator sees the schedule scene briefly during the
    // transition out before the data resets.
    if (fromScene === SCHEDULE_SCENE && sceneName !== SCHEDULE_SCENE) {
        const leaveDelay = computeScheduleLeaveDelay(transitionInfo);
        console.log(`[OBS] Leaving schedule scene → "${sceneName}" via "${transitionInfo?.transitionName ?? '?'}" (${transitionInfo?.transitionKind ?? '?'}) — emitting obs-leave-schedule (delay=${leaveDelay}ms)`);
        scheduleLeaveTimer = setTimeout(() => {
            scheduleLeaveTimer = null;
            console.log('[OBS] Emitting obs-leave-schedule now');
            RoomUtils.emitWithRoomMapping(io, 'obs-leave-schedule', {});
        }, leaveDelay);
    }

    // Schedule — replay the data-layer fade+slide-up entrance animation
    // on every cut to the schedule scene. Display page listener is in
    // public/js/event-info.js (triggerScheduleAnimation()). Delay is
    // computed per-transition (see computeScheduleDelay): cuts fire
    // immediately, stingers wait `transition_point + offset` so the
    // animation kicks in after the stinger video has visually cleared
    // the schedule scene, and other transitions (fade/swipe/slide)
    // wait for their configured duration.
    if (sceneName === SCHEDULE_SCENE) {
        const delay = computeScheduleDelay(transitionInfo, cachedVideoFps);
        const tName = transitionInfo?.transitionName ?? '?';
        const tKind = transitionInfo?.transitionKind ?? '?';
        const tp = transitionInfo?.transitionSettings?.transition_point;
        const tpStr = transitionInfo?.transitionKind === 'obs_stinger_transition'
            ? ` | transition_point=${tp}ms + offset=${SCHEDULE_STINGER_OFFSET}ms`
            : '';
        console.log(`[OBS] Schedule scene detected via "${tName}" (${tKind}${tpStr}) — emitting obs-animate-schedule (delay=${delay}ms)`);
        scheduleAnimateTimer = setTimeout(() => {
            scheduleAnimateTimer = null;
            console.log('[OBS] Emitting obs-animate-schedule now');
            RoomUtils.emitWithRoomMapping(io, 'obs-animate-schedule', {});
        }, delay);
    }

    // Standings
    const standingsPage = STANDINGS_SCENE_MAP[sceneName];
    if (standingsPage) {
        // Only the ENTRANCE (cutting into standings from another scene — usually
        // P1) gets a delay so its row cascade fires AFTER the entrance stinger
        // clears. In-scene P1→P2→P3→P4 changes (wasOnStandings already true) stay
        // immediate. computeScheduleDelay → the stinger's tail for a stinger, 0
        // for a cut, so it auto-adapts (and a cut entrance gets 0 = no wait).
        // STANDINGS_ENTRANCE_OFFSET = extra settle past the stinger before the
        // cascade — standings needs a touch more than the decklist (tuned by eye).
        // Standings-specific (does NOT shift the global SCHEDULE_STINGER_OFFSET).
        const STANDINGS_ENTRANCE_OFFSET = 1000;
        let enterDelay = 0;
        if (!wasOnStandings) {
            const base = computeScheduleDelay(transitionInfo, cachedVideoFps);
            enterDelay = base > 0 ? base + STANDINGS_ENTRANCE_OFFSET : 0;
        }
        RoomUtils.emitWithRoomMapping(io, 'obs-standings-page', { page: standingsPage, delay: enterDelay });
        wasOnStandings = true;
    } else if (wasOnStandings) {
        setTimeout(() => {
            RoomUtils.emitWithRoomMapping(io, 'obs-left-standings', {});
        }, STANDINGS_DELAY);
        wasOnStandings = false;
    }
}

// ── Preset Helpers ──────────────────────────────────────────────────────────
//
// Preset file format (v2 — extended deep-capture):
//
//   {
//     game, vendor, playerCount, savedAt,
//     scenes: {
//       <sceneName>: {
//         sources: [{
//           sourceName, sceneItemId,
//           enabled, locked, index, blendMode,
//           transform: { positionX, positionY, scaleX, scaleY, … }
//         }, …],
//         transitionOverride: { transitionName, transitionDuration } | null
//       }
//     },
//     inputs: {
//       <inputName>: {
//         inputKind,                          // e.g. 'browser_source'
//         settings: { … kind-specific … },    // url, file, font, text, …
//         audio: {
//           volumeMul, muted, syncOffset,     // ns
//           balance, monitorType, tracks,     // tracks: { '1':true, '2':false, … }
//         } | null,                           // null when source has no audio
//         filters: [{
//           filterName, filterKind,
//           filterEnabled, filterIndex,
//           filterSettings: { … }
//         }, …]
//       }
//     },
//     transition: {                           // ALL transitions (v3),
//       active: "<name>",                     // not just the active one
//       transitions: [{
//         transitionName, transitionKind,
//         transitionDuration,                 // ms
//         transitionSettings: { … }           // stinger video path,
//                                             // audio fade type,
//                                             // transition point, …
//       }, …]
//     } | null
//
// File paths in `inputs.<name>.settings` (image_source.file,
// ffmpeg_source.local_file, browser_source.url, etc.) are captured
// opaquely via GetInputSettings — the values are absolute paths from
// the saving machine. Restore on the same machine is exact;
// cross-machine restore preserves the path string but the underlying
// file may not exist there.
//
// All extended fields are optional on restore — older v1 presets (just
// `scenes` with transform+enabled) still work. v2 presets (single
// active-only transition at top level) also restore via the v2
// fallback branch in applyTransition. Each section is captured in a
// try/catch so a single failing source/scene doesn't abort the whole
// snapshot. Restore applies in dependency order:
//
//   1. inputs.settings + inputs.audio   (sources need correct settings
//                                        before scene items reference them)
//   2. inputs.filters                   (filters live on inputs)
//   3. transitions (all, then active)   (each transition's settings
//                                        applied while it's active,
//                                        then settle back to original)
//   4. scenes (transform + enabled +    (apply per-scene-item state)
//      locked + index + blendMode +
//      transitionOverride)

function getPresetPath(game, vendor, playerCount) {
    return path.join(PRESETS_DIR, `${game}-obsconfig-${vendor}-${playerCount}.json`);
}

// Wrap an async OBS call so we can grab per-source attributes without
// the whole snapshot exploding when a source doesn't support that
// attribute (e.g. image sources don't have audio — GetInputVolume
// throws "input not configured for audio"). Returns null on failure.
async function tryCall(method, params) {
    try {
        return await obs.call(method, params);
    } catch (err) {
        return null;
    }
}

async function snapshotAllScenes() {
    if (!obs) return null;

    const { scenes: sceneList } = await obs.call('GetSceneList');
    const scenes = {};

    for (const scene of sceneList) {
        const sceneName = scene.sceneName;
        const { sceneItems } = await obs.call('GetSceneItemList', { sceneName });
        const sources = [];

        for (const item of sceneItems) {
            const { sceneItemTransform } = await obs.call('GetSceneItemTransform', {
                sceneName,
                sceneItemId: item.sceneItemId
            });
            const { sceneItemEnabled } = await obs.call('GetSceneItemEnabled', {
                sceneName,
                sceneItemId: item.sceneItemId
            });
            // Extended per-item attributes — wrap each in tryCall so an
            // older OBS WS that doesn't support one of these doesn't
            // abort the whole snapshot. Older presets (without these
            // fields) still restore the basics on newer OBS.
            const lockedRes = await tryCall('GetSceneItemLocked', { sceneName, sceneItemId: item.sceneItemId });
            const indexRes  = await tryCall('GetSceneItemIndex',  { sceneName, sceneItemId: item.sceneItemId });
            const blendRes  = await tryCall('GetSceneItemBlendMode', { sceneName, sceneItemId: item.sceneItemId });

            log(`[OBS Preset]   "${sceneName}" → "${item.sourceName}" | visible: ${sceneItemEnabled} | locked: ${lockedRes?.sceneItemLocked ?? 'n/a'} | z: ${indexRes?.sceneItemIndex ?? 'n/a'} | blend: ${blendRes?.sceneItemBlendMode ?? 'n/a'} | pos: (${sceneItemTransform.positionX}, ${sceneItemTransform.positionY}) | size: (${Math.round(sceneItemTransform.sourceWidth * sceneItemTransform.scaleX)}x${Math.round(sceneItemTransform.sourceHeight * sceneItemTransform.scaleY)}) | crop: L${sceneItemTransform.cropLeft} R${sceneItemTransform.cropRight} T${sceneItemTransform.cropTop} B${sceneItemTransform.cropBottom}`);

            sources.push({
                sourceName: item.sourceName,
                sceneItemId: item.sceneItemId,
                enabled: sceneItemEnabled,
                locked: lockedRes?.sceneItemLocked ?? null,
                index:  indexRes?.sceneItemIndex  ?? null,
                blendMode: blendRes?.sceneItemBlendMode ?? null,
                transform: sceneItemTransform
            });
        }

        // Per-scene transition override — null both fields if no override.
        // OBS exposes this even when nothing is overridden; we capture the
        // null state so restore can clear an override that was set on the
        // live scene but isn't in the preset.
        const overrideRes = await tryCall('GetSceneTransitionOverride', { sceneName });

        scenes[sceneName] = {
            sources,
            transitionOverride: overrideRes
                ? { transitionName: overrideRes.transitionName, transitionDuration: overrideRes.transitionDuration }
                : null
        };
    }

    return scenes;
}

// Snapshot every input (source) in OBS — settings, audio properties,
// and filters. Sources are global (live across all scenes), so this
// is keyed by inputName. Failure on any single source is logged and
// skipped so the rest of the snapshot survives.
async function snapshotAllInputs() {
    if (!obs) return null;

    const inputs = {};
    const listRes = await tryCall('GetInputList', {});
    if (!listRes || !listRes.inputs) {
        log('[OBS Preset] GetInputList unavailable — skipping input capture');
        return inputs;
    }

    for (const input of listRes.inputs) {
        const inputName = input.inputName;
        const inputKind = input.inputKind;
        try {
            // Source-specific settings — text content, font, file paths,
            // browser URL, etc. Opaque object; OBS knows how to apply
            // it back as long as inputKind matches.
            const settingsRes = await tryCall('GetInputSettings', { inputName });
            const settings = settingsRes?.inputSettings ?? {};

            // Audio — only present on sources with audio capability.
            // Each call returns null for non-audio sources via tryCall.
            const volRes      = await tryCall('GetInputVolume',           { inputName });
            const muteRes     = await tryCall('GetInputMute',             { inputName });
            const syncRes     = await tryCall('GetInputAudioSyncOffset',  { inputName });
            const balRes      = await tryCall('GetInputAudioBalance',     { inputName });
            const monRes      = await tryCall('GetInputAudioMonitorType', { inputName });
            const tracksRes   = await tryCall('GetInputAudioTracks',      { inputName });
            const audio = (volRes || muteRes || syncRes || balRes || monRes || tracksRes) ? {
                volumeMul:    volRes?.inputVolumeMul   ?? null,
                muted:        muteRes?.inputMuted      ?? null,
                syncOffset:   syncRes?.inputAudioSyncOffset ?? null,
                balance:      balRes?.inputAudioBalance ?? null,
                monitorType:  monRes?.monitorType      ?? null,
                tracks:       tracksRes?.inputAudioTracks ?? null
            } : null;

            // Filters — GetSourceFilterList returns filterSettings inline
            // per filter, so a single call per source is enough.
            const filtersRes = await tryCall('GetSourceFilterList', { sourceName: inputName });
            const filters = (filtersRes?.filters ?? []).map(f => ({
                filterName:     f.filterName,
                filterKind:     f.filterKind,
                filterEnabled:  f.filterEnabled,
                filterIndex:    f.filterIndex,
                filterSettings: f.filterSettings ?? {}
            }));

            inputs[inputName] = {
                inputKind,
                settings,
                audio,
                filters
            };
            log(`[OBS Preset]   input "${inputName}" (${inputKind}) | settings: ${Object.keys(settings).length} keys | audio: ${audio ? 'yes' : 'n/a'} | filters: ${filters.length}`);
        } catch (err) {
            log(`[OBS Preset]   input "${inputName}" snapshot failed: ${err.message}`);
        }
    }

    return inputs;
}

// Snapshot every transition in the OBS profile, not just the active
// one. The v5 WebSocket protocol only exposes settings for the
// CURRENTLY-ACTIVE transition (via GetCurrentSceneTransition). To
// capture non-active stingers/cuts/fades with their full settings —
// stinger video path, transition point, audio fade type, etc. — we
// walk the transition list, briefly switch to each one to read its
// settings, then restore the originally-active transition at the end.
//
// SetCurrentSceneTransition only changes the dropdown selection in
// OBS — it does NOT trigger a visual transition — so the operator
// won't see scenes flicker during the snapshot pass. The restore-
// active step at the end ensures we leave OBS in the same state we
// found it.
//
// Returns:
//   {
//     active: "<originally-active transition name>",
//     transitions: [
//       { transitionName, transitionKind, transitionDuration,
//         transitionSettings: { … } },
//       …
//     ]
//   }
async function snapshotTransitions() {
    if (!obs) return null;

    // GetSceneTransitionList returns: currentSceneTransitionName +
    // a list of {transitionName, transitionKind, transitionFixed,
    // transitionConfigurable}. Settings are NOT included — that's
    // why we need the per-transition switch+read pass below.
    const listRes = await tryCall('GetSceneTransitionList', {});
    if (!listRes || !listRes.transitions) {
        log('[OBS Preset] GetSceneTransitionList unavailable — falling back to current-only capture');
        const cur = await tryCall('GetCurrentSceneTransition', {});
        if (!cur) return null;
        log(`[OBS Preset]   transition "${cur.transitionName}" (${cur.transitionKind}) | duration: ${cur.transitionDuration}ms (active only)`);
        return {
            active: cur.transitionName,
            transitions: [{
                transitionName:     cur.transitionName,
                transitionKind:     cur.transitionKind,
                transitionDuration: cur.transitionDuration,
                transitionSettings: cur.transitionSettings ?? {}
            }]
        };
    }

    const originallyActive = listRes.currentSceneTransitionName;
    const captured = [];

    for (const t of listRes.transitions) {
        try {
            // Brief switch to this transition so GetCurrentSceneTransition
            // returns ITS settings on the next call. Skip the switch when
            // we're already on the right one (no point thrashing).
            const cur0 = await tryCall('GetCurrentSceneTransition', {});
            if (cur0?.transitionName !== t.transitionName) {
                await obs.call('SetCurrentSceneTransition', { transitionName: t.transitionName });
            }
            const cur = await tryCall('GetCurrentSceneTransition', {});
            if (cur && cur.transitionName === t.transitionName) {
                captured.push({
                    transitionName:     cur.transitionName,
                    transitionKind:     cur.transitionKind,
                    transitionDuration: cur.transitionDuration,
                    transitionSettings: cur.transitionSettings ?? {}
                });
                const settingsKeys = Object.keys(cur.transitionSettings ?? {}).length;
                log(`[OBS Preset]   transition "${cur.transitionName}" (${cur.transitionKind}) | duration: ${cur.transitionDuration}ms | settings keys: ${settingsKeys}${cur.transitionName === originallyActive ? ' [ACTIVE]' : ''}`);
            }
        } catch (err) {
            log(`[OBS Preset]   transition "${t.transitionName}" snapshot failed: ${err.message}`);
        }
    }

    // Restore the originally-active transition so the operator's OBS
    // state isn't disturbed by our walk. SetCurrentSceneTransition is
    // a configuration change, not a visual transition trigger — but
    // we still want OBS to be back where we found it.
    if (originallyActive) {
        await tryCall('SetCurrentSceneTransition', { transitionName: originallyActive });
    }

    return {
        active: originallyActive,
        transitions: captured
    };
}

// ── Save Preset ─────────────────────────────────────────────────────────────

export async function savePreset() {
    const game = getGameSelection();
    const vendor = getVendorSelection();
    const playerCount = getPlayerCount();
    startLog('save', `${game}-obsconfig-${vendor}-${playerCount}`);

    if (!obs) {
        log('[OBS Preset] OBS not connected — cannot save');
        return { success: false, error: 'OBS not connected' };
    }

    try {
        // Each section captured independently — log a header so the per-
        // section progress is easy to scan. snapshotAllInputs and
        // snapshotTransitions are the new deep-capture categories
        // (file paths, fonts, URLs, audio, filters, stinger settings).
        log(`[OBS Preset] ── Snapshotting scenes ─────────────`);
        const scenes = await snapshotAllScenes();
        log(`[OBS Preset] ── Snapshotting inputs ─────────────`);
        const inputs = await snapshotAllInputs();
        log(`[OBS Preset] ── Snapshotting current transition ─`);
        const transition = await snapshotTransitions();

        const preset = {
            game,
            vendor,
            playerCount,
            savedAt: new Date().toISOString(),
            scenes,
            inputs,
            transition
        };

        const filePath = getPresetPath(game, vendor, playerCount);
        fs.writeFileSync(filePath, JSON.stringify(preset, null, 2));
        const sceneCount = Object.keys(scenes ?? {}).length;
        const inputCount = Object.keys(inputs ?? {}).length;
        log(`[OBS Preset] Saved: ${game}-${vendor}-${playerCount} | scenes: ${sceneCount} | inputs: ${inputCount} | transition: ${transition?.transitionName ?? 'n/a'}`);
        return { success: true, file: `${game}-${vendor}-${playerCount}.json` };
    } catch (err) {
        log('[OBS Preset] Save failed:', err.message);
        return { success: false, error: err.message };
    }
}

// ── Restore Preset ──────────────────────────────────────────────────────────

// Apply per-input settings + audio properties + filters. Runs first
// because scene items reference inputs by name — getting the source
// content (file path, URL, font, etc.) right BEFORE the scene item is
// re-positioned avoids a brief frame where the scene shows the wrong
// content. Audio/filters are independent of scene items, so order
// within this pass doesn't matter beyond stability.
async function applyInputs(presetInputs, counters) {
    if (!presetInputs) return;
    for (const [inputName, data] of Object.entries(presetInputs)) {
        try {
            // 1. Source-specific settings — overlay:true means we merge
            //    on top of existing settings rather than replacing the
            //    whole object (some kinds have non-serialized internal
            //    fields that we'd nuke with overlay:false).
            if (data.settings) {
                await obs.call('SetInputSettings', {
                    inputName,
                    inputSettings: data.settings,
                    overlay: true
                });
            }
            // 2. Audio properties — only apply what the input supports.
            //    Each setter wrapped in tryCall so non-audio sources
            //    (image, color source, etc.) don't blow up the whole
            //    input restore.
            if (data.audio) {
                const a = data.audio;
                if (a.volumeMul   !== null && a.volumeMul   !== undefined) await tryCall('SetInputVolume',           { inputName, inputVolumeMul: a.volumeMul });
                if (a.muted       !== null && a.muted       !== undefined) await tryCall('SetInputMute',             { inputName, inputMuted: a.muted });
                if (a.syncOffset  !== null && a.syncOffset  !== undefined) await tryCall('SetInputAudioSyncOffset',  { inputName, inputAudioSyncOffset: a.syncOffset });
                if (a.balance     !== null && a.balance     !== undefined) await tryCall('SetInputAudioBalance',     { inputName, inputAudioBalance: a.balance });
                if (a.monitorType !== null && a.monitorType !== undefined) await tryCall('SetInputAudioMonitorType', { inputName, monitorType: a.monitorType });
                if (a.tracks)                                              await tryCall('SetInputAudioTracks',      { inputName, inputAudioTracks: a.tracks });
            }
            // 3. Filters — assume each filter exists on the source by
            //    name. Update settings + enabled state + index. We do
            //    NOT create missing filters or delete unmentioned ones
            //    (less destructive — a filter the operator added live
            //    won't be ripped out by a restore). Index applied last
            //    so the order shuffle doesn't fight with the settings
            //    apply on intermediate frames.
            for (const f of data.filters ?? []) {
                try {
                    await tryCall('SetSourceFilterSettings', {
                        sourceName: inputName,
                        filterName: f.filterName,
                        filterSettings: f.filterSettings ?? {},
                        overlay: true
                    });
                    await tryCall('SetSourceFilterEnabled', {
                        sourceName: inputName,
                        filterName: f.filterName,
                        filterEnabled: !!f.filterEnabled
                    });
                    if (f.filterIndex !== null && f.filterIndex !== undefined) {
                        await tryCall('SetSourceFilterIndex', {
                            sourceName: inputName,
                            filterName: f.filterName,
                            filterIndex: f.filterIndex
                        });
                    }
                    counters.filtersApplied++;
                } catch (err) {
                    counters.filtersSkipped++;
                }
            }
            counters.inputsApplied++;
            log(`[OBS Preset]   input "${inputName}" → applied (settings + audio + ${data.filters?.length ?? 0} filters)`);
        } catch (err) {
            counters.inputsSkipped++;
            log(`[OBS Preset]   input "${inputName}" → skipped: ${err.message}`);
        }
    }
}

// Apply transition settings — handles both the v3 multi-transition
// format ({ active, transitions: [...] }) and the v2 single-transition
// fallback ({ transitionName, … }) for backward compatibility.
//
// v3 walk:
//   1. For each saved transition, switch to it via
//      SetCurrentSceneTransition, then apply its settings + duration.
//      Settings/duration setters target the CURRENTLY-ACTIVE
//      transition, so the switch must come first.
//   2. After all transitions have their settings restored, switch
//      back to the originally-active transition (preset.active) so
//      OBS is left in the right operating state.
async function applyTransition(presetTransition) {
    if (!presetTransition) return;

    // v3 format: array of transitions to apply, plus the active one
    // to settle on at the end.
    if (Array.isArray(presetTransition.transitions)) {
        for (const t of presetTransition.transitions) {
            try {
                if (!t.transitionName) continue;
                await obs.call('SetCurrentSceneTransition', { transitionName: t.transitionName });
                if (t.transitionDuration !== null && t.transitionDuration !== undefined) {
                    await tryCall('SetCurrentSceneTransitionDuration', { transitionDuration: t.transitionDuration });
                }
                if (t.transitionSettings) {
                    await tryCall('SetCurrentSceneTransitionSettings', {
                        transitionSettings: t.transitionSettings,
                        overlay: true
                    });
                }
                log(`[OBS Preset]   transition "${t.transitionName}" (${t.transitionKind}) → applied | duration: ${t.transitionDuration}ms`);
            } catch (err) {
                log(`[OBS Preset]   transition "${t.transitionName}" apply failed: ${err.message}`);
            }
        }
        // Settle on the originally-active transition. Without this we'd
        // leave OBS pointed at whichever transition was last in the loop.
        if (presetTransition.active) {
            await tryCall('SetCurrentSceneTransition', { transitionName: presetTransition.active });
            log(`[OBS Preset]   active transition restored to "${presetTransition.active}"`);
        }
        return;
    }

    // v2 fallback: single transition with name/kind/duration/settings
    // at the top level. Older preset files saved before non-active
    // capture was added.
    try {
        if (presetTransition.transitionName) {
            await obs.call('SetCurrentSceneTransition', { transitionName: presetTransition.transitionName });
        }
        if (presetTransition.transitionDuration !== null && presetTransition.transitionDuration !== undefined) {
            await tryCall('SetCurrentSceneTransitionDuration', { transitionDuration: presetTransition.transitionDuration });
        }
        if (presetTransition.transitionSettings) {
            await tryCall('SetCurrentSceneTransitionSettings', {
                transitionSettings: presetTransition.transitionSettings,
                overlay: true
            });
        }
        log(`[OBS Preset]   transition "${presetTransition.transitionName}" (${presetTransition.transitionKind}) → applied (v2 single-transition format) | duration: ${presetTransition.transitionDuration}ms`);
    } catch (err) {
        log(`[OBS Preset]   transition apply failed: ${err.message}`);
    }
}

// Apply per-scene state: scene-item transforms/visibility/locked/
// blend-mode/index, plus per-scene transition overrides. Index is set
// last per-item so reordering doesn't fight with concurrent transform
// updates. Overrides are applied per-scene at the end so a transition
// rename doesn't cause stale references during the per-item pass.
async function applyScenes(presetScenes, counters) {
    if (!presetScenes) return;
    for (const [sceneName, sceneData] of Object.entries(presetScenes)) {
        // Get all live scene items to handle duplicate source names (paste reference)
        let liveItems;
        try {
            const result = await obs.call('GetSceneItemList', { sceneName });
            liveItems = result.sceneItems;
        } catch (err) {
            log(`[OBS Preset] Skipped scene "${sceneName}": ${err.message}`);
            continue;
        }

        // Build occurrence map: sourceName → [sceneItemId, sceneItemId, ...]
        const liveOccurrences = {};
        for (const item of liveItems) {
            if (!liveOccurrences[item.sourceName]) liveOccurrences[item.sourceName] = [];
            liveOccurrences[item.sourceName].push(item.sceneItemId);
        }

        // Track which occurrence we're on per source name
        const presetOccurrenceCount = {};

        for (const source of sceneData.sources) {
            try {
                const name = source.sourceName;
                if (!presetOccurrenceCount[name]) presetOccurrenceCount[name] = 0;
                const occIdx = presetOccurrenceCount[name]++;

                const liveIds = liveOccurrences[name];
                if (!liveIds || occIdx >= liveIds.length) {
                    log(`[OBS Preset] Skipped "${name}" (occurrence ${occIdx}) in "${sceneName}": not found`);
                    counters.itemsSkipped++;
                    continue;
                }
                const sceneItemId = liveIds[occIdx];

                // Read current state for before/after comparison
                const { sceneItemTransform: curT } = await obs.call('GetSceneItemTransform', { sceneName, sceneItemId });
                const { sceneItemEnabled: curE } = await obs.call('GetSceneItemEnabled', { sceneName, sceneItemId });
                const t = source.transform;
                const fmtT = (tr, en) => `pos (${tr.positionX}, ${tr.positionY}) | size (${Math.round((tr.sourceWidth || 0) * (tr.scaleX || 1))}x${Math.round((tr.sourceHeight || 0) * (tr.scaleY || 1))}) | crop L${tr.cropLeft} R${tr.cropRight} T${tr.cropTop} B${tr.cropBottom} | visible: ${en}`;
                log(`[OBS Preset]   "${sceneName}" → "${name}" (occurrence ${occIdx}, id ${sceneItemId})`);
                log(`[OBS Preset]     BEFORE: ${fmtT(curT, curE)}`);
                log(`[OBS Preset]     AFTER:  ${fmtT(t, source.enabled)}`);

                // Filter to only writable transform properties
                const { sourceWidth, sourceHeight, width, height, boundsWidth, boundsHeight, ...writableTransform } = source.transform;
                if (writableTransform.boundsType && writableTransform.boundsType !== 'OBS_BOUNDS_NONE') {
                    writableTransform.boundsWidth = boundsWidth;
                    writableTransform.boundsHeight = boundsHeight;
                }
                await obs.call('SetSceneItemTransform', {
                    sceneName,
                    sceneItemId,
                    sceneItemTransform: writableTransform
                });

                await obs.call('SetSceneItemEnabled', {
                    sceneName,
                    sceneItemId,
                    sceneItemEnabled: source.enabled
                });

                // Extended per-item state — locked, blend mode, z-index.
                // All wrapped in tryCall so older OBS WS that doesn't
                // support one of these silently moves on. v1 presets
                // (without these fields) skip naturally because the
                // value is undefined.
                if (source.locked !== null && source.locked !== undefined) {
                    await tryCall('SetSceneItemLocked', { sceneName, sceneItemId, sceneItemLocked: source.locked });
                }
                if (source.blendMode !== null && source.blendMode !== undefined) {
                    await tryCall('SetSceneItemBlendMode', { sceneName, sceneItemId, sceneItemBlendMode: source.blendMode });
                }
                // Index last — moves the item up/down the z-stack;
                // applying after transform avoids fighting the layout
                // updates above.
                if (source.index !== null && source.index !== undefined) {
                    await tryCall('SetSceneItemIndex', { sceneName, sceneItemId, sceneItemIndex: source.index });
                }

                counters.itemsApplied++;
            } catch (err) {
                log(`[OBS Preset] Skipped ${source.sourceName} in "${sceneName}": ${err.message}`);
                counters.itemsSkipped++;
            }
        }

        // Per-scene transition override — apply after all items in the
        // scene are positioned. Null override means "no override" which
        // we restore by clearing (passing null/empty). The OBS API
        // accepts null fields to clear an override.
        if ('transitionOverride' in sceneData) {
            const ov = sceneData.transitionOverride;
            const params = ov
                ? { sceneName, transitionName: ov.transitionName, transitionDuration: ov.transitionDuration }
                : { sceneName, transitionName: null, transitionDuration: null };
            await tryCall('SetSceneTransitionOverride', params);
        }
    }
}

export async function restorePreset(game, vendor, playerCount) {
    startLog('restore', `${game}-obsconfig-${vendor}-${playerCount}`);

    if (!obs) {
        log('[OBS Preset] OBS not connected — skipping restore');
        return;
    }

    const filePath = getPresetPath(game, vendor, playerCount);
    if (!fs.existsSync(filePath)) {
        log(`[OBS Preset] No preset for ${game}-${vendor}-${playerCount}`);
        return;
    }

    try {
        // Auto-backup current state before restoring — full snapshot
        // (scenes + inputs + transition) so a bad restore can be undone
        // by re-running with this backup file.
        log(`[OBS Preset] ── Auto-backup before restore ──────`);
        const backupScenes = await snapshotAllScenes();
        const backupInputs = await snapshotAllInputs();
        const backupTransition = await snapshotTransitions();
        if (backupScenes) {
            const now = new Date();
            const timestamp = now.getFullYear().toString() + String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0') + '-' + String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0') + String(now.getSeconds()).padStart(2,'0');
            const backupPath = path.join(BACKUPS_DIR, `backup-${timestamp}.json`);
            fs.writeFileSync(backupPath, JSON.stringify({
                savedAt: new Date().toISOString(),
                reason: `auto-backup before restoring ${game}-${vendor}-${playerCount}`,
                scenes: backupScenes,
                inputs: backupInputs,
                transition: backupTransition
            }, null, 2));
            log(`[OBS Preset] Backup saved: ${path.basename(backupPath)}`);
        }

        const preset = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const counters = { inputsApplied: 0, inputsSkipped: 0, filtersApplied: 0, filtersSkipped: 0, itemsApplied: 0, itemsSkipped: 0 };

        // Dependency order:
        //   1. Inputs first  — sources need the right settings/audio/
        //      filters in place before the scene-item pass references
        //      them. v1 presets (no `inputs` key) skip this step.
        log(`[OBS Preset] ── Applying inputs ─────────────────`);
        await applyInputs(preset.inputs, counters);

        //   2. Transition — must be set BEFORE its settings/duration
        //      apply (the settings setter targets whichever transition
        //      is currently active). v1 presets (no `transition` key)
        //      skip this step.
        log(`[OBS Preset] ── Applying transition ─────────────`);
        await applyTransition(preset.transition);

        //   3. Scenes — per-item transform/enabled/locked/blend/index
        //      and per-scene transition override. Always applied
        //      (v1 + v2 presets both have `scenes`).
        log(`[OBS Preset] ── Applying scenes ─────────────────`);
        await applyScenes(preset.scenes, counters);

        log(`[OBS Preset] Restored ${game}-${vendor}-${playerCount} | inputs: ${counters.inputsApplied}/${counters.inputsApplied + counters.inputsSkipped} | filters: ${counters.filtersApplied}/${counters.filtersApplied + counters.filtersSkipped} | items: ${counters.itemsApplied}/${counters.itemsApplied + counters.itemsSkipped}`);
    } catch (err) {
        log('[OBS Preset] Restore failed:', err.message);
    }
}

// ── Connection ──────────────────────────────────────────────────────────────

async function connect() {
    obs = new OBSWebSocket();

    try {
        await obs.connect(OBS_WS_URL, OBS_WS_PASSWORD);
        log('[OBS WebSocket] Connected');

        // Scene changes only arrive as events, so without this the program
        // scene would be unknown until the operator's first cut after boot.
        try {
            const { currentProgramSceneName } = await obs.call('GetCurrentProgramScene');
            currentProgramScene = currentProgramSceneName || null;
        } catch (err) {
            log(`[OBS WebSocket] Could not read the program scene: ${err.message}`);
        }

        // Cache the project FPS once at connect — used by
        // computeScheduleDelay to convert frame-based stinger
        // transition_points to ms. Refresh isn't critical (fps rarely
        // changes mid-session) but a video-settings change event
        // would let us refresh if needed.
        try {
            const v = await obs.call('GetVideoSettings');
            if (v?.fpsNumerator && v?.fpsDenominator) {
                cachedVideoFps = v.fpsNumerator / v.fpsDenominator;
                log(`[OBS WebSocket] Cached project FPS: ${cachedVideoFps}`);
            }
        } catch (err) {
            log(`[OBS WebSocket] Could not fetch video settings (using ${cachedVideoFps}fps default): ${err.message}`);
        }

        // Cache transition name → kind so per-scene override lookups (which
        // only return a name) can resolve cut vs stinger vs fade.
        try {
            const tl = await obs.call('GetSceneTransitionList');
            transitionKindByName = {};
            for (const t of (tl.transitions || [])) transitionKindByName[t.transitionName] = t.transitionKind;
            log(`[OBS WebSocket] Cached ${Object.keys(transitionKindByName).length} transition kinds`);
        } catch (err) {
            log(`[OBS WebSocket] Could not fetch transition list: ${err.message}`);
        }

        let pendingScene = null;

        obs.on('SceneTransitionStarted', async () => {
            try {
                const { currentProgramSceneName } = await obs.call('GetCurrentProgramScene');
                pendingScene = currentProgramSceneName;
                // Read the active transition's full info — used by
                // computeScheduleDelay/computeScheduleLeaveDelay to
                // pick the right delay based on the transition kind
                // (cut vs stinger) and stinger transition_point. Lazy
                // (per-event) lookup avoids the expense of caching the
                // full list at connect.
                let transitionInfo = null;
                try {
                    // A per-scene transition OVERRIDE takes precedence over the
                    // global transition. GetCurrentSceneTransition only reports
                    // the GLOBAL one, so without this an overridden scene (e.g. a
                    // decklist scene set to "Stinger - Decklist") reads as the
                    // global "Cut" → 0 delay. OBS doesn't expose the override
                    // transition's stinger settings, only its duration —
                    // computeScheduleDelay falls back to that duration.
                    let ov = null;
                    try { ov = await obs.call('GetSceneSceneTransitionOverride', { sceneName: pendingScene }); } catch (e) {}
                    if (ov && ov.transitionName) {
                        transitionInfo = {
                            transitionName: ov.transitionName,
                            transitionKind: transitionKindByName[ov.transitionName] ?? null,
                            transitionDuration: ov.transitionDuration,
                            transitionSettings: {}
                        };
                    } else {
                        const cur = await obs.call('GetCurrentSceneTransition');
                        transitionInfo = {
                            transitionName: cur.transitionName,
                            transitionKind: cur.transitionKind,
                            transitionDuration: cur.transitionDuration,
                            transitionSettings: cur.transitionSettings ?? {}
                        };
                    }
                } catch (err) {
                    // Non-fatal — handleSceneChange falls back to a
                    // default delay when transitionInfo is null.
                }
                log(`[OBS WebSocket] Transition started → target: ${pendingScene} | transition: ${transitionInfo?.transitionName ?? '?'} (${transitionInfo?.transitionKind ?? '?'})`);
                handleSceneChange(pendingScene, transitionInfo);
            } catch (err) {
                log('[OBS WebSocket] Error querying scene:', err.message);
            }
        });

        // Fallback: catch scene changes that don't go through transitions
        // (e.g. studio-mode preview swaps without a transition button).
        // No transition info available here — handleSceneChange falls
        // back to defaults.
        obs.on('CurrentProgramSceneChanged', (data) => {
            const sceneName = data.sceneName;
            if (sceneName === pendingScene) {
                pendingScene = null;
                return; // Already handled during transition
            }
            log(`[OBS WebSocket] Program scene changed to: ${sceneName} (fallback)`);
            handleSceneChange(sceneName, null);
        });

        obs.on('ConnectionClosed', () => {
            currentProgramScene = null;   // can't vouch for what's on air while blind
            log('[OBS WebSocket] Connection closed — reconnecting...');
            scheduleReconnect();
        });

    } catch (err) {
        log(`[OBS WebSocket] Failed to connect: ${err.message}`);
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, RECONNECT_INTERVAL);
}

export function initOBSWebSocket(socketIo) {
    io = socketIo;
    connect();
}
