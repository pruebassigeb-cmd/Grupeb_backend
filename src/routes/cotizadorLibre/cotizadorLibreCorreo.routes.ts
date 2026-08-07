// src/routes/cotizadorLibre/cotizadorLibreCorreo.routes.ts
import { Router } from "express";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
import { enviarPdfCotizadorLibre } from "../../controllers/cotizadorLibre/cotizadorLibreCorreo.controller";

const router = Router();

router.use(authMiddleware);

// Reutiliza el mismo privilegio de "Crear Cotizacion" — mandar el PDF es
// parte del mismo flujo de guardado, no amerita un privilegio aparte.
router.post(
  "/:idsolicitud/enviar-pdf",
  checkPermiso("Cotizador Libre - Crear Cotizacion"),
  enviarPdfCotizadorLibre
);

export default router;

// ============================================================================
// Registrar en app.ts, junto a la ruta de cotizaciones ya existente:
//
//   import cotizadorLibreCorreoRoutes from "./routes/cotizadorLibre/cotizadorLibreCorreo.routes";
//   app.use("/api/cotizador-libre/cotizaciones", cotizadorLibreCorreoRoutes);
//
// Ruta resultante: POST /api/cotizador-libre/cotizaciones/:idsolicitud/enviar-pdf
// (comparte el mismo prefijo que cotizadorLibreCotizaciones.routes.ts — Express
// permite montar varios routers en el mismo prefijo sin problema, cada uno
// resuelve su propia sub-ruta)
// ============================================================================