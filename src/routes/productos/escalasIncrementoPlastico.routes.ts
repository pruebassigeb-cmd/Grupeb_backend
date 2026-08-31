// src/routes/plastico/escalasIncrementoPlastico.routes.ts
import { Router } from "express";
import {
  getEscalasAsaFlexible,
  updateEscalasAsaFlexibleBatch,
  getEscalasCintaSeguridad,
  updateEscalasCintaSeguridadBatch,
} from "../../controllers/productos/escalasIncrementoPlastico.controller";
import { authMiddleware, checkAnyPermiso, checkPermiso } from "../../middlewares/auth.middleware";

// Mismo permiso que ya usa la pantalla de "Costos de Producción - Plástico"
// (tarifas.routes.ts) — estas escalas viven en esa misma pantalla.
const PERMISO = "precios.gestionar";
const VER_O_GESTIONAR = checkAnyPermiso("precios.ver", PERMISO);

const router = Router();

router.get("/asa-flexible", authMiddleware, VER_O_GESTIONAR, getEscalasAsaFlexible);
router.put("/asa-flexible/batch", authMiddleware, checkPermiso(PERMISO), updateEscalasAsaFlexibleBatch);

router.get("/cinta-seguridad", authMiddleware, VER_O_GESTIONAR, getEscalasCintaSeguridad);
router.put("/cinta-seguridad/batch", authMiddleware, checkPermiso(PERMISO), updateEscalasCintaSeguridadBatch);

export default router;

// Montaje en app.ts (ya lo hiciste antes, sin cambios):
//   app.use("/api/escalas-incremento-plastico", escalasIncrementoPlasticoRoutes);