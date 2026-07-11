export interface WhatsappConfig {
  token?: string;
  phoneNumberId?: string;
  apiVersion: string;
}

export const getWhatsappConfig = (): WhatsappConfig => {
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const apiVersion = process.env.WHATSAPP_API_VERSION?.trim() || "v25.0";

  return {
    token,
    phoneNumberId,
    apiVersion,
  };
};

export interface RespuestaMeta {
  ok: boolean;
  status: number;
  data: any;
}

/**
 * Envía cualquier payload (texto o template) al endpoint /messages de Meta.
 * Centralizado aquí para no repetir la llamada fetch en cada controlador.
 */
export const enviarPayloadMeta = async (payload: unknown): Promise<RespuestaMeta> => {
  const { token, phoneNumberId, apiVersion } = getWhatsappConfig();

  if (!token || !phoneNumberId) {
    throw new Error(
      "Faltan variables de entorno: WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID"
    );
  }

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  const respuestaMeta = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await respuestaMeta.json();

  return {
    ok: respuestaMeta.ok,
    status: respuestaMeta.status,
    data,
  };
};

export const limpiarTextoWhatsapp = (valor: unknown, fallback: string): string => {
  if (typeof valor !== "string") return fallback;

  const limpio = valor.trim();

  return limpio.length > 0 ? limpio : fallback;
};

/**
 * Respuesta HTTP estándar para cualquier endpoint que envíe un mensaje/template.
 * Evita repetir el if/else de éxito-error en cada función del controlador.
 */
export const responderResultadoEnvio = (
  res: import("express").Response,
  respuesta: RespuestaMeta,
  mensajeOk: string,
  mensajeError: string
): void => {
  if (!respuesta.ok) {
    res.status(respuesta.status).json({
      ok: false,
      message: mensajeError,
      error: respuesta.data,
    });
    return;
  }

  res.status(200).json({
    ok: true,
    message: mensajeOk,
    data: respuesta.data,
  });
};