import type { Request, Response } from "express";

export const verificarWebhookWhatsapp = (req: Request, res: Response): void => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (!verifyToken) {
    console.error("Falta WHATSAPP_VERIFY_TOKEN en el .env");
    res.sendStatus(500);
    return;
  }

  if (
    mode === "subscribe" &&
    token === verifyToken &&
    typeof challenge === "string"
  ) {
    console.log("Webhook de WhatsApp verificado correctamente");
    res.status(200).send(challenge);
    return;
  }

  console.warn("Token de verificación inválido");
  res.sendStatus(403);
};

export const recibirWebhookWhatsapp = (req: Request, res: Response): void => {
  try {
    const body = req.body;

    console.log("Webhook WhatsApp recibido:");
    console.log(JSON.stringify(body, null, 2));

    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const mensaje = value?.messages?.[0];

    if (mensaje) {
      const telefonoCliente = mensaje.from;
      const texto = mensaje.text?.body;

      console.log("Mensaje recibido de:", telefonoCliente);
      console.log("Texto recibido:", texto ?? "Mensaje sin texto");
    }

    res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    console.error("Error al recibir webhook de WhatsApp:", error);
    res.sendStatus(500);
  }
};