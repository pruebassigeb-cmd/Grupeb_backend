import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import {
  setupSecurity,
  corsOptions,
  generalLimiter,
  approvalLimiter,
  loginLimiter,
  cotizadorLibrePrecioLimiter,
} from "./config/security.config";
import { optionalAuth } from "./middlewares/auth.middleware";
import reportesDestinatariosRoutes from "./routes/reportes/reportesDestinatarios.routes";

// Rutas
import authRoutes from "./routes/auth/auth.routes";
import rolesRoutes from "./routes/roles/roles.routes";
import privilegiosRoutes from "./routes/privilegios/privilegios.routes";
import usuariosRoutes from "./routes/usuarios/usuarios.routes";
import catalogosRoutes from "./routes/catalogos_fiscales/catalogos.routes";
import clientesRoutes from "./routes/clientes/clientes.routes";
import tarifasRoutes from "./routes/tarifas/tarifas.routes";
import tipoCambioRoutes from "./routes/tipoCambio/tipoCambio.routes";
import catalogosProductosRoutes from "./routes/productos/catalogos-productos.routes";
import productosPlasticoRoutes from "./routes/productos/productos-plastico.routes";
import catalogosPlasticoAdminRoutes from "./routes/productos/catalogosPlasticoAdmin.routes";
import catalogosProduccionRoutes from "./routes/catalogos_produccion/catalogos-produccion.routes";
import cotizacionesRoutes from "./routes/cotizaciones/cotizaciones.routes";
import calcularPrecioRoutes from "./routes/cotizaciones/calcular-precio.routes";
import pedidosRoutes from "./routes/pedidos/pedidos.routes";
import ventasRoutes from "./routes/ventas/ventas.routes";
import disenoRoutes from "./routes/diseno/diseno.routes";
import auditoriaRoutes from "./routes/auditoria/auditoria.routes";
import suajesRoutes from "./routes/suajes/suajes.routes";
import seguimientoRoutes from "./routes/seguimiento/seguimiento.routes";
import rodillosRoutes from "./routes/rodillos/rodillos.routes";
import procesosRoutes from "./routes/procesos/procesos.routes";
import estadoCuentaRoutes from "./routes/estadoCuenta/estadoCuenta.routes";
import bultosRoutes from "./routes/seguimiento/bultos.routes";
import unidadesRoutes from "./routes/envios/unidades.routes";
import paqueteriaRoutes from "./routes/envios/paqueteria.routes";
import enviosRoutes from "./routes/envios/envios.routes";
import bitacoraRoutes from "./routes/envios/bitacora.routes";
import notasRoutes from "./routes/envios/notas.routes";
import carritoRoutes from "./routes/envios/carrito.routes";
import archivosRoutes from "./routes/archivos/archivos.routes";
import formatoCastoresRoutes from "./routes/envios/formatoCastores.routes";
import formatoTresGuerrasRoutes from "./routes/envios/formatoTresGuerras.routes";
import ordenDisenoRoutes from "./routes/diseno/ordenDiseno.routes";
import fichaRoutes from "./routes/diseno/ficha.routes";
import codigoPostalRouter from "./routes/codigoPostal/codigoPostal.routes";
import backupRoutes from "./routes/backup/backup.routes";
import historialRoutes from "./routes/envios/historial.routes";
import proveedoresRoutes from "./routes/proveedores/proveedores.routes";
import foilRoutes from "./routes/foil/foil.routes";
import catalogosPapelRoutes from "./routes/catalogos_papel/catalogos_papel.routes";
import productoPapelRoutes from "./routes/producto_papel/producto_papel.routes";
import catTexturaRoutes from "./routes/catTextura/catTextura.routes";
import expoRoutes from "./routes/expo/expo.routes";
import procesosPapelRoutes from "./routes/producto_papel/procesosPapel.routes";
import maquinariaPedidoPapelRoutes from "./routes/producto_papel/maquinariaPedidoPapel.routes";
import correoRoutes from "./routes/correo/correo.routes";
import pushRoutes from "./routes/push/push.routes";
import whatsappRoutes from "./routes/whatsapp/whatsapp.routes";
import catalogosPapelInsumoRoutes from "./routes/producto_papel/catalogosPapelInsumo.routes";
import preciosAcabadosPapelRoutes from "./routes/producto_papel/precios_acabados_papel.routes";
import mermaPapelRoutes from "./routes/producto_papel/mermaPapel.routes";
import calculadorPrecioPapelRoutes from "./routes/producto_papel/calculadorPrecioPapel.routes";
import cotizadorLibreClientesRoutes from "./routes/cotizadorLibre/cotizadorLibreClientes.routes";
import cotizadorLibrePrecioRoutes from "./routes/cotizadorLibre/cotizadorLibrePrecio.routes";
import cotizadorLibreCatalogoRoutes from "./routes/cotizadorLibre/cotizadorLibreCatalogo.routes";
import cotizadorLibreCotizacionesRoutes from "./routes/cotizadorLibre/cotizadorLibreCotizaciones.routes";
import { contextoAuditoria } from "./middlewares/auditoria";
import cotizadorLibreCorreoRoutes from "./routes/cotizadorLibre/cotizadorLibreCorreo.routes";
import cotizadorLibreLandingRoutes from "./routes/cotizadorLibre/cotizadorLibreLanding.routes";

const app = express();

// ==========================
// TRUST PROXY (DEBE IR PRIMERO)
// ==========================
app.set("trust proxy", 1);

// ==========================
// CONFIGURACIÓN DE SEGURIDAD (helmet)
// ==========================
setupSecurity(app);

