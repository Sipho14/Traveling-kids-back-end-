-- Scholar Transit: core schema
-- One business (owner) per deployment for the prototype; multi-tenant-ready via business_id.

CREATE TABLE IF NOT EXISTS business (
  id INTEGER PRIMARY KEY CHECK (id = 1), -- singleton row for the prototype
  name TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  owner_password_hash TEXT NOT NULL,
  whatsapp_display_number TEXT,
  trial_started_at TEXT NOT NULL,
  trial_days INTEGER NOT NULL DEFAULT 30,
  subscription_status TEXT NOT NULL DEFAULT 'trial', -- trial | active | past_due | canceled
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  price_per_seat_cents INTEGER DEFAULT 5000,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS parents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_number TEXT UNIQUE NOT NULL,
  name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER NOT NULL REFERENCES parents(id),
  name TEXT NOT NULL,
  school TEXT,
  grade TEXT,
  pickup_address TEXT,
  dropoff_address TEXT,
  route_id INTEGER REFERENCES routes(id),
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  license_number TEXT,
  vehicle_id INTEGER REFERENCES vehicles(id),
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plate_number TEXT NOT NULL,
  model TEXT,
  capacity INTEGER,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  driver_id INTEGER REFERENCES drivers(id),
  morning_time TEXT, -- e.g. '06:30'
  afternoon_time TEXT, -- e.g. '14:30'
  delay_alert_threshold_minutes INTEGER NOT NULL DEFAULT 5, -- how big a delay must be before downstream parents are pinged
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- A trip is one scheduled run of a route on a given day (morning or afternoon leg)
CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id INTEGER NOT NULL REFERENCES routes(id),
  service_date TEXT NOT NULL, -- YYYY-MM-DD
  leg TEXT NOT NULL CHECK (leg IN ('morning','afternoon')),
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | in_progress | completed | canceled
  started_at TEXT,
  completed_at TEXT,
  current_lat REAL,
  current_lng REAL,
  eta_minutes INTEGER,
  driver_access_token TEXT UNIQUE, -- lets the driver open their trip page with no login
  cumulative_delay_minutes INTEGER DEFAULT 0, -- running delay, propagated forward across stops
  created_at TEXT DEFAULT (datetime('now'))
);

-- A booking links a student to a specific trip, and tracks pickup/dropoff confirmation
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  status TEXT NOT NULL DEFAULT 'booked', -- booked | picked_up | dropped_off | canceled | no_show
  booked_via TEXT DEFAULT 'whatsapp',
  created_at TEXT DEFAULT (datetime('now'))
);

-- One row per student per trip: the actual logistics unit the driver acts on.
-- This is what turns "trip status" into a real stop-by-stop route.
CREATE TABLE IF NOT EXISTS stops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  sequence INTEGER NOT NULL, -- order along the route, 1-based
  scheduled_offset_minutes INTEGER NOT NULL DEFAULT 0, -- minutes after route leg start time
  status TEXT NOT NULL DEFAULT 'pending',
    -- pending | awaiting | arrived | delayed | picked_up | skipped | no_show
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  delay_reason TEXT,
  eta_at TEXT, -- computed ISO timestamp estimate, recalculated as delays occur
  arrived_at TEXT,
  picked_up_at TEXT,
  parent_notified_for_delay INTEGER NOT NULL DEFAULT 0, -- avoids double-alerting for the same delay
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER NOT NULL REFERENCES parents(id),
  student_id INTEGER REFERENCES students(id),
  amount_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed | refunded
  stripe_checkout_session_id TEXT,
  period_label TEXT, -- e.g. 'March 2026'
  created_at TEXT DEFAULT (datetime('now')),
  paid_at TEXT
);

-- Full log of every WhatsApp message in/out, plus which AI action it triggered.
-- This is what the control center's "conversations" / support view reads from.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES parents(id),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  body TEXT,
  ai_action TEXT, -- e.g. 'book_ride', 'track_ride', 'support_escalation'
  needs_human INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL, -- 'delay' | 'no_show' | 'payment_failed' | 'support_escalation' | 'vehicle_issue' | 'stop_delay' | 'stop_no_show'
  message TEXT NOT NULL,
  related_trip_id INTEGER,
  resolved INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Cached AI-generated diagnosis for a problem trip, so the dashboard doesn't
-- re-call Claude every time the owner reopens the same trip.
CREATE TABLE IF NOT EXISTS trip_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  diagnosis TEXT NOT NULL,
  suggestions TEXT NOT NULL, -- JSON array of strings
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_students_parent ON students(parent_id);
CREATE INDEX IF NOT EXISTS idx_bookings_trip ON bookings(trip_id);
CREATE INDEX IF NOT EXISTS idx_trips_date ON trips(service_date);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_stops_trip ON stops(trip_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stops_trip_student ON stops(trip_id, student_id);
