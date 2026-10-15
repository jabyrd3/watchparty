'use strict';
// User store. Deliberately holds nothing but usernames and password hashes --
// no chat content, no timestamps, no session records. Chat messages live only
// in memory (see chat.js) and are never written here.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function open(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'users.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,   -- lowercased, the identity key
      display  TEXT NOT NULL,      -- same name with the casing the user typed
      pw_hash  TEXT NOT NULL
    )
  `);

  const qGet    = db.prepare('SELECT username, display, pw_hash FROM users WHERE username = ?');
  const qInsert = db.prepare('INSERT INTO users (username, display, pw_hash) VALUES (?, ?, ?)');
  const qCount  = db.prepare('SELECT COUNT(*) AS n FROM users');

  return {
    getUser(usernameLc) {
      return qGet.get(usernameLc) || null;
    },
    createUser(usernameLc, display, hash) {
      qInsert.run(usernameLc, display, hash);
    },
    countUsers() {
      return qCount.get().n;
    },
    close() { db.close(); },
  };
}

module.exports = { open };
