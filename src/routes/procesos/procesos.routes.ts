import { Router } from "express";
import {
  getProcesosOrden,
  iniciarProceso,
  finalizarProceso,
  resagarProceso,
  editarProceso,
  registrarAvance,
  getAvancesProceso,
} from "../../controllers/procesos/procesosController";
import { authMiddleware } from "../../middlewares/auth.middleware";

const router = Router();

// ==========================
// RUTAS
// GET procesos → cualquier usuario autenticado puede ver.
// POST/PUT acciones → requieren autenticación base.
// La autorización real del operador se verifica en el
// frontend mediante /auth/verificar-operador (popup),
// que valida correo + código + proceso antes de llamar
// a estos endpoints.
// ==========================

// GET /api/procesos/:idproduccion
router.get("/:idproduccion", authMiddleware, getProcesosOrden);

// POST /api/procesos/:idproduccion/iniciar
router.post("/:idproduccion/iniciar", authMiddleware, iniciarProceso);

// PUT /api/procesos/:idproduccion/finalizar
router.put("/:idproduccion/finalizar", authMiddleware, finalizarProceso);

// PUT /api/procesos/:idproduccion/resagar
router.put("/:idproduccion/resagar", authMiddleware, resagarProceso);

// PUT /api/procesos/:idproduccion/editar/:tabla
router.put("/:idproduccion/editar/:tabla", authMiddleware, editarProceso);

// POST /api/procesos/:idproduccion/avance
router.post("/:idproduccion/avance", authMiddleware, registrarAvance);

// GET /api/procesos/:idproduccion/avances
router.get("/:idproduccion/avances", authMiddleware, getAvancesProceso);

export default router;