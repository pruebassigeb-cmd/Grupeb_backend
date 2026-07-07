import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  getTiposProductoAdmin,
  crearTipoProductoAdmin,
  editarTipoProductoAdmin,
  desactivarTipoProductoAdmin,
  reactivarTipoProductoAdmin,
  getMaterialesAdmin,
  crearMaterialAdmin,
  editarMaterialAdmin,
  desactivarMaterialAdmin,
  reactivarMaterialAdmin,
  getCalibresAdmin,
  crearCalibreAdmin,
  editarCalibreAdmin,
  desactivarCalibreAdmin,
  reactivarCalibreAdmin,
} from "../../controllers/productos/catalogosPlasticoAdmin.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
import {
  validateId,
  preventSQLInjection,
  validateCreateTipoProductoPlastico,
  validateCreateMaterialPlastico,
  validateCreateCalibrePlastico,
} from "../../middlewares/validation.middleware";

const router = Router();

router.use(
  helmet({
    contentSecurityPolicy:     false,
    crossOriginEmbedderPolicy: false,
  })
);

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      200,
  message:  { error: "Demasiadas solicitudes. Intenta más tarde." },
  standardHeaders: true,
  legacyHeaders:   false,
});

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      100,
  message:  { error: "Demasiadas operaciones. Intenta más tarde." },
  standardHeaders: true,
  legacyHeaders:   false,
});

router.use(generalLimiter);

// Mismo permiso que "Dar de alta productos" — ajusta si prefieres un permiso
// dedicado para administrar catálogos.
const PERMISO = "Dar de alta productos";

// ── Tipo de producto ─────────────────────────────────────────────────────
router.get("/tipos-producto", authMiddleware, getTiposProductoAdmin);
router.post(
  "/tipos-producto",
  authMiddleware, checkPermiso(PERMISO), writeLimiter,
  preventSQLInjection, validateCreateTipoProductoPlastico,
  crearTipoProductoAdmin
);
router.put(
  "/tipos-producto/:id",
  authMiddleware, checkPermiso(PERMISO), writeLimiter,
  preventSQLInjection, validateId, validateCreateTipoProductoPlastico,
  editarTipoProductoAdmin
);
router.delete(
  "/tipos-producto/:id",
  authMiddleware, checkPermiso(PERMISO), writeLimiter, validateId,
  desactivarTipoProductoAdmin
);
router.patch(
  "/tipos-producto/:id/reactivar",
  authMiddleware, checkPermiso(PERMISO), writeLimiter, validateId,
  reactivarTipoProductoAdmin
);

// ── Material ──────────────────────────────────────────────────────────────
router.get("/materiales", authMiddleware, getMaterialesAdmin);
router.post(
  "/materiales",
  authMiddleware, checkPermiso(PERMISO), writeLimiter,
  preventSQLInjection, validateCreateMaterialPlastico,
  crearMaterialAdmin
);
router.put(
  "/materiales/:id",
  authMiddleware, checkPermiso(PERMISO), writeLimiter,
  preventSQLInjection, validateId, validateCreateMaterialPlastico,
  editarMaterialAdmin
);
router.delete(
  "/materiales/:id",
  authMiddleware, checkPermiso(PERMISO), writeLimiter, validateId,
  desactivarMaterialAdmin
);
router.patch(
  "/materiales/:id/reactivar",
  authMiddleware, checkPermiso(PERMISO), writeLimiter, validateId,
  reactivarMaterialAdmin
);

// ── Calibre ───────────────────────────────────────────────────────────────
router.get("/calibres", authMiddleware, getCalibresAdmin);
router.post(
  "/calibres",
  authMiddleware, checkPermiso(PERMISO), writeLimiter,
  preventSQLInjection, validateCreateCalibrePlastico,
  crearCalibreAdmin
);
router.put(
  "/calibres/:id",
  authMiddleware, checkPermiso(PERMISO), writeLimiter,
  preventSQLInjection, validateId, validateCreateCalibrePlastico,
  editarCalibreAdmin
);
router.delete(
  "/calibres/:id",
  authMiddleware, checkPermiso(PERMISO), writeLimiter, validateId,
  desactivarCalibreAdmin
);
router.patch(
  "/calibres/:id/reactivar",
  authMiddleware, checkPermiso(PERMISO), writeLimiter, validateId,
  reactivarCalibreAdmin
);

export default router;

// ═══════════════════════════════════════════════════════════════════════════
// Montaje sugerido en app.ts, junto a tus otras rutas de productos:
//
//   import catalogosPlasticoAdminRoutes from "./routes/productos/catalogos-plastico-admin.routes";
//   app.use("/catalogos-productos/plastico/admin", catalogosPlasticoAdminRoutes);
// ═══════════════════════════════════════════════════════════════════════════