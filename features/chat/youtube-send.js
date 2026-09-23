// YouTube live chat SENDER — liveChatMessages.insert.
//
// Unlike the reader next door, this cannot run on an API key: posting acts as a
// Google account, so it needs OAuth with a stored refresh token (see DEPLOY.md
// for the one-time consent, and scripts/chat/youtube-auth.mjs which performs
// it). The account that consents IS the name in chat; make it a moderator of
// the channel, which is also what lets its messages carry links.
//
// Three things make this a poorer relation of the Twitch sender, and the
// bridge is built around them rather than pretending otherwise:
//
//  1. 200 characters a message (YouTube Help; the API documents no limit and
//     simply answers 400 messageTextInvalid). The bot's deck-code links are
//     221-242 characters, so per-player deck links cannot be posted here at
//     all — YouTube gets the match line and the lists doc.
//  2. 50 quota units a message, from the same daily allowance reading spends.
//     Everything goes through features/chat/youtube-quota.js for that reason.
//  3. A 200 does NOT mean anyone saw it. YouTube Help says URLs are not allowed
//     in live chat; in practice a moderator's links do appear, but when the
//     channel's filtering eats one the API still reports success. Test with a
//     second account before trusting a link-carrying reply on air.

import { spend, canSend, SEND_COST } from './youtube-quota.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';
export const MAX_MESSAGE = 200;

const log = (m) => console.log(`[youtube-send] ${m}`);

// YouTube documents the 200 limit in Help and not in the API, so it does not
// say WHICH length it counts. An emoji is one code point but two UTF-16 units,
// so the two differ by a factor of two in the worst case. Take the larger: a
// message that fits under both rules is safe under whichever they use, and the
// cost of being wrong is a 400 that still charged 50 units.
export const messageLength = (s) => {
    const str = String(s ?? '');
    return Math.max(Array.from(str).length, str.length);
};

export function createYouTubeSender({
    clientId = process.env.YOUTUBE_CLIENT_ID,
    clientSecret = process.env.YOUTUBE_CLIENT_SECRET,
    refreshToken = process.env.YOUTUBE_REFRESH_TOKEN,
    liveChatId = () => null,          // read lazily: the id dies with the broadcast
    fetchImpl = fetch,
} = {}) {
    const configured = !!(clientId && clientSecret && refreshToken);
    if (!configured) {
        return {
            configured: false,
            async say() { return { ok: false, reason: 'not configured' }; },
            async warmup() { return { ok: false, reason: 'not configured' }; },
            botChannelId: () => null,
        };
    }

    let token = null, tokenExpiresAt = 0, botChannelId = null, lastSentAt = 0;

    async function getToken() {
        if (token && Date.now() < tokenExpiresAt - 60000) return token;
        const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
        const r = await fetchImpl(TOKEN_URL, { method: 'POST', body, signal: AbortSignal.timeout(15000) });
        const text = await r.text();
        if (!r.ok) {
            // invalid_grant is the one that bites in production: the app was
            // left in "Testing", so the refresh token expired after 7 days.
            const why = /invalid_grant/.test(text)
                ? 'refresh token rejected — if the Cloud app is still in "Testing" it expires every 7 days; publish it and re-authorize'
                : text.slice(0, 160);
            throw new Error(`token refresh failed: ${r.status} ${why}`);
        }
        const j = JSON.parse(text);
        // Google returns this only while the app is in "Testing", where refresh
        // tokens die after 7 days. Say so every time rather than letting chat
        // go quiet between shows for no visible reason.
        if (j.refresh_token_expires_in) {
            const days = Math.round(j.refresh_token_expires_in / 86400);
            log(`WARNING: this refresh token expires in ~${days} day(s) — the Cloud app is still in "Testing". Publish it, then re-run scripts/chat/youtube-auth.mjs.`);
        }
        token = j.access_token;
        tokenExpiresAt = Date.now() + (j.expires_in || 3600) * 1000;
        return token;
    }

    /**
     * Post one message. Never throws. Quota is charged by Google per request,
     * so it is recorded on the attempt, not on success.
     * @returns {{ ok: true } | { ok: false, reason: string }}
     */
    async function say(message) {
        try {
            const text = String(message ?? '').replace(/\s+/g, ' ').trim();
            if (!text) return { ok: false, reason: 'empty' };
            if (messageLength(text) > MAX_MESSAGE) {
                // The caller is meant to have fitted it; refuse rather than
                // spend 50 units on a message YouTube will reject.
                log(`refused: ${messageLength(text)} characters, limit ${MAX_MESSAGE}`);
                return { ok: false, reason: 'too-long' };
            }
            const chatId = liveChatId();
            if (!chatId) return { ok: false, reason: 'not-live' };
            const budget = canSend();
            if (!budget.ok) { log(`refused: ${budget.reason}`); return { ok: false, reason: budget.reason }; }

            const gap = Date.now() - lastSentAt;
            if (gap < 1100) await new Promise(r => setTimeout(r, 1100 - gap));

            const t = await getToken();
            spend(SEND_COST, 'send');
            lastSentAt = Date.now();
            const r = await fetchImpl(`${API}/liveChat/messages?part=snippet`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ snippet: { liveChatId: chatId, type: 'textMessageEvent', textMessageDetails: { messageText: text } } }),
                signal: AbortSignal.timeout(15000),
            });
            if (r.status === 401) { token = null; log('401 — access token rejected, re-minting next send'); return { ok: false, reason: '401' }; }
            if (!r.ok) {
                const body = await r.text().catch(() => '');
                const reason = body.match(/"reason":\s*"([^"]+)"/)?.[1] || String(r.status);
                log(`send failed: ${r.status} ${reason} ${body.slice(0, 160)}`);
                return { ok: false, reason };
            }
            return { ok: true };
        } catch (e) {
            log(`send error: ${e.message}`);
            return { ok: false, reason: e.message };
        }
    }

    // At startup, so a dead refresh token shows up in the boot log rather than
    // the first time a viewer asks something.
    async function warmup() {
        try {
            const t = await getToken();
            const r = await fetchImpl(`${API}/channels?part=id&mine=true`, { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(15000) });
            if (!r.ok) return { ok: false, reason: `${r.status} ${(await r.text()).slice(0, 120)}` };
            spend(1, 'resolve');
            const j = await r.json();
            botChannelId = j.items?.[0]?.id || null;
            if (!botChannelId) {
                // A Google account is not a YouTube channel. Consent granted to
                // the bare account (rather than to its channel, which for a
                // Brand Account is a separate entry in the chooser) leaves a
                // token that can refresh but has no identity to post as — every
                // send would fail. Say so now, not at the first reply.
                log('FAILED — that token has no YouTube channel behind it. Re-run scripts/chat/youtube-auth.mjs and pick the BOT CHANNEL at the account chooser, not the plain Google account.');
                return { ok: false, reason: 'no channel on the authorized account — authorize the bot CHANNEL, not the account' };
            }
            log(`ready — posting as channel ${botChannelId}`);
            return { ok: true, botChannelId };
        } catch (e) {
            log(`warmup failed: ${e.message}`);
            return { ok: false, reason: e.message };
        }
    }

    return { configured: true, say, warmup, botChannelId: () => botChannelId, _state: () => ({ tokenExpiresAt, botChannelId }) };
}
