# NT Ticket Monitor 🎭

Monitors the [National Theatre](https://www.nationaltheatre.org.uk/) for returned tickets on **October 2026 performances of Electra/Persona** and alerts you the instant any become available.

- Runs **24/7 on Cloudflare Workers** — no server, no laptop needed
- Checks every **3 minutes**
- Alerts via **Slack** (phone push notification) + **Email**
- Only notifies on a **new release** — no spam

---

## How it works

Every 3 minutes the worker calls the NT events API:
```
GET https://events.nationaltheatre.org.uk/api/v1/events/95878
```
For each October 2026 performance it checks whether any standard mode-of-sale has `percentage > 0` — the NT's own field indicating remaining ticket allocation. The first time a sold-out show flips to available, it fires an alert with the date, time, prices, and a direct booking link. It won't alert again for that show until it sells out and comes back.

---

## Stack

| Service | What for | Cost |
|---------|----------|------|
| [Cloudflare Workers](https://workers.cloudflare.com/) | Runs the monitor 24/7 on a cron | Free (100k req/day) |
| [Cloudflare KV](https://developers.cloudflare.com/kv/) | Stores last known availability state | Free |
| [Resend](https://resend.com/) | Sends email alerts | Free (3k emails/month) |
| [Slack Incoming Webhooks](https://api.slack.com/messaging/webhooks) | Phone push notifications | Free |

---

## Project structure

```
nt-ticket-monitor/
├── src/
│   └── index.js        # Worker logic — poll, diff, alert
├── wrangler.toml       # Cloudflare config — cron, KV binding
├── package.json
├── SETUP.md            # Step-by-step first-time setup guide
└── README.md
```

---

## Secrets

Set via `npx wrangler secret put <NAME>` — never committed to the repo.

| Secret | Description |
|--------|-------------|
| `RESEND_API_KEY` | From [resend.com](https://resend.com) — free, no credit card |
| `ALERT_EMAIL` | Email address to send alerts to |
| `SLACK_WEBHOOK_URL` | From [api.slack.com/apps](https://api.slack.com/apps) |

---

## Endpoints

| URL | What it does |
|-----|-------------|
| `GET /check` | Run a check right now, returns JSON summary |
| `GET /status` | Show last known state for all 12 October performances |
| `GET /test` | Send a real test alert (email + Slack) |
| `GET /reset` | Clear stored state — re-arms all alerts (use after buying tickets) |

Worker URL: `https://nt-ticket-monitor.vpetrova3.workers.dev`

---

## Deploying changes

```bash
# Install dependencies
npm install

# Login to Cloudflare
npx wrangler login

# Deploy
npx wrangler deploy

# Watch live logs
npx wrangler tail
```

---

## Alert behaviour

| Scenario | Alert sent? |
|----------|-------------|
| Show sold out → no change | ❌ Silent |
| Show sold out → ticket available | ✅ Once |
| Show available → sells out again → available again | ✅ Once (new release) |
| Same show still available on next check | ❌ Silent |

---

## Stopping the monitor

When you've got your tickets:

```bash
# Pause (re-enable anytime in the Cloudflare dashboard)
npx wrangler deploy --no-schedule

# Or delete entirely
npx wrangler delete nt-ticket-monitor
```
