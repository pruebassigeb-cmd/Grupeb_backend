// src/routes/producto_papel/precios_acabados_papel.routes.ts
import { Router } from "express";
import {
  createEscalaCostoPapel,
  getCatalogosPreciosAcabadosPapel,
  getCostoMetroLaminado,
  getMatrizPreciosAcabadoPapel,
  toggleAcabadoCostoPapel,
  toggleEscalaCostoPapel,
  updateCostoMetroLaminado,
  updateEscalaCostoPapel,
  updateMatrizPreciosAcabadoPapel,
} from "../../controllers/producto_papel/precios_acabados_papel.controller";
import { authMiddleware, checkAnyPermiso, checkPermiso } from "../../middlewares/auth.middleware";

const PERMISO = "precios.gestionar";
const VER_O_GESTIONAR = checkAnyPermiso("precios.ver", PERMISO);
const router = Router();

// Valor único usado por la fórmula del laminado.
router.get("/costo-metro", authMiddleware, VER_O_GESTIONAR, getCostoMetroLaminado);
router.put("/costo-metro", authMiddleware, checkPermiso(PERMISO), updateCostoMetroLaminado);

router.get("/catalogos", authMiddleware, VER_O_GESTIONAR, getCatalogosPreciosAcabadosPapel);
router.get("/matriz/:idAcabado", authMiddleware, VER_O_GESTIONAR, getMatrizPreciosAcabadoPapel);
router.put("/matriz/:idAcabado", authMiddleware, checkPermiso(PERMISO), updateMatrizPreciosAcabadoPapel);

router.post("/escalas", authMiddleware, checkPermiso(PERMISO), createEscalaCostoPapel);
router.put("/escalas/:id", authMiddleware, checkPermiso(PERMISO), updateEscalaCostoPapel);
router.patch("/escalas/:id/estado", authMiddleware, checkPermiso(PERMISO), toggleEscalaCostoPapel);

router.patch("/acabados/:id/estado", authMiddleware, checkPermiso(PERMISO), toggleAcabadoCostoPapel);

export default router;
