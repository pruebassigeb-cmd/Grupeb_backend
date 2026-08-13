import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  getUnidades, getUnidadById,
  createUnidad, updateUnidad, deleteUnidad,
} from "../../controllers/envios/unidades.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
import { validateId, preventSQLInjection } from "../../middlewares/validation.middleware";

const router = Router();

router.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
const writeLimiter   = rateLimit({ windowMs: 15 * 60 * 1000, max: 30,  standardHeaders: true, legacyHeaders: false });

router.use(generalLimiter);

// Fase 6: antes reutilizaba "Crear/Editar/Eliminar Clientes" como comodín
// (sin relación real con unidades de reparto) — ya existe un privilegio
// propio para esto desde la fase 0, se corrige de paso al migrar a clave.
const PERMISO = "envios.paqueterias_unidades.gestionar";

router.get("/",    authMiddleware, getUnidades);
router.get("/:id", authMiddleware, validateId, getUnidadById);

router.post(
  "/", authMiddleware, checkPermiso(PERMISO),
  writeLimiter, preventSQLInjection, createUnidad
);
router.put(
  "/:id", authMiddleware, checkPermiso(PERMISO),
  writeLimiter, preventSQLInjection, validateId, updateUnidad
);
router.delete(
  "/:id", authMiddleware, checkPermiso(PERMISO),
  writeLimiter, validateId, deleteUnidad
);

export default router;