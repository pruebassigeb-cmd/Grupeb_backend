import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { getOrCreateNota } from "../../controllers/envios/notas.controller";

const router = Router();

router.get("/:idenvio", authMiddleware, getOrCreateNota);

export default router;