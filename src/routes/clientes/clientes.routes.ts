import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  createCliente,
  getClientes,
  getClienteById,
  searchClientes,
  updateCliente,
  deleteCliente,
  createClienteLigero,
} from "../../controllers/clientes/clientes.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
import {
  validateCreateCliente,
  validateUpdateCliente,
  validateCreateClienteLigero,
  validateId,
  preventSQLInjection,
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

const PERMISO = "Crear/Editar/Eliminar Clientes";

// ── GETs — cualquier autenticado ──────────────────────────
router.get("/",       authMiddleware, getClientes);
router.get("/search", authMiddleware, searchClientes);
router.get("/:id",    authMiddleware, validateId, getClienteById);

// ── Escritura — requiere permiso ──────────────────────────
router.post(
  "/",
  authMiddleware,
  checkPermiso(PERMISO),
  writeLimiter,
  preventSQLInjection,
  validateCreateCliente,
  createCliente
);

router.put(
  "/:id",
  authMiddleware,
  checkPermiso(PERMISO),
  writeLimiter,
  preventSQLInjection,
  validateId,
  validateUpdateCliente,
  updateCliente
);

router.delete(
  "/:id",
  authMiddleware,
  checkPermiso(PERMISO),
  writeLimiter,
  validateId,
  deleteCliente
);

// Cliente ligero — cualquier autenticado puede crearlo
// (usado desde cotizaciones y pedidos)
router.post(
  "/ligero",
  authMiddleware,
  writeLimiter,
  preventSQLInjection,
  validateCreateClienteLigero,
  createClienteLigero
);

export default router;