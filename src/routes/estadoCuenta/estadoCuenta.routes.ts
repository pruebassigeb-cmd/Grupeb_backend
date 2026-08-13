import { Router } from "express";
import { getEstadoCuenta, getListaEstadoCuenta } from "../../controllers/estadoCuenta/estadoCuentaController";
import { authMiddleware, checkAnyPermiso } from "../../middlewares/auth.middleware";

const VER_O_GESTIONAR = checkAnyPermiso("cobranza.estado_cuenta.ver", "cobranza.anticipo_liquidacion.gestionar");
const router = Router();

//rutas
router.get("/",           authMiddleware, VER_O_GESTIONAR, getListaEstadoCuenta);
router.get("/:noPedido",  authMiddleware, VER_O_GESTIONAR, getEstadoCuenta);

export default router;