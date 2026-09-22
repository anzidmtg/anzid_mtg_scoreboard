import { RIFTBOUND_LEGENDS_LIST, RIFTBOUND_CHAMPIONS_LIST, RIFTBOUND_BATTLEFIELDS_LIST } from '../riftbound/constants.js';

export function initMatches(socket) {

    const broadcastDisplay = document.getElementById('broadcasting-now-round-display');
    let currentGameSelection = 'mtg'; // Default to mtg
    let currentVendor = 'default';
    let currentPlayerCount = '1v1';
    const control1Display = document.getElementById('control-1-round-match-display');
    const control2Display = document.getElementById('control-2-round-match-display');
    const control3Display = document.getElementById('control-3-round-match-display');
    const control4Display = document.getElementById('control-4-round-match-display');
    const updateEventInformation = document.querySelector(`#global-update-event-information.update-button`);
    const updateEventInformationBaseTimer = document.querySelector(`#global-update-event-information-base-timer.update-button`);
    const updateCommentators = document.querySelector(`#global-update-commentators.update-button`);
    const commentator1 = () => document.querySelector(`#global-commentator-1`);
    const commentator1_subtext = () =>  document.querySelector(`#global-commentator-subtext-1`);
    const commentator2 = () =>  document.querySelector(`#global-commentator-2`);
    const commentator2_subtext = () =>  document.querySelector(`#global-commentator-subtext-2`);
    const commentator3 = () =>  document.querySelector(`#global-commentator-3`);
    const commentator3_subtext = () =>  document.querySelector(`#global-commentator-subtext-3`);
    const commentator4 = () =>  document.querySelector(`#global-commentator-4`);
    const commentator4_subtext = () =>  document.querySelector(`#global-commentator-subtext-4`);
    const matchEventName = document.querySelector(`#global-event-name`);
    const matchEventFormat = document.querySelector(`#global-event-format`);
    const matchEventMiscDetails = document.querySelector(`#global-event-miscellaneous-details`);
    const matchEventBaseLifePoints = document.querySelector(`#global-event-base-life-points`);
    const matchEventBaseLifePointsCurrent = document.querySelector(`#global-event-base-life-points-current`);
    const matchEventBaseTimer = document.querySelector(`#global-event-base-timer`);
    const matchEventBaseTimerCurrent = document.querySelector(`#global-event-base-timer-current`);
    const matchEventNumberOfRounds = document.querySelector(`#global-event-number-of-rounds`);
    let allControlData = {};
    let allTimerStates = {};
    // Broadcast round id (string), kept in sync with the server's
    // `broadcastTracker.round_id`. Null until the first
    // `control-broadcast-trackers` payload arrives.
    let currentBroadcastRoundId = null;
    let allStandingsData = {};
    // Full per-round standings (ALL players, not just the broadcast cut in the
    // textarea) used by the standings search. Lazy-loaded from the server the
    // first time a round is searched; keyed by roundId. fullStandingsRequested
    // dedupes the in-flight request so typing doesn't spam the socket.
    const fullStandingsByRound = {};
    const fullStandingsRequested = new Set();
    // Round the server actually served per requested round. Differs when the
    // requested round has no file yet (Carde files standings a round behind),
    // so we can tell the operator which round they're really searching.
    const fullStandingsRoundUsed = {};
    // Per-round watchdog timers: if the server never answers get-full-standings
    // (e.g. it's running an older build without the handler), we replace the
    // "Searching…" spinner with an actionable error instead of hanging forever.
    const fullStandingsTimers = {};
    const FULL_STANDINGS_TIMEOUT_MS = 8000;
    let baseLifePoints = '20';
    let baseTimer = '50';
    let currentArchetypeList = [];
    let currentPlayerRoster = []; // roster for player-name autocomplete (see setupCustomDropdowns)
    let swuLeadersList = [];
    let swuBasesList = [];
    let commentatorData = {};
    // Group assignments for the FQ 2v2 override panel, kept in module scope so
    // the rendered panel can re-sync when the `groupAssignmentUpdated` socket
    // event fires. Shape: { group1: [teamName, ...], group2: [teamName, ...] }.
    let currentGroupAssignment = { group1: [], group2: [] };
    // Flag flips to true once the first `groupAssignmentUpdated` response lands
    // so the override panel can distinguish "still loading from server" from
    // "received an empty assignment". Without this the initial render (which
    // happens synchronously when the round card is built, before the socket
    // response arrives) shows the "Group Assignment not saved" empty state
    // even when groups are saved — a visible flash before the real data lands.
    let groupAssignmentReceived = false;

    // ── Add Deck Modal ──
    // Shared modal for pasting decklists (appended once to DOM)
    let addDeckModalContext = { roundId: null, matchId: null, side: null };

    const addDeckModalHTML = `
    <div class="modal fade" id="add-deck-modal" tabindex="-1" aria-labelledby="add-deck-modal-label" aria-hidden="true">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="add-deck-modal-label">Add Decklist</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <!-- Piltover Archive import (riftbound only) — paste a deck link,
                 hit Load, and the server fetches the decklist into the textarea
                 below for review before Submit. Shown/hidden per game in the
                 .add-deck-btn click handler. -->
            <div id="add-deck-pa-row" class="mb-2" style="display:none;">
              <label class="form-label mb-1">Piltover Archive link</label>
              <div class="input-group">
                <input type="text" id="add-deck-pa-link" class="form-control"
                       placeholder="https://piltoverarchive.com/decks/…">
                <button type="button" class="btn btn-outline-primary" id="add-deck-pa-load">Load</button>
              </div>
              <div id="add-deck-pa-status" class="small mt-1" style="display:none;"></div>
            </div>
            <textarea id="add-deck-textarea" class="form-control" rows="15"
                      placeholder="Paste your decklist here..."></textarea>
            <div id="add-deck-error" class="text-danger mt-2" style="display:none;"></div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
            <button type="button" class="btn btn-primary" id="add-deck-submit">Submit</button>
          </div>
        </div>
      </div>
    </div>`;

    // Append modal to document body once
    const modalWrapper = document.createElement('div');
    modalWrapper.innerHTML = addDeckModalHTML;
    document.body.appendChild(modalWrapper.firstElementChild);

    const addDeckModal = new bootstrap.Modal(document.getElementById('add-deck-modal'));
    const addDeckTextarea = document.getElementById('add-deck-textarea');
    const addDeckError = document.getElementById('add-deck-error');
    const addDeckPaRow = document.getElementById('add-deck-pa-row');
    const addDeckPaLink = document.getElementById('add-deck-pa-link');
    const addDeckPaLoad = document.getElementById('add-deck-pa-load');
    const addDeckPaStatus = document.getElementById('add-deck-pa-status');

    function setPaStatus(msg, kind) {
        // kind: 'muted' | 'success' | 'danger'
        if (!msg) { addDeckPaStatus.style.display = 'none'; return; }
        addDeckPaStatus.textContent = msg;
        addDeckPaStatus.className = `small mt-1 text-${kind || 'muted'}`;
        addDeckPaStatus.style.display = 'block';
    }

    // "Add" button click — open modal
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.add-deck-btn');
        if (!btn) return;
        addDeckModalContext = {
            roundId: btn.dataset.round,
            matchId: btn.dataset.match,
            side: btn.dataset.side
        };
        addDeckTextarea.value = '';
        addDeckError.style.display = 'none';
        // Piltover Archive import is riftbound-only — show the row for riftbound,
        // reset it either way so a stale link/status never carries over.
        addDeckPaLink.value = '';
        setPaStatus('');
        addDeckPaRow.style.display = (currentGameSelection === 'riftbound') ? 'block' : 'none';
        addDeckModal.show();
    });

    // Piltover Archive "Load" — POST the link to our server-side proxy, which
    // resolves it with the API key and returns a decklist string in the exact
    // format parseDeckString understands. Fill the textarea; the operator then
    // reviews and clicks Submit as normal.
    async function loadPiltoverDeck() {
        const link = addDeckPaLink.value.trim();
        if (!link) { setPaStatus('Paste a Piltover Archive deck link first', 'danger'); return; }

        addDeckPaLoad.disabled = true;
        setPaStatus('Loading deck from Piltover Archive…', 'muted');
        try {
            const res = await fetch('/api/piltover/deck', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ link }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
                throw new Error(data.error || `Request failed (${res.status})`);
            }
            addDeckTextarea.value = data.text;
            addDeckTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            setPaStatus('Deck loaded — review below, then Submit.', 'success');
        } catch (err) {
            setPaStatus(err.message || 'Failed to load deck', 'danger');
        } finally {
            addDeckPaLoad.disabled = false;
        }
    }

    addDeckPaLoad.addEventListener('click', loadPiltoverDeck);
    // Enter in the link field triggers Load (not the modal's Submit).
    addDeckPaLink.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); loadPiltoverDeck(); }
    });

    // Submit handler
    document.getElementById('add-deck-submit').addEventListener('click', () => {
        const { roundId, matchId, side } = addDeckModalContext;
        if (!roundId || !matchId || !side) return;

        const raw = addDeckTextarea.value.trim();
        if (!raw) {
            addDeckError.textContent = 'Please paste a decklist';
            addDeckError.style.display = 'block';
            return;
        }

        const parsed = parseDeckString(raw);

        // Check if any cards were found (at least one section with card lines)
        const totalCards = Object.values(parsed).reduce((sum, arr) => sum + arr.length, 0);
        if (totalCards === 0) {
            addDeckError.textContent = 'No cards found in decklist';
            addDeckError.style.display = 'block';
            return;
        }

        // Populate main deck textarea (maindeck + any uncategorized lines)
        const mainLines = parsed['maindeck'] || [];
        const deckTextarea = document.getElementById(`${roundId}-${matchId}-player-main-deck-${side}`);
        if (deckTextarea) {
            deckTextarea.value = mainLines.join('\n');
            deckTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // Populate side deck textarea
        const sideLines = parsed['sideboard'] || [];
        const sideTextarea = document.getElementById(`${roundId}-${matchId}-player-side-deck-${side}`);
        if (sideTextarea) {
            sideTextarea.value = sideLines.join('\n');
            sideTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // Game-specific field population
        if (currentGameSelection === 'riftbound') {
            updateRiftboundFields(parsed, roundId, matchId, side);
        }

        if (currentGameSelection === 'starwars') {
            let leaderName = '';
            let baseName = '';
            // Leader
            if (parsed['leader'] && parsed['leader'].length > 0) {
                leaderName = parsed['leader'][0].replace(/^\d+\s+/, '');
                const leaderField = document.getElementById(`${roundId}-${matchId}-player-leader-${side}`);
                if (leaderField) {
                    leaderField.textContent = leaderName;
                    leaderField.dispatchEvent(new Event('input', { bubbles: true }));
                }
                // Also prepend leader to main deck so it gets transformed with card URLs
                if (deckTextarea) {
                    deckTextarea.value = `1 ${leaderName}\n${deckTextarea.value}`;
                    deckTextarea.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
            // Base
            if (parsed['base'] && parsed['base'].length > 0) {
                baseName = parsed['base'][0].replace(/^\d+\s+/, '');
                const baseField = document.getElementById(`${roundId}-${matchId}-player-base-${side}`);
                if (baseField) {
                    baseField.textContent = baseName;
                    baseField.dispatchEvent(new Event('input', { bubbles: true }));
                }
                // Also prepend base to main deck so it gets transformed with card URLs
                if (deckTextarea) {
                    deckTextarea.value = `1 ${baseName}\n${deckTextarea.value}`;
                    deckTextarea.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
            // Update archetype field with "Leader - Base" so broadcast deck name updates
            const archetypeField = document.getElementById(`${roundId}-${matchId}-player-archetype-${side}`);
            if (archetypeField) {
                const parts = [leaderName, baseName].filter(Boolean);
                archetypeField.textContent = parts.join(' - ');
                archetypeField.dispatchEvent(new Event('input', { bubbles: true }));
            }
            // Look up aspects and HP from server card database
            if (leaderName) {
                socket.emit('lookup-swu-card', { name: leaderName }, (info) => {
                    if (info && info.aspects && info.aspects.length > 0) {
                        const aspects = info.aspects.map(a => a.toLowerCase());
                        const aspect1Field = document.getElementById(`${roundId}-${matchId}-player-leader-aspect-1-${side}`);
                        const aspect2Field = document.getElementById(`${roundId}-${matchId}-player-leader-aspect-2-${side}`);
                        if (aspect1Field) {
                            aspect1Field.textContent = aspects[0] || '';
                            aspect1Field.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                        if (aspect2Field) {
                            aspect2Field.textContent = aspects[1] || '';
                            aspect2Field.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    }
                });
            }
            if (baseName) {
                socket.emit('lookup-swu-card', { name: baseName }, (info) => {
                    if (info) {
                        if (info.aspects && info.aspects.length > 0) {
                            const aspectsField = document.getElementById(`${roundId}-${matchId}-player-base-aspects-${side}`);
                            if (aspectsField) {
                                aspectsField.textContent = info.aspects.map(a => a.toLowerCase()).join(', ');
                                aspectsField.dispatchEvent(new Event('input', { bubbles: true }));
                            }
                        }
                        if (info.hp) {
                            const hpField = document.getElementById(`${roundId}-${matchId}-player-base-hp-${side}`);
                            if (hpField) {
                                hpField.textContent = info.hp;
                                hpField.dispatchEvent(new Event('input', { bubbles: true }));
                            }
                        }
                    }
                });
            }
        }

        // Unhide deck fields
        const deckFieldsContainer = document.getElementById(`${roundId}-${matchId}-deck-fields-${side}`);
        if (deckFieldsContainer) {
            deckFieldsContainer.style.display = 'block';
        }

        addDeckModal.hide();
    });

    // Riftbound Legends List
    const riftboundLegendsList = RIFTBOUND_LEGENDS_LIST;
    
    const riftboundChampionsList = RIFTBOUND_CHAMPIONS_LIST;
    
    const riftboundBattlefieldsList = RIFTBOUND_BATTLEFIELDS_LIST;

    // Generate HTML for a single player section
    function renderPlayerSection(roundId, matchId, side, label) {
        // 2v2 AND ffa render four player sections → 4 columns. FFA keeps the
        // individual life/poison/wins fields visible (every player independent);
        // 2v2 hides them in favour of the shared team rows above.
        const colClass = (currentPlayerCount === '2v2' || currentPlayerCount === 'ffa') ? 'col-md-3' : 'col-md-6';
        // In 2v2, only P1 (left) and P3 (right) show shared team life; teammates (left-2, right-2) hide it
        // In 2v2, all individual life fields are hidden — team life is in the shared row above
        const is2v2 = currentPlayerCount === '2v2';
        const hideShared = is2v2 ? 'style="display:none;"' : '';
        return `
                        <div class="${colClass} player-section player-section-${side}">
                            <h5 class="card-title">${label}</h5>
                            <div class="mb-3">
                                <label class="form-label">Player Name</label>
                                <div id="${roundId}-${matchId}-player-name-${side}" class="editable form-control" contenteditable="true"></div>
                            </div>
                            <div class="mb-3 life-points-field" ${hideShared}>
                                <label class="form-label">LifePoints</label>
                                <div class="d-flex align-items-center">
                                    <button class="btn btn-sm btn-outline-danger mtg-only-field life-btn-5" data-life-target="${roundId}-${matchId}-player-life-${side}" data-life-delta="-5">-5</button>
                                    <button class="btn btn-sm btn-outline-secondary life-btn" data-life-target="${roundId}-${matchId}-player-life-${side}" data-life-delta="-1">-1</button>
                                    <div id="${roundId}-${matchId}-player-life-${side}" class="editable form-control text-center mx-1" contenteditable="true"></div>
                                    <button class="btn btn-sm btn-outline-secondary life-btn" data-life-target="${roundId}-${matchId}-player-life-${side}" data-life-delta="1">+1</button>
                                    <button class="btn btn-sm btn-outline-success mtg-only-field life-btn-5" data-life-target="${roundId}-${matchId}-player-life-${side}" data-life-delta="5">+5</button>
                                </div>
                            </div>
                            <div class="mb-3">
                                <label class="form-label">Pronouns</label>
                                <div id="${roundId}-${matchId}-player-pronouns-${side}" class="editable form-control" contenteditable="true"></div>
                            </div>
                            <div class="mb-3 archetype-field">
                                <label class="form-label">Archetype</label>
                                <div id="${roundId}-${matchId}-player-archetype-${side}" class="editable form-control" contenteditable="true"></div>
                            </div>
                            <div class="mb-3 mtg-only-field">
                                <label class="form-label">Mana Symbols</label>
                                <div id="${roundId}-${matchId}-player-mana-symbols-${side}" class="editable form-control" contenteditable="true"></div>
                            </div>
                            <div class="mb-3 record-field" ${hideShared}>
                                <label class="form-label">Record</label>
                                <div id="${roundId}-${matchId}-player-record-${side}" class="editable form-control" contenteditable="true"></div>
                            </div>
                            <div class="mb-3 riftbound-only-field" style="display: none;">
                                <label class="form-label">XP</label>
                                <div class="d-flex align-items-center">
                                    <button class="btn btn-sm btn-outline-secondary life-btn" data-life-target="${roundId}-${matchId}-player-xp-${side}" data-life-delta="-1">-1</button>
                                    <div id="${roundId}-${matchId}-player-xp-${side}" class="editable form-control text-center mx-1" contenteditable="true">0</div>
                                    <button class="btn btn-sm btn-outline-secondary life-btn" data-life-target="${roundId}-${matchId}-player-xp-${side}" data-life-delta="1">+1</button>
                                </div>
                            </div>
                            <div class="mb-3 wins-field" ${hideShared}>
                                <label class="form-label">Wins</label>
                                <div class="d-flex align-items-center">
                                    <button class="btn btn-sm btn-outline-secondary wins-minus-btn" data-target="${roundId}-${matchId}-player-wins-${side}">-</button>
                                    <div id="${roundId}-${matchId}-player-wins-${side}" class="editable form-control text-center mx-1" contenteditable="false" style="width: 50px;">0</div>
                                    <button class="btn btn-sm btn-outline-secondary wins-plus-btn" data-target="${roundId}-${matchId}-player-wins-${side}">+</button>
                                </div>
                            </div>
                            ${!is2v2 ? `<div class="mb-3 mtg-only-field poison-field">
                                <label class="form-label">Poison</label>
                                <div id="${roundId}-${matchId}-player-poison-${side}" class="editable form-control" contenteditable="true"></div>
                            </div>` : ''}
                            <div class="mb-3" style="display: none;">
                                <label class="form-label">Mulligan</label>
                                <div id="${roundId}-${matchId}-player-mulligan-${side}" class="editable form-control" contenteditable="true"></div>
                            </div>
                            <div class="mb-3 riftbound-only-field" style="display: none;">
                                <label class="form-label">Legend</label>
                                <div id="${roundId}-${matchId}-player-legend-${side}" class="editable form-control" contenteditable="true"></div>
                            </div>
                            <div class="mb-3 riftbound-only-field" style="display: none;">
                                <label class="form-label">Champion</label>
                                <div id="${roundId}-${matchId}-player-champion-${side}" class="editable form-control" contenteditable="true"></div>
                            </div>
                            <div class="mb-3 riftbound-only-field" style="display: none;">
                                <label class="form-label">Runes</label>
                                <div class="d-flex gap-2 mb-1">
                                    <div id="${roundId}-${matchId}-player-rune-color-1-${side}" class="editable form-control" contenteditable="true"></div>
                                    <div id="${roundId}-${matchId}-player-rune-qty-1-${side}" class="editable form-control" contenteditable="true"></div>
                                </div>
                                <div class="d-flex gap-2">
                                    <div id="${roundId}-${matchId}-player-rune-color-2-${side}" class="editable form-control" contenteditable="true"></div>
                                    <div id="${roundId}-${matchId}-player-rune-qty-2-${side}" class="editable form-control" contenteditable="true"></div>
                                </div>
                            </div>
                            <!-- Battlefield controls moved OUT of the player
                                 section into a dedicated battlefields row
                                 (renderBattlefieldsRow) so the Baron Pit
                                 control can sit beside them. -->
                            <div class="mb-3 starwars-only-field" style="display: none;">
                                <label class="form-label">Leader & Aspects</label>
                                <div id="${roundId}-${matchId}-player-leader-${side}" class="editable form-control" contenteditable="true"></div>
                                <div class="d-flex gap-2 mt-1">
                                    <div id="${roundId}-${matchId}-player-leader-aspect-1-${side}" class="editable form-control" contenteditable="true" placeholder="aspect 1" style="flex: 1;"></div>
                                    <div id="${roundId}-${matchId}-player-leader-aspect-2-${side}" class="editable form-control" contenteditable="true" placeholder="aspect 2" style="flex: 1;"></div>
                                </div>
                            </div>
                            <div class="mb-3 starwars-only-field" style="display: none;">
                                <label class="form-label">Base & Aspect</label>
                                <div class="d-flex gap-2">
                                    <div id="${roundId}-${matchId}-player-base-${side}" class="editable form-control" contenteditable="true" style="flex: 1;"></div>
                                    <div id="${roundId}-${matchId}-player-base-aspects-${side}" class="editable form-control" contenteditable="true" placeholder="aspect" style="width: 120px; flex-shrink: 0;"></div>
                                </div>
                            </div>
                            <div class="mb-3 starwars-only-field" style="display: none;">
                                <div class="d-flex gap-3 swu-base-stats-container">
                                    <div>
                                        <label class="form-label">Base HP</label>
                                        <div class="d-flex align-items-center">
                                            <button class="btn btn-sm btn-outline-secondary life-btn" data-life-target="${roundId}-${matchId}-player-base-hp-${side}" data-life-delta="-1">-1</button>
                                            <div id="${roundId}-${matchId}-player-base-hp-${side}" class="editable form-control text-center mx-1" contenteditable="true" style="width: 60px;">30</div>
                                            <button class="btn btn-sm btn-outline-secondary life-btn" data-life-target="${roundId}-${matchId}-player-base-hp-${side}" data-life-delta="1">+1</button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>`;
    }

    // Generate HTML for a player's deck section
    // Riftbound Showdown Might tracker — match-level (not per-player).
    // Generates the per-match block of controls that drive the
    // scoreboard's slide-in showdown overlay (PSD center-bottom).
    //
    // Fields per match (sent via the standard control-data flow):
    //   showdown-visible           'true' | 'false'  — slide-in toggle
    //   showdown-active-bf         '1' | '2' | '3'   — which BF is displayed
    //   showdown-bf-3-enabled      'true' | 'false'  — adds Baron Pit slot
    //   showdown-bf-{N}-name       text              — display name override
    //   showdown-bf-{N}-left-might  integer
    //   showdown-bf-{N}-right-might integer
    //
    // BF #1 default name = player-battlefield-left (left player's active BF).
    // BF #2 default name = player-battlefield-right (right player's active).
    // BF #3 name is fixed to "Baron Pit" when enabled.
    // Names are auto-populated when blank — operator can override per slot.
    // Battlefield controls for one player slot (the inner content only — the
    // column wrapper is supplied by renderBattlefieldsRow). 2v2 = single
    // editable field + Hide toggle; 1v1 = 3-radio pre-selected list + Brush
    // Override.
    function renderBattlefieldBlock(roundId, matchId, side, is2v2) {
        const prefix = `${roundId}-${matchId}`;
        if (is2v2) {
            return `
                <div class="d-flex align-items-center justify-content-between mb-1">
                    <label class="form-label mb-0">Battlefield</label>
                    <label class="d-flex align-items-center mb-0 small text-muted" title="Hide this battlefield from the /scoreboard L3 strip">
                        <span class="me-2">Hide</span>
                        <input type="checkbox" class="form-check-input battlefield-hide-toggle m-0" data-slot="${side}">
                    </label>
                </div>
                <div id="${prefix}-player-battlefield-${side}" class="editable form-control battlefield-input" contenteditable="true"></div>`;
        }
        return `
                <div class="d-flex align-items-center justify-content-between mb-1">
                    <label class="form-label mb-0">Battlefield</label>
                    <!-- Brush is a TOKEN battlefield (not one of the player's
                         3) — Pressed = override, the hidden field is forced
                         to "Brush" regardless of radio selection. -->
                    <button type="button" class="btn btn-sm btn-outline-secondary brush-override-btn" aria-pressed="false" data-side="${side}" data-round="${roundId}" data-match="${matchId}">Brush Override</button>
                </div>
                <div class="d-flex align-items-center mb-1">
                    <input type="radio" name="${prefix}-bf-${side}-select" class="form-check-input me-2 battlefield-radio" data-side="${side}" data-round="${roundId}" data-match="${matchId}" data-bf="1" value="1" checked>
                    <div id="${prefix}-player-battlefield-1-${side}" class="editable form-control battlefield-input" contenteditable="true"></div>
                </div>
                <div class="d-flex align-items-center mb-1">
                    <input type="radio" name="${prefix}-bf-${side}-select" class="form-check-input me-2 battlefield-radio" data-side="${side}" data-round="${roundId}" data-match="${matchId}" data-bf="2" value="2">
                    <div id="${prefix}-player-battlefield-2-${side}" class="editable form-control battlefield-input" contenteditable="true"></div>
                </div>
                <div class="d-flex align-items-center">
                    <input type="radio" name="${prefix}-bf-${side}-select" class="form-check-input me-2 battlefield-radio" data-side="${side}" data-round="${roundId}" data-match="${matchId}" data-bf="3" value="3">
                    <div id="${prefix}-player-battlefield-3-${side}" class="editable form-control battlefield-input" contenteditable="true"></div>
                </div>
                <div id="${prefix}-player-battlefield-${side}" class="editable" style="display:none;"></div>`;
    }

    // Dedicated Battlefields row (riftbound only). 1v1: Left BF | Right BF |
    // Baron Pit. 2v2: one column per player (no Baron). Wrapped in a block
    // div so toggleGameFields' display:block doesn't break the .row flex.
    // The Baron Pit column holds the enable checkbox + its Brush Override —
    // enabling reveals the Showdown Might Tracker's BF 3 row (name
    // auto-filled "Baron Pit"); the Brush Override forces BF 3 → "Brush".
    function renderBattlefieldsRow(roundId, matchId) {
        const prefix = `${roundId}-${matchId}`;
        const is2v2 = currentPlayerCount === '2v2';
        if (is2v2) {
            const col = (side, label) => `
                <div class="col-md-3">
                    <h6 class="text-muted small mb-1">${label}</h6>
                    ${renderBattlefieldBlock(roundId, matchId, side, true)}
                </div>`;
            return `
                <div class="riftbound-only-field" style="display:none;">
                    <div class="row mb-3 battlefields-row">
                        ${col('left', 'P1 (Team A)')}${col('left-2', 'P2 (Team A)')}${col('right', 'P3 (Team B)')}${col('right-2', 'P4 (Team B)')}
                    </div>
                </div>`;
        }
        return `
            <div class="riftbound-only-field" style="display:none;">
                <div class="row mb-3 battlefields-row">
                    <div class="col-md-5">
                        <h6 class="text-muted small mb-1">Left Player</h6>
                        ${renderBattlefieldBlock(roundId, matchId, 'left', false)}
                    </div>
                    <div class="col-md-5">
                        <h6 class="text-muted small mb-1">Right Player</h6>
                        ${renderBattlefieldBlock(roundId, matchId, 'right', false)}
                    </div>
                    <div class="col-md-2 baron-pit-section">
                        <h6 class="text-muted small mb-1">Baron Pit</h6>
                        <label class="d-flex align-items-center mb-2 small">
                            <input type="checkbox" id="${prefix}-showdown-bf-3-enabled" class="form-check-input me-2 showdown-baron-pit-toggle" data-round="${roundId}" data-match="${matchId}">
                            Enable (BF 3)
                        </label>
                        <button type="button" class="btn btn-sm btn-outline-secondary baron-brush-override-btn w-100" aria-pressed="false" data-round="${roundId}" data-match="${matchId}">Brush Override</button>
                    </div>
                </div>
            </div>`;
    }

    function renderShowdownMightSection(roundId, matchId) {
        const prefix = `${roundId}-${matchId}`;
        const bfRow = (n, defaultName, hideClass) => `
            <div class="showdown-bf-row ${hideClass || ''}" data-bf="${n}" style="display: flex; gap: 8px; align-items: end; margin-bottom: 8px;">
                <div style="flex: 1;">
                    <label class="form-label mb-0 small text-muted">BF ${n} Name${defaultName ? ` (default: ${defaultName})` : ''}</label>
                    <div id="${prefix}-showdown-bf-${n}-name" class="editable form-control" contenteditable="true" placeholder="${defaultName || ''}"></div>
                </div>
                <div style="width: 80px;">
                    <label class="form-label mb-0 small text-muted">Left Might</label>
                    <div id="${prefix}-showdown-bf-${n}-left-might" class="editable form-control text-center" contenteditable="true">0</div>
                </div>
                <div style="width: 80px;">
                    <label class="form-label mb-0 small text-muted">Right Might</label>
                    <div id="${prefix}-showdown-bf-${n}-right-might" class="editable form-control text-center" contenteditable="true">0</div>
                </div>
                <div style="width: 100px;">
                    <label class="form-label mb-0 small text-muted">Active</label>
                    <div class="form-check">
                        <input type="radio" name="${prefix}-showdown-active-bf" value="${n}" class="form-check-input showdown-active-bf-radio" data-round="${roundId}" data-match="${matchId}" data-bf="${n}" ${n === 1 ? 'checked' : ''}>
                        <label class="form-check-label small">Showdown here</label>
                    </div>
                </div>
            </div>`;
        return `
            <div class="row riftbound-only-field showdown-might-section mt-3" style="display: none;">
                <div class="col-12">
                    <div class="card border-warning">
                        <div class="card-body">
                            <div class="d-flex align-items-center justify-content-between mb-2">
                                <h6 class="card-title mb-0">Showdown Might Tracker</h6>
                                <button type="button" class="btn btn-sm btn-outline-primary showdown-visible-toggle" data-round="${roundId}" data-match="${matchId}" aria-pressed="false">
                                    Show on Scoreboard
                                </button>
                            </div>
                            ${bfRow(1, "Left player's battlefield")}
                            ${bfRow(2, "Right player's battlefield")}
                            ${bfRow(3, 'Baron Pit', 'showdown-bf-3-row d-none')}
                        </div>
                    </div>
                </div>
            </div>`;
    }

    function renderDeckSection(roundId, matchId, side, label) {
        const colClass = currentPlayerCount === '2v2' ? 'col-md-3' : 'col-md-6';
        return `
                        <div class="${colClass} deck-section deck-section-${side}">
                            <h5 class="card-title">${label} Deck
                                <button class="btn btn-sm btn-outline-primary add-deck-btn"
                                        data-side="${side}" data-round="${roundId}" data-match="${matchId}">Add</button>
                            </h5>
                            <div class="deck-fields" id="${roundId}-${matchId}-deck-fields-${side}" style="display: none;">
                                <div class="mb-3">
                                    <label class="form-label">Main Deck</label>
                                    <textarea id="${roundId}-${matchId}-player-main-deck-${side}"
                                            class="editable form-control"
                                            rows="5"
                                            placeholder="Enter main deck cards (separated by new lines)"></textarea>
                                </div>
                                <div class="mb-3">
                                    <label class="form-label">Side Deck</label>
                                    <textarea id="${roundId}-${matchId}-player-side-deck-${side}"
                                            class="editable form-control"
                                            rows="3"
                                            placeholder="Enter side deck cards (separated by new lines)"></textarea>
                                </div>
                                <div class="my-3">
                                    <button class="btn btn-primary" id="display-deck-${side}-${roundId}-${matchId}">Display Deck</button>
                                </div>
                            </div>
                        </div>`;
    }

    // Function to render or update a match card
    function renderMatch(roundId, matchId, matchData) {
        // Check if a card for this match already exists
        let matchContainer = document.getElementById(`round-${roundId}-matches`);
        let matchCard = document.getElementById(`match-card-${roundId}-${matchId}`);

        if (!matchCard) {
            // Create new card (use your existing card HTML structure)
            matchCard = document.createElement('div');
            matchCard.classList.add((currentPlayerCount === '2v2' || currentPlayerCount === 'ffa') ? 'col-12' : 'col-6', 'mb-3', 'match-card-container');
            matchCard.id = `match-card-${roundId}-${matchId}`;
            matchCard.innerHTML = `
            <div class="row mb-2">
                <div class="col-4 d-flex flex-row justify-content-start align-items-center" style="position: relative; z-index: 1;">
                    <h3 class="match-id-name mb-0">${roundId}-${matchId}</h3>
                    <div class="ms-3 d-flex align-items-center">
                        <label class="form-label me-2 mb-0" style="white-space: nowrap;">Table #</label>
                        <input type="number" id="table-number-${roundId}-${matchId}"
                               class="form-control form-control-sm" style="width: 70px;"
                               placeholder="1" min="1">
                        <button class="btn btn-sm btn-info ms-2 fetch-table-btn"
                                id="fetch-table-${roundId}-${matchId}"
                                data-round-id="${roundId}" data-match-id="${matchId}">
                            Fetch
                        </button>
                    </div>
                </div>
                <div class="col-8 d-flex flex-row justify-content-end flex-wrap">
                    <button id="reset-life-${roundId}-${matchId}" class="btn btn-warning reset-life-button me-2" data-match-id="${matchId}"
                            data-round-id="${roundId}">Reset Life
                    </button>
                    <button id="control-1-${roundId}-${matchId}" class="btn btn-secondary control-button me-2" data-match-id="${matchId}"
                            data-round-id="${roundId}" data-control-id="1">Control 1
                    </button>
                    <button id="control-2-${roundId}-${matchId}" class="btn btn-secondary control-button me-2" data-match-id="${matchId}"
                            data-round-id="${roundId}" data-control-id="2">Control 2
                    </button>
                    <button id="control-3-${roundId}-${matchId}" class="btn btn-secondary control-button me-2" data-match-id="${matchId}"
                            data-round-id="${roundId}" data-control-id="3">Control 3
                    </button>
                    <button id="control-4-${roundId}-${matchId}" class="btn btn-secondary control-button" data-match-id="${matchId}"
                            data-round-id="${roundId}" data-control-id="4">Control 4
                    </button>
                </div>
            </div>
            <div class="card">
                <div class="card-body">
                    <div class="row mb-4">
                        <!-- Event Information -->
                        <div class="col-12">
                            <div class="row">
                                <div class="col-12">
                                    <div class="timer-container">
                                        <div id="timer-${roundId}-${matchId}" class="timer-text">50:00</div>
                                        <button id="timer-add-${roundId}-${matchId}" class="btn timer-button font-40" >+</button>
                                        <button id="timer-minus-${roundId}-${matchId}" class="btn timer-button font-40" >-</button>
                                        <button id="timer-start-${roundId}-${matchId}" class="btn timer-button">▶</button>
                                        <button id="timer-pause-${roundId}-${matchId}" class="btn timer-button">⏸</button>
                                        <button id="timer-reset-${roundId}-${matchId}" class="btn timer-button">⭮</button>
                                    </div>
                                </div>
                                <div class="col-12 text-center">
                                    <label>
                                        <input type="checkbox" id="timer-display-scoreboard-${roundId}-${matchId}"> Show Timer on Scoreboard
                                    </label>
                                    <label class="ms-3">
                                        <input type="checkbox" id="timer-count-up-${roundId}-${matchId}"> Count Up
                                    </label>
                                </div>
                                <div class="col-12 text-center">
                                    <label>
                                        <input type="checkbox" id="wins-display-scoreboard-${roundId}-${matchId}"> Show Wins on Scoreboard
                                    </label>
                                </div>
                                <div class="col-12">
                                    <h5 class="card-title">Event Information</h5>
                                </div>
                                <div class="col-4">
                                    <div class="mb-3">
                                        <label class="form-label">Event Name</label>
                                        <div id="${roundId}-${matchId}-event-name" class="editable form-control" contenteditable="false"></div>
                                    </div>
                                </div>
                                <div class="col-4">
                                    <div class="mb-3">
                                        <label class="form-label">Event Round</label>
                                        <div id="${roundId}-${matchId}-event-round" class="editable form-control" contenteditable="true"></div>
                                    </div>
                                </div>
                                <div class="col-4">
                                    <div class="mb-3">
                                        <label class="form-label">Event Format</label>
                                        <div id="${roundId}-${matchId}-event-format" class="editable form-control" contenteditable="false"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <hr>
                        ${currentPlayerCount === '2v2' ? `
                        <div class="col-12">
                            <div class="row">
                                <div class="col-md-6"><h4 class="text-info mb-0">Team A (Top)</h4></div>
                                <div class="col-md-6"><h4 class="text-success mb-0">Team B (Bottom)</h4></div>
                            </div>
                        </div>
                        ` : ''}
                        ${currentPlayerCount === '2v2' ? `
                        <div class="col-md-6 team-shared-section team-shared-section-left">
                            <div class="d-flex gap-3 align-items-end mb-3">
                                <div class="team-life-field" style="flex: 1;">
                                    <label class="form-label">Team A Life</label>
                                    <div class="d-flex align-items-center">
                                        <button class="btn btn-sm btn-outline-danger mtg-only-field life-btn-5" data-life-target="${roundId}-${matchId}-player-life-left" data-life-delta="-5">-5</button>
                                        <button class="btn btn-sm btn-outline-secondary life-btn" data-life-target="${roundId}-${matchId}-player-life-left" data-life-delta="-1">-1</button>
                                        <div id="${roundId}-${matchId}-player-life-left" class="editable form-control text-center mx-1" contenteditable="true"></div>
                                        <button class="btn btn-sm btn-outline-secondary life-btn" data-life-target="${roundId}-${matchId}-player-life-left" data-life-delta="1">+1</button>
                                        <button class="btn btn-sm btn-outline-success mtg-only-field life-btn-5" data-life-target="${roundId}-${matchId}-player-life-left" data-life-delta="5">+5</button>
                                    </div>
                                </div>
                                <div style="width: 70px;">
                                    <label class="form-label">Poison</label>
                                    <div id="${roundId}-${matchId}-player-poison-left" class="editable form-control text-center" contenteditable="true">0</div>
                                </div>
                                <div>
                                    <label class="form-label">Wins</label>
                                    <div class="d-flex align-items-center">
                                        <button class="btn btn-sm btn-outline-secondary wins-minus-btn" data-target="${roundId}-${matchId}-player-wins-left">-</button>
                                        <div id="${roundId}-${matchId}-player-wins-left" class="editable form-control text-center mx-1" contenteditable="false" style="width: 50px;">0</div>
                                        <button class="btn btn-sm btn-outline-secondary wins-plus-btn" data-target="${roundId}-${matchId}-player-wins-left">+</button>
                                    </div>
                                </div>
                                <div style="width: 100px;">
                                    <label class="form-label">Record</label>
                                    <div id="${roundId}-${matchId}-player-record-left" class="editable form-control" contenteditable="true"></div>
                                </div>
                            </div>
                        </div>
                        <div class="col-md-6 team-shared-section team-shared-section-right">
                            <div class="d-flex gap-3 align-items-end mb-3">
                                <div class="team-life-field" style="flex: 1;">
                                    <label class="form-label">Team B Life</label>
                                    <div class="d-flex align-items-center">
                                        <button class="btn btn-sm btn-outline-danger mtg-only-field life-btn-5" data-life-target="${roundId}-${matchId}-player-life-right" data-life-delta="-5">-5</button>
                                        <button class="btn btn-sm btn-outline-secondary life-btn" data-life-target="${roundId}-${matchId}-player-life-right" data-life-delta="-1">-1</button>
                                        <div id="${roundId}-${matchId}-player-life-right" class="editable form-control text-center mx-1" contenteditable="true"></div>
                                        <button class="btn btn-sm btn-outline-secondary life-btn" data-life-target="${roundId}-${matchId}-player-life-right" data-life-delta="1">+1</button>
                                        <button class="btn btn-sm btn-outline-success mtg-only-field life-btn-5" data-life-target="${roundId}-${matchId}-player-life-right" data-life-delta="5">+5</button>
                                    </div>
                                </div>
                                <div style="width: 70px;">
                                    <label class="form-label">Poison</label>
                                    <div id="${roundId}-${matchId}-player-poison-right" class="editable form-control text-center" contenteditable="true">0</div>
                                </div>
                                <div>
                                    <label class="form-label">Wins</label>
                                    <div class="d-flex align-items-center">
                                        <button class="btn btn-sm btn-outline-secondary wins-minus-btn" data-target="${roundId}-${matchId}-player-wins-right">-</button>
                                        <div id="${roundId}-${matchId}-player-wins-right" class="editable form-control text-center mx-1" contenteditable="false" style="width: 50px;">0</div>
                                        <button class="btn btn-sm btn-outline-secondary wins-plus-btn" data-target="${roundId}-${matchId}-player-wins-right">+</button>
                                    </div>
                                </div>
                                <div style="width: 100px;">
                                    <label class="form-label">Record</label>
                                    <div id="${roundId}-${matchId}-player-record-right" class="editable form-control" contenteditable="true"></div>
                                </div>
                            </div>
                        </div>
                        ` : ''}
                        ${currentPlayerCount === 'ffa' ? `
                        <div class="col-12 mb-2">
                            <div class="form-check form-switch">
                                <input class="form-check-input ffa-life-toggle" type="checkbox"
                                       id="${roundId}-${matchId}-ffa-life-visible-toggle"
                                       data-round="${roundId}" data-match="${matchId}"
                                       ${(matchData && matchData['ffa-life-visible']) === 'false' ? '' : 'checked'}>
                                <label class="form-check-label" for="${roundId}-${matchId}-ffa-life-visible-toggle">
                                    Show life totals on scoreboard (turn off when a table app tracks life)
                                </label>
                            </div>
                        </div>` : ''}
                        ${renderPlayerSection(roundId, matchId, 'left', currentPlayerCount === '2v2' ? 'P1 (Team A)' : (currentPlayerCount === 'ffa' ? 'Player 1' : 'Left Player'))}
                        ${currentPlayerCount === '2v2' ? renderPlayerSection(roundId, matchId, 'left-2', 'P2 (Team A)') : ''}
                        ${currentPlayerCount === 'ffa' ? renderPlayerSection(roundId, matchId, 'left-2', 'Player 2') : ''}
                        ${renderPlayerSection(roundId, matchId, 'right', currentPlayerCount === '2v2' ? 'P3 (Team B)' : (currentPlayerCount === 'ffa' ? 'Player 3' : 'Right Player'))}
                        ${currentPlayerCount === '2v2' ? renderPlayerSection(roundId, matchId, 'right-2', 'P4 (Team B)') : ''}
                        ${currentPlayerCount === 'ffa' ? renderPlayerSection(roundId, matchId, 'right-2', 'Player 4') : ''}
                    </div>

                    <!-- Battlefields (riftbound): Left BF | Right BF | Baron Pit -->
                    ${renderBattlefieldsRow(roundId, matchId)}

                    <!-- Deck information -->
                    <div class="row">
                        ${renderDeckSection(roundId, matchId, 'left', currentPlayerCount === '2v2' ? 'P1' : (currentPlayerCount === 'ffa' ? 'Player 1' : 'Left Player'))}
                        ${(currentPlayerCount === '2v2' || currentPlayerCount === 'ffa') ? renderDeckSection(roundId, matchId, 'left-2', currentPlayerCount === 'ffa' ? 'Player 2' : 'P2') : ''}
                        ${renderDeckSection(roundId, matchId, 'right', currentPlayerCount === '2v2' ? 'P3' : (currentPlayerCount === 'ffa' ? 'Player 3' : 'Right Player'))}
                        ${(currentPlayerCount === '2v2' || currentPlayerCount === 'ffa') ? renderDeckSection(roundId, matchId, 'right-2', currentPlayerCount === 'ffa' ? 'Player 4' : 'P4') : ''}
                    </div>

                    <!-- Showdown Might tracker (riftbound 1v1) -->
                    ${currentPlayerCount !== '2v2' ? renderShowdownMightSection(roundId, matchId) : ''}

                </div>
            </div>
        `;
            // Add the new card to the round's match container
            matchContainer.appendChild(matchCard);
            // Toggle Riftbound fields visibility based on current game selection
            toggleGameFields(currentGameSelection);
            // Attach change listeners
            attachChangeListeners(roundId, matchId);
            // Attach the deck display listeners after rendering
            attachDeckDisplayListeners(roundId, matchId);
            // Attach control mapping listeners
            attachControlMappingButtonListeners(roundId, matchId);
            // Attach reset life listener
            attachMatchResetLifeButtonListeners(roundId, matchId);
            // Attach timer listeners
            attachMatchTimerButtonListeners(roundId, matchId);
            // Attach show wins listener
            attachMatchShowWinsCheckboxListener(roundId, matchId);
            // Attach fetch table button listener
            attachFetchTableButtonListener(roundId, matchId);
        }

        // Update the fields with the match data
        Object.keys(matchData).forEach(key => {
            const fieldElement = document.getElementById(`${roundId}-${matchId}-${key}`);
            if (fieldElement) {
                if (fieldElement.tagName.toLowerCase() === 'textarea') {
                    if (key.includes('main-deck') || key.includes('side-deck')) {
                        // Join array elements with newlines for deck lists
                        fieldElement.value = Array.isArray(matchData[key])
                            ? matchData[key].join('\n')
                            : matchData[key];
                    } else {
                        fieldElement.value = matchData[key];
                    }
                } else {
                    fieldElement.textContent = matchData[key];
                }
            }
        });

        // Restore Showdown Might section state from saved control data.
        // The generic loop above already restores the contenteditable
        // might values (they're .editable contenteditable divs). What's
        // left: the button's aria-pressed (showdown-visible), the radio
        // group's :checked (showdown-active-bf), and the Baron Pit
        // checkbox + BF-3 row visibility (showdown-bf-3-enabled).
        const showdownVisible = matchData['showdown-visible'] === 'true';
        const showdownVisibleBtn = document.querySelector(`#match-card-${roundId}-${matchId} .showdown-visible-toggle`);
        if (showdownVisibleBtn) {
            showdownVisibleBtn.setAttribute('aria-pressed', String(showdownVisible));
            showdownVisibleBtn.textContent = showdownVisible ? 'Hide from Scoreboard' : 'Show on Scoreboard';
        }
        const activeBf = matchData['showdown-active-bf'] || '1';
        const activeBfRadio = document.querySelector(`#match-card-${roundId}-${matchId} .showdown-active-bf-radio[data-bf="${activeBf}"]`);
        if (activeBfRadio) activeBfRadio.checked = true;
        const baronPitEnabled = matchData['showdown-bf-3-enabled'] === 'true';
        const baronPitCb = document.getElementById(`${roundId}-${matchId}-showdown-bf-3-enabled`);
        if (baronPitCb) baronPitCb.checked = baronPitEnabled;
        const bf3Row = document.querySelector(`#match-card-${roundId}-${matchId} .showdown-bf-3-row`);
        if (bf3Row) bf3Row.classList.toggle('d-none', !baronPitEnabled);

        // Sync active battlefield radio slot → hidden player-battlefield field.
        // Update allControlData DIRECTLY (without dispatching an input event)
        // so the server has the value, but we avoid flooding /scoreboard/* pages
        // with N-match-wide redundant emissions on every page load. The next
        // master-control-matches-updated emission (triggered by any user edit)
        // will carry the now-correct battlefield value to all scoreboards.
        // Without this, the hidden field has the right text in the DOM but
        // allControlData[round][match]['player-battlefield-{side}'] stays empty,
        // so scoreboards never see the active battlefield.
        for (const side of ['left', 'right', 'left-2', 'right-2']) {
            const checkedRadio = document.querySelector(`input[name="${roundId}-${matchId}-bf-${side}-select"]:checked`);
            if (checkedRadio) {
                const bfNum = checkedRadio.dataset.bf;
                const sourceEl = document.getElementById(`${roundId}-${matchId}-player-battlefield-${bfNum}-${side}`);
                const mainField = document.getElementById(`${roundId}-${matchId}-player-battlefield-${side}`);
                if (sourceEl && mainField) {
                    const text = sourceEl.innerText;
                    mainField.innerText = text;
                    // Mirror into allControlData so it ships with the next emission.
                    if (typeof updateControlData === 'function') {
                        updateControlData(roundId, matchId, `player-battlefield-${side}`, text);
                    }
                    // Auto-populate showdown BF name fields based on active
                    // radio / brush override. Left → BF 1, Right → BF 2.
                    // (Skip the 2v2 inner slots — showdown is 1v1-only.)
                    if (side === 'left' || side === 'right') {
                        const bfNum = side === 'left' ? '1' : '2';
                        const showdownNameEl = document.getElementById(`${roundId}-${matchId}-showdown-bf-${bfNum}-name`);
                        if (showdownNameEl && showdownNameEl.innerText !== text) {
                            showdownNameEl.innerText = text;
                            if (typeof updateControlData === 'function') {
                                updateControlData(roundId, matchId, `showdown-bf-${bfNum}-name`, text);
                            }
                        }
                    }
                }
            }
        }

        // Unhide deck fields if existing deck data is present
        for (const side of ['left', 'right', 'left-2', 'right-2']) {
            const mainDeck = matchData[`player-main-deck-${side}`];
            const hasDeckData = Array.isArray(mainDeck)
                ? mainDeck.some(line => line.trim() !== '')
                : (typeof mainDeck === 'string' && mainDeck.trim() !== '');
            if (hasDeckData) {
                const deckFieldsContainer = document.getElementById(`${roundId}-${matchId}-deck-fields-${side}`);
                if (deckFieldsContainer) deckFieldsContainer.style.display = 'block';
            }
        }
    }

    // Function to attach change listeners to all editable fields for a given match ID
    function attachChangeListeners(roundId, matchId) {
        const editableFields = document.querySelectorAll(`#match-card-${roundId}-${matchId} .editable`);
        editableFields.forEach(field => {
            field.addEventListener('input', (e) => {
                let value;

                // Handle deck lists as arrays
                if (field.tagName.toLowerCase() === 'textarea' &&
                    (field.id.includes('main-deck') || field.id.includes('side-deck'))) {
                    // Split by newlines and/or commas, trim whitespace, and filter empty strings
                    let parsedDeck = parseDeckString(field.value);

                    // Update various fields as needed (Legend, Champion, etc.) (Currently only needed for Riftbound, but who knows?)
                    // Strip the well-known prefix so the side suffix survives the dash-split
                    // ("round1-match1-player-main-deck-left-2" → "left-2", not "left").
                    const idSuffix = e.target['id'].replace(`${roundId}-${matchId}-player-main-deck-`, '');
                    const sideId = idSuffix; // 'left' | 'left-2' | 'right' | 'right-2'
                    if (currentGameSelection === 'riftbound') {
                        updateRiftboundFields(parsedDeck, roundId, matchId, sideId);
                    }
                    
                    value = field.value
                        .split(/\n+/)
                        .map(card => card.trim())
                        .filter(card => card !== '');
                } else {
                    // Handle other fields normally
                    value = field.tagName.toLowerCase() === 'textarea' ? field.value : field.textContent;
                }

                // check if event round is being updated
                if (field.id.includes('event-round')) {
                    // Dynamically select all event-round fields for this round and matches
                    const eventFields = document.querySelectorAll(`[id^="${roundId}-match"][id$="-event-round"]`);
                    eventFields.forEach(eventField => {
                        // Avoid updating the field currently being edited
                        if (eventField !== field) {
                            eventField.innerText = value;
                        }
                    });
                    // Update control data for all matches in this round
                    Object.keys(allControlData[roundId]).forEach(matchId => {
                        allControlData[roundId][matchId]['event-round'] = value;
                    });
                }

                // Update the local control data when a field changes
                const fieldKey = field.id.replace(`${roundId}-${matchId}-`, '');
                updateControlData(roundId, matchId, fieldKey, value);
                // Emit the updated control data to the backend
                console.log('updated all data', allControlData);
                socket.emit('master-control-matches-updated', allControlData);
            });
        });
    }

    // parse deck string into an object of multiple array categories
    // Parse a pasted decklist string into categorized sections.
    // Recognizes section headers with or without colons across all games.
    function parseDeckString(decklist) {
        // Known section headers (normalized) → canonical section name
        const KNOWN_HEADERS = {
            'maindeck':       'maindeck',
            'main':           'maindeck',
            'sideboard':      'sideboard',
            'side':           'sideboard',
            'legend':         'legend',
            'champion':       'champion',
            'chosenchampion': 'champion',
            'runepool':       'runepool',
            'runes':          'runepool',
            'rune':           'runepool',
            'battlefield':    'battlefield',
            'battlefields':   'battlefield',
            'units':          'maindeck',
            'spells':         'maindeck',
            'leader':         'leader',
            'base':           'base',
        };

        const result = {};
        let currentSection = null;

        const lines = decklist.split("\n");

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Normalize for header matching: strip colon, "(N)", non-alphanumeric
            const normalized = trimmed
                .replace(/:$/, '')
                .replace(/\s*\(\d+\)\s*$/, '')
                .toLowerCase()
                .replace(/[^a-z0-9]/g, '');

            // Check if this line is a section header (with or without colon)
            // A line is a header if it matches a known header AND doesn't start with a number (card quantity)
            const isHeader = KNOWN_HEADERS[normalized] !== undefined
                || (normalized.includes('rune') && !trimmed.match(/^\d/));

            if (isHeader && !trimmed.match(/^\d/)) {
                let sectionName = KNOWN_HEADERS[normalized];
                // Fallback: rune-containing headers → runepool
                if (!sectionName && normalized.includes('rune')) {
                    sectionName = 'runepool';
                }
                currentSection = sectionName;
                if (!result[currentSection]) result[currentSection] = [];
                continue;
            }

            // Normalize card name: convert " | " separator to ", " (SWU paste format → melee.gg convention)
            const cardLine = trimmed.replace(/\s*\|\s*/g, ', ');

            // Card line — add to current section or default bucket
            if (currentSection) {
                if (!result[currentSection]) result[currentSection] = [];
                result[currentSection].push(cardLine);
            } else {
                // Cards before any header go to 'maindeck'
                if (!result['maindeck']) result['maindeck'] = [];
                result['maindeck'].push(cardLine);
            }
        }
        return result;
    }

    // Function to update Riftbound-specific fields based on parsed deck data
    function updateRiftboundFields(parsedDeck, roundId, matchId, sideId) {
        // Only update fields that are present in the parsed deck — don't blank out existing values
        // when the user is just editing individual card lines

        // Legend — dispatch input+change (like the manual dropdown select and the
        // battlefield/rune fields below) so the field update propagates and the
        // server re-resolves the legend image on the decklist. Without this, "Add
        // Decklist" set the text but never fired an event, so the decklist display
        // kept the old legend until the field was re-selected by hand.
        if (parsedDeck['legend']?.length) {
            let legendField = document.getElementById(`${roundId}-${matchId}-player-legend-${sideId}`);
            let legendName = parsedDeck['legend'][0].substring(2); // remove quantity prefix
            if (legendField) {
                legendField.innerText = legendName;
                legendField.dispatchEvent(new Event('input', { bubbles: true }));
                legendField.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }

        // Champion — same fix as Legend above.
        if (parsedDeck['champion']?.length) {
            let championField = document.getElementById(`${roundId}-${matchId}-player-champion-${sideId}`);
            let championName = parsedDeck['champion'][0].substring(2); // remove quantity prefix
            if (championField) {
                championField.innerText = championName;
                championField.dispatchEvent(new Event('input', { bubbles: true }));
                championField.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }

        // Battlefield — only update if battlefields are in the pasted deck
        if (parsedDeck['battlefield']?.length) {
            const battlefields = parsedDeck['battlefield'].slice(0, 3);
            for (let i = 0; i < 3; i++) {
                const bfEl = document.getElementById(`${roundId}-${matchId}-player-battlefield-${i + 1}-${sideId}`);
                if (bfEl) {
                    bfEl.innerText = battlefields[i] ? battlefields[i].substring(2) : '';
                    // Dispatch input (like the legend/champion/rune fields above) so
                    // the slot value flows into allControlData and is emitted — without
                    // this the battlefields never reach the server, so a mapped
                    // admin-control / scoreboard never sees the imported battlefields.
                    bfEl.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
            const radio1 = document.querySelector(`input[name="${roundId}-${matchId}-bf-${sideId}-select"][value="1"]`);
            if (radio1) { radio1.checked = true; radio1.dispatchEvent(new Event('change', { bubbles: true })); }
        }

        // Runes — only update if runes are in the pasted deck
        if (parsedDeck['runepool']?.length) {
            const runeLetterToName = { 'r': 'Fury', 'g': 'Calm', 'b': 'Mind', 'o': 'Body', 'p': 'Chaos', 'y': 'Order' };
            const nameToLetter = Object.fromEntries(Object.entries(runeLetterToName).map(([k, v]) => [v, k]));
            const runeOrder = ['r', 'g', 'b', 'o', 'p', 'y'];
            const runes = parsedDeck['runepool'].map(entry => {
                const parts = entry.split(' ');
                return { qty: parts[0], letter: nameToLetter[parts[1]] || '' };
            }).filter(r => r.letter).sort((a, b) => runeOrder.indexOf(a.letter) - runeOrder.indexOf(b.letter));
            for (let i = 0; i < 2; i++) {
                const colorEl = document.getElementById(`${roundId}-${matchId}-player-rune-color-${i + 1}-${sideId}`);
                const qtyEl = document.getElementById(`${roundId}-${matchId}-player-rune-qty-${i + 1}-${sideId}`);
                if (colorEl) { colorEl.textContent = runes[i]?.letter || ''; colorEl.dispatchEvent(new Event('input', { bubbles: true })); }
                if (qtyEl) { qtyEl.textContent = runes[i]?.qty || ''; qtyEl.dispatchEvent(new Event('input', { bubbles: true })); }
            }
        }
    }

    // Function to update the control data for a specific match
    function updateControlData(roundId, matchId, key, value) {
        if (!allControlData[roundId]) {
            allControlData[roundId] = {};
        }
        if (!allControlData[roundId][matchId]) {
            allControlData[roundId][matchId] = {};
        }
        console.log(roundId, matchId, key, value)
        allControlData[roundId][matchId][key] = value;
    }

    function renderDropdownList(dropdownList, items, field) {
        dropdownList.innerHTML = '';
        items.forEach(item => {
            const div = document.createElement('div');
            div.textContent = item.name;
            div.classList.add('dropdown-item');
            div.addEventListener('click', function () {
                field.textContent = item.name;
                dropdownList.style.display = 'none';
                field.dispatchEvent(new Event('input', { bubbles: true }));
                field.dispatchEvent(new Event('change', { bubbles: true }));
            });
            dropdownList.appendChild(div);
        });
        dropdownList.style.display = items.length > 0 ? 'block' : 'none';
    }

    function renderSWUDropdownList(dropdownList, items, field, onSelect, nameTransform) {
        dropdownList.innerHTML = '';
        items.forEach(item => {
            const div = document.createElement('div');
            div.classList.add('dropdown-item', 'd-flex', 'align-items-center');
            // Render aspect icons to the left
            (item.aspects || []).forEach(aspect => {
                const img = document.createElement('img');
                img.src = `/assets/images/starwars/icons/${aspect}.png`;
                img.alt = aspect;
                img.style.width = '20px';
                img.style.height = '20px';
                img.style.marginRight = '4px';
                div.appendChild(img);
            });
            // Card name
            const nameSpan = document.createElement('span');
            nameSpan.textContent = item.name;
            div.appendChild(nameSpan);
            div.addEventListener('click', () => {
                field.textContent = nameTransform ? nameTransform(item.name) : item.name;
                dropdownList.style.display = 'none';
                field.dispatchEvent(new Event('input'));
                field.dispatchEvent(new Event('change'));
                if (onSelect) onSelect(item);
            });
            dropdownList.appendChild(div);
        });
        dropdownList.style.display = items.length > 0 ? 'block' : 'none';
    }

    function setupCustomDropdowns() {
        const archetypeFields = document.querySelectorAll('[id$="-player-archetype-left"], [id$="-player-archetype-right"], [id$="-player-archetype-left-2"], [id$="-player-archetype-right-2"], [id^="bracket-"][id$="-archetype"]');
        archetypeFields.forEach(field => {
            if (field.parentNode.classList.contains('custom-dropdown')) {
                return; // Skip if already set up
            }

            const wrapper = document.createElement('div');
            wrapper.className = 'custom-dropdown';
            field.parentNode.insertBefore(wrapper, field);
            wrapper.appendChild(field);

            const dropdownList = document.createElement('div');
            dropdownList.className = 'dropdown-list';
            wrapper.appendChild(dropdownList);

            field.addEventListener('input', function () {
                const value = this.textContent.trim().toLowerCase();
                const filteredArchetypes = currentArchetypeList.filter(archetype => archetype.name.toLowerCase().includes(value))
                    .slice(0, 5); // Limit to top 5 results
                renderDropdownList(dropdownList, filteredArchetypes, field);
            });

            field.addEventListener('focus', function () {
                renderDropdownList(dropdownList, currentArchetypeList, field);
            });

            document.addEventListener('click', function (e) {
                if (!wrapper.contains(e.target)) {
                    dropdownList.style.display = 'none';
                }
            });
        });


        // Setup player-name autocomplete dropdowns (roster-backed). Matches
        // all four side variants generated by renderPlayerSection() — left /
        // right for 1v1, plus -left-2 / -right-2 for 2v2 partner slots.
        const playerNameFields = document.querySelectorAll(
            '[id$="-player-name-left"], [id$="-player-name-right"], [id$="-player-name-left-2"], [id$="-player-name-right-2"]'
        );
        playerNameFields.forEach(field => {
            if (field.parentNode.classList.contains('custom-dropdown')) {
                return; // Skip if already set up
            }

            const wrapper = document.createElement('div');
            wrapper.className = 'custom-dropdown';
            field.parentNode.insertBefore(wrapper, field);
            wrapper.appendChild(field);

            const dropdownList = document.createElement('div');
            dropdownList.className = 'dropdown-list';
            wrapper.appendChild(dropdownList);

            field.addEventListener('input', function () {
                const value = this.textContent.trim().toLowerCase();
                const filteredPlayers = currentPlayerRoster
                    .filter(player => player.name.toLowerCase().includes(value))
                    .slice(0, 5);
                renderDropdownList(dropdownList, filteredPlayers, field);
            });

            field.addEventListener('focus', function () {
                renderDropdownList(dropdownList, currentPlayerRoster, field);
            });

            document.addEventListener('click', function (e) {
                if (!wrapper.contains(e.target)) {
                    dropdownList.style.display = 'none';
                }
            });
        });

        // Setup legend autocomplete dropdowns
        // Includes -left-2 / -right-2 for riftbound 2v2 (P2 + P4 teammates).
        const legendFields = document.querySelectorAll('[id$="-player-legend-left"], [id$="-player-legend-left-2"], [id$="-player-legend-right"], [id$="-player-legend-right-2"]');
        legendFields.forEach(field => {
            if (field.parentNode.classList.contains('custom-dropdown')) {
                return; // Skip if already set up
            }

            const wrapper = document.createElement('div');
            wrapper.className = 'custom-dropdown';
            field.parentNode.insertBefore(wrapper, field);
            wrapper.appendChild(field);

            const dropdownList = document.createElement('div');
            dropdownList.className = 'dropdown-list';
            wrapper.appendChild(dropdownList);

            field.addEventListener('input', function () {
                const value = this.textContent.trim().toLowerCase();
                const filteredLegends = riftboundLegendsList.filter(legend => legend.name.toLowerCase().includes(value))
                    .slice(0, 5); // Limit to top 5 results
                renderDropdownList(dropdownList, filteredLegends, field);
            });

            field.addEventListener('focus', function () {
                renderDropdownList(dropdownList, riftboundLegendsList, field);
            });

            document.addEventListener('click', function (e) {
                if (!wrapper.contains(e.target)) {
                    dropdownList.style.display = 'none';
                }
            });
        });

        // Setup champion autocomplete dropdowns
        // Includes -left-2 / -right-2 for riftbound 2v2 (P2 + P4 teammates).
        const championFields = document.querySelectorAll('[id$="-player-champion-left"], [id$="-player-champion-left-2"], [id$="-player-champion-right"], [id$="-player-champion-right-2"]');
        championFields.forEach(field => {
            if (field.parentNode.classList.contains('custom-dropdown')) {
                return; // Skip if already set up
            }

            const wrapper = document.createElement('div');
            wrapper.className = 'custom-dropdown';
            field.parentNode.insertBefore(wrapper, field);
            wrapper.appendChild(field);

            const dropdownList = document.createElement('div');
            dropdownList.className = 'dropdown-list';
            wrapper.appendChild(dropdownList);

            field.addEventListener('input', function () {
                const value = this.textContent.trim().toLowerCase();
                const filteredChampions = riftboundChampionsList.filter(champion => champion.name.toLowerCase().includes(value))
                    .slice(0, 5); // Limit to top 5 results
                renderDropdownList(dropdownList, filteredChampions, field);
            });

            field.addEventListener('focus', function () {
                renderDropdownList(dropdownList, riftboundChampionsList, field);
            });

            document.addEventListener('click', function (e) {
                if (!wrapper.contains(e.target)) {
                    dropdownList.style.display = 'none';
                }
            });
        });

        // Setup battlefield autocomplete dropdowns
        const battlefieldFields = document.querySelectorAll('.battlefield-input');
        battlefieldFields.forEach(field => {
            if (field.parentNode.classList.contains('custom-dropdown')) {
                return; // Skip if already set up
            }

            const wrapper = document.createElement('div');
            wrapper.className = 'custom-dropdown';
            field.parentNode.insertBefore(wrapper, field);
            wrapper.appendChild(field);

            const dropdownList = document.createElement('div');
            dropdownList.className = 'dropdown-list';
            wrapper.appendChild(dropdownList);

            field.addEventListener('input', function () {
                const value = this.textContent.trim().toLowerCase();
                const filteredBattlefields = riftboundBattlefieldsList.filter(battlefield => battlefield.name.toLowerCase().includes(value))
                    .slice(0, 5); // Limit to top 5 results
                renderDropdownList(dropdownList, filteredBattlefields, field);
            });

            field.addEventListener('focus', function () {
                renderDropdownList(dropdownList, riftboundBattlefieldsList, field);
            });

            document.addEventListener('click', function (e) {
                if (!wrapper.contains(e.target)) {
                    dropdownList.style.display = 'none';
                }
            });
        });

        // Setup SWU Leader autocomplete dropdowns
        const swuLeaderFields = document.querySelectorAll('[id$="-player-leader-left"], [id$="-player-leader-right"]');
        swuLeaderFields.forEach(field => {
            if (field.parentNode.classList.contains('custom-dropdown')) return;
            const wrapper = document.createElement('div');
            wrapper.className = 'custom-dropdown';
            field.parentNode.insertBefore(wrapper, field);
            wrapper.appendChild(field);
            const dropdownList = document.createElement('div');
            dropdownList.className = 'dropdown-list';
            wrapper.appendChild(dropdownList);

            const onSelect = (item) => {
                // Auto-fill leader aspect boxes (two separate fields)
                const aspects = (item.aspects || []).map(a => a.toLowerCase());
                const aspect1Id = field.id.replace('player-leader-', 'player-leader-aspect-1-');
                const aspect2Id = field.id.replace('player-leader-', 'player-leader-aspect-2-');
                const aspect1Field = document.getElementById(aspect1Id);
                const aspect2Field = document.getElementById(aspect2Id);
                if (aspect1Field) {
                    aspect1Field.textContent = aspects[0] || '';
                    aspect1Field.dispatchEvent(new Event('input', { bubbles: true }));
                }
                if (aspect2Field) {
                    aspect2Field.textContent = aspects[1] || '';
                    aspect2Field.dispatchEvent(new Event('input', { bubbles: true }));
                }
            };

            field.addEventListener('input', function () {
                const value = this.textContent.trim().toLowerCase();
                const filtered = swuLeadersList
                    .filter(l => l.name.toLowerCase().includes(value))
                    .slice(0, 10);
                renderSWUDropdownList(dropdownList, filtered, field, onSelect);
            });
            field.addEventListener('focus', function () {
                renderSWUDropdownList(dropdownList, swuLeadersList.slice(0, 10), field, onSelect);
            });
            document.addEventListener('click', (e) => {
                if (!wrapper.contains(e.target)) dropdownList.style.display = 'none';
            });
        });

        // Setup SWU Base autocomplete dropdowns
        const stripBaseTrait = (name) => name.split(' - ')[0].trim();
        const swuBaseFields = document.querySelectorAll('[id$="-player-base-left"], [id$="-player-base-right"]');
        swuBaseFields.forEach(field => {
            if (field.parentNode.classList.contains('custom-dropdown')) return;
            const wrapper = document.createElement('div');
            wrapper.className = 'custom-dropdown';
            field.parentNode.insertBefore(wrapper, field);
            wrapper.appendChild(field);
            const dropdownList = document.createElement('div');
            dropdownList.className = 'dropdown-list';
            wrapper.appendChild(dropdownList);

            const onSelect = (item) => {
                // Auto-fill base aspects field
                const aspectsFieldId = field.id.replace('player-base-', 'player-base-aspects-');
                const aspectsField = document.getElementById(aspectsFieldId);
                if (aspectsField) {
                    aspectsField.textContent = (item.aspects || []).join(', ').toLowerCase();
                    aspectsField.dispatchEvent(new Event('input', { bubbles: true }));
                }
                // Auto-fill base HP
                if (item.hp) {
                    const hpFieldId = field.id.replace('player-base-', 'player-base-hp-');
                    const hpField = document.getElementById(hpFieldId);
                    if (hpField) {
                        hpField.textContent = item.hp;
                        hpField.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }
            };

            field.addEventListener('input', function () {
                const value = this.textContent.trim().toLowerCase();
                const filtered = swuBasesList
                    .filter(b => b.name.toLowerCase().includes(value))
                    .slice(0, 10);
                renderSWUDropdownList(dropdownList, filtered, field, onSelect, stripBaseTrait);
            });
            field.addEventListener('focus', function () {
                renderSWUDropdownList(dropdownList, swuBasesList.slice(0, 10), field, onSelect, stripBaseTrait);
            });
            document.addEventListener('click', (e) => {
                if (!wrapper.contains(e.target)) dropdownList.style.display = 'none';
            });
        });

        // Setup SWU Aspect autocomplete dropdowns (leader aspects + base aspects)
        const swuAspectOptions = ['Aggression', 'Command', 'Cunning', 'Heroism', 'Vigilance', 'Villainy'];
        const swuAspectFields = document.querySelectorAll(
            '[id$="-player-leader-aspect-1-left"], [id$="-player-leader-aspect-1-right"], ' +
            '[id$="-player-leader-aspect-2-left"], [id$="-player-leader-aspect-2-right"], ' +
            '[id$="-player-base-aspects-left"], [id$="-player-base-aspects-right"]'
        );
        swuAspectFields.forEach(field => {
            if (field.parentNode.classList.contains('custom-dropdown')) return;
            const wrapper = document.createElement('div');
            wrapper.className = 'custom-dropdown';
            // Transfer flex styling from field to wrapper so flex layout is preserved
            if (field.style.flex) {
                wrapper.style.flex = field.style.flex;
                field.style.flex = '';
            }
            if (field.style.width && field.style.flexShrink) {
                wrapper.style.width = field.style.width;
                wrapper.style.flexShrink = field.style.flexShrink;
                field.style.width = '100%';
                field.style.flexShrink = '';
            }
            field.parentNode.insertBefore(wrapper, field);
            wrapper.appendChild(field);
            const dropdownList = document.createElement('div');
            dropdownList.className = 'dropdown-list';
            wrapper.appendChild(dropdownList);

            const renderAspectDropdown = (filter) => {
                dropdownList.innerHTML = '';
                const filtered = swuAspectOptions.filter(a => a.toLowerCase().includes(filter.toLowerCase()));
                filtered.forEach(aspect => {
                    const div = document.createElement('div');
                    div.classList.add('dropdown-item', 'd-flex', 'align-items-center');
                    const img = document.createElement('img');
                    img.src = `/assets/images/starwars/icons/${aspect}.png`;
                    img.alt = aspect;
                    img.style.width = '20px';
                    img.style.height = '20px';
                    img.style.marginRight = '6px';
                    div.appendChild(img);
                    const nameSpan = document.createElement('span');
                    nameSpan.textContent = aspect;
                    div.appendChild(nameSpan);
                    div.addEventListener('click', () => {
                        field.textContent = aspect.toLowerCase();
                        dropdownList.style.display = 'none';
                        field.dispatchEvent(new Event('input', { bubbles: true }));
                        field.dispatchEvent(new Event('change'));
                    });
                    dropdownList.appendChild(div);
                });
                dropdownList.style.display = filtered.length > 0 ? 'block' : 'none';
            };

            field.addEventListener('input', function () {
                renderAspectDropdown(this.textContent.trim());
            });
            field.addEventListener('focus', function () {
                renderAspectDropdown('');
            });
            document.addEventListener('click', (e) => {
                if (!wrapper.contains(e.target)) dropdownList.style.display = 'none';
            });
        });
    }

    // Add these functions to your existing script section
    function renderRoundTabs(allData) {
        const roundTabs = document.getElementById('roundTabs');
        const roundContent = document.getElementById('roundTabsContent');
        // Standings tab parallel containers — same per-round sub-tab
        // structure mirrored into the dedicated Standings tab so the
        // standings card (built by renderStandings()) lands there instead
        // of inside the Matches tab's per-round match container.
        const standingsRoundTabs = document.getElementById('standingsRoundTabs');
        const standingsRoundContent = document.getElementById('standingsRoundTabsContent');
        // Pairings tab parallel containers — same shape as standings.
        // Each round sub-tab here gets a self-contained pairings card
        // (rendered by renderPairings() below); we don't share a card
        // with the standings tab because the two tables have very
        // different shapes/columns.
        const pairingsRoundTabs = document.getElementById('pairingsRoundTabs');
        const pairingsRoundContent = document.getElementById('pairingsRoundTabsContent');

        if (roundTabs.children.length === 0 && roundContent.children.length === 0) {
            // Create tabs and content for each round
            Object.keys(allData).filter(roundId => !isNaN(roundId)).forEach((roundId, index) => {
                // Create tab
                const tab = document.createElement('li');
                tab.className = 'nav-item';
                tab.innerHTML = `
                <button class="nav-link ${index === 0 ? 'active' : ''}"
                        id="round-${roundId}-tab"
                        data-bs-toggle="tab"
                        data-bs-target="#round-${roundId}-content"
                        type="button"
                        role="tab"
                        aria-controls="round-${roundId}"
                        aria-selected="${index === 0}">
                    Round ${roundId}
                </button>
            `;
                roundTabs.appendChild(tab);

                // Mirror the round sub-tab into the Standings tab nav so the
                // operator can pick which round's standings to view there.
                // Defensive: skip if the Standings tab markup isn't on the
                // page (older master-control.html builds, or a future
                // refactor that drops the tab).
                if (standingsRoundTabs) {
                    const standingsTab = document.createElement('li');
                    standingsTab.className = 'nav-item';
                    standingsTab.innerHTML = `
                <button class="nav-link ${index === 0 ? 'active' : ''}"
                        id="standings-round-${roundId}-tab"
                        data-bs-toggle="tab"
                        data-bs-target="#standings-round-${roundId}-content"
                        type="button"
                        role="tab"
                        aria-controls="standings-round-${roundId}"
                        aria-selected="${index === 0}">
                    Round ${roundId}
                </button>
            `;
                    standingsRoundTabs.appendChild(standingsTab);
                }

                // Mirror into the Pairings tab nav too. Same pattern as
                // standings — independent sub-tabs with their own cards.
                if (pairingsRoundTabs) {
                    const pairingsTab = document.createElement('li');
                    pairingsTab.className = 'nav-item';
                    pairingsTab.innerHTML = `
                <button class="nav-link ${index === 0 ? 'active' : ''}"
                        id="pairings-round-${roundId}-tab"
                        data-bs-toggle="tab"
                        data-bs-target="#pairings-round-${roundId}-content"
                        type="button"
                        role="tab"
                        aria-controls="pairings-round-${roundId}"
                        aria-selected="${index === 0}">
                    Round ${roundId}
                </button>
            `;
                    pairingsRoundTabs.appendChild(pairingsTab);
                }

                // Create content
                const content = document.createElement('div');
                content.className = `tab-pane fade ${index === 0 ? 'show active' : ''}`;
                content.id = `round-${roundId}-content`;
                content.role = 'tabpanel';
                content.setAttribute('aria-labelledby', `round-${roundId}-tab`);

                // create container for round actions
                // The Fetch Standings button lives next to the blue Broadcast
                // button perpetually (every vendor/count) and matches the
                // primary style so the two read as a paired action strip.
                // It carries `.fetch-standings-btn` + `data-round-id` so the
                // existing delegated click handler in tournament-platform.js
                // picks it up — no separate wiring required.
                //
                // The round input sitting between them is FQ 2v2 only (the
                // broadcast round advances twice as fast as the Melee round
                // for that format, so the operator needs to specify the
                // platform round explicitly). Hidden via `.fq2v2-only` for
                // every other vendor/count; the sync handler mirrors its
                // value across every other round's `.fetch-round-input`.
                const roundActions = document.createElement('div');
                roundActions.className = 'col-12 d-flex flex-row justify-content-center align-items-center gap-2 my-3 round-broadcast-container';
                roundActions.innerHTML = `
                    <button class="btn btn-primary broadcast-button" id="broadcast-${roundId}" data-round-id="${roundId}">Broadcast</button>
                    <button class="btn btn-primary fetch-standings-btn"
                        data-round-id="${roundId}">Fetch Standings</button>
                    <input type="text"
                        class="form-control form-control-sm fq2v2-only fetch-round-input"
                        data-round-id="${roundId}"
                        style="width: 80px;"
                        placeholder="Round" />
                    <!-- Show Sideboard lives on the broadcast strip (global state,
                         one switch per round tab, all kept in sync by
                         game-selection.js). Initial checked is read from the
                         body dataset so a strip rendered after the first sync
                         still starts correct. -->
                    <div class="form-check form-switch d-inline-flex align-items-center mb-0 ms-2" style="gap:6px;">
                        <input class="form-check-input m-0 round-sideboard-toggle" type="checkbox" role="switch"
                            id="sideboard-visible-${roundId}" ${document.body.dataset.sideboardVisible === 'true' ? 'checked' : ''}>
                        <label class="form-check-label small" for="sideboard-visible-${roundId}" style="white-space:nowrap;">Show Sideboard</label>
                    </div>
                `;
                content.appendChild(roundActions);

                const divider = document.createElement('hr');
                content.appendChild(divider);

                // Create container for match cards
                const matchContainer = document.createElement('div');
                matchContainer.id = `round-${roundId}-matches`;
                matchContainer.className = 'mt-3 row';
                content.appendChild(matchContainer);

                roundContent.appendChild(content);

                // Mirror content pane into Standings tab. The pane is just
                // a `row` container — renderStandings() appends the
                // standings card (col-6, on the LEFT), and renderBestOfLegend()
                // appends the BoL card (col-6, on the RIGHT) via
                // appendChild on first data arrival. Order matters: by
                // appending standings first and BoL second, Bootstrap's
                // row layout puts standings left + BoL right without
                // needing CSS order utilities.
                if (standingsRoundContent) {
                    const standingsContent = document.createElement('div');
                    standingsContent.className = `tab-pane fade ${index === 0 ? 'show active' : ''}`;
                    standingsContent.id = `standings-round-${roundId}-content`;
                    standingsContent.role = 'tabpanel';
                    standingsContent.setAttribute('aria-labelledby', `standings-round-${roundId}-tab`);
                    standingsContent.classList.add('row', 'mt-3');
                    standingsRoundContent.appendChild(standingsContent);
                    // Eagerly render the empty standings card so the
                    // Fetch Standings button + textarea always exist —
                    // even for rounds with no fetched data yet (otherwise
                    // there's no way to click Fetch on round 16+ before
                    // the cache has any data). Mirrors the pairings tab
                    // pattern (renderEmptyPairingsCard below). The
                    // textarea fills in later when populateStandingsData
                    // fires off the standings-data socket payload.
                    renderStandings(roundId);
                }

                // Mirror content pane into Pairings tab. Unlike Standings —
                // which has a JS-built card appended on demand — we render
                // the empty pairings card eagerly here. It always shows the
                // header + Fetch button + empty table; the tbody fills in
                // when a fetch response arrives (or when the cached
                // `all-pairings-data` snapshot lands at page-load time).
                if (pairingsRoundContent) {
                    const pairingsContent = document.createElement('div');
                    pairingsContent.className = `tab-pane fade ${index === 0 ? 'show active' : ''}`;
                    pairingsContent.id = `pairings-round-${roundId}-content`;
                    pairingsContent.role = 'tabpanel';
                    pairingsContent.setAttribute('aria-labelledby', `pairings-round-${roundId}-tab`);
                    pairingsContent.classList.add('row', 'mt-3');
                    pairingsContent.innerHTML = renderEmptyPairingsCard(roundId);
                    pairingsRoundContent.appendChild(pairingsContent);
                    attachPairingsSearchListener(roundId);
                }

                attachBroadcastButtonListeners(roundId);

            });
        }

        // update content in round / matches
        Object.keys(allData).filter(roundId => !isNaN(roundId)).forEach((roundId) => {
            // Render all matches for this round
            Object.entries(allData[roundId])
                .sort(([a], [b]) => a.localeCompare(b, undefined, {numeric: true}))
                .forEach(([matchId, matchData]) => {
                    renderMatch(roundId, matchId, matchData);
                });
        })

        // NOTE: We intentionally do NOT emit master-control-matches-updated
        // here. An earlier version pushed the full allControlData on every
        // render to sync derived active-battlefield values to the server —
        // but that fired on every load/reconnect, hammering the server's
        // updateFromMaster (80-match merge + ~hundreds of room emits + disk
        // write) and could jam the event loop. The active-battlefield values
        // are persisted in controlData.json, so the server already serves
        // them; the per-radio-change input listeners keep them in sync.

        // Re-render if 2v2 was already set before control data arrived
        if (currentPlayerCount === '2v2') {
            toggleTeammateSections();
        }

        // matches are rendered - now ask server for standings + pairings.
        // Both reuse the per-round sub-tab containers we just created in
        // the Standings/Pairings tabs above (see renderRoundTabs body).
        socket.emit('get-all-standings');
        socket.emit('get-all-pairings');
        // Best of Legend (riftbound) — server computes per-round per-Legend
        // top-5 from the cached standings + decklists. Empty if active
        // event has no decklists or selected platform isn't cardeio.
        socket.emit('get-best-of-legend');
    }

    // Add click handlers for the Display Deck buttons
    function attachDeckDisplayListeners(round_id, match_id) {
        ['left', 'right', 'left-2', 'right-2'].forEach(side => {
            const btn = document.querySelector(`#display-deck-${side}-${round_id}-${match_id}`);
            if (btn) {
                btn.addEventListener('click', () => {
                    socket.emit('display-deck', { round_id, match_id, side });
                });
            }
        });
    }

    // add event listeners for broadcast buttons
    function attachBroadcastButtonListeners(round_id) {
        const broadcast = document.querySelector(`#broadcast-${round_id}`);
        broadcast.addEventListener('click', () => {
            console.log(`broadcast clicked for round ${round_id}`);
            broadcastDisplay.innerText = `Round ${round_id}`;
            socket.emit('broadcast-requested', {
                round_id
            });
            currentBroadcastRoundId = String(round_id);
        });
    }

    // Add event listeners for control buttons
    function attachControlMappingButtonListeners(round_id, match_id) {
        const control1 = document.querySelector(`#control-1-${round_id}-${match_id}.control-button`);
        const control2 = document.querySelector(`#control-2-${round_id}-${match_id}.control-button`);
        const control3 = document.querySelector(`#control-3-${round_id}-${match_id}.control-button`);
        const control4 = document.querySelector(`#control-4-${round_id}-${match_id}.control-button`);
        control1.addEventListener('click', () => {
            console.log('click from', round_id, match_id);
            control1Display.innerText = `${round_id}-${match_id}`;
            socket.emit('control-mapping-update', {controlId: '1', round_id, match_id});
        })
        control2.addEventListener('click', () => {
            console.log('click from', round_id, match_id);
            control2Display.innerText = `${round_id}-${match_id}`;
            socket.emit('control-mapping-update', {controlId: '2', round_id, match_id});
        })
        control3.addEventListener('click', () => {
            console.log('click from', round_id, match_id);
            control3Display.innerText = `${round_id}-${match_id}`;
            socket.emit('control-mapping-update', {controlId: '3', round_id, match_id});
        })
        control4.addEventListener('click', () => {
            console.log('click from', round_id, match_id);
            control4Display.innerText = `${round_id}-${match_id}`;
            socket.emit('control-mapping-update', {controlId: '4', round_id, match_id});
        })
    }

    // Add event listeners for reset life buttons
    function attachMatchResetLifeButtonListeners(round_id, match_id) {
        const resetLifeButton = document.querySelector(`#reset-life-${round_id}-${match_id}.reset-life-button`);
        resetLifeButton.addEventListener('click', () => {
            console.log('click reset life', round_id, match_id);
            // update life points for all players in round / match
            const teamLife = currentPlayerCount === '2v2' ? '30' : baseLifePoints;
            const sides = ['left', 'right'];
            // 2v2: -2 slots exist but life is team-level; FFA: all four players
            // carry their own life and reset to the event base (e.g. 40 for cmdr).
            if (currentPlayerCount === '2v2' || currentPlayerCount === 'ffa') sides.push('left-2', 'right-2');
            sides.forEach(side => {
                const el = document.querySelector(`[id="${round_id}-${match_id}-player-life-${side}"]`);
                if (el) {
                    el.innerText = teamLife;
                    if (!allControlData[round_id]) allControlData[round_id] = {};
                    if (!allControlData[round_id][match_id]) allControlData[round_id][match_id] = {};
                    allControlData[round_id][match_id][`player-life-${side}`] = baseLifePoints;
                }
            });
            // Also reset Star Wars base HP if in Star Wars mode
            if (currentGameSelection === 'starwars') {
                sides.forEach(side => {
                    const el = document.querySelector(`[id="${round_id}-${match_id}-player-base-hp-${side}"]`);
                    if (el) { el.innerText = '30'; allControlData[round_id][match_id][`player-base-hp-${side}`] = '30'; }
                });
            }
            // update server since control data changed
            socket.emit('master-control-matches-updated', allControlData);
        })
    }

    // Delegated click handler for life +/- buttons (debounced to prevent flicker)
    const _lifeDebounceTimers = {};
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.life-btn, .life-btn-5');
        if (!btn) return;
        const targetId = btn.dataset.lifeTarget;
        const delta = parseInt(btn.dataset.lifeDelta);
        const lifeEl = document.getElementById(targetId);
        if (!lifeEl) return;
        let current = parseInt(lifeEl.innerText) || 0;
        lifeEl.innerText = current + delta;

        // Debounce: only send to server after 300ms of no clicks
        if (_lifeDebounceTimers[targetId]) clearTimeout(_lifeDebounceTimers[targetId]);
        _lifeDebounceTimers[targetId] = setTimeout(() => {
            lifeEl.dispatchEvent(new Event('input', { bubbles: true }));
            delete _lifeDebounceTimers[targetId];
        }, 300);
    });

    // Delegated change handler for battlefield radio buttons
    // When a radio is selected, copy that battlefield's text into the hidden player-battlefield field
    // — but ONLY if the Brush override toggle for this side isn't on.
    // When Brush override is active, every radio change is muted at
    // the display level; the override release path (toggling Brush off)
    // re-applies whatever's currently selected.
    document.addEventListener('change', (e) => {
        if (!e.target.classList.contains('battlefield-radio')) return;
        const radio = e.target;
        const { side, round, match, bf } = radio.dataset;
        const overrideBtn = document.querySelector(`.brush-override-btn[data-round="${round}"][data-match="${match}"][data-side="${side}"]`);
        if (overrideBtn?.classList.contains('active')) {
            // Brush override is on — keep showing "Brush", ignore the
            // selection change.
            return;
        }
        const sourceEl = document.getElementById(`${round}-${match}-player-battlefield-${bf}-${side}`);
        const mainField = document.getElementById(`${round}-${match}-player-battlefield-${side}`);
        if (sourceEl && mainField) {
            mainField.innerText = sourceEl.innerText;
            mainField.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });

    // ── Brush override toggle ─────────────────────────────────────────
    // We own the toggle state via `aria-pressed` + the `.active` class
    // (instead of Bootstrap's `data-bs-toggle="button"` which would
    // race with this handler depending on listener registration order).
    // While pressed, the hidden `player-battlefield-${side}` field is
    // forced to "Brush" — that flows through the existing editable-
    // input listener to `master-control-matches-updated` and out to
    // every connected scoreboard. Toggling off re-derives from the
    // currently-checked radio.
    document.addEventListener('click', (e) => {
        const btn = e.target.closest?.('.brush-override-btn');
        if (!btn) return;
        const { side, round, match } = btn.dataset;
        const mainField = document.getElementById(`${round}-${match}-player-battlefield-${side}`);
        if (!mainField) return;
        const wasPressed = btn.getAttribute('aria-pressed') === 'true';
        const nowPressed = !wasPressed;
        btn.setAttribute('aria-pressed', String(nowPressed));
        btn.classList.toggle('active', nowPressed);
        if (nowPressed) {
            // textContent (not innerText) because the hidden field is
            // display:none — innerText only reflects rendered text and
            // can return/set inconsistently on hidden elements. The
            // input-listener downstream reads textContent too (line ~707).
            mainField.textContent = 'Brush';
        } else {
            // Off → restore from the currently-checked radio for this side.
            const selectedRadio = document.querySelector(`input[name="${round}-${match}-bf-${side}-select"]:checked`);
            const bf = selectedRadio?.dataset?.bf || '1';
            const sourceEl = document.getElementById(`${round}-${match}-player-battlefield-${bf}-${side}`);
            mainField.textContent = sourceEl?.textContent || '';
        }
        mainField.dispatchEvent(new Event('input', { bubbles: true }));
        console.log(`[Brush Override] ${nowPressed ? 'ON' : 'OFF'} side=${side} round=${round} match=${match} → mainField.textContent="${mainField.textContent}"`);
    });

    // Delegated input handler for battlefield text fields
    // When editing a battlefield input, sync to the hidden field if this
    // battlefield's radio is selected — UNLESS Brush override is on,
    // in which case the hidden field is locked to "Brush" until the
    // operator toggles the override off.
    document.addEventListener('input', (e) => {
        if (!e.target.classList.contains('battlefield-input')) return;
        const fieldId = e.target.id; // e.g. "1-match1-player-battlefield-2-left"
        const match = fieldId.match(/^(.+)-player-battlefield-(\d)-(left|right)$/);
        if (!match) return;
        const [, prefix, bfNum, side] = match;
        const radioName = `${prefix}-bf-${side}-select`;
        const selectedRadio = document.querySelector(`input[name="${radioName}"]:checked`);
        if (selectedRadio && selectedRadio.dataset.bf === bfNum) {
            const overrideBtn = document.querySelector(`.brush-override-btn[data-round="${prefix.split('-')[0]}"][data-match="${prefix.split('-').slice(1).join('-')}"][data-side="${side}"]`);
            if (overrideBtn?.classList.contains('active')) return;
            const mainField = document.getElementById(`${prefix}-player-battlefield-${side}`);
            if (mainField) {
                mainField.innerText = e.target.innerText;
                mainField.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
    });

    // FFA "show life totals" switch — rides the standard control-data path
    // (updateControlData + master-control-matches-updated) so it persists and
    // reaches the scoreboard like any field. 'false' hides the life blocks on
    // the FFA plates (players tracking life with a table app instead).
    document.addEventListener('change', (e) => {
        if (!e.target.classList || !e.target.classList.contains('ffa-life-toggle')) return;
        const { round, match } = e.target.dataset;
        if (!round || !match) return;
        updateControlData(round, match, 'ffa-life-visible', e.target.checked ? 'true' : 'false');
        socket.emit('master-control-matches-updated', allControlData);
    });

    // Auto-sync the Showdown Might Tracker's BF 1 / BF 2 name fields to
    // mirror the active battlefield for each player. Listens to input
    // events on the hidden player-battlefield-{left,right} field (which
    // gets updated by radio clicks, brush override toggles, and battlefield
    // slot edits). Left → BF 1, Right → BF 2. Dispatching input on the
    // showdown field triggers the normal editable-input handler → updates
    // allControlData + emits to server → scoreboard receives.
    document.addEventListener('input', (e) => {
        const fieldId = e.target?.id;
        if (!fieldId) return;
        const m = fieldId.match(/^(.+)-player-battlefield-(left|right)$/);
        if (!m) return;
        const [, prefix, side] = m;
        const bfNum = side === 'left' ? '1' : '2';
        const showdownEl = document.getElementById(`${prefix}-showdown-bf-${bfNum}-name`);
        if (!showdownEl) return;
        const newText = e.target.innerText;
        if (showdownEl.innerText === newText) return;
        showdownEl.innerText = newText;
        showdownEl.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Delegated handlers for the Riftbound Showdown Might section:
    //   - Visibility toggle button (aria-pressed → showdown-visible field)
    //   - Baron Pit enable checkbox (toggles BF-3 row visibility +
    //     persists showdown-bf-3-enabled)
    //   - Active battlefield radio (sets showdown-active-bf to 1/2/3)
    // All three persist via the standard control-data flow (write to
    // allControlData + emit master-control-matches-updated), same as
    // the other contenteditable fields.
    document.addEventListener('click', (e) => {
        const btn = e.target.closest?.('.showdown-visible-toggle');
        if (!btn) return;
        const round = btn.dataset.round;
        const match = btn.dataset.match;
        const nowPressed = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', String(nowPressed));
        btn.textContent = nowPressed ? 'Hide from Scoreboard' : 'Show on Scoreboard';
        updateControlData(round, match, 'showdown-visible', nowPressed ? 'true' : 'false');
        socket.emit('master-control-matches-updated', allControlData);
    });

    document.addEventListener('change', (e) => {
        const cb = e.target.closest?.('.showdown-baron-pit-toggle');
        if (!cb) return;
        const round = cb.dataset.round;
        const match = cb.dataset.match;
        const enabled = cb.checked;
        // The Baron Pit toggle now lives in its own column (not inside the
        // Showdown Might card), so locate the BF-3 row via the match card.
        const bf3Row = document.querySelector(`#match-card-${round}-${match} .showdown-bf-3-row`);
        if (bf3Row) bf3Row.classList.toggle('d-none', !enabled);
        // Auto-fill the BF 3 name to "Baron Pit" when enabling (if blank), so
        // the showdown's third battlefield is ready to use immediately.
        const nameEl = document.getElementById(`${round}-${match}-showdown-bf-3-name`);
        if (enabled && nameEl && !nameEl.textContent.trim()) {
            nameEl.textContent = 'Baron Pit';
            updateControlData(round, match, 'showdown-bf-3-name', 'Baron Pit');
        }
        updateControlData(round, match, 'showdown-bf-3-enabled', enabled ? 'true' : 'false');
        socket.emit('master-control-matches-updated', allControlData);
    });

    // Baron Pit Brush Override — forces the showdown BF 3 name to "Brush"
    // while pressed; restores the prior name (default "Baron Pit") when
    // released. Mirrors the per-player brush override pattern.
    document.addEventListener('click', (e) => {
        const btn = e.target.closest?.('.baron-brush-override-btn');
        if (!btn) return;
        const round = btn.dataset.round;
        const match = btn.dataset.match;
        const nameEl = document.getElementById(`${round}-${match}-showdown-bf-3-name`);
        if (!nameEl) return;
        const nowPressed = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', String(nowPressed));
        btn.classList.toggle('active', nowPressed);
        if (nowPressed) {
            btn._priorName = nameEl.textContent.trim() || 'Baron Pit';
            nameEl.textContent = 'Brush';
        } else {
            nameEl.textContent = btn._priorName || 'Baron Pit';
        }
        updateControlData(round, match, 'showdown-bf-3-name', nameEl.textContent.trim());
        socket.emit('master-control-matches-updated', allControlData);
    });

    document.addEventListener('change', (e) => {
        const radio = e.target.closest?.('.showdown-active-bf-radio');
        if (!radio || !radio.checked) return;
        const round = radio.dataset.round;
        const match = radio.dataset.match;
        const bf = radio.dataset.bf;
        updateControlData(round, match, 'showdown-active-bf', bf);
        socket.emit('master-control-matches-updated', allControlData);
    });

    // add click handler for commentator data
    function attachCommentatorDataUpdateClickListener() {
        const commentatorDataUpdateButton = document.querySelector(`#update-commentator-dropdowns`);

        commentatorDataUpdateButton.addEventListener('click', () => {
            commentatorData = extractCommentatorData();
            // send update to server to handle storage - unsure if this is needed?
            //socket.emit('bracket-updated', {bracketValues});
        });
    }

    // add click handlers for update global buttons
    function attachGlobalCommentatorsListener() {
        updateCommentators.addEventListener('click', () => {
            const data2send = {
                'global-commentator-1': commentator1().innerText,
                'global-commentator-1-subtext': commentator1_subtext().innerText,
                'global-commentator-2': commentator2().innerText,
                'global-commentator-2-subtext': commentator2_subtext().innerText,
                'global-commentator-3': commentator3().innerText,
                'global-commentator-3-subtext': commentator3_subtext().innerText,
                'global-commentator-4': commentator4().innerText,
                'global-commentator-4-subtext': commentator4_subtext().innerText
            }
            console.log(data2send)
            socket.emit('update-commentators-requested', {commentatorData: data2send});
        })
    }

    // add click handlers for update event name and event format button
    function attachGlobalEventInformationUpdateListener() {
        updateEventInformation.addEventListener('click', () => {
            const data2send = {
                'global-event-name': matchEventName.innerText,
                'global-event-format': matchEventFormat.innerText,
                'global-event-miscellaneous-details': matchEventMiscDetails.innerText,
                'global-event-base-life-points': matchEventBaseLifePoints.innerText,
                'global-event-base-timer': matchEventBaseTimer.innerText,
                'global-event-number-of-rounds': matchEventNumberOfRounds.innerText
            }
            console.log(data2send)
            socket.emit('update-event-information-requested', {eventInformationData: data2send});
        })
    }

    // add click handlers for update event base timer button
    function attachGlobalBaseTimerUpdateListener() {
        updateEventInformationBaseTimer.addEventListener('click', () => {
            const data2send = {
                'global-event-base-timer': matchEventBaseTimer.innerText
            }
            console.log(data2send)
            socket.emit('update-event-information-base-timer-requested', {eventInformationData: data2send});
        })
    }

    // add input / keypress handlers for base timer global update
    function attachGlobalBaseTimerInputListener() {
        // Allow only number keys
        matchEventBaseTimer.addEventListener('keydown', function (e) {
            const allowedKeys = ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight'];
            if (!/[0-9]/.test(e.key) && !allowedKeys.includes(e.key)) {
                e.preventDefault();
            }
        });

        // Sanitize pasted input
        matchEventBaseTimer.addEventListener('paste', function (e) {
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData).getData('text');
            const digitsOnly = text.replace(/\D/g, '');

            const selection = window.getSelection();
            if (!selection.rangeCount) return;
            selection.deleteFromDocument();
            selection.getRangeAt(0).insertNode(document.createTextNode(digitsOnly));
        });
    }


    // Commentator Data Function
    function extractCommentatorData() {
        // Select the parent container
        const commentatorDataText = document.getElementById('commentators-input').value;
        
        // Update commentatorData to be an object w/ pairs
        commentatorData = [];
        // split into array
        let comData = commentatorDataText.split(/\r?\n/);
        for (let i = 0; i < comData.length; i+=2) {
            if (i+1 < comData.length){
                let o = {
                    name: comData[i],
                    social: comData[i+1]
                }
                commentatorData.push(o);
            }
        }
        //console.log('commentatorData set', commentatorData);
        autoPopulateCommentatorDropdowns(commentatorData);
    }

    function autoPopulateCommentatorDropdowns(commentatorData) {
        //console.log('APCD - entered autopopulate comdata');

        // delete all pre-existing wrappers/dropdowns, we want to start from scratch each time
        // delete all wrappers
        document.querySelectorAll('.custom-dropdown.global-commentator').forEach(e => e.replaceWith(...e.childNodes));
        // delete all children dropdown lists
        document.querySelectorAll('.dropdown-list.global-commentator').forEach(e => e.remove());


        // grab name dropdown inputs
        let nameInputsForDeletion = document.querySelectorAll('[id^="global-commentator-"]:not([id^="global-commentator-subtext-"]).editable');
        // delete and remake all old nameInputs so that we can remove existing listeners
        nameInputsForDeletion.forEach(node => {
            const clone = node.cloneNode();
            node.replaceWith(clone);
        });

        // also clear all socials text
        document.querySelectorAll('[id^="global-commentator-subtext-"]').forEach(e => { e.innerText = '' })

        // grab name dropdown inputs
        let nameInputs = document.querySelectorAll('[id^="global-commentator-"]:not([id^="global-commentator-subtext-"]).editable');
        //console.log('APCD - ', nameInputs);

        // use commentatorData to populate dropdowns
        let namesFromComData = [...new Set(Object.values(commentatorData).map(commentator => commentator.name))];
        //console.log('APCD - ', namesFromComData);

        nameInputs.forEach(field => {
            const wrapper = document.createElement('div');
            wrapper.className = 'custom-dropdown global-commentator';
            field.parentNode.insertBefore(wrapper, field);
            wrapper.appendChild(field);

            const dropdownList = document.createElement('div');
            dropdownList.className = 'dropdown-list global-commentator';
            wrapper.appendChild(dropdownList);

            field.addEventListener('input', function () {
                const value = this.textContent.trim().toLowerCase();
                const filteredNames = namesFromComData.filter(name => name.toLowerCase().includes(value));
                renderCommentatorDropdownList(dropdownList, filteredNames, field);
            });

            field.addEventListener('focus', function () {
                renderCommentatorDropdownList(dropdownList, namesFromComData, field);
            });

            field.addEventListener('change', function (e) {
                let s = commentatorData.find(n => n.name === e.target.innerText).social
                let subtext = document.getElementById('global-commentator-subtext-' + e.target.id.split('-')[2])
                subtext.innerText = s;
            })

            document.addEventListener('click', function (e) {
                if (!wrapper.contains(e.target)) {
                    dropdownList.style.display = 'none';
                }
            });
        });
    }

    function renderCommentatorDropdownList(dropdownList, names, field) {
        dropdownList.innerHTML = '';
        names.forEach(name => {
            const div = document.createElement('div');
            div.textContent = name;
            div.classList.add('dropdown-item');
            div.addEventListener('click', function () {
                field.textContent = name;
                dropdownList.style.display = 'none';
                field.dispatchEvent(new Event('input'));
                field.dispatchEvent(new Event('change')); // Trigger change event
            });
            dropdownList.appendChild(div);
        });
        dropdownList.style.display = names.length > 0 ? 'block' : 'none';
    }

    // START TIMER FUNCTIONS

    function updateTimerState(round_id, match_id, action) {
        socket.emit('update-timer-state', {round_id, match_id, action});
    }

    function formatTime(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
        const seconds = String(totalSeconds % 60).padStart(2, '0');
        return `${minutes}:${seconds}`;
    }

    // Add event listeners for reset life buttons
    function attachMatchTimerButtonListeners(round_id, match_id) {
        const startButton = document.querySelector(`#timer-start-${round_id}-${match_id}`);
        const addButton = document.querySelector(`#timer-add-${round_id}-${match_id}`);
        const minusButton = document.querySelector(`#timer-minus-${round_id}-${match_id}`);
        const pauseButton = document.querySelector(`#timer-pause-${round_id}-${match_id}`);
        const resetButton = document.querySelector(`#timer-reset-${round_id}-${match_id}`);
        const timerShowCheck = document.querySelector(`#timer-display-scoreboard-${round_id}-${match_id}`);
        const timerCountUpCheck = document.querySelector(`#timer-count-up-${round_id}-${match_id}`);
        startButton.addEventListener('click', () => {
            console.log('start clicked', round_id, match_id)
            updateTimerState(round_id, match_id, 'start');
        });
        addButton.addEventListener('click', () => {
            console.log('add clicked', round_id, match_id)
            updateTimerState(round_id, match_id, 'add');
        });
        minusButton.addEventListener('click', () => {
            console.log('minus clicked', round_id, match_id)
            updateTimerState(round_id, match_id, 'minus');
        });
        pauseButton.addEventListener('click', () => {
            console.log('pause clicked', round_id, match_id)
            updateTimerState(round_id, match_id, 'pause');
        });
        resetButton.addEventListener('click', () => {
            console.log('reset clicked', round_id, match_id)
            updateTimerState(round_id, match_id, 'reset');
        });
        timerShowCheck.addEventListener('change', function () {
            console.log('show / no show timer clicked', round_id, match_id, timerShowCheck.checked);
            if (timerShowCheck.checked) {
                updateTimerState(round_id, match_id, 'show');
            } else {
                updateTimerState(round_id, match_id, 'no-show');
            }
        });
        timerCountUpCheck.addEventListener('change', function () {
            console.log('count up / count down clicked', round_id, match_id, timerCountUpCheck.checked);
            if (timerCountUpCheck.checked) {
                updateTimerState(round_id, match_id, 'count-up');
            } else {
                updateTimerState(round_id, match_id, 'count-down');
            }
        });
    }

    // END TIMER FUNCTIONS

    // HIDE / SHOW WINS

    // attach listener for show wins checkbox on each match
    function attachMatchShowWinsCheckboxListener(round_id, match_id) {
        const winsShowCheck = document.querySelector(`#wins-display-scoreboard-${round_id}-${match_id}`);
        winsShowCheck.addEventListener('change', function () {
            console.log('show / no show wins clicked', round_id, match_id, winsShowCheck.checked);
            const data2send = {
                round_id: round_id,
                match_id: match_id,
                action: 'showWins',
                value: winsShowCheck.checked
            }
            console.log('sending scoreboard wins data', data2send);
            socket.emit('update-scoreboard-state', data2send);
        });
    }

    function updateMatchShowWinsCheckBox() {

    }

    // END HIDE / SHOW WINS

    // FETCH TABLE DATA

    // Add event listener for fetch table button
    function attachFetchTableButtonListener(round_id, match_id) {
        const fetchButton = document.querySelector(`#fetch-table-${round_id}-${match_id}`);
        const tableInput = document.querySelector(`#table-number-${round_id}-${match_id}`);

        fetchButton.addEventListener('click', () => {
            const platform = document.getElementById('tournament-platform-select')?.value;
            const tournamentId = document.getElementById('tournament-id-input')?.value?.trim();
            const tableNumber = tableInput.value;

            if (!platform || platform === 'manual') {
                alert('Please select a platform (Melee.gg or TopDeck.gg) in Global Settings.');
                return;
            }

            if (!tournamentId && platform !== 'cardeio') {
                alert('Please enter a tournament ID in Global Settings.');
                return;
            }

            if (!tableNumber) {
                alert('Please enter a table number.');
                return;
            }

            // Show loading state
            fetchButton.disabled = true;
            fetchButton.textContent = 'Fetching...';
            fetchButton.dataset.fetching = 'true';
            fetchButton.dataset.roundId = round_id;
            fetchButton.dataset.matchId = match_id;

            if (platform === 'cardeio') {
                // Auto-resolve round ID, fetching event detail if needed
                const proceedWithCardeRound = (cardeRoundId) => {
                    socket.emit('fetch-cardeio-round', { roundId: cardeRoundId, roundNumber: round_id });

                    const onRoundFetched = (results) => {
                        socket.off('cardeio-round-fetched', onRoundFetched);
                        if (!results.matches?.success) {
                            fetchButton.disabled = false;
                            fetchButton.textContent = 'Fetch';
                            delete fetchButton.dataset.fetching;
                            alert('Failed to fetch round pairings: ' + (results.matches?.error || 'Unknown error'));
                            return;
                        }
                        socket.emit('fetch-match-by-table', {
                            tournamentId,
                            roundNumber: round_id,
                            tableNumber,
                            platform
                        });
                    };
                    socket.on('cardeio-round-fetched', onRoundFetched);
                };

                let cardeRoundId = window.cardeioRoundMap?.[round_id];
                if (cardeRoundId) {
                    proceedWithCardeRound(cardeRoundId);
                } else {
                    // Round map not loaded — auto-fetch event detail first
                    fetchButton.textContent = 'Resolving rounds...';
                    const onEventDetail = (result) => {
                        socket.off('cardeio-event-detail-fetched', onEventDetail);
                        if (result.success && result.roundMap) {
                            window.cardeioRoundMap = result.roundMap;
                            cardeRoundId = result.roundMap[round_id];
                        }
                        if (!cardeRoundId) {
                            fetchButton.disabled = false;
                            fetchButton.textContent = 'Fetch';
                            delete fetchButton.dataset.fetching;
                            alert(`Round ${round_id} not found in event. Available rounds: ${Object.keys(window.cardeioRoundMap || {}).join(', ') || 'none'}`);
                            return;
                        }
                        fetchButton.textContent = 'Fetching...';
                        proceedWithCardeRound(cardeRoundId);
                    };
                    socket.on('cardeio-event-detail-fetched', onEventDetail);
                    socket.emit('fetch-cardeio-event-detail', { eventId: tournamentId });
                }
            } else {
                socket.emit('fetch-match-by-table', {
                    tournamentId,
                    roundNumber: round_id,
                    tableNumber,
                    platform
                });
            }
        });
    }

    // WINS +/- BUTTONS (event delegation)
    document.addEventListener('click', (e) => {
        if (e.target.classList.contains('wins-plus-btn') || e.target.classList.contains('wins-minus-btn')) {
            const targetId = e.target.dataset.target;
            const winsEl = document.getElementById(targetId);
            if (!winsEl) return;
            let current = parseInt(winsEl.textContent) || 0;
            if (e.target.classList.contains('wins-plus-btn')) {
                current++;
            } else {
                current = Math.max(0, current - 1);
            }
            winsEl.textContent = current.toString();
            winsEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });

    // END FETCH TABLE DATA

    // STANDINGS DATA

    function populateStandingsData() {
        Object.keys(allStandingsData).forEach((round_id) => {
            renderStandings(round_id);
        })
    }

    function renderStandings(roundId) {
        // Check if a card for this match already exists.
        // Standings card was previously appended into the Matches tab's
        // per-round match container (`round-${roundId}-matches`). It now
        // lives in the dedicated Standings tab — the parallel per-round
        // pane created by renderRoundTabs(). Fall back to the old container
        // only if the new one isn't on the page (defensive against an
        // older master-control.html or a future tab refactor).
        let standingsContainer = document.getElementById(`standings-round-${roundId}-content`)
            || document.getElementById(`round-${roundId}-matches`);
        let standingsCard = document.getElementById(`standings-card-${roundId}`);

        if (!standingsCard) {
            // make standings card
            // Create new card (use your existing card HTML structure)
            standingsCard = document.createElement('div');
            // col-4 (was col-6) — standings text content is ~30-char-wide
            // lines, doesn't need half the screen. Frees up col-8 for the
            // BoL card on the right so its legend grid fits 3 columns
            // instead of 2 at typical viewport widths.
            standingsCard.classList.add('col-4', 'mb-3', 'standings-card-container');
            standingsCard.id = `standings-card-${roundId}`;
            // For FQ 2v2 we augment the card with a manual override panel to
            // the right of the textarea (rendered empty here, populated by
            // renderOverridePanel() below). It carries W/L/D boxes per team
            // so the operator can type in live record adjustments and click
            // "Update Standings" to rewrite the textarea. Hidden via
            // .fq2v2-only outside the FQ 2v2 vendor/count combo, which lets
            // the textarea column expand back to full width via CSS.
            // Layout:
            //   - Card title "Standings" at the top, spanning the whole card.
            //   - Textarea column: "Round Standings" label paired inline with
            //     the Fetch Standings button at the top (mirrors the override
            //     column's "Manual Override / Update Standings" header so the
            //     two columns sit symmetrically).
            //   - Override column (FQ 2v2 only): label + Update Standings
            //     button on top, two-group W/L/D grid below.
            standingsCard.innerHTML = `
            <div class="card">
                <div class="card-body">
                    <div class="row mb-4">
                        <!-- Event Information -->
                        <div class="col-12">
                            <div class="row">
                                <div class="col-12">
                                    <h5 class="card-title mb-0">Standings</h5>
                                </div>
                                <div class="col-12 mt-2 standings-textarea-col">
                                    <div class="mb-3">
                                        <div class="d-flex justify-content-between align-items-center mb-2">
                                            <label class="form-label mb-0">Round Standings</label>
                                            <div class="d-flex align-items-center gap-2">
                                                <button class="btn btn-sm btn-success standings-broadcast-btn" data-round-id="${roundId}" title="Push this round to all broadcast scenes">
                                                    Broadcast
                                                </button>
                                                <button class="btn btn-sm btn-primary fetch-standings-btn" data-round-id="${roundId}">
                                                    Fetch Standings
                                                </button>
                                                <input type="text"
                                                    class="form-control form-control-sm fq2v2-only fetch-round-input"
                                                    data-round-id="${roundId}"
                                                    style="width: 80px;"
                                                    placeholder="Round" />
                                            </div>
                                        </div>
                                        <textarea id="standings-${roundId}" class="editable form-control" rows="20"
                                        placeholder="Paste standings here..."></textarea>
                                    </div>

                                    <!-- Searchable structured standings table — mirrors the pairings
                                         tab's search pattern (attachPairingsSearchListener at ~line
                                         2430). Re-parses from the textarea on every update so live
                                         edits flow through. tbody filled by renderStandingsTable(). -->
                                    <div class="standings-search-wrap mb-2">
                                        <input type="text"
                                            class="form-control form-control-sm standings-search"
                                            data-round-id="${roundId}"
                                            placeholder="Search player or archetype…" />
                                    </div>
                                    <div class="table-responsive" style="max-height: 60vh; overflow-y: auto;">
                                        <table class="table table-sm table-striped table-hover standings-table mb-0">
                                            <thead>
                                                <tr>
                                                    <th style="width: 60px;">Rank</th>
                                                    <th>Player</th>
                                                    <th>Archetype</th>
                                                    <th style="width: 90px;">Record</th>
                                                </tr>
                                            </thead>
                                            <tbody id="standings-tbody-${roundId}"></tbody>
                                        </table>
                                    </div>
                                </div>
                                <div class="col-6 mt-2 fq2v2-only standings-override-col"
                                    id="override-panel-${roundId}"
                                    data-round-id="${roundId}">
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
            // Add the new card to the round's match container
            standingsContainer.appendChild(standingsCard);
            // Attach change listeners
            attachStandingsChangeListeners(roundId);
            // Render the override panel now (uses current group assignment,
            // re-renders on `groupAssignmentUpdated` — see socket listener below).
            renderOverridePanel(roundId);
        }

        // Update the fields with the match data
        const standingsTextbox = document.getElementById(`standings-${roundId}`);
        standingsTextbox.value = allStandingsData[roundId];
        // Render the searchable table from the just-updated textarea
        // contents. Called on every populate path (initial socket load,
        // round tab creation) so the table stays in sync with the
        // textarea without a separate data flow.
        renderStandingsTable(roundId);
    }

    // Function to attach change listeners to all editable fields for a given match ID.
    //
    // Invariant this relies on: the standings card (and its textarea) is built
    // exactly once per round, inside the `if (!existing)` branch above. Nothing
    // else — including `rerenderAllOverridePanels()` which only mutates the
    // override-panel container — touches this textarea, so binding an `input`
    // listener here is safe and can't double-fire. If that ever changes (e.g.
    // the whole standings card gets re-rendered on vendor swap), switch to a
    // delegated listener on the round-card container to avoid duplicate binds.
    function attachStandingsChangeListeners(roundId) {
        const standingsTextbox = document.querySelector(`#standings-${roundId}.editable`);

        standingsTextbox.addEventListener('input', () => {
            let value = standingsTextbox.value;

            // Update the local standings data when a field changes
            updateStandingsData(roundId, value);
            // Emit the updated standings data to the backend
            console.log('updated standings data', allStandingsData);
            socket.emit('standings-updated', {round_id: roundId, textData: value});
            // Live edits: re-parse + re-render the searchable table so
            // the operator sees their corrections reflected immediately.
            renderStandingsTable(roundId);
        });

        // Wire the standings-search input to live-filter the table rows.
        attachStandingsSearchListener(roundId);
    }

    // Parse the standings textarea into structured rows. The textarea
    // format is 4 lines per player — rank / name / archetype / record —
    // matching what tournament-platform.js's fetch-response handler
    // writes (see `textLines.push(...)` in that file). Returns an array
    // sorted by rank ascending. Lines are trimmed; blank trailing lines
    // are tolerated. For FQ 2v2's 4-line "rank / p1 / p2 / record"
    // shape, this collapses the two player names into a single string
    // — good enough for search; the broadcast page has its own 2v2
    // renderer that splits them properly.
    function parseStandingsTextToRows(rawText) {
        if (typeof rawText !== 'string' || !rawText.trim()) return [];
        const lines = rawText.split(/\r?\n/);
        const rows = [];
        for (let i = 0; i + 3 < lines.length; i += 4) {
            const rank = (lines[i] || '').trim();
            const name = (lines[i + 1] || '').trim();
            const archetype = (lines[i + 2] || '').trim();
            const record = (lines[i + 3] || '').trim();
            // Skip empty groups (textarea trailing newlines)
            if (!rank && !name && !archetype && !record) continue;
            rows.push({ rank, name, archetype, record });
        }
        // Sort by rank numerically (handles "1", "2", "10" correctly)
        rows.sort((a, b) => (parseInt(a.rank, 10) || 0) - (parseInt(b.rank, 10) || 0));
        return rows;
    }

    // Repaint the per-round searchable standings table from whatever's
    // currently in the textarea. Called on (1) initial socket load,
    // (2) Fetch Standings response, (3) any live textarea edit.
    // Repaint the per-round standings table. Empty search box → the broadcast
    // cut parsed from the textarea; a search query → matches from the FULL
    // round standings (all players). Both routed through applyStandingsFilter.
    function renderStandingsTable(roundId) {
        applyStandingsFilter(roundId);
    }

    // The broadcast-cut rows parsed straight from the textarea (no filtering).
    function renderStandingsRowsFromTextarea(roundId) {
        const tbody = document.getElementById(`standings-tbody-${roundId}`);
        if (!tbody) return;
        const raw = allStandingsData[roundId];
        const rows = parseStandingsTextToRows(typeof raw === 'string' ? raw : '');
        tbody.innerHTML = rows.length === 0
            ? '<tr><td colspan="4" class="text-muted text-center">No standings loaded.</td></tr>'
            : rows.map(r => `
                <tr>
                    <td>${escapeHtml(r.rank)}</td>
                    <td>${escapeHtml(r.name)}</td>
                    <td>${escapeHtml(r.archetype)}</td>
                    <td>${escapeHtml(r.record)}</td>
                </tr>`).join('');
    }

    // Cheap HTML escape so a player name containing < or > doesn't
    // break the row. Matches the pattern used by pairings rendering.
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Same live-filter pattern as attachPairingsSearchListener
    // (line ~2430 below). Case-insensitive substring match across the
    // whole row's textContent — catches rank, player, archetype,
    // record without needing per-column logic.
    function attachStandingsSearchListener(roundId) {
        const input = document.querySelector(`.standings-search[data-round-id="${roundId}"]`);
        if (!input) return;
        input.addEventListener('input', () => applyStandingsFilter(roundId));
    }

    // Standings search. Empty query → show the broadcast cut from the textarea.
    // Non-empty query → search EVERY player in the round's standings (the full
    // server-provided list), so mid-field players that aren't in the broadcast
    // cut are still findable. The full list is lazy-loaded per round on the
    // first search; the `full-standings-data` listener caches it and re-runs
    // this filter. Searches across handle + real name + best-identifier.
    function applyStandingsFilter(roundId) {
        const input = document.querySelector(`.standings-search[data-round-id="${roundId}"]`);
        const tbody = document.getElementById(`standings-tbody-${roundId}`);
        if (!input || !tbody) return;
        const q = input.value.trim().toLowerCase();
        if (!q) { renderStandingsRowsFromTextarea(roundId); return; }

        const full = fullStandingsByRound[roundId];
        if (!full) {
            if (!fullStandingsRequested.has(roundId)) {
                fullStandingsRequested.add(roundId);
                socket.emit('get-full-standings', { roundNumber: roundId });
                // Watchdog: if no reply arrives the search is broken (usually a
                // server that hasn't been restarted for this feature). Surface
                // that rather than spinning, and clear the in-flight flag so the
                // next keystroke retries.
                clearTimeout(fullStandingsTimers[roundId]);
                fullStandingsTimers[roundId] = setTimeout(() => {
                    if (fullStandingsByRound[roundId]) return; // answered in time
                    fullStandingsRequested.delete(roundId);
                    const tb = document.getElementById(`standings-tbody-${roundId}`);
                    if (tb) tb.innerHTML = '<tr><td colspan="4" class="text-danger text-center">Full search unavailable — restart the server, then try again.</td></tr>';
                }, FULL_STANDINGS_TIMEOUT_MS);
            }
            tbody.innerHTML = '<tr><td colspan="4" class="text-muted text-center">Searching all players…</td></tr>';
            return;
        }
        const matches = full.filter(p => p.search.includes(q));
        // When the requested round has no file yet, the server served the latest
        // available round — tell the operator which round these standings are from.
        const used = fullStandingsRoundUsed[roundId];
        const noteRow = (used && String(used) !== String(roundId))
            ? `<tr><td colspan="4" class="text-info text-center small">Round ${escapeHtml(roundId)} not posted yet — showing latest standings (round ${escapeHtml(used)})</td></tr>`
            : '';
        tbody.innerHTML = matches.length === 0
            ? noteRow + '<tr><td colspan="4" class="text-muted text-center">No player matches.</td></tr>'
            : noteRow + matches.map(p => `
                <tr>
                    <td>${escapeHtml(p.rank == null ? '' : p.rank)}</td>
                    <td>${escapeHtml(p.name)}</td>
                    <td>${escapeHtml(p.legend)}</td>
                    <td>${escapeHtml(p.record)}</td>
                </tr>`).join('');
    }

    function updateStandingsData(roundId, value) {
        if (!allStandingsData[roundId]) {
            allStandingsData[roundId] = {};
        }
        console.log(roundId, value)
        allStandingsData[roundId] = value;
    }

    // ── BEST OF LEGEND (riftbound) ────────────────────────────────────
    // Per-round, per-Legend top-3 leaderboard sourced from the server's
    // `get-best-of-legend` snapshot. Card is appended into each
    // Standings round sub-tab pane on first data arrival, so it lands
    // AFTER the standings card (which is appended by renderStandings).
    // Bootstrap row + col-6 on each puts standings left, BoL right.
    // `.riftbound-only` keeps the card hidden for non-riftbound games.
    let allBestOfLegendData = {}; // { [roundId]: { legends: [...], unmatchedPlayers, … } }

    // Per-round filter state — name-search + multi-select set
    // checkboxes. Held outside the DOM so re-rendering on a fresh
    // data push preserves operator selections. `activeSets` is a
    // Set<string> of bucket values that are currently CHECKED. All
    // sets checked by default = show everything.
    const bolFilterState = {}; // { [roundId]: { search: '', activeSets: Set<string> } }

    // Set buckets the operator can toggle. Match the server-side
    // `getLegendSet()` output. "OTHER" is included so future-set
    // legends still get a checkbox if they show up before this list
    // is updated.
    const BOL_SET_BUCKETS = [
        { value: 'OGS+OGN', label: 'OGS + OGN' },
        { value: 'SFD',     label: 'SFD'       },
        { value: 'UNL',     label: 'UNL'       },
        { value: 'VEN',     label: 'VEN'       },
        { value: 'OTHER',   label: 'Other'     }
    ];

    function bolFilterStateFor(roundId) {
        if (!bolFilterState[roundId]) {
            bolFilterState[roundId] = {
                search: '',
                activeSets: new Set(BOL_SET_BUCKETS.map(b => b.value))
            };
        }
        return bolFilterState[roundId];
    }

    function ensureBolCard(roundId) {
        let card = document.getElementById(`bol-card-${roundId}`);
        if (card) return card;
        const pane = document.getElementById(`standings-round-${roundId}-content`);
        if (!pane) return null;
        // Set-filter dropdown: Bootstrap dropdown w/ check-list inside.
        // `data-bs-auto-close="outside"` keeps the menu open while the
        // operator toggles multiple boxes; clicking outside closes it.
        const dropdownOptions = BOL_SET_BUCKETS.map(b => `
            <li>
                <label class="dropdown-item bol-set-option" style="cursor: pointer;">
                    <input type="checkbox"
                        class="form-check-input me-2 bol-set-checkbox"
                        data-set="${b.value}"
                        checked>
                    ${b.label}
                </label>
            </li>
        `).join('');

        const html = `
            <div class="col-8 mb-3 best-of-legend-card-container riftbound-only" id="bol-card-${roundId}">
                <div class="card">
                    <div class="card-body">
                        <div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
                            <h5 class="card-title mb-0">Best of Legend before Round ${roundId}</h5>
                            <div class="d-flex align-items-center gap-2">
                                <div class="dropdown bol-set-dropdown" data-round-id="${roundId}">
                                    <button class="btn btn-sm btn-outline-secondary dropdown-toggle bol-set-toggle"
                                        type="button"
                                        data-bs-toggle="dropdown"
                                        data-bs-auto-close="outside"
                                        aria-expanded="false">
                                        Sets <span class="bol-set-count">(${BOL_SET_BUCKETS.length}/${BOL_SET_BUCKETS.length})</span>
                                    </button>
                                    <ul class="dropdown-menu dropdown-menu-end p-1" style="min-width: 160px;">
                                        ${dropdownOptions}
                                        <li><hr class="dropdown-divider"></li>
                                        <li class="d-flex gap-1 px-2 pb-1">
                                            <button type="button" class="btn btn-sm btn-outline-secondary flex-fill bol-set-all" data-round-id="${roundId}">All</button>
                                            <button type="button" class="btn btn-sm btn-outline-secondary flex-fill bol-set-none" data-round-id="${roundId}">None</button>
                                        </li>
                                    </ul>
                                </div>
                                <input type="text"
                                    class="form-control form-control-sm bol-search"
                                    data-round-id="${roundId}"
                                    placeholder="Filter legend…"
                                    style="width: 200px;" />
                            </div>
                        </div>
                        <div class="bol-status text-muted small mb-2"
                             id="bol-status-${roundId}">Loading…</div>
                        <div class="bol-grid" id="bol-grid-${roundId}"></div>
                    </div>
                </div>
            </div>
        `;
        // appendChild via insertAdjacentHTML so the card lands AFTER
        // the standings card (which is already in the pane). Result:
        // standings col-6 LEFT + BoL col-6 RIGHT.
        pane.insertAdjacentHTML('beforeend', html);
        attachBolFilterListeners(roundId);
        return document.getElementById(`bol-card-${roundId}`);
    }

    // Wires both the name-search input and the set-checkbox dropdown.
    // All three update the same per-round filter state and call
    // applyBolFilters() — one source of truth for hiding rows.
    function attachBolFilterListeners(roundId) {
        const search = document.querySelector(`.bol-search[data-round-id="${roundId}"]`);
        if (search) {
            search.addEventListener('input', () => {
                bolFilterStateFor(roundId).search = search.value.trim().toLowerCase();
                applyBolFilters(roundId);
            });
        }
        const dropdown = document.querySelector(`.bol-set-dropdown[data-round-id="${roundId}"]`);
        if (dropdown) {
            // Each checkbox toggles its set's membership in activeSets.
            dropdown.querySelectorAll('.bol-set-checkbox').forEach(cb => {
                cb.addEventListener('change', () => {
                    const state = bolFilterStateFor(roundId);
                    if (cb.checked) state.activeSets.add(cb.dataset.set);
                    else state.activeSets.delete(cb.dataset.set);
                    applyBolFilters(roundId);
                });
            });
            // "All" / "None" quick-toggles at the bottom of the menu.
            const allBtn = dropdown.querySelector('.bol-set-all');
            const noneBtn = dropdown.querySelector('.bol-set-none');
            if (allBtn) allBtn.addEventListener('click', () => setAllSetCheckboxes(roundId, true));
            if (noneBtn) noneBtn.addEventListener('click', () => setAllSetCheckboxes(roundId, false));
        }
    }

    // Helper: toggle every set checkbox to a given state. Used by the
    // All/None buttons so the operator can flip the whole filter
    // without unchecking each one manually.
    function setAllSetCheckboxes(roundId, checked) {
        const dropdown = document.querySelector(`.bol-set-dropdown[data-round-id="${roundId}"]`);
        if (!dropdown) return;
        const state = bolFilterStateFor(roundId);
        dropdown.querySelectorAll('.bol-set-checkbox').forEach(cb => {
            cb.checked = checked;
            if (checked) state.activeSets.add(cb.dataset.set);
            else state.activeSets.delete(cb.dataset.set);
        });
        applyBolFilters(roundId);
    }

    // Hide/show legend blocks based on current name search + active
    // sets. activeSets is a Set<string> — block must have its set in
    // the Set to be visible. Empty search + all sets active reveals
    // everything.
    function applyBolFilters(roundId) {
        const grid = document.getElementById(`bol-grid-${roundId}`);
        if (!grid) return;
        const { search, activeSets } = bolFilterStateFor(roundId);
        let visible = 0;
        grid.querySelectorAll('.bol-legend').forEach(block => {
            const name = (block.getAttribute('data-legend') || '').toLowerCase();
            const set = block.getAttribute('data-set') || 'OTHER';
            const matchesSearch = !search || name.includes(search);
            const matchesSet = activeSets.has(set);
            const ok = matchesSearch && matchesSet;
            block.style.display = ok ? '' : 'none';
            if (ok) visible++;
        });
        // Update the dropdown toggle label to reflect "(N/total)" so
        // the operator sees at a glance how many sets are active
        // without opening the menu.
        const toggle = document.querySelector(`.bol-set-dropdown[data-round-id="${roundId}"] .bol-set-count`);
        if (toggle) {
            toggle.textContent = `(${activeSets.size}/${BOL_SET_BUCKETS.length})`;
        }
        // Update status to show how many are visible vs total.
        const status = document.getElementById(`bol-status-${roundId}`);
        if (status && status.dataset.baseStatus) {
            const base = status.dataset.baseStatus;
            const total = grid.querySelectorAll('.bol-legend').length;
            status.textContent = (visible === total)
                ? base
                : `Showing ${visible} of ${total} legends · ${base}`;
        }
    }

    // Top-N row HTML for one candidate. Layout:
    //   #1   IGN (with real name subtitle)            8-0-0
    //                                                 #157
    // Record + overall rank are stacked vertically on the right
    // (was a single horizontal row) so the name column has the
    // full freed-up width — long IGNs like "Prismaticismism" no
    // longer truncate with ellipsis. Title attribute on the name
    // gives operators the full string on hover regardless.
    function bolCandidateRowHtml(c, position) {
        const ign = c.displayName || c.bestIdentifier || '';
        const real = c.realName || '';
        const fullForTitle = ign && real && ign !== real ? `${ign} (${real})` : (ign || real || '?');
        const igsAndReal = (ign && real && ign !== real)
            ? `<div class="bol-name" title="${escapeHtml(fullForTitle)}">${escapeHtml(ign)}</div><div class="bol-real text-muted small">${escapeHtml(real)}</div>`
            : `<div class="bol-name" title="${escapeHtml(fullForTitle)}">${escapeHtml(ign || real || '?')}</div>`;
        return `
            <li class="bol-row">
                <span class="bol-position">#${position}</span>
                <span class="bol-player">${igsAndReal}</span>
                <span class="bol-meta">
                    <span class="bol-record">${escapeHtml(c.record || '—')}</span>
                    <span class="bol-rank text-muted small">#${c.rank}</span>
                </span>
            </li>
        `;
    }

    // Render one legend's block — portrait + header + top-N list.
    function bolLegendBlockHtml(entry) {
        // Eager load (no `loading="lazy"`): browsers don't reliably
        // trigger lazy-load for elements rendered inside an inactive
        // Bootstrap tab pane, so we end up with permanently-blank
        // circles when the operator switches tabs. With 251×124
        // portraits (~55 KB), eager loading 28 × 16 = 448 images
        // costs ~25 MB total but parallelizes across the connection.
        const portrait = entry.portraitUrl
            ? `<img src="${escapeHtml(entry.portraitUrl)}" alt="${escapeHtml(entry.legend)}" class="bol-portrait-img" onerror="this.style.display='none'">`
            : '';
        const rows = (entry.topPlayers || []).map((c, i) => bolCandidateRowHtml(c, i + 1)).join('');
        return `
            <div class="bol-legend" data-legend="${escapeHtml(entry.legend)}" data-set="${escapeHtml(entry.set || 'OTHER')}">
                <div class="bol-portrait">${portrait}</div>
                <div class="bol-content">
                    <div class="bol-header">
                        <span class="bol-legend-name">${escapeHtml(entry.legend)}</span>
                        <span class="bol-deck-count text-muted small">${entry.totalDecks} deck${entry.totalDecks === 1 ? '' : 's'}</span>
                    </div>
                    <ol class="bol-top5">
                        ${rows}
                    </ol>
                </div>
            </div>
        `;
    }

    function renderBestOfLegend(roundId, dataForRound) {
        const card = ensureBolCard(roundId);
        if (!card) return;
        const grid = document.getElementById(`bol-grid-${roundId}`);
        const status = document.getElementById(`bol-status-${roundId}`);
        if (!grid) return;
        if (!dataForRound || !Array.isArray(dataForRound.legends) || dataForRound.legends.length === 0) {
            grid.innerHTML = '';
            if (status) {
                status.dataset.baseStatus = '';
                status.textContent = dataForRound?.error
                    || 'No legend data for this round. Run Fetch Event Data → Decklists for the active event, then re-fetch standings.';
            }
            return;
        }
        grid.innerHTML = dataForRound.legends.map(bolLegendBlockHtml).join('');
        if (status) {
            const totalLegends = dataForRound.legends.length;
            const totalDecks = dataForRound.legends.reduce((sum, l) => sum + (l.totalDecks || 0), 0);
            const unmatched = dataForRound.unmatchedPlayers || 0;
            const tail = unmatched > 0 ? ` · ${unmatched} player(s) without a cached deck excluded` : '';
            const base = `${totalLegends} legends played · ${totalDecks} decks total${tail}`;
            status.dataset.baseStatus = base;
            status.textContent = base;
        }
        // Re-apply any operator-active filter (preserved across refreshes).
        applyBolFilters(roundId);
    }

    function populateBestOfLegendData() {
        // Render every standings round sub-tab — passing the data we
        // got from the server when it exists, or null otherwise. The
        // server only emits entries for rounds with standings JSON on
        // disk, so rounds without cached standings (e.g. operator
        // moved files out of `data/cardeio/`) get an empty card with
        // the "No legend data for this round" hint instead of a
        // missing-card surprise.
        const tabsContainer = document.getElementById('standingsRoundTabs');
        if (!tabsContainer) {
            // Fallback: no standings tabs rendered yet, just paint
            // whatever the server sent.
            Object.keys(allBestOfLegendData).forEach(roundId => {
                renderBestOfLegend(roundId, allBestOfLegendData[roundId]);
            });
            return;
        }
        Array.from(tabsContainer.querySelectorAll('button')).forEach(btn => {
            const m = btn.id.match(/^standings-round-(\d+)-tab$/);
            if (!m) return;
            const roundId = m[1];
            renderBestOfLegend(roundId, allBestOfLegendData[roundId] || null);
        });
    }

    // ── PAIRINGS (Carde.io v2 matches-list) ────────────────────────────
    // Per-round table of matches sourced from
    // `tournament-pairings-fetched` (one round) and `all-pairings-data`
    // (every cached round on page load). Render shape mirrors anu-api's
    // pairings columns — Table | P1 | Record | P2 | Record | Status |
    // Winner — adapted to a plain Bootstrap table since we don't have
    // tanstack/table on the master-control page.
    let allPairingsData = {};

    // Build the empty pairings card markup for a round. Card is rendered
    // synchronously inside renderRoundTabs() so the Fetch button is
    // clickable before any pairings data has arrived; the tbody fills
    // in when a fetch response (or cached snapshot) lands.
    function renderEmptyPairingsCard(roundId) {
        return `
            <div class="col-12 mb-3 pairings-card-container" id="pairings-card-${roundId}">
                <div class="card">
                    <div class="card-body">
                        <div class="d-flex justify-content-between align-items-center mb-3">
                            <h5 class="card-title mb-0">Round ${roundId} Pairings</h5>
                            <div class="d-flex align-items-center gap-2">
                                <input type="text"
                                    class="form-control form-control-sm pairings-search"
                                    data-round-id="${roundId}"
                                    placeholder="Search player or table…"
                                    style="width: 240px;" />
                                <button class="btn btn-sm btn-primary fetch-pairings-btn"
                                    data-round-id="${roundId}">Fetch Pairings</button>
                            </div>
                        </div>
                        <div class="pairings-status text-muted small mb-2"
                             id="pairings-status-${roundId}">No pairings loaded yet — click Fetch Pairings.</div>
                        <div class="table-responsive" style="max-height: 70vh; overflow-y: auto;">
                            <table class="table table-sm table-striped table-hover pairings-table mb-0">
                                <thead>
                                    <tr>
                                        <th style="width: 60px;">Table</th>
                                        <th>Player 1</th>
                                        <th style="width: 160px;">Legend</th>
                                        <th style="width: 70px;">Record</th>
                                        <th>Player 2</th>
                                        <th style="width: 160px;">Legend</th>
                                        <th style="width: 70px;">Record</th>
                                        <th style="width: 100px;">Status</th>
                                        <th>Winner</th>
                                    </tr>
                                </thead>
                                <tbody id="pairings-tbody-${roundId}"></tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    // Live filter for the pairings search box. Hides any tbody row whose
    // textContent doesn't include the query (case-insensitive). Cheap;
    // fine for ~1k rows per round.
    function attachPairingsSearchListener(roundId) {
        const input = document.querySelector(`.pairings-search[data-round-id="${roundId}"]`);
        if (!input) return;
        input.addEventListener('input', () => {
            const q = input.value.trim().toLowerCase();
            const tbody = document.getElementById(`pairings-tbody-${roundId}`);
            if (!tbody) return;
            tbody.querySelectorAll('tr').forEach(row => {
                if (!q) {
                    row.style.display = '';
                    return;
                }
                row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
            });
        });
    }

    // Resolve a player cell (HTML) from their pairings relationship.
    // Layout matches anu-api's pairings page — Riot/in-game name as the
    // primary line + real name as a smaller, muted subtitle so casters
    // can quickly recognize either form.
    //   <div>Anzid To Win</div>
    //   <div class="text-muted small">Anuraag Das</div>
    //
    // Source priority:
    //   - Primary line: `game_user.display_name` (Carde stores the
    //     player's Riot-account gameName here, e.g. "Anzid To Win").
    //     Carde does NOT expose the `#NA1` tagline anywhere — that
    //     requires hitting Riot's Account API by-PUUID, which needs
    //     a separate API key. If we add `RIOT_API_KEY` to .env later,
    //     we can append `#${tagLine}` server-side and this function
    //     will pick it up via `rel.riot_id_with_tagline` (TBD).
    //   - Subtitle: `first_last` (the real name on the registration).
    //   - Fallbacks: best_identifier → "Unknown" if everything is null.
    //
    // Returns HTML — caller already uses .innerHTML to lay out rows
    // and we own the inputs (escapeHtml() applied on every dynamic
    // segment), so this stays safe.
    function resolvePairingsPlayerCell(rel) {
        if (!rel) return '—';
        const player = rel.player || {};
        const user = rel.user_event_status?.user || {};
        const gameName = user.game_user?.display_name || '';
        const realName = user.first_last
            || `${player.first_name || ''} ${player.last_name || ''}`.trim()
            || '';
        const fallback = user.best_identifier || player.best_identifier || 'Unknown';

        // Build the primary line. If the server has appended a Riot
        // tagline (future enhancement), it lands on the relationship
        // as `riot_id_with_tagline` and replaces the gameName.
        const primary = rel.riot_id_with_tagline || gameName || fallback;
        const subtitle = realName && realName !== primary ? realName : '';

        if (subtitle) {
            return `<div>${escapeHtml(primary)}</div>` +
                   `<div class="text-muted small">${escapeHtml(subtitle)}</div>`;
        }
        return escapeHtml(primary);
    }

    // Plain-text version — used when we need the raw name for search /
    // logging. Same priority as the cell renderer.
    function resolvePairingsPlayerName(rel) {
        if (!rel) return '—';
        const player = rel.player || {};
        const user = rel.user_event_status?.user || {};
        return rel.riot_id_with_tagline
            || user.game_user?.display_name
            || user.first_last
            || user.best_identifier
            || player.best_identifier
            || `${player.first_name || ''} ${player.last_name || ''}`.trim()
            || 'Unknown';
    }

    // Server augments each relationship with `legend` from the cached
    // decklist export (joined by player.id). Returns "—" when no
    // decklist was cached for this event/player (e.g. operator hasn't
    // run "Fetch Event Data → Decklists" for the active event yet).
    function resolvePairingsLegend(rel) {
        const legend = rel?.legend;
        if (!legend) return '—';
        return String(legend);
    }

    function resolvePairingsRecord(rel) {
        // Server enriches each relationship with `pre_round_record` —
        // the player's record going INTO the displayed round, joined
        // server-side from data/cardeio/standings-api-event-{id}-round-{N-1}.json.
        // That's what an operator wants in a pairings table ("Will sat
        // down at table 5 with a 4-1 record"), not the player's final
        // tournament tally that the embedded user_event_status carries.
        if (rel?.pre_round_record) {
            const r = String(rel.pre_round_record);
            // Drop trailing "-0" draws column for symmetry with how
            // standings textareas format records — but ONLY when the
            // string has three parts (W-L-D). "0-0" must stay "0-0",
            // not collapse to "0".
            const parts = r.split('-');
            if (parts.length === 3 && parts[2] === '0') {
                return `${parts[0]}-${parts[1]}`;
            }
            return r;
        }
        // Fallback path — server didn't have a standings cache loaded
        // (e.g. operator bulk-fetched pairings but not standings).
        // Show the embedded final tally so the column isn't blank.
        const ues = rel?.user_event_status;
        if (!ues) return '—';
        const w = ues.matches_won ?? 0;
        const l = ues.matches_lost ?? 0;
        const d = ues.matches_drawn ?? 0;
        return d ? `${w}-${l}-${d}` : `${w}-${l}`;
    }

    // Resolve which player won a match. Carde's `winning_player_id` is
    // the player.id (and equivalently user.id — same number). Empty
    // when the match was an intentional/unintentional draw, or when
    // the status is still pending/in-progress.
    function resolvePairingsWinner(match) {
        if (match.match_is_bye) return '—';
        if (match.match_is_intentional_draw || match.match_is_unintentional_draw) return 'Draw';
        if (!match.winning_player_id) {
            // No winner reported yet — leave blank rather than guessing.
            return '';
        }
        const rels = match.player_match_relationships || [];
        for (const rel of rels) {
            const playerId = rel.player?.id ?? rel.user_event_status?.user?.id;
            if (playerId != null && Number(playerId) === Number(match.winning_player_id)) {
                return resolvePairingsPlayerName(rel);
            }
        }
        return '';
    }

    // Format the raw `status` enum into something readable. Carde uses
    // values like `MATCH_STATUS_REPORTED`, `MATCH_STATUS_PENDING`,
    // `MATCH_STATUS_IN_PROGRESS`. Strip the prefix + lowercase + title-case.
    function formatPairingsStatus(status) {
        if (!status) return '—';
        return String(status)
            .replace(/^MATCH_STATUS_/, '')
            .toLowerCase()
            .replace(/(^|_)(\w)/g, (_, sep, c) => (sep ? ' ' : '') + c.toUpperCase());
    }

    // Render the entire tbody for one round's pairings. Sorted by
    // `table_number` ascending. Idempotent — replaces any prior rows.
    function renderPairings(roundId, matches) {
        const tbody = document.getElementById(`pairings-tbody-${roundId}`);
        const status = document.getElementById(`pairings-status-${roundId}`);
        if (!tbody) return;

        if (!Array.isArray(matches) || matches.length === 0) {
            tbody.innerHTML = '';
            if (status) status.textContent = 'No pairings returned for this round.';
            return;
        }

        const sorted = [...matches].sort((a, b) => {
            const ta = Number(a.table_number ?? Number.POSITIVE_INFINITY);
            const tb = Number(b.table_number ?? Number.POSITIVE_INFINITY);
            return ta - tb;
        });

        const rows = sorted.map(match => {
            const rels = match.player_match_relationships || [];
            const p1 = rels[0];
            const p2 = rels[1];
            const isBye = !!match.match_is_bye;
            // Carde returns table_number = -1 for byes (no physical table).
            // Show an em-dash instead so the column reads cleanly.
            const tableCell = (match.table_number == null || match.table_number === -1) ? '—' : match.table_number;
            // Player cells render Riot/in-game name primary + real name
            // subtitle. resolvePairingsPlayerCell returns pre-escaped HTML.
            const p1Cell = resolvePairingsPlayerCell(p1);
            const p1Record = resolvePairingsRecord(p1);
            const p1Legend = resolvePairingsLegend(p1);
            const p2Cell = isBye ? 'BYE' : (p2 ? resolvePairingsPlayerCell(p2) : '—');
            const p2Record = isBye ? '—' : (p2 ? resolvePairingsRecord(p2) : '—');
            const p2Legend = isBye ? '—' : (p2 ? resolvePairingsLegend(p2) : '—');
            const winner = resolvePairingsWinner(match);
            return `
                <tr>
                    <td>${tableCell}</td>
                    <td>${p1Cell}</td>
                    <td>${escapeHtml(p1Legend)}</td>
                    <td>${escapeHtml(p1Record)}</td>
                    <td>${p2Cell}</td>
                    <td>${escapeHtml(p2Legend)}</td>
                    <td>${escapeHtml(p2Record)}</td>
                    <td>${escapeHtml(formatPairingsStatus(match.status))}</td>
                    <td>${escapeHtml(winner)}</td>
                </tr>
            `;
        });
        tbody.innerHTML = rows.join('');

        if (status) {
            // Carde uses `COMPLETE` as the terminal status (occasionally
            // `REPORTED` on older events). Match either as "finished".
            const finished = sorted.filter(m => /complete|reported/i.test(m.status || '')).length;
            const byes = sorted.filter(m => m.match_is_bye).length;
            status.textContent = `${sorted.length} matches (${finished} finished, ${byes} byes).`;
        }
    }

    // Tiny HTML-escape — pairings data comes straight from Carde and may
    // include user-supplied display names with weird characters. Cheap
    // safety net since we're using .innerHTML to lay out rows.
    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Repaint every cached round (called when the `all-pairings-data`
    // snapshot lands at page-load time).
    function populatePairingsData() {
        Object.keys(allPairingsData).forEach(roundId => {
            renderPairings(roundId, allPairingsData[roundId]);
        });
    }

    // Click delegate for `.standings-broadcast-btn` — convenience
    // duplicate of the Matches tab's per-round Broadcast button so the
    // operator can push a round to broadcast without leaving the
    // Standings tab. Same `broadcast-requested` socket event + same
    // `currentBroadcastRoundId` update as the original handler in
    // attachBroadcastButtonListeners(). The Matches tab button still
    // works exactly as before — this just adds a second entry point.
    document.addEventListener('click', (e) => {
        const btn = e.target.closest?.('.standings-broadcast-btn');
        if (!btn) return;
        const roundId = btn.dataset.roundId;
        if (!roundId) return;
        console.log(`broadcast clicked from standings tab for round ${roundId}`);
        if (broadcastDisplay) broadcastDisplay.innerText = `Round ${roundId}`;
        socket.emit('broadcast-requested', { round_id: roundId });
        currentBroadcastRoundId = String(roundId);
    });

    // Click delegate for `.fetch-pairings-btn`. Reads platform +
    // tournament-id from Global Settings (same source the standings
    // fetch uses) and emits `fetch-tournament-pairings`. Disabled-state
    // / restored-state mirrors the existing `.fetch-standings-btn`
    // delegate in tournament-platform.js.
    document.addEventListener('click', (e) => {
        const btn = e.target.closest?.('.fetch-pairings-btn');
        if (!btn) return;
        const roundId = btn.dataset.roundId;
        const platformSelect = document.getElementById('tournament-platform-select');
        const tournamentIdInput = document.getElementById('tournament-id-input');
        const platform = platformSelect?.value || 'manual';
        const tournamentId = (tournamentIdInput?.value || '').trim();

        if (platform !== 'cardeio') {
            alert('Pairings fetch is only supported for Carde.io. Switch the platform in Global Settings → Tournament Platform.');
            return;
        }
        if (!tournamentId) {
            alert('Please enter a tournament ID in Global Settings.');
            return;
        }

        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Fetching…';
        btn.dataset.fetching = 'true';

        const status = document.getElementById(`pairings-status-${roundId}`);
        if (status) status.textContent = `Fetching round ${roundId} pairings from Carde…`;

        socket.emit('fetch-tournament-pairings', { platform, tournamentId, roundId });

        // Re-enable the button after the response (or 30 s timeout).
        const restore = () => {
            btn.disabled = false;
            btn.textContent = original;
            delete btn.dataset.fetching;
        };
        const onResp = (result) => {
            if (String(result.roundId) !== String(roundId)) return;
            socket.off('tournament-pairings-fetched', onResp);
            restore();
            if (!result.success && status) {
                status.textContent = `Fetch failed: ${result.error}`;
            }
        };
        socket.on('tournament-pairings-fetched', onResp);
        setTimeout(() => {
            if (btn.dataset.fetching === 'true') {
                socket.off('tournament-pairings-fetched', onResp);
                restore();
                if (status) status.textContent = 'Fetch timed out (30 s).';
            }
        }, 30000);
    });

    // ── FQ 2v2 manual override panel ────────────────────────────────────────
    // Renders the 8-team override grid (4 per group) into
    // #override-panel-${roundId}. Each row has W/L/D number inputs and the
    // footer has an "Update Standings" button.
    //
    // The panel is always rendered into the DOM — `.fq2v2-only` CSS keeps it
    // hidden for every other vendor/count — so a vendor/count switch doesn't
    // need to re-render; the panel just becomes visible again with whatever
    // group-assignment state is current.
    function renderOverridePanel(roundId) {
        const container = document.getElementById(`override-panel-${roundId}`);
        if (!container) return;

        const group1 = currentGroupAssignment.group1 || [];
        const group2 = currentGroupAssignment.group2 || [];

        // Loading state — the override panel renders synchronously when the
        // round card is built, but group assignments arrive via socket. Show a
        // neutral placeholder until the first `groupAssignmentUpdated` response
        // lands so the operator doesn't see a misleading "not saved" message
        // during the first few frames after load.
        if (!groupAssignmentReceived) {
            container.innerHTML = `
                <label class="form-label mb-2">Manual Override (FQ 2v2)</label>
                <div class="text-muted small">Loading group assignment…</div>
            `;
            return;
        }

        // Empty state when the Groups tab hasn't been populated yet — nudge
        // the operator toward it rather than showing blank rows.
        if (group1.length === 0 && group2.length === 0) {
            container.innerHTML = `
                <label class="form-label mb-2">Manual Override (FQ 2v2)</label>
                <div class="text-muted small">
                    Override panel available once Group Assignment is saved
                    (see the Groups tab).
                </div>
            `;
            return;
        }

        // Team row — compact layout so two groups fit side-by-side. W/L/D
        // inputs are narrow (45px) and left-padding removed so short-name
        // rows don't blow out the column. Team name truncates with an
        // `ellipsis` title tooltip for accessibility.
        const rowHTML = (teamName) => `
            <div class="d-flex align-items-center mb-2 override-row" data-team-name="${teamName.replace(/"/g, '&quot;')}">
                <span class="team-name flex-grow-1 text-truncate pe-1" title="${teamName.replace(/"/g, '&quot;')}">${teamName}</span>
                <input type="number" min="0" class="override-w form-control form-control-sm" style="width:45px;padding:0.15rem 0.25rem" placeholder="W" />
                <input type="number" min="0" class="override-l form-control form-control-sm ms-1" style="width:45px;padding:0.15rem 0.25rem" placeholder="L" />
                <input type="number" min="0" class="override-d form-control form-control-sm ms-1" style="width:45px;padding:0.15rem 0.25rem" placeholder="D" />
            </div>
        `;

        const groupHTML = (label, teams) => `
            <div class="col-6 override-group">
                <h6 class="mb-2">${label}</h6>
                ${teams.map(rowHTML).join('')}
            </div>
        `;

        // Layout mirrors the textarea column above it:
        //   - title row + action button at the top (Update Standings here
        //     sits where Fetch Standings sits on the textarea column)
        //   - two-column grid of teams (Group 1 | Group 2) underneath
        container.innerHTML = `
            <div class="d-flex justify-content-between align-items-center mb-2">
                <label class="form-label mb-0">Manual Override (FQ 2v2)</label>
                <button type="button"
                    class="btn btn-sm btn-primary override-submit"
                    data-round-id="${roundId}">
                    Update Standings
                </button>
            </div>
            <div class="row override-grid" data-round-id="${roundId}">
                ${groupHTML('Group 1', group1)}
                ${groupHTML('Group 2', group2)}
            </div>
        `;
    }

    // Re-render every already-built override panel. Called when group
    // assignment changes mid-session.
    function rerenderAllOverridePanels() {
        document.querySelectorAll('[id^="override-panel-"]').forEach(panel => {
            const roundId = panel.dataset.roundId;
            if (roundId) renderOverridePanel(roundId);
        });
    }

    // Keep all `.fetch-round-input` instances (per-round + the global one
    // beside Broadcasting Now) in sync so the operator doesn't wonder which
    // one is "right". Typing in any of them mirrors to all others.
    function syncFetchRoundInputs(sourceEl) {
        const value = sourceEl.value;
        document.querySelectorAll('.fetch-round-input').forEach(el => {
            if (el !== sourceEl && el.value !== value) el.value = value;
        });
    }
    document.addEventListener('input', (e) => {
        if (e.target.classList?.contains('fetch-round-input')) {
            syncFetchRoundInputs(e.target);
        }
    });

    // Delegated click for the override panel submit button. Reads W/L/D per
    // team, MTG-scores (W*3 + D*1), sorts, ranks, rewrites the textarea in
    // the 2v2 format (rank / player1 / player2 / W-L-D), and dispatches an
    // `input` event so the existing change listener emits `standings-updated`.
    document.addEventListener('click', (e) => {
        if (!e.target.classList?.contains('override-submit')) return;
        const roundId = e.target.dataset.roundId;
        if (!roundId) return;

        const panel = document.getElementById(`override-panel-${roundId}`);
        if (!panel) return;

        // Collect team records from the panel (default 0 for blanks).
        const entries = Array.from(panel.querySelectorAll('.override-row')).map(row => {
            const teamName = row.dataset.teamName || '';
            const w = parseInt(row.querySelector('.override-w')?.value, 10) || 0;
            const l = parseInt(row.querySelector('.override-l')?.value, 10) || 0;
            const d = parseInt(row.querySelector('.override-d')?.value, 10) || 0;
            const { player1, player2 } = splitTeamIntoPlayers(teamName);
            return { teamName, player1, player2, w, l, d };
        });

        // MTG match points: W*3 + D*1. Tiebreakers we can calculate from
        // local state: higher W, then alphabetical team name for determinism.
        // Real Melee standings use OMW%/GW%/OGW% which we don't have here —
        // the operator is expected to correct that by re-ordering W/L/D
        // values if a tiebreak matters.
        entries.forEach(e => { e.points = e.w * 3 + e.d; });
        entries.sort((a, b) => {
            if (b.points !== a.points) return b.points - a.points;
            if (b.w !== a.w) return b.w - a.w;
            return a.teamName.localeCompare(b.teamName);
        });

        // Build the 2v2 textarea format — 4 lines per entry, matching the
        // parser in features/standings.js:parseStandingsRawData2v2().
        // Record convention: hide the draws segment when 0 ("6-1" not
        // "6-1-0") — matches normalizeStandings + the Carde API path.
        const lines = [];
        entries.forEach((e, idx) => {
            const rank = idx + 1;
            lines.push(String(rank));
            lines.push(e.player1 || e.teamName); // fallback if roster split failed
            lines.push(e.player2 || '');
            lines.push(e.d > 0 ? `${e.w}-${e.l}-${e.d}` : `${e.w}-${e.l}`);
        });

        const textarea = document.getElementById(`standings-${roundId}`);
        if (!textarea) {
            console.warn(`[override] standings textarea not found for round ${roundId}`);
            return;
        }
        textarea.value = lines.join('\n');
        // Fire `input` so attachStandingsChangeListeners() emits
        // `standings-updated` to the server (same path as a manual edit).
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Split a team-name string from groupAssignment.json into {player1, player2}
    // by checking against currentPlayerRoster. Case-insensitive pair match so
    // "PeterPark Atrioc" resolves to { player1: 'peterpark', player2: 'Atrioc' }
    // even when casing drifts.
    //
    // If no roster pair resolves, fall back to a naive first-word split so the
    // downstream renderer at least has *something* to work with. Captain
    // portraits / thumbs will miss, and formatTeamLabel() in the combined
    // broadcast page falls back to the team name — not pretty but not a crash.
    function splitTeamIntoPlayers(teamName) {
        const roster = Array.isArray(currentPlayerRoster) ? currentPlayerRoster : [];
        const names = roster
            .map(p => (typeof p === 'string' ? p : (p && p.name) || ''))
            .filter(Boolean);

        const teamLower = teamName.toLowerCase().trim();

        // Try every ordered pair of roster names. First match wins.
        for (let i = 0; i < names.length; i++) {
            for (let j = 0; j < names.length; j++) {
                if (i === j) continue;
                const pairLower = `${names[i].toLowerCase()} ${names[j].toLowerCase()}`.trim();
                if (pairLower === teamLower) {
                    return { player1: names[i], player2: names[j] };
                }
            }
        }

        console.warn(
            `[override] team "${teamName}" didn't resolve to a roster pair; ` +
            `falling back to first-word split (captain thumbs will likely miss).`
        );
        const parts = teamName.trim().split(/\s+/);
        if (parts.length >= 2) {
            return { player1: parts[0], player2: parts.slice(1).join(' ') };
        }
        return { player1: teamName, player2: '' };
    }

    // Listen for group-assignment updates so the override panels stay in sync
    // when the Groups tab changes team lists mid-session. The Groups tab's
    // own groups.js also subscribes (both listeners get the same emission).
    socket.on('groupAssignmentUpdated', (assignment) => {
        currentGroupAssignment = {
            group1: Array.isArray(assignment?.group1) ? assignment.group1 : [],
            group2: Array.isArray(assignment?.group2) ? assignment.group2 : [],
        };
        // First response has arrived — flip the flag before rerendering so the
        // placeholder clears and real state (rows, or "not saved yet") shows.
        groupAssignmentReceived = true;
        rerenderAllOverridePanels();
    });
    socket.emit('getGroupAssignment');

    // END STANDINGS DATA

    // START UP

    // Initial setup when the page loads
    // setup custom dropdowns
    setupCustomDropdowns();
    // attach on startup
    attachGlobalCommentatorsListener();
    // attach global event information update button listener on start up
    attachGlobalEventInformationUpdateListener();
    // attach global base timer input listener
    attachGlobalBaseTimerInputListener();
    // attach global base timer update button lister
    attachGlobalBaseTimerUpdateListener();
    // attach commentator data update button listener
    attachCommentatorDataUpdateClickListener();

    // setup sockets emitters

    // Fetch player count first so renderMatch knows the layout before control data arrives
    socket.emit('get-player-count');

    // call for control data
    socket.emit('get-all-control-data');

    // call for control broadcast trackers data
    socket.emit('get-control-broadcast-trackers');

    // call for global data at start up
    socket.emit('get-match-global-data');

    // at the start, ask for all timer states from the server
    socket.emit('get-all-timer-states');

    // call for scoreboard state - for now its wins show check
    socket.emit('get-scoreboard-state');

    // ── Scoreboard battlefields-row visibility (inline per-match toggles) ──
    // The "Hide" checkbox rendered next to each 2v2 battlefield input
    // (see renderPlayerSection above) writes through to the server's
    // `update-battlefield-visibility` handler. Semantic is inverted from
    // the canonical `visible` flag: CHECKED in the UI means HIDDEN in the
    // /scoreboard L3 strip (.riftbound-bf-row), so we flip at emit + sync
    // time. Handler is delegated because match cards render dynamically —
    // there's no single moment when all inline toggles exist in the DOM.
    socket.emit('get-battlefield-visibility');

    document.addEventListener('change', (e) => {
        if (!e.target.classList.contains('battlefield-hide-toggle')) return;
        socket.emit('update-battlefield-visibility', {
            slot: e.target.dataset.slot,
            visible: !e.target.checked
        });
    });

    socket.on('battlefield-visibility-updated', (flags) => {
        if (!flags) return;
        // Inline per-match "Hide" checkboxes — checked = hidden (inverted).
        document.querySelectorAll('.battlefield-hide-toggle')
            .forEach(input => {
                const slot = input.dataset.slot;
                if (slot in flags) input.checked = !flags[slot];
            });
    });

    // end setup socket emitters

    // setup sockets listeners

    // handle response for control broadcast trackers data
    socket.on('control-broadcast-trackers', (data) => {
        console.log('control and broadcast tracking update', data);
        // update broadcast and control displays
        broadcastDisplay.innerText = data['broadcastTracker']['round_id'] ? `Round ${data['broadcastTracker']['round_id']}` : 'None';
        control1Display.innerText = `${data['controlsTracker']['1']['round_id']}-${data['controlsTracker']['1']['match_id']}`;
        control2Display.innerText = `${data['controlsTracker']['2']['round_id']}-${data['controlsTracker']['2']['match_id']}`;
        control3Display.innerText = `${data['controlsTracker']['3']['round_id']}-${data['controlsTracker']['3']['match_id']}`;
        control4Display.innerText = `${data['controlsTracker']['4']['round_id']}-${data['controlsTracker']['4']['match_id']}`;
        currentBroadcastRoundId = data['broadcastTracker']['round_id'] || null;
    })

    // handle response for global data
    socket.on('update-match-global-data', (data) => {
        // update match global fields
        console.log('got global data', data['globalData'])
        commentator1().innerText = data['globalData']['global-commentator-1'] ? data['globalData']['global-commentator-1'] : '';
        commentator1_subtext().innerText = data['globalData']['global-commentator-1-subtext'] ? data['globalData']['global-commentator-1-subtext'] : '';
        commentator2().innerText = data['globalData']['global-commentator-2'] ? data['globalData']['global-commentator-2'] : '';
        commentator2_subtext().innerText = data['globalData']['global-commentator-2-subtext'] ? data['globalData']['global-commentator-2-subtext'] : '';
        commentator3().innerText = data['globalData']['global-commentator-3'] ? data['globalData']['global-commentator-3'] : '';
        commentator3_subtext().innerText = data['globalData']['global-commentator-3-subtext'] ? data['globalData']['global-commentator-3-subtext'] : '';
        commentator4().innerText = data['globalData']['global-commentator-4'] ? data['globalData']['global-commentator-4'] : '';
        commentator4_subtext().innerText = data['globalData']['global-commentator-4-subtext'] ? data['globalData']['global-commentator-4-subtext'] : '';
        matchEventName.innerText = data['globalData']['global-event-name'] ? data['globalData']['global-event-name'] : '';
        matchEventFormat.innerText = data['globalData']['global-event-format'] ? data['globalData']['global-event-format'] : '';
        matchEventMiscDetails.innerText = data['globalData']['global-event-miscellaneous-details'] ? data['globalData']['global-event-miscellaneous-details'] : '';
        matchEventBaseLifePoints.innerText = data['globalData']['global-event-base-life-points'] ? data['globalData']['global-event-base-life-points'] : '20';
        matchEventBaseLifePointsCurrent.innerText = data['globalData']['global-event-base-life-points'] ? data['globalData']['global-event-base-life-points'] : '20';
        baseLifePoints = data['globalData']['global-event-base-life-points'] ? data['globalData']['global-event-base-life-points'] : '20';
        matchEventBaseTimer.innerText = data['globalData']['global-event-base-timer'] ? data['globalData']['global-event-base-timer'] : '50';
        matchEventBaseTimerCurrent.innerText = data['globalData']['global-event-base-timer'] ? data['globalData']['global-event-base-timer'] : '50';
        baseTimer = data['globalData']['global-event-base-timer'] ? data['globalData']['global-event-base-timer'] : '50';
        matchEventNumberOfRounds.innerText = data['globalData']['global-event-number-of-rounds'] ? data['globalData']['global-event-number-of-rounds'] : '15';
    })

    // handle getting all timer states
    socket.on('current-all-timer-states', ({timerState}) => {
        // save all timer states
        allTimerStates = timerState;
        // Iterate through all rounds and matches
        Object.keys(timerState).forEach((roundId) => {
            Object.keys(timerState[roundId]).forEach((matchId) => {
                const matchState = timerState[roundId][matchId];
                const timerElement = document.querySelector(`#timer-${roundId}-${matchId}`);
                if (timerElement) {
                    // For count up mode, always show the time (never show TURNS)
                    // For count down mode, show TURNS when time reaches 0
                    if (matchState.countUp) {
                        timerElement.innerText = formatTime(matchState.time);
                    } else {
                        timerElement.innerText = matchState.time > 0 ? formatTime(matchState.time) : 'TURNS';
                    }
                }
                const timerShowCheck = document.querySelector(`#timer-display-scoreboard-${roundId}-${matchId}`);
                if (timerShowCheck) {
                    timerShowCheck.checked = matchState.show;
                }
                const timerCountUpCheck = document.querySelector(`#timer-count-up-${roundId}-${matchId}`);
                if (timerCountUpCheck) {
                    timerCountUpCheck.checked = matchState.countUp;
                }
            });
        });
    });

    // handle standing data
    socket.on('standings-data', ({standingsData}) => {
        console.log('got standings data', standingsData);
        allStandingsData = standingsData;
        // populate all standings text boxes per round
        populateStandingsData();
    })

    // Full per-round standings (every player) for the standings search.
    // Cached client-side; once it lands we re-run the active filter so the
    // "Searching all players…" placeholder is replaced with real matches.
    socket.on('full-standings-data', ({ roundNumber, roundUsed, players }) => {
        clearTimeout(fullStandingsTimers[roundNumber]);
        fullStandingsByRound[roundNumber] = Array.isArray(players) ? players : [];
        fullStandingsRoundUsed[roundNumber] = roundUsed != null ? String(roundUsed) : String(roundNumber);
        fullStandingsRequested.delete(roundNumber);
        applyStandingsFilter(roundNumber);
    })

    // ── Pairings socket listeners ───────────────────────────────────────
    // `all-pairings-data` lands once at page load with whatever the
    // server has cached on disk under data/cardeio/pairings-api-event-{id}-round-*.json.
    socket.on('all-pairings-data', ({ pairingsData }) => {
        console.log('got pairings data', Object.keys(pairingsData || {}).length, 'round(s)');
        allPairingsData = pairingsData || {};
        populatePairingsData();
    });

    // `tournament-pairings-fetched` lands after a per-round fetch click
    // (broadcast to every client so a co-operator's open tab repaints
    // without a separate fetch). On error, the click handler above shows
    // the reason in the round's status line — we just skip the render.
    socket.on('tournament-pairings-fetched', (result) => {
        if (!result?.success) return;
        const { roundId, matches } = result;
        allPairingsData[String(roundId)] = matches;
        renderPairings(roundId, matches);
    });

    // ── Missing-rounds auto-fill status (piggybacks Fetch Pairings) ──
    // Every per-round Fetch Pairings click also triggers a server-side
    // scan for OTHER rounds in this event that don't have a cached
    // pairings file yet, and fetches each one sequentially. The status
    // line above the round tabs (`#fetch-missing-pairings-status`) shows
    // live progress for those auto-fills. The per-round table itself
    // still repaints via the existing `tournament-pairings-fetched`
    // listener above as each round lands.
    const fetchMissingStatus = document.getElementById('fetch-missing-pairings-status');
    function setMissingStatus(msg, kind) {
        if (!fetchMissingStatus) return;
        if (!msg) {
            fetchMissingStatus.style.display = 'none';
            fetchMissingStatus.textContent = '';
            fetchMissingStatus.className = '';
            return;
        }
        fetchMissingStatus.style.display = '';
        fetchMissingStatus.textContent = msg;
        const cls = kind === 'success' ? 'alert alert-success py-2 mb-2'
                  : kind === 'danger' ? 'alert alert-danger py-2 mb-2'
                  : 'alert alert-info py-2 mb-2';
        fetchMissingStatus.className = cls;
    }
    socket.on('fetch-missing-pairings-progress', (p) => {
        if (!p) return;
        if (p.phase === 'start') {
            const missingCount = (p.missing || []).length;
            const staleCount = (p.stale || []).length;
            const parts = [];
            if (missingCount > 0) parts.push(`${missingCount} missing (${p.missing.join(', ')})`);
            if (staleCount > 0) parts.push(`${staleCount} stale (${p.stale.join(', ')})`);
            if (parts.length > 0) {
                setMissingStatus(`Auto-fill: ${parts.join(' + ')}…`, 'info');
            }
        } else if (p.phase === 'fetching') {
            const verb = p.refresh ? 'Refreshing' : 'Fetching';
            setMissingStatus(`(${p.index}/${p.total}) ${verb} round ${p.roundId}…`, 'info');
        } else if (p.phase === 'fetched') {
            const verb = p.refresh ? 'refreshed' : 'fetched';
            setMissingStatus(`(${p.index}/${p.total}) Round ${p.roundId} ${verb}: ${p.count} matches`, 'info');
        } else if (p.phase === 'failed') {
            setMissingStatus(`(${p.index}/${p.total}) Round ${p.roundId} FAILED: ${p.error}`, 'danger');
        }
    });
    socket.on('fetch-missing-pairings-complete', (result) => {
        if (!result) return;
        if (!result.success && !result.fetched) {
            setMissingStatus(result.error || 'Auto-fill failed.', 'danger');
            return;
        }
        // Silent on "nothing to do" — only show toast when we actually
        // fetched something or hit failures.
        if ((result.fetched || 0) === 0 && (result.failed || 0) === 0) {
            setMissingStatus('', 'info');
            return;
        }
        const kind = result.failed && result.failed > 0 ? 'danger' : 'success';
        setMissingStatus(result.message || `Auto-fill done — fetched ${result.fetched || 0} round(s).`, kind);
    });

    // Best of Legend — `byRound` is `{ "1": {...}, "2": {...}, ... }`.
    // Repaints every round's BoL card. If the server reports `error`
    // (e.g. no decklists cached for the active event), each round's
    // status line shows the message instead of legend blocks.
    socket.on('best-of-legend-data', ({ byRound, error, eventId }) => {
        console.log('got best-of-legend data', Object.keys(byRound || {}).length, 'round(s)', eventId ? `for event ${eventId}` : '');
        allBestOfLegendData = {};
        if (byRound) {
            for (const [roundId, dataForRound] of Object.entries(byRound)) {
                allBestOfLegendData[roundId] = dataForRound;
            }
        }
        // If the server returned a top-level error, propagate it to every
        // visible BoL card so the operator sees the reason.
        if (error) {
            document.querySelectorAll('.best-of-legend-card-container').forEach(card => {
                const status = card.querySelector('.bol-status');
                if (status) status.textContent = error;
                const grid = card.querySelector('.bol-grid');
                if (grid) grid.innerHTML = '';
            });
            return;
        }
        populateBestOfLegendData();
    });

    // handle updates to full control data to update the page (initial load)
    socket.on('control-data-updated', (allData) => {
        // save to local object
        allControlData = allData;

        // Render the round tabs
        renderRoundTabs(allData);

        // Set up custom dropdowns after rendering
        setupCustomDropdowns();
    });

    // NEW: Granular field updates from control pages (real-time editing)
    socket.on('field-updated', ({round_id, match_id, field, value, timestamp}) => {
        console.log('Field updated', field, '=', value);
        
        // Ensure nested structure exists
        if (!allControlData[round_id]) allControlData[round_id] = {};
        if (!allControlData[round_id][match_id]) allControlData[round_id][match_id] = {};
        if (!allControlData[round_id][match_id]._timestamps) {
            allControlData[round_id][match_id]._timestamps = {};
        }
        
        // Conflict resolution: only update if newer timestamp
        const currentTimestamp = allControlData[round_id][match_id]._timestamps[field] || 0;
        if (timestamp > currentTimestamp) {
            allControlData[round_id][match_id][field] = value;
            allControlData[round_id][match_id]._timestamps[field] = timestamp;

            // Update ONLY the specific field in DOM
            const fieldElement = document.getElementById(`${round_id}-${match_id}-${field}`);
            if (fieldElement) {
                // The deck lists are textareas that renderMatch filled with
                // .value, and a textarea shows .value from then on — setting
                // textContent would leave the old list on screen (and the next
                // edit would send it back).
                if (fieldElement.tagName === 'TEXTAREA') {
                    fieldElement.value = Array.isArray(value) ? value.join('\n') : (value ?? '');
                } else {
                    fieldElement.textContent = value;
                }
            }
            // A deck arriving from elsewhere (the chat bot's !p1 / !p2, an
            // iPad's saved deck) opens that player's deck section, as the Add
            // Decklist import does.
            const mainDeckSide = field.match(/^player-main-deck-(.+)$/);
            if (mainDeckSide && String(Array.isArray(value) ? value.join('') : (value ?? '')).trim()) {
                const deckFields = document.getElementById(`${round_id}-${match_id}-deck-fields-${mainDeckSide[1]}`);
                if (deckFields) deckFields.style.display = 'block';
            }

            // Mirror admin-driven RIFTBOUND changes onto master-control's DERIVED
            // controls (radios / toggle buttons / checkbox), which aren't plain
            // text fields — so they MOVE live instead of only catching up on the
            // next full re-render. (The text fields above — names, might values,
            // battlefield slots — already update via fieldElement.)
            const prefix = `${round_id}-${match_id}`;
            const card = `#match-card-${prefix}`;
            if (field === 'showdown-active-bf') {
                const radio = document.querySelector(`${card} .showdown-active-bf-radio[data-bf="${value}"]`);
                if (radio) radio.checked = true;
            } else if (field === 'showdown-visible') {
                const btn = document.querySelector(`${card} .showdown-visible-toggle`);
                if (btn) {
                    const on = value === 'true';
                    btn.setAttribute('aria-pressed', String(on));
                    btn.textContent = on ? 'Hide from Scoreboard' : 'Show on Scoreboard';
                }
            } else if (field === 'showdown-bf-3-enabled') {
                const enabled = value === 'true';
                const cb = document.getElementById(`${prefix}-showdown-bf-3-enabled`);
                if (cb) cb.checked = enabled;
                const bf3Row = document.querySelector(`${card} .showdown-bf-3-row`);
                if (bf3Row) bf3Row.classList.toggle('d-none', !enabled);
            } else if (field === 'showdown-bf-3-name') {
                // Baron brush override forces this name to "Brush".
                const btn = document.querySelector(`${card} .baron-brush-override-btn`);
                if (btn) {
                    const isBrush = (value || '').trim() === 'Brush';
                    btn.setAttribute('aria-pressed', String(isBrush));
                    btn.classList.toggle('active', isBrush);
                }
            } else if (field === 'player-battlefield-left' || field === 'player-battlefield-right') {
                const side = field.endsWith('left') ? 'left' : 'right';
                const active = (value || '').trim();
                const isBrush = active === 'Brush';
                const brushBtn = document.querySelector(`.brush-override-btn[data-round="${round_id}"][data-match="${match_id}"][data-side="${side}"]`);
                if (brushBtn) {
                    brushBtn.setAttribute('aria-pressed', String(isBrush));
                    brushBtn.classList.toggle('active', isBrush);
                }
                if (!isBrush && active) {
                    for (const bf of ['1', '2', '3']) {
                        const slot = document.getElementById(`${prefix}-player-battlefield-${bf}-${side}`);
                        if (slot && (slot.textContent || '').trim() === active) {
                            const radio = document.querySelector(`input[name="${prefix}-bf-${side}-select"][data-bf="${bf}"]`);
                            if (radio) radio.checked = true;
                            break;
                        }
                    }
                }
            }
        }
    });

    // Function to toggle visibility of game-specific fields
    function toggleTeammateSections() {
        // Collect all match cards in order, then re-render in place
        const cards = [...document.querySelectorAll('.match-card-container')];
        cards.forEach(card => {
            const id = card.id; // match-card-{roundId}-{matchId}
            const parts = id.replace('match-card-', '').split('-');
            const roundId = parts[0];
            const matchId = parts.slice(1).join('-');
            const container = card.parentElement;
            const nextSibling = card.nextSibling;
            const matchData = allControlData[roundId]?.[matchId] || {};
            // Remove old card
            card.remove();
            // Re-render creates a new card and appends to container
            renderMatch(roundId, matchId, matchData);
            // Move the newly appended card back to its original position
            const newCard = document.getElementById(`match-card-${roundId}-${matchId}`);
            if (newCard && container) {
                if (nextSibling) {
                    container.insertBefore(newCard, nextSibling);
                }
                // If nextSibling is null, it was already appended at the end which is correct
            }
        });
        // Re-attach autocomplete dropdown wrappers — every match card we just
        // re-rendered has fresh DOM nodes whose focus/input listeners need to
        // be wired up. The other re-render entry point (control-data-updated)
        // calls this same function; missing it here is what made player-name,
        // archetype, and SWU dropdowns silently disappear after a player-count
        // swap.
        setupCustomDropdowns();
    }

    function toggleGameFields(gameSelection) {
        const showRiftbound = gameSelection === 'riftbound';
        const showMtg = gameSelection === 'mtg';
        const showStarwars = gameSelection === 'starwars';
        const showArchetype = showMtg || gameSelection === 'vibes';

        document.querySelectorAll('.riftbound-only-field').forEach(field => {
            field.style.display = showRiftbound ? 'block' : 'none';
        });

        document.querySelectorAll('.mtg-only-field').forEach(field => {
            field.style.display = showMtg ? 'block' : 'none';
        });

        document.querySelectorAll('.starwars-only-field').forEach(field => {
            field.style.display = showStarwars ? 'block' : 'none';
        });

        document.querySelectorAll('.archetype-field').forEach(field => {
            field.style.display = showArchetype ? 'block' : 'none';
        });

        document.querySelectorAll('.life-points-field').forEach(field => {
            if (showStarwars) {
                // Save original position for moving back later
                if (!field._originalParent) {
                    field._originalParent = field.parentElement;
                    field._originalNextSibling = field.nextElementSibling;
                }
                // Move into the Star Wars base stats container (before Base HP)
                const matchCol = field.closest('.col-md-6');
                const statsContainer = matchCol?.querySelector('.swu-base-stats-container');
                if (statsContainer) {
                    statsContainer.insertBefore(field, statsContainer.firstChild);
                }
                field.querySelector('.form-label').textContent = 'Base Damage';
                field.style.display = 'block';
            } else {
                // Move back to original position
                if (field._originalParent) {
                    field._originalParent.insertBefore(field, field._originalNextSibling);
                }
                // In 2v2, hide all individual life/record/wins fields (shared in team row)
                if (currentPlayerCount === '2v2' && field.closest('.player-section')) {
                    field.style.display = 'none';
                } else {
                    field.querySelector('.form-label').textContent = 'LifePoints';
                    field.style.display = 'block';
                }
            }
        });

        // In 2v2, hide individual record and wins fields inside player sections
        document.querySelectorAll('.player-section .record-field, .player-section .wins-field').forEach(field => {
            if (currentPlayerCount === '2v2') {
                field.style.display = 'none';
            } else {
                field.style.display = 'block';
            }
        });
    }

    // Function to update theme with vendor overrides
    function updateTheme(game, vendor, playerCount) {
        toggleGameFields(game);
        // Apply vendor overrides
        const vc = window.VENDOR_CONFIG;
        if (vc) {
            vc.getAllOverrideProperties().forEach(prop => {
                document.documentElement.style.removeProperty(prop);
            });
            const overrides = vc.getOverrides(game, vendor, playerCount);
            Object.entries(overrides).forEach(([prop, value]) => {
                document.documentElement.style.setProperty(prop, value);
            });
        }
    }

    const GAME_DEFAULTS = {
        mtg:       { life: '20', timer: '50' },
        riftbound: { life: '0', timer: '60' },
        vibes:     { life: '0', timer: '35' },
        starwars:  { life: '20', timer: '55' },
        default:   { life: '20', timer: '50' }
    };

    function applyGameDefaults(game) {
        const defaults = GAME_DEFAULTS[game] || GAME_DEFAULTS.default;
        baseLifePoints = defaults.life;
        baseTimer = defaults.timer;
        if (matchEventBaseLifePoints) matchEventBaseLifePoints.innerText = defaults.life;
        if (matchEventBaseLifePointsCurrent) matchEventBaseLifePointsCurrent.innerText = defaults.life;
        if (matchEventBaseTimer) matchEventBaseTimer.innerText = defaults.timer;
        if (matchEventBaseTimerCurrent) matchEventBaseTimerCurrent.innerText = defaults.timer;

        // Update all match card life and timer fields.
        // NOTE: do NOT dispatch an 'input' event here. This function runs on every
        // page load via `server-current-game-selection`, and a synthetic input event
        // triggers the editable-field listener → `master-control-matches-updated`
        // emit, which the server's `updateFromMaster` merges onto disk and broadcasts
        // to every /scoreboard/* page — clobbering real per-match state (life, wins,
        // etc.) with game defaults on every F5. The `innerText` overwrite is a pure
        // visual default that `renderMatch` replaces with the persisted value moments
        // later, so no emit is needed here.
        document.querySelectorAll('[id$="-player-life-left"], [id$="-player-life-right"]').forEach(el => {
            el.innerText = defaults.life;
        });
        const timerDisplay = `${defaults.timer}:00`;
        document.querySelectorAll('.timer-text').forEach(el => {
            el.innerText = timerDisplay;
        });
    }

    // Listen for game selection changes
    socket.on('server-current-game-selection', ({gameSelection}) => {
        currentGameSelection = gameSelection?.toLowerCase() || 'mtg';
        applyGameDefaults(currentGameSelection);
        updateTheme(currentGameSelection, currentVendor, currentPlayerCount);
    });
    socket.on('game-selection-updated', ({gameSelection}) => {
        currentGameSelection = gameSelection?.toLowerCase() || 'mtg';
        applyGameDefaults(currentGameSelection);
        updateTheme(currentGameSelection, currentVendor, currentPlayerCount);
        // Auto-push event info (life, timer) to broadcast pages
        updateEventInformation.click();
    });
    socket.on('server-current-vendor-selection', ({vendorSelection}) => {
        currentVendor = vendorSelection;
        updateTheme(currentGameSelection, currentVendor, currentPlayerCount);
    });
    socket.on('vendor-selection-updated', ({vendorSelection}) => {
        currentVendor = vendorSelection;
        updateTheme(currentGameSelection, currentVendor, currentPlayerCount);
    });
    socket.on('server-current-player-count', ({playerCount}) => {
        currentPlayerCount = playerCount;
        updateTheme(currentGameSelection, currentVendor, currentPlayerCount);
        toggleTeammateSections();
    });
    socket.on('player-count-updated', ({playerCount}) => {
        currentPlayerCount = playerCount;
        updateTheme(currentGameSelection, currentVendor, currentPlayerCount);
        toggleTeammateSections();
    });

    // Initial fetch of game selection, vendor, and player count
    socket.emit('get-game-selection');
    socket.emit('get-vendor-selection');
    socket.emit('get-player-count');

    // Listen for updated archetype list from server
    socket.on('archetypeListUpdated', (archetypes) => {
        currentArchetypeList = archetypes; // Update the current archetype list
    });

    // Listen for player roster updates (powers player-name autocomplete).
    // Existing dropdown handlers close over `currentPlayerRoster` by reference
    // at event-fire time, so just replacing the array lets focus/input events
    // pick up the new list without re-running setupCustomDropdowns().
    socket.on('playerRosterUpdated', (roster) => {
        currentPlayerRoster = roster;
    });
    socket.emit('getPlayerRoster');

    // Fetch SWU leaders and bases for dropdowns
    socket.emit('starwars-get-leaders-and-bases');
    socket.on('starwars-leaders-and-bases', ({ leaders, bases }) => {
        swuLeadersList = leaders;
        swuBasesList = bases;
        setupCustomDropdowns(); // Re-run to set up SWU dropdowns
    });

    // Listen for match-by-table fetch response
    socket.on('match-by-table-fetched', (result) => {
        // Find the button that was fetching and reset it
        const fetchingButton = document.querySelector('.fetch-table-btn[data-fetching="true"]');
        if (fetchingButton) {
            fetchingButton.disabled = false;
            fetchingButton.textContent = 'Fetch';
            delete fetchingButton.dataset.fetching;

            const roundId = fetchingButton.dataset.roundId;
            const matchId = fetchingButton.dataset.matchId;

            if (result.error) {
                alert('Error fetching match data: ' + result.error);
                return;
            }

            if (result.matchData) {
                const { player1, player2 } = result.matchData;

                // 2v2: Melee stores a team as a single pseudo-player with
                // FirstName=playerA / LastName=playerB / Name="playerA playerB".
                // The server exposes both halves as `player1`/`player2` on the
                // team's record (see features/tournament-platforms.js →
                // fetchMatchByTable). Here we route them into the teammate
                // slots (left → playerA, left-2 → playerB; same for right).
                //
                // For 1v1 the server still populates player1/player2 from the
                // real FirstName/LastName (it has no playerCount input to gate
                // on), so a stale module-scope `currentPlayerCount` would route
                // a 1v1 last name into the phantom P2 slot. Gate strictly on
                // the body dataset — that's the committed source of truth,
                // updated synchronously on Apply, and safe even if the
                // module-scope value drifts.
                const is2v2 =
                    document.body.dataset.playerCount === '2v2';

                function writeSideField(side, fieldSuffix, value) {
                    const el = document.getElementById(`${roundId}-${matchId}-${fieldSuffix}-${side}`);
                    if (!el) return;
                    el.textContent = value || '';
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }

                // FFA pods (Topdeck): the server sends the whole table as
                // `players` in seat order → route into left / left-2 / right /
                // right-2 with commander (archetype), WUBRG colors (mana
                // symbols) and standings record; wins reset to 0. Tournament
                // name + "ROUND X OF Y" go through the GLOBAL event panel —
                // its update-match-global-data overwrites the per-match values
                // on the mtg scoreboard header, so it must be the writer.
                const isFfa = document.body.dataset.playerCount === 'ffa';
                if (isFfa && Array.isArray(result.matchData.players) && result.matchData.players.length) {
                    const seats = ['left', 'left-2', 'right', 'right-2'];
                    result.matchData.players.slice(0, 4).forEach((p, i) => {
                        writeSideField(seats[i], 'player-name', p.name || '');
                        writeSideField(seats[i], 'player-archetype', p.archetype || '');
                        writeSideField(seats[i], 'player-mana-symbols', p.colors || '');
                        writeSideField(seats[i], 'player-record', p.record || '');
                        const wins = document.getElementById(`${roundId}-${matchId}-player-wins-${seats[i]}`);
                        if (wins) { wins.textContent = '0'; wins.dispatchEvent(new Event('input', { bubbles: true })); }
                    });

                    const meta = result.matchData.topdeck;
                    if (meta) {
                        const rn = Number(meta.roundLabel);
                        const roundText = (Number.isFinite(rn) && meta.swissNum)
                            ? `ROUND ${rn} OF ${meta.swissNum}`
                            : String(meta.roundLabel || '').toUpperCase();
                        const evEl = document.getElementById(`${roundId}-${matchId}-event-round`);
                        if (evEl) { evEl.textContent = roundText; evEl.dispatchEvent(new Event('input', { bubbles: true })); }
                        updateControlData(roundId, matchId, 'event-name', meta.tournamentName || '');
                        socket.emit('master-control-matches-updated', allControlData);

                        const globalNameEl = document.querySelector('#global-event-name');
                        if (globalNameEl && meta.tournamentName) {
                            globalNameEl.innerText = meta.tournamentName;
                            const gv = id => document.querySelector(`#${id}`)?.innerText || '';
                            const totalRounds = meta.swissNum ? String(meta.swissNum) : gv('global-event-number-of-rounds');
                            const roundsEl = document.querySelector('#global-event-number-of-rounds');
                            if (roundsEl && meta.swissNum) roundsEl.innerText = totalRounds;
                            socket.emit('update-event-information-requested', { eventInformationData: {
                                'global-event-name': meta.tournamentName,
                                'global-event-format': gv('global-event-format'),
                                'global-event-miscellaneous-details': gv('global-event-miscellaneous-details'),
                                'global-event-base-life-points': gv('global-event-base-life-points'),
                                'global-event-base-timer': gv('global-event-base-timer'),
                                'global-event-number-of-rounds': totalRounds,
                            }});
                        }
                    }
                    console.log('FFA pod populated for table', result.matchData.tableNumber);
                    return;
                }

                // Team A → left (+ left-2 teammate on 2v2)
                if (is2v2 && (player1.player1 || player1.player2)) {
                    writeSideField('left',   'player-name', player1.player1 || '');
                    writeSideField('left-2', 'player-name', player1.player2 || '');
                } else {
                    writeSideField('left', 'player-name', player1.name || '');
                }
                writeSideField('left', 'player-archetype', player1.archetype || '');
                writeSideField('left', 'player-pronouns',  player1.pronouns  || '');
                writeSideField('left', 'player-record',    player1.record    || '');

                // Team B → right (+ right-2 teammate on 2v2)
                if (is2v2 && (player2.player1 || player2.player2)) {
                    writeSideField('right',   'player-name', player2.player1 || '');
                    writeSideField('right-2', 'player-name', player2.player2 || '');
                } else {
                    writeSideField('right', 'player-name', player2.name || '');
                }
                writeSideField('right', 'player-archetype', player2.archetype || '');
                writeSideField('right', 'player-pronouns',  player2.pronouns  || '');
                writeSideField('right', 'player-record',    player2.record    || '');

                console.log('Match data populated for table', result.matchData.tableNumber);

                // Reset wins to 0 for both players
                const winsLeft = document.getElementById(`${roundId}-${matchId}-player-wins-left`);
                const winsRight = document.getElementById(`${roundId}-${matchId}-player-wins-right`);
                if (winsLeft) { winsLeft.textContent = '0'; winsLeft.dispatchEvent(new Event('input', { bubbles: true })); }
                if (winsRight) { winsRight.textContent = '0'; winsRight.dispatchEvent(new Event('input', { bubbles: true })); }

                // Riftbound (cardeio) extra fields
                for (const [side, player] of [['left', player1], ['right', player2]]) {
                    const setField = (field, value) => {
                        const el = document.getElementById(`${roundId}-${matchId}-${field}-${side}`);
                        if (el) { el.textContent = value; el.dispatchEvent(new Event('input', { bubbles: true })); }
                    };
                    // Like setField but also hides the autocomplete dropdown that opens on input
                    const setDropdownField = (field, value) => {
                        const el = document.getElementById(`${roundId}-${matchId}-${field}-${side}`);
                        if (el) {
                            el.textContent = value;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            const dl = el.closest('.custom-dropdown')?.querySelector('.dropdown-list');
                            if (dl) dl.style.display = 'none';
                        }
                    };
                    const setTextarea = (field, lines) => {
                        const el = document.getElementById(`${roundId}-${matchId}-${field}-${side}`);
                        if (el) { el.value = lines.join('\n'); el.dispatchEvent(new Event('input', { bubbles: true })); }
                    };
                    // Set deck first — its input event calls updateRiftboundFields which would
                    // overwrite legend/champion, so legend/champion must be set after
                    if (player.mainDeck?.length) {
                        setTextarea('player-main-deck', player.mainDeck);
                        const deckFieldsContainer = document.getElementById(`${roundId}-${matchId}-deck-fields-${side}`);
                        if (deckFieldsContainer) deckFieldsContainer.style.display = 'block';
                    }
                    if (player.sideboard?.length) setTextarea('player-side-deck', player.sideboard);
                    if (player.legend !== undefined) setDropdownField('player-legend', player.legend);
                    if (player.champion !== undefined) setDropdownField('player-champion', player.champion);
                    if (player.runeList?.length) {
                        player.runeList.forEach((rune, i) => {
                            const n = i + 1;
                            setField(`player-rune-color-${n}`, rune.letter);
                            setField(`player-rune-qty-${n}`, rune.qty);
                        });
                    }
                    // Battlefields — populate up to 3 slots and select radio 1
                    if (player.battlefields?.length) {
                        player.battlefields.forEach((name, i) => {
                            setField(`player-battlefield-${i + 1}`, name);
                        });
                        const radio1 = document.querySelector(`input[name="${roundId}-${matchId}-bf-${side}-select"][value="1"]`);
                        if (radio1) { radio1.checked = true; radio1.dispatchEvent(new Event('change', { bubbles: true })); }
                    }
                }

                // Auto-fetch decklists if decklistIds are available, otherwise clear
                if (player1.decklistId) {
                    socket.emit('fetch-decklist-by-id', {
                        decklistId: player1.decklistId,
                        side: 'left',
                        matchId,
                        roundId,
                        game: currentGameSelection
                    });
                } else if (!player1.mainDeck?.length) {
                    clearDeckFields(roundId, matchId, 'left');
                }
                if (player2.decklistId) {
                    socket.emit('fetch-decklist-by-id', {
                        decklistId: player2.decklistId,
                        side: 'right',
                        matchId,
                        roundId,
                        game: currentGameSelection
                    });
                } else if (!player2.mainDeck?.length) {
                    clearDeckFields(roundId, matchId, 'right');
                }
            }
        }
    });

    // Clear deck-related fields for a given side (used when player has no decklist)
    function clearDeckFields(roundId, matchId, side) {
        const deckTextarea = document.getElementById(`${roundId}-${matchId}-player-main-deck-${side}`);
        if (deckTextarea) {
            deckTextarea.value = '';
            deckTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const sideTextarea = document.getElementById(`${roundId}-${matchId}-player-side-deck-${side}`);
        if (sideTextarea) {
            sideTextarea.value = '';
            sideTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // Clear leader/base/aspect fields (SWU-specific but safe to clear for all games)
        const leaderField = document.getElementById(`${roundId}-${matchId}-player-leader-${side}`);
        if (leaderField) { leaderField.textContent = ''; leaderField.dispatchEvent(new Event('input', { bubbles: true })); }
        const baseField = document.getElementById(`${roundId}-${matchId}-player-base-${side}`);
        if (baseField) { baseField.textContent = ''; baseField.dispatchEvent(new Event('input', { bubbles: true })); }
        const aspect1Field = document.getElementById(`${roundId}-${matchId}-player-leader-aspect-1-${side}`);
        if (aspect1Field) { aspect1Field.textContent = ''; aspect1Field.dispatchEvent(new Event('input', { bubbles: true })); }
        const aspect2Field = document.getElementById(`${roundId}-${matchId}-player-leader-aspect-2-${side}`);
        if (aspect2Field) { aspect2Field.textContent = ''; aspect2Field.dispatchEvent(new Event('input', { bubbles: true })); }
        const baseAspectsField = document.getElementById(`${roundId}-${matchId}-player-base-aspects-${side}`);
        if (baseAspectsField) { baseAspectsField.textContent = ''; baseAspectsField.dispatchEvent(new Event('input', { bubbles: true })); }
        const hpField = document.getElementById(`${roundId}-${matchId}-player-base-hp-${side}`);
        if (hpField) { hpField.textContent = ''; hpField.dispatchEvent(new Event('input', { bubbles: true })); }
    }

    // Listen for decklist fetch response (auto-populate main-deck textarea and leader/base fields)
    socket.on('decklist-fetched', ({ side, matchId, roundId, mainDeck, sideboard, leader, base, error }) => {
        if (error) {
            console.warn('Decklist fetch error:', error);
            clearDeckFields(roundId, matchId, side);
            return;
        }

        // Populate main-deck textarea with card lines
        // Include leader/base as first lines so they get transformed with card URLs
        const deckTextarea = document.getElementById(`${roundId}-${matchId}-player-main-deck-${side}`);
        if (deckTextarea) {
            const lines = [];
            if (leader?.name) lines.push(`1 ${leader.name}`);
            if (base?.name) lines.push(`1 ${base.name}`);
            lines.push(...(mainDeck || []));
            deckTextarea.value = lines.join('\n');
            deckTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // Populate side-deck textarea with sideboard cards
        if (sideboard && sideboard.length > 0) {
            const sideTextarea = document.getElementById(`${roundId}-${matchId}-player-side-deck-${side}`);
            if (sideTextarea) {
                sideTextarea.value = sideboard.join('\n');
                sideTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }

        // Populate leader field and aspects
        if (leader) {
            const leaderField = document.getElementById(`${roundId}-${matchId}-player-leader-${side}`);
            if (leaderField) {
                leaderField.textContent = leader.name || '';
                leaderField.dispatchEvent(new Event('input', { bubbles: true }));
            }
            // Auto-fill leader aspects
            if (leader.aspects && leader.aspects.length > 0) {
                const aspects = leader.aspects.map(a => a.toLowerCase());
                const aspect1Field = document.getElementById(`${roundId}-${matchId}-player-leader-aspect-1-${side}`);
                const aspect2Field = document.getElementById(`${roundId}-${matchId}-player-leader-aspect-2-${side}`);
                if (aspect1Field) {
                    aspect1Field.textContent = aspects[0] || '';
                    aspect1Field.dispatchEvent(new Event('input', { bubbles: true }));
                }
                if (aspect2Field) {
                    aspect2Field.textContent = aspects[1] || '';
                    aspect2Field.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        }

        // Populate base field, aspects, and HP
        if (base) {
            const baseField = document.getElementById(`${roundId}-${matchId}-player-base-${side}`);
            if (baseField) {
                baseField.textContent = base.name || '';
                baseField.dispatchEvent(new Event('input', { bubbles: true }));
            }
            // Auto-fill base aspects
            if (base.aspects && base.aspects.length > 0) {
                const aspectsField = document.getElementById(`${roundId}-${matchId}-player-base-aspects-${side}`);
                if (aspectsField) {
                    aspectsField.textContent = base.aspects.map(a => a.toLowerCase()).join(', ');
                    aspectsField.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
            // Auto-fill base HP
            if (base.hp) {
                const hpField = document.getElementById(`${roundId}-${matchId}-player-base-hp-${side}`);
                if (hpField) {
                    hpField.textContent = base.hp;
                    hpField.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        }

        // Unhide deck fields after melee fetch
        const deckFieldsContainer = document.getElementById(`${roundId}-${matchId}-deck-fields-${side}`);
        if (deckFieldsContainer) deckFieldsContainer.style.display = 'block';

        console.log(`Decklist populated for ${side} player in ${roundId}-${matchId}`);
    });

    // Listen for updated scoreboard state from server
    socket.on('scoreboard-state-data', ({scoreboardState}) => {
        console.log('got server scoreboard state', scoreboardState);
        Object.keys(scoreboardState).forEach((roundId) => {
            Object.keys(scoreboardState[roundId]).forEach((matchId) => {
                const matchState = scoreboardState[roundId][matchId];
                const winsShowCheck = document.querySelector(`#wins-display-scoreboard-${roundId}-${matchId}`);
                if (winsShowCheck) {
                    winsShowCheck.checked = matchState.showWins;
                }
            });
        });
    })

    // end setup socket listeners

    // END START UP

}