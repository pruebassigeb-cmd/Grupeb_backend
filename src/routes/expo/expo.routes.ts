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
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
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

// CORREGIDO (2026-08-14): las 15 rutas solo pedían sesión iniciada, así que
// CUALQUIER usuario autenticado podía leer y escribir el catálogo, los
// clientes y las cotizaciones de Expo. Ahora exigen el privilegio de la
// pantalla, que el rol "Expo" trae en su base
// (migrations/2026-08-14_expo_por_privilegio.sql). Ninguna ruta de este
// archivo es pública, por eso se puede aplicar parejo.
const expoGestionar = checkPermiso("externos.expo.gestionar");

// ── OPCIONES DE REGISTRO EXPO ─────────────────────────────────────────────
// ⚠️ DEBE IR ANTES DE /catalogo/:id PARA EVITAR CONFLICTOS
router.get(
  "/catalogo/opciones-registro",
  authMiddleware, expoGestionar,
  getOpcionesRegistroExpo
);

// ── Catálogo ──────────────────────────────────────────────
router.get("/catalogo/propio",  authMiddleware, expoGestionar, getCatalogoPropio);
router.get("/catalogo/sistema", authMiddleware, expoGestionar, getCatalogoSistema);
router.post("/catalogo",        authMiddleware, expoGestionar, writeLimiter, preventSQLInjection, crearProductoCatalogo);
router.put("/catalogo/:id",     authMiddleware, expoGestionar, writeLimiter, preventSQLInjection, actualizarProductoCatalogo);
router.delete("/catalogo/:id",  authMiddleware, expoGestionar, writeLimiter, eliminarProductoCatalogo);

// ── Clientes ──────────────────────────────────────────────
router.get("/clientes",        authMiddleware, expoGestionar, getClientesExpo);
router.post("/clientes",       authMiddleware, expoGestionar, writeLimiter, preventSQLInjection, crearClienteExpo);
router.put("/clientes/:id",    authMiddleware, expoGestionar, writeLimiter, preventSQLInjection, actualizarClienteExpo);
router.delete("/clientes/:id", authMiddleware, expoGestionar, writeLimiter, eliminarClienteExpo);

// ── Cotizaciones ──────────────────────────────────────────
router.get("/cotizaciones/siguiente-folio", authMiddleware, expoGestionar, getSiguienteFolioExpo);
router.get("/cotizaciones",                 authMiddleware, expoGestionar, getCotizacionesExpo);
router.post("/cotizaciones",                authMiddleware, expoGestionar, writeLimiter, preventSQLInjection, crearCotizacionExpo);
router.patch("/cotizaciones/:folio/aprobar", authMiddleware, expoGestionar, writeLimiter, preventSQLInjection, aprobarCotizacionExpo);
router.delete("/cotizaciones/:folio",        authMiddleware, expoGestionar, writeLimiter, eliminarCotizacionExpo);

export default router;