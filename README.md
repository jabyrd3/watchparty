# watchparty

Self-hosted low-latency live streaming with chat. WebRTC primary (~0.2 - 0.5s),
low-latency HLS fallback, and a small chat system with accounts.

```
OBS --WHIP (H.264 + Opus, over TLS)--> mediamtx --WHEP----> browser   ~0.2-0.5s
                                                \--LL-HLS--> browser   ~1.5-3s
                       nginx (TLS) --> watchparty (page, status, chat websocket)
```

Chat sits to the right of the video at ≥912px and below it on narrower windows.
Anyone can read chat; sending requires an account.

## What's here

| Path | What it is |
|---|---|
| `server.js` | HTTP server: page, stream status, accounts, websocket upgrade |
| `lib/ws.js` | minimal RFC 6455 websocket server (no dependencies) |
| `lib/db.js` | SQLite user store |
| `lib/auth.js` | scrypt hashing, stateless session tokens, login throttling |
| `lib/chat.js` | in-memory chat backend |
| `public/index.html` | player (WHEP with HLS fallback) + chat UI |
| `mediamtx.example.yml` | media server config |
| `docker-compose.example.yml` | example deployment |
| `nginx/…conf.example` | reverse-proxy location block |

**No dependencies.** Everything uses the Node standard library: `node:sqlite` for storage,
`node:crypto` for hashing, and a basic websocket implementation.

## Requirements

* **Node ≥ 22.5** (for `node:sqlite`). The compose example pins `node:24-slim`.
* **A TLS reverse proxy.** Not optional: browsers only expose WebRTC in a secure
  context, so the page must be served over HTTPS.
* **A publicly reachable UDP port** (8189) for WebRTC media. This cannot be
  proxied — the browser connects to it directly.
* **OBS ≥ 30** for WHIP output.

## Quick start

```sh
cp docker-compose.example.yml docker-compose.yml
cp mediamtx.example.yml       mediamtx.yml
# edit mediamtx.yml: set webrtcAdditionalHosts and the publisher password
docker compose up -d
```

Then point your reverse proxy at it using `nginx/watchparty.locations.conf.example`.

In OBS: **Settings → Stream → Service: WHIP**

```
Server:       https://example.com/watchparty/whip
Bearer Token: obs:<the password you set in mediamtx.yml>
```

Viewers open `https://example.com/watchparty/`.

## The codec constraint

**Browsers cannot play AAC over WebRTC.** It is Opus (or G711/G722), spec-level,
in every browser, and MediaMTX does not transcode. So:

* **WHIP publish (Opus)** → WebRTC works, HLS carries Opus in fMP4.
* **RTMP publish (AAC)** → HLS works, WebRTC has no audio.

Selecting WHIP in OBS switches its audio encoder to Opus automatically. This is
why RTMP is disabled in the example config.

Caveat on the fallback: Opus-in-fMP4 plays in Chrome and Firefox but may not in
Safari. It only affects a Safari user whose network also blocked WebRTC. If that
matters, run an ffmpeg sidecar that republishes an AAC copy to a second path.

## Encoder settings that actually matter

Set a **1 second keyframe interval**, `tune=zerolatency`, and **no B-frames**.

HLS segments cannot be shorter than your keyframe interval; MediaMTX extends
each segment until it contains an IDR frame. A 4s keyframe interval silently
produces 4s segments no matter what `hlsSegmentDuration` says, which makes the
HLS fallback roughly 4× slower than intended, triggers variable segment lengths
that break iOS clients, and makes new WebRTC viewers wait for a keyframe before
they see anything.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8000` | listen port |
| `BASE_PATH` | `/watchparty/` | mount path; baked into the page's `<base href>` |
| `MEDIAMTX_API` | `http://mediamtx:9997` | MediaMTX control API |
| `STREAM_PATH` | `live` | MediaMTX path name |
| `DATA_DIR` | `/data` | holds `users.db` and `session.key` |
| `CHAT_HISTORY` | `50` | in-memory scrollback; `0` retains nothing |
| `STATS_INTERVAL_MS` | `5000` | occupancy log interval |

