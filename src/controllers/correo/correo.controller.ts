// src/controllers/correo/correo.controller.ts
import { Request, Response } from "express";
import { pool } from "../../config/db";
import { enviarCorreo } from "../../services/email/mailer";
import { armarAsuntoDocumento, armarHtmlDocumento } from "../../services/email/templates/documentoEmail";

const MAX_PDF_BYTES = 8 * 1024 * 1024; // 8MB de margen — un PDF de estos nunca debería acercarse a esto

// Copia interna de todo documento enviado a un cliente (cotización, pedido
// o agradecimiento de Expo) — para verificar que el envío se completó y ver
// exactamente qué está recibiendo el cliente de nuestra parte.
const CORREO_COPIA_INTERNA = "sistemaeb@grupoeb.com.mx";

export const enviarCorreoDocumento = async (req: Request, res: Response) => {
  try {
    const {
      tipo,           // "cotizacion" | "pedido"
      folio,          // no_cotizacion o no_pedido
      cliente,        // nombre para el saludo
      empresa,        // opcional
      destinatario,   // correo del cliente (puede venir editado por el usuario en el modal de envío)
      pdfBase64,      // el PDF ya generado en el frontend
      nombreArchivo,  // ej. "Cotizacion_COT26001.pdf"
    } = req.body;

    if (!tipo || !["cotizacion", "pedido", "agradecimiento"].includes(tipo)) {
  return res.status(400).json({ error: "tipo debe ser 'cotizacion', 'pedido' o 'agradecimiento'" });
}
    if (!folio?.trim()) return res.status(400).json({ error: "Se requiere folio" });
    if (!destinatario?.trim()) return res.status(400).json({ error: "Se requiere destinatario" });
    if (!pdfBase64) return res.status(400).json({ error: "Se requiere el PDF (pdfBase64)" });

    // Validación básica de correo — evitamos mandar a direcciones basura
    const correoValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destinatario.trim());
    if (!correoValido) return res.status(400).json({ error: "El destinatario no es un correo válido" });

    const buffer = Buffer.from(pdfBase64, "base64");
    if (buffer.length > MAX_PDF_BYTES) {
      return res.status(400).json({ error: "El PDF excede el tamaño permitido" });
    }

    const asunto = armarAsuntoDocumento({ tipo, folio, cliente: cliente || "", empresa });
    const html = armarHtmlDocumento({ tipo, folio, cliente: cliente || "", empresa });

    await enviarCorreo({
      para: destinatario.trim(),
      bcc: CORREO_COPIA_INTERNA,
      asunto,
      html,
      adjuntos: [{
        filename: nombreArchivo || `${tipo === "pedido" ? "Pedido" : "Cotizacion"}_${folio}.pdf`,
        content: buffer,
        contentType: "application/pdf",
      }],
    });

    return res.json({ message: "Correo enviado correctamente" });
  } catch (e: any) {
    console.error("❌ ENVIAR CORREO ERROR:", e.message);
    return res.status(500).json({ error: "No se pudo enviar el correo", detalle: e.message });
  }
};