import { Router } from "express";
import {
  listarCatalogoInsumo,
  crearCatalogoInsumo,
  desactivarCatalogoInsumo,
  reactivarCatalogoInsumo,
} from "../../controllers/catalogos_papel/catalogosPapelInsumo.controller";
// import { authMiddleware } from "../../middlewares/auth.middleware"; // agrega si tus otras rutas de catálogos lo usan

const router = Router();

// router.use(authMiddleware);

// :catKey ∈ tipo_papel | pegamento | laminado | sacabocados | perforado | matrix
router.get("/:catKey", listarCatalogoInsumo);
router.post("/:catKey", crearCatalogoInsumo);
router.patch("/:catKey/:id/reactivar", reactivarCatalogoInsumo); // antes de la genérica :id
router.patch("/:catKey/:id", desactivarCatalogoInsumo);

export default router;

// ═══════════════════════════════════════════════════════════════════════════
// Montaje sugerido en app.ts, junto a tu ruta de catalogos-papel existente:
//
//   import catalogosPapelInsumoRoutes from "./routes/catalogos_papel/catalogosPapelInsumo.routes";
//   app.use("/api/catalogos-papel/insumo", catalogosPapelInsumoRoutes);
//
// Quedaría, por ejemplo:
//   GET    /api/catalogos-papel/insumo/pegamento
//   POST   /api/catalogos-papel/insumo/sacabocados        { nombre: "Sacabocado", medida: "3 mm" }
//   PATCH  /api/catalogos-papel/insumo/matrix/14
//   PATCH  /api/catalogos-papel/insumo/matrix/14/reactivar
// ═══════════════════════════════════════════════════════════════════════════