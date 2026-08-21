import { Router } from "express";
import { getSeguimiento, getOrdenProduccion, getCuentasPorCobrar,
 } from "../../controllers/seguimiento/seguimiento.controller";
//import { getOrdenProduccion } from "../../controllers/seguimiento/getOrdenProduccion.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";

const router = Router();

// ==========================
// RUTAS
// GET seguimiento y orden-produccion son accesibles para
// cualquier usuario autenticado (incluyendo rol Planta).
// La verificación de operador para acciones de procesos
// se maneja desde el frontend con /auth/verificar-operador.
// ==========================

// GET /api/seguimiento
router.get("/", authMiddleware, getSeguimiento);

// GET /api/seguimiento/cuentas-por-cobrar
router.get("/cuentas-por-cobrar", authMiddleware, getCuentasPorCobrar);

// GET /api/seguimiento/:noPedido/orden-produccion
router.get("/:noPedido/orden-produccion", authMiddleware, getOrdenProduccion);

export default router;