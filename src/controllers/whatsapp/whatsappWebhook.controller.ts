// src/controllers/whatsapp/whatsappWebhook.controller.ts

import { Request, Response } from "express";

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

export function verificarWebhookWhatsapp(req: Request, res: Response) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("🔎 Verificando webhook de WhatsApp:", {
    mode,
    token,
    challenge,
  });

  if (!VERIFY_TOKEN) {
    console.error("❌ Falta WHATSAPP_VERIFY_TOKEN en el .env");
    return res.status(500).send("Falta WHATSAPP_VERIFY_TOKEN en el .env");
  }

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook de WhatsApp verificado correctamente");
    return res.status(200).send(challenge);
  }

  console.warn("⚠️ Falló la verificación del webhook de WhatsApp");
  return res.sendStatus(403);
}

export function recibirWebhookWhatsapp(req: Request, res: Response) {
  try {
    const body = req.body;

    console.log("📩 Webhook recibido de WhatsApp:");
    console.log(JSON.stringify(body, null, 2));

    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const mensajes = value?.messages || [];
    const estados = value?.statuses || [];

    for (const mensaje of mensajes) {
      console.log("💬 Mensaje entrante:", {
        from: mensaje.from,
        id: mensaje.id,
        type: mensaje.type,
        text: mensaje.text?.body,
        timestamp: mensaje.timestamp,
      });
    }

    for (const estado of estados) {
      console.log("📌 Estado de mensaje:", {
        id: estado.id,
        status: estado.status,
        recipient_id: estado.recipient_id,
        timestamp: estado.timestamp,
      });
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error procesando webhook de WhatsApp:", error);

    // Meta espera 200 para no seguir reintentando indefinidamente.
    return res.sendStatus(200);
  }
}