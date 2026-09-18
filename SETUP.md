# NT Ticket Monitor — Setup Guide

Monitors **Electra/Persona** (National Theatre, event #95878) for returned tickets on any
**October 2026** performance. Alerts you via **email** and **Slack** the moment standard-sale
tickets become available. Runs 24/7 on Cloudflare's free tier — no server, no running costs.

---

## How it works

Every 3 minutes the worker calls:
```
https://events.nationaltheatre.org.uk/api/v1/events/95878
```
For each October performance it checks whether any standard mode-of-sale (mos 11/12/13/21/27…)
shows `percentage > 0`, which is the NT's own API field indicating remaining allocation.
On first detection it fires an email + Slack message and won't repeat until the tickets sell out
and come back again.

---

## Prerequisites (all free)

| Account | What for | Free tier |
|---------|----------|-----------|
| **Cloudflare** | Hosts the worker, runs cron, stores state | 100k req/day free |
| **Mailgun** | Sends email alerts | 100 emails/day free (sandbox) |
| **Slack** | Receives instant notifications | Free workspaces included |

---

## Step 1 — Install Node.js + Wrangler

1. Download Node.js from https://nodejs.org (LTS version)
2. Open a terminal in this folder (`nt-ticket-monitor/`) and run:
   ```bash
   npm install
   ```
   This installs Wrangler (Cloudflare's deployment CLI).

---

## Step 2 — Create a Cloudflare account

1. Go to https://dash.cloudflare.com/sign-up — sign up free
2. Once in the dashboard, run in your terminal:
   ```bash
   npx wrangler login
   ```
   A browser window opens — approve access.

---

## Step 3 — Create the KV namespace

The worker stores the last-known availability state here so it doesn't spam you.

```bash
npx wrangler kv namespace create "TICKET_MONITOR_KV"
```

Wrangler will print something like:
```
{ binding = "TICKET_MONITOR_KV", id = "abc123def456..." }
```

Copy the `id` value and paste it into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

---

## Step 4 — Set up Mailgun (email alerts)

1. Go to https://signup.mailgun.com — sign up free
2. After logging in, go to **Sending → Domains** — you'll have a sandbox domain like
   `sandbox1234567890abcdef.mailgun.org`
3. Go to **API Keys** (top-right menu → API Security) and copy your **Private API key**
4. In the Mailgun dashboard, under your sandbox domain → **Authorized Recipients**,
   add your email address (required for sandbox — you'll get a confirmation email)

Now add the secrets to your worker:
```bash
npx wrangler secret put MAILGUN_API_KEY
# Paste your Mailgun private API key when prompted

npx wrangler secret put MAILGUN_DOMAIN
# Paste your sandbox domain, e.g. sandbox1234567890abcdef.mailgun.org

npx wrangler secret put ALERT_EMAIL
# Paste the email address you want alerts sent to
```

---

## Step 5 — Set up Slack (instant phone notifications)

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**
2. Name it `NT Ticket Monitor`, pick your workspace, click **Create App**
3. In the left sidebar, click **Incoming Webhooks** → toggle **Activate Incoming Webhooks** ON
4. Click **Add New Webhook to Workspace** → pick a channel (e.g. `#general` or a new
   `#tickets` channel) → click **Allow**
5. Copy the webhook URL (looks like `https://hooks.slack.com/services/T.../B.../...`)

```bash
npx wrangler secret put SLACK_WEBHOOK_URL
# Paste the webhook URL when prompted
```

**To get phone notifications from Slack:** Install the Slack app on your phone, enable
notifications for the channel you picked, and set your notification settings to **All messages**.
You'll get a push notification the moment the worker fires.

---

## Step 6 — Deploy

```bash
npx wrangler deploy
```

You'll see output like:
```
Deployed nt-ticket-monitor triggers:
  - Schedule: */3 * * * *
  - https://nt-ticket-monitor.<your-subdomain>.workers.dev
```

---

## Step 7 — Test it

Run a manual check to confirm everything works:
```bash
curl https://nt-ticket-monitor.<your-subdomain>.workers.dev/check
```

This will:
- Hit the NT API
- Check all October performances
- If no standard tickets are available, return a summary showing all dates as sold out
- If you want to force a test notification regardless, use `/check` with `forceSend=true`
  (or temporarily set `forceSend = true` in the code and redeploy)

To force a test alert (sends real email + Slack):
```bash
# Temporarily reset state so the next /check fires alerts for any available ticket
curl https://nt-ticket-monitor.<your-subdomain>.workers.dev/reset
curl https://nt-ticket-monitor.<your-subdomain>.workers.dev/check
```

---

## Manual URLs

| URL | What it does |
|-----|-------------|
| `/check` | Runs a check right now and returns JSON summary |
| `/status` | Shows the last known state for all October performances |
| `/reset` | Clears stored state — next check re-evaluates everything (useful to re-arm after buying tickets) |

---

## Monitoring costs

The free Cloudflare Workers plan gives you **100,000 requests/day**.
Running every 3 minutes = ~480 requests/day — well within the free tier.
The KV store is free up to 1,000 writes/day — this uses ~480/day.

---

## Stopping the monitor

When you've got your tickets (congratulations!), either:
- **Pause**: In the Cloudflare dashboard → Workers → `nt-ticket-monitor` → Settings → Disable
- **Delete**: `npx wrangler delete nt-ticket-monitor`

---

## Troubleshooting

**Not getting emails?**
- Make sure your email is in Mailgun's "Authorized Recipients" list (sandbox requirement)
- Check the worker logs: `npx wrangler tail` in your terminal

**Not getting Slack messages?**
- Confirm the webhook URL is correct with: `curl -X POST -d '{"text":"test"}' YOUR_WEBHOOK_URL`
- Make sure Slack mobile notifications are enabled for the channel

**Check the live logs:**
```bash
npx wrangler tail
```
This streams real-time logs from your worker so you can watch each 3-minute check.
