import { Router } from "express";
import {
  getTipoCambioActual,
  getTipoCambioHistorial,
} from "../../controllers/tipoCambio/tipoCambio.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";

const router = Router();

const PERMISO = "precios.gestionar";

// ── GET — cualquier autenticado (precargar formularios de cotización/pago) ──
router.get("/actual", authMiddleware, getTipoCambioActual);

// ── Historial — requiere permiso de catálogo de precios ──
// No hay corrección manual: el tipo de cambio es 100% automático (Banxico).
router.get("/historial", authMiddleware, checkPermiso(PERMISO), getTipoCambioHistorial);

export default router;
