// src/routes/expo.routes.ts
import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  getCatalogoPropio, getCatalogoSistema, crearProductoCatalogo,
  actualizarProductoCatalogo, eliminarProductoCatalogo,
  crearClienteExpo, getClientesExpo, actualizarClienteExpo, eliminarClienteExpo,
  crearCotizacionExpo, getCotizacionesExpo, aprobarCotizacionExpo, eliminarCotizacionExpo,
  getSiguienteFolioExpo,
  getOpcionesRegistroExpo, // ← NUEVA IMPORTACIÓN
} from "../../controllers/expo/expo.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { preventSQLInjection } from "../../middlewares/validation.middleware";
import { generarClaveLimitador } from "../../config/security.config";

const router = Router();

router.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// Límites aflojados (antes 250/60) — el outbox del PWA reintenta cotizaciones
// y correos encolados automáticamente al reconectar, lo que puede sumar más
// tráfico de escritura en ráfaga del que se contempló originalmente.
// keyGenerator por usuario (no por IP): varios vendedores en la misma red
// (ej. wifi de un venue de expo) ya no comparten el mismo presupuesto.
const generalLimiter = rateLimit({ windowMs: 15*60*1000, max: 1000, standardHeaders: true, legacyHeaders: false, keyGenerator: generarClaveLimitador });
const writeLimiter   = rateLimit({ windowMs: 15*60*1000, max: 300,  standardHeaders: true, legacyHeaders: false, keyGenerator: generarClaveLimitador });

router.use(generalLimiter);

// ── OPCIONES DE REGISTRO EXPO ─────────────────────────────────────────────
// ⚠️ DEBE IR ANTES DE /catalogo/:id PARA EVITAR CONFLICTOS
router.get(
  "/catalogo/opciones-registro",
  authMiddleware,
  getOpcionesRegistroExpo
);

// ── Catálogo ──────────────────────────────────────────────
router.get("/catalogo/propio",  authMiddleware, getCatalogoPropio);
router.get("/catalogo/sistema", authMiddleware, getCatalogoSistema);
router.post("/catalogo",        authMiddleware, writeLimiter, preventSQLInjection, crearProductoCatalogo);
router.put("/catalogo/:id",     authMiddleware, writeLimiter, preventSQLInjection, actualizarProductoCatalogo);
router.delete("/catalogo/:id",  authMiddleware, writeLimiter, eliminarProductoCatalogo);

// ── Clientes ──────────────────────────────────────────────
router.get("/clientes",        authMiddleware, getClientesExpo);
router.post("/clientes",       authMiddleware, writeLimiter, preventSQLInjection, crearClienteExpo);
router.put("/clientes/:id",    authMiddleware, writeLimiter, preventSQLInjection, actualizarClienteExpo);
router.delete("/clientes/:id", authMiddleware, writeLimiter, eliminarClienteExpo);

// ── Cotizaciones ──────────────────────────────────────────
router.get("/cotizaciones/siguiente-folio", authMiddleware, getSiguienteFolioExpo);
router.get("/cotizaciones",                 authMiddleware, getCotizacionesExpo);
router.post("/cotizaciones",                authMiddleware, writeLimiter, preventSQLInjection, crearCotizacionExpo);
router.patch("/cotizaciones/:folio/aprobar", authMiddleware, writeLimiter, preventSQLInjection, aprobarCotizacionExpo);
router.delete("/cotizaciones/:folio",        authMiddleware, writeLimiter, eliminarCotizacionExpo);

export default router;