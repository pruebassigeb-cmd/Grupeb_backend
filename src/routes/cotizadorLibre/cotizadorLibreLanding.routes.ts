// src/routes/cotizadorLibre/cotizadorLibreLanding.routes.ts
import { Router } from "express";
import { upload } from "../../config/multer";
import { authMiddleware } from "../../middlewares/auth.middleware";
import {
  getLandingCotizadorLibre,
  crearSlotLandingCotizadorLibre,
  actualizarSlotLandingCotizadorLibre,
  eliminarSlotLandingCotizadorLibre,
  subirImagenSlotLandingCotizadorLibre,
  eliminarImagenSlotLandingCotizadorLibre,
} from "../../controllers/cotizadorLibre/cotizadorLibreLanding.controller";

const router = Router();

// Lectura: cualquier usuario autenticado (incluida la cuenta compartida
// CotizadorLibre) puede ver la landing ya armada.
router.get("/", authMiddleware, getLandingCotizadorLibre);

// Escritura: el candado real de "solo admin" vive dentro del controller
// (esAdmin → user.acceso_total === true), mismo criterio que el resto del
// sistema usa para áreas admin-only.
router.post("/", authMiddleware, crearSlotLandingCotizadorLibre);
router.put("/:id", authMiddleware, actualizarSlotLandingCotizadorLibre);
router.delete("/:id", authMiddleware, eliminarSlotLandingCotizadorLibre);
router.post("/:id/imagen", authMiddleware, upload.single("archivo"), subirImagenSlotLandingCotizadorLibre);
router.delete("/:id/imagen", authMiddleware, eliminarImagenSlotLandingCotizadorLibre);

export default router;