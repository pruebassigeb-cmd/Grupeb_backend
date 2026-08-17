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
  getTroquelesAdmin,
  crearTroquelAdmin,
  editarTroquelAdmin,
  desactivarTroquelAdmin,
  reactivarTroquelAdmin,
  getSuajesAdmin,
  crearSuajeAdmin,
  editarSuajeAdmin,
  desactivarSuajeAdmin,
  reactivarSuajeAdmin,
  getCintaSeguridadAdmin,
  crearCintaSeguridadAdmin,
  editarCintaSeguridadAdmin,
  desactivarCintaSeguridadAdmin,
  reactivarCintaSeguridadAdmin,
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
const PERMISO = "productos.plastico.gestionar";

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

// ── Tipo de troquel ───────────────────────────────────────────────────────
router.get("/troqueles", authMiddleware, getTroquelesAdmin);
router.post(
  "/troqueles",
  authMiddleware, checkPermiso(PERMISO), writeLimiter, preventSQLInjection,
  crearTroquelAdmin
);
router.put(
  "/troqueles/:id",
  authMiddleware, checkPermiso(PERMISO), writeLimiter, preventSQLInjection, validateId,
  editarTroquelAdmin
);
router.delete(
  "/troqueles/:id",
  authMiddleware, checkPermiso(PERMISO), writeLimiter, validateId,
  desactivarTroquelAdmin
);
router.patch(
  "/troqueles/:id/reactivar",
  authMiddleware, checkPermiso(PERMISO), writeLimiter, validateId,
  reactivarTroquelAdmin
);

// ── Asa / Suaje ───────────────────────────────────────────────────────────
router.get("/asa-suaje", authMiddleware, getSuajesAdmin);
router.post(
  "/asa-suaje",
  authMiddleware, checkPermiso(PERMISO), writeLimiter, preventSQLInjection,
  crearSuajeAdmin
);
router.put(
  "/asa-suaje/:id",
  authMiddleware, checkPermiso(PERMISO), writeLimiter, preventSQLInjection, validateId,
  editarSuajeAdmin
);
router.delete(
  "/asa-suaje/:id",
  authMiddleware, checkPermiso(PERMISO), writeLimiter, validateId,
  desactivarSuajeAdmin
);
router.patch(
  "/asa-suaje/:id/reactivar",
  authMiddleware, checkPermiso(PERMISO), writeLimiter, validateId,
  reactivarSuajeAdmin
);

// ── Cinta de seguridad ────────────────────────────────────────────────────
router.get("/cinta-seguridad", authMiddleware, getCintaSeguridadAdmin);
router.post(
  "/cinta-seguridad",
  authMiddleware, checkPermiso(PERMISO), writeLimiter, preventSQLInjection,
  crearCintaSeguridadAdmin
);
router.put(
  "/cinta-seguridad/:id",
  authMiddleware, checkPermiso(PERMISO), writeLimiter, preventSQLInjection, validateId,
  editarCintaSeguridadAdmin
);
router.delete(
  "/cinta-seguridad/:id",
  authMiddleware, checkPermiso(PERMISO), writeLimiter, validateId,
  desactivarCintaSeguridadAdmin
);
router.patch(
  "/cinta-seguridad/:id/reactivar",
  authMiddleware, checkPermiso(PERMISO), writeLimiter, validateId,
  reactivarCintaSeguridadAdmin
);

export default router;

// ═══════════════════════════════════════════════════════════════════════════
// Montaje sugerido en app.ts, junto a tus otras rutas de productos:
//
//   import catalogosPlasticoAdminRoutes from "./routes/productos/catalogos-plastico-admin.routes";
//   app.use("/catalogos-productos/plastico/admin", catalogosPlasticoAdminRoutes);
// ═══════════════════════════════════════════════════════════════════════════