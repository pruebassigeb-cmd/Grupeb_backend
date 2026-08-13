import { Router } from "express";
import { upload } from "../../config/multer";
import {
  subirArchivo,
  listarArchivos,
  eliminarArchivo,
  obtenerUrlFirmada,
  obtenerUrlFirmadaLarga,
  verArchivo,
  obtenerEstadisticas,
  getFotosEnvio,
  getFotosNota,
  getArchivosProductoPlastico,
} from "../../controllers/archivo/archivo.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";

const router = Router();

router.post("/upload",             authMiddleware, upload.single("archivo"), subirArchivo);
router.get("/estadisticas",        authMiddleware, obtenerEstadisticas);
router.get("/envio/:idenvio",      authMiddleware, getFotosEnvio);     
router.get("/nota/:idnota",        authMiddleware, getFotosNota);     
router.get("/producto-plastico/:idproducto", authMiddleware, getArchivosProductoPlastico);     
router.get("/",                    authMiddleware, listarArchivos);
router.get("/:id_archivo/url",     authMiddleware, obtenerUrlFirmada);
router.get("/:id_archivo/url-larga", authMiddleware, obtenerUrlFirmadaLarga);
router.get("/:id_archivo/ver",     authMiddleware, verArchivo);
router.delete("/:id_archivo",      authMiddleware, eliminarArchivo);

export default router;