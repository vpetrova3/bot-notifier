/**
 * NT Ticket Monitor — Cloudflare Worker
 * Polls the National Theatre events API every 3 minutes.
 * Alerts via email (Resend — free, no credit card) and Slack when
 * standard-sale tickets become available for any October 2026
 * performance of Electra/Persona.
 *
 * Secrets needed (set via `wrangler secret put`):
 *   RESEND_API_KEY      — from resend.com (free, no card)
 *   ALERT_EMAIL         — your email address
 *   SLACK_WEBHOOK_URL   — from api.slack.com/apps
 */

const EVENT_ID = "95878";
const API_URL = `https://events.nationaltheatre.org.uk/api/v1/events/${EVENT_ID}`;

// Mode-of-sale codes that represent standard public tickets.
// Excludes 141 (Member Plus), 143, 144 (other member tiers).
const STANDARD_MOS = new Set([11, 12, 13, 21, 27, 31, 32, 58, 62, 86, 87, 122, 128]);
const FRIDAY_RUSH_MOS = new Set([124]);

// KV namespace binding name: TICKET_MONITOR_KV  (set in wrangler.toml)

export default {
  // Runs on a cron schedule (every 3 minutes — set in wrangler.toml)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAvailability(env));
  },

  // Also expose a manual HTTP trigger for testing: GET /check
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/check") {
      const result = await checkAvailability(env, true);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/status") {
      const state = await env.TICKET_MONITOR_KV.get("last_state", { type: "json" });
      return new Response(JSON.stringify(state || {}, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/reset") {
      await env.TICKET_MONITOR_KV.delete("last_state");
      return new Response("State cleared. Next check will re-evaluate.", {
        headers: { "Content-Type": "text/plain" },
      });
    }
    return new Response(
      "NT Ticket Monitor running.\n\nEndpoints:\n  GET /check  – run a manual check now\n  GET /status – view last known state\n  GET /reset  – clear state (re-arms all alerts)",
      { headers: { "Content-Type": "text/plain" } }
    );
  },
};

async function checkAvailability(env, forceSend = false) {
  const response = await fetch(API_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; NTTicketMonitor/1.0)",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    console.error(`API returned ${response.status}`);
    return { error: `API returned ${response.status}` };
  }

  const data = await response.json();
  const now = new Date().toISOString();

  // Filter to October 2026 performances only
  const octPerformances = (data.instances || []).filter((inst) =>
    inst.datetime.startsWith("2026-10")
  );

  // Load previous state from KV
  const prevState = (await env.TICKET_MONITOR_KV.get("last_state", { type: "json" })) || {};
  const newState = {};
  const newlyAvailable = [];

  for (const perf of octPerformances) {
    const perfId = perf._id;
    const perfDate = formatDate(perf.datetime);
    const perfTime = formatTime(perf.datetime);
    const bookingUrl = perf.bookingURL;

    // Find available standard-sale tickets
    const standardAvail = (perf.prices || []).filter(
      (p) => STANDARD_MOS.has(parseInt(p.mos)) && parseFloat(p.percentage) > 0
    );
    const rushAvail = (perf.prices || []).filter(
      (p) => FRIDAY_RUSH_MOS.has(parseInt(p.mos)) && parseFloat(p.percentage) > 0
    );

    const isAvailable = standardAvail.length > 0 || rushAvail.length > 0;
    newState[perfId] = { available: isAvailable, checkedAt: now };

    // Only alert if this is a NEW availability (was unavailable last time, or no prior state)
    const wasAvailable = prevState[perfId]?.available === true;
    if (isAvailable && (!wasAvailable || forceSend)) {
      const prices = buildPriceList(standardAvail, rushAvail);
      newlyAvailable.push({ perfId, perfDate, perfTime, bookingUrl, prices });
    }
  }

  // Persist new state
  await env.TICKET_MONITOR_KV.put("last_state", JSON.stringify(newState));

  const summary = {
    checkedAt: now,
    octPerformancesChecked: octPerformances.length,
    newlyAvailable: newlyAvailable.map((a) => `${a.perfDate} ${a.perfTime}`),
  };

  if (newlyAvailable.length > 0) {
    const notifyResults = await sendNotifications(env, newlyAvailable);
    summary.notificationsSent = notifyResults;
    console.log(`🎭 ALERT: ${newlyAvailable.length} October performance(s) now available!`);
  } else {
    console.log(`✓ Checked ${octPerformances.length} October performances — all sold out.`);
  }

  return summary;
}

