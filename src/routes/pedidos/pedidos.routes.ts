// ─── pedidos.routes.ts (versión actualizada) ─────────────────────────────────

import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  getPedidos,
  eliminarPedido,
  actualizarPedido,       // ← nuevo
  eliminarPedidoCompleto,
  getHistorialPedidosPorCliente,
  cambiarMonedaPedido,
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

// Split en la fase 0: "Eliminar Pedido" es privilegio propio desde entonces
// (antes solo lo exigía el código, sin existir en la tabla — ver P3 del plan).
const PERMISO = "pedido.crear_editar";

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
  checkPermiso("pedido.eliminar"),
  eliminarPedido
);

router.put(
  "/:id/moneda",
  authMiddleware,
  checkPermiso(PERMISO),
  cambiarMonedaPedido
);

router.delete(
  "/:noPedido/completo",
  authMiddleware,
  checkPermiso("pedido.eliminar"),
  eliminarPedidoCompleto
);


export default router;