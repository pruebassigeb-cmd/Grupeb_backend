import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  getTarifas,
  updateTarifasBatch,
} from "../../controllers/tarifas/tarifas.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";

const router = Router();

router.use(
  helmet({
    contentSecurityPolicy:     false,
    crossOriginEmbedderPolicy: false,
  })
);

const updateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      50,
  message:  { error: "Demasiadas actualizaciones. Intenta más tarde." },
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

const PERMISO = "Modificar Catalogo de precios";

// ── GET — cualquier autenticado ───────────────────────────
router.get("/", authMiddleware, getTarifas);

// ── Escritura — requiere permiso ──────────────────────────
router.put(
  "/batch",
  authMiddleware,
  checkPermiso(PERMISO),
  updateLimiter,
  updateTarifasBatch
);

export default router;