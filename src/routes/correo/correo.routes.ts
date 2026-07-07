// src/routes/correo/correo.routes.ts
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { enviarCorreoDocumento } from "../../controllers/correo/correo.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";

const router = Router();

// Límite conservador: el envío de correo no debería dispararse en ráfaga
const correoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/documento", authMiddleware, correoLimiter, enviarCorreoDocumento);

export default router;