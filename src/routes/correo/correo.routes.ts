// src/routes/correo/correo.routes.ts
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { enviarCorreoDocumento } from "../../controllers/correo/correo.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";

const router = Router();

// Límite aflojado (antes 30) — el outbox del PWA puede reintentar varios
// correos encolados en ráfaga al reconectar tras estar offline.
const correoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/documento", authMiddleware, correoLimiter, enviarCorreoDocumento);

export default router;