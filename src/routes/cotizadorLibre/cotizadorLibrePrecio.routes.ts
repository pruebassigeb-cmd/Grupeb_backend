// src/routes/cotizadorLibre/cotizadorLibrePrecio.routes.ts
import { Router } from "express";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
import { calcularPrecioCotizadorLibre } from "../../controllers/cotizadorLibre/cotizadorLibrePrecio.controller";

// Nota: el rate-limit de este endpoint (cotizadorLibrePrecioLimiter) NO se
// aplica aquí — sigue el mismo patrón que approvalLimiter en app.ts: se
// monta a nivel de app.ts sobre la ruta específica, antes de montar este
// router, para quedar consistente con cómo ya lo hace el resto del sistema.

const router = Router();

router.use(authMiddleware);

router.post(
  "/calcular-precio",
  checkPermiso("Cotizador Libre - Calcular Precio"),
  calcularPrecioCotizadorLibre
);

export default router;

// ============================================================================
// Registrar en app.ts (ver bloque correspondiente más abajo, junto a los
// demás rate limiters específicos y rutas):
//
//   import cotizadorLibrePrecioRoutes from "./routes/cotizadorLibre/cotizadorLibrePrecio.routes";
//   import { cotizadorLibrePrecioLimiter } from "./config/security.config";
//
//   app.use("/api/cotizador-libre/calcular-precio", cotizadorLibrePrecioLimiter);
//   app.use("/api/cotizador-libre", cotizadorLibrePrecioRoutes);
//
// Ruta resultante: POST /api/cotizador-libre/calcular-precio
// ============================================================================