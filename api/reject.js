// api/reject.js
// Endpoint 3 — The owner opens the "Decline" link from their email.
// Same shape as approve: GET confirms, POST executes.

import {
  redis,
  sendEmail,
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

    if (!request || !safeEqual(token, request.token)) {
      return res.status(404).send(message("Request not found, or this link is no longer valid."));
    }

    if (request.status !== "pending") {
      const label = request.status === "approved" ? "approved" : "declined";
      return res.status(200).send(message(`This request was already ${label}.`));
    }

    // Step 1: human confirmation.
    if (req.method !== "POST") {
      const actionUrl = `${process.env.BASE_URL}/api/reject?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
      return res.status(200).send(confirmPage({ action: "reject", request, actionUrl }));
    }

    // Step 2: actually decline.
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

    // Email first, then mark as declined: if delivery fails the request stays
    // pending and the owner can press Decline again.
    const sent = await sendEmail({
      to: request.email,
      subject: "Regarding your request — Txoko",
      html: emailLayout(`
        <div style="font-family: Georgia, serif; max-width: 480px; margin: 0 auto; padding: 48px 24px; color: #1a1a1a; text-align: center;">
          <h2 style="font-weight: normal; letter-spacing: 3px; text-transform: uppercase; font-size: 18px; margin-bottom: 40px;">Txoko</h2>
          <p style="font-size: 15px; line-height: 1.8;">${escapeHtml(request.name)}, thank you for your interest in Txoko.</p>
          <p style="font-size: 15px; line-height: 1.8;">We are not able to extend an invitation at this time. Our capacity is deliberately small, and new guests are welcomed only at a few select moments in the year.</p>
          <p style="font-size: 15px; line-height: 1.8;">We will keep your request on file for future openings.</p>
        </div>
      `),
    });

    request.status = "rejected";
    request.rejectedAt = new Date().toISOString();
    await redis.set(`request:${id}`, request);
    await redis.del(`pending:${request.email}`);

    console.log(`reject: ${id} declined, ${request.email} notified (resend ${sent.id})`);
    return res.status(200).send(message(`Declined. ${escapeHtml(request.email)} has been notified.`));
  } catch (err) {
    console.error("reject error:", err);
    return res
      .status(500)
      .send(message("Something went wrong while declining the request. Nothing was sent: go back and press Decline again."));
  } finally {
    if (locked) await redis.del(lockKey).catch(() => {});
  }
}
