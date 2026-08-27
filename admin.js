import { Router } from 'express';
import { db, getBusinessById, trialStatus } from './db.js';
import { requireAuth } from './auth.js';
import { ensureDriverToken, getTripWithStops, reorderStops, reassignStop } from './logistics.js';
import { sendText } from './whatsapp.js';
import { diagnoseTrip } from './diagnostics.js';
import { generateUniqueId } from './uniqueId.js';

export const adminRouter = Router();
adminRouter.use(requireAuth);

// ---- Dashboard overview ----
adminRouter.get('/overview', (req, res) => {
  const bizId = req.auth.businessId;
  const today = new Date().toISOString().slice(0, 10);
  const activeTripsToday = db.prepare(`
    SELECT COUNT(*) c FROM trips t JOIN routes r ON r.id = t.route_id
    WHERE r.business_id = ? AND t.service_date = ? AND t.status IN ('scheduled','in_progress')`
  ).get(bizId, today).c;
  const studentsCount = db.prepare(`
    SELECT COUNT(*) c FROM students s JOIN parents p ON p.id = s.parent_id
    WHERE p.business_id = ? AND s.active = 1`).get(bizId).c;
  const driversCount = db.prepare('SELECT COUNT(*) c FROM drivers WHERE business_id = ? AND active = 1').get(bizId).c;
  const openAlerts = db.prepare('SELECT COUNT(*) c FROM alerts WHERE business_id = ? AND resolved = 0').get(bizId).c;
  const revenueThisMonth = db.prepare(`
    SELECT COALESCE(SUM(pay.amount_cents),0) s FROM payments pay JOIN parents p ON p.id = pay.parent_id
    WHERE p.business_id = ? AND pay.status = 'paid' AND strftime('%Y-%m', pay.paid_at) = strftime('%Y-%m','now')`
  ).get(bizId).s;

  res.json({
    trial: trialStatus(getBusinessById(bizId)),
    activeTripsToday,
    studentsCount,
    driversCount,
    openAlerts,
    revenueThisMonthCents: revenueThisMonth
  });
});

// ---- Business profile (owner-editable) ----
adminRouter.get('/profile', (req, res) => {
  const b = getBusinessById(req.auth.businessId);
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json({
    id: b.id,
    name: b.name,
    email: b.owner_email,
    contactName: b.contact_name,
    contactSurname: b.contact_surname,
    contactPhone: b.contact_phone,
    companyAddress: b.company_address,
    planTier: b.plan_tier
  });
});

