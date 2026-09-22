// One YouTube quota, one ledger.
//
// Reading chat and posting to it draw on the SAME 10,000 units a day — the
// allowance is per Cloud PROJECT, not per key or per feature. If the reader and
// the sender each kept their own count, a busy night of replies would quietly
// starve reading and take YouTube chat dark mid-show, with each half insisting
// it was within budget. So both spend through here.
//
// Costs, from Google's quota table:
//   liveChatMessages.list    1 unit   (a read)
//   liveChatMessages.insert 50 units  (a reply)
//   videos.list              1 unit   (resolving a broadcast)
//   search.list              its own bucket of ~100 CALLS a day, not units
//
// The day rolls over at the server's midnight, which is not Pacific — where
// Google resets. Close enough for a budget with headroom in it; the numbers are
// a guard rail, and Cloud Console remains the authority.

const DAILY_POOL = 10000;
export const DAILY_BUDGET = 9000;   // what we let ourselves use of the pool
export const SEND_COST = 50;
// Of the budget, the most that may go on posting. 2,000 units is 40 replies —
// far more than a show needs — and it leaves 7,000 for reading, which covers a
// 9-hour show at 5s. A raid cannot turn chat into a quota fire.
export const SEND_BUDGET = 2000;
export const SEND_PER_HOUR = 8;
export const DAILY_SEARCHES = 90;

const HOUR = 3600000;
let day = new Date().toDateString();
let units = 0, searches = 0;
const byTag = { read: 0, send: 0, resolve: 0 };
let sends = 0, sendTimes = [];

function rollover() {
    const today = new Date().toDateString();
    if (today === day) return;
    day = today;
    units = 0; searches = 0; sends = 0; sendTimes = [];
    for (const k of Object.keys(byTag)) byTag[k] = 0;
    console.log('[youtube-quota] counters reset for a new day');
}

export function spend(n, tag = 'read') {
    rollover();
    units += n;
    byTag[tag] = (byTag[tag] || 0) + n;
    if (tag === 'send') { sends++; sendTimes = [...sendTimes.filter(t => Date.now() - t < HOUR), Date.now()]; }
    return units;
}

export function noteSearch() { rollover(); return ++searches; }
export function searchesLeft() { rollover(); return Math.max(0, DAILY_SEARCHES - searches); }

// Fraction of the day's budget spent — what paces the reader (see nextPollMs).
export function spentFrac() { rollover(); return units / DAILY_BUDGET; }

/**
 * May we post one more message? Sending is capped three ways: the day's whole
 * budget, the slice of it reserved for posting, and an hourly rate so one bad
 * hour cannot spend the evening.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function canSend() {
    rollover();
    if (units + SEND_COST > DAILY_BUDGET) return { ok: false, reason: 'daily-budget' };
    if (byTag.send + SEND_COST > SEND_BUDGET) return { ok: false, reason: 'send-budget' };
    const lastHour = sendTimes.filter(t => Date.now() - t < HOUR).length;
    if (lastHour >= SEND_PER_HOUR) return { ok: false, reason: 'hourly-cap' };
    return { ok: true };
}

// Everything the status page and the usage readout show.
export function snapshot() {
    rollover();
    return {
        day,
        units: { used: units, budget: DAILY_BUDGET, pool: DAILY_POOL, left: Math.max(0, DAILY_BUDGET - units) },
        reading: { units: byTag.read + byTag.resolve },
        sending: { units: byTag.send, budget: SEND_BUDGET, messages: sends, lastHour: sendTimes.filter(t => Date.now() - t < HOUR).length, perHourCap: SEND_PER_HOUR },
        searches: { used: searches, cap: DAILY_SEARCHES, left: searchesLeft() },
        // What is left, expressed in the units the operator actually thinks in.
        left: { reads: Math.max(0, DAILY_BUDGET - units), messages: Math.floor(Math.max(0, Math.min(DAILY_BUDGET - units, SEND_BUDGET - byTag.send)) / SEND_COST) },
    };
}

// Tests only: start from a clean day.
export function _reset() { day = new Date().toDateString(); units = 0; searches = 0; sends = 0; sendTimes = []; for (const k of Object.keys(byTag)) byTag[k] = 0; }
