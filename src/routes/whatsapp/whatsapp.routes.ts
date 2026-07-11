import { Router } from "express";

import {
  verificarWebhookWhatsapp,
  recibirWebhookWhatsapp,
} from "../../controllers/whatsapp/whatsappWebhook.controller";

import {
  enviarPruebaWhatsapp,
  enviarAgradecimientoExpo,
  enviarCotizacion,
  enviarPedidoAutorizacion,
  enviarActualizacion,
  enviarDocumentoPrueba,
} from "../../controllers/whatsapp/whatsapp.controller";

const router = Router();

router.get("/webhook", verificarWebhookWhatsapp);
router.post("/webhook", recibirWebhookWhatsapp);

// Prueba de texto libre (sin plantilla)
router.post("/enviar-prueba", enviarPruebaWhatsapp);

// Flujos reales de negocio (uno por plantilla)
router.post("/enviar-agradecimiento", enviarAgradecimientoExpo);
router.post("/enviar-cotizacion", enviarCotizacion);
router.post("/enviar-pedido-autorizacion", enviarPedidoAutorizacion);
router.post("/enviar-actualizacion", enviarActualizacion);

// Plantilla de prueba técnica — NO usar en producción con clientes
router.post("/enviar-documento-prueba", enviarDocumentoPrueba);

export default router;