import Anthropic from '@anthropic-ai/sdk';
import { db, getBusiness } from './db.js';
import { createPaymentLink } from './billing.js';
import { addStopForBooking } from './logistics.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are the WhatsApp assistant for a school transportation ("scholar transit") service.
You talk directly with parents. Be warm, brief, and clear — parents are often messaging while busy or
worried about their child. Use plain language, not jargon like "trip ID" or "route ID".

You can:
- Look up a parent's registered students
- Book or cancel a ride for a student on a given day/leg (morning or afternoon)
- Report live status/ETA of a student's ride
- Generate a payment link for outstanding fees
- Answer common questions (schedule, pickup point, driver contact policy, what to do if a ride is missed)
- Escalate to a human staff member when something is urgent, a complaint, or you're not confident

When reporting ride status from track_ride, translate stop_status into plain language:
pending = "hasn't started that pickup route yet", awaiting/arrived = "the driver is at the pickup point now",
delayed = "running behind, new estimate below", picked_up = "already picked up and on the way".
Always mention the eta_at time in local terms if present (e.g. "around 7:42 AM").

Rules:
- Never invent a status, ETA, driver name, or price — always call a tool to get real data.
- If the parent's WhatsApp number isn't registered to any student, guide them to contact the office to be added
  (don't try to self-register a new student from chat).
- If a request is ambiguous (e.g. "cancel the ride" with two kids), ask which student first.
- If a parent sounds distressed, angry, or reports a safety concern, immediately call escalate_to_human — don't
  try to fully resolve it yourself first.
- Keep replies short: 1-4 sentences, WhatsApp-style. No markdown headers or bullet walls.`;

const tools = [
  {
    name: 'get_students_for_parent',
    description: "List the students registered under this parent's WhatsApp number.",
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'book_ride',
    description: 'Book a student on a scheduled route for a given date and leg (morning or afternoon).',
    input_schema: {
      type: 'object',
      properties: {
        student_id: { type: 'integer' },
        service_date: { type: 'string', description: 'YYYY-MM-DD' },
        leg: { type: 'string', enum: ['morning', 'afternoon'] }
      },
      required: ['student_id', 'service_date', 'leg']
    }
  },
  {
    name: 'cancel_ride',
    description: 'Cancel an existing booking for a student.',
    input_schema: {
      type: 'object',
      properties: {
        student_id: { type: 'integer' },
        service_date: { type: 'string', description: 'YYYY-MM-DD' },
        leg: { type: 'string', enum: ['morning', 'afternoon'] }
      },
      required: ['student_id', 'service_date', 'leg']
    }
  },
  {
    name: 'track_ride',
    description: "Get the live status and ETA for a student's ride today.",
    input_schema: {
      type: 'object',
      properties: { student_id: { type: 'integer' } },
      required: ['student_id']
    }
  },
  {
    name: 'get_payment_link',
    description: 'Generate a Stripe payment link for a parent to pay outstanding transportation fees.',
    input_schema: {
      type: 'object',
      properties: {
        student_id: { type: 'integer' },
        amount_cents: { type: 'integer', description: 'Amount to charge, in cents' },
        period_label: { type: 'string', description: "e.g. 'March 2026 fees'" }
      },
      required: ['student_id', 'amount_cents', 'period_label']
    }
  },
  {
    name: 'escalate_to_human',
    description: 'Flag this conversation for the business owner/staff to handle personally. Use for complaints, safety concerns, or anything you cannot resolve.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason']
    }
  }
];

function toolImplementations(parent) {
  return {
    get_students_for_parent: () => {
      return db.prepare('SELECT id, name, school, grade, route_id FROM students WHERE parent_id = ? AND active = 1')
        .all(parent.id);
    },

    book_ride: ({ student_id, service_date, leg }) => {
      const student = db.prepare('SELECT * FROM students WHERE id = ? AND parent_id = ?').get(student_id, parent.id);
      if (!student) return { error: 'Student not found for this parent.' };
      if (!student.route_id) return { error: 'This student has no route assigned yet. Contact the office.' };

      let trip = db.prepare('SELECT * FROM trips WHERE route_id = ? AND service_date = ? AND leg = ?')
        .get(student.route_id, service_date, leg);
      if (!trip) {
        const info = db.prepare('INSERT INTO trips (route_id, service_date, leg) VALUES (?, ?, ?)')
          .run(student.route_id, service_date, leg);
        trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(info.lastInsertRowid);
      }

      const existing = db.prepare("SELECT * FROM bookings WHERE trip_id = ? AND student_id = ? AND status != 'canceled'")
        .get(trip.id, student_id);
      if (existing) return { status: 'already_booked', booking_id: existing.id };

      const result = db.prepare('INSERT INTO bookings (trip_id, student_id) VALUES (?, ?)').run(trip.id, student_id);
      addStopForBooking(trip, student); // adds this student to the driver's ordered stop list
      return { status: 'booked', booking_id: result.lastInsertRowid, student: student.name, service_date, leg };
    },

    cancel_ride: ({ student_id, service_date, leg }) => {
      const trip = db.prepare(`
        SELECT t.* FROM trips t
        JOIN students s ON s.route_id = t.route_id
        WHERE s.id = ? AND t.service_date = ? AND t.leg = ?`).get(student_id, service_date, leg);
      if (!trip) return { error: 'No booking found for that date/leg.' };

      const booking = db.prepare("SELECT * FROM bookings WHERE trip_id = ? AND student_id = ? AND status != 'canceled'")
        .get(trip.id, student_id);
      if (!booking) return { error: 'No active booking found for that date/leg.' };

      db.prepare("UPDATE bookings SET status = 'canceled' WHERE id = ?").run(booking.id);
      return { status: 'canceled', booking_id: booking.id };
    },

    track_ride: ({ student_id }) => {
      const today = new Date().toISOString().slice(0, 10);
      const row = db.prepare(`
        SELECT t.status as trip_status, t.leg, r.name as route_name, d.name as driver_name,
               st.status as stop_status, st.eta_at, st.delay_minutes, st.delay_reason
        FROM bookings b
        JOIN trips t ON t.id = b.trip_id
        JOIN routes r ON r.id = t.route_id
        LEFT JOIN drivers d ON d.id = r.driver_id
        LEFT JOIN stops st ON st.trip_id = t.id AND st.student_id = b.student_id
        WHERE b.student_id = ? AND t.service_date = ? AND b.status != 'canceled'
        ORDER BY t.id DESC LIMIT 1`).get(student_id, today);
      if (!row) return { error: 'No ride booked for this student today.' };
      return row;
    },

    get_payment_link: ({ student_id, amount_cents, period_label }) => {
      return createPaymentLink({ parentId: parent.id, studentId: student_id, amountCents: amount_cents, periodLabel: period_label });
    },

    escalate_to_human: ({ reason }) => {
      db.prepare('INSERT INTO alerts (type, message) VALUES (?, ?)')
        .run('support_escalation', `Parent ${parent.whatsapp_number}: ${reason}`);
      return { status: 'escalated' };
    }
  };
}

// Runs one turn of the agent loop: sends the conversation to Claude, executes any
// tool calls it requests, feeds results back, and returns the final text reply.
export async function runAgent({ parent, userMessage, history }) {
  const impls = toolImplementations(parent);
  const messages = [...history, { role: 'user', content: userMessage }];
  let needsHuman = false;
  let actionTaken = null;

  for (let turn = 0; turn < 5; turn++) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages
    });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      const text = response.content.find((b) => b.type === 'text')?.text || "Sorry, I didn't catch that — could you rephrase?";
      return { text, needsHuman, actionTaken };
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const use of toolUses) {
      actionTaken = use.name;
      if (use.name === 'escalate_to_human') needsHuman = true;
      let result;
      try {
        result = impls[use.name](use.input);
      } catch (err) {
        result = { error: err.message };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return { text: "I'm having trouble finishing that — I've flagged it for our team to follow up.", needsHuman: true, actionTaken };
}
