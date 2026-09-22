#!/usr/bin/env node
// Rehearse the whole YouTube path with no YouTube: no account, no stream, no
// quota, no network. A fake YouTube answers on localhost and the REAL reader,
// bridge and OAuth sender run against it, so what you watch is the code that
// will run on show day — not a mock of it.
//
//   node scripts/chat/fake-youtube.mjs                  a viewer asks, the bot answers
//   node scripts/chat/fake-youtube.mjs --scenario ended     the broadcast ends mid-show
//   node scripts/chat/fake-youtube.mjs --scenario quota     Google says the quota is gone
//   node scripts/chat/fake-youtube.mjs --scenario expired   the refresh token is dead
//
// What this CANNOT tell you (see DEPLOY.md): how YouTube counts 200 characters,
// whether your links survive its chat filtering, whether the refresh token
// outlives its 7 days, or whether Google's quota count matches ours. Those need
// a real unlisted stream.
import { createServer } from 'http';

const scenario = (() => { const i = process.argv.indexOf('--scenario'); return i > -1 ? process.argv[i + 1] : 'happy'; })();
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const chat = { id: 'FAKE-CHAT-1', waiting: [], posted: [], reads: 0 };
let quotaGone = scenario === 'quota';
let endedOnce = false;   // the broadcast ends once, not on every read

// ── the fake YouTube ────────────────────────────────────────────────────────
const fake = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const deny = (reason, code = 403) => send(code, { error: { code, errors: [{ reason }], message: reason } });

    if (url.pathname.endsWith('/token')) {
        if (scenario === 'expired') return send(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        return send(200, { access_token: 'fake-access-token', expires_in: 3600 });
    }
    if (url.pathname.endsWith('/videos')) {
        return send(200, { items: [{ snippet: { title: 'Fake test stream', liveBroadcastContent: 'live' }, liveStreamingDetails: { activeLiveChatId: chat.id } }] });
    }
    if (url.pathname.endsWith('/channels')) return send(200, { items: [{ id: 'UC-fake-bot-channel' }] });
    if (url.pathname.endsWith('/liveChat/messages')) {
        if (quotaGone) return deny('quotaExceeded');
        if (req.method === 'POST') {
            let body = '';
            req.on('data', c => { body += c; });
            return req.on('end', () => {
                const text = JSON.parse(body)?.snippet?.textMessageDetails?.messageText || '';
                chat.posted.push(text);
                console.log(`\n  🗨  the bot posted (${Math.max(Array.from(text).length, text.length)} chars):\n     ${text}\n`);
                send(200, { id: `posted-${chat.posted.length}` });
            });
        }
        // The broadcast ends the second time the reader looks.
        if (scenario === 'ended' && !endedOnce && chat.reads >= 2) {
            endedOnce = true;
            chat.id = 'FAKE-CHAT-2';   // the next stream, with its own chat
            console.log('\n  ⚠  the broadcast ended — YouTube returns 403 liveChatEnded\n');
            return deny('liveChatEnded');
        }
        chat.reads++;
        const items = chat.waiting.splice(0).map((m, i) => ({
            id: `msg-${chat.reads}-${i}`,
            snippet: { type: 'textMessageEvent', displayMessage: m.text },
            authorDetails: { channelId: m.from, displayName: m.name },
        }));
        return send(200, { items, nextPageToken: `page-${chat.reads}`, pollingIntervalMillis: 0 });
    }
    send(404, { error: { message: 'no such fake endpoint' } });
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;

// Everything Google, redirected here — installed BEFORE the modules load, so
// the sender's captured fetch is this one.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
    const u = String(input);
    if (u.includes('googleapis.com')) return realFetch(u.replace(/https:\/\/[^/]*googleapis\.com(\/youtube\/v3)?/, FAKE), init);
    return realFetch(input, init);
};

process.env.CHAT_BRIDGE_ENABLED = 'true';
process.env.TWITCH_CHANNEL = 'fake-rehearsal';
const { connectYouTubeChat } = await import('../../features/chat/youtube-live.js');
const { createYouTubeSender } = await import('../../features/chat/youtube-send.js');
const { initChatBridge, youtubeDecklistsMessage } = await import('../../features/chat-bridge.js');
const quota = await import('../../features/chat/youtube-quota.js');

