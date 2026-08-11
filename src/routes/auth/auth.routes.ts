import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  login,
  logout,
  verifyToken,
  verificarOperador,
} from "../../controllers/auth/auth.controller";
import {
  validateLogin,
  preventSQLInjection,
} from "../../middlewares/validation.middleware";

const router = Router();

// ==========================
// HELMET
// ==========================
router.use(
  helmet({
    contentSecurityPolicy:    false,
    crossOriginEmbedderPolicy: false,
  })
);

// ==========================
// RATE LIMITING
// ==========================
const verifyLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max:      20,
  message:  { error: "Demasiadas verificaciones. Intenta más tarde." },
  standardHeaders: true,
  legacyHeaders:   false,
  skip: () => process.env.NODE_ENV !== "production",
});

// Rate limit para verificarOperador — más permisivo ya que
// los operadores de planta lo usan frecuentemente
const operadorLimiter = rateLimit({
  windowMs: 2 * 60 * 1000, // 2 minutos
  max:      20,
  message:  {
    error: "Demasiados intentos de verificación. Intenta en 5 minutos.",
  },
  standardHeaders: true,
  legacyHeaders:   false,
  skip: (req) => process.env.NODE_ENV !== "production",
});

// ==========================
// RUTAS
// ==========================
router.post(
  "/login",
  preventSQLInjection,
  validateLogin,
  login
);

router.post("/logout", logout);

router.get("/verify", verifyLimiter, verifyToken);

// Verificación de operador para popup de planta
// No requiere authMiddleware — es su propio mecanismo de auth
router.post(
  "/verificar-operador",
  operadorLimiter,
  preventSQLInjection,
  verificarOperador
);

export default router;