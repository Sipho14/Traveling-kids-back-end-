import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'scholar-transit.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// If a business table already exists from the old single-business version (id locked to 1),
// move it aside so the fresh multi-business schema can be created, then copy its one row over.
const existingBusinessTable = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='business'").get();
const needsBusinessMigration = existingBusinessTable && existingBusinessTable.sql.includes('CHECK');
if (needsBusinessMigration) {
  db.exec('ALTER TABLE business RENAME TO business_old_singleton;');
}

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

if (needsBusinessMigration) {
  db.exec(`
    INSERT INTO business (id, name, owner_email, owner_password_hash, whatsapp_display_number,
      trial_started_at, trial_days, subscription_status, stripe_customer_id, stripe_subscription_id,
      created_at, email_verified)
    SELECT id, name, owner_email, owner_password_hash, whatsapp_display_number,
      trial_started_at, trial_days, subscription_status, stripe_customer_id, stripe_subscription_id,
      created_at, 1
    FROM business_old_singleton;
  `);
  db.exec('DROP TABLE business_old_singleton;');
}

// Lightweight migrations for columns added after initial deploy — CREATE TABLE IF NOT EXISTS
// won't add columns to an already-existing table, so patch them in directly.
const columnMigrations = [
  ['routes', 'delay_alert_threshold_minutes', 'INTEGER NOT NULL DEFAULT 5'],
  ['parents', 'business_id', 'INTEGER REFERENCES business(id)'],
  ['drivers', 'business_id', 'INTEGER REFERENCES business(id)'],
  ['vehicles', 'business_id', 'INTEGER REFERENCES business(id)'],
  ['routes', 'business_id', 'INTEGER REFERENCES business(id)'],
  ['alerts', 'business_id', 'INTEGER REFERENCES business(id)'],
  ['business', 'contact_name', 'TEXT'],
  ['business', 'contact_surname', 'TEXT'],
  ['business', 'contact_phone', 'TEXT'],
  ['business', 'company_name', 'TEXT'],
  ['business', 'company_address', 'TEXT'],
  ['business', 'plan_tier', "TEXT NOT NULL DEFAULT 'starter'"],
  ['business', 'student_limit', 'INTEGER NOT NULL DEFAULT 20'],
  ['business', 'price_cents', 'INTEGER NOT NULL DEFAULT 85000'],
  ['business', 'email_verified', 'INTEGER NOT NULL DEFAULT 0'],
  ['business', 'verification_code', 'TEXT'],
  ['business', 'verification_expires', 'TEXT'],
  ['business', 'reset_code', 'TEXT'],
  ['business', 'reset_code_expires', 'TEXT'],
  ['business', 'service_area', 'TEXT'],
  ['parents', 'unique_id', 'TEXT'],
  ['parents', 'home_address', 'TEXT'],
  ['students', 'age', 'INTEGER'],
  ['students', 'school_address', 'TEXT'],
  ['students', 'dropoff_time', 'TEXT'],
  ['students', 'allergies', 'TEXT'],
  ['students', 'medical_conditions', 'TEXT'],
  ['students', 'medication', 'TEXT'],
  ['students', 'emergency_contact_name', 'TEXT'],
  ['students', 'emergency_contact_phone', 'TEXT'],
  ['students', 'monthly_payment_cents', 'INTEGER'],
  ['students', 'payment_due_day', 'INTEGER'],
  ['students', 'payment_method', 'TEXT'],
  ['trips', 'current_lat', 'REAL'],
  ['trips', 'current_lng', 'REAL'],
  ['trips', 'location_updated_at', 'TEXT']
];
for (const [table, column, type] of columnMigrations) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch {
    // already present
  }
}

// Backfill unique IDs for parents that predate this feature (e.g. from seeding).
const parentsNeedingIds = db.prepare('SELECT id FROM parents WHERE unique_id IS NULL').all();
for (const p of parentsNeedingIds) {
  let id;
  do {
    id = `TK-${crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4)}`;
  } while (db.prepare('SELECT 1 FROM parents WHERE unique_id = ?').get(id));
  db.prepare('UPDATE parents SET unique_id = ? WHERE id = ?').run(id, p.id);
}

// Safe to add only after the column itself is guaranteed to exist (see migrations above).
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_parents_unique_id ON parents(unique_id)');
} catch {
  // pre-existing
}

// Backfill business_id on rows created before multi-business support existed, so
// nothing pre-existing becomes orphaned/invisible under the new scoping.
const firstBusiness = db.prepare('SELECT id FROM business ORDER BY id LIMIT 1').get();
if (firstBusiness) {
  for (const table of ['parents', 'drivers', 'vehicles', 'routes', 'alerts']) {
    db.prepare(`UPDATE ${table} SET business_id = ? WHERE business_id IS NULL`).run(firstBusiness.id);
  }
}

export function getBusinessById(id) {
  return db.prepare('SELECT * FROM business WHERE id = ?').get(id);
}

export function getBusinessByEmail(email) {
  return db.prepare('SELECT * FROM business WHERE owner_email = ?').get(email);
}

export function trialStatus(business) {
  if (!business) return null;
  const started = new Date(business.trial_started_at);
  const daysElapsed = Math.floor((Date.now() - started.getTime()) / 86400000);
  const daysLeft = Math.max(0, business.trial_days - daysElapsed);
  const expired = daysElapsed >= business.trial_days && business.subscription_status === 'trial';
  return { daysElapsed, daysLeft, expired, status: business.subscription_status };
}
