import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  createUsuario,
  getUsuarios,
  getUsuarioById,
  updateUsuario,
  deleteUsuario,
} from "../../controllers/usuarios/usuarios.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
import {
  validateCreateUsuario,
  validateUsuario,
  validateId,
  preventSQLInjection,
} from "../../middlewares/validation.middleware";

const router = Router();

// ==========================
// HELMET
// ==========================
router.use(
  helmet({
    contentSecurityPolicy:     false,
    crossOriginEmbedderPolicy: false,
  })
);

// ==========================
// RATE LIMITING
// ==========================
const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      10,
  message:  { error: "Demasiados usuarios creados. Intenta más tarde." },
  standardHeaders: true,
  legacyHeaders:   false,
});

const updateDeleteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      30,
  message:  { error: "Demasiadas operaciones. Intenta más tarde." },
  standardHeaders: true,
  legacyHeaders:   false,
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      100,
  message:  { error: "Demasiadas solicitudes. Intenta más tarde." },
  standardHeaders: true,
  legacyHeaders:   false,
});

router.use(generalLimiter);

// ==========================
// RUTAS
// Todas requieren: estar autenticado + privilegio "Crear/Editar/Eliminar Usuarios"
// ==========================
const PERMISO = "Crear/Editar/Eliminar Usuarios";

router.post(
  "/",
  authMiddleware,
  checkPermiso(PERMISO),
  createLimiter,
  preventSQLInjection,
  validateCreateUsuario,
  createUsuario
);

router.get(
  "/",
  authMiddleware,
  checkPermiso(PERMISO),
  getUsuarios
);

router.get(
  "/:id",
  authMiddleware,
  checkPermiso(PERMISO),
  validateId,
  getUsuarioById
);

router.put(
  "/:id",
  authMiddleware,
  checkPermiso(PERMISO),
  updateDeleteLimiter,
  preventSQLInjection,
  validateId,
  validateUsuario,
  updateUsuario
);

router.delete(
  "/:id",
  authMiddleware,
  checkPermiso(PERMISO),
  updateDeleteLimiter,
  validateId,
  deleteUsuario
);

export default router;