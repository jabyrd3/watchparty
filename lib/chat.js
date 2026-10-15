'use strict';
// In-memory chat hub.
//
// Message contents never leave this process: they are not written to SQLite,
// not written to disk, and never passed to console.* -- the logging here counts
// events and never includes text. The only retention is an optional short
// scrollback ring so someone joining mid-conversation has context; set
// CHAT_HISTORY=0 to keep nothing at all.

const MAX_TEXT = 500;
// Flood control, per connection.
const RATE_LIMIT = 6, RATE_WINDOW_MS = 6000;

function create({ historySize = 50, log = () => {} } = {}) {
  const clients = new Set();
  const history = [];          // ring of { from, text, ts }
  let seq = 0;

  const presence = () => {
    const names = new Set();
    let anon = 0;
    for (const c of clients) {
      if (c.ctx.user) names.add(c.ctx.user);
      else anon++;
    }
    return { names: [...names].sort(), anon, total: clients.size };
  };

  const broadcast = (obj) => {
    const s = JSON.stringify(obj);
    for (const c of clients) {
      if (!c.closed) c.send(s);
    }
  };

  const pushPresence = () => broadcast(Object.assign({ t: 'presence' }, presence()));

  function add(conn) {
    conn.ctx.user = null;
    conn.ctx.times = [];
    clients.add(conn);

    conn.sendJSON(Object.assign(
      { t: 'hello', authed: false, history: history.slice() },
      { presence: presence() }
    ));
    pushPresence();
    log('chat: client connected (' + clients.size + ' total)');
  }

  function remove(conn) {
    if (!clients.delete(conn)) return;
    const who = conn.ctx.user;
    if (who && ![...clients].some((c) => c.ctx.user === who)) {
      broadcast({ t: 'system', text: who + ' left' });
    }
    pushPresence();
    log('chat: client disconnected (' + clients.size + ' total)');
  }

  // Called once the HTTP layer has validated a token.
  function authenticate(conn, username) {
    const already = [...clients].some((c) => c !== conn && c.ctx.user === username);
    conn.ctx.user = username;
    conn.sendJSON({ t: 'auth', ok: true, user: username });
    if (!already) broadcast({ t: 'system', text: username + ' joined' });
    pushPresence();
    log('chat: authenticated a client');
  }

  function message(conn, raw) {
    if (!conn.ctx.user) {
      return conn.sendJSON({ t: 'error', error: 'Sign in to send messages.' });
    }
    let text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
    if (!text) return;
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);

    const now = Date.now();
    conn.ctx.times = conn.ctx.times.filter((t) => now - t < RATE_WINDOW_MS);
    if (conn.ctx.times.length >= RATE_LIMIT) {
      return conn.sendJSON({ t: 'error', error: 'Slow down a moment.' });
    }
    conn.ctx.times.push(now);

    const msg = { t: 'msg', id: ++seq, from: conn.ctx.user, text, ts: now };
    if (historySize > 0) {
      history.push({ from: msg.from, text: msg.text, ts: msg.ts, id: msg.id });
      while (history.length > historySize) history.shift();
    }
    broadcast(msg);
    // Count only. Never log message text.
    log('chat: relayed a message to ' + clients.size + ' client(s)');
  }

  return { add, remove, authenticate, message, presence, count: () => clients.size };
}

module.exports = { create, MAX_TEXT };
