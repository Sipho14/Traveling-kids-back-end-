# Scholar Transit — WhatsApp AI + Control Center

A WhatsApp assistant for parents (booking rides, live tracking, paying fees, support Q&A) backed by
Claude, plus a control-center dashboard for the business owner (drivers, vehicles, routes, live trips,
billing, and alerts). Includes a 30-day free trial → paid subscription flow for you (the owner).

## How it fits together

```
Parent's WhatsApp  <-->  Meta WhatsApp Cloud API  <-->  /webhooks/whatsapp  <-->  Claude (agent.js)
                                                                |
                                                          SQLite database
                                                                |
                                                    /api/admin/*  <-->  React dashboard (owner)
                                                                |
                                                      Stripe (parent fees + your subscription)
```

- **backend/** — Node/Express API: WhatsApp webhook, Claude-powered agent, admin API, Stripe billing.
- **frontend/** — React + Tailwind dashboard: the owner's "control center."

## 1. Backend setup

```bash
cd backend
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | developers.facebook.com → your app → WhatsApp → API Setup |
| `WHATSAPP_VERIFY_TOKEN` | any string you choose — you'll enter the same value in Meta's dashboard |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | dashboard.stripe.com |
| `JWT_SECRET` | any long random string |

Create your owner account and a sample fleet:

```bash
SEED_OWNER_EMAIL=you@yourcompany.com SEED_OWNER_PASSWORD=yourpassword npm run seed
```

Start the server:

```bash
npm start        # or: npm run dev  (auto-restarts on change)
```

## 2. Connect real WhatsApp (Meta Cloud API)

1. Create a Meta Developer app → add the **WhatsApp** product.
2. In **API Setup**, grab the temporary token + phone number ID (swap the token for a permanent
   System User token before going live — temporary ones expire in 24h).
3. Expose your local server publicly for testing: `ngrok http 3000` (or deploy — see below).
4. In **WhatsApp → Configuration → Webhook**, set:
   - Callback URL: `https://<your-domain>/webhooks/whatsapp`
   - Verify token: same value as `WHATSAPP_VERIFY_TOKEN` in your `.env`
   - Subscribe to the `messages` field.
5. Message your WhatsApp test number from your phone — it should hit your webhook and Claude will reply.

Once you're ready for real parents, apply for a production WhatsApp Business number and get it
verified through Meta (this part is Meta's process, typically a few days).

## 3. Connect Stripe

1. Create a **recurring price** in Stripe for your own subscription (what investors/schools pay you
   after the 30-day trial) → put its ID in `STRIPE_PRICE_ID`.
2. Add a webhook endpoint in Stripe pointing to `https://<your-domain>/webhooks/stripe`, subscribed to
   `checkout.session.completed`, `invoice.payment_failed`, `customer.subscription.deleted` → copy the
   signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Parent-facing payment links (school fees) are created automatically by the AI agent's
   `get_payment_link` tool — no setup needed beyond your Stripe secret key.

## 4. Frontend (control center) setup

```bash
cd frontend
npm install
npm run dev
```

Visit `http://localhost:5173`, log in with the owner email/password from the seed step. In production,
run `npm run build` and serve the `dist/` folder (e.g. from Vercel, Netlify, or the same server as the
backend behind a reverse proxy), and point its API calls at your deployed backend URL.

## 5. Deploying for the investor trial

- Backend: any Node host works (Railway, Render, Fly.io, a small VPS). SQLite is fine for a single-business
  prototype like this; if you outgrow one file, swap `better-sqlite3` for Postgres later — the query layer
  is isolated in `src/db/` and `src/routes/admin.js`.
- Set `TRIAL_DAYS=30` (default) in `.env` — the trial clock starts the moment you run the seed script.
- The trial-expiry cron (`src/services/trialCron.js`) checks daily and raises an in-app alert at 5 days
  left, then pauses the WhatsApp assistant (with a polite auto-reply to parents) once the trial ends,
  until a subscription is active.

## Stop-by-stop logistics (drivers, parents, and the owner)

Every booking adds the student as a numbered **stop** on that trip — not just a trip-level status. This
is what makes the whole thing behave like a real logistics system rather than a simple tracker.

**Driver side** (`backend/public/driver.html`, served at `<APP_URL>/driver.html?token=...`):
- No app install, no login — the owner taps **"Send driver their link"** on a trip in the dashboard, and
  the driver gets a one-time WhatsApp link straight to their ordered stop list for that run.
- For each stop the driver taps one of: **Arrived**, **Waiting**, **Delayed** (enter minutes + optional
  reason), **Picked up**, **No show**.

**Parent side** — each tap fires a targeted WhatsApp message to *that* stop's parent only ("driver has
arrived", "running 8 min behind — construction on Main St"). Parents further down the route are **not**
messaged for every stop; they only get a proactive update if a delay is large enough to actually move
their own ETA (5+ minutes, tunable via `CASCADE_ALERT_THRESHOLD_MINUTES` in `src/services/logistics.js`).
Parents can also always just ask the WhatsApp assistant directly ("where's the bus?") for the current
stop-level status.

**Owner side** (Live trips tab): each trip expands into a full timestamped stop timeline (ETA per stop,
actual pickup time, delay minutes + reason). Trips with a delay or no-show are outlined and flagged, with
a **"Diagnose & suggest fix"** button that sends the trip's stop data — plus the same route's last 7 runs
— to Claude for a concrete diagnosis and 1-3 operational suggestions (e.g. "Stop 3 has been 10+ min late
three days running — consider moving its scheduled time back" or "reassign a second vehicle").

Two more owner controls live in the same timeline:
- **Drag to reorder stops** on a trip — reindexes sequence and refreshes ETAs for everything still pending.
- **Move a stop to another trip** running the same day (e.g. a vehicle breaks down mid-route) via the
  "Move to…" dropdown next to each stop.
- **Per-route delay alert threshold** (Drivers & routes tab) — how many minutes behind a route has to run
  before downstream parents get a proactive text. Defaults to 5 min; edit it per route any time.

## What the AI can actually do (src/ai/agent.js)

- `get_students_for_parent` — looks up which kids are registered to the messaging number
- `book_ride` / `cancel_ride` — creates/cancels a booking for a date + morning/afternoon leg
- `track_ride` — live status, ETA, driver name for today's ride
- `get_payment_link` — generates a real Stripe checkout link for outstanding fees
- `escalate_to_human` — flags the conversation in the owner's Alerts tab (complaints, safety concerns,
  anything it's not confident about)

Every message in and out is logged (`messages` table) so the owner has a full audit trail per parent.

## Notes on this being a prototype

- Single-business (single-tenant) by design — fastest path to a working demo. The schema has room to add
  a `business_id` foreign key everywhere if you later want to sell this to multiple transport companies.
- No live GPS feed yet — `trips.current_lat/lng` and `eta_minutes` are there for you to wire up to a
  driver-side app or a GPS tracker API; today, trip status (scheduled/in progress/completed) is set from
  the dashboard.
- Auth is a single owner login (email/password → JWT). Add staff roles later if you need multiple logins.
