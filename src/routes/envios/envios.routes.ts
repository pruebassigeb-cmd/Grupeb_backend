import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  getPedidosDisponibles,
  getBultosPedido,
  createEnvio,
  getEnviosPedido,
  updateEstadoEnvio,
  deleteEnvio,
  getEnviosPaqueteria,
  updateGuiaEnvio,
  getProductosSat,
  getGuiaGeneral,
  updateClavesSatBultos,
} from "../../controllers/envios/envios.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { validateId, preventSQLInjection } from "../../middlewares/validation.middleware";

const router = Router();

router.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
const writeLimiter   = rateLimit({ windowMs: 15 * 60 * 1000, max: 30,  standardHeaders: true, legacyHeaders: false });

router.use(generalLimiter);

// Catálogo SAT — general, disponible para todos los formatos
router.get("/catalogos/productos-sat", authMiddleware, getProductosSat);

// Pedidos disponibles
router.get("/pedidos-disponibles", authMiddleware, getPedidosDisponibles);

// Bultos de un pedido
router.get("/pedidos/:idsolicitud/bultos", authMiddleware, getBultosPedido);

// Envíos de un pedido
router.get("/pedidos/:idsolicitud/envios", authMiddleware, getEnviosPedido);

// Historial paquetería
router.get("/paqueteria/historial", authMiddleware, getEnviosPaqueteria);

// Guía general paquetería (antes de /:id/guia para evitar conflicto de rutas)
router.get("/:id/guia-general",       authMiddleware, validateId, getGuiaGeneral);

// Guardar claves SAT de bultos de un envío
router.patch("/:id/claves-sat",       authMiddleware, writeLimiter, validateId, updateClavesSatBultos);

// Actualizar guía
router.patch("/:id/guia", authMiddleware, writeLimiter, validateId, updateGuiaEnvio);

// Crear envío
router.post(
  "/", authMiddleware,
  writeLimiter, preventSQLInjection, createEnvio
);

// Actualizar estado
router.patch(
  "/:id/estado", authMiddleware,
  writeLimiter, validateId, updateEstadoEnvio
);

// Cancelar envío
router.delete(
  "/:id", authMiddleware,
  writeLimiter, validateId, deleteEnvio
);

export default router;