// src/routes/producto_papel/mermaPapel.routes.ts
import { Router } from "express";
import {
  createEscalaMerma,
  getMatrizMermaPapel,
  getMermaOrdenController,
  getPermisosMermaController,
  recalcularMermaOrdenController,
  resolverEscalaMermaController,
  simularMermaPapel,
  toggleEscalaMerma,
  toggleProcesoMerma,
  updateEscalaMerma,
  updateMatrizMermaPapel,
} from "../../controllers/producto_papel/merma_papel.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";

const PERMISO = "precios.gestionar";
const router = Router();

// ── Matriz ────────────────────────────────────────────────────────────────
router.get("/matriz", authMiddleware, getMatrizMermaPapel);
router.put("/matriz", authMiddleware, checkPermiso(PERMISO), updateMatrizMermaPapel);

// ── Escalas (filas) ───────────────────────────────────────────────────────
router.post("/escalas", authMiddleware, checkPermiso(PERMISO), createEscalaMerma);
router.put("/escalas/:id", authMiddleware, checkPermiso(PERMISO), updateEscalaMerma);
router.patch("/escalas/:id/activo", authMiddleware, checkPermiso(PERMISO), toggleEscalaMerma);

// ── Conceptos / procesos (columnas) ───────────────────────────────────────
router.patch("/procesos/:id/activo", authMiddleware, checkPermiso(PERMISO), toggleProcesoMerma);

// ── Herramientas de validación ────────────────────────────────────────────
router.get("/simular", authMiddleware, simularMermaPapel);
router.get("/escala", authMiddleware, resolverEscalaMermaController);

// ── Snapshot por orden ────────────────────────────────────────────────────
router.get("/permisos", authMiddleware, getPermisosMermaController);
router.get("/orden/:idproduccion", authMiddleware, getMermaOrdenController);
// 🔒 Solo roles con acceso_total. La validación está DENTRO del controller,
// no aquí: así no depende de que alguien recuerde poner un middleware.
router.post("/orden/:idproduccion/recalcular", authMiddleware, recalcularMermaOrdenController);

export default router;

// ═══════════════════════════════════════════════════════════════════════════
// REGISTRO EN EL APP PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════
// En src/app.ts (o donde se monten las demás rutas de papel), agregar:
//
//   import mermaPapelRoutes from "./routes/producto_papel/mermaPapel.routes";
//   app.use("/merma-papel", <middlewareDeAuth>, mermaPapelRoutes);
//
// El middleware de auth es necesario para que req.usuario exista: sin él,
// getUsuarioId() devuelve null y el recálculo responderá 401.
// ═══════════════════════════════════════════════════════════════════════════