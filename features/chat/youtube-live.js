// YouTube live chat READER — API key only, no OAuth.
//
// Reading needs nothing but an API key: no consent screen, no refresh tokens,
// no 7-day expiry, no app verification. (Sending would need OAuth AND costs
// ~50 quota units per message, so this adapter is read-only by design — the
// card appearing on stream IS the feedback for YouTube viewers.)
//
// QUOTA IS THE REAL CONSTRAINT. Default is 10,000 units/day per PROJECT (not
// per key), resetting on Pacific time. Google's quota table documents
// liveChatMessages.list and videos.list at 1 unit each, so:
//
//   interval   calls in 10h   units   % of 10,000
//   1s             36,000     36,000     360%   <- what a busy chat asks for
//   3s             12,000     12,000     120%
//   5s              7,200      7,200      72%   <- our default, covers a long day
//   6s              6,000      6,000      60%   <- headroom for two shows a day
//
// Those are worst-case rows: the reader only polls while a chat is actually
// live, and it slows to IDLE_POLL_MS when nobody is talking (see nextPollMs),
// so a real 4-6 hour show costs well under its row. A 6h show at 5s is ~4,300
// units even if chat never goes quiet.
//
// The API's own pollingIntervalMillis drops to ~1s on a busy chat, which would
// burn the whole day's quota in under three hours and kill the feature
// mid-show. So we honour that hint only when it is SLOWER than our floor.
//
// search.list — how channelId mode finds the live video — is billed from its
// OWN bucket of ~100 calls a day. This server runs all day, so most of those
// calls happen while nothing is live: at one a minute the bucket is empty in
// under two hours and chat never connects at all that day. Discovery therefore
// runs on its own slow clock (DISCOVERY_MS) with its own daily cap, and a
// pinned YOUTUBE_VIDEO_ID skips it entirely.
//
// A broadcast's chat id dies with the broadcast (403 liveChatEnded). Everything
// tied to it — the id, the page token, the seen set — is dropped together in
// forgetChat(), so the next stream of the day is picked up without a restart.
// Restarting is not a cheap alternative here: it drops every overlay and iPad.
//
// A lower-latency option exists: liveChatMessages.streamList is a gRPC
// server-streaming endpoint that pushes messages instead of polling. It needs
// @grpc/grpc-js plus proto handling, and Google documents neither the
// connection lifetime, the dedup rules across reconnects, nor any reconnection
// rate limit — so it is deliberately not used here. See DEPLOY.md.

const API = 'https://www.googleapis.com/youtube/v3';
const DEFAULT_POLL_MS = 5000;   // fits a 10h show at 72% of the default quota
const MIN_POLL_MS = 1000;       // the API itself never asks for faster
const DAILY_BUDGET = 9000;      // leave headroom under the 10k default
const OFFLINE_MS = 60000;       // nothing live, video pinned: 1 unit a try
// Nothing live and no pinned video: each look costs a search, and there are
// only ~100 a day. At 15 minutes a look, a server left running around the clock
// spends 96 — so it can still find the stream tomorrow. The cost is that going
// live can take up to 15 minutes to notice; YOUTUBE_VIDEO_ID is instant.
const DISCOVERY_MS = 15 * 60 * 1000;
const DAILY_SEARCHES = 90;
// Chat is not busy for most of a show. Reading every few seconds through an
// hour of silence spends the same quota as reading through an hour of a packed
// chat, and buys nothing — so the reader slows down when nobody is talking and
// speeds back up on the first message. That is what makes a fast interval
// affordable across a long day.
const IDLE_POLL_MS = 10000;      // after QUIET_AFTER_MS with nothing said
const QUIET_AFTER_MS = 120000;
const LONG_IDLE_POLL_MS = 30000; // after LONG_QUIET_AFTER_MS: a between-rounds lull
const LONG_QUIET_AFTER_MS = 900000;
const PAUSED_POLL_MS = 60000;    // kill switch is off: nothing acts on chat anyway
// Running out of quota mid-show used to mean chat simply stopped (a 15-minute
// sleep, over and over, until midnight Pacific). A show that runs longer than
// planned should cost latency, not the feature: past these fractions of the
// day's budget the reader stretches its interval so what is left lasts. An 8h
// show at 5s spends 64% and never reaches them; a 12h one degrades instead of
// going dark. Highest fraction first.
const BUDGET_TIERS = [
    { spent: 0.95, ms: 30000 },
    { spent: 0.90, ms: 20000 },
    { spent: 0.80, ms: 10000 },
];

