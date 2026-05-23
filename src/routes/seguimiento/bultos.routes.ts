import { Router } from "express";
import {
  getBultos,
  agregarBulto,
  agregarBultosBatch,
  eliminarBulto,
  finalizarBultos,
  getBultosEtiqueta,
  marcarBultosParcialidad,
  editarBulto,
} from "../../controllers/bultos/bultos.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";

const router = Router({ mergeParams: true });

// GET /api/seguimiento/:idproduccion/bultos
router.get("/", authMiddleware, getBultos);

// POST /api/seguimiento/:idproduccion/bultos/batch  ← antes del POST /
router.post("/batch", authMiddleware, agregarBultosBatch);

// POST /api/seguimiento/:idproduccion/bultos
router.post("/", authMiddleware, agregarBulto);

// PUT /api/seguimiento/:idproduccion/bultos/:idbulto
router.put("/:idbulto", authMiddleware, editarBulto);

// DELETE /api/seguimiento/:idproduccion/bultos/:idbulto
router.delete("/:idbulto", authMiddleware, eliminarBulto);

// PATCH /api/seguimiento/:idproduccion/bultos/finalizar
router.patch("/finalizar", authMiddleware, finalizarBultos);

// PATCH /api/seguimiento/:idproduccion/bultos/marcar-parcialidad
router.patch("/marcar-parcialidad", authMiddleware, marcarBultosParcialidad);

// GET /api/seguimiento/:idproduccion/bultos/etiqueta
router.get("/etiqueta", authMiddleware, getBultosEtiqueta);

export default router;