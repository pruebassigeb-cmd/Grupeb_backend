import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

import {
  getBitacora,
  getBitacoraById,
  registrarHoraSalida,
  registrarHoraLlegada,
  updateBitacora,
  marcarRecolectado,
  getFotoRecoleccion,
  getRecolecciones,
  getPaqueteriaBitacora,
  marcarSalidaEnvio,
  marcarEntregaEnvio,
} from "../../controllers/envios/bitacora.controller";

import { authMiddleware } from "../../middlewares/auth.middleware";

import {
  validateId,
  preventSQLInjection,
} from "../../middlewares/validation.middleware";

import { upload } from "../../config/multer";

const router = Router();

router.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(generalLimiter);

router.use((req, _res, next) => {
  console.log("BITACORA ROUTER:", req.method, req.path);
  next();
});

// ─────────────────────────────────────────────
// PAQUETERÍA
// ─────────────────────────────────────────────

router.get(
  "/paqueteria",
  authMiddleware,
  getPaqueteriaBitacora
);

// ─────────────────────────────────────────────
// RECOLECCIONES
// ─────────────────────────────────────────────

router.get(
  "/recoleccion",
  authMiddleware,
  getRecolecciones
);

router.patch(
  "/recoleccion/:idenvio/marcar-recogido",
  authMiddleware,
  writeLimiter,
  upload.single("foto"),
  marcarRecolectado
);

router.get(
  "/recoleccion/:idenvio/foto",
  authMiddleware,
  getFotoRecoleccion
);

// ─────────────────────────────────────────────
// SALIDA / ENTREGA FINAL LOCAL / PAQUETERÍA
// ─────────────────────────────────────────────

router.patch(
  "/envio/:idenvio/marcar-salida",
  authMiddleware,
  writeLimiter,
  marcarSalidaEnvio
);

router.patch(
  "/envio/:idenvio/marcar-entregado",
  authMiddleware,
  writeLimiter,
  upload.single("foto"),
  marcarEntregaEnvio
);

// ─────────────────────────────────────────────
// BITÁCORA
// ─────────────────────────────────────────────

router.get(
  "/",
  authMiddleware,
  getBitacora
);

router.get(
  "/:id",
  authMiddleware,
  validateId,
  getBitacoraById
);

router.patch(
  "/:id/hora-salida",
  authMiddleware,
  writeLimiter,
  validateId,
  registrarHoraSalida
);

router.patch(
  "/:id/hora-llegada",
  authMiddleware,
  writeLimiter,
  validateId,
  registrarHoraLlegada
);

router.put(
  "/:id",
  authMiddleware,
  writeLimiter,
  preventSQLInjection,
  validateId,
  updateBitacora
);

export default router;
