// lib/utils.js — helpers shared by the four endpoints

import { Redis } from "@upstash/redis";
import crypto from "node:crypto";

// ── Redis (Upstash, through the Vercel Marketplace) ───
// Depending on how the store was linked, Vercel injects either the UPSTASH_
// prefixed variables or the older KV_ ones. Accept both.
export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

// ── CORS ──────────────────────────────────────────────
// Only accepts requests from the real domain (SITE_URL).
// Note: CORS is a browser rule, not a server-side defense. What actually
// stops abuse is the rate limiting further down.
const ALLOWED_ORIGINS = [
  process.env.SITE_URL, // e.g. https://txoko-dining.com
  // "https://yourproject.framer.website", // ← uncomment for testing ONLY
].filter(Boolean);

export function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Preflight
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true; // already answered
  }
  return false;
}

// ── HTML escaping ─────────────────────────────────────
// Every visitor-supplied value must go through this before landing in email
// HTML. Without it, the "name" field can inject markup into the owner's
// inbox, including a fake approve button.
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// Trim, cap the length and drop control characters from free-text input.
export function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

// ── Email delivery (Resend) ───────────────────────────
// FROM_EMAIL is an address on the verified domain and does NOT need a mailbox
// behind it: Resend signs and sends regardless. But replies to it would
// bounce, so every message carries a Reply-To pointing at a real inbox.
export async function sendEmail({ to, subject, html, replyTo }) {
  const replyAddress = replyTo || process.env.REPLY_TO || process.env.OWNER_EMAIL;

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      // The charset is explicit on purpose: accented names arrived mangled
      // when it was left to the default.
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL, // e.g. "Txoko <access@txoko-dining.com>"
      to,
      subject,
      html,
      ...(replyAddress ? { reply_to: replyAddress } : {}),
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Resend error: ${err}`);
  }
  return r.json();
}

// Wraps email content in a full document. The charset declaration matters:
// without it, mail clients guess, and names like "Beltrán" render broken.
export function emailLayout(innerHtml) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin: 0; background: #ffffff;">
${innerHtml}
</body></html>`;
}

// ── Access code generator ─────────────────────────────
// Format: TXK-XXXXXX, with no ambiguous characters (no 0/O, no 1/I).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateCode() {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return `TXK-${code}`;
}

// One-off token per request, used in the approve/decline links.
export function generateToken() {
  return crypto.randomBytes(24).toString("base64url");
}

// Constant-time comparison, so the token cannot be guessed byte by byte.
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── Basic email validation ────────────────────────────
export function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ── Per-IP rate limiting ──────────────────────────────
export function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded || "";
  return raw.split(",")[0].trim() || "unknown";
}

// Fixed-window counter in Redis. Returns true when the request is allowed.
export async function rateLimit(key, { max, windowSeconds }) {
  const hits = await redis.incr(key);
  if (hits === 1) await redis.expire(key, windowSeconds);
  return hits <= max;
}

// ── Pages the owner sees when handling a request ──────
export function page(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Txoko — Access management</title></head>
<body style="font-family: Georgia, serif; background: #f7f5f2; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0;">
  <div style="text-align: center; padding: 40px; max-width: 420px;">
    <h1 style="font-weight: normal; letter-spacing: 3px; text-transform: uppercase; font-size: 16px; color: #1a1a1a;">Txoko</h1>
    ${bodyHtml}
  </div>
</body></html>`;
}

export function message(text) {
  return page(`<p style="font-size: 15px; line-height: 1.7; color: #333;">${text}</p>`);
}

// Confirmation screen. The link in the email only renders this; the action
// happens when a person presses the button (POST). That way Gmail and Outlook
// link scanners cannot approve requests on their own.
export function confirmPage({ action, request, actionUrl }) {
  const isApprove = action === "approve";
  const verb = isApprove ? "Approve" : "Decline";
  return page(`
    <p style="font-size: 15px; line-height: 1.7; color: #333;">
      ${verb} the request from<br/>
      <strong>${escapeHtml(request.name)}</strong><br/>
      <span style="color: #777;">${escapeHtml(request.email)}</span>?
    </p>
    <form method="POST" action="${escapeHtml(actionUrl)}" style="margin-top: 28px;">
      <button type="submit" style="cursor: pointer; background: ${isApprove ? "#1a1a1a" : "#ffffff"}; color: ${isApprove ? "#ffffff" : "#1a1a1a"}; border: 1px solid #1a1a1a; padding: 13px 32px; font-family: Georgia, serif; font-size: 13px; letter-spacing: 1px; text-transform: uppercase;">${verb}</button>
    </form>
  `);
}
