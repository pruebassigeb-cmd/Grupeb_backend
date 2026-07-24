// src/routes/correo/correo.routes.ts
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { enviarCorreoDocumento } from "../../controllers/correo/correo.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { generarClaveLimitador } from "../../config/security.config";

const router = Router();

// Límite aflojado (antes 30) — el outbox del PWA puede reintentar varios
// correos encolados en ráfaga al reconectar tras estar offline.
// keyGenerator por usuario: cada vendedor tiene su propio presupuesto de
// envíos, no se comparte con quien esté en la misma red.
const correoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: generarClaveLimitador,
});

router.post("/documento", authMiddleware, correoLimiter, enviarCorreoDocumento);

export default router;