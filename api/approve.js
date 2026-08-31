// api/approve.js
// Endpoint 2 — Josu abre el link "Aprobar" desde su email.
//
// GET  → muestra una pantalla de confirmacion con un boton.
// POST → recien ahi genera el codigo, lo guarda y se lo manda al solicitante.
//
// La separacion importa: Gmail y Outlook visitan solos los links de los
// mails para escanearlos. Si aprobar fuera un GET, aprobarian por su cuenta.

import {
  redis,
  sendEmail,
  generateCode,
  escapeHtml,
  safeEqual,
  message,
  confirmPage,
} from "../lib/utils.js";

export default async function handler(req, res) {
  const { id, token } = req.query;

  try {
    const request = await redis.get(`request:${id}`);

    // Mismo mensaje para "no existe" y "token invalido", para no revelar
    // cuales ids son reales.
    if (!request || !safeEqual(token, request.token)) {
      return res.status(404).send(message("Solicitud no encontrada o link inválido."));
    }

    if (request.status === "approved") {
      return res
        .status(200)
        .send(message(`Esta solicitud ya fue aprobada. Código: <strong>${escapeHtml(request.code)}</strong>`));
    }
    if (request.status === "rejected") {
      return res.status(200).send(message("Esta solicitud ya fue rechazada anteriormente."));
    }

    // Paso 1: confirmacion humana.
    if (req.method !== "POST") {
      const actionUrl = `${process.env.BASE_URL}/api/approve?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
      return res.status(200).send(confirmPage({ action: "approve", request, actionUrl }));
    }

    // Paso 2: aprobar de verdad.
    // Codigo unico (reintenta si colisiona, muy improbable)
    let code = generateCode();
    while (await redis.get(`code:${code}`)) {
      code = generateCode();
    }

    // Guardar codigo (sin expiracion — acceso permanente una vez aprobado)
    await redis.set(`code:${code}`, {
      email: request.email,
      name: request.name,
      approvedAt: new Date().toISOString(),
    });

    // Actualizar estado de la solicitud
    request.status = "approved";
    request.code = code;
    await redis.set(`request:${id}`, request);
    await redis.del(`pending:${request.email}`);

    // Email al solicitante con su codigo
    const siteUrl = process.env.SITE_URL;
    await sendEmail({
      to: request.email,
      subject: "Tu acceso a Txoko",
      html: `
        <div style="font-family: Georgia, serif; max-width: 480px; margin: 0 auto; padding: 48px 24px; color: #1a1a1a; text-align: center;">
          <h2 style="font-weight: normal; letter-spacing: 3px; text-transform: uppercase; font-size: 18px; margin-bottom: 40px;">Txoko</h2>
          <p style="font-size: 15px; line-height: 1.7;">${escapeHtml(request.name)}, tu solicitud fue aprobada.</p>
          <p style="font-size: 15px; line-height: 1.7;">Este es tu código de acceso personal:</p>
          <p style="font-size: 28px; letter-spacing: 6px; margin: 32px 0; padding: 20px; background: #f7f5f2; border: 1px solid #b8963e; font-family: monospace;">${code}</p>
          <a href="${siteUrl}" style="display: inline-block; margin-top: 16px; background: #1a1a1a; color: #ffffff; padding: 13px 32px; text-decoration: none; font-size: 13px; letter-spacing: 1px; text-transform: uppercase;">Ingresar</a>
          <p style="font-size: 12px; color: #999; margin-top: 40px;">Este código es personal e intransferible.</p>
        </div>
      `,
    });

    return res
      .status(200)
      .send(message(`Aprobado. Se envió el código <strong>${code}</strong> a ${escapeHtml(request.email)}.`));
  } catch (err) {
    console.error("approve error:", err);
    return res.status(500).send(message("Error interno al procesar la aprobación."));
  }
}
