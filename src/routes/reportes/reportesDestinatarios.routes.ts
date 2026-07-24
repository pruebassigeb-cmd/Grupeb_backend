// src/routes/reportes/reportesDestinatarios.routes.ts
import { Router } from "express";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
import {
  getDestinatariosReporte,
  actualizarDestinatarioReporte,
} from "../../controllers/reportes/reportesDestinatarios.controller";

const router = Router();

// Reusa el mismo permiso que protege el módulo de Usuarios
const PERMISO_USUARIOS = "Crear/Editar/Eliminar Usuarios";

router.get("/destinatarios", authMiddleware, checkPermiso(PERMISO_USUARIOS), getDestinatariosReporte);
router.put("/destinatarios/:idusuario", authMiddleware, checkPermiso(PERMISO_USUARIOS), actualizarDestinatarioReporte);

export default router;