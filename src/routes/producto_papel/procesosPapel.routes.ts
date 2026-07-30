// ════════════════════════════════════════════════════════════════════════
// REGISTRO DE RUTAS — procesos-papel
//
// Router DEDICADO, separado de producto_papel.routes.ts a propósito: ese
// router maneja CRUD de fichas de producto y se monta bajo un prefijo
// como /api/producto-papel -- si las rutas de procesos vivieran ahí,
// quedarían en /api/producto-papel/procesos-papel/... en vez de
// /api/procesos-papel/... (que es lo que el frontend pide), y además
// router.get("/:id", ...) de ese router interceptaría "/procesos-papel/68"
// antes de llegar a la ruta correcta (Express resuelve en orden de
// declaración). Por eso este archivo se monta aparte, directamente en
// /api desde app.ts -- ver instrucción de montaje al final del archivo.
// ════════════════════════════════════════════════════════════════════════

import { Router } from "express";
import {
  getProcesosOrdenPapel,
  iniciarProcesoPapel,
  registrarAvancePapel,
  finalizarProcesoPapel,
  editarProcesoPapel,
  reiniciarProcesoPreparacionPapel,
} from "../../controllers/producto_papel/procesosPapel.controller";

const router = Router();

router.get("/procesos-papel/:idproduccion", getProcesosOrdenPapel);
router.post("/procesos-papel/:idproduccion/iniciar", iniciarProcesoPapel);
router.post("/procesos-papel/:idproduccion/avance", registrarAvancePapel);
router.put("/procesos-papel/:idproduccion/finalizar", finalizarProcesoPapel);
router.put("/procesos-papel/:idproduccion/editar/:tabla", editarProcesoPapel);

// Único endpoint destructivo: reiniciar Hojeado o Guillotina cuando el
// operador eligió la máquina equivocada (ver comentario en el controller).
router.delete("/procesos-papel/:idproduccion/reiniciar/:tabla", reiniciarProcesoPreparacionPapel);

export default router;

// ════════════════════════════════════════════════════════════════════════
// CÓMO MONTAR ESTE ROUTER EN app.ts
//
// Busca donde montas tu router de producto_papel, algo como:
//   app.use("/api/producto-papel", productoPapelRoutes);
//
// Y agrega, AL MISMO NIVEL (directamente bajo /api, sin sub-prefijo):
//   import procesosPapelRoutes from "./routes/producto_papel/procesosPapel.routes";
//   app.use("/api", procesosPapelRoutes);
//
// Esto deja las rutas finales exactamente como las pide el frontend:
//   GET  /api/procesos-papel/:idproduccion
//   POST /api/procesos-papel/:idproduccion/iniciar
//   POST /api/procesos-papel/:idproduccion/avance
//   PUT  /api/procesos-papel/:idproduccion/finalizar
//   PUT  /api/procesos-papel/:idproduccion/editar/:tabla
//   DELETE /api/procesos-papel/:idproduccion/reiniciar/:tabla  (solo hojeado_papel/guillotina_papel)
//
// Si tu authMiddleware/checkPermiso se aplican globalmente antes de este
// punto en app.ts, ya cubren estas rutas también. Si no, y quieres
// proteger estos endpoints igual que producto_papel.routes.ts, agrega
// authMiddleware como segundo argumento en cada router.get/post/put,
// igual que se hace ahí.
// ════════════════════════════════════════════════════════════════════════