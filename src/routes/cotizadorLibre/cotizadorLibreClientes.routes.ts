// src/routes/cotizadorLibre/cotizadorLibreClientes.routes.ts
import { Router } from "express";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
import {
  buscarClienteCotizadorLibre,
  enviarCodigoVerificacion,
  confirmarCodigoVerificacion,
} from "../../controllers/cotizadorLibre/cotizadorLibreClientes.controller";

const router = Router();

// Todas requieren sesión activa (cuenta compartida CotizadorLibre o staff interno)
router.use(authMiddleware);

router.post(
  "/buscar",
  checkPermiso("Cotizador Libre - Buscar Cliente"),
  buscarClienteCotizadorLibre
);

router.post(
  "/verificar/enviar",
  checkPermiso("Cotizador Libre - Buscar Cliente"),
  enviarCodigoVerificacion
);

router.post(
  "/verificar/confirmar",
  checkPermiso("Cotizador Libre - Buscar Cliente"),
  confirmarCodigoVerificacion
);

export default router;

// ============================================================================
// Registrar en el router principal (app.ts o routes/index.ts), por ejemplo:
//
//   import cotizadorLibreClientesRoutes from "./routes/cotizadorLibre/cotizadorLibreClientes.routes";
//   app.use("/cotizador-libre/clientes", cotizadorLibreClientesRoutes);
//
// Rutas resultantes:
//   POST /cotizador-libre/clientes/buscar
//   POST /cotizador-libre/clientes/verificar/enviar
//   POST /cotizador-libre/clientes/verificar/confirmar
// ============================================================================
