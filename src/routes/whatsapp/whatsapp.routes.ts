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
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";

const PERMISO = "externos.whatsapp.gestionar";
const router = Router();

// El webhook lo llama Meta, no un usuario de la app — se queda SIN
// authMiddleware a propósito. Su propia verificación (token de verify)
// vive dentro de verificarWebhookWhatsapp/recibirWebhookWhatsapp.
router.get("/webhook", verificarWebhookWhatsapp);
router.post("/webhook", recibirWebhookWhatsapp);

// Prueba de texto libre (sin plantilla)
router.post("/enviar-prueba", authMiddleware, checkPermiso(PERMISO), enviarPruebaWhatsapp);

// Flujos reales de negocio (uno por plantilla)
router.post("/enviar-agradecimiento", authMiddleware, checkPermiso(PERMISO), enviarAgradecimientoExpo);
router.post("/enviar-cotizacion", authMiddleware, checkPermiso(PERMISO), enviarCotizacion);
router.post("/enviar-pedido-autorizacion", authMiddleware, checkPermiso(PERMISO), enviarPedidoAutorizacion);
router.post("/enviar-actualizacion", authMiddleware, checkPermiso(PERMISO), enviarActualizacion);

// Plantilla de prueba técnica — NO usar en producción con clientes
router.post("/enviar-documento-prueba", authMiddleware, checkPermiso(PERMISO), enviarDocumentoPrueba);

export default router;