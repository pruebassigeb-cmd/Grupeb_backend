// src/routes/whatsapp.routes.ts

import { Router } from "express";
import {
  verificarWebhookWhatsapp,
  recibirWebhookWhatsapp,
} from "../../controllers/whatsapp/whatsappWebhook.controller";

const router = Router();

router.get("/webhook", verificarWebhookWhatsapp);
router.post("/webhook", recibirWebhookWhatsapp);

export default router;