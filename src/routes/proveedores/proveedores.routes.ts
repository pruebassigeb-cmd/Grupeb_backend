import { Router } from "express";
import {
  getTiposInsumo,
  getProveedores,
  getProveedorById,
  crearProveedor,
  actualizarProveedor,
  eliminarProveedor,
  getProductosProveedor,
  buscarInsumos,
  registrarInsumoRapido,
  crearProductoProveedor,
  actualizarProductoProveedor,
  eliminarProductoProveedor,
  desactivarInsumo,
  reactivarInsumo,
  crearTipoInsumo,
  getDomicilioProveedor,
  upsertDomicilioProveedor,
  getFacturacionProveedor,
  crearFacturacionProveedor,
  actualizarFacturacionProveedor,
  eliminarFacturacionProveedor,
  getProductosSat,
  getRegimenesFiscales,
  guardarProveedorCompleto,
  crearFoil,
} from "../../controllers/proveedores/proveedores.controller";
import { actualizarFoil, eliminarFoil, getFoilById, getFoilByProveedor } from "../../controllers/foil/foil.controller";
import { authMiddleware, checkAnyPermiso, checkPermiso } from "../../middlewares/auth.middleware";

const PERMISO = "proveedores.gestionar";
const VER_O_GESTIONAR = checkAnyPermiso("proveedores.ver", PERMISO);
const GESTIONAR = checkPermiso(PERMISO);

const router = Router();
router.use(authMiddleware);

// ── Tipos de insumo ───────────────────────────────────────────────────────────
router.get("/tipos-insumo", VER_O_GESTIONAR, getTiposInsumo);
router.post("/tipos-insumo", GESTIONAR, crearTipoInsumo);

// ── Búsqueda global + registro rápido ────────────────────────────────────────
router.get("/insumos", VER_O_GESTIONAR, buscarInsumos);
router.post("/insumos/registrar-rapido", GESTIONAR, registrarInsumoRapido);

// ✅ NUEVO — desactivar/reactivar el INSUMO completo (no un vínculo con un
// proveedor específico). Debe ir ANTES de "/:id" para que Express no confunda
// "insumos" con un id de proveedor.
router.patch("/insumos/:idinsumo", GESTIONAR, desactivarInsumo);
router.patch("/insumos/:idinsumo/reactivar", GESTIONAR, reactivarInsumo);

router.get("/regimenes-fiscales", VER_O_GESTIONAR, getRegimenesFiscales);
router.get("/productos-sat", VER_O_GESTIONAR, getProductosSat);

// ── Proveedores ───────────────────────────────────────────────────────────────
router.get("/", VER_O_GESTIONAR, getProveedores);
router.get("/:id", VER_O_GESTIONAR, getProveedorById);
router.post("/", GESTIONAR, crearProveedor);
router.put("/:id", GESTIONAR, actualizarProveedor);
router.delete("/:id", GESTIONAR, eliminarProveedor);


// ── Foil ──────────────────────────────────────────────────────────────────
router.get("/:id/foil",          VER_O_GESTIONAR, getFoilByProveedor);
router.get("/:id/foil/:idFoil",  VER_O_GESTIONAR, getFoilById);
router.post("/:id/foil",         GESTIONAR, crearFoil);
router.put("/:id/foil/:idFoil",  GESTIONAR, actualizarFoil);
router.delete("/:id/foil/:idFoil", GESTIONAR, eliminarFoil);

// ── Productos por proveedor ───────────────────────────────────────────────────
router.get("/:id/productos", VER_O_GESTIONAR, getProductosProveedor);
router.post("/:id/productos", GESTIONAR, crearProductoProveedor);
router.put("/:id/productos/:idProducto", GESTIONAR, actualizarProductoProveedor);
router.delete("/:id/productos/:idProducto", GESTIONAR, eliminarProductoProveedor);
router.put("/:id/completo", GESTIONAR, guardarProveedorCompleto);

// ── Domicilio ─────────────────────────────────────────────────────────────────
router.get("/:id/domicilio", VER_O_GESTIONAR, getDomicilioProveedor);
router.put("/:id/domicilio", GESTIONAR, upsertDomicilioProveedor);

// ── Facturación ───────────────────────────────────────────────────────────────
router.get("/:id/facturacion", VER_O_GESTIONAR, getFacturacionProveedor);
router.post("/:id/facturacion", GESTIONAR, crearFacturacionProveedor);
router.put("/:id/facturacion/:idFact", GESTIONAR, actualizarFacturacionProveedor);
router.delete("/:id/facturacion/:idFact", GESTIONAR, eliminarFacturacionProveedor);

export default router;