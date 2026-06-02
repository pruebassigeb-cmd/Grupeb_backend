// ─── pedidos.routes.ts (versión actualizada) ─────────────────────────────────

import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  getPedidos,
  eliminarPedido,
  actualizarPedido,       // ← nuevo
  eliminarPedidoCompleto,
  getHistorialPedidosPorCliente
} from "../../controllers/pedidos/pedidos.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";

const router = Router();

router.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: "Demasiadas solicitudes. Intenta más tarde." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(limiter);

const PERMISO = "Crear/Editar/Eliminar Pedidos";

// ── GET — cualquier autenticado ───────────────────────────
router.get("/", authMiddleware, getPedidos);

router.get(
  "/historial/:clienteId",
  authMiddleware,
  getHistorialPedidosPorCliente
);

// ── Escritura — requiere permiso ──────────────────────────
router.put(
  "/:id",
  authMiddleware,
  checkPermiso(PERMISO),
  actualizarPedido          // ← nuevo
);

router.delete(
  "/:id",
  authMiddleware,
  checkPermiso(PERMISO),
  eliminarPedido
);

router.delete(
  "/:noPedido/completo",
  authMiddleware,
  checkPermiso("Eliminar Pedido"),
  eliminarPedidoCompleto
);


export default router;