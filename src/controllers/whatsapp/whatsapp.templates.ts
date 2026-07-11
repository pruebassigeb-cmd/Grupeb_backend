/**
 * Definición de las plantillas de WhatsApp de GrupoEB.
 * Cada plantilla puede sobreescribirse desde variables de entorno,
 * con un nombre por defecto igual al configurado hoy en Meta.
 */
export const WHATSAPP_TEMPLATES = {
  // Marketing — agradecimiento por registro en expo (sin header de documento)
  AGRADECIMIENTO_EXPO: {
    name: process.env.WHATSAPP_TEMPLATE_AGRADECIMIENTO?.trim() || "agradecimiento_grupoeb",
    language: process.env.WHATSAPP_TEMPLATE_AGRADECIMIENTO_LANGUAGE?.trim() || "es_MX",
  },
  // Utilidad — cotización enviada
  COTIZACION: {
    name: process.env.WHATSAPP_TEMPLATE_COTIZACION?.trim() || "cotizacion_grupeb",
    language: process.env.WHATSAPP_TEMPLATE_COTIZACION_LANGUAGE?.trim() || "es_MX",
  },
  // Utilidad — pedido para autorización de fabricación
  PEDIDO_AUTORIZACION: {
    name: process.env.WHATSAPP_TEMPLATE_PEDIDO?.trim() || "pedido_autorizacion_grupeb",
    language: process.env.WHATSAPP_TEMPLATE_PEDIDO_LANGUAGE?.trim() || "es_MX",
  },
  // Utilidad — actualización genérica de cotización/pedido
  ACTUALIZACION: {
    name: process.env.WHATSAPP_TEMPLATE_ACTUALIZACION?.trim() || "actualizacion_grupeb",
    language: process.env.WHATSAPP_TEMPLATE_ACTUALIZACION_LANGUAGE?.trim() || "es_MX",
  },
  // Solo prueba técnica — NO se usa en flujos reales con clientes
  DOCUMENTO_PRUEBA: {
    name: process.env.WHATSAPP_TEMPLATE_DOCUMENTO?.trim() || "documento_grupeb",
    language: process.env.WHATSAPP_TEMPLATE_DOCUMENTO_LANGUAGE?.trim() || "es_MX",
  },
} as const;

export const buildTextParam = (text: string) => ({
  type: "text" as const,
  text,
});

/**
 * Header con documento adjunto (PDF). Úsalo solo en plantillas que
 * tengan un header tipo "Documento" configurado en Meta.
 */
export const buildDocumentHeaderComponent = (link: string, filename: string) => ({
  type: "header" as const,
  parameters: [
    {
      type: "document" as const,
      document: { link, filename },
    },
  ],
});

/**
 * Body de texto. El orden del arreglo debe coincidir EXACTAMENTE con el
 * orden de las variables {{1}}, {{2}}, ... definidas en la plantilla aprobada.
 */
export const buildBodyComponent = (params: string[]) => ({
  type: "body" as const,
  parameters: params.map(buildTextParam),
});