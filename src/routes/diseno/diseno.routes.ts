import { Router } from "express";
import {
  getDisenoByPedido,
  actualizarEstadoProducto,
  verificarCondicionesProduccion,
} from "../../controllers/diseno/diseno.controller";
import {
  authMiddleware,
  checkAnyPermiso,
  checkPermiso,
  PERMISO_EDITAR_DISENO,
  PERMISO_ORDEN_DISENO,
} from "../../middlewares/auth.middleware";

const router = Router();

const accesoFichaChat = checkAnyPermiso(
  PERMISO_EDITAR_DISENO,
  PERMISO_ORDEN_DISENO
);

// ── GETs — cualquier autenticado ──────────────────────────
router.get("/pedido/:noPedido", authMiddleware, accesoFichaChat, getDisenoByPedido);
router.get(
  "/pedido/:noPedido/produccion",
  authMiddleware,
  accesoFichaChat,
  verificarCondicionesProduccion
);

// ── Escritura — requiere permiso ──────────────────────────
router.patch(
  "/producto/:id/estado",
  authMiddleware,
  checkPermiso(PERMISO_EDITAR_DISENO),
  actualizarEstadoProducto
);

export default router;
