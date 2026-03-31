import { Router } from "express";
import {
  getDisenoByPedido,
  actualizarEstadoProducto,
  verificarCondicionesProduccion,
} from "../../controllers/diseno/diseno.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";

const router = Router();

const PERMISO = "Editar Diseño";

// ── GETs — cualquier autenticado ──────────────────────────
router.get("/pedido/:noPedido",            authMiddleware, getDisenoByPedido);
router.get("/pedido/:noPedido/produccion", authMiddleware, verificarCondicionesProduccion);

// ── Escritura — requiere permiso ──────────────────────────
router.patch(
  "/producto/:id/estado",
  authMiddleware,
  checkPermiso(PERMISO),
  actualizarEstadoProducto
);

export default router;