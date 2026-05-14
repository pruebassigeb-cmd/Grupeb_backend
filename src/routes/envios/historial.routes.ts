import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { getHistorialLocal, getHistorialPaqueteria } from "../../controllers/envios/historial.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";

const router = Router();

router.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(generalLimiter);

// GET /historial/local?fecha_inicio=&fecha_fin=&idunidad=&idusuario=&no_pedido=&cliente=
router.get("/local",      authMiddleware, getHistorialLocal);

// GET /historial/paqueteria?fecha_inicio=&fecha_fin=&idpaqueteria=&numero_guia=&no_pedido=&cliente=&estado=
router.get("/paqueteria", authMiddleware, getHistorialPaqueteria);

export default router;