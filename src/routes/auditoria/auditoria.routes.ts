import { Router } from "express";
import {
  authMiddleware,
  requireAdminOrSuperUser,
} from "../../middlewares/auth.middleware";
import {
  getAuditoriaRegistro,
  getTablasAuditables,
} from "../../controllers/auditoria/auditoria.controller";

const router = Router();

// La bitácora contiene información sensible de autoría. No basta con ocultar
// los botones en el frontend: ambos endpoints exigen Admin o Super Usuario
// con acceso_total.
router.get("/tablas", authMiddleware, requireAdminOrSuperUser, getTablasAuditables);
router.get("/:tabla/:id", authMiddleware, requireAdminOrSuperUser, getAuditoriaRegistro);

export default router;
