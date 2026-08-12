import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'scholar-transit.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

// Lightweight migration for DBs created before this column existed — CREATE TABLE IF NOT EXISTS
// won't add it to an already-existing table, so patch it in directly.
try {
  db.exec('ALTER TABLE routes ADD COLUMN delay_alert_threshold_minutes INTEGER NOT NULL DEFAULT 5');
} catch {
  // already present
}

export function getBusiness() {
  return db.prepare('SELECT * FROM business WHERE id = 1').get();
}

export function trialStatus(business = getBusiness()) {
  if (!business) return null;
  const started = new Date(business.trial_started_at);
  const daysElapsed = Math.floor((Date.now() - started.getTime()) / 86400000);
  const daysLeft = Math.max(0, business.trial_days - daysElapsed);
  const expired = daysElapsed >= business.trial_days && business.subscription_status === 'trial';
  return { daysElapsed, daysLeft, expired, status: business.subscription_status };
}
