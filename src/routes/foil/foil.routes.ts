import { Router } from "express";
import { getFoils, getFoilById } from "../../controllers/foil/foil.controller";

const router = Router();

router.get("/",    getFoils);
router.get("/:id", getFoilById);

export default router;