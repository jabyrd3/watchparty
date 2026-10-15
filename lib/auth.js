'use strict';
// Password hashing, session tokens, and login throttling.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

// scrypt cost. 16384/8/1 is the usual interactive-login baseline.
const N = 16384, R = 8, P = 1, KEYLEN = 64;

const USERNAME_RE = /^[A-Za-z0-9_.-]{2,24}$/;
const PASSWORD_MIN = 8, PASSWORD_MAX = 200;

// ---- passwords --------------------------------------------------------------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const key = await scrypt(password, salt, expected.length,
                             { N: Number(n), r: Number(r), p: Number(p) });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch (_) {
    return false;
  }
}

// ---- session tokens ---------------------------------------------------------
// Stateless and HMAC-signed, so no session table is needed and the browser can
// hold one indefinitely. The signing key lives in the data volume (not in
// SQLite) so that tokens survive restarts.

function loadSecret(dir) {
  const file = path.join(dir, 'session.key');
  try {
    const b = fs.readFileSync(file);
    if (b.length >= 32) return b;
  } catch (_) { /* first run */ }
  const secret = crypto.randomBytes(32);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const b64u = (b) => Buffer.from(b).toString('base64url');

function makeTokens(secret) {
  const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest();

  return {
    issue(username) {
      const payload = b64u(JSON.stringify({ u: username, iat: Date.now() }));
      return payload + '.' + b64u(sign(payload));
    },
    // Returns the username, or null if the token is absent/forged/malformed.
    verify(token) {
      if (typeof token !== 'string' || token.length > 4096) return null;
      const dot = token.indexOf('.');
      if (dot < 1) return null;
      const payload = token.slice(0, dot);
      const given = Buffer.from(token.slice(dot + 1), 'base64url');
      const want = sign(payload);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
      try {
        const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return typeof o.u === 'string' ? o.u : null;
      } catch (_) { return null; }
    },
  };
}

// ---- login throttling -------------------------------------------------------
// Keyed per client, sliding window. In memory; a restart forgives everyone,
// which is an acceptable trade for not persisting anything extra.

function makeThrottle(limit = 8, windowMs = 60000) {
  const hits = new Map();
  return {
    check(key) {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (arr.length >= limit) {
        hits.set(key, arr);
        return false;
      }
      arr.push(now);
      hits.set(key, arr);
      if (hits.size > 5000) {                       // bound the map
        for (const [k, v] of hits) {
          if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
        }
      }
      return true;
    },
    clear(key) { hits.delete(key); },
  };
}

function validateCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return 'Username must be 2-24 characters: letters, numbers, dot, dash or underscore.';
  }
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return `Password must be at least ${PASSWORD_MIN} characters.`;
  }
  return null;
}

module.exports = {
  hashPassword, verifyPassword, loadSecret, makeTokens, makeThrottle,
  validateCredentials, USERNAME_RE,
};
