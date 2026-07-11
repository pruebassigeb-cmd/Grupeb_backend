import type { Request, Response } from "express";

import {
  enviarPayloadMeta,
  limpiarTextoWhatsapp,
  responderResultadoEnvio,
} from "../../services/whatsapp/whatsapp.services";

import {
  WHATSAPP_TEMPLATES,
  buildBodyComponent,
  buildDocumentHeaderComponent,
} from "./whatsapp.templates";

// ──────────────────────────────────────────────────────────
// Mensaje de texto libre (sin cambios, útil para pruebas rápidas)
// ──────────────────────────────────────────────────────────
interface EnviarPruebaWhatsappBody {
  to?: string;
  message?: string;
}

export const enviarPruebaWhatsapp = async (
  req: Request<{}, {}, EnviarPruebaWhatsappBody>,
  res: Response
): Promise<void> => {
  try {
    const body = req.body ?? {};
    const { to, message } = body;

    if (!to) {
      res.status(400).json({
        ok: false,
        message: "Falta el número destino en el campo 'to'",
      });
      return;
    }

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body: message ?? "Mensaje de prueba desde GrupoEB",
      },
    };

    console.log("Payload texto WhatsApp:", JSON.stringify(payload, null, 2));

    const respuesta = await enviarPayloadMeta(payload);
    responderResultadoEnvio(
      res,
      respuesta,
      "Mensaje enviado correctamente",
      "Meta rechazó el envío del mensaje"
    );
  } catch (error: any) {
    console.error("Error al enviar mensaje de WhatsApp:", error);
    res.status(500).json({
      ok: false,
      message: error.message ?? "Error interno al enviar mensaje de WhatsApp",
    });
  }
};

// ──────────────────────────────────────────────────────────
// 1. Agradecimiento por registro en expo — Marketing
//    Sin header de documento. El botón URL ya es estático en la plantilla.
// ──────────────────────────────────────────────────────────
interface EnviarAgradecimientoBody {
  to?: string;
  nombreContacto?: string;
}

export const enviarAgradecimientoExpo = async (
  req: Request<{}, {}, EnviarAgradecimientoBody>,
  res: Response
): Promise<void> => {
  try {
    const { to } = req.body ?? {};

    if (!to) {
      res.status(400).json({
        ok: false,
        message: "Falta el número destino en el campo 'to'",
      });
      return;
    }

    const nombreContacto = limpiarTextoWhatsapp(req.body?.nombreContacto, "cliente");

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: WHATSAPP_TEMPLATES.AGRADECIMIENTO_EXPO.name,
        language: { code: WHATSAPP_TEMPLATES.AGRADECIMIENTO_EXPO.language },
        components: [buildBodyComponent([nombreContacto])],
      },
    };

    console.log("Payload agradecimiento expo:", JSON.stringify(payload, null, 2));

    const respuesta = await enviarPayloadMeta(payload);
    responderResultadoEnvio(
      res,
      respuesta,
      "Agradecimiento enviado correctamente",
      "Meta rechazó el envío del agradecimiento"
    );
  } catch (error: any) {
    console.error("Error al enviar agradecimiento por WhatsApp:", error);
    res.status(500).json({
      ok: false,
      message: error.message ?? "Error interno al enviar agradecimiento",
    });
  }
};

// ──────────────────────────────────────────────────────────
// 2. Cotización enviada — Utilidad
// ──────────────────────────────────────────────────────────
interface EnviarCotizacionBody {
  to?: string;
  documentoUrl?: string;
  documentoNombre?: string;
  nombreContacto?: string;
  folio?: string;
  clienteEmpresa?: string;
}

