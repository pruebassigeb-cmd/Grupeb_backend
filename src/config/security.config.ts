import helmet from "helmet";
import { Express } from "express";
import rateLimit from "express-rate-limit";

export const setupSecurity = (app: Express) => {
app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
      frameguard: {
        action: "deny",
      },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
        },
      },
      noSniff: true,
      hsts: process.env.NODE_ENV === "production" ? {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      } : false,
      hidePoweredBy: true,
      dnsPrefetchControl: {
        allow: false,
      },
      referrerPolicy: {
        policy: "strict-origin-when-cross-origin",
      },
    })
  );

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    next();
  });

  console.log("✅ Configuración de seguridad aplicada");
};

/**
 * Configuración de CORS
 */
export const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    const allowedExact = [
      process.env.FRONTEND_URL || "http://localhost:5173",
      "http://localhost:5173",
      "http://localhost:5174",
    ];

    // Patrones para desarrollo (dev tunnels, ngrok, etc.)
    const allowedPatterns = [
      /^https:\/\/[a-z0-9.-]+\.devtunnels\.ms$/,
      /^https:\/\/[a-z0-9.-]+\.ngrok(-free)?\.app$/,
    ];

    const isAllowed =
      !origin ||
      allowedExact.includes(origin) ||
      allowedPatterns.some((pattern) => pattern.test(origin));

    if (isAllowed) {
      callback(null, true);
    } else {
      console.log("❌ CORS bloqueado para origen:", origin);
      callback(new Error(`CORS: origen no permitido: ${origin}`));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
  exposedHeaders: ["Set-Cookie", "ETag"],
  maxAge: 600,
};

/**
 * Constantes de seguridad
 */
export const SECURITY_CONSTANTS = {
  RATE_LIMIT_WINDOW_MS:    15 * 60 * 1000,
  LOGIN_MAX_ATTEMPTS:      10,
  CREATE_USER_MAX_ATTEMPTS: 10,
  GENERAL_MAX_REQUESTS:    500,
  APPROVAL_MAX_REQUESTS:   1000,
  JWT_EXPIRATION:          "16h",
  COOKIE_MAX_AGE:          16 * 60 * 60 * 1000,
  BCRYPT_ROUNDS:           12,
  REQUEST_TIMEOUT_MS:      30000,
  DB_QUERY_TIMEOUT_MS:     10000,
  MAX_USERS_TO_CHECK:      1000,
  MAX_REQUEST_BODY_SIZE:   "10mb",
  MAX_JSON_SIZE:           "5mb",
};

/**
 * Rate limiter general — aplica a todas las rutas /api
 */
export const generalLimiter = rateLimit({
  windowMs:       SECURITY_CONSTANTS.RATE_LIMIT_WINDOW_MS,
  max:            SECURITY_CONSTANTS.GENERAL_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders:  false,
  message:        { error: "Demasiadas solicitudes, espera un momento." },
});

/**
 * Rate limiter para toggles de aprobación — más permisivo
 * porque la UI puede disparar varios PATCHs seguidos al cambiar selección
 */
export const approvalLimiter = rateLimit({
  windowMs:       SECURITY_CONSTANTS.RATE_LIMIT_WINDOW_MS,
  max:            SECURITY_CONSTANTS.APPROVAL_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders:  false,
  message:        { error: "Demasiadas solicitudes de aprobación, espera un momento." },
});

/**
 * Rate limiter estricto para login
 */
export const loginLimiter = rateLimit({
  windowMs:       SECURITY_CONSTANTS.RATE_LIMIT_WINDOW_MS,
  max:            SECURITY_CONSTANTS.LOGIN_MAX_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders:  false,
  message:        { error: "Demasiados intentos de inicio de sesión. Intenta más tarde." },
});