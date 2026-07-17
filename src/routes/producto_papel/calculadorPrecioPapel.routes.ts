import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { calcularPrecioPapelController } from "../../controllers/producto_papel/calculadorPrecioPapel.controller";

const router = Router();

// El proyecto ya aplica el limiter general en /api. No se agrega otro limiter
// aquí para evitar contabilizar dos veces cada recálculo interactivo.
router.post("/", authMiddleware, calcularPrecioPapelController);

export default router;
