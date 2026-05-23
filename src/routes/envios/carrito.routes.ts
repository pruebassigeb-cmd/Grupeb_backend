import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import {
  getCarrito,
  agregarAlCarrito,
  asignarPaqueteriaCarrito,
  asignarTipoEnvioPedido,
  quitarDelCarrito,
  vaciarCarrito,
  procesarCarrito,
} from "../../controllers/envios/carrito.controller";

const router = Router();

router.get   ("/",                            authMiddleware, getCarrito);
router.post  ("/agregar",                     authMiddleware, agregarAlCarrito);
router.post  ("/tipo-envio",                  authMiddleware, asignarTipoEnvioPedido);
router.patch ("/bulto/:idcarrito/paqueteria", authMiddleware, asignarPaqueteriaCarrito);
router.delete("/quitar/:idbulto",             authMiddleware, quitarDelCarrito);
router.delete("/vaciar",                      authMiddleware, vaciarCarrito);
router.post  ("/procesar",                    authMiddleware, procesarCarrito);

export default router;