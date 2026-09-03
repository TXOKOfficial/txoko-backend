// api/request-access.js
// Endpoint 1 — Receives the access request from the Framer gate, stores it in
// Redis and emails the owner with Approve / Decline links, each carrying its
// own one-off token.

import {
  redis,
  applyCors,
  sendEmail,
  isValidEmail,
  escapeHtml,
  cleanText,
  emailLayout,
  generateToken,
  clientIp,
  rateLimit,
} from "../lib/utils.js";

const THIRTY_DAYS = 60 * 60 * 24 * 30;

// Optional fields coming from the gate form, with the label shown in the
// owner's email and the maximum length accepted for each.
const DETAIL_FIELDS = [
  { key: "city", label: "City", maxLength: 80 },
  { key: "guests", label: "Guests", maxLength: 40 },
  { key: "month", label: "Preferred month", maxLength: 40 },
];

const MESSAGE_MAX_LENGTH = 1200;

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
      return res.status(429).json({
        error: "Too many requests. Please try again later.",
      });
    }

    const body = req.body || {};

    if (!body.name || !isValidEmail(body.email)) {
      return res.status(400).json({ error: "Name and a valid email are required." });
    }

    const cleanEmail = body.email.toLowerCase().trim();

    // Avoid duplicate requests from the same email
    const existing = await redis.get(`pending:${cleanEmail}`);
    if (existing) {
      return res.status(200).json({
        ok: true,
        message: "We have already received your request. We will be in touch.",
      });
    }

    // Store the request (expires in 30 days if nobody handles it)
    const requestId = crypto.randomUUID();
    const request = {
      id: requestId,
      name: cleanText(body.name, 80),
      email: cleanEmail,
      token: generateToken(), // unique key for this request
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    for (const field of DETAIL_FIELDS) {
      const value = cleanText(body[field.key], field.maxLength);
      if (value) request[field.key] = value;
    }
    const visitorMessage = cleanText(body.message, MESSAGE_MAX_LENGTH);
    if (visitorMessage) request.message = visitorMessage;

    await redis.set(`request:${requestId}`, request, { ex: THIRTY_DAYS });
    await redis.set(`pending:${cleanEmail}`, requestId, { ex: THIRTY_DAYS });

    // Management links for the owner. The token is scoped to this request:
    // if the email gets forwarded, it cannot be used on anyone else.
    const base = process.env.BASE_URL;
    const query = `id=${requestId}&token=${request.token}`;
    const approveUrl = `${base}/api/approve?${query}`;
    const declineUrl = `${base}/api/reject?${query}`;

    // Everything the visitor typed, so the owner can decide without having to
    // write back and ask.
    const detailRows = DETAIL_FIELDS.filter((field) => request[field.key])
      .map(
        (field) =>
          `<tr>
            <td style="padding: 2px 12px 2px 0; color: #8a8378; font-size: 13px; white-space: nowrap;">${field.label}</td>
            <td style="padding: 2px 0; font-size: 14px;">${escapeHtml(request[field.key])}</td>
          </tr>`
      )
      .join("");

    const messageBlock = request.message
      ? `<p style="font-size: 14px; line-height: 1.7; color: #444; margin: 20px 0 0; padding-left: 14px; border-left: 2px solid #e2ddd4; font-style: italic;">${escapeHtml(request.message)}</p>`
      : "";

    // Replying to this email writes straight to the applicant.
    await sendEmail({
      to: process.env.OWNER_EMAIL,
      replyTo: cleanEmail,
      subject: `New access request — ${request.name}`,
      html: emailLayout(`
        <div style="font-family: Georgia, serif; max-width: 520px; margin: 0 auto; padding: 40px 24px; color: #1a1a1a;">
          <h2 style="font-weight: normal; letter-spacing: 2px; text-transform: uppercase; font-size: 16px;">Txoko</h2>
          <p style="font-size: 15px; line-height: 1.6;">New access request:</p>
          <div style="background: #f7f5f2; padding: 20px 24px; border-left: 3px solid #b8963e;">
            <p style="margin: 0 0 12px; font-size: 16px;">
              <strong>${escapeHtml(request.name)}</strong><br/>
              <a href="mailto:${escapeHtml(request.email)}" style="color: #6b6255; font-size: 14px;">${escapeHtml(request.email)}</a>
            </p>
            ${detailRows ? `<table style="border-collapse: collapse;">${detailRows}</table>` : ""}
            ${messageBlock}
          </div>
          <div style="margin-top: 32px;">
            <a href="${approveUrl}" style="display: inline-block; background: #1a1a1a; color: #ffffff; padding: 12px 28px; text-decoration: none; font-size: 13px; letter-spacing: 1px; text-transform: uppercase;">Approve</a>
            &nbsp;&nbsp;
            <a href="${declineUrl}" style="display: inline-block; border: 1px solid #1a1a1a; color: #1a1a1a; padding: 11px 28px; text-decoration: none; font-size: 13px; letter-spacing: 1px; text-transform: uppercase;">Decline</a>
          </div>
          <p style="font-size: 12px; color: #999; margin-top: 28px;">Each link asks you to confirm before anything happens. Replying to this email writes to ${escapeHtml(request.name)} directly.</p>
        </div>
      `),
    }).catch(async (sendErr) => {
      // If delivery fails, drop what we just stored. Otherwise the request
      // sits there unseen and the visitor cannot retry for 30 days, because
      // the duplicate check would find the stale marker.
      await redis.del(`request:${requestId}`);
      await redis.del(`pending:${cleanEmail}`);
      throw sendErr;
    });

    return res.status(200).json({
      ok: true,
      message: "Request received. We will be in touch.",
    });
  } catch (err) {
    console.error("request-access error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
