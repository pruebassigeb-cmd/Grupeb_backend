import { Router } from "express";
import {
  getProcesosOrden,
  iniciarProceso,
  finalizarProceso,
  resagarProceso,
  editarProceso,
} from "../../controllers/procesos/procesosController";

const router = Router();

router.get( "/:idproduccion",                  getProcesosOrden);
router.post("/:idproduccion/iniciar",          iniciarProceso);
router.put( "/:idproduccion/finalizar",        finalizarProceso);
router.put( "/:idproduccion/resagar",          resagarProceso);
router.put( "/:idproduccion/editar/:tabla",    editarProceso);

export default router;