// ==========================
// MIDDLEWARES BASE
// ==========================
app.use(cors(corsOptions));

app.use(
  express.json({
    limit: "10mb",
    type: ["application/json", "application/*+json"],
  })
);

app.use(
  express.text({
    limit: "10mb",
    type: "text/plain",
  })
);

app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

app.use((req, res, next) => {
  res.charset = "utf-8";
  next();
});

// Puebla req.user cuando ya hay un token válido, sin rechazar si no lo hay
// (eso lo sigue haciendo authMiddleware más adelante, por ruta). Tiene que
// correr ANTES de los rate limiters de abajo para que puedan identificar
// por usuario en vez de por IP — ver generarClaveLimitador en
// security.config.ts. Sin esto, varios usuarios en la misma red (ej. el
// wifi de un venue) comparten el mismo presupuesto de peticiones.
app.use(optionalAuth);
app.use(contextoAuditoria);

// ==========================
// RATE LIMITERS
// Limiters específicos primero. El general omite /auth/login para evitar doble conteo.
// ==========================
app.use("/api/cotizaciones/detalle", approvalLimiter);
app.use("/api/cotizaciones/herramental", approvalLimiter);
app.use("/api/auth/login", loginLimiter);
app.use("/api/cotizador-libre/calcular-precio", cotizadorLibrePrecioLimiter);
app.use("/api", generalLimiter);

// ==========================
// RUTAS
// ==========================
app.use("/api/auth", authRoutes);
app.use("/api/roles", rolesRoutes);
app.use("/api/privilegios", privilegiosRoutes);
app.use("/api/usuarios", usuariosRoutes);
app.use("/api/catalogos", catalogosRoutes);
app.use("/api/clientes", clientesRoutes);
app.use("/api/tarifas", tarifasRoutes);
app.use("/api/tipo-cambio", tipoCambioRoutes);
app.use("/api/catalogos-productos", catalogosProductosRoutes);
app.use("/api/productos-plastico", productosPlasticoRoutes);
app.use("/api/catalogos-productos/plastico/admin", catalogosPlasticoAdminRoutes);
app.use("/api/catalogos-produccion", catalogosProduccionRoutes);
app.use("/api/cotizaciones", cotizacionesRoutes);
app.use("/api/pedidos", pedidosRoutes);
app.use("/api/ventas", ventasRoutes);
app.use("/api/diseno", disenoRoutes);
app.use("/api/auditoria", auditoriaRoutes);
app.use("/api", calcularPrecioRoutes);
app.use("/api", suajesRoutes);
app.use("/api/seguimiento", seguimientoRoutes);
app.use("/api/rodillos", rodillosRoutes);
app.use("/api/procesos", procesosRoutes);
app.use("/api/estado-cuenta", estadoCuentaRoutes);
app.use("/api/seguimiento/:idproduccion/bultos", bultosRoutes);
app.use("/api/unidades", unidadesRoutes);
app.use("/api/paqueterias", paqueteriaRoutes);
app.use("/api/envios", enviosRoutes);
app.use("/api/bitacora", bitacoraRoutes);
app.use("/api/notas", notasRoutes);
app.use("/api/notas-remision", notasRoutes);
app.use("/api/carrito", carritoRoutes);
app.use("/api/archivos", archivosRoutes);
app.use("/api/formato-castores", formatoCastoresRoutes);
app.use("/api/formato-tres-guerras", formatoTresGuerrasRoutes);
app.use("/api/orden-diseno", ordenDisenoRoutes);
app.use("/api/ficha", fichaRoutes);
app.use("/api/codigos-postales", codigoPostalRouter);
app.use("/api/backup", backupRoutes);
app.use("/api/historial", historialRoutes);
app.use("/api/proveedores", proveedoresRoutes);
app.use("/api/foil", foilRoutes);
app.use("/api/catalogos-papel", catalogosPapelRoutes);
app.use("/api/productos-papel", productoPapelRoutes);
app.use("/api/precios-acabados-papel", preciosAcabadosPapelRoutes);
app.use("/api/merma-papel", mermaPapelRoutes);
app.use("/api/calculador-precio-papel", calculadorPrecioPapelRoutes);
app.use("/api", catTexturaRoutes);
app.use("/api/expo", expoRoutes);
app.use("/api", procesosPapelRoutes);
app.use("/api/pedidos", maquinariaPedidoPapelRoutes);
app.use("/api/correos", correoRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/catalogos-papel/insumo", catalogosPapelInsumoRoutes);
app.use("/api/reportes", reportesDestinatariosRoutes);

// Cotizador Interactivo (público, cuenta compartida + staff) — se monta bajo
// /api como el resto del sistema, para que la instancia de axios del
// frontend (baseURL ya incluye /api) resuelva las rutas correctamente.
app.use("/api/cotizador-libre/clientes", cotizadorLibreClientesRoutes);
app.use("/api/cotizador-libre/catalogo", cotizadorLibreCatalogoRoutes);
app.use("/api/cotizador-libre", cotizadorLibrePrecioRoutes);
app.use("/api/cotizador-libre/cotizaciones", cotizadorLibreCotizacionesRoutes);
app.use("/api/cotizador-libre/cotizaciones", cotizadorLibreCorreoRoutes);
app.use("/api/cotizador-libre/landing", cotizadorLibreLandingRoutes);


// ==========================
// HEALTH CHECK
// ==========================
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// ==========================
// 404 - RUTA NO ENCONTRADA
// ==========================
app.use((_req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

// ==========================
// MANEJO DE ERRORES GLOBAL
// ==========================
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("❌ Error no manejado:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
);

export default app;