export const enviarCotizacion = async (
  req: Request<{}, {}, EnviarCotizacionBody>,
  res: Response
): Promise<void> => {
  try {
    const { to, documentoUrl, documentoNombre } = req.body ?? {};

    if (!to) {
      res.status(400).json({ ok: false, message: "Falta el número destino en el campo 'to'" });
      return;
    }
    if (!documentoUrl) {
      res.status(400).json({ ok: false, message: "Falta documentoUrl" });
      return;
    }
    if (!documentoNombre) {
      res.status(400).json({ ok: false, message: "Falta documentoNombre" });
      return;
    }

    const nombreContacto = limpiarTextoWhatsapp(req.body?.nombreContacto, "cliente");
    const folio = limpiarTextoWhatsapp(req.body?.folio, "sin folio");
    const clienteEmpresa = limpiarTextoWhatsapp(req.body?.clienteEmpresa, "cliente GrupoEB");

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: WHATSAPP_TEMPLATES.COTIZACION.name,
        language: { code: WHATSAPP_TEMPLATES.COTIZACION.language },
        components: [
          buildDocumentHeaderComponent(documentoUrl, documentoNombre),
          buildBodyComponent([nombreContacto, folio, clienteEmpresa]),
        ],
      },
    };

    console.log("Payload cotización:", JSON.stringify(payload, null, 2));

    const respuesta = await enviarPayloadMeta(payload);
    responderResultadoEnvio(
      res,
      respuesta,
      "Cotización enviada correctamente",
      "Meta rechazó el envío de la cotización"
    );
  } catch (error: any) {
    console.error("Error al enviar cotización por WhatsApp:", error);
    res.status(500).json({
      ok: false,
      message: error.message ?? "Error interno al enviar cotización",
    });
  }
};

// ──────────────────────────────────────────────────────────
// 3. Pedido para autorización de fabricación — Utilidad
// ──────────────────────────────────────────────────────────
interface EnviarPedidoAutorizacionBody {
  to?: string;
  documentoUrl?: string;
  documentoNombre?: string;
  nombreContacto?: string;
  folio?: string;
  clienteEmpresa?: string;
}

export const enviarPedidoAutorizacion = async (
  req: Request<{}, {}, EnviarPedidoAutorizacionBody>,
  res: Response
): Promise<void> => {
  try {
    const { to, documentoUrl, documentoNombre } = req.body ?? {};

    if (!to) {
      res.status(400).json({ ok: false, message: "Falta el número destino en el campo 'to'" });
      return;
    }
    if (!documentoUrl) {
      res.status(400).json({ ok: false, message: "Falta documentoUrl" });
      return;
    }
    if (!documentoNombre) {
      res.status(400).json({ ok: false, message: "Falta documentoNombre" });
      return;
    }

    const nombreContacto = limpiarTextoWhatsapp(req.body?.nombreContacto, "cliente");
    const folio = limpiarTextoWhatsapp(req.body?.folio, "sin folio");
    const clienteEmpresa = limpiarTextoWhatsapp(req.body?.clienteEmpresa, "cliente GrupoEB");

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: WHATSAPP_TEMPLATES.PEDIDO_AUTORIZACION.name,
        language: { code: WHATSAPP_TEMPLATES.PEDIDO_AUTORIZACION.language },
        components: [
          buildDocumentHeaderComponent(documentoUrl, documentoNombre),
          buildBodyComponent([nombreContacto, folio, clienteEmpresa]),
        ],
      },
    };

    console.log("Payload pedido autorización:", JSON.stringify(payload, null, 2));

    const respuesta = await enviarPayloadMeta(payload);
    responderResultadoEnvio(
      res,
      respuesta,
      "Pedido enviado correctamente para autorización",
      "Meta rechazó el envío del pedido"
    );
  } catch (error: any) {
    console.error("Error al enviar pedido por WhatsApp:", error);
    res.status(500).json({
      ok: false,
      message: error.message ?? "Error interno al enviar pedido",
    });
  }
};

// ──────────────────────────────────────────────────────────
// 4. Actualización de cotización/pedido — Utilidad (genérica)
//    {{2}} recibe el texto libre "cotización" o "pedido" según el caso.
// ──────────────────────────────────────────────────────────
interface EnviarActualizacionBody {
  to?: string;
  documentoUrl?: string;
  documentoNombre?: string;
  nombreContacto?: string;
  tipoDocumento?: string; // "cotización" | "pedido"
  folio?: string;
  clienteEmpresa?: string;
}

