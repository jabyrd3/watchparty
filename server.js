'use strict';
// Watchparty webserver: player page, stream status, user accounts, and the
// chat websocket.
//
// Media does not pass through here -- MediaMTX handles ingest and both egress
// paths, and nginx proxies those directly. What lives here is the page, a
// status probe, the user table, and the chat relay.
//
// Chat messages are in-memory only (see lib/chat.js). SQLite holds usernames
// and password hashes and nothing else.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const ws = require('./lib/ws');
const store = require('./lib/db');
const auth = require('./lib/auth');
const chatlib = require('./lib/chat');

const PORT         = parseInt(process.env.PORT || '8000', 10);
const BASE_PATH    = process.env.BASE_PATH || '/watchparty/';
const MEDIAMTX_API = process.env.MEDIAMTX_API || 'http://mediamtx:9997';
const STREAM_PATH  = process.env.STREAM_PATH || 'live';
const DATA_DIR     = process.env.DATA_DIR || '/data';
const HISTORY_SIZE = parseInt(process.env.CHAT_HISTORY || '50', 10);

// Every viewer gets an identical status answer, so one upstream call can serve
// all of them. Without this the MediaMTX API sees one request per viewer per
// poll (N/4 per second); with it, at most one call per this interval.
const STATUS_CACHE_MS = 1500;
const STATS_INTERVAL_MS = parseInt(process.env.STATS_INTERVAL_MS || '5000', 10);

const SESSION_TTL_MS = 12000;
const MAX_SESSIONS   = 10000;
const MAX_BODY       = 4096;

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.ico':  'image/x-icon',
};

function log(...a) { console.log(new Date().toISOString(), ...a); }

const db = store.open(DATA_DIR);
const tokens = auth.makeTokens(auth.loadSecret(DATA_DIR));
const throttle = auth.makeThrottle();
const chat = chatlib.create({ historySize: HISTORY_SIZE, log });

// ---- helpers ----------------------------------------------------------------

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}
const sendJSON = (res, code, obj) =>
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json' });

function safeJoin(root, rel) {
  const p = path.normalize(path.join(root, decodeURIComponent(rel)));
  return p.startsWith(path.normalize(root)) ? p : null;
}

// nginx hands us one stable address in X-Forwarded-For (see the map in
// default.conf), so the first entry is the client.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function readJSON(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > MAX_BODY) { req.destroy(); resolve(null); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

// Strip the mount prefix nginx may or may not have removed.
function appPath(pathname) {
  let p = pathname;
  if (p.startsWith(BASE_PATH)) p = '/' + p.slice(BASE_PATH.length);
  return p === '' ? '/' : p;
}

// ---- viewer presence (unrelated to chat auth) -------------------------------
const sessions = new Map();

function touchSession(id, playing) {
  if (!id) return;
  if (!sessions.has(id) && sessions.size >= MAX_SESSIONS) return;
  sessions.set(id, { seen: Date.now(), playing: !!playing });
}
function dropSession(id) { if (id) sessions.delete(id); }
function countViewers() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  let viewers = 0, watching = 0;
  for (const [id, s] of sessions) {
    if (s.seen < cutoff) { sessions.delete(id); continue; }
    viewers++;
    if (s.playing) watching++;
  }
  return { viewers, watching };
}

