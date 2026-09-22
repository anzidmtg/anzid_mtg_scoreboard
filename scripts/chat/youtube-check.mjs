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
// It never prints the API key, and it posts nothing anywhere.
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

if (!key) {
    bad('YOUTUBE_API_KEY is not set in .env');
    note('Create one: console.cloud.google.com -> enable "YouTube Data API v3" -> Credentials -> API key.');
    note('Then add YOUTUBE_API_KEY=... to the .env on the machine that runs the server.');
    process.exit(1);
}
ok(`YOUTUBE_API_KEY is set (${key.length} characters — its value is never printed)`);

const pollMs = Number(process.env.YOUTUBE_POLL_MS) || 5000;
const perDay = Math.round((10 * 3600 * 1000) / pollMs);
note(`YOUTUBE_POLL_MS=${pollMs} -> ${perDay} units for a 10-hour day, of 10,000.`);
if (perDay > 9000) bad(`that is over the bot's own 9,000 budget — YouTube chat would stop early. Use 5000 or more.`);

let channelId = arg('channel') || (process.env.YOUTUBE_CHANNEL_ID || '').trim() || null;
let videoId = arg('video') || (process.env.YOUTUBE_VIDEO_ID || '').trim() || null;
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

console.log(`\n  spent ${units} unit${units === 1 ? '' : 's'} of 10,000 and ${searches} of ~100 daily searches.\n`);
