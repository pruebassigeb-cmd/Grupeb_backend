// src/routes/cotizadorLibre/cotizadorLibreCotizaciones.routes.ts
import { Router } from "express";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
import { crearCotizacionCotizadorLibre } from "../../controllers/cotizadorLibre/cotizadorLibreCotizaciones.controller";

const router = Router();

router.use(authMiddleware);

router.post(
  "/",
  checkPermiso("Cotizador Libre - Crear Cotizacion"),
  crearCotizacionCotizadorLibre
);

export default router;

// ============================================================================
// Registrar en app.ts:
//
//   import cotizadorLibreCotizacionesRoutes from "./routes/cotizadorLibre/cotizadorLibreCotizaciones.routes";
//   app.use("/api/cotizador-libre/cotizaciones", cotizadorLibreCotizacionesRoutes);
//
// Ruta resultante: POST /api/cotizador-libre/cotizaciones
// ============================================================================