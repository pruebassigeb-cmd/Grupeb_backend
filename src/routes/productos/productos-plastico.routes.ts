// import { Router } from "express";
// import rateLimit from "express-rate-limit";
// import helmet from "helmet";
// import {
//   createProductoPlastico,
//   getProductosPlastico,
//   getProductoPlasticoById,
//   updateProductoPlastico,
//   deleteProductoPlastico,
//   reactivarProductoPlastico,
//   checkProductoDuplicado,
// } from "../../controllers/productos/productos-plastico.controller";
// import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
// import {
//   validateId,
//   preventSQLInjection,
//   validateCreateProductoPlastico,
//   validateUpdateProductoPlastico,
// } from "../../middlewares/validation.middleware";

// const router = Router();

// router.use(
//   helmet({
//     contentSecurityPolicy:     false,
//     crossOriginEmbedderPolicy: false,
//   })
// );

// const createLimiter = rateLimit({
//   windowMs: 60 * 60 * 1000,
//   max:      100,
//   message:  { error: "Demasiados productos creados. Intenta más tarde." },
//   standardHeaders:        true,
//   legacyHeaders:          false,
//   skipSuccessfulRequests: false,
// });

// const updateDeleteLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max:      150,
//   message:  { error: "Demasiadas operaciones. Intenta más tarde." },
//   standardHeaders: true,
//   legacyHeaders:   false,
// });

// const generalLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max:      200,
//   message:  { error: "Demasiadas solicitudes. Intenta más tarde." },
//   standardHeaders: true,
//   legacyHeaders:   false,
// });

// router.use(generalLimiter);

// const PERMISO = "Dar de alta productos";

// // ── GETs — cualquier autenticado ──────────────────────────
// router.get("/check-duplicado", authMiddleware, checkProductoDuplicado);
// router.get("/",                authMiddleware, getProductosPlastico);
// router.get("/:id",             authMiddleware, validateId, getProductoPlasticoById);

// // ── Escritura — requiere permiso ──────────────────────────
// router.post(
//   "/",
//   authMiddleware,
//   checkPermiso(PERMISO),
//   createLimiter,
//   preventSQLInjection,
//   validateCreateProductoPlastico,
//   createProductoPlastico
// );

// router.put(
//   "/:id",
//   authMiddleware,
//   checkPermiso(PERMISO),
//   updateDeleteLimiter,
//   preventSQLInjection,
//   validateId,
//   validateUpdateProductoPlastico,
//   updateProductoPlastico
// );

// // ✅ Antes estaba comentado (sin handler) — ahora sí desactiva el producto
// router.delete(
//   "/:id",
//   authMiddleware,
//   checkPermiso(PERMISO),
//   updateDeleteLimiter,
//   validateId,
//   deleteProductoPlastico
// );

// // ✅ NUEVO — reactivar un producto previamente desactivado
// router.patch(
//   "/:id/reactivar",
//   authMiddleware,
//   checkPermiso(PERMISO),
//   updateDeleteLimiter,
//   validateId,
//   reactivarProductoPlastico
// );

// export default router;














import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  createProductoPlastico,
  getProductosPlastico,
  getProductoPlasticoById,
  updateProductoPlastico,
  deleteProductoPlastico,
  reactivarProductoPlastico,
  checkProductoDuplicado,
  registrarProductoPlasticoEnBlancoExpo,
} from "../../controllers/productos/productos-plastico.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
import {
  validateId,
  preventSQLInjection,
  validateCreateProductoPlastico,
  validateUpdateProductoPlastico,
} from "../../middlewares/validation.middleware";

const router = Router();

router.use(
  helmet({
    contentSecurityPolicy:     false,
    crossOriginEmbedderPolicy: false,
  })
);

const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      100,
  message:  { error: "Demasiados productos creados. Intenta más tarde." },
  standardHeaders:        true,
  legacyHeaders:          false,
  skipSuccessfulRequests: false,
});

const updateDeleteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      150,
  message:  { error: "Demasiadas operaciones. Intenta más tarde." },
  standardHeaders: true,
  legacyHeaders:   false,
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      200,
  message:  { error: "Demasiadas solicitudes. Intenta más tarde." },
  standardHeaders: true,
  legacyHeaders:   false,
});

router.use(generalLimiter);

const PERMISO = "Dar de alta productos";

// ── GETs — cualquier autenticado ──────────────────────────
router.get("/check-duplicado", authMiddleware, checkProductoDuplicado);
router.get("/",                authMiddleware, getProductosPlastico);
router.get("/:id",             authMiddleware, validateId, getProductoPlasticoById);

// ── Registro EN BLANCO desde Expo — cualquier autenticado, SIN el permiso
// especial de "Dar de alta productos" (mismo criterio que en papel: es un
// registro relajado para cotizar algo nuevo sobre la marcha desde Expo).
router.post("/en-blanco-expo", authMiddleware, createLimiter, registrarProductoPlasticoEnBlancoExpo);

// ── Escritura — requiere permiso ──────────────────────────
router.post(
  "/",
  authMiddleware,
  checkPermiso(PERMISO),
  createLimiter,
  preventSQLInjection,
  validateCreateProductoPlastico,
  createProductoPlastico
);

router.put(
  "/:id",
  authMiddleware,
  checkPermiso(PERMISO),
  updateDeleteLimiter,
  preventSQLInjection,
  validateId,
  validateUpdateProductoPlastico,
  updateProductoPlastico
);

// ✅ Antes estaba comentado (sin handler) — ahora sí desactiva el producto
router.delete(
  "/:id",
  authMiddleware,
  checkPermiso(PERMISO),
  updateDeleteLimiter,
  validateId,
  deleteProductoPlastico
);

// ✅ NUEVO — reactivar un producto previamente desactivado
router.patch(
  "/:id/reactivar",
  authMiddleware,
  checkPermiso(PERMISO),
  updateDeleteLimiter,
  validateId,
  reactivarProductoPlastico
);

export default router;