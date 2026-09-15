// api/consultation.js
// Endpoint 5 — The "Request a Consultation" form on /services.
//
// It is the same Framer form as the access request, but whoever sends it is
// already inside the site. So instead of a new access request with Approve /
// Decline links, the owner gets a plain consultation email saying that this
// person already has access. Nothing is stored.

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
  clientIp,
  rateLimit,
} from "../lib/utils.js";

const CODE_PATTERN = /^TXK-[A-Z0-9]{6}$/;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Spam brake, same as the access request.
    const ip = clientIp(req);
    const allowed = await rateLimit(`rl:consultation:${ip}`, {
      max: 3,
      windowSeconds: 60 * 60,
    });
    if (!allowed) {
      console.warn(`consultation: rate limited ${ip}`);
      return res.status(429).json({
        error: "Too many requests. Please try again later.",
      });
    }

    const body = req.body || {};
    if (!body.name || !isValidEmail(body.email)) {
      return res.status(400).json({ error: "Name and a valid email are required." });
    }

    const consultation = {
      name: cleanText(body.name, 80),
      email: body.email.toLowerCase().trim(),
      ...readFormDetails(body),
    };

    // The access claim is checked against Redis, never taken from the page:
    // the snippet only passes along the code remembered in the browser.
    const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
    const access = CODE_PATTERN.test(code) ? await redis.get(`code:${code}`) : null;

    const sent = await sendEmail({
      to: process.env.OWNER_EMAIL,
      replyTo: consultation.email,
      subject: `Consultation request — ${consultation.name}`,
      html: emailLayout(`
        <div style="font-family: Georgia, serif; max-width: 520px; margin: 0 auto; padding: 40px 24px; color: #1a1a1a;">
          <h2 style="font-weight: normal; letter-spacing: 2px; text-transform: uppercase; font-size: 16px;">Txoko</h2>
          <p style="font-size: 15px; line-height: 1.6;">New consultation request:</p>
          ${accessNoteHtml(access, code, consultation.email)}
          ${detailsCardHtml(consultation)}
          <p style="font-size: 12px; color: #999; margin-top: 28px;">Sent from the consultation form on the site. Replying to this email writes to ${escapeHtml(consultation.name)} directly.</p>
        </div>
      `),
    });

    console.log(
      `consultation: from ${consultation.email}, access ${access ? code : "not confirmed"}, owner notified (resend ${sent.id})`
    );
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("consultation error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}

// The line above the details telling the owner whether this person already
// has access, and to whom the code was originally issued if it differs.
function accessNoteHtml(access, code, email) {
  const style =
    "margin: 0 0 16px; padding: 10px 14px; font-size: 13px; line-height: 1.6; border: 1px solid";

  if (!access) {
    return `<p style="${style} #e2ddd4; color: #6b6255;">No access code was found in this visitor's browser.</p>`;
  }

  const approvedOn = access.approvedAt
    ? new Date(access.approvedAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "America/Los_Angeles",
      })
    : "";
  const issuedTo =
    access.email && access.email !== email
      ? ` Issued to ${escapeHtml(access.name)} (${escapeHtml(access.email)}).`
      : "";

  return `<p style="${style} #b8963e; color: #1a1a1a; background: #fbf7ee;">
    <strong>Already has access</strong> with code ${escapeHtml(code)}${approvedOn ? `, approved ${approvedOn}` : ""}.${issuedTo}
  </p>`;
}
