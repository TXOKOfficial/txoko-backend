// lib/utils.js — helpers compartidos por los 4 endpoints

import { Redis } from "@upstash/redis";
import crypto from "node:crypto";

// ── Redis (Upstash, via Marketplace de Vercel) ────────
// Segun como se vincule la base, Vercel inyecta las variables con
// prefijo UPSTASH_ o con el prefijo viejo KV_. Aceptamos las dos.
export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

// ── CORS ──────────────────────────────────────────────
// Solo acepta requests desde el dominio real (SITE_URL).
// Ojo: CORS es una regla del navegador, no una defensa del servidor.
// Lo que frena el abuso de verdad es el rate limit de mas abajo.
const ALLOWED_ORIGINS = [
  process.env.SITE_URL, // ej: https://txoko-dining.com
  // "https://tuproyecto.framer.website", // ← descomentar SOLO para testing
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
    return true; // ya respondimos
  }
  return false;
}

// ── Escape de HTML ────────────────────────────────────
// Todo dato que venga del visitante y termine dentro de un email
// tiene que pasar por aca. Si no, alguien puede escribir markup en el
// campo "nombre" y dibujar sus propios botones en el mail de Josu.
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// ── Resend ────────────────────────────────────────────
export async function sendEmail({ to, subject, html }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL, // ej: "Txoko <acceso@txoko-dining.com>"
      to,
      subject,
      html,
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Resend error: ${err}`);
  }
  return r.json();
}

// ── Generador de codigo de acceso ─────────────────────
// Formato: TXK-XXXXXX (sin caracteres ambiguos como 0/O, 1/I)
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateCode() {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return `TXK-${code}`;
}

// Token unico por solicitud, para los links de aprobar/rechazar.
export function generateToken() {
  return crypto.randomBytes(24).toString("base64url");
}

// Comparacion en tiempo constante, para no filtrar el token de a poco.
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── Validacion basica de email ────────────────────────
export function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ── Rate limit por IP ─────────────────────────────────
export function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded || "";
  return raw.split(",")[0].trim() || "unknown";
}

// Contador con ventana fija en Redis. Devuelve true si se permite.
export async function rateLimit(key, { max, windowSeconds }) {
  const hits = await redis.incr(key);
  if (hits === 1) await redis.expire(key, windowSeconds);
  return hits <= max;
}

// ── Paginas que ve Josu al gestionar una solicitud ────
export function page(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Txoko — Gestion de acceso</title></head>
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

// Pantalla de confirmacion. El link del email solo muestra esto; la accion
// recien ocurre cuando una persona aprieta el boton (POST). Asi los
// prefetchers de Gmail y Outlook no pueden aprobar solicitudes solos.
export function confirmPage({ action, request, actionUrl }) {
  const isApprove = action === "approve";
  const verb = isApprove ? "Aprobar" : "Rechazar";
  return page(`
    <p style="font-size: 15px; line-height: 1.7; color: #333;">
      ¿${verb} la solicitud de<br/>
      <strong>${escapeHtml(request.name)}</strong><br/>
      <span style="color: #777;">${escapeHtml(request.email)}</span>?
    </p>
    <form method="POST" action="${escapeHtml(actionUrl)}" style="margin-top: 28px;">
      <button type="submit" style="cursor: pointer; background: ${isApprove ? "#1a1a1a" : "#ffffff"}; color: ${isApprove ? "#ffffff" : "#1a1a1a"}; border: 1px solid #1a1a1a; padding: 13px 32px; font-family: Georgia, serif; font-size: 13px; letter-spacing: 1px; text-transform: uppercase;">${verb}</button>
    </form>
  `);
}
