#!/usr/bin/env node
// One-time: authorize the bot account to post in your YouTube live chat.
//
//   node scripts/chat/youtube-auth.mjs
//
// Run it on your own machine, sign in AS THE ACCOUNT THAT SHOULD POST (the bot
// channel, not necessarily anzidmtg), and it prints a refresh token to paste
// into .env. The token is printed to this terminal only — it is never written
// to a file, logged, or sent anywhere but Google.
//
// Before running, in the Google Cloud console (same project as the reader's
// API key, so both spend one visible quota):
//   * APIs & Services -> Credentials -> Create credentials -> OAuth client ID
//     -> type "Desktop app". Web application will NOT work here.
//   * OAuth consent screen: add the scope .../auth/youtube.force-ssl, then
//     press PUBLISH APP so the status reads "In production". Left in "Testing",
//     Google expires the refresh token after 7 DAYS and chat dies between
//     shows. You do not need Google verification: you are the only user, which
//     their own docs name as the exception. You will see one "Google hasn't
//     verified this app" screen during this script — that is expected, open
//     Advanced and continue.
import 'dotenv/config';
import { createServer } from 'http';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const clientId = arg('client-id') || process.env.YOUTUBE_CLIENT_ID;
const clientSecret = arg('client-secret') || process.env.YOUTUBE_CLIENT_SECRET;
const PORT = Number(arg('port')) || 8765;
const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

if (!clientId || !clientSecret) {
    console.error('\nNeed the OAuth client first.\n');
    console.error('  Put YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env (type: Desktop app),');
    console.error('  or pass --client-id ... --client-secret ...\n');
    process.exit(1);
}

const redirect = `http://127.0.0.1:${PORT}`;
const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent',
});

console.log('\n1. Open this in a browser, signed in as the account that should POST in chat:\n');
console.log(`   ${url}\n`);
console.log('2. Approve it (click Advanced -> continue past the unverified-app screen).');
console.log(`3. This script is listening on ${redirect} and will finish by itself.\n`);

const done = (server, code) => { server.close(); process.exit(code); };

const server = createServer(async (req, res) => {
    const q = new URL(req.url, redirect).searchParams;
    const code = q.get('code'), error = q.get('error');
    if (!code && !error) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    if (error) {
        res.end(`Authorization failed: ${error}. You can close this tab.`);
        console.error(`\nFAIL  Google said: ${error}\n`);
        return done(server, 1);
    }
    res.end('Done — the bot is authorized. You can close this tab.');
    try {
        const r = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }),
        });
        const j = await r.json();
        if (!r.ok || !j.refresh_token) {
            console.error(`\nFAIL  token exchange: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
            if (!j.refresh_token && r.ok) console.error('      No refresh token came back. That happens when this account has already\n      authorized the app: revoke it at myaccount.google.com -> Data & privacy ->\n      Third-party access, then run this again.');
            return done(server, 1);
        }
        // A token minted while the app is still in "Testing" is on a 7-day
        // clock, and Google says so right here in the response. Catching it now
        // beats finding out when chat goes silent between shows.
        if (j.refresh_token_expires_in) {
            const days = Math.round(j.refresh_token_expires_in / 86400);
            console.log(`\n  WARNING  this refresh token EXPIRES in ~${days} day${days === 1 ? '' : 's'}.`);
            console.log('           That means the Cloud app is still in "Testing". Publish it');
            console.log('           (console.cloud.google.com/auth/audience -> Publish app), revoke this');
            console.log('           grant at myaccount.google.com/permissions, and run this again — a');
            console.log('           token minted before publishing keeps its clock.\n');
        } else {
            console.log('\n  ok    the token has no expiry attached — the app is published, as it should be.');
        }
        console.log('\n  ok    authorized. Add this line to the .env of the machine that runs the server:\n');
        console.log(`YOUTUBE_REFRESH_TOKEN=${j.refresh_token}\n`);
        console.log('  Keep it out of git (.env is already ignored) and out of chat messages.');
        console.log('  Check it with:  node scripts/chat/youtube-check.mjs --send-test\n');
        done(server, 0);
    } catch (e) {
        console.error(`\nFAIL  ${e.message}\n`);
        done(server, 1);
    }
});
server.listen(PORT, '127.0.0.1');
setTimeout(() => { console.error('\nTimed out after 5 minutes — nothing was authorized.\n'); done(server, 1); }, 300000).unref?.();