adminRouter.patch('/profile', (req, res) => {
  const { name, contactName, contactSurname, contactPhone, companyAddress } = req.body;
  const fields = [];
  const values = [];
  if (name) { fields.push('name = ?', 'company_name = ?'); values.push(name, name); }
  if (contactName) { fields.push('contact_name = ?'); values.push(contactName); }
  if (contactSurname) { fields.push('contact_surname = ?'); values.push(contactSurname); }
  if (contactPhone) { fields.push('contact_phone = ?'); values.push(contactPhone); }
  if (companyAddress !== undefined) { fields.push('company_address = ?'); values.push(companyAddress); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  values.push(req.auth.businessId);
  db.prepare(`UPDATE business SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

// Latest profile photo, if one was uploaded via the documents endpoint (category='profile').
adminRouter.get('/profile-photo', (req, res) => {
  const doc = db.prepare(`
    SELECT file_data, mime_type FROM documents
    WHERE business_id = ? AND category = 'profile' ORDER BY created_at DESC LIMIT 1`
  ).get(req.auth.businessId);
  res.json({ fileData: doc?.file_data || null, mimeType: doc?.mime_type || null });
});

// ---- Students ----
adminRouter.get('/students', (req, res) => {
  res.json(db.prepare(`
    SELECT s.*, p.whatsapp_number, p.name as parent_name, p.unique_id, p.home_address, r.name as route_name
    FROM students s JOIN parents p ON p.id = s.parent_id
    LEFT JOIN routes r ON r.id = s.route_id
    WHERE p.business_id = ?
    ORDER BY s.created_at DESC`).all(req.auth.businessId));
});

adminRouter.post('/students', async (req, res) => {
  const bizId = req.auth.businessId;
  const {
    parent_whatsapp, parent_name, home_address,
    name, age, grade, school, school_address, pickup_address, dropoff_address, dropoff_time,
    allergies, medical_conditions, medication, emergency_contact_name, emergency_contact_phone,
    monthly_payment_cents, payment_due_day, payment_method, route_id
  } = req.body;

  if (!parent_whatsapp || !name || !dropoff_time) {
    return res.status(400).json({ error: 'Parent WhatsApp number, student name, and drop-off time are required.' });
  }

  let parent = db.prepare('SELECT * FROM parents WHERE whatsapp_number = ? AND business_id = ?').get(parent_whatsapp, bizId);
  if (!parent) {
    const info = db.prepare('INSERT INTO parents (business_id, whatsapp_number, name, home_address, unique_id) VALUES (?, ?, ?, ?, ?)')
      .run(bizId, parent_whatsapp, parent_name || null, home_address || null, generateUniqueId());
    parent = db.prepare('SELECT * FROM parents WHERE id = ?').get(info.lastInsertRowid);
  }

  const result = db.prepare(`
    INSERT INTO students (
      parent_id, name, age, grade, school, school_address, pickup_address, dropoff_address, dropoff_time,
      allergies, medical_conditions, medication, emergency_contact_name, emergency_contact_phone,
      monthly_payment_cents, payment_due_day, payment_method, route_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    parent.id, name, age || null, grade || null, school || null, school_address || null,
    pickup_address || null, dropoff_address || null, dropoff_time,
    allergies || null, medical_conditions || null, medication || null,
    emergency_contact_name || null, emergency_contact_phone || null,
    monthly_payment_cents || null, payment_due_day || null, payment_method || null, route_id || null
  );

  // Confirmation receipt to the parent, referencing their tracking ID.
  try {
    await sendText(parent_whatsapp,
      `Welcome to Scholar Transit! ${name} has been registered for pickup at ${dropoff_time}. ` +
      `Your reference ID is ${parent.unique_id} — mention this any time you message us so we can find your account fast.`
    );
  } catch (err) {
    console.error('Registration receipt send failed:', err.message);
  }

  res.json({ id: result.lastInsertRowid, parentUniqueId: parent.unique_id });
});

// ---- Live GPS: today's active trips with their last known position ----
adminRouter.get('/live-locations', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.json(db.prepare(`
    SELECT t.id as trip_id, t.leg, t.status, t.current_lat, t.current_lng, t.location_updated_at,
      r.name as route_name, d.name as driver_name
    FROM trips t JOIN routes r ON r.id = t.route_id LEFT JOIN drivers d ON d.id = r.driver_id
    WHERE r.business_id = ? AND t.service_date = ? AND t.status = 'in_progress' AND t.current_lat IS NOT NULL`
  ).all(req.auth.businessId, today));
});

// ---- Drivers & Vehicles ----
adminRouter.get('/drivers', (req, res) => {
  res.json(db.prepare(`
    SELECT d.*, v.plate_number, v.model FROM drivers d LEFT JOIN vehicles v ON v.id = d.vehicle_id
    WHERE d.business_id = ? AND d.active = 1 ORDER BY d.created_at DESC`).all(req.auth.businessId));
});
adminRouter.post('/drivers', (req, res) => {
  const { name, phone, license_number, vehicle_id } = req.body;
  const result = db.prepare('INSERT INTO drivers (business_id, name, phone, license_number, vehicle_id) VALUES (?, ?, ?, ?, ?)')
    .run(req.auth.businessId, name, phone, license_number, vehicle_id || null);
  res.json({ id: result.lastInsertRowid });
});
adminRouter.delete('/drivers/:id', (req, res) => {
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ? AND business_id = ?').get(req.params.id, req.auth.businessId);
  if (!driver) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE drivers SET active = 0 WHERE id = ?').run(driver.id);
  db.prepare('UPDATE routes SET driver_id = NULL WHERE driver_id = ?').run(driver.id);
  db.prepare('UPDATE staff SET driver_record_id = NULL WHERE driver_record_id = ?').run(driver.id);
  res.json({ ok: true });
});

adminRouter.get('/vehicles', (req, res) =>
  res.json(db.prepare('SELECT * FROM vehicles WHERE business_id = ? AND active = 1 ORDER BY created_at DESC').all(req.auth.businessId)));
adminRouter.post('/vehicles', (req, res) => {
  const { plate_number, model, capacity } = req.body;
  const result = db.prepare('INSERT INTO vehicles (business_id, plate_number, model, capacity) VALUES (?, ?, ?, ?)')
    .run(req.auth.businessId, plate_number, model, capacity);
  res.json({ id: result.lastInsertRowid });
});
adminRouter.delete('/vehicles/:id', (req, res) => {
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ? AND business_id = ?').get(req.params.id, req.auth.businessId);
  if (!vehicle) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE vehicles SET active = 0 WHERE id = ?').run(vehicle.id);
  db.prepare('UPDATE drivers SET vehicle_id = NULL WHERE vehicle_id = ?').run(vehicle.id);
  db.prepare('UPDATE staff SET assigned_vehicle_id = NULL WHERE assigned_vehicle_id = ?').run(vehicle.id);
  res.json({ ok: true });
});

// ---- Routes ----
adminRouter.get('/routes', (req, res) => {
  res.json(db.prepare(`
    SELECT r.*, d.name as driver_name FROM routes r LEFT JOIN drivers d ON d.id = r.driver_id
    WHERE r.business_id = ? ORDER BY r.created_at DESC`).all(req.auth.businessId));
});
adminRouter.post('/routes', (req, res) => {
  const { name, description, driver_id, morning_time, afternoon_time, delay_alert_threshold_minutes } = req.body;
  const result = db.prepare(`
    INSERT INTO routes (business_id, name, description, driver_id, morning_time, afternoon_time, delay_alert_threshold_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.auth.businessId, name, description, driver_id || null, morning_time, afternoon_time, delay_alert_threshold_minutes || 5);
  res.json({ id: result.lastInsertRowid });
});

adminRouter.patch('/routes/:id', (req, res) => {
  const route = db.prepare('SELECT * FROM routes WHERE id = ? AND business_id = ?').get(req.params.id, req.auth.businessId);
  if (!route) return res.status(404).json({ error: 'Not found' });
  const { delay_alert_threshold_minutes } = req.body;
  if (delay_alert_threshold_minutes !== undefined) {
    db.prepare('UPDATE routes SET delay_alert_threshold_minutes = ? WHERE id = ?').run(delay_alert_threshold_minutes, req.params.id);
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
    WHERE r.business_id = ? AND t.service_date = ? ORDER BY t.leg`).all(req.auth.businessId, date));
});

