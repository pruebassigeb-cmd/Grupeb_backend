import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  getCatalogoPropio, getCatalogoSistema, crearProductoCatalogo,
  actualizarProductoCatalogo, eliminarProductoCatalogo,
  crearClienteExpo, getClientesExpo, actualizarClienteExpo, eliminarClienteExpo,
  crearCotizacionExpo, getCotizacionesExpo, aprobarCotizacionExpo, eliminarCotizacionExpo,
  getSiguienteFolioExpo,
} from "../../controllers/expo/expo.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { preventSQLInjection } from "../../middlewares/validation.middleware";

const router = Router();

router.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const generalLimiter = rateLimit({ windowMs: 15*60*1000, max: 200, standardHeaders: true, legacyHeaders: false });
const writeLimiter   = rateLimit({ windowMs: 15*60*1000, max: 60,  standardHeaders: true, legacyHeaders: false });

router.use(generalLimiter);

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