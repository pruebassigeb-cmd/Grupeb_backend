import { Router } from "express";
import {
  crearOrdenDiseno,
  getOrdenesDiseno,
  getOrdenDisenoById,
  getMensajesOrden,
  enviarMensaje,
  subirRevision,
  aprobarOrdenDiseno,
  agregarParticipante,
  getNotificaciones,
  marcarNotificacionesLeidas,
  marcarVersionFinal,
  limpiarChatsAntiguos,
  getObservacionProducto
} from "../../controllers/diseno/ordenDiseno.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";

const router = Router();

// ── Notificaciones PRIMERO (antes de /:id para evitar conflicto) ─
router.get("/notificaciones/mis",    authMiddleware, getNotificaciones);
router.patch("/notificaciones/leer", authMiddleware, marcarNotificacionesLeidas);

// ── Lectura ──────────────────────────────────────────────────
router.get("/",             authMiddleware, getOrdenesDiseno);
router.get("/:id",          authMiddleware, getOrdenDisenoById);
router.get("/:id/mensajes", authMiddleware, getMensajesOrden);

// ── Escritura ────────────────────────────────────────────────
router.post("/",                 authMiddleware, crearOrdenDiseno);
router.post("/:id/mensaje",      authMiddleware, enviarMensaje);
router.post("/:id/revision",     authMiddleware, subirRevision);
router.post("/:id/aprobar",      authMiddleware, aprobarOrdenDiseno);
router.post("/:id/participante", authMiddleware, agregarParticipante);

// ── Versión final y limpieza ─────────────────────────────────
router.patch("/:id/revision/:revId/version-final", authMiddleware, marcarVersionFinal);
router.post("/limpiar-chats",                       authMiddleware, limpiarChatsAntiguos);
router.get("/:id/observacion-producto", authMiddleware, getObservacionProducto);

export default router;