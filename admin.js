import { Router } from 'express';
import { db, getBusiness, trialStatus } from '../db/index.js';
import { requireAuth } from './auth.js';
import { ensureDriverToken, getTripWithStops, reorderStops, reassignStop } from '../services/logistics.js';
import { sendText } from '../services/whatsapp.js';
import { diagnoseTrip } from '../services/diagnostics.js';

export const adminRouter = Router();
adminRouter.use(requireAuth);

// ---- Dashboard overview ----
adminRouter.get('/overview', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const activeTripsToday = db.prepare(
    "SELECT COUNT(*) c FROM trips WHERE service_date = ? AND status IN ('scheduled','in_progress')"
  ).get(today).c;
  const studentsCount = db.prepare('SELECT COUNT(*) c FROM students WHERE active = 1').get().c;
  const driversCount = db.prepare('SELECT COUNT(*) c FROM drivers WHERE active = 1').get().c;
  const openAlerts = db.prepare('SELECT COUNT(*) c FROM alerts WHERE resolved = 0').get().c;
  const revenueThisMonth = db.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE status = 'paid' AND strftime('%Y-%m', paid_at) = strftime('%Y-%m','now')"
  ).get().s;

  res.json({
    trial: trialStatus(),
    activeTripsToday,
    studentsCount,
    driversCount,
    openAlerts,
    revenueThisMonthCents: revenueThisMonth
  });
});

// ---- Students ----
adminRouter.get('/students', (req, res) => {
  res.json(db.prepare(`
    SELECT s.*, p.whatsapp_number, p.name as parent_name, r.name as route_name
    FROM students s JOIN parents p ON p.id = s.parent_id
    LEFT JOIN routes r ON r.id = s.route_id
    ORDER BY s.created_at DESC`).all());
});

