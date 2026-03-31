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
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      50,
  message:  {
    error: "Demasiados intentos de inicio de sesión. Intenta en 15 minutos.",
  },
  standardHeaders: true,
  legacyHeaders:   false,
  skip: (req) => process.env.NODE_ENV !== "production",
});

const verifyLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max:      20,
  message:  { error: "Demasiadas verificaciones. Intenta más tarde." },
  standardHeaders: true,
  legacyHeaders:   false,
});

// Rate limit para verificarOperador — más permisivo ya que
// los operadores de planta lo usan frecuentemente
const operadorLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutos
  max:      30,
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
  loginLimiter,
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