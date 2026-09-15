// api/request-access.js
// Endpoint 1 — Receives the access request from the Framer gate, stores it in
// Redis and emails the owner with Approve / Decline links, each carrying its
// own one-off token.

import { randomUUID } from "node:crypto";
import {
  redis,
  applyCors,
  sendEmail,
  isValidEmail,
  escapeHtml,
  cleanText,
  emailLayout,
  readFormDetails,
  detailsCardHtml,
  generateToken,
  clientIp,
  rateLimit,
} from "../lib/utils.js";

const THIRTY_DAYS = 60 * 60 * 24 * 30;

// A repeated request for an email that is still pending reminds the owner,
// but no more often than this.
const RENOTIFY_AFTER_MS = 15 * 60 * 1000;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Spam brake: without this anyone can flood the owner's inbox.
    const ip = clientIp(req);
    const allowed = await rateLimit(`rl:request:${ip}`, {
      max: 3,
      windowSeconds: 60 * 60,
    });
    if (!allowed) {
      console.warn(`request-access: rate limited ${ip}`);
      return res.status(429).json({
        error: "Too many requests. Please try again later.",
      });
    }

    const body = req.body || {};

    if (!body.name || !isValidEmail(body.email)) {
      return res.status(400).json({ error: "Name and a valid email are required." });
    }

    const cleanEmail = body.email.toLowerCase().trim();

    // Same email with a request still pending: no second request is created,
    // but it is never dropped silently either. If the first notice got lost
    // (spam, wrong inbox), the owner is reminded with the same links.
    const existingId = await redis.get(`pending:${cleanEmail}`);
    const existing = existingId ? await redis.get(`request:${existingId}`) : null;
    if (existing && existing.status === "pending") {
      const lastNotice = Date.parse(existing.notifiedAt || existing.createdAt) || 0;
      if (Date.now() - lastNotice < RENOTIFY_AFTER_MS) {
        console.log(`request-access: duplicate ${existing.id} for ${cleanEmail}, owner notified recently, not resent`);
      } else {
        const sent = await notifyOwner(existing);
        existing.notifiedAt = new Date().toISOString();
        await redis.set(`request:${existing.id}`, existing, { keepTtl: true });
        console.log(`request-access: duplicate ${existing.id} for ${cleanEmail}, owner reminded (resend ${sent.id})`);
      }
      return res.status(200).json({
        ok: true,
        message: "We have already received your request. We will be in touch.",
      });
    }

    // Store the request (expires in 30 days if nobody handles it)
    const now = new Date().toISOString();
    const request = {
      id: randomUUID(),
      name: cleanText(body.name, 80),
      email: cleanEmail,
      token: generateToken(), // unique key for this request
      createdAt: now,
      notifiedAt: now,
      status: "pending",
      ...readFormDetails(body),
    };

    await redis.set(`request:${request.id}`, request, { ex: THIRTY_DAYS });
    await redis.set(`pending:${cleanEmail}`, request.id, { ex: THIRTY_DAYS });

    try {
      const sent = await notifyOwner(request);
      console.log(`request-access: new ${request.id} for ${cleanEmail}, owner notified (resend ${sent.id})`);
    } catch (sendErr) {
      // If delivery fails, drop what we just stored. Otherwise the request
      // sits there unseen and the visitor cannot retry for 30 days, because
      // the duplicate check would find the stale marker.
      await redis.del(`request:${request.id}`);
      await redis.del(`pending:${cleanEmail}`);
      throw sendErr;
    }

    return res.status(200).json({
      ok: true,
      message: "Request received. We will be in touch.",
    });
  } catch (err) {
    console.error("request-access error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}

// Emails the owner everything the visitor typed, with the management links.
function notifyOwner(request) {
  // The token is scoped to this request: if the email gets forwarded, it
  // cannot be used on anyone else.
  const base = process.env.BASE_URL;
  const query = `id=${encodeURIComponent(request.id)}&token=${encodeURIComponent(request.token)}`;
  const approveUrl = `${base}/api/approve?${query}`;
  const declineUrl = `${base}/api/reject?${query}`;

  // Replying to this email writes straight to the applicant.
  return sendEmail({
    to: process.env.OWNER_EMAIL,
    replyTo: request.email,
    subject: `New access request — ${request.name}`,
    html: emailLayout(`
      <div style="font-family: Georgia, serif; max-width: 520px; margin: 0 auto; padding: 40px 24px; color: #1a1a1a;">
        <h2 style="font-weight: normal; letter-spacing: 2px; text-transform: uppercase; font-size: 16px;">Txoko</h2>
        <p style="font-size: 15px; line-height: 1.6;">New access request:</p>
        ${detailsCardHtml(request)}
        <div style="margin-top: 32px;">
          <a href="${approveUrl}" style="display: inline-block; background: #1a1a1a; color: #ffffff; padding: 12px 28px; text-decoration: none; font-size: 13px; letter-spacing: 1px; text-transform: uppercase;">Approve</a>
          &nbsp;&nbsp;
          <a href="${declineUrl}" style="display: inline-block; border: 1px solid #1a1a1a; color: #1a1a1a; padding: 11px 28px; text-decoration: none; font-size: 13px; letter-spacing: 1px; text-transform: uppercase;">Decline</a>
        </div>
        <p style="font-size: 12px; color: #999; margin-top: 28px;">Each link asks you to confirm before anything happens. Replying to this email writes to ${escapeHtml(request.name)} directly.</p>
      </div>
    `),
  });
}
