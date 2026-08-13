// src/routes/calcular-precio.routes.ts
import { Router } from "express";
import {
  calcularPrecioPreview,
  calcularPreciosBatch,
} from "../../controllers/cotizaciones/calcular-precio.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";

const PERMISO = "cotizacion.crear_editar";
const router = Router();

router.post("/calcular-precio", authMiddleware, checkPermiso(PERMISO), calcularPrecioPreview);
router.post("/calcular-precios-batch", authMiddleware, checkPermiso(PERMISO), calcularPreciosBatch);

export default router;