## What is stored, and what is not

| Data | Where |
|---|---|
| username + password hash | SQLite, in a docker volume |
| session signing key | `session.key` in the same volume, mode 600 |
| session token | the browser's `localStorage`, indefinitely |
| **chat messages** | **process memory only** |

The `users` table has exactly three columns: `username`, `display`, `pw_hash`.
No timestamps, no session rows, no message table. Chat messages are never
written to disk and never logged — logging counts events only
(`chat: relayed a message to N client(s)`).

Passwords are scrypt (N=16384, r=8, p=1) with a per-user random salt, compared
with `timingSafeEqual`. Sessions are stateless HMAC-SHA256 tokens, which is what
lets a browser hold one indefinitely with no server-side session store. Because
the signing key lives in the volume, tokens survive restarts; **deleting
`session.key` invalidates every session at once.**

Abuse limits: 8 login attempts per client per minute, 6 messages per 6s per
connection, messages truncated at 500 chars, websocket frames capped at 64 KB.
Login returns an identical error for unknown-user and wrong-password, so the
endpoint cannot enumerate accounts. Message text is rendered with `textContent`,
never `innerHTML`.

## Security notes and known limitations

Read these before exposing this to people you don't know.

* **Session tokens never expire.** There is no server-side revocation beyond
  deleting `session.key`, which signs everybody out. A captured token is valid
  forever. This is intentional, this is meant to be an ephemeral system.
  if you'd rather they aged out, enforce the `iat` claim in `lib/auth.js`.
* **Tokens live in `localStorage`**, so they are readable by any XSS on the
  origin. Also deliberate, for the same reason.
* **No cap on concurrent websocket connections.** Nothing stops one client
  opening thousands. Fine behind a trusted front end; add a per-IP connection
  limit before exposing it broadly.
* **No password reset or account deletion.** Resetting means deleting the row:
  ```sh
  docker exec watchparty node -e "const{DatabaseSync}=require('node:sqlite'); \
    new DatabaseSync('/data/users.db').prepare('DELETE FROM users WHERE username=?').run('name')"
  ```
* **MediaMTX CORS is `*`** in the example config. Tighten `hlsAllowOrigins` /
  `webrtcAllowOrigins` if you care.
* **Anyone can register.** There is no invite system; registration is throttled
  but open.

CSRF is not a concern here: authentication uses a token held in JS, not an
ambient cookie, so there are no credentials for a cross-site request to ride.

## Gotchas worth knowing

These each cost real debugging time.

**MediaMTX pins HLS sessions to the client IP** it reads from
`X-Forwarded-For`. If that header carries an appended proxy chain and anything
in front of you rotates addresses between requests (Cloudflare does), every
variant-playlist request looks like a new client and returns
`401 authentication error`. Pass exactly one stable address — see the nginx
example.

**MediaMTX answers the first playlist request with a 302** to
`…/index.m3u8?cookieCheck=1`. Serving it under a path prefix without
`proxy_redirect` sends the player out of your prefix to a URL that doesn't
exist, and the HLS fallback silently breaks while WebRTC keeps working.

**`webrtcAdditionalHosts` must be an address viewers can actually reach.**
The container only sees its bridge IP, which is useless as an ICE candidate.
No TURN server is needed if your host is publicly routable.

**Scale is bounded by CPU, not bandwidth.** Measured at roughly 11-14% of one
core per viewer for a ~10 Mbps stream, so a 16-thread machine runs out of CPU
around 100-150 concurrent WebRTC viewers, long before a gigabit link fills.
Every viewer is a direct unicast copy; there is no CDN in this path. The HLS
fallback scales far better if it's behind a caching CDN.

## Debugging

```sh
docker logs watchparty            # occupancy, auth events, chat counts
docker logs mediamtx              # publish/read, auth failures, ICE
docker logs watchparty | grep users:   # 5s-resolution occupancy trace
```

If WebRTC never connects but HLS does, it is almost always UDP 8189 being
blocked upstream, or `webrtcAdditionalHosts` not matching the address viewers
use.

## Licence
do whatever. i don't care.
