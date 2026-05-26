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
  crearTipoInsumo 
} from "../../controllers/proveedores/proveedores.controller";

const router = Router();

// ── Tipos de insumo ───────────────────────────────────────────────────────────
router.get ("/tipos-insumo", getTiposInsumo);
router.post("/tipos-insumo", crearTipoInsumo);

// ── Búsqueda global + registro rápido ────────────────────────────────────────
router.get ("/insumos",                  buscarInsumos);
router.post("/insumos/registrar-rapido", registrarInsumoRapido);

// ── Proveedores ───────────────────────────────────────────────────────────────
router.get   ("/",    getProveedores);
router.get   ("/:id", getProveedorById);
router.post  ("/",    crearProveedor);
router.put   ("/:id", actualizarProveedor);
router.delete("/:id", eliminarProveedor);

// ── Productos por proveedor ───────────────────────────────────────────────────
router.get   ("/:id/productos",             getProductosProveedor);
router.post  ("/:id/productos",             crearProductoProveedor);
router.put   ("/:id/productos/:idProducto", actualizarProductoProveedor);
router.delete("/:id/productos/:idProducto", eliminarProductoProveedor);

export default router;