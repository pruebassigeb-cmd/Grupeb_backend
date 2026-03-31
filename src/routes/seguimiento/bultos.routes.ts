import { Router } from "express";
import {
  getBultos,
  agregarBulto,
  eliminarBulto,
  finalizarBultos,
  getBultosEtiqueta,
  editarBulto,
} from "../../controllers/bultos/bultos.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";

const router = Router({ mergeParams: true });

// ==========================
// RUTAS
// Bultos pertenece al flujo de seguimiento/producción.
// Accesible para cualquier usuario autenticado.
// Las acciones de escritura son operadas por el personal
// de planta verificado mediante el popup de operador.
// ==========================

// GET /api/seguimiento/:idproduccion/bultos
router.get("/", authMiddleware, getBultos);

// POST /api/seguimiento/:idproduccion/bultos
router.post("/", authMiddleware, agregarBulto);

// PUT /api/seguimiento/:idproduccion/bultos/:idbulto
router.put("/:idbulto", authMiddleware, editarBulto);

// DELETE /api/seguimiento/:idproduccion/bultos/:idbulto
router.delete("/:idbulto", authMiddleware, eliminarBulto);

// PATCH /api/seguimiento/:idproduccion/bultos/finalizar
router.patch("/finalizar", authMiddleware, finalizarBultos);

// GET /api/seguimiento/:idproduccion/bultos/etiqueta
router.get("/etiqueta", authMiddleware, getBultosEtiqueta);

export default router;