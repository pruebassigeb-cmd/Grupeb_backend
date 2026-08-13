import { Router } from "express";
import { getFoils, getFoilById } from "../../controllers/foil/foil.controller";
import { authMiddleware, checkAnyPermiso } from "../../middlewares/auth.middleware";

const VER = checkAnyPermiso("catalogos.ver", "catalogos.foil.gestionar");
const router = Router();

router.get("/",    authMiddleware, VER, getFoils);
router.get("/:id", authMiddleware, VER, getFoilById);

export default router;