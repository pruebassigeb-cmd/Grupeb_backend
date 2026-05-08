import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  getBitacora,
  getBitacoraById,
  registrarHoraSalida,
  registrarHoraLlegada,
  updateBitacora,
} from "../../controllers/envios/bitacora.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { validateId, preventSQLInjection } from "../../middlewares/validation.middleware";

const router = Router();

router.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
const writeLimiter   = rateLimit({ windowMs: 15 * 60 * 1000, max: 30,  standardHeaders: true, legacyHeaders: false });

router.use(generalLimiter);

// Listar bitácora completa
router.get("/",    authMiddleware, getBitacora);
router.get("/:id", authMiddleware, validateId, getBitacoraById);

// Registrar horas en tiempo real
router.patch("/:id/hora-salida",  authMiddleware, writeLimiter, validateId, registrarHoraSalida);
router.patch("/:id/hora-llegada", authMiddleware, writeLimiter, validateId, registrarHoraLlegada);

// Editar registro
router.put(
  "/:id", authMiddleware,
  writeLimiter, preventSQLInjection, validateId, updateBitacora
);

export default router;