// Ownership check used by every single-trip route below.
function ownedTrip(tripId, businessId) {
  return db.prepare(`
    SELECT t.* FROM trips t JOIN routes r ON r.id = t.route_id
    WHERE t.id = ? AND r.business_id = ?`).get(tripId, businessId);
}

adminRouter.get('/trips/:id', (req, res) => {
  const trip = ownedTrip(req.params.id, req.auth.businessId);
  if (!trip) return res.status(404).json({ error: 'Not found' });
  res.json(getTripWithStops(trip));
});

adminRouter.get('/trips/:id/reassign-candidates', (req, res) => {
  const trip = ownedTrip(req.params.id, req.auth.businessId);
  if (!trip) return res.status(404).json({ error: 'Not found' });
  const candidates = db.prepare(`
    SELECT t.id, t.leg, r.name as route_name FROM trips t JOIN routes r ON r.id = t.route_id
    WHERE r.business_id = ? AND t.service_date = ? AND t.id != ? AND t.status != 'canceled'`
  ).all(req.auth.businessId, trip.service_date, trip.id);
  res.json(candidates);
});

adminRouter.patch('/trips/:id/stops/reorder', (req, res) => {
  const trip = ownedTrip(req.params.id, req.auth.businessId);
  if (!trip) return res.status(404).json({ error: 'Not found' });
  const { stop_ids } = req.body;
  if (!Array.isArray(stop_ids) || stop_ids.length === 0) return res.status(400).json({ error: 'stop_ids required' });
  res.json(reorderStops(req.params.id, stop_ids));
});

adminRouter.patch('/stops/:id/reassign', (req, res) => {
  const { trip_id } = req.body;
  if (!trip_id) return res.status(400).json({ error: 'trip_id required' });
  if (!ownedTrip(trip_id, req.auth.businessId)) return res.status(404).json({ error: 'Destination trip not found' });
  try {
    res.json(reassignStop(req.params.id, trip_id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

adminRouter.post('/trips/:id/send-driver-link', async (req, res) => {
  const trip = ownedTrip(req.params.id, req.auth.businessId);
  if (!trip) return res.status(404).json({ error: 'Not found' });
  const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(trip.route_id);
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(route.driver_id);
  if (!driver?.phone) return res.status(400).json({ error: 'This route has no driver phone number on file.' });

  const token = ensureDriverToken(trip);
  const url = `${process.env.APP_URL}/driver.html?token=${token}`;
  await sendText(driver.phone, `Your ${trip.leg} run for ${route.name} is ready. Open your stop list: ${url}`);
  res.json({ ok: true, url });
});

adminRouter.post('/trips/:id/suggest', async (req, res) => {
  const trip = ownedTrip(req.params.id, req.auth.businessId);
  if (!trip) return res.status(404).json({ error: 'Not found' });
  const result = await diagnoseTrip(trip.id);
  res.json(result);
});

adminRouter.patch('/trips/:id', (req, res) => {
  const trip = ownedTrip(req.params.id, req.auth.businessId);
  if (!trip) return res.status(404).json({ error: 'Not found' });

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
  res.json(db.prepare('SELECT * FROM alerts WHERE business_id = ? ORDER BY resolved ASC, created_at DESC').all(req.auth.businessId));
});
adminRouter.patch('/alerts/:id/resolve', (req, res) => {
  db.prepare('UPDATE alerts SET resolved = 1 WHERE id = ? AND business_id = ?').run(req.params.id, req.auth.businessId);
  res.json({ ok: true });
});

adminRouter.get('/conversations/escalated', (req, res) => {
  res.json(db.prepare(`
    SELECT m.*, p.whatsapp_number, p.name as parent_name FROM messages m
    JOIN parents p ON p.id = m.parent_id
    WHERE p.business_id = ? AND m.needs_human = 1 ORDER BY m.created_at DESC LIMIT 50`).all(req.auth.businessId));
});

// ---- WhatsApp panel: every parent conversation, monitorable and manually replyable ----
adminRouter.get('/conversations', (req, res) => {
  res.json(db.prepare(`
    SELECT p.id as parent_id, p.unique_id, p.name as parent_name, p.whatsapp_number,
      (SELECT body FROM messages m WHERE m.parent_id = p.id ORDER BY m.id DESC LIMIT 1) as last_message,
      (SELECT created_at FROM messages m WHERE m.parent_id = p.id ORDER BY m.id DESC LIMIT 1) as last_message_at,
      (SELECT COUNT(*) FROM messages m WHERE m.parent_id = p.id AND m.needs_human = 1) as escalation_count
    FROM parents p
    WHERE p.business_id = ?
    ORDER BY last_message_at DESC`).all(req.auth.businessId));
});

adminRouter.get('/conversations/:parentId/messages', (req, res) => {
  const parent = db.prepare('SELECT * FROM parents WHERE id = ? AND business_id = ?').get(req.params.parentId, req.auth.businessId);
  if (!parent) return res.status(404).json({ error: 'Not found' });
  const messages = db.prepare('SELECT * FROM messages WHERE parent_id = ? ORDER BY id ASC').all(parent.id);
  res.json({ parent, messages });
});

// Owner sending a message directly (bypassing the AI) — for when a human needs to step in.
adminRouter.post('/conversations/:parentId/send', async (req, res) => {
  const parent = db.prepare('SELECT * FROM parents WHERE id = ? AND business_id = ?').get(req.params.parentId, req.auth.businessId);
  if (!parent) return res.status(404).json({ error: 'Not found' });
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: 'Message body required' });

  await sendText(parent.whatsapp_number, body);
  db.prepare('INSERT INTO messages (parent_id, direction, body, ai_action) VALUES (?, ?, ?, ?)')
    .run(parent.id, 'out', body, 'manual_owner_reply');
  res.json({ ok: true });
});

// ---- Billing / reports ----
adminRouter.get('/billing/overview', (req, res) => {
  const business = getBusinessById(req.auth.businessId);
  const monthly = db.prepare(`
    SELECT strftime('%Y-%m', pay.paid_at) as month, SUM(pay.amount_cents) as total_cents, COUNT(*) as count
    FROM payments pay JOIN parents p ON p.id = pay.parent_id
    WHERE p.business_id = ? AND pay.status = 'paid' GROUP BY month ORDER BY month DESC LIMIT 12`).all(business.id);
  const outstanding = db.prepare(`
    SELECT COALESCE(SUM(pay.amount_cents),0) s FROM payments pay JOIN parents p ON p.id = pay.parent_id
    WHERE p.business_id = ? AND pay.status = 'pending'`).get(business.id).s;
  res.json({
    trial: trialStatus(business),
    subscriptionStatus: business.subscription_status,
    planTier: business.plan_tier,
    studentLimit: business.student_limit,
    priceCents: business.price_cents,
    monthly,
    outstandingCents: outstanding
  });
});

adminRouter.get('/payments', (req, res) => {
  res.json(db.prepare(`
    SELECT pay.*, par.whatsapp_number, s.name as student_name FROM payments pay
    JOIN parents par ON par.id = pay.parent_id LEFT JOIN students s ON s.id = pay.student_id
    WHERE par.business_id = ? ORDER BY pay.created_at DESC LIMIT 100`).all(req.auth.businessId));
});
