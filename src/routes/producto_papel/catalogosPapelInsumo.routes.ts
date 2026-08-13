import { Router } from "express";
import {
  listarCatalogoInsumo,
  crearCatalogoInsumo,
  desactivarCatalogoInsumo,
  reactivarCatalogoInsumo,
} from "../../controllers/catalogos_papel/catalogosPapelInsumo.controller";
import { authMiddleware, checkAnyPermiso, checkPermiso } from "../../middlewares/auth.middleware";

const PERMISO = "catalogos.productos_papel_insumo.gestionar";
const VER_O_GESTIONAR = checkAnyPermiso("catalogos.ver", PERMISO);
const GESTIONAR = checkPermiso(PERMISO);

const router = Router();
router.use(authMiddleware);

// :catKey ∈ tipo_papel | pegamento | laminado | sacabocados | perforado | matrix
router.get("/:catKey", VER_O_GESTIONAR, listarCatalogoInsumo);
router.post("/:catKey", GESTIONAR, crearCatalogoInsumo);
router.patch("/:catKey/:id/reactivar", GESTIONAR, reactivarCatalogoInsumo); // antes de la genérica :id
router.patch("/:catKey/:id", GESTIONAR, desactivarCatalogoInsumo);

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