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
import { authMiddleware } from "../../middlewares/auth.middleware";

const router = Router();

// Catálogo de métodos de pago
router.get("/metodos-pago", authMiddleware, getMetodosPago);

// Ventas
router.get("/",                         authMiddleware, getVentas);
router.get("/:id",                      authMiddleware, getVentaById);
router.get("/pedido/:noPedido",         authMiddleware, getVentaByPedido);

// Pagos
router.post("/:id/pagos",              authMiddleware, registrarPago);
router.delete("/pagos/:id",            authMiddleware, eliminarPago);

// Anticipo por crédito
router.post("/:id/anticipo-credito",   authMiddleware, autorizarAnticipoCredito);

export default router;