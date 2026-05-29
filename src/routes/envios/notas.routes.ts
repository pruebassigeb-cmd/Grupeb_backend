import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import {
  getOrCreateNota,
  crearNotaMulti,
  getNotaMulti,
  getNotasBitacora,
  marcarRecolectadoNota,
  marcarEntregadoLocalNota,
  marcarSalidaLocalNota,
} from "../../controllers/envios/notaRemisionMulti.controller";

const router = Router();

// ── Multi ──
router.post("/multi",        authMiddleware, crearNotaMulti);
router.get("/multi/:idnota", authMiddleware, getNotaMulti);

// ── Bitácora (ANTES de /:idenvio) ──
router.get("/bitacora", authMiddleware, getNotasBitacora);

// ── Marcar entregados (ANTES de /:idenvio) ──
router.patch("/:idnota/marcar-recogido",        authMiddleware, marcarRecolectadoNota);
router.patch("/:idnota/marcar-entregado-local", authMiddleware, marcarEntregadoLocalNota);
router.patch("/:idnota/marcar-salida-local", authMiddleware, marcarSalidaLocalNota);

// ── Simple (VA AL FINAL) ──
router.get("/:idenvio", authMiddleware, getOrCreateNota);

export default router;