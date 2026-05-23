import { Router } from "express";
import { upload } from "../../config/multer";
import {
  subirArchivo,
  listarArchivos,
  eliminarArchivo,
  obtenerUrlFirmada,
  verArchivo,
  obtenerEstadisticas,
  getFotosEnvio,
} from "../../controllers/archivo/archivo.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";

const router = Router();

router.post("/upload",             authMiddleware, upload.single("archivo"), subirArchivo);
router.get("/estadisticas",        authMiddleware, obtenerEstadisticas);
router.get("/envio/:idenvio",      authMiddleware, getFotosEnvio);          // ← NUEVO
router.get("/",                    authMiddleware, listarArchivos);
router.get("/:id_archivo/url",     authMiddleware, obtenerUrlFirmada);
router.get("/:id_archivo/ver",     verArchivo);
router.delete("/:id_archivo",      authMiddleware, eliminarArchivo);

export default router;