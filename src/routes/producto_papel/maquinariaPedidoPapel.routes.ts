import { Router } from "express";
import { guardarMaquinariaPedidoPapel } from "../../controllers/producto_papel/maquinariaPedidoPapel.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";

const router = Router();

router.patch(
  "/:noPedido/maquinaria-papel",
  authMiddleware,
  guardarMaquinariaPedidoPapel
);

export default router;