const log = (m) => console.log(`[youtube-live] ${m}`);

async function api(path, params, key) {
    const qs = new URLSearchParams({ ...params, key }).toString();
    const r = await fetch(`${API}/${path}?${qs}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
        const body = await r.text().catch(() => '');
        const err = new Error(`${path} ${r.status}: ${body.slice(0, 200)}`);
        err.status = r.status;
        err.quotaExceeded = /quotaExceeded|dailyLimitExceeded/.test(body);
        // The broadcast ended (or its chat was turned off / replaced). The chat
        // id is dead for good, so the only way on is to resolve a new one.
        err.chatGone = /liveChatEnded|liveChatNotFound|liveChatDisabled|no longer live/i.test(body);
        throw err;
    }
    return r.json();
}

// How long to wait before the next read. Pure, so the pacing can be tested
// without the network: see scripts/chat/test-decklists.mjs.
export function nextPollMs({ floorMs, gotMessages, quietMs, paused = false, apiHintMs = 0, spentFrac = 0 }) {
    if (paused) return PAUSED_POLL_MS;
    // Never faster than the interval the operator set, whatever the tier says.
    const quiet = Math.max(floorMs, quietMs >= LONG_QUIET_AFTER_MS ? LONG_IDLE_POLL_MS
        : quietMs >= QUIET_AFTER_MS ? IDLE_POLL_MS
        : 0);
    const low = BUDGET_TIERS.find(t => spentFrac >= t.spent)?.ms || 0;
    const mine = Math.max(gotMessages ? floorMs : quiet, low);
    // YouTube's own hint is honoured only when it asks us to go SLOWER: it
    // drops to ~1s on a busy chat, which would burn the day in under 3 hours.
    return Math.max(mine, apiHintMs || 0);
}

/**
 * Read the live chat of a broadcast.
 *
 *   videoId   pin a specific broadcast (1 quota unit to resolve — cheapest)
 *   channelId auto-discover the live video (search.list, its own 100/day bucket)
 *
 * Returns { stop, isConnected, quotaUsed }.
 */
export function connectYouTubeChat({ apiKey, videoId, channelId, pollMs, onMessage, onStatus = () => {} }) {
    // Operator-tunable via YOUTUBE_POLL_MS. Clamped so a typo cannot set 50ms
    // and torch the day's quota in ten minutes.
    const floorMs = Math.max(MIN_POLL_MS, Number(pollMs) || DEFAULT_POLL_MS);
    let stopped = false, liveChatId = null, pageToken = null;
    let connected = false, timer = null, primed = false, paused = false;
    let lastMessageAt = Date.now(), misses = 0;
    let used = 0, searches = 0, day = new Date().toDateString();
    const seen = new Set();          // liveChatMessageId, guards the first-page backlog

    const rollover = () => {
        const today = new Date().toDateString();
        if (today === day) return;
        day = today; used = 0; searches = 0;
        log('quota counters reset (the server\'s midnight, not necessarily Pacific)');
    };
    const spend = (n) => { rollover(); used += n; return used; };

    // Everything tied to one broadcast's chat. Cleared together: a page token
    // minted for the old chat is rejected by the new one, and the new chat's
    // backlog has to be skipped in its turn.
    function forgetChat() {
        liveChatId = null;
        pageToken = null;
        primed = false;
        seen.clear();
    }

    async function findVideoId() {
        if (videoId) return videoId;
        if (!channelId) throw new Error('set YOUTUBE_VIDEO_ID or YOUTUBE_CHANNEL_ID');
        rollover();
        if (searches >= DAILY_SEARCHES) throw new Error('search budget spent for today — set YOUTUBE_VIDEO_ID to pin the broadcast');
        searches++;
        const j = await api('search', { part: 'id', channelId, eventType: 'live', type: 'video', maxResults: '1' }, apiKey);
        const id = j.items?.[0]?.id?.videoId;
        if (!id) throw new Error('no live broadcast found on that channel');
        return id;
    }

    async function resolveChat() {
        const vid = await findVideoId();
        const j = await api('videos', { part: 'liveStreamingDetails', id: vid }, apiKey);
        spend(1);
        const id = j.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
        if (!id) throw new Error(`video ${vid} has no active live chat (not live, or chat disabled)`);
        liveChatId = id;
        connected = true;
        misses = 0;
        onStatus(`reading chat for video ${vid}`);
    }

    async function poll() {
        if (stopped) return;
        let waitMs = floorMs;
        // Paused by the kill switch: nothing would act on a message anyway, so
        // stop paying for reads. Kept ticking slowly rather than stopped, so
        // resuming does not have to re-resolve the chat.
        if (paused) { timer = setTimeout(poll, PAUSED_POLL_MS); timer.unref?.(); return; }
        try {
            if (!liveChatId) await resolveChat();

            if (used >= DAILY_BUDGET) {
                connected = false;
                onStatus(`daily quota budget reached (${used}) — pausing until reset`);
                waitMs = 15 * 60 * 1000;
            } else {
                const j = await api('liveChat/messages', {
                    liveChatId, part: 'snippet,authorDetails', maxResults: '200',
                    ...(pageToken ? { pageToken } : {}),
                }, apiKey);
                spend(1);
                pageToken = j.nextPageToken || pageToken;
                connected = true;

                // The first page after connecting is the backlog YouTube keeps
                // for a new reader — old messages, not requests. Latched on the
                // first successful call, not on seen.size: a quiet chat returns
                // an empty first page, and inferring it from the set would then
                // swallow the first real messages of the show as well.
                const first = !primed;
                primed = true;
                let fresh = 0;
                for (const it of j.items || []) {
                    const id = it.id;
                    if (!id || seen.has(id)) continue;
                    seen.add(id);
                    if (first) continue;        // don't replay backlog on connect
                    fresh++;
                    const s = it.snippet || {}, a = it.authorDetails || {};
                    if (s.type !== 'textMessageEvent') continue;
                    const roles = new Set();
                    if (a.isChatOwner) roles.add('broadcaster');
                    if (a.isChatModerator) roles.add('moderator');
                    if (a.isChatSponsor) roles.add('subscriber');
                    onMessage({
                        platform: 'youtube',
                        userId: a.channelId || id,
                        login: a.channelId || '',
                        displayName: a.displayName || 'viewer',
                        text: s.displayMessage || s.textMessageDetails?.messageText || '',
                        roles,
                        firstMsg: false,     // YouTube exposes no first-message flag
                    });
                }
                if (seen.size > 5000) for (const k of [...seen].slice(0, 2500)) seen.delete(k);

                if (fresh) lastMessageAt = Date.now();
                waitMs = nextPollMs({
                    floorMs, gotMessages: fresh, quietMs: Date.now() - lastMessageAt,
                    paused, apiHintMs: Number(j.pollingIntervalMillis) || 0,
                    spentFrac: used / DAILY_BUDGET,
                });
            }
        } catch (e) {
            connected = false;
            // Nothing to read yet, or not any more: the previous stream ended,
            // the next one hasn't started, or chat is off. All of them mean
            // "drop this chat and look again later" — how much later depends on
            // whether looking costs a search (see DISCOVERY_MS).
            const noChat = e.chatGone || /no active live chat|no live broadcast|search budget/.test(e.message);
            if (e.quotaExceeded) { onStatus('QUOTA EXCEEDED — backing off 30m'); waitMs = 30 * 60 * 1000; }
            else if (noChat) {
                forgetChat();
                // Each look at a pinned video costs a unit, so a stale id left
                // in .env overnight would quietly eat the morning's budget.
                misses++;
                waitMs = videoId ? Math.min(OFFLINE_MS * Math.min(misses, 5), 5 * 60 * 1000) : DISCOVERY_MS;
                onStatus(`${e.message} — looking again in ${Math.round(waitMs / 60000) || 1}m`);
            }
            else { onStatus(`error: ${e.message}`); waitMs = 30000; }
        }
        if (!stopped) { timer = setTimeout(poll, waitMs); timer.unref?.(); }
    }

    poll();
    return {
        stop() { stopped = true; clearTimeout(timer); connected = false; onStatus('stopped'); },
        isConnected: () => connected,
        // The bridge's kill switch calls this: a paused bot should not spend
        // the day's quota reading chat it will ignore.
        setPaused(p) {
            const was = paused;
            paused = !!p;
            if (was && !paused) { clearTimeout(timer); lastMessageAt = Date.now(); poll(); }
        },
        quotaUsed: () => used,
        // Its own daily bucket, and the one that decides whether channelId mode
        // can still find a stream today — so it is worth seeing separately.
        searchesUsed: () => searches,
    };
}
