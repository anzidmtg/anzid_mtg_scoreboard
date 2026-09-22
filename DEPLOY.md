# Deploy / sync runbook

Two production targets:

- **Ingest box** — `AnziD-Ingest-2` (`192.168.4.20`), the live LAN server OBS points at.
  Repo lives under `~/Desktop/coverage hub/...`. Pulls the **`20260330---dsg+fly`** (dsg) branch.
- **Heroku** — deploys from **`deploy-heroku`**.

## Branches

| Branch | Role |
|---|---|
| `20260330---dsg+fly` (dsg) | active working branch — the **ingest box pulls this** |
| `master` | mainline |
| `deploy-heroku` | Heroku deploy branch |

Normally kept in sync via fast-forward (dsg → master → deploy-heroku).

## One-command update of the ingest box

`scripts/deploy/update-ingest.sh` does the whole runbook on the box: fetch + fast-forward
(keeping the box's own `data/` files), `npm install` only when the package files changed,
load the deck-library import list, then start the server if nothing is listening on 1378.
Run it from the dev Mac; it asks for the box's password once:

```bash
ssh -t anuraagdas@<box-ip> 'cd "$HOME/Desktop/coverage hub" && git fetch -q origin 20260330---dsg+fly && git show origin/20260330---dsg+fly:scripts/deploy/update-ingest.sh > /tmp/update-ingest.sh && bash /tmp/update-ingest.sh'
```

| Add | Effect |
|---|---|
| `--stop-after` | leave NO server running at the end: nothing is started, and a server that was already up is stopped after the library work. For updating between shows. Never during a show. |
| `--no-start` | do not start a server, but leave a running one alone |
| `--dry-run` | change nothing, report what would happen |
| `--prune "Vex,Reksai,..."` | one-off: delete library decks for every other legend first (a backup is taken) |

A running server is never restarted by the script, so code changes only take effect after a
stop + start (`--stop-after`, then run it again without the flag).

## Stream Deck: Bitfocus Companion on the ingest box

Companion 5.0.5 is installed on the ingest box (`/Applications/Companion.app`, web UI at
`http://127.0.0.1:8000` on the box only). It loads our module as a **developer module** from
`~/companion-dev-modules/anzid-coverage-hub`, a real copy of `companion-module/` — Companion
hangs on a symlink there, so it must be a copy. `update-ingest.sh` refreshes that copy on every
update (and runs `npm install` in it when the module's package files change); Companion watches
the folder and restarts the module by itself.

The connection "coverage-hub" points at `127.0.0.1:1378`, so it is green only while the server
on the box is running. The launcher settings that make this work live in
`~/Library/Application Support/companion/config.json`: `enable_developer: true`,
`dev_modules_path: /Users/anuraagdas/companion-dev-modules`.

From the dev Mac, reach the Companion UI with an SSH tunnel:
`ssh -N -L 18000:127.0.0.1:8000 anuraagdas@<box-ip>` then open `http://127.0.0.1:18000`.

## ⚠️ Gitignored assets DO NOT transfer via git

Large binaries are gitignored (`.gitignore`) and must be copied to the ingest box
**separately** — a plain `git pull` leaves them missing. Typical symptoms: blank
decklist **wallpaper video**, missing animated legend art, no metagame/standings motion.

| Path | ~Size | Breaks if missing |
|---|---|---|
| `public/assets/animations/riftbound/` | ~3.7 GB | decklist wallpaper video, animated legends, metagame/standings motion |
| `public/assets/images/vibes/cards/ETH/`, `.../LOL/` | — | Vibes card art |
| `public/js/restream-config.js` | 1 line | anu Restream chat overlay (blank without it) |

### Topdeck.gg import (`.env`)

The master-control FFA "Topdeck" row (load round → apply pod) needs
`TOPDECK_API_KEY=<key>` in the server's `.env` (gitignored). Free key from
https://topdeck.gg/developers. Without it the Load button reports the missing
key. Topdeck requires a visible "powered by TopDeck.gg" credit on projects
using the API.

### Card vision (`CARD_VISION_ENABLED`)

The experimental card recognizer starts with the server and holds an OBS
WebSocket open, polling every 1 s (local state) and 10 s (scene transform),
whether or not anyone is using it. Unless you are actively developing it:

```
CARD_VISION_ENABLED=false
```

⚠️ It reads `OBS_WS_URL`, which the main OBS integration does **not**
(`features/obs-websocket.js` hardcodes `ws://localhost:4455`). If `OBS_WS_URL`
points at another machine — e.g. `ws://192.168.4.20:4455` — then every box
running the server quietly polls the **ingest box's** OBS. Leave `OBS_WS_URL`
unset so each machine defaults to its own OBS, and `.env` stays portable
across Dev-1, Dev-2 and the ingest box.

### Chat-driven card viewer (`CHAT_BRIDGE_ENABLED`)

Viewers type `!card <name>`, `!c <name>` or `[[name]]` in chat and the card
appears on **slot 3** (`/display/card/view/3`), which has its own OBS browser
source — hiding it is an instant kill.

Note that slot 3 ALSO renders on the main scoreboard's right-hand viewer:
`scoreboard.js` routes by `card-id === '1' ? left : right`, so anything that is
not 1 lands on the right. It is not a 1/2 whitelist. Chat cannot paint over the
operator, but that is because of the operator-yield guard (which keys on the
SIDE, not the card id), not because the slot is unrouted.

Off unless you set:

```
CHAT_BRIDGE_ENABLED=true
TWITCH_CHANNEL=anzidmtg
```

**Reading chat needs no credentials** — it connects anonymously. Everything
works at that point except posting disambiguation prompts; ambiguous names
fall through to the 5-second auto-pick instead.

#### Optional: let the bot post in chat

Needed only for "did you mean 1) … 2) …" prompts and the cooldown notice.

1. Create a second Twitch account for the bot (keeps prompts visually distinct
   from you, and earns the Chat Bot badge).
2. Register an app at <https://dev.twitch.tv/console/apps>. Client type
   **Confidential**, OAuth redirect `http://localhost:3000`. Note the
   **Client ID** and **Client Secret**.
3. Grant the BOT account once — easiest with the Twitch CLI:
   ```bash
   twitch token -u -s 'user:write:chat user:bot'
   ```
   Log in **as the bot**. You can discard the printed token; only the grant
   matters, and Twitch remembers it server-side.
4. In your channel, `/mod <botname>`. That removes the need for a separate
   `channel:bot` grant from the broadcaster and lifts the send limit from 20 to
   100 messages / 30s.
5. Add to `.env`:
   ```
   TWITCH_CLIENT_ID=...
   TWITCH_CLIENT_SECRET=...
   TWITCH_BOT_LOGIN=<botname>
   ```

The server then mints an **app access token** itself (~58 days, no refresh
token to rotate or lose) and re-mints a day before expiry. Nothing to maintain
mid-show. Boot logs `chat sending ready` when the credentials work.

#### Optional: read YouTube live chat too

YouTube is **read-only** — posting costs ~50 quota units a message and needs
OAuth, so YouTube viewers never get a "did you mean" menu. An ambiguous name
shows the top-ranked printing immediately rather than stalling on a prompt they
cannot see.

1. Create a project at <https://console.cloud.google.com/>.
2. **APIs & Services → Library → YouTube Data API v3 → Enable.**
3. **APIs & Services → Credentials → Create credentials → API key.**
   Restrict it to the YouTube Data API (Application restrictions can stay None
   — it is used server-side, not from a browser).
4. Add to `.env`:
   ```
   YOUTUBE_API_KEY=...
   YOUTUBE_CHANNEL_ID=UC...      # finds whatever is live by itself
   # YOUTUBE_VIDEO_ID=...        # or pin one broadcast (edit per stream)
   # YOUTUBE_POLL_MS=5000        # default 5000, clamped to >= 1000
   ```
   Your channel ID is in YouTube Studio → Settings → Channel → Advanced.
   anzidmtg is `UCskein7E6WikZYKemXqxCSw`.

5. Check it before you need it: `node scripts/chat/youtube-check.mjs`. It
   resolves the key, the channel and the live chat and reads one page, printing
   what it spent. `--handle @name`, `--video <id>` and `--channel UC...`
   override `.env`. It never prints the key.

Which to set:

- `YOUTUBE_CHANNEL_ID` needs no attention per stream, but finding the broadcast
  costs a `search.list` call from its OWN bucket of ~100 a day. The reader looks
  every 15 minutes while nothing is live (96 a day, under the bucket, so it can
  still find a stream tomorrow) — so going live takes up to 15 minutes to be
  noticed.
- `YOUTUBE_VIDEO_ID` connects immediately and spends no searches, but it means
  editing `.env` and restarting before every stream, which drops every overlay
  and iPad. Take the id from the watch URL: `youtube.com/watch?v=THIS_PART`.

Set both and the video id wins.

**Quota.** 10,000 units/day per PROJECT (not per key), resetting Pacific time.
Google's quota table documents `liveChatMessages.list` and `videos.list` at 1
unit each, and `search.list` as its own ~100-calls/day bucket.

| Poll interval | Calls in 10h | Units | Of 10,000 |
|---|---|---|---|
| 1s | 36,000 | 36,000 | 360% — over |
| 3s | 12,000 | 12,000 | 120% — over |
| **5s** | **7,200** | **7,200** | **72% — default** |
| 6s | 6,000 | 6,000 | 60% — room for two shows |

The adapter stops itself at 9,000 units and pauses until the counter resets, so
a too-fast interval costs you the END of the show, quietly. `sources[].quotaUsed`
and `sources[].searchesUsed` on the status endpoint are the two numbers to
watch; Cloud Console → APIs & Services → Quotas shows Google's own view.

A push-based alternative exists — `liveChatMessages.streamList`, a gRPC
server-streaming endpoint with much lower latency and no polling cost. It needs
`@grpc/grpc-js` plus proto handling, and Google documents neither the
connection lifetime, the dedup rules across reconnects, nor any reconnection
rate limit. Not used here for that reason.

#### Operating it

| | |
|---|---|
| Status | `GET /api/chat-bridge/status` |
| Kill switch | `POST /api/chat-bridge/live/off` (and `/on`) — no restart |
| Cooldown | 10s global between cards; one chat notice per window, not per request |
| Fairness | a request arriving during a cooldown is PARKED (one per platform, newest wins) and the platform not served last goes first — so YouTube cannot be permanently crowded out by a busier Twitch chat. Parked entries expire after 30s |
| Dwell | card clears after 10s — equal to the cooldown on purpose, so the next card goes up the moment the last comes down, with no dead gap on the card back |
| Blocked | content-warning cards, first-time chatters, unknown names (silent) |

### Restream chat config (`public/js/restream-config.js`)

Gitignored because it holds an embed token. The anu scoreboard's Restream chat
stays blank until this one-line file exists on the machine serving the scoreboard.
Create it on the ingest box (and Heroku, if used):

```js
window.RESTREAM_CHAT_URL = 'https://chat.restream.io/embed?token=YOUR_TOKEN';
```

Get the URL from https://chat.restream.io/settings/embed.

### Sync command (run from the dev Mac)

```bash
# whole animations tree (recommended — covers decklist, legend-art, metagame, standings)
rsync -avz --progress \
  "public/assets/animations/riftbound/" \
  "USER@192.168.4.20:PATH_TO_REPO/public/assets/animations/riftbound/"
```

Replace `USER` and `PATH_TO_REPO` with the ingest box's login + repo path. Re-run
whenever the animation assets change. (To sync just the decklist wallpaper, point both
sides at `.../animations/riftbound/decklist/` instead.)

## Ingest box update steps

1. `git pull` (on the `20260330---dsg+fly` branch)
2. **rsync the gitignored assets above** — only when they changed (see table)
3. `npm install` — only when `package.json` changed
4. Restart the server (`node server.js`, or via your process manager)

OBS WebSocket must be reachable at `ws://localhost:4455` — used by the OBS preset
system and the card-vision transform mapping.

## Heroku

Push `deploy-heroku`; if the app auto-deploys from GitHub it builds on push, otherwise
trigger the deploy from the dashboard. Heroku has no OBS and no local recognizer state,
so the `card-vision` feature just logs harmless failed-connection retries there.

---

# Setting up a NEW Mac (dev or show machine)

A `git pull` gets you the app. It does **not** get you a working OBS. Three
separate things have to arrive, and only the first is in git:

| Layer | In git? | Size | How it travels |
|---|---|---|---|
| App code | ✅ yes | — | `git pull` |
| Gitignored app assets (`animations/`, `.env`, `restream-config.js`) | ❌ no | ~3.7 GB | rsync / manual |
| **OBS scene collection** (`.json`) | ❌ no | ~3 MB | OBS export → import |
| **External media the collection points at** | ❌ no | ~6 GB | copy, at identical absolute paths |

## 1. Repo (Sourcetree)

1. **File → Clone / New → Clone from URL**
   - Source URL: `https://github.com/vikashramkumar001/anzid_mtg_scoreboard.git`
   - Destination: keep the same path shape as the dev Mac if you can.
2. In the sidebar under **REMOTES → origin**, double-click the branch you want
   (`master`, or `20260330---dsg+fly` for the active working branch). Sourcetree
   creates the local tracking branch.
3. Later updates: **Pull** button (or ⌘⇧L). Nothing else is needed for code.

Then, in Terminal at the repo root:

```bash
npm install     # Node 18.x — matches the dev Mac (node -v → v18.15.0)
```

## 2. Gitignored app assets

See the table further up this file. In short: `.env` (Topdeck key),
`public/js/restream-config.js` (Restream token), and
`public/assets/animations/` (~3.7 GB). Copy from the dev Mac.

## 3. OBS

### 3a. Install OBS + the plugins the collection depends on

OBS **31.1.2** on the dev Mac. The collection will load without these plugins,
but scenes will be visibly broken — **Move Transition alone drives 326 filters**,
i.e. essentially every animated element:

| Plugin | Used for | Count |
|---|---|---|
| **Move Transition** | all scene-item animation + the `Move` transition | 326 filters |
| **Source Clone** | duplicated cams/browsers | 3 sources |
| **DistroAV / obs-ndi** | NDI backup feeds | 2 sources |
| **obs-shaderfilter** | shader effects | 5 filters |
| **Source Record** | per-source recording | 1 filter |
| **Ashmanix Countdown** | writes `Text - Timer Long` / `Text - Timer Short`, which the merlion BTB countdown page mirrors | — |

Also on the dev Mac (not strictly required by the collection): Advanced Scene
Switcher, Vertical Canvas, obs-multi-rtmp, Aitum Multistream, Advanced Masks,
Stroke/Glow/Shadow, text-pthread, Transition Table, Waveform, Source Copy.

### 3b. Fonts

Install these system-wide or OBS text sources fall back to something wrong:
**Beaufort for LOL** (Heavy), **Beni** (Bold), **Gotham Narrow** (Bold),
**Tusker Grotesk 6500** (Medium). Web fonts used by the browser pages live in
`public/fonts/` and travel with git — no action needed for those.

### 3c. Move the scene collection

On the dev Mac: **Scene Collection → Export**. On the new Mac: **Scene
Collection → Import**, then select it. The current show collection is
`proto 3 - FULL LOCAL - riftbound` (140 scenes, 173 inputs).

The raw file, if you'd rather copy it directly:

```
~/Library/Application Support/obs-studio/basic/scenes/proto_3__FULL_LOCAL__riftbound.json
```

Quit OBS before copying — OBS only flushes the collection to disk on quit or
collection-switch, so a live copy can be stale.

### 3d. Enable OBS WebSocket

**Tools → WebSocket Server Settings** → enable, port **4455**, password
`RRWtUPVpGf6myRvx` (this is what the app's preset system and the browser pages
default to). Without it: no preset save/restore, and the merlion countdown page
can't mirror the Ashmanix timer.

### 3e. ⚠️ External media lives OUTSIDE the repo, at absolute paths

The collection references ~54 files by **absolute path**, ~6 GB, under:

- `~/Desktop/media assets/` — stingers, music beds, sponsor ad videos, animated
  legend `.mov` files, backgrounds
- `~/Desktop/mtg mobile coverage/coverage overlay/` — overlay art, masks, info
  slides, sponsor images
- `~/Movies/` — camera-ingest test recordings

Because the paths are absolute and start `/Users/anuraagdas/`, the new Mac needs
**the same short username** and the same folder layout, or every one of those
sources goes red. If the username differs, you must relink them by hand in OBS.

Only the folders actually referenced need to come across — not all 233 GB. The
biggest single items are the camera-ingest `.mkv` (2.8 GB), the flyquest sponsor
ads (932 MB), `elf rgb2.mov` (832 MB) and the 10s countdown comp (383 MB).

**Two single points of failure worth checking by hand:**

- **The stinger.** All 11 `Stinger - *` transitions point at one file:
  `~/Desktop/media assets/Brand/g4k motion/Breach The Bay/BTB_update_02.aep_AME/PG1_1.webm`
  (4.2 MB, VP9 1920x1080 30 fps, transition point 1000 ms). Miss it and every
  scene change in the show breaks. The same folder holds an older `PG1.webm` —
  `PG1_1` is the current one.
- **The NDI backup source** is named after a *machine*: `MACBOOK-PRO (OBS
  Backup)`. NDI resolves by computer name, so it stays disconnected until that
  machine is on the network under that name.

### 3e-bis. If the usernames don't match

**Confirmed case:** the second Mac's short username is `anzidmtg_TD001`, while
every path baked into the collection starts `/Users/anuraagdas/`. Three ways out,
best first:

1. **Symlink the old home path** (one command, fixes all 54 at once, and keeps
   preset restore correct too):

   ```bash
   sudo ln -s /Users/$(whoami) /Users/anuraagdas
   ```

   Every `/Users/anuraagdas/...` path then resolves to the real home. Nothing in
   OBS or the presets needs editing. Re-run after a macOS major upgrade, which
   can clear it.

2. **Rewrite the paths** in the exported collection *before* importing, with a
   find-and-replace of `/Users/anuraagdas/` → `/Users/<newuser>/`. ⚠️ You must
   also rewrite `local_file` in every `data/obs exports/*.json`, or the first
   **Apply Broadcast Settings** pushes the old paths straight back — the same
   failure mode as the Fiora/Irelia break (see the preset notes).

3. **Relink each source by hand** in OBS. 54 sources. Avoid.

`verify-machine.mjs` reports this explicitly as *"N path(s) reference a
DIFFERENT user's home"*.

### 3f. Restore positions from a preset

Scene-item positions live in the repo, per game/vendor/player-count, in
`data/obs exports/`. Start the server, open master control, pick the
game/vendor/count and click **Apply Broadcast Settings**.

Restore **only repositions items that already exist** — it never creates or
deletes sources. So the scene collection (3c) must be imported first, otherwise
restore silently does nothing.

## 4. Machine names

Two Macs plus the ingest box on one LAN gets confusing fast, and NDI resolves
sources *by computer name*. Suggested scheme, matching the existing
`AnziD-Ingest-2`:

| Machine | Name | Role |
|---|---|---|
| M4 Max, serial CPG9M62GJC, user `anuraagdas` | `AnziD-Dev-1` | original dev + show Mac; the reference for everything in this file |
| the second one, user `anzidmtg_TD001` | `AnziD-Dev-2` | second rig |
| `192.168.4.20` | `AnziD-Ingest-2` | LAN server the ingest OBS points at |

The numbers are identity, not rank — if the second machine becomes primary,
nothing needs renaming.

Set it in **System Settings → General → About → Name**; confirm with
`scutil --get LocalHostName`. Dev-1 currently reports `MacBook Pro (2)` /
`MacBook-Pro-37` — the `(2)` means something else already claimed "MacBook Pro"
on the network, which is the collision worth heading off now that there are two.

## 5. Verify the new Mac

```bash
node server.js        # then open http://localhost:1378
```

- OBS: no red "missing file" sources in the scene list
- OBS: the 11 `Stinger - *` transitions all point at `PG1_1.webm`
- Browser sources render (they hit `http://localhost:1378/...`, so the server
  must be running on the *same* machine as OBS, or the URLs need repointing)
- Apply a preset from master control and confirm items land correctly

## Known-stale references (safe to ignore)

12 files referenced by the collection no longer exist. All are past-event
assets in archived `*` scenes, plus two old test recordings — nothing a current
show touches:

- `20231208 eternal weekend na/profiles/legacy/*` — 3 player profile PNGs (hidden)
- `20250418 mxp santa clara/*`, `20250822 mxp phoenix/*`, `20251009 na ew/*`,
  `20251031 mxp tacoma/*` — 7 old event slides
- `~/Movies/2025-08-23 *.mkv`, `~/Movies/2025-10-16 *.mkv` — test recordings
