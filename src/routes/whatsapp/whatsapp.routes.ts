import { Router } from "express";

import {
  verificarWebhookWhatsapp,
  recibirWebhookWhatsapp,
} from "../../controllers/whatsapp/whatsappWebhook.controller";

import { enviarPruebaWhatsapp } from "../../controllers/whatsapp/whatsapp.controller";

const router = Router();

router.get("/webhook", verificarWebhookWhatsapp);
router.post("/webhook", recibirWebhookWhatsapp);

router.post("/enviar-prueba", enviarPruebaWhatsapp);

export default router;