// api/approve.js
// Endpoint 2 — The owner opens the "Approve" link from their email.
//
// GET  → renders a confirmation screen with a button.
// POST → only then generates the code, stores it and emails the applicant.
//
// The split matters: Gmail and Outlook visit links in messages on their own to
// scan them, so a GET that performs the action ends up approving by itself.

import {
  redis,
  sendEmail,
  generateCode,
  escapeHtml,
  safeEqual,
  acquireLock,
  message,
  confirmPage,
  emailLayout,
} from "../lib/utils.js";

export default async function handler(req, res) {
  const { id, token } = req.query;
  const lockKey = `lock:request:${id}`;
  let locked = false;

  try {
    const request = await redis.get(`request:${id}`);

    // Same response for "does not exist" and "bad token", so valid ids cannot
    // be discovered by probing.
    if (!request || !safeEqual(token, request.token)) {
      return res.status(404).send(message("Request not found, or this link is no longer valid."));
    }

    if (request.status === "approved") {
      return res
        .status(200)
        .send(message(`This request was already approved. Code: <strong>${escapeHtml(request.code)}</strong>`));
    }
    // Stored as "rejected" since the first version; only the wording shown to
    // the owner changed to "declined".
    if (request.status === "rejected") {
      return res.status(200).send(message("This request was already declined."));
    }

    // Step 1: human confirmation.
    if (req.method !== "POST") {
      const actionUrl = `${process.env.BASE_URL}/api/approve?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
      return res.status(200).send(confirmPage({ action: "approve", request, actionUrl }));
    }

    // Step 2: actually approve.
    locked = await acquireLock(lockKey);
    if (!locked) {
      return res.status(409).send(message("This request is already being processed. Reload this page in a moment."));
    }
    // Read again under the lock: a click that finished a moment ago may have
    // handled it after the first read.
    const current = await redis.get(`request:${id}`);
    if (!current || current.status !== "pending") {
      return res.status(200).send(message("This request was already handled. Open the link again to see its state."));
    }

    // Unique code (retries on collision, which is very unlikely)
    let code = generateCode();
    while (await redis.get(`code:${code}`)) {
      code = generateCode();
    }

    // Store the code with no expiry — access is permanent once granted
    await redis.set(`code:${code}`, {
      email: request.email,
      name: request.name,
      approvedAt: new Date().toISOString(),
    });

    // Email the applicant BEFORE marking the request as approved. If delivery
    // fails, the code is removed and the request stays pending, so the owner
    // can simply press Approve again. The other way round, a failed send left
    // a request marked approved whose code never reached anyone.
    const siteUrl = process.env.SITE_URL;
    let sent;
    try {
      sent = await sendEmail({
        to: request.email,
        subject: "Your access to Txoko",
        html: emailLayout(`
          <div style="font-family: Georgia, serif; max-width: 480px; margin: 0 auto; padding: 48px 24px; color: #1a1a1a; text-align: center;">
            <h2 style="font-weight: normal; letter-spacing: 3px; text-transform: uppercase; font-size: 18px; margin-bottom: 40px;">Txoko</h2>
            <p style="font-size: 15px; line-height: 1.7;">${escapeHtml(request.name)}, your request has been approved.</p>
            <p style="font-size: 15px; line-height: 1.7;">This is your personal access code:</p>
            <p style="font-size: 28px; letter-spacing: 6px; margin: 32px 0; padding: 20px; background: #f7f5f2; border: 1px solid #b8963e; font-family: monospace;">${code}</p>
            <a href="${siteUrl}" style="display: inline-block; margin-top: 16px; background: #1a1a1a; color: #ffffff; padding: 13px 32px; text-decoration: none; font-size: 13px; letter-spacing: 1px; text-transform: uppercase;">Enter</a>
            <p style="font-size: 12px; color: #999; margin-top: 40px;">This code is personal and non-transferable.</p>
          </div>
        `),
      });
    } catch (sendErr) {
      await redis.del(`code:${code}`);
      throw sendErr;
    }

    // Update the request state
    request.status = "approved";
    request.code = code;
    request.approvedAt = new Date().toISOString();
    await redis.set(`request:${id}`, request);
    await redis.del(`pending:${request.email}`);

    console.log(`approve: ${id} approved, code sent to ${request.email} (resend ${sent.id})`);
    return res
      .status(200)
      .send(message(`Approved. Code <strong>${code}</strong> was sent to ${escapeHtml(request.email)}.`));
  } catch (err) {
    console.error("approve error:", err);
    return res
      .status(500)
      .send(message("Something went wrong while processing the approval. Nothing was sent: go back and press Approve again."));
  } finally {
    if (locked) await redis.del(lockKey).catch(() => {});
  }
}
