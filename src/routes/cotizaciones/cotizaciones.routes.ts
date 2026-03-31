import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  crearCotizacion,
  getCotizaciones,
  actualizarEstadoCotizacion,
  eliminarCotizacion,
  aprobarDetalle,
  actualizarObservacion,
  aprobarHerramental,
} from "../../controllers/cotizaciones/cotizaciones.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
import { preventSQLInjection } from "../../middlewares/validation.middleware";

const router = Router();

router.use(
  helmet({
    contentSecurityPolicy:     false,
    crossOriginEmbedderPolicy: false,
  })
);

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      100,
  message:  { error: "Demasiadas solicitudes. Intenta más tarde." },
  standardHeaders: true,
  legacyHeaders:   false,
});

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      30,
  message:  { error: "Demasiadas operaciones. Intenta más tarde." },
  standardHeaders: true,
  legacyHeaders:   false,
});

router.use(generalLimiter);

const PERMISO = "Crear/Editar/Aprobar/Rechazar Cotizaciones";

// ── GETs — cualquier autenticado ──────────────────────────
router.get("/", authMiddleware, getCotizaciones);

// ── Escritura — requiere permiso ──────────────────────────
router.post(
  "/",
  authMiddleware,
  checkPermiso(PERMISO),
  writeLimiter,
  preventSQLInjection,
  crearCotizacion
);

router.patch(
  "/:id/estado",
  authMiddleware,
  checkPermiso(PERMISO),
  writeLimiter,
  preventSQLInjection,
  actualizarEstadoCotizacion
);

router.patch(
  "/:id/detalle/:idDetalle/aprobar",
  authMiddleware,
  checkPermiso(PERMISO),
  writeLimiter,
  aprobarDetalle
);

router.patch(
  "/:id/herramental/:idH/aprobar",
  authMiddleware,
  checkPermiso(PERMISO),
  writeLimiter,
  aprobarHerramental
);

router.patch(
  "/:id/producto/:idP/observacion",
  authMiddleware,
  checkPermiso(PERMISO),
  writeLimiter,
  preventSQLInjection,
  actualizarObservacion
);

router.delete(
  "/:id",
  authMiddleware,
  checkPermiso(PERMISO),
  writeLimiter,
  eliminarCotizacion
);

export default router;