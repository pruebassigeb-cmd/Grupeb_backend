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
import { resolverOperadorProceso } from "../../middlewares/procesoToken.middleware";

const router = Router();

// ==========================
// RUTAS
// GET procesos → cualquier usuario autenticado puede ver.
// POST/PUT acciones → requieren autenticación base.
// La autorización real del operador se verifica en el
// frontend mediante /auth/verificar-operador (popup),
// que valida correo + código + proceso antes de llamar
// a estos endpoints.
//
// resolverOperadorProceso (fase 5): si la petición trae un token de
// proceso válido (emitido por ese mismo popup), la bitácora de auditoría
// atribuye la escritura al operador real en vez de a la cuenta de sesión
// (la compartida de Planta). No exige el token — si falta, todo sigue
// igual que antes.
// ==========================

// GET /api/procesos/:idproduccion
router.get("/:idproduccion", authMiddleware, getProcesosOrden);

// POST /api/procesos/:idproduccion/iniciar
router.post("/:idproduccion/iniciar", authMiddleware, resolverOperadorProceso, iniciarProceso);

// PUT /api/procesos/:idproduccion/finalizar
router.put("/:idproduccion/finalizar", authMiddleware, resolverOperadorProceso, finalizarProceso);

// PUT /api/procesos/:idproduccion/resagar
router.put("/:idproduccion/resagar", authMiddleware, resolverOperadorProceso, resagarProceso);

// PUT /api/procesos/:idproduccion/editar/:tabla
router.put("/:idproduccion/editar/:tabla", authMiddleware, resolverOperadorProceso, editarProceso);

// POST /api/procesos/:idproduccion/avance
router.post("/:idproduccion/avance", authMiddleware, resolverOperadorProceso, registrarAvance);

// GET /api/procesos/:idproduccion/avances
router.get("/:idproduccion/avances", authMiddleware, getAvancesProceso);

export default router;