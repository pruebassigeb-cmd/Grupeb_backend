import { Router } from "express";
import {
  getTipoCambioActual,
  getTipoCambioHistorial,
  putTipoCambioManual,
} from "../../controllers/tipoCambio/tipoCambio.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";

const router = Router();

const PERMISO = "Modificar Catalogo de precios";

// ── GET — cualquier autenticado (precargar formularios de cotización/pago) ──
router.get("/actual", authMiddleware, getTipoCambioActual);

// ── Historial y corrección manual — requieren permiso de catálogo de precios ──
router.get("/historial", authMiddleware, checkPermiso(PERMISO), getTipoCambioHistorial);
router.put("/manual", authMiddleware, checkPermiso(PERMISO), putTipoCambioManual);

export default router;