adminRouter.post('/students', (req, res) => {
  const { parent_whatsapp, parent_name, name, school, grade, pickup_address, dropoff_address, route_id } = req.body;
  let parent = db.prepare('SELECT * FROM parents WHERE whatsapp_number = ?').get(parent_whatsapp);
  if (!parent) {
    const info = db.prepare('INSERT INTO parents (whatsapp_number, name) VALUES (?, ?)').run(parent_whatsapp, parent_name);
    parent = db.prepare('SELECT * FROM parents WHERE id = ?').get(info.lastInsertRowid);
  }
  const result = db.prepare(`
    INSERT INTO students (parent_id, name, school, grade, pickup_address, dropoff_address, route_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(parent.id, name, school, grade, pickup_address, dropoff_address, route_id || null);
  res.json({ id: result.lastInsertRowid });
});

// ---- Drivers & Vehicles ----
adminRouter.get('/drivers', (req, res) => {
  res.json(db.prepare(`
    SELECT d.*, v.plate_number, v.model FROM drivers d LEFT JOIN vehicles v ON v.id = d.vehicle_id
    ORDER BY d.created_at DESC`).all());
});
adminRouter.post('/drivers', (req, res) => {
  const { name, phone, license_number, vehicle_id } = req.body;
  const result = db.prepare('INSERT INTO drivers (name, phone, license_number, vehicle_id) VALUES (?, ?, ?, ?)')
    .run(name, phone, license_number, vehicle_id || null);
  res.json({ id: result.lastInsertRowid });
});

adminRouter.get('/vehicles', (req, res) => res.json(db.prepare('SELECT * FROM vehicles ORDER BY created_at DESC').all()));
adminRouter.post('/vehicles', (req, res) => {
  const { plate_number, model, capacity } = req.body;
  const result = db.prepare('INSERT INTO vehicles (plate_number, model, capacity) VALUES (?, ?, ?)').run(plate_number, model, capacity);
  res.json({ id: result.lastInsertRowid });
});

// ---- Routes ----
adminRouter.get('/routes', (req, res) => {
  res.json(db.prepare(`
    SELECT r.*, d.name as driver_name FROM routes r LEFT JOIN drivers d ON d.id = r.driver_id
    ORDER BY r.created_at DESC`).all());
});
adminRouter.post('/routes', (req, res) => {
  const { name, description, driver_id, morning_time, afternoon_time, delay_alert_threshold_minutes } = req.body;
  const result = db.prepare(`
    INSERT INTO routes (name, description, driver_id, morning_time, afternoon_time, delay_alert_threshold_minutes)
    VALUES (?, ?, ?, ?, ?, ?)`).run(name, description, driver_id || null, morning_time, afternoon_time, delay_alert_threshold_minutes || 5);
  res.json({ id: result.lastInsertRowid });
});

adminRouter.patch('/routes/:id', (req, res) => {
  const { delay_alert_threshold_minutes } = req.body;
  if (delay_alert_threshold_minutes !== undefined) {
    db.prepare('UPDATE routes SET delay_alert_threshold_minutes = ? WHERE id = ?')
      .run(delay_alert_threshold_minutes, req.params.id);
  }
  res.json({ ok: true });
});

// ---- Live trips ----
adminRouter.get('/trips', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  res.json(db.prepare(`
    SELECT t.*, r.name as route_name, d.name as driver_name, d.phone as driver_phone,
      (SELECT COUNT(*) FROM bookings b WHERE b.trip_id = t.id AND b.status != 'canceled') as booked_count,
      (SELECT COUNT(*) FROM stops st WHERE st.trip_id = t.id AND st.status = 'delayed') as delayed_stops,
      (SELECT COUNT(*) FROM stops st WHERE st.trip_id = t.id AND st.status = 'no_show') as no_show_stops,
      (SELECT COUNT(*) FROM stops st WHERE st.trip_id = t.id AND st.status = 'picked_up') as picked_up_stops
    FROM trips t JOIN routes r ON r.id = t.route_id LEFT JOIN drivers d ON d.id = r.driver_id
    WHERE t.service_date = ? ORDER BY t.leg`).all(date));
});

// Full stop-by-stop timeline for one trip — the "logistics view" of a single run.
adminRouter.get('/trips/:id', (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'Not found' });
  res.json(getTripWithStops(trip));
});

// Other trips running the same service date — candidates to reassign a stop into
// (e.g. a vehicle breaks down and its riders need to shift onto another driver's run).
adminRouter.get('/trips/:id/reassign-candidates', (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'Not found' });
  const candidates = db.prepare(`
    SELECT t.id, t.leg, r.name as route_name FROM trips t JOIN routes r ON r.id = t.route_id
    WHERE t.service_date = ? AND t.id != ? AND t.status != 'canceled'`).all(trip.service_date, trip.id);
  res.json(candidates);
});

// Owner drags stops into a new order in the dashboard, then saves — reindexes
// sequence/offsets and refreshes ETAs for anything still pending.
adminRouter.patch('/trips/:id/stops/reorder', (req, res) => {
  const { stop_ids } = req.body;
  if (!Array.isArray(stop_ids) || stop_ids.length === 0) return res.status(400).json({ error: 'stop_ids required' });
  res.json(reorderStops(req.params.id, stop_ids));
});

adminRouter.patch('/stops/:id/reassign', (req, res) => {
  const { trip_id } = req.body;
  if (!trip_id) return res.status(400).json({ error: 'trip_id required' });
  try {
    res.json(reassignStop(req.params.id, trip_id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Sends the driver a one-tap WhatsApp link to their live stop list for this trip.
adminRouter.post('/trips/:id/send-driver-link', async (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'Not found' });
  const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(trip.route_id);
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(route.driver_id);
  if (!driver?.phone) return res.status(400).json({ error: 'This route has no driver phone number on file.' });

  const token = ensureDriverToken(trip);
  const url = `${process.env.APP_URL}/driver.html?token=${token}`;
  await sendText(driver.phone, `Your ${trip.leg} run for ${route.name} is ready. Open your stop list: ${url}`);
  res.json({ ok: true, url });
});

// AI-generated diagnosis + suggestions for a problem trip (delays, no-shows, etc.)
adminRouter.post('/trips/:id/suggest', async (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'Not found' });
  const result = await diagnoseTrip(trip.id);
  res.json(result);
});

adminRouter.patch('/trips/:id', (req, res) => {
  const { status, current_lat, current_lng, eta_minutes } = req.body;
  const fields = [];
  const values = [];
  if (status) { fields.push('status = ?'); values.push(status); }
  if (current_lat !== undefined) { fields.push('current_lat = ?'); values.push(current_lat); }
  if (current_lng !== undefined) { fields.push('current_lng = ?'); values.push(current_lng); }
  if (eta_minutes !== undefined) { fields.push('eta_minutes = ?'); values.push(eta_minutes); }
  if (status === 'in_progress') fields.push("started_at = datetime('now')");
  if (status === 'completed') fields.push("completed_at = datetime('now')");
  values.push(req.params.id);
  db.prepare(`UPDATE trips SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

// ---- Alerts / conversations needing a human ----
adminRouter.get('/alerts', (req, res) => {
  res.json(db.prepare('SELECT * FROM alerts ORDER BY resolved ASC, created_at DESC').all());
});
adminRouter.patch('/alerts/:id/resolve', (req, res) => {
  db.prepare('UPDATE alerts SET resolved = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

adminRouter.get('/conversations/escalated', (req, res) => {
  res.json(db.prepare(`
    SELECT m.*, p.whatsapp_number, p.name as parent_name FROM messages m
    JOIN parents p ON p.id = m.parent_id
    WHERE m.needs_human = 1 ORDER BY m.created_at DESC LIMIT 50`).all());
});

// ---- Billing / reports ----
adminRouter.get('/billing/overview', (req, res) => {
  const business = getBusiness();
  const monthly = db.prepare(`
    SELECT strftime('%Y-%m', paid_at) as month, SUM(amount_cents) as total_cents, COUNT(*) as count
    FROM payments WHERE status = 'paid' GROUP BY month ORDER BY month DESC LIMIT 12`).all();
  const outstanding = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE status = 'pending'`).get().s;
  res.json({
    trial: trialStatus(business),
    subscriptionStatus: business.subscription_status,
    pricePerSeatCents: business.price_per_seat_cents,
    monthly,
    outstandingCents: outstanding
  });
});

adminRouter.get('/payments', (req, res) => {
  res.json(db.prepare(`
    SELECT pay.*, par.whatsapp_number, s.name as student_name FROM payments pay
    JOIN parents par ON par.id = pay.parent_id LEFT JOIN students s ON s.id = pay.student_id
    ORDER BY pay.created_at DESC LIMIT 100`).all());
});
