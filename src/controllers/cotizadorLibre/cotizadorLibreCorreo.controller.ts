// src/controllers/cotizadorLibre/cotizadorLibreCorreo.controller.ts
import { Request, Response } from "express";
import { pool } from "../../config/db";
import { enviarCorreo } from "../../services/email/mailer";
import { armarAsuntoDocumento, armarHtmlDocumento } from "../../services/email/templates/documentoEmail";
import type {
  EnviarPdfCotizadorLibreRequest,
} from "../../types/cotizadorLibre/cotizadorLibreCorreo.types";

const CORREO_COPIA_INTERNA = "sistemaeb@grupoeb.com.mx";

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
    const pdfBuffer = Buffer.from(body.pdfBase64, "base64");

    const datosDocumento = {
      tipo: body.tipo,
      folio: body.folio,
      cliente: nombreCliente,
      empresa: rows[0].empresa,
    };

    await enviarCorreo({
      para: correoDestino,
      bcc: CORREO_COPIA_INTERNA,
      asunto: armarAsuntoDocumento(datosDocumento),
      html: armarHtmlDocumento(datosDocumento),
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