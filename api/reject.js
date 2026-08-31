// api/reject.js
// Endpoint 3 — Josu abre el link "Rechazar" desde su email.
// Mismo esquema que approve: GET confirma, POST ejecuta.

import { redis, sendEmail, escapeHtml, safeEqual, message, confirmPage } from "../lib/utils.js";

export default async function handler(req, res) {
  const { id, token } = req.query;

  try {
    const request = await redis.get(`request:${id}`);

    if (!request || !safeEqual(token, request.token)) {
      return res.status(404).send(message("Solicitud no encontrada o link inválido."));
    }

    if (request.status !== "pending") {
      const label = request.status === "approved" ? "aprobada" : "rechazada";
      return res.status(200).send(message(`Esta solicitud ya fue gestionada (${label}).`));
    }

    // Paso 1: confirmacion humana.
    if (req.method !== "POST") {
      const actionUrl = `${process.env.BASE_URL}/api/reject?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
      return res.status(200).send(confirmPage({ action: "reject", request, actionUrl }));
    }

    // Paso 2: rechazar de verdad.
    request.status = "rejected";
    await redis.set(`request:${id}`, request);
    await redis.del(`pending:${request.email}`);

    await sendEmail({
      to: request.email,
      subject: "Sobre tu solicitud — Txoko",
      html: `
        <div style="font-family: Georgia, serif; max-width: 480px; margin: 0 auto; padding: 48px 24px; color: #1a1a1a; text-align: center;">
          <h2 style="font-weight: normal; letter-spacing: 3px; text-transform: uppercase; font-size: 18px; margin-bottom: 40px;">Txoko</h2>
          <p style="font-size: 15px; line-height: 1.8;">${escapeHtml(request.name)}, gracias por tu interés en Txoko.</p>
          <p style="font-size: 15px; line-height: 1.8;">Por el momento no podemos extenderte una invitación. Nuestra capacidad es muy limitada y las incorporaciones se dan en momentos puntuales del año.</p>
          <p style="font-size: 15px; line-height: 1.8;">Conservamos tu solicitud para futuras aperturas.</p>
        </div>
      `,
    });

    return res.status(200).send(message(`Rechazado. Se notificó a ${escapeHtml(request.email)}.`));
  } catch (err) {
    console.error("reject error:", err);
    return res.status(500).send(message("Error interno al procesar el rechazo."));
  }
}
