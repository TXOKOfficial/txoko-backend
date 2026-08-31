// api/request-access.js
// Endpoint 1 — Recibe la solicitud de acceso desde el gate de Framer,
// la guarda en Redis y le manda un email a Josu con los links de
// Aprobar / Rechazar (cada uno con su token unico).

import {
  redis,
  applyCors,
  sendEmail,
  isValidEmail,
  escapeHtml,
  generateToken,
  clientIp,
  rateLimit,
} from "../lib/utils.js";

const THIRTY_DAYS = 60 * 60 * 24 * 30;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Freno al spam: sin esto cualquiera puede llenarle la casilla a Josu.
    const ip = clientIp(req);
    const allowed = await rateLimit(`rl:request:${ip}`, {
      max: 3,
      windowSeconds: 60 * 60,
    });
    if (!allowed) {
      return res.status(429).json({
        error: "Demasiadas solicitudes. Probá de nuevo más tarde.",
      });
    }

    const { name, email } = req.body || {};

    if (!name || !isValidEmail(email)) {
      return res.status(400).json({ error: "Nombre y email válido son requeridos." });
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanName = String(name).trim().slice(0, 80);

    // Evitar solicitudes duplicadas del mismo email
    const existing = await redis.get(`pending:${cleanEmail}`);
    if (existing) {
      return res.status(200).json({
        ok: true,
        message: "Ya recibimos tu solicitud. Te contactaremos pronto.",
      });
    }

    // Guardar la solicitud (expira en 30 dias si nadie la gestiona)
    const requestId = crypto.randomUUID();
    const request = {
      id: requestId,
      name: cleanName,
      email: cleanEmail,
      token: generateToken(), // llave unica de esta solicitud
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    await redis.set(`request:${requestId}`, request, { ex: THIRTY_DAYS });
    await redis.set(`pending:${cleanEmail}`, requestId, { ex: THIRTY_DAYS });

    // Links de gestion para Josu. El token vale solo para esta solicitud:
    // si el mail se reenvia, no sirve para aprobar a nadie mas.
    const base = process.env.BASE_URL;
    const query = `id=${requestId}&token=${request.token}`;
    const approveUrl = `${base}/api/approve?${query}`;
    const rejectUrl = `${base}/api/reject?${query}`;

    // Si el envio falla, borramos lo que acabamos de guardar. Si no, la
    // solicitud queda registrada pero nadie se entera de ella, y el
    // solicitante no puede reintentar durante 30 dias porque el sistema
    // lo toma como duplicado.
    try {
      await sendEmail({
        to: process.env.OWNER_EMAIL,
        subject: `Nueva solicitud de acceso — ${cleanName}`,
        html: `
          <div style="font-family: Georgia, serif; max-width: 480px; margin: 0 auto; padding: 40px 24px; color: #1a1a1a;">
            <h2 style="font-weight: normal; letter-spacing: 2px; text-transform: uppercase; font-size: 16px;">Txoko</h2>
            <p style="font-size: 15px; line-height: 1.6;">Nueva solicitud de acceso:</p>
            <p style="font-size: 15px; line-height: 1.8; background: #f7f5f2; padding: 16px 20px; border-left: 3px solid #b8963e;">
              <strong>${escapeHtml(cleanName)}</strong><br/>
              ${escapeHtml(cleanEmail)}
            </p>
            <div style="margin-top: 32px;">
              <a href="${approveUrl}" style="display: inline-block; background: #1a1a1a; color: #ffffff; padding: 12px 28px; text-decoration: none; font-size: 13px; letter-spacing: 1px; text-transform: uppercase;">Aprobar</a>
              &nbsp;&nbsp;
              <a href="${rejectUrl}" style="display: inline-block; border: 1px solid #1a1a1a; color: #1a1a1a; padding: 11px 28px; text-decoration: none; font-size: 13px; letter-spacing: 1px; text-transform: uppercase;">Rechazar</a>
            </div>
            <p style="font-size: 12px; color: #999; margin-top: 28px;">Cada link te va a pedir una confirmación antes de hacer nada.</p>
          </div>
        `,
      });
    } catch (sendErr) {
      await redis.del(`request:${requestId}`);
      await redis.del(`pending:${cleanEmail}`);
      throw sendErr;
    }

    return res.status(200).json({
      ok: true,
      message: "Solicitud recibida. Te contactaremos pronto.",
    });
  } catch (err) {
    console.error("request-access error:", err);
    return res.status(500).json({ error: "Error interno. Intentá de nuevo." });
  }
}
