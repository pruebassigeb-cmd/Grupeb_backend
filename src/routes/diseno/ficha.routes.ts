import { Router } from "express";
import {
  authMiddleware,
  checkAnyPermiso,
  checkPermiso,
  PERMISO_EDITAR_DISENO,
  PERMISO_ORDEN_DISENO,
} from "../../middlewares/auth.middleware";
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

const accesoFichaChat = checkAnyPermiso(
  PERMISO_EDITAR_DISENO,
  PERMISO_ORDEN_DISENO
);
const editarDiseno = checkPermiso(PERMISO_EDITAR_DISENO);

// Las rutas con segmento fijo van antes que las de parámetro,
// para que /sugerencias no se coma como si fuera un :idficha.
router.get("/sugerencias", authMiddleware, accesoFichaChat, sugerencias);
router.get("/catalogo-acabados", authMiddleware, accesoFichaChat, catalogoAcabados);
router.post("/catalogo-acabados", authMiddleware, editarDiseno, agregarOpcionCatalogo);
router.get("/zonas/:familia", authMiddleware, accesoFichaChat, zonas);
router.post("/zonas/:familia", authMiddleware, editarDiseno, agregarZona);
router.get("/redes-cliente/:idclientes", authMiddleware, accesoFichaChat, redesCliente);
router.post("/redes-cliente/:idclientes", authMiddleware, editarDiseno, guardarRedCliente);

router.get("/orden/:ordenId", authMiddleware, accesoFichaChat, obtenerFicha);
router.post("/orden/:ordenId", authMiddleware, editarDiseno, crear);

router.put("/:idficha", authMiddleware, editarDiseno, guardar);
router.get("/:idficha/pdf", authMiddleware, accesoFichaChat, pdf);
router.get("/:idficha/cambios-producto", authMiddleware, accesoFichaChat, cambiosProducto);
router.post("/:idficha/refrescar", authMiddleware, editarDiseno, refrescar);
router.post("/:idficha/publicar", authMiddleware, editarDiseno, publicar);
router.post("/:idficha/imagen", authMiddleware, editarDiseno, agregarImagen);

export default router;