async function fetchStreamStatus() {
  const url = `${MEDIAMTX_API}/v3/paths/get/${encodeURIComponent(STREAM_PATH)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (r.status === 404) return { live: false, tracks: [], since: null, rtcReaders: 0 };
    if (!r.ok) return { live: false, tracks: [], since: null, rtcReaders: 0, error: 'api ' + r.status };
    const j = await r.json();
    return {
      live: !!j.ready,
      tracks: Array.isArray(j.tracks) ? j.tracks : [],
      since: j.readyTime || null,
      rtcReaders: Array.isArray(j.readers) ? j.readers.length : 0,
    };
  } catch (e) {
    return { live: false, tracks: [], since: null, rtcReaders: 0, error: String(e.message || e) };
  }
}

let statusCache = { at: 0, value: null, inflight: null };

function streamStatus() {
  const now = Date.now();
  if (statusCache.value && now - statusCache.at < STATUS_CACHE_MS) {
    return Promise.resolve(statusCache.value);
  }
  // Coalesce: a burst of concurrent misses shares one upstream request rather
  // than each firing its own.
  if (statusCache.inflight) return statusCache.inflight;
  statusCache.inflight = fetchStreamStatus().then((v) => {
    statusCache = { at: Date.now(), value: v, inflight: null };
    return v;
  }).catch((e) => {
    statusCache.inflight = null;
    throw e;
  });
  return statusCache.inflight;
}

// ---- accounts ---------------------------------------------------------------

async function handleAuth(req, res, mode) {
  const ip = clientIp(req);
  if (!throttle.check(ip)) {
    return sendJSON(res, 429, { ok: false, error: 'Too many attempts. Wait a minute.' });
  }
  const body = await readJSON(req);
  if (!body) return sendJSON(res, 400, { ok: false, error: 'Bad request.' });

  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const invalid = auth.validateCredentials(username, password);
  if (invalid) return sendJSON(res, 400, { ok: false, error: invalid });

  const key = username.toLowerCase();
  const existing = db.getUser(key);

  if (mode === 'register') {
    if (existing) return sendJSON(res, 409, { ok: false, error: 'That username is taken.' });
    const hash = await auth.hashPassword(password);
    try { db.createUser(key, username, hash); }
    catch (_) { return sendJSON(res, 409, { ok: false, error: 'That username is taken.' }); }
    log('auth: account created');
    throttle.clear(ip);
    return sendJSON(res, 200, { ok: true, token: tokens.issue(key), user: username });
  }

  // Same response for unknown user and wrong password, so the endpoint does not
  // reveal which usernames exist.
  const ok = existing && await auth.verifyPassword(password, existing.pw_hash);
  if (!ok) return sendJSON(res, 401, { ok: false, error: 'Wrong username or password.' });
  log('auth: login succeeded');
  throttle.clear(ip);
  return sendJSON(res, 200, { ok: true, token: tokens.issue(key), user: existing.display });
}

// ---- HTTP -------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = appPath(u.pathname);

  if (req.method === 'POST' && p === '/api/auth/login')    return handleAuth(req, res, 'login');
  if (req.method === 'POST' && p === '/api/auth/register') return handleAuth(req, res, 'register');

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');

  if (p === '/api/status') {
    const id = u.searchParams.get('id');
    if (u.searchParams.get('leave') === '1') { dropSession(id); return send(res, 204, ''); }
    touchSession(id, u.searchParams.get('playing') === '1');
    const st = await streamStatus();
    return sendJSON(res, 200, Object.assign(st, countViewers(), { chatUsers: chat.count() }));
  }

  if (p === '/' || p === '/index.html') {
    return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8', (err, html) => {
      if (err) return send(res, 500, 'player page missing');
      send(res, 200, html.replace(/__BASE_PATH__/g, BASE_PATH), { 'Content-Type': MIME['.html'] });
    });
  }

  const file = safeJoin(PUBLIC_DIR, p.slice(1));
  if (!file) return send(res, 400, 'bad path');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
    });
    fs.createReadStream(file).pipe(res);
  });
});

// ---- chat websocket ---------------------------------------------------------

server.on('upgrade', (req, socket) => {
  const p = appPath(new URL(req.url, 'http://localhost').pathname);
  if (p !== '/ws') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }

  const conn = ws.accept(req, socket);
  if (!conn) return;
  chat.add(conn);

  conn.onmessage = (text) => {
    let m;
    try { m = JSON.parse(text); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'auth') {
      const key = tokens.verify(m.token);
      const user = key && db.getUser(key);
      if (!user) return conn.sendJSON({ t: 'auth', ok: false, error: 'Session expired, sign in again.' });
      return chat.authenticate(conn, user.display);
    }
    if (m.t === 'msg') return chat.message(conn, m.text);
  };

  conn.onclose = () => chat.remove(conn);
});

// Periodic occupancy line. Counts only -- never anything about who or what.
setInterval(async () => {
  const v = countViewers();
  let live = '?', rtc = '?';
  try { const st = await streamStatus(); live = st.live ? 'live' : 'offline'; rtc = st.rtcReaders; }
  catch (_) { live = 'unknown'; }
  log(`users: ${v.viewers} present, ${v.watching} watching, ${chat.count()} in chat` +
      ` | stream ${live}, ${rtc} webrtc reader(s)`);
}, STATS_INTERVAL_MS);

server.listen(PORT, '0.0.0.0', () => {
  log(`watchparty listening on :${PORT}  base=${BASE_PATH}`);
  log(`status via ${MEDIAMTX_API} path=${STREAM_PATH}`);
  log(`users db in ${DATA_DIR} (${db.countUsers()} accounts); chat scrollback ${HISTORY_SIZE}`);
});