console.log(`\nFake YouTube on ${FAKE} — scenario: ${scenario}\n`);

// ── the real code, wired as it is in production ─────────────────────────────
let reader = null;
const sender = createYouTubeSender({
    clientId: 'fake-client', clientSecret: 'fake-secret', refreshToken: 'fake-refresh',
    liveChatId: () => reader?.liveChatId() || null,
});
const warm = await sender.warmup();
console.log(warm.ok ? `  ok    the bot authenticated (as ${warm.botChannelId})` : `  FAIL  the bot could not authenticate: ${warm.reason}`);
if (!warm.ok && scenario === 'expired') {
    console.log('        That is what an expired refresh token looks like. On the real thing it means');
    console.log('        the Cloud app is still in "Testing" — publish it and re-run youtube-auth.mjs.\n');
    fake.close(); process.exit(0);
}

const routes = {};
const bridge = initChatBridge({ get: (p, h) => { routes[p] = h; }, post: () => {} },
    { emit() {}, to: () => ({ emit() {} }), sockets: { emit() {} } },
    { connect: false, say: async () => ({ ok: true }), youtubeSay: sender.say });

reader = connectYouTubeChat({
    apiKey: 'fake-key', videoId: 'FAKE-VIDEO', pollMs: 1000,
    onMessage: bridge.handle, onStatus: (m) => console.log(`  reader: ${m}`),
});

const viewerSays = (text, name = 'A Viewer', from = 'UC-viewer-1') => { chat.waiting.push({ text, name, from }); };
await wait(1500);                       // the reader connects and skips the backlog
viewerSays('!decklists');
await wait(2500);

if (scenario === 'ended') {
    // The reader drops a dead chat immediately, then waits a minute before
    // looking for the next broadcast (OFFLINE_MS — each look costs a unit).
    // Waiting it out is the point: this is the recovery that used to need a
    // server restart, which would drop every overlay and iPad mid-show.
    process.stdout.write('  … the reader retries in 60s; waiting to prove it recovers on its own ');
    for (let i = 0; i < 70 && reader.liveChatId() !== 'FAKE-CHAT-2'; i++) { await wait(1000); if (i % 5 === 0) process.stdout.write('.'); }
    console.log('');
    const got = reader.liveChatId();
    console.log(got === 'FAKE-CHAT-2'
        ? '  ok    picked up the next broadcast by itself — no restart\n'
        : `  FAIL  still on ${got || 'no chat'} after 70s\n`);
    viewerSays('!decklists', 'Second Viewer', 'UC-viewer-2');
    await wait(2500);
}
if (scenario === 'quota') {
    await wait(2000);
    console.log(`  reader state: ${JSON.stringify(reader.state())}`);
}

// ── what the operator would see ─────────────────────────────────────────────
let usage = '';
await routes['/api/chat-bridge/youtube-usage']({}, { type: () => ({ send: (t) => { usage = t; } }) });
console.log('\n' + usage.replace(/^/gm, '  '));
console.log(`  posted this run: ${chat.posted.length} message(s); the fake never filters, so a real`);
console.log('  channel may still hide a link-bearing reply — only a second account can tell you.\n');

// The full reply needs a match on air; OBS is not running here, so show what it
// would compose from a real board.
const board = { 'player-name-left': 'Anu', 'player-name-right': 'Blank', 'player-legend-left': 'Rengar, Pridestalker', 'player-legend-right': 'LeBlanc, Deceiver' };
const full = youtubeDecklistsMessage({
    scene: 'Match 1 - Live', tracker: { 1: { round_id: '1', match_id: 'match1' } }, broadcast: { round_id: '1' },
    data: { 1: { match1: board } }, inSync: () => true, game: 'riftbound', playerCount: '1v1',
}, '@viewer', process.env.DECKLISTS_DOC_URL || 'https://docs.google.com/document/d/1417NC3vjNUJbROWBqp0tPlFJY7asy-fdsFAMjlBMmzQ');
console.log(`  With a match on air it would post (${Math.max(Array.from(full).length, full.length)}/200 chars):\n     ${full}\n`);

reader.stop(); bridge.stop?.(); fake.close(); quota._reset();
process.exit(0);
