import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DATA_DIR } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'prices.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS parts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  brand       TEXT,
  model       TEXT,
  spec        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS listings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id   TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  retailer  TEXT NOT NULL,
  asin      TEXT,
  sku       TEXT,
  query     TEXT,
  alt_query TEXT,
  url       TEXT,
  allow_html INTEGER NOT NULL DEFAULT 0,
  UNIQUE (part_id, retailer)
);

-- One row per observation. Never updated, only appended.
CREATE TABLE IF NOT EXISTS price_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id     TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  retailer    TEXT NOT NULL,
  source      TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'USD',
  in_stock    INTEGER NOT NULL DEFAULT 1,
  url         TEXT,
  observed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_price_part_time ON price_history (part_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_part_retailer ON price_history (part_id, retailer, observed_at DESC);

-- Discovered alternatives per part. A snapshot, not a history: a refresh
-- replaces a part's rows wholesale, which is what keeps the API cost down.
CREATE TABLE IF NOT EXISTS alternatives (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id       TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  asin          TEXT NOT NULL,
  title         TEXT NOT NULL,
  brand         TEXT,
  price_cents   INTEGER,
  currency      TEXT NOT NULL DEFAULT 'USD',
  url           TEXT,
  image_url     TEXT,
  rating        REAL,
  ratings_total INTEGER,
  discovered_at TEXT NOT NULL,
  UNIQUE (part_id, asin)
);

CREATE INDEX IF NOT EXISTS idx_alternatives_part ON alternatives (part_id, price_cents);

CREATE TABLE IF NOT EXISTS fetch_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  trigger      TEXT NOT NULL,
  sources      TEXT,
  observations INTEGER NOT NULL DEFAULT 0,
  errors       TEXT
);
`);

export const nowIso = () => new Date().toISOString();

export function toCents(value) {
  return Math.round(Number(value) * 100);
}

export function fromCents(cents) {
  return cents == null ? null : cents / 100;
}
