import Anthropic from '@anthropic-ai/sdk';
import { db } from './db.js';
import { getTripWithStops } from './logistics.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Looks at this trip's stop timeline plus the same route's recent history so the
// suggestion isn't just "today was late" but can spot a recurring pattern.
export async function diagnoseTrip(tripId) {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
  const { route, stops } = getTripWithStops(trip);

  const recentRuns = db.prepare(`
    SELECT t.service_date, t.leg, t.cumulative_delay_minutes,
      (SELECT COUNT(*) FROM stops s WHERE s.trip_id = t.id AND s.status='no_show') as no_shows
    FROM trips t WHERE t.route_id = ? AND t.service_date < ? ORDER BY t.service_date DESC LIMIT 7`
  ).all(route.id, trip.service_date);

  const summary = {
    route: route.name,
    date: trip.service_date,
    leg: trip.leg,
    cumulative_delay_minutes: trip.cumulative_delay_minutes,
    stops: stops.map((s) => ({
      student: s.student_name,
      sequence: s.sequence,
      status: s.status,
      delay_minutes: s.delay_minutes,
      delay_reason: s.delay_reason
    })),
    recent_history_same_route: recentRuns
  };

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: `You are a logistics analyst for a school transportation company. Given one trip's stop-by-stop
data and recent history for the same route, write a short diagnosis of what went wrong (or confirm nothing
did), and 1-3 concrete, specific operational suggestions (e.g. adjust scheduled time for a specific stop,
reorder stops, flag a specific recurring reason, consider a second vehicle). Be concrete and reference the
actual data given — no generic advice. Respond ONLY as JSON: {"diagnosis": "...", "suggestions": ["...", "..."]}`,
    messages: [{ role: 'user', content: JSON.stringify(summary) }]
  });

  const text = response.content.find((b) => b.type === 'text')?.text || '{}';
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    parsed = { diagnosis: 'Could not analyze this trip automatically.', suggestions: [] };
  }

  db.prepare('INSERT INTO trip_suggestions (trip_id, diagnosis, suggestions) VALUES (?, ?, ?)')
    .run(tripId, parsed.diagnosis, JSON.stringify(parsed.suggestions || []));

  return parsed;
}
