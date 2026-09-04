import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  crearCotizacionLibre,
  getCotizacionesLibres,
  getCotizacionLibrePorFolio,
  actualizarCotizacionLibre,
  eliminarCotizacionLibre,
} from "../../controllers/cotizaciones/cotizacionLibre.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
import { preventSQLInjection } from "../../middlewares/validation.middleware";

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
  message: { error: "Demasiadas solicitudes. Intenta más tarde." },
  standardHeaders: true,
  legacyHeaders: false,
});

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: "Demasiadas operaciones. Intenta más tarde." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(generalLimiter);

// Mismo permiso que ya usan para crear/editar cotización normal — es la
// misma acción de negocio (armar una cotización), solo que "libre".
const PERMISO_CREAR_EDITAR = "cotizacion.crear_editar";

router.get("/", authMiddleware, getCotizacionesLibres);
router.get("/:folio", authMiddleware, getCotizacionLibrePorFolio);

router.post(
  "/",
  authMiddleware,
  checkPermiso(PERMISO_CREAR_EDITAR),
  writeLimiter,
  preventSQLInjection,
  crearCotizacionLibre
);

router.put(
  "/:folio",
  authMiddleware,
  checkPermiso(PERMISO_CREAR_EDITAR),
  writeLimiter,
  preventSQLInjection,
  actualizarCotizacionLibre
);

router.delete(
  "/:folio",
  authMiddleware,
  checkPermiso(PERMISO_CREAR_EDITAR),
  writeLimiter,
  eliminarCotizacionLibre
);

export default router;