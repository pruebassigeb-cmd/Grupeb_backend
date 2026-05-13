import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import {
  backupManual,
  getSchedule,
  updateSchedule,
  getHistorialBackups,
  verificarCodigo,
  diagnostico,
} from "../../controllers/backup/backup.controller";

const router = Router();

// ─── Rutas protegidas ───────────────────────────────────────────
router.post("/manual",           authMiddleware, backupManual);
router.post("/verificar-codigo", authMiddleware, verificarCodigo);
router.get("/schedule",          authMiddleware, getSchedule);
router.put("/schedule",          authMiddleware, updateSchedule);
router.get("/historial",         authMiddleware, getHistorialBackups);

// ─── Diagnóstico — SIN auth, solo para pruebas en local ─────────
// ⚠️  IMPORTANTE: elimina o comenta esta ruta antes de subir a producción
// o agrégale authMiddleware si quieres dejarlo permanente
router.get("/diagnostico", diagnostico);

export default router;