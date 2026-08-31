// src/routes/cotizadorLibre/cotizadorLibreClientes.routes.ts
import { Router } from "express";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
import {
  buscarClienteCotizadorLibre,
  enviarCodigoVerificacion,
  confirmarCodigoVerificacion,
  buscarClientesInternoCotizadorLibre,
  buscarClientesExactoInternoCotizadorLibre,
} from "../../controllers/cotizadorLibre/cotizadorLibreClientes.controller";

const router = Router();

// Todas requieren sesión activa (cuenta compartida CotizadorLibre o staff interno)
router.use(authMiddleware);

router.post(
  "/buscar",
  checkPermiso("externos.cotizador_libre.buscar_cliente"),
  buscarClienteCotizadorLibre
);

router.post(
  "/verificar/enviar",
  checkPermiso("externos.cotizador_libre.buscar_cliente"),
  enviarCodigoVerificacion
);

router.post(
  "/verificar/confirmar",
  checkPermiso("externos.cotizador_libre.buscar_cliente"),
  confirmarCodigoVerificacion
);

// ✅ NUEVO — buscador de clientes reales para uso interno. Mismo permiso
// que las rutas de arriba (tanto staff interno como la cuenta compartida
// externa lo tienen), a propósito: el candado real que bloquea a la
// cuenta compartida "CotizadorLibre" vive DENTRO del controller
// (compara req.user?.rol), no aquí — porque a nivel de ruta no hay forma
// de distinguir "interno" de "externo" sin ese chequeo específico.
router.get(
  "/buscar-interno",
  checkPermiso("externos.cotizador_libre.buscar_cliente"),
  buscarClientesInternoCotizadorLibre
);

// ✅ NUEVO — coincidencia exacta sin enmascarar (por correo/teléfono/RFC/
// empresa tecleados en el formulario de registro), para que el staff pueda
// confirmar si el cliente ya existe antes de crear uno nuevo.
router.post(
  "/buscar-exacto-interno",
  checkPermiso("externos.cotizador_libre.buscar_cliente"),
  buscarClientesExactoInternoCotizadorLibre
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
//   GET  /cotizador-libre/clientes/buscar-interno
//   POST /cotizador-libre/clientes/buscar-exacto-interno
// ============================================================================