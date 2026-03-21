import helmet from "helmet";
import { Express } from "express";

/**
 * Configuración de seguridad global
 */
export const setupSecurity = (app: Express) => {
  app.use(
    helmet({
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
    const allowed = [
      process.env.FRONTEND_URL || "http://localhost:5173",
      "http://localhost:5173",
      "http://localhost:5174",
    ];
    if (!origin || allowed.includes(origin)) {
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
  exposedHeaders: ["Set-Cookie"],
  maxAge: 600,
};

/**
 * Constantes de seguridad
 */
export const SECURITY_CONSTANTS = {
  RATE_LIMIT_WINDOW_MS: 15 * 60 * 1000,
  LOGIN_MAX_ATTEMPTS: 5,
  CREATE_USER_MAX_ATTEMPTS: 10,
  GENERAL_MAX_REQUESTS: 100,
  JWT_EXPIRATION: "8h",
  COOKIE_MAX_AGE: 8 * 60 * 60 * 1000,
  BCRYPT_ROUNDS: 12,
  REQUEST_TIMEOUT_MS: 30000,
  DB_QUERY_TIMEOUT_MS: 10000,
  MAX_USERS_TO_CHECK: 1000,
  MAX_REQUEST_BODY_SIZE: "10mb",
  MAX_JSON_SIZE: "5mb",
};