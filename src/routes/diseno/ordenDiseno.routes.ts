import { Router, type NextFunction, type Response } from "express";
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
import {
  type AuthRequest,
  authMiddleware,
  checkAnyPermiso,
  checkPermiso,
  PERMISO_EDITAR_DISENO,
  PERMISO_ORDEN_DISENO,
  requireAdminOrSuperUser,
} from "../../middlewares/auth.middleware";

const router = Router();

const accesoFichaChat = checkAnyPermiso(
  PERMISO_EDITAR_DISENO,
  PERMISO_ORDEN_DISENO
);
const editarDiseno = checkPermiso(PERMISO_EDITAR_DISENO);

// Ventas puede adjuntar feedback, pero solo Diseño puede subir un render.
// Los tipos inválidos siguen hacia el controller para responder 400.
const validarTipoRevision = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  if (req.body?.tipo !== "render") return next();
  return editarDiseno(req, res, next);
};

// ── Notificaciones PRIMERO (antes de /:id para evitar conflicto) ─
router.get("/notificaciones/mis", authMiddleware, accesoFichaChat, getNotificaciones);
router.patch("/notificaciones/leer", authMiddleware, accesoFichaChat, marcarNotificacionesLeidas);

// ── Lectura ──────────────────────────────────────────────────
router.get("/", authMiddleware, accesoFichaChat, getOrdenesDiseno);
router.get("/:id", authMiddleware, accesoFichaChat, getOrdenDisenoById);
router.get("/:id/mensajes", authMiddleware, accesoFichaChat, getMensajesOrden);

// ── Escritura ────────────────────────────────────────────────
router.post("/", authMiddleware, accesoFichaChat, crearOrdenDiseno);
router.post("/:id/mensaje", authMiddleware, accesoFichaChat, enviarMensaje);
router.post("/:id/revision", authMiddleware, accesoFichaChat, validarTipoRevision, subirRevision);
router.post("/:id/aprobar", authMiddleware, editarDiseno, aprobarOrdenDiseno);
router.post("/:id/participante", authMiddleware, editarDiseno, agregarParticipante);

// ── Versión final y limpieza ─────────────────────────────────
router.patch("/:id/revision/:revId/version-final", authMiddleware, editarDiseno, marcarVersionFinal);
router.post("/limpiar-chats", authMiddleware, requireAdminOrSuperUser, limpiarChatsAntiguos);
router.get("/:id/observacion-producto", authMiddleware, accesoFichaChat, getObservacionProducto);

export default router;
