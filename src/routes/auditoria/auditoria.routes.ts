import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import {
  getAuditoriaRegistro,
  getTablasAuditables,
} from "../../controllers/auditoria/auditoria.controller";

const router = Router();

// El privilegio por tabla lo revisa el controller, porque depende de cuál
// tabla se pidió. Aquí solo se exige estar autenticado.
router.get("/tablas", authMiddleware, getTablasAuditables);
router.get("/:tabla/:id", authMiddleware, getAuditoriaRegistro);

export default router;
