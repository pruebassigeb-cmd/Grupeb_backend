import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import {
  getOrCreateNota,
  crearNotaMulti,
  getNotaMulti,
} from "../../controllers/envios/notaRemisionMulti.controller";

const router = Router();

// ==========================================
// NOTA MULTI-PEDIDO
// ==========================================

// Crear nota multi
router.post("/multi", authMiddleware, crearNotaMulti);

// Obtener nota multi
router.get("/multi/:idnota", authMiddleware, getNotaMulti);

// ==========================================
// NOTA SIMPLE (IMPORTANTE: VA AL FINAL)
// ==========================================

// Obtener o crear nota simple por envío
router.get("/:idenvio", authMiddleware, getOrCreateNota);

export default router;