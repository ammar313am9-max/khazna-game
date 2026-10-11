'use strict';

/**
 * قاعدة البيانات: SQLite المدمجة في Node (node:sqlite) — لا تحتاج أي حزم خارجية.
 * الملف يُنشأ تلقائياً في مجلد data/ عند أول تشغيل.
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  username          TEXT    NOT NULL UNIQUE,
  username_key      TEXT    NOT NULL UNIQUE,
  password_hash     TEXT    NOT NULL,
  referral_code     TEXT    NOT NULL UNIQUE,
  referred_by       INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  referral_bonus    INTEGER NOT NULL DEFAULT 0,
  guesses_used      INTEGER NOT NULL DEFAULT 0,
  wins              INTEGER NOT NULL DEFAULT 0,
  total_purchased   INTEGER NOT NULL DEFAULT 0,
  session_epoch     INTEGER NOT NULL DEFAULT 0,
  created_ip        TEXT    NOT NULL DEFAULT '',
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vault (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  code_cipher  TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  open_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS guesses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guess        TEXT    NOT NULL,
  is_correct   INTEGER NOT NULL DEFAULT 0,
  exact_digits INTEGER NOT NULL DEFAULT 0,
  other_digits INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  reference     TEXT    NOT NULL UNIQUE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempts      INTEGER NOT NULL,
  amount_usd    REAL    NOT NULL,
  method        TEXT    NOT NULL,
  payer_note    TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'pending',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  reviewed_at   TEXT    NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_referral   ON users(referral_code);
CREATE INDEX IF NOT EXISTS idx_guesses_user     ON guesses(user_id, id);
CREATE INDEX IF NOT EXISTS idx_orders_status    ON orders(status, created_at);
`;

/** أعمدة أُضيفت لاحقاً: تُهاجر تلقائياً على قواعد بيانات قديمة موجودة. */
const MIGRATIONS = [
  ['users', 'created_ip', "TEXT NOT NULL DEFAULT ''"],
  ['users', 'session_epoch', 'INTEGER NOT NULL DEFAULT 0'],
];

function init() {
  db.exec(SCHEMA);
  for (const [table, column, definition] of MIGRATIONS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

function get(sql, ...params) {
  return db.prepare(sql).get(...params) ?? null;
}

function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

function run(sql, ...params) {
  const result = db.prepare(sql).run(...params);
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
}

/** معاملة واحدة: كل أمر داخلها ينجح كاملاً أو يتراجع كاملاً (حماية عدّاد المحاولات). */
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* تجاهل فشل التراجع بعد انقطاع الاتصال */
    }
    throw error;
  }
}

function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    String(value)
  );
}

function close() {
  db.close();
}

module.exports = { db, SCHEMA, init, get, all, run, transaction, getSetting, setSetting, close };