function buildPriceList(standardAvail, rushAvail) {
  const prices = [];
  for (const p of standardAvail) {
    prices.push(`£${p.price} (standard)`);
  }
  for (const p of rushAvail) {
    prices.push(`£${p.price} (Friday Rush)`);
  }
  // Deduplicate
  return [...new Set(prices)];
}

async function sendNotifications(env, newlyAvailable) {
  const results = {};
  const subject = `🎭 Electra/Persona tickets available — ${newlyAvailable.length} Oct date(s)!`;
  const textBody = buildTextMessage(newlyAvailable);
  const htmlBody = buildHtmlMessage(newlyAvailable);

  // --- Email via Resend (free: 3,000 emails/month, no credit card) ---
  if (env.RESEND_API_KEY && env.ALERT_EMAIL) {
    try {
      const resRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "NT Ticket Monitor <onboarding@resend.dev>",
          to: [env.ALERT_EMAIL],
          subject,
          text: textBody,
          html: htmlBody,
        }),
      });
      results.email = resRes.ok ? "sent" : `failed (${resRes.status}: ${await resRes.text()})`;
    } catch (e) {
      results.email = `error: ${e.message}`;
    }
  } else {
    results.email = "skipped (RESEND_API_KEY / ALERT_EMAIL not configured)";
  }

  // --- Slack webhook ---
  if (env.SLACK_WEBHOOK_URL) {
    try {
      const slackPayload = buildSlackMessage(newlyAvailable);
      const slRes = await fetch(env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(slackPayload),
      });
      results.slack = slRes.ok ? "sent" : `failed (${slRes.status})`;
    } catch (e) {
      results.slack = `error: ${e.message}`;
    }
  } else {
    results.slack = "skipped (SLACK_WEBHOOK_URL not configured)";
  }

  return results;
}

// ── Message builders ──────────────────────────────────────────────────────────

function buildTextMessage(performances) {
  const lines = [
    "🎭 TICKET ALERT: Electra/Persona — National Theatre",
    "Standard-sale tickets have become available for October 2026!\n",
  ];
  for (const p of performances) {
    lines.push(`📅 ${p.perfDate} at ${p.perfTime}`);
    if (p.prices.length > 0) lines.push(`   Prices: ${p.prices.join(", ")}`);
    lines.push(`   Book now: ${p.bookingUrl}`);
    lines.push("");
  }
  lines.push("This is an automated alert from your NT Ticket Monitor.");
  return lines.join("\n");
}

function buildHtmlMessage(performances) {
  const rows = performances
    .map(
      (p) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">
        <strong>${p.perfDate}</strong> at ${p.perfTime}
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">
        ${p.prices.length > 0 ? p.prices.join(", ") : "Check booking page"}
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">
        <a href="${p.bookingUrl}" style="color:#3b82d4;font-weight:bold;">Book now →</a>
      </td>
    </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1f2328;">
  <h2 style="color:#1f2328;">🎭 Electra/Persona — Tickets Available!</h2>
  <p>Standard-sale tickets have just become available for the following October 2026 performances:</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0;">
    <thead>
      <tr style="background:#f7f8fa;">
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb;">Date</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb;">Prices</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb;">Link</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="font-size:13px;color:#57606a;">Act fast — returned tickets sell quickly. This alert was sent by your NT Ticket Monitor.</p>
</body></html>`;
}

function buildSlackMessage(performances) {
  const perfList = performances
    .map((p) => {
      const priceStr = p.prices.length > 0 ? ` • ${p.prices.join(", ")}` : "";
      return `• *${p.perfDate}* at ${p.perfTime}${priceStr}\n  <${p.bookingUrl}|Book now →>`;
    })
    .join("\n\n");

  return {
    text: `🎭 *Electra/Persona tickets available!* ${performances.length} October date(s) just opened up.`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🎭 Electra/Persona — Tickets Available!",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Standard-sale tickets are available for *${performances.length}* October 2026 performance(s):\n\n${perfList}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Spotted by your NT Ticket Monitor • <https://events.nationaltheatre.org.uk/events/${EVENT_ID}|View all performances>`,
          },
        ],
      },
    ],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/London",
  });
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}
