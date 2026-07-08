import type { Request, Response } from "express";

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

    const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
    const apiVersion = process.env.WHATSAPP_API_VERSION?.trim() || "v25.0";

    if (!token || !phoneNumberId) {
      res.status(500).json({
        ok: false,
        message:
          "Faltan variables de entorno: WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID",
      });
      return;
    }

    if (!to) {
      res.status(400).json({
        ok: false,
        message: "Falta el número destino en el campo 'to'",
      });
      return;
    }

    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body: message ?? "Mensaje de prueba desde GrupoEB",
      },
    };

    console.log("Payload enviado a Meta:", JSON.stringify(payload, null, 2));

    const respuestaMeta = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await respuestaMeta.json();

    if (!respuestaMeta.ok) {
      console.error("Error de Meta WhatsApp API:", data);

      res.status(respuestaMeta.status).json({
        ok: false,
        message: "Meta rechazó el envío del mensaje",
        error: data,
      });
      return;
    }

    res.status(200).json({
      ok: true,
      message: "Mensaje enviado correctamente",
      data,
    });
  } catch (error) {
    console.error("Error al enviar mensaje de WhatsApp:", error);

    res.status(500).json({
      ok: false,
      message: "Error interno al enviar mensaje de WhatsApp",
      error,
    });
  }
};