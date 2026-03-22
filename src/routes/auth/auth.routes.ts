import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  login,
  logout,
  verifyToken,
} from "../../controllers/auth/auth.controller";
import { 
  validateLogin,
  preventSQLInjection 
} from "../../middlewares/validation.middleware";

const router = Router();

// ==========================
// HELMET
// ==========================
router.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

// ==========================
// RATE LIMITING
// ==========================
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { 
    error: "Demasiados intentos de inicio de sesión. Intenta en 15 minutos." 
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV !== "production", // solo en producción
});

// ✅ NUEVO: Rate limit MÁS PERMISIVO para /verify (desarrollo con StrictMode)
const verifyLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 20, // 20 verificaciones por minuto (suficiente para desarrollo)
  message: { 
    error: "Demasiadas verificaciones. Intenta más tarde." 
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { 
    error: "Demasiadas solicitudes. Intenta más tarde." 
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// NO aplicar rate limit general a /verify
// router.use(generalAuthLimiter);

// ==========================
// RUTAS
// ==========================
router.post("/login", loginLimiter, preventSQLInjection, validateLogin, login);
router.post("/logout", logout);
router.get("/verify", verifyLimiter, verifyToken); 

export default router;