export const enviarActualizacion = async (
  req: Request<{}, {}, EnviarActualizacionBody>,
  res: Response
): Promise<void> => {
  try {
    const { to, documentoUrl, documentoNombre } = req.body ?? {};

    if (!to) {
      res.status(400).json({ ok: false, message: "Falta el número destino en el campo 'to'" });
      return;
    }
    if (!documentoUrl) {
      res.status(400).json({ ok: false, message: "Falta documentoUrl" });
      return;
    }
    if (!documentoNombre) {
      res.status(400).json({ ok: false, message: "Falta documentoNombre" });
      return;
    }

    const nombreContacto = limpiarTextoWhatsapp(req.body?.nombreContacto, "cliente");
    const tipoDocumento = limpiarTextoWhatsapp(req.body?.tipoDocumento, "documento");
    const folio = limpiarTextoWhatsapp(req.body?.folio, "sin folio");
    const clienteEmpresa = limpiarTextoWhatsapp(req.body?.clienteEmpresa, "cliente GrupoEB");

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: WHATSAPP_TEMPLATES.ACTUALIZACION.name,
        language: { code: WHATSAPP_TEMPLATES.ACTUALIZACION.language },
        components: [
          buildDocumentHeaderComponent(documentoUrl, documentoNombre),
          buildBodyComponent([nombreContacto, tipoDocumento, folio, clienteEmpresa]),
        ],
      },
    };

    console.log("Payload actualización:", JSON.stringify(payload, null, 2));

    const respuesta = await enviarPayloadMeta(payload);
    responderResultadoEnvio(
      res,
      respuesta,
      "Actualización enviada correctamente",
      "Meta rechazó el envío de la actualización"
    );
  } catch (error: any) {
    console.error("Error al enviar actualización por WhatsApp:", error);
    res.status(500).json({
      ok: false,
      message: error.message ?? "Error interno al enviar actualización",
    });
  }
};

// ──────────────────────────────────────────────────────────
// Plantilla de prueba técnica (documento_grupeb) — NO usar en flujos reales.
// Se conserva solo por si necesitas volver a diagnosticar el envío crudo
// de un documento genérico.
// ──────────────────────────────────────────────────────────
interface EnviarDocumentoPruebaBody {
  to?: string;
  documentoUrl?: string;
  documentoNombre?: string;
  nombreContacto?: string;
  tipoDocumento?: string;
  folio?: string;
  clienteEmpresa?: string;
}

export const enviarDocumentoPrueba = async (
  req: Request<{}, {}, EnviarDocumentoPruebaBody>,
  res: Response
): Promise<void> => {
  try {
    const body = req.body ?? {};
    const { to, documentoUrl, documentoNombre } = body;

    if (!to) {
      res.status(400).json({ ok: false, message: "Falta el número destino en el campo 'to'" });
      return;
    }
    if (!documentoUrl) {
      res.status(400).json({ ok: false, message: "Falta documentoUrl" });
      return;
    }
    if (!documentoNombre) {
      res.status(400).json({ ok: false, message: "Falta documentoNombre" });
      return;
    }

    const nombreContacto = limpiarTextoWhatsapp(body.nombreContacto, "cliente");
    const tipoDocumento = limpiarTextoWhatsapp(body.tipoDocumento, "documento");
    const folio = limpiarTextoWhatsapp(body.folio, "sin folio");
    const clienteEmpresa = limpiarTextoWhatsapp(body.clienteEmpresa, "cliente GrupoEB");

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: WHATSAPP_TEMPLATES.DOCUMENTO_PRUEBA.name,
        language: { code: WHATSAPP_TEMPLATES.DOCUMENTO_PRUEBA.language },
        components: [
          buildDocumentHeaderComponent(documentoUrl, documentoNombre),
          buildBodyComponent([nombreContacto, tipoDocumento, folio, clienteEmpresa]),
        ],
      },
    };

    console.log("Payload documento prueba:", JSON.stringify(payload, null, 2));

    const respuesta = await enviarPayloadMeta(payload);
    responderResultadoEnvio(
      res,
      respuesta,
      "Documento de prueba enviado correctamente",
      "Meta rechazó el envío del documento de prueba"
    );
  } catch (error: any) {
    console.error("Error al enviar documento de prueba por WhatsApp:", error);
    res.status(500).json({
      ok: false,
      message: error.message ?? "Error interno al enviar documento de prueba",
    });
  }
};

// Alias para no romper código existente que aún importe el nombre anterior.
export const enviarDocumentoWhatsapp = enviarDocumentoPrueba;