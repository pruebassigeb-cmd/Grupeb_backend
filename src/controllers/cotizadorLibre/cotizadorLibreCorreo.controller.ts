// src/controllers/cotizadorLibre/cotizadorLibreCorreo.controller.ts
import { Request, Response } from "express";
import { pool } from "../../config/db";
import { enviarCorreo } from "../../services/email/mailer";
import type {
  EnviarPdfCotizadorLibreRequest,
} from "../../types/cotizadorLibre/cotizadorLibreCorreo.types";

const ETIQUETA_TIPO: Record<"cotizacion" | "pedido", string> = {
  cotizacion: "cotización",
  pedido: "pedido",
};

// ==========================
// Envía el PDF ya generado (en el navegador) por correo — pero el
// DESTINATARIO se resuelve aquí, del lado del servidor, por clienteId. Nunca
// se confía en un correo que venga del frontend: rompería exactamente la
// protección de enmascarado que ya construimos en Fase 2 (buscarCliente
// nunca expone el correo completo de un cliente existente al navegador).
// ==========================
export const enviarPdfCotizadorLibre = async (req: Request, res: Response) => {
  try {
    const idsolicitud = Number(req.params.idsolicitud);
    const body = req.body as EnviarPdfCotizadorLibreRequest;

    if (!Number.isInteger(idsolicitud) || idsolicitud <= 0) {
      return res.status(400).json({ error: "idsolicitud inválido." });
    }
    if (body.tipo !== "cotizacion" && body.tipo !== "pedido") {
      return res.status(400).json({ error: "tipo debe ser 'cotizacion' o 'pedido'." });
    }
    if (!body.folio || !body.pdfBase64 || !body.nombreArchivo) {
      return res.status(400).json({ error: "Faltan datos del PDF a enviar." });
    }

    const { rows } = await pool.query(
      `SELECT c.correo, c.empresa, c.atencion
       FROM solicitud s
       JOIN clientes c ON c.idclientes = s.clientes_idclientes
       WHERE s.idsolicitud = $1`,
      [idsolicitud]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "No se encontró la solicitud." });
    }

    const correoDestino = rows[0].correo;
    if (!correoDestino) {
      return res.status(404).json({ error: "El cliente no tiene un correo registrado." });
    }

    const nombreCliente = rows[0].atencion || rows[0].empresa || "";
    const etiqueta = ETIQUETA_TIPO[body.tipo];
    const pdfBuffer = Buffer.from(body.pdfBase64, "base64");

    await enviarCorreo({
      para: correoDestino,
      asunto: `Tu ${etiqueta} ${body.folio} — Grupo EB`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color:#1e3a2b;">Grupo EB</h2>
          <p>${nombreCliente ? `Hola ${nombreCliente},` : "Hola,"}</p>
          <p>Adjunto encontrarás tu ${etiqueta} <b>${body.folio}</b>, generada desde nuestro Cotizador Interactivo.</p>
          <p style="color:#6b6f63; font-size: 13px;">Si tienes alguna duda, un asesor puede ayudarte con los siguientes pasos.</p>
        </div>
      `,
      adjuntos: [
        {
          filename: body.nombreArchivo,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    });

    console.log(`✅ PDF de ${body.tipo} ${body.folio} enviado a cliente (solicitud ${idsolicitud})`);

    return res.json({ enviado: true });
  } catch (error: any) {
    console.error("❌ ENVIAR PDF COTIZADOR LIBRE ERROR:", error.message);
    return res.status(500).json({ error: "No se pudo enviar el correo con el PDF." });
  }
};