import { Router } from "express";
import { authMiddleware, requireAccessTotal } from "../../middlewares/auth.middleware";
import {
  backupManual,
  getSchedule,
  updateSchedule,
  getHistorialBackups,
  verificarCodigo,
  diagnostico,
  backupAutomatico,
} from "../../controllers/backup/backup.controller";

const router = Router();

// ─── Rutas protegidas ───────────────────────────────────────────
router.post("/manual",           authMiddleware, backupManual);
router.post("/verificar-codigo", authMiddleware, verificarCodigo);
router.get("/schedule",          authMiddleware, getSchedule);
router.put("/schedule",          authMiddleware, updateSchedule);
router.get("/historial",         authMiddleware, getHistorialBackups);

// ─── Diagnóstico — expone host/puerto/usuario de la BD, así que exige
// acceso total igual que el resto de este router, no solo sesión.
router.get("/diagnostico", authMiddleware, requireAccessTotal, diagnostico);

// Lo llama un cron externo, no un usuario — su propia verificación es el
// header x-cron-secret (ver backupAutomatico en el controller).
router.post("/automatico", backupAutomatico);

export default router;