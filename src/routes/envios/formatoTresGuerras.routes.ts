import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { getFormatoTresGuerras } from "../../controllers/envios/formatoTresGuerras.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";

const router = Router();

router.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
router.use(generalLimiter);

// Sin validateId porque ese middleware espera param "id", no "idenvio"
router.get("/:idenvio", authMiddleware, getFormatoTresGuerras);

export default router;