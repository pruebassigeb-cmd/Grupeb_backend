import { Router } from "express";
import { buscarPorCP } from "../../controllers/codigoPostal/codigoPostal.controller";

const router = Router();

router.get("/:cp", buscarPorCP);

export default router;