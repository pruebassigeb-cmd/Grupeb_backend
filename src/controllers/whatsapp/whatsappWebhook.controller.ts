import type { Request, Response } from "express";

export const verificarWebhookWhatsapp = (req: Request, res: Response): void => {
  const mode = String(req.query["hub.mode"] ?? "");
  const token = String(req.query["hub.verify_token"] ?? "");
  const challenge = req.query["hub.challenge"];

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN?.trim();

  console.log("──── VERIFICANDO WEBHOOK WHATSAPP ────");
  console.log("method:", req.method);
  console.log("originalUrl:", req.originalUrl);
  console.log("mode:", mode);
  console.log("token recibido:", token);
  console.log("token .env:", verifyToken);
  console.log("coinciden:", token === verifyToken);
  console.log("challenge:", challenge);
  console.log("──────────────────────────────────────");

  // Si alguien abre la URL base sin parámetros, no es una verificación de Meta.
  if (!mode && !token && !challenge) {
    res.status(200).send("Webhook de WhatsApp activo");
    return;
  }

  if (!verifyToken) {
    console.error("❌ Falta WHATSAPP_VERIFY_TOKEN en el .env");
    res.sendStatus(500);
    return;
  }

  if (
    mode === "subscribe" &&
    token === verifyToken &&
    typeof challenge === "string"
  ) {
    console.log("✅ Webhook de WhatsApp verificado correctamente");
    res.status(200).send(challenge);
    return;
  }

  console.warn("❌ Token de verificación inválido");
  res.sendStatus(403);
};

export const recibirWebhookWhatsapp = (req: Request, res: Response): void => {
  try {
    let body = req.body;

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        console.warn("⚠️ El webhook llegó como texto, pero no era JSON válido");
      }
    }

    console.log("────────────────────────────────────");
    console.log("📩 WEBHOOK WHATSAPP RECIBIDO");
    console.log("method:", req.method);
    console.log("originalUrl:", req.originalUrl);
    console.log("content-type:", req.headers["content-type"]);
    console.log("content-length:", req.headers["content-length"]);
    console.log("body:", JSON.stringify(body, null, 2));
    console.log("────────────────────────────────────");

    if (!body || Object.keys(body).length === 0) {
      console.warn("⚠️ El webhook llegó sin body o vacío");
      res.status(200).send("EVENT_RECEIVED_EMPTY");
      return;
    }

    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const mensaje = value?.messages?.[0];

    if (mensaje) {
      console.log("💬 Mensaje entrante");
      console.log("De:", mensaje.from);
      console.log("Tipo:", mensaje.type);

      if (mensaje.text?.body) {
        console.log("Texto:", mensaje.text.body);
      }

      // Clic en botón de "respuesta rápida" (quick reply) de un template,
      // por ejemplo: "Recibido", "Autorizo producción", "Tengo cambios",
      // "Todo correcto", "Aún falta ajustar".
      if (mensaje.type === "button" && mensaje.button) {
        console.log("🔘 Respuesta rápida de plantilla");
        console.log("Texto del botón:", mensaje.button.text);
        console.log("Payload del botón:", mensaje.button.payload);
      }

      // Botón dentro de un mensaje interactivo (poco común para quick
      // replies de template, pero se deja por si se usan flujos interactivos).
      if (mensaje.type === "interactive" && mensaje.interactive?.button_reply) {
        console.log("🔘 Respuesta interactiva (button_reply)");
        console.log("ID:", mensaje.interactive.button_reply.id);
        console.log("Título:", mensaje.interactive.button_reply.title);
      }
    }

    const status = value?.statuses?.[0];

    if (status) {
      console.log("📌 Estatus de mensaje enviado");
      console.log("ID:", status.id);
      console.log("Estado:", status.status);
      console.log("Para:", status.recipient_id);
      console.log("Timestamp:", status.timestamp);

      if (status.errors) {
        console.log("❌ Errores:");
        console.log(JSON.stringify(status.errors, null, 2));
      }
    }

    res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    console.error("❌ Error al recibir webhook de WhatsApp:", error);
    res.sendStatus(500);
  }
};