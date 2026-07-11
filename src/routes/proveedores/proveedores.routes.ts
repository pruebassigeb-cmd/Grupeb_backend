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

const router = Router();

// ── Tipos de insumo ───────────────────────────────────────────────────────────
router.get("/tipos-insumo", getTiposInsumo);
router.post("/tipos-insumo", crearTipoInsumo);

// ── Búsqueda global + registro rápido ────────────────────────────────────────
router.get("/insumos", buscarInsumos);
router.post("/insumos/registrar-rapido", registrarInsumoRapido);

// ✅ NUEVO — desactivar/reactivar el INSUMO completo (no un vínculo con un
// proveedor específico). Debe ir ANTES de "/:id" para que Express no confunda
// "insumos" con un id de proveedor.
router.patch("/insumos/:idinsumo", desactivarInsumo);
router.patch("/insumos/:idinsumo/reactivar", reactivarInsumo);

router.get("/regimenes-fiscales", getRegimenesFiscales);
router.get("/productos-sat", getProductosSat);

// ── Proveedores ───────────────────────────────────────────────────────────────
router.get("/", getProveedores);
router.get("/:id", getProveedorById);
router.post("/", crearProveedor);
router.put("/:id", actualizarProveedor);
router.delete("/:id", eliminarProveedor);


// ── Foil ──────────────────────────────────────────────────────────────────
router.get("/:id/foil",          getFoilByProveedor);
router.get("/:id/foil/:idFoil",  getFoilById);
router.post("/:id/foil",         crearFoil);
router.put("/:id/foil/:idFoil",  actualizarFoil);
router.delete("/:id/foil/:idFoil", eliminarFoil);

// ── Productos por proveedor ───────────────────────────────────────────────────
router.get("/:id/productos", getProductosProveedor);
router.post("/:id/productos", crearProductoProveedor);
router.put("/:id/productos/:idProducto", actualizarProductoProveedor);
router.delete("/:id/productos/:idProducto", eliminarProductoProveedor);
router.put("/:id/completo", guardarProveedorCompleto);

// ── Domicilio ─────────────────────────────────────────────────────────────────
router.get("/:id/domicilio", getDomicilioProveedor);
router.put("/:id/domicilio", upsertDomicilioProveedor);

// ── Facturación ───────────────────────────────────────────────────────────────
router.get("/:id/facturacion", getFacturacionProveedor);
router.post("/:id/facturacion", crearFacturacionProveedor);
router.put("/:id/facturacion/:idFact", actualizarFacturacionProveedor);
router.delete("/:id/facturacion/:idFact", eliminarFacturacionProveedor);

export default router;