// api/verify.js
// Endpoint 4 — The Framer gate sends the code the visitor typed.
// Answers whether it is valid.

import { redis, applyCors, clientIp, rateLimit } from "../lib/utils.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Brute-force brake: without this, codes can be guessed without limit.
    const ip = clientIp(req);
    const allowed = await rateLimit(`rl:verify:${ip}`, {
      max: 10,
      windowSeconds: 60 * 10,
    });
    if (!allowed) {
      return res.status(429).json({
        valid: false,
        error: "Too many attempts. Please wait a few minutes.",
      });
    }

    const { code } = req.body || {};
    if (!code || typeof code !== "string") {
      return res.status(400).json({ valid: false, error: "Access code required." });
    }

    const normalized = code.trim().toUpperCase();
    const entry = await redis.get(`code:${normalized}`);

    if (!entry) {
      return res.status(200).json({ valid: false });
    }

    // Record last use (useful for metrics and auditing)
    entry.lastUsedAt = new Date().toISOString();
    entry.uses = (entry.uses || 0) + 1;
    await redis.set(`code:${normalized}`, entry);

    return res.status(200).json({ valid: true });
  } catch (err) {
    console.error("verify error:", err);
    return res.status(500).json({ valid: false, error: "Something went wrong." });
  }
}
