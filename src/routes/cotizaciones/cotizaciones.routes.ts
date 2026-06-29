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
import { getColoresAsa }     from "../../controllers/cotizaciones/coloresAsa.controller";
import { getMedidasTroquel } from "../../controllers/cotizaciones/medidasTroquel.controller";
import {
  authMiddleware,
  checkPermiso,
  type AuthRequest,
} from "../../middlewares/auth.middleware";
import { preventSQLInjection } from "../../middlewares/validation.middleware";
import type { Response, NextFunction } from "express";
import { crearCotizacionPapelMock } from "../../controllers/cotizaciones/cotizacionPapel.mock.controller";


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

const PERMISO         = "Crear/Editar/Aprobar/Rechazar Cotizaciones";
const PERMISO_URGENTE = "Orden Urgente";

// Middleware inline — valida "Orden Urgente" solo si prioridad = true en un pedido
const checkOrdenUrgente = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const { prioridad, tipo } = req.body;

  // Solo aplica cuando es pedido con prioridad = true
  if (tipo !== "pedido" || !prioridad) return next();

  const user = req.user;
  if (!user) return res.status(401).json({ error: "No autenticado" });
  if (user.acceso_total) return next();

  const tienePermiso = (user.privilegios ?? []).includes(PERMISO_URGENTE);
  if (!tienePermiso) {
    return res.status(403).json({
      error: "No tienes permiso para crear órdenes urgentes",
    });
  }

  next();
};

// ── GETs catálogos — cualquier autenticado ────────────────
router.get("/",                authMiddleware, getCotizaciones);
router.get("/colores-asa",     authMiddleware, getColoresAsa);
router.get("/medidas-troquel", authMiddleware, getMedidasTroquel);

// ── Escritura — requiere permiso ──────────────────────────
router.post(
  "/",
  authMiddleware,
  checkPermiso(PERMISO),
  checkOrdenUrgente,      // ← valida prioridad solo si tipo=pedido y prioridad=true
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

// ── Detalle, herramental y observación — IDs directos ─────
router.patch(
  "/detalle/:idDetalle/aprobar",
  authMiddleware,
  checkPermiso(PERMISO),
  writeLimiter,
  aprobarDetalle
);

router.patch(
  "/herramental/:idH/aprobar",
  authMiddleware,
  checkPermiso(PERMISO),
  writeLimiter,
  aprobarHerramental
);

router.patch(
  "/producto/:idP/observacion",
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

router.post(
  "/cotizaciones-papel/mock",
  authMiddleware,
  crearCotizacionPapelMock
);

export default router;