import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { sendText } from './whatsapp.js';

// Only ping parents further down the route if a delay actually moves their ETA by
// this much — otherwise a 1-2 minute hiccup would spam everyone on a 20-stop route.
// Falls back to this default if a route hasn't set its own threshold.
const DEFAULT_CASCADE_THRESHOLD_MINUTES = 5;
const DEFAULT_STOP_GAP_MINUTES = 5;

export function ensureDriverToken(trip) {
  if (trip.driver_access_token) return trip.driver_access_token;
  const token = nanoid(16);
  db.prepare('UPDATE trips SET driver_access_token = ? WHERE id = ?').run(token, trip.id);
  return token;
}

// Called when a booking is created: adds the student as the next stop in sequence
// on that trip, spaced out from the previous stop by a default gap (owner can't fine-tune
// per-stop timing yet, but the sequence and cascade logic works regardless).
export function addStopForBooking(trip, student) {
  const last = db.prepare('SELECT MAX(sequence) as maxSeq, MAX(scheduled_offset_minutes) as maxOffset FROM stops WHERE trip_id = ?')
    .get(trip.id);
  const sequence = (last.maxSeq || 0) + 1;
  const scheduledOffset = (last.maxOffset ?? -DEFAULT_STOP_GAP_MINUTES) + DEFAULT_STOP_GAP_MINUTES;

  const info = db.prepare(`
    INSERT INTO stops (trip_id, student_id, sequence, scheduled_offset_minutes)
    VALUES (?, ?, ?, ?)`).run(trip.id, student.id, sequence, scheduledOffset);

  ensureDriverToken(trip);
  return db.prepare('SELECT * FROM stops WHERE id = ?').get(info.lastInsertRowid);
}

function baseTime(trip, route) {
  const legTime = trip.leg === 'morning' ? route.morning_time : route.afternoon_time;
  const d = new Date(`${trip.service_date}T${legTime || '07:00'}:00`);
  return d;
}

function computeEta(trip, route, stop) {
  const base = baseTime(trip, route);
  base.setMinutes(base.getMinutes() + stop.scheduled_offset_minutes + trip.cumulative_delay_minutes);
  return base.toISOString();
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function parentFor(studentId) {
  return db.prepare(`
    SELECT p.* FROM parents p JOIN students s ON s.parent_id = p.id WHERE s.id = ?`).get(studentId);
}

function studentName(studentId) {
  return db.prepare('SELECT name FROM students WHERE id = ?').get(studentId)?.name || 'your child';
}

// Recomputes ETA for every not-yet-picked-up stop after `fromSequence` on this trip,
// and pushes a WhatsApp update to any parent whose ETA moved by more than the threshold
// and who hasn't already been told about this specific delay.
async function cascadeDelay({ trip, route, fromSequence, addedDelayMinutes, reason }) {
  const threshold = route.delay_alert_threshold_minutes ?? DEFAULT_CASCADE_THRESHOLD_MINUTES;

  const downstream = db.prepare(`
    SELECT * FROM stops WHERE trip_id = ? AND sequence > ? AND status IN ('pending','awaiting') ORDER BY sequence`
  ).all(trip.id, fromSequence);

  for (const stop of downstream) {
    const eta = computeEta(trip, route, stop);
    db.prepare('UPDATE stops SET eta_at = ? WHERE id = ?').run(eta, stop.id);

    if (addedDelayMinutes >= threshold && !stop.parent_notified_for_delay) {
      const parent = parentFor(stop.student_id);
      if (parent) {
        const name = studentName(stop.student_id);
        await sendText(
          parent.whatsapp_number,
          `Heads up — the bus is running about ${addedDelayMinutes} min behind${reason ? ` (${reason})` : ''}. New estimated pickup for ${name}: ~${fmtTime(eta)}.`
        ).catch((e) => console.error('cascade notify failed', e));
      }
      db.prepare('UPDATE stops SET parent_notified_for_delay = 1 WHERE id = ?').run(stop.id);
    }
  }
}

// The main entry point the driver portal calls for every button tap.
export async function updateStopStatus({ stopId, action, delayMinutes, reason }) {
  const stop = db.prepare('SELECT * FROM stops WHERE id = ?').get(stopId);
  if (!stop) throw new Error('Stop not found');
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(stop.trip_id);
  const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(trip.route_id);
  const parent = parentFor(stop.student_id);
  const name = studentName(stop.student_id);
  const now = new Date().toISOString();

  if (trip.status === 'scheduled') {
    db.prepare("UPDATE trips SET status = 'in_progress', started_at = COALESCE(started_at, ?) WHERE id = ?").run(now, trip.id);
  }

  switch (action) {
    case 'arrived': {
      db.prepare("UPDATE stops SET status = 'arrived', arrived_at = ? WHERE id = ?").run(now, stop.id);
      if (parent) await sendText(parent.whatsapp_number, `The bus has arrived for ${name}'s pickup.`).catch(() => {});
      break;
    }
    case 'awaiting': {
      db.prepare("UPDATE stops SET status = 'awaiting' WHERE id = ?").run(stop.id);
      if (parent) await sendText(parent.whatsapp_number, `The driver is waiting at the pickup point for ${name}.`).catch(() => {});
      break;
    }
    case 'delayed': {
      const mins = Math.max(1, Number(delayMinutes) || 5);
      db.prepare("UPDATE stops SET status = 'delayed', delay_minutes = ?, delay_reason = ? WHERE id = ?")
        .run(mins, reason || null, stop.id);
      db.prepare('UPDATE trips SET cumulative_delay_minutes = cumulative_delay_minutes + ? WHERE id = ?').run(mins, trip.id);

      if (parent) {
        await sendText(parent.whatsapp_number, `Running about ${mins} min behind for ${name}'s pickup${reason ? ` — ${reason}` : ''}. Sorry for the wait!`).catch(() => {});
      }
      const updatedTrip = db.prepare('SELECT * FROM trips WHERE id = ?').get(trip.id);
      await cascadeDelay({ trip: updatedTrip, route, fromSequence: stop.sequence, addedDelayMinutes: mins, reason });

      db.prepare("INSERT INTO alerts (type, message, related_trip_id) VALUES ('stop_delay', ?, ?)")
        .run(`${route.name}: delayed ${mins} min at ${name}'s stop${reason ? ` — ${reason}` : ''}`, trip.id);
      break;
    }
    case 'picked_up': {
      db.prepare("UPDATE stops SET status = 'picked_up', picked_up_at = ? WHERE id = ?").run(now, stop.id);
      db.prepare(`UPDATE bookings SET status = 'picked_up' WHERE trip_id = ? AND student_id = ?`).run(trip.id, stop.student_id);
      if (parent) await sendText(parent.whatsapp_number, `${name} has been picked up and is on the way. 🚌`).catch(() => {});

      // If the actual pickup happened later than the original ETA, treat the gap as a
      // fresh delay signal for whoever's still waiting further down the route.
      const scheduledEta = computeEta({ ...trip, cumulative_delay_minutes: 0 }, route, stop);
      const actualDelay = Math.round((new Date(now) - new Date(scheduledEta)) / 60000);
      const threshold = route.delay_alert_threshold_minutes ?? DEFAULT_CASCADE_THRESHOLD_MINUTES;
      if (actualDelay >= threshold) {
        const updatedTrip = db.prepare('SELECT * FROM trips WHERE id = ?').get(trip.id);
        await cascadeDelay({ trip: updatedTrip, route, fromSequence: stop.sequence, addedDelayMinutes: actualDelay, reason: null });
      }
      break;
    }
    case 'no_show': {
      db.prepare("UPDATE stops SET status = 'no_show' WHERE id = ?").run(stop.id);
      db.prepare(`UPDATE bookings SET status = 'no_show' WHERE trip_id = ? AND student_id = ?`).run(trip.id, stop.student_id);
      db.prepare("INSERT INTO alerts (type, message, related_trip_id) VALUES ('stop_no_show', ?, ?)")
        .run(`${route.name}: no-show at ${name}'s stop`, trip.id);
      if (parent) await sendText(parent.whatsapp_number, `We stopped for ${name} but no one was there — let us know if you still need pickup today.`).catch(() => {});
      break;
    }
    default:
      throw new Error('Unknown action');
  }

  const remaining = db.prepare(`SELECT COUNT(*) c FROM stops WHERE trip_id = ? AND status IN ('pending','awaiting','arrived','delayed')`).get(trip.id).c;
  if (remaining === 0) {
    db.prepare("UPDATE trips SET status = 'completed', completed_at = ? WHERE id = ?").run(now, trip.id);
  }

  return db.prepare('SELECT * FROM stops WHERE id = ?').get(stop.id);
}

export function getTripWithStops(tripOrToken, byToken = false) {
  const trip = byToken
    ? db.prepare('SELECT * FROM trips WHERE driver_access_token = ?').get(tripOrToken)
    : tripOrToken;
  if (!trip) return null;
  const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(trip.route_id);
  const stops = db.prepare(`
    SELECT st.*, s.name as student_name, s.pickup_address FROM stops st
    JOIN students s ON s.id = st.student_id
    WHERE st.trip_id = ? ORDER BY st.sequence`).all(trip.id);
  return { trip, route, stops };
}

// Owner drag-to-reorder: takes the new top-to-bottom order of stop ids for a trip,
// reassigns sequence + evenly-spaced scheduled offsets, and refreshes ETAs so the
// dashboard and any parent who asks "where's the bus" stay consistent with the new order.
export function reorderStops(tripId, orderedStopIds) {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
  const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(trip.route_id);

  const update = db.prepare('UPDATE stops SET sequence = ?, scheduled_offset_minutes = ? WHERE id = ? AND trip_id = ?');
  orderedStopIds.forEach((stopId, i) => {
    update.run(i + 1, i * DEFAULT_STOP_GAP_MINUTES, stopId, tripId);
  });

  const stops = db.prepare(`SELECT * FROM stops WHERE trip_id = ? AND status IN ('pending','awaiting') ORDER BY sequence`).all(tripId);
  const recompute = db.prepare('UPDATE stops SET eta_at = ? WHERE id = ?');
  for (const stop of stops) {
    recompute.run(computeEta(trip, route, stop), stop.id);
  }
  return getTripWithStops(trip);
}

// Moves a student's stop to a different trip running the same day (e.g. a vehicle
// breaks down and its remaining riders need to shift onto another driver's run).
// Appends the stop to the end of the destination trip's sequence.
export function reassignStop(stopId, newTripId) {
  const stop = db.prepare('SELECT * FROM stops WHERE id = ?').get(stopId);
  if (!stop) throw new Error('Stop not found');
  const newTrip = db.prepare('SELECT * FROM trips WHERE id = ?').get(newTripId);
  if (!newTrip) throw new Error('Destination trip not found');
  if (newTrip.service_date !== db.prepare('SELECT service_date FROM trips WHERE id = ?').get(stop.trip_id).service_date) {
    throw new Error('Can only reassign within the same service date');
  }

  const maxSeq = db.prepare('SELECT MAX(sequence) as m FROM stops WHERE trip_id = ?').get(newTripId).m || 0;
  db.prepare('UPDATE stops SET trip_id = ?, sequence = ?, status = ?, eta_at = NULL WHERE id = ?')
    .run(newTripId, maxSeq + 1, 'pending', stopId);
  db.prepare('UPDATE bookings SET trip_id = ? WHERE trip_id = ? AND student_id = ?')
    .run(newTripId, stop.trip_id, stop.student_id);

  ensureDriverToken(newTrip);
  return getTripWithStops(newTrip);
}
