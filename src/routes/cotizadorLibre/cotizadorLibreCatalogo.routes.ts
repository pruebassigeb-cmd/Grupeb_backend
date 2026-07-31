// src/routes/cotizadorLibre/cotizadorLibreCatalogo.routes.ts
import { Router } from "express";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
import {
  getTiposCotizadorLibre,
  getMedidasCotizadorLibre,
  getDetalleProductoPapelCotizadorLibre,
  getDetalleProductoPlasticoCotizadorLibre,
} from "../../controllers/cotizadorLibre/cotizadorLibreCatalogo.controller";

const router = Router();

router.use(authMiddleware);

// Reutiliza el privilegio "Cotizador Libre - Ver Catalogo" ya creado en la
// migración de Fase 1.
router.get(
  "/tipos",
  checkPermiso("Cotizador Libre - Ver Catalogo"),
  getTiposCotizadorLibre
);

router.get(
  "/medidas",
  checkPermiso("Cotizador Libre - Ver Catalogo"),
  getMedidasCotizadorLibre
);

router.get(
  "/papel/producto/:idproducto_papel",
  checkPermiso("Cotizador Libre - Ver Catalogo"),
  getDetalleProductoPapelCotizadorLibre
);

router.get(
  "/plastico/producto/:idconfiguracion_plastico",
  checkPermiso("Cotizador Libre - Ver Catalogo"),
  getDetalleProductoPlasticoCotizadorLibre
);

export default router;

// ============================================================================
// Registrar en app.ts junto a los demás routers de cotizador-libre:
//
//   import cotizadorLibreCatalogoRoutes from "./routes/cotizadorLibre/cotizadorLibreCatalogo.routes";
//   app.use("/api/cotizador-libre/catalogo", cotizadorLibreCatalogoRoutes);
//
// Rutas resultantes:
//   GET /api/cotizador-libre/catalogo/tipos?categoria=papel|plastico
//   GET /api/cotizador-libre/catalogo/medidas?categoria=papel|plastico&idTipo=X
//   GET /api/cotizador-libre/catalogo/papel/producto/:idproducto_papel
//   GET /api/cotizador-libre/catalogo/plastico/producto/:idconfiguracion_plastico
// ============================================================================