import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  createProductoPlastico,
  getProductosPlastico,
  getProductoPlasticoById,
  updateProductoPlastico,
  checkProductoDuplicado,
  //deleteProductoPlastico,
} from "../../controllers/productos/productos-plastico.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import {
  validateId,
  preventSQLInjection,
  validateCreateProductoPlastico,
  validateUpdateProductoPlastico,
} from "../../middlewares/validation.middleware";

const router = Router();

// ==========================
// HELMET
// ==========================
router.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

// ==========================
// RATE LIMITING
// ==========================
const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 100, // 100 productos por hora
  message: {
    error: "Demasiados productos creados. Intenta más tarde.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
});

const updateDeleteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 150, // 150 operaciones por 15 minutos
  message: {
    error: "Demasiadas operaciones. Intenta más tarde.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 200, // 200 solicitudes por 15 minutos
  message: {
    error: "Demasiadas solicitudes. Intenta más tarde.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(generalLimiter);

// ==========================
// RUTAS PROTEGIDAS
// ==========================

// Crear producto plástico - Con validación completa
router.post(
  "/",
  authMiddleware,
  createLimiter,
  preventSQLInjection,
  validateCreateProductoPlastico,
  createProductoPlastico
);

// Obtener todos los productos plástico
router.get("/", authMiddleware, getProductosPlastico);
// En tus rutas de productos
router.get('/check-duplicado', checkProductoDuplicado);

// Obtener producto por ID
router.get("/:id", authMiddleware, validateId, getProductoPlasticoById);

// Actualizar producto - Con validación completa
router.put(
  "/:id",
  authMiddleware,
  updateDeleteLimiter,
  preventSQLInjection,
  validateId,
  validateUpdateProductoPlastico,
  updateProductoPlastico
);

// Eliminar producto
router.delete(
  "/:id",
  authMiddleware,
  updateDeleteLimiter,
  validateId,
  //deleteProductoPlastico
);

export default router;