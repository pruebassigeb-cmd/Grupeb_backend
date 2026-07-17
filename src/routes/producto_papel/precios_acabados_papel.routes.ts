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

const router = Router();

// Valor único usado por la fórmula del laminado.
router.get("/costo-metro", getCostoMetroLaminado);
router.put("/costo-metro", updateCostoMetroLaminado);

router.get("/catalogos", getCatalogosPreciosAcabadosPapel);
router.get("/matriz/:idAcabado", getMatrizPreciosAcabadoPapel);
router.put("/matriz/:idAcabado", updateMatrizPreciosAcabadoPapel);

router.post("/escalas", createEscalaCostoPapel);
router.put("/escalas/:id", updateEscalaCostoPapel);
router.patch("/escalas/:id/estado", toggleEscalaCostoPapel);

router.patch("/acabados/:id/estado", toggleAcabadoCostoPapel);

export default router;
