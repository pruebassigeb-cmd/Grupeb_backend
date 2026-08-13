import { Router } from "express";
import { buscarPorCP } from "../../controllers/codigoPostal/codigoPostal.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";

const router = Router();

// Lookup genérico de códigos postales (dato público del SAT), usado por
// varios formularios de domicilio en toda la app — solo exige sesión, sin
// privilegio específico.
router.get("/:cp", authMiddleware, buscarPorCP);

export default router;