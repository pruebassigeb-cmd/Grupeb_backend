import { Router } from "express";
import {
  getVentas,
  getVentaById,
  getVentaByPedido,
  registrarPago,
  eliminarPago,
  getMetodosPago,
  autorizarAnticipoCredito,
} from "../../controllers/ventas/ventas.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";

const router = Router();

const PERMISO = "Editar Anticipo y Liquidacion";

// ── GETs — cualquier autenticado ──────────────────────────
router.get("/metodos-pago",       authMiddleware, getMetodosPago);
router.get("/",                   authMiddleware, getVentas);
router.get("/pedido/:noPedido",   authMiddleware, getVentaByPedido);
router.get("/:id",                authMiddleware, getVentaById);

// ── Escritura — requiere permiso ──────────────────────────
router.post(
  "/:id/pagos",
  authMiddleware,
  checkPermiso(PERMISO),
  registrarPago
);

router.delete(
  "/pagos/:id",
  authMiddleware,
  checkPermiso(PERMISO),
  eliminarPago
);

router.post(
  "/:id/anticipo-credito",
  authMiddleware,
  checkPermiso(PERMISO),
  autorizarAnticipoCredito
);

export default router;