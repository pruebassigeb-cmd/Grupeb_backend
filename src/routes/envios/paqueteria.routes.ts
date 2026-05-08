import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  getPaqueterias, getPaqueteriaById,
  createPaqueteria, updatePaqueteria, deletePaqueteria,
} from "../../controllers/envios/paqueteria.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
import { validateId, preventSQLInjection } from "../../middlewares/validation.middleware";

const router = Router();

router.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
const writeLimiter   = rateLimit({ windowMs: 15 * 60 * 1000, max: 30,  standardHeaders: true, legacyHeaders: false });

router.use(generalLimiter);

const PERMISO = "Crear/Editar/Eliminar Clientes";

router.get("/",    authMiddleware, getPaqueterias);
router.get("/:id", authMiddleware, validateId, getPaqueteriaById);

router.post(
  "/", authMiddleware, checkPermiso(PERMISO),
  writeLimiter, preventSQLInjection, createPaqueteria
);
router.put(
  "/:id", authMiddleware, checkPermiso(PERMISO),
  writeLimiter, preventSQLInjection, validateId, updatePaqueteria
);
router.delete(
  "/:id", authMiddleware, checkPermiso(PERMISO),
  writeLimiter, validateId, deletePaqueteria
);

export default router;