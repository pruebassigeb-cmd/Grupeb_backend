import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { getFormatoCastores } from "../../controllers/envios/formatoCastores.controller";

const router = Router();

router.get("/:idenvio", authMiddleware, getFormatoCastores);

export default router;