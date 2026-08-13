import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  crearCotizacion,
  getCotizaciones,
  actualizarEstadoCotizacion,
  actualizarCotizacionProductos,
  eliminarCotizacion,
  aprobarDetalle,
  actualizarObservacion,
  aprobarHerramental,
  cambiarMonedaCotizacion,
} from "../../controllers/cotizaciones/cotizaciones.controller";
import { getColoresAsa }     from "../../controllers/cotizaciones/coloresAsa.controller";
import { getMedidasTroquel } from "../../controllers/cotizaciones/medidasTroquel.controller";
import {
  authMiddleware,
  checkPermiso,
  checkAnyPermiso,
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

// Split en la fase 0 (2026-08-12): el privilegio monolítico original se
// dividió en crear/editar y aprobar/rechazar. A todo el que ya tenía el
// viejo se le dieron los dos nuevos automáticamente, así que esto no le
// quita capacidad a nadie — solo permite, de ahora en más, un rol que
// apruebe sin poder crear/editar.
const PERMISO_CREAR_EDITAR = "cotizacion.crear_editar";
const PERMISO_APROBAR      = "cotizacion.aprobar";
const PERMISO_URGENTE      = "cotizacion.urgente";

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
  checkPermiso(PERMISO_CREAR_EDITAR),
  checkOrdenUrgente,      // ← valida prioridad solo si tipo=pedido y prioridad=true
  writeLimiter,
  preventSQLInjection,
  crearCotizacion
);

// Cambia el estado administrativo — incluye transiciones de
// aprobado/rechazado, por eso acepta cualquiera de los dos privilegios.
router.patch(
  "/:id/estado",
  authMiddleware,
  checkAnyPermiso(PERMISO_CREAR_EDITAR, PERMISO_APROBAR),
  writeLimiter,
  preventSQLInjection,
  actualizarEstadoCotizacion
);

// ── Detalle, herramental y observación — IDs directos ─────
router.patch(
  "/detalle/:idDetalle/aprobar",
  authMiddleware,
  checkPermiso(PERMISO_APROBAR),
  writeLimiter,
  aprobarDetalle
);

router.patch(
  "/herramental/:idH/aprobar",
  authMiddleware,
  checkPermiso(PERMISO_APROBAR),
  writeLimiter,
  aprobarHerramental
);

router.patch(
  "/producto/:idP/observacion",
  authMiddleware,
  checkPermiso(PERMISO_CREAR_EDITAR),
  writeLimiter,
  preventSQLInjection,
  actualizarObservacion
);

router.delete(
  "/:id",
  authMiddleware,
  checkPermiso(PERMISO_CREAR_EDITAR),
  writeLimiter,
  eliminarCotizacion
);

router.put(
  "/:id/moneda",
  authMiddleware,
  checkPermiso(PERMISO_CREAR_EDITAR),
  writeLimiter,
  cambiarMonedaCotizacion
);

router.post(
  "/cotizaciones-papel/mock",
  authMiddleware,
  crearCotizacionPapelMock
);
router.put(
  "/:id",
  authMiddleware,
  checkPermiso(PERMISO_CREAR_EDITAR),
  writeLimiter,
  preventSQLInjection,
  actualizarCotizacionProductos
);

export default router;