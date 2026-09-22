#!/usr/bin/env node
// Does the YouTube side of the chat bot actually work? Run this BEFORE a show,
// on the machine that will run the server, and never mid-show — it spends a
// little of the same daily quota the bot needs.
//
//   node scripts/chat/youtube-check.mjs                 # what .env is set to
//   node scripts/chat/youtube-check.mjs --video dQw4w9  # check one broadcast
//   node scripts/chat/youtube-check.mjs --handle @anzidmtg
//   node scripts/chat/youtube-check.mjs --channel UC...
//
//   --server http://192.168.4.43:1378   also read the running server's quota
//                                       and what a !decklists reply would say
//   --send-test                         actually post one message to the live
//                                       chat (needs the OAuth vars; 50 units)
//
// It never prints the API key. It posts nothing unless you pass --send-test,
// which puts one short message in your live chat on purpose.
import 'dotenv/config';

const API = 'https://www.googleapis.com/youtube/v3';
const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : undefined;
};
const key = (process.env.YOUTUBE_API_KEY || '').trim();
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);
const note = (m) => console.log(`        ${m}`);

// Cost is charged per call whatever the outcome, so it is counted here the way
// Google counts it: units for most calls, and search.list against its own
// ~100-calls-a-day bucket.
let units = 0, searches = 0;
async function call(path, params, cost = 1) {
    if (path === 'search') searches++; else units += cost;
    const url = `${API}/${path}?${new URLSearchParams({ ...params, key })}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const body = await r.text();
    let json = null;
    try { json = JSON.parse(body); } catch { /* not JSON: the message below is enough */ }
    if (!r.ok) {
        const reason = json?.error?.errors?.[0]?.reason || '';
        const message = json?.error?.message || body.slice(0, 160);
        const e = new Error(`${path} ${r.status}${reason ? ` (${reason})` : ''}: ${message}`);
        e.reason = reason;
        throw e;
    }
    return json;
}

console.log('\nYouTube chat check\n');

const server = arg('server');
if (!key) {
    bad('YOUTUBE_API_KEY is not set in this .env');
    note('Create one: console.cloud.google.com -> enable "YouTube Data API v3" -> Credentials -> API key.');
    note('Then add YOUTUBE_API_KEY=... to the .env on the machine that runs the server.');
    // The key normally lives on the ingest box, not here, so --server is still
    // worth running: it reads that server's own numbers rather than the API.
    if (!server) process.exit(1);
    note('Checking the server below instead — the API checks need a key on THIS machine.');
} else {
    ok(`YOUTUBE_API_KEY is set (${key.length} characters — its value is never printed)`);
}

if (key) {
const pollMs = Number(process.env.YOUTUBE_POLL_MS) || 5000;
const perDay = Math.round((10 * 3600 * 1000) / pollMs);
note(`YOUTUBE_POLL_MS=${pollMs} -> ${perDay} units for a 10-hour day, of 10,000.`);
if (perDay > 9000) bad(`that is over the bot's own 9,000 budget — YouTube chat would stop early. Use 5000 or more.`);

var channelId = arg('channel') || (process.env.YOUTUBE_CHANNEL_ID || '').trim() || null;
var videoId = arg('video') || (process.env.YOUTUBE_VIDEO_ID || '').trim() || null;
const handle = arg('handle');

try {
    if (handle) {
        const j = await call('channels', { part: 'id', forHandle: handle });
        channelId = j.items?.[0]?.id || null;
        if (channelId) ok(`${handle} is channel ${channelId}`);
        else bad(`no channel found for ${handle}`);
    }

    if (videoId) {
        ok(`checking the broadcast pinned by video id: ${videoId}`);
    } else if (channelId) {
        note(`no video id set, so the bot would search channel ${channelId} for whatever is live.`);
        const j = await call('search', { part: 'id', channelId, eventType: 'live', type: 'video', maxResults: '1' });
        videoId = j.items?.[0]?.id?.videoId || null;
        if (videoId) ok(`that channel is live right now: video ${videoId}`);
        else {
            bad('nothing is live on that channel at the moment');
            note('Not a failure if you are not streaming — but note the bot spends one of ~100 daily');
            note('searches every time it looks, which is why pinning YOUTUBE_VIDEO_ID per stream is safer.');
        }
    } else {
        bad('neither YOUTUBE_VIDEO_ID nor YOUTUBE_CHANNEL_ID is set — the bot would have nothing to read');
    }

    if (videoId) {
        const j = await call('videos', { part: 'liveStreamingDetails,snippet', id: videoId });
        const item = j.items?.[0];
        if (!item) {
            bad(`no video ${videoId} (wrong id, or it is private)`);
        } else {
            const chatId = item.liveStreamingDetails?.activeLiveChatId;
            note(`"${item.snippet?.title || '(untitled)'}" — ${item.snippet?.liveBroadcastContent || 'not live'}`);
            if (!chatId) {
                bad('that broadcast has no active live chat (not live yet, ended, or chat is turned off)');
            } else {
                ok('it has an active live chat');
                const m = await call('liveChat/messages', { liveChatId: chatId, part: 'snippet', maxResults: '200' });
                const n = (m.items || []).length;
                ok(`read the chat: ${n} message${n === 1 ? '' : 's'} in the current page`);
                note(`YouTube asks readers to poll every ${Math.round((m.pollingIntervalMillis || 0) / 100) / 10 || '?'}s; the bot uses ${pollMs / 1000}s (it ignores anything faster).`);
                note('The bot skips this first page on connect — it is backlog, not new requests.');
            }
        }
    }
} catch (e) {
    bad(e.message);
    if (e.reason === 'quotaExceeded' || e.reason === 'dailyLimitExceeded') {
        note("That project's daily quota is gone until midnight Pacific. If this keeps happening, something");
        note('else is sharing the Cloud project, or the bot has been searching for a stream all day.');
    } else if (e.reason === 'keyInvalid' || e.reason === 'badRequest') {
        note('The key looks wrong. Check it was copied whole, and that the restriction on it allows');
        note('the YouTube Data API v3 (Application restrictions should be None for a server).');
    } else if (e.reason === 'accessNotConfigured') {
        note('YouTube Data API v3 is not enabled on that Cloud project: APIs & Services -> Library -> Enable.');
    }
}
}

// ── the running server: its quota ledger, and what it would say right now ───
if (server) {
    const base = server.replace(/\/+$/, '');
    try {
        const r = await fetch(`${base}/api/chat-bridge/youtube-usage`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`${r.status}`);
        console.log('\n' + (await r.text()).replace(/^/gm, '  '));
    } catch (e) {
        bad(`could not read ${base}/api/chat-bridge/youtube-usage — ${e.message}`);
        note(e.message === '404'
            ? 'That server answers, but has no such route — it is running a build from before the'
            : 'Is the server running, and is the chat bridge enabled on it (CHAT_BRIDGE_ENABLED=true)?');
        if (e.message === '404') note('YouTube work. Deploy the current branch and restart it.');
    }
    try {
        const r = await fetch(`${base}/api/chat-bridge/status`, { signal: AbortSignal.timeout(8000) });
        const j = await r.json();
        if (!j?.youtube) { note('That server has no YouTube block on its status page — same older build.'); throw new Error('old build'); }
        const p = j.youtube.preview;
        if (p?.message) {
            console.log(`  A YouTube !decklists right now would post (${p.length}/${p.limit} characters):\n`);
            console.log(`    ${p.message}\n`);
        } else if (p?.error) bad(`preview failed: ${p.error}`);
        else note('The bot would stay quiet right now — nothing confirmed on air and no lists doc.');
    } catch { /* the usage call above already reported the server being unreachable */ }
}

// ── optional: prove a real message actually posts ───────────────────────────
if (process.argv.includes('--send-test')) {
    const cid = process.env.YOUTUBE_CLIENT_ID, csec = process.env.YOUTUBE_CLIENT_SECRET, rt = process.env.YOUTUBE_REFRESH_TOKEN;
    if (!cid || !csec || !rt) {
        bad('--send-test needs YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and YOUTUBE_REFRESH_TOKEN in .env');
        note('Run: node scripts/chat/youtube-auth.mjs');
    } else if (!videoId) {
        bad('--send-test needs a live broadcast — none was found above');
    } else {
        const { createYouTubeSender } = await import('../../features/chat/youtube-send.js');
        let chatId = null;
        try {
            const j = await call('videos', { part: 'liveStreamingDetails', id: videoId });
            chatId = j.items?.[0]?.liveStreamingDetails?.activeLiveChatId || null;
        } catch (e) { bad(e.message); }
        if (!chatId) bad('that broadcast has no active live chat to post into');
        else {
            const sender = createYouTubeSender({ clientId: cid, clientSecret: csec, refreshToken: rt, liveChatId: () => chatId });
            const warm = await sender.warmup();
            if (!warm.ok) { bad(`the bot could not authenticate: ${warm.reason}`); note('If it mentions invalid_grant, the Cloud app is probably still in "Testing" — publish it and re-run youtube-auth.mjs.'); }
            else {
                ok(`authenticated as channel ${warm.botChannelId}`);
                const r = await sender.say('anzidbot check — you can ignore this.');
                if (r.ok) {
                    ok('posted a test message (50 units)');
                    note('Now LOOK at the chat from a SECOND account, switched from "Top chat" to "Live chat".');
                    note('If you can see it and they cannot, the channel\'s chat filtering is eating the bot —');
                    note('make sure the bot account is a moderator. The API reports success either way.');
                } else {
                    bad(`the message did not post: ${r.reason}`);
                    if (r.reason === 'not-live') note('The broadcast ended between the check above and the send.');
                }
            }
        }
    }
}

console.log(`\n  spent ${units} unit${units === 1 ? '' : 's'} of 10,000 and ${searches} of ~100 daily searches.\n`);
