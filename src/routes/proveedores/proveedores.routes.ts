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
} from "../../controllers/proveedores/proveedores.controller";

const router = Router();

// ── Tipos de insumo ───────────────────────────────────────────────────────────
router.get("/tipos-insumo", getTiposInsumo);
router.post("/tipos-insumo", crearTipoInsumo);

// ── Búsqueda global + registro rápido ────────────────────────────────────────
router.get("/insumos", buscarInsumos);
router.post("/insumos/registrar-rapido", registrarInsumoRapido);

router.get("/regimenes-fiscales", getRegimenesFiscales);
router.get("/productos-sat", getProductosSat);

// ── Proveedores ───────────────────────────────────────────────────────────────
router.get("/", getProveedores);
router.get("/:id", getProveedorById);
router.post("/", crearProveedor);
router.put("/:id", actualizarProveedor);
router.delete("/:id", eliminarProveedor);

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

router.get("/:id", getProveedorById);
router.put("/:id", actualizarProveedor);
router.delete("/:id", eliminarProveedor);

export default router;