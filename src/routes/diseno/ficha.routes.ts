import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import {
  obtenerFicha,
  crear,
  guardar,
  publicar,
  agregarImagen,
  sugerencias,
  redesCliente,
  guardarRedCliente,
  zonas,
  pdf,
  cambiosProducto,
  refrescar,
  catalogoAcabados,
  agregarOpcionCatalogo,
  agregarZona,
} from "../../controllers/diseno/ficha.controller";

const router = Router();

// Las rutas con segmento fijo van antes que las de parámetro,
// para que /sugerencias no se coma como si fuera un :idficha.
router.get("/sugerencias", authMiddleware, sugerencias);
router.get("/catalogo-acabados", authMiddleware, catalogoAcabados);
router.post("/catalogo-acabados", authMiddleware, agregarOpcionCatalogo);
router.get("/zonas/:familia", authMiddleware, zonas);
router.post("/zonas/:familia", authMiddleware, agregarZona);
router.get("/redes-cliente/:idclientes", authMiddleware, redesCliente);
router.post("/redes-cliente/:idclientes", authMiddleware, guardarRedCliente);

router.get("/orden/:ordenId", authMiddleware, obtenerFicha);
router.post("/orden/:ordenId", authMiddleware, crear);

router.put("/:idficha", authMiddleware, guardar);
router.get("/:idficha/pdf", authMiddleware, pdf);
router.get("/:idficha/cambios-producto", authMiddleware, cambiosProducto);
router.post("/:idficha/refrescar", authMiddleware, refrescar);
router.post("/:idficha/publicar", authMiddleware, publicar);
router.post("/:idficha/imagen", authMiddleware, agregarImagen);

export default router;