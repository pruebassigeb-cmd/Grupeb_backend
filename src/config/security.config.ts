import helmet from "helmet";
import { Express, Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

/**
 * Los rate limiters cuentan por IP por defecto — un problema real cuando
 * varios usuarios comparten la misma red (ej. el wifi del venue en una
 * expo): todos comparten el mismo presupuesto de peticiones, y uno solo
 * reconectando repetidamente puede agotarlo para los demás. Esta función
 * identifica por usuario autenticado cuando es posible (requiere que
 * `optionalAuth` ya haya corrido antes en la cadena de middlewares — ver
 * `app.ts` — para que `req.user` ya esté poblado en este punto) y cae a IP
 * (normalizada para IPv6) solo para peticiones sin sesión, como login.
 */
export function generarClaveLimitador(req: Request): string {
  const usuarioId = (req as Request & { user?: { id?: number } }).user?.id;
  return usuarioId ? `user:${usuarioId}` : ipKeyGenerator(req.ip ?? "desconocida");
}

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
  COTIZADOR_LIBRE_PRECIO_WINDOW_MS: 60 * 1000,
  COTIZADOR_LIBRE_PRECIO_MAX_REQUESTS: 60,
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
  keyGenerator:   generarClaveLimitador,
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
  keyGenerator:   generarClaveLimitador,
  message:        { error: "Demasiadas solicitudes de aprobación, espera un momento." },
});

/**
 * Rate limiter estricto para login — se queda por IP a propósito (no por
 * usuario): antes de autenticarse no hay `req.user` que usar, y el punto de
 * este limiter es justo frenar intentos de login repetidos desde el mismo
 * origen antes de que exista una sesión.
 */
export const loginLimiter = rateLimit({
  windowMs:       SECURITY_CONSTANTS.RATE_LIMIT_WINDOW_MS,
  max:            SECURITY_CONSTANTS.LOGIN_MAX_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders:  false,
  message:        { error: "Demasiados intentos de inicio de sesión. Intenta más tarde." },
});

/**
 * Rate limiter para el cálculo de precio del Cotizador Interactivo — ventana
 * mucho más corta que el resto (1 minuto, no 15) porque cada llamada dispara
 * una consulta real contra el motor de precios (papel o plástico), no una
 * lectura simple, y el frontend la va a disparar seguido mientras el cliente
 * configura su producto en vivo. 60/min por usuario es suficiente para uso
 * normal sin dejar la puerta abierta a sondear la tabla de precios a fuerza
 * bruta probando combinaciones.
 */
export const cotizadorLibrePrecioLimiter = rateLimit({
  windowMs:       SECURITY_CONSTANTS.COTIZADOR_LIBRE_PRECIO_WINDOW_MS,
  max:            SECURITY_CONSTANTS.COTIZADOR_LIBRE_PRECIO_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders:  false,
  keyGenerator:   generarClaveLimitador,
  message:        { error: "Demasiadas solicitudes de cálculo de precio. Espera un momento." },
});