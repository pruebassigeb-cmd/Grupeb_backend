import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { setupSecurity, corsOptions } from "./config/security.config";

// Rutas
import authRoutes from "./routes/auth/auth.routes";
import rolesRoutes from "./routes/roles/roles.routes";
import privilegiosRoutes from "./routes/privilegios/privilegios.routes";
import usuariosRoutes from "./routes/usuarios/usuarios.routes";
import catalogosRoutes from "./routes/catalogos_fiscales/catalogos.routes";
import clientesRoutes from "./routes/clientes/clientes.routes";
import tarifasRoutes from "./routes/tarifas/tarifas.routes";
import catalogosProductosRoutes from "./routes/productos/catalogos-productos.routes";
import productosPlasticoRoutes from "./routes/productos/productos-plastico.routes";
import catalogosProduccionRoutes from "./routes/catalogos_produccion/catalogos-produccion.routes";
import cotizacionesRoutes from "./routes/cotizaciones/cotizaciones.routes";
import calcularPrecioRoutes from "./routes/cotizaciones/calcular-precio.routes";
import pedidosRoutes from "./routes/pedidos/pedidos.routes";
import ventasRoutes from "./routes/ventas/ventas.routes";
import disenoRoutes from "./routes/diseno/diseno.routes";
import suajesRoutes from "./routes/suajes/suajes.routes";
import seguimientoRoutes from "./routes/seguimiento/seguimiento.routes";
import rodillosRoutes from "./routes/rodillos/rodillos.routes";
import procesosRoutes from "./routes/procesos/procesos.routes";
import estadoCuentaRoutes from "./routes/estadoCuenta/estadoCuenta.routes";
import bultosRoutes from "./routes/seguimiento/bultos.routes";

const app = express();

// ==========================
// TRUST PROXY (DEBE IR PRIMERO)
// ==========================
app.set("trust proxy", 1);

// ==========================
// CONFIGURACIÓN DE SEGURIDAD
// ==========================
setupSecurity(app);

// ==========================
// MIDDLEWARES
// ==========================
app.use(cors(corsOptions));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));
app.use(cookieParser());

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
app.use("/api/catalogos-productos", catalogosProductosRoutes);
app.use("/api/productos-plastico", productosPlasticoRoutes);
app.use("/api/catalogos-produccion", catalogosProduccionRoutes);
app.use("/api/cotizaciones", cotizacionesRoutes);
app.use("/api/pedidos", pedidosRoutes);
app.use("/api/ventas", ventasRoutes);
app.use("/api/diseno", disenoRoutes);
app.use("/api", calcularPrecioRoutes);
app.use("/api", suajesRoutes);
app.use("/api/seguimiento", seguimientoRoutes);
app.use("/api/rodillos", rodillosRoutes);
app.use("/api/procesos", procesosRoutes);
app.use("/api/estado-cuenta", estadoCuentaRoutes);
app.use("/api/seguimiento/:idproduccion/bultos", bultosRoutes);

// ==========================
// HEALTH CHECK
// ==========================
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ==========================
// 404 - RUTA NO ENCONTRADA
// ==========================
app.use((req, res, next) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

// ==========================
// MANEJO DE ERRORES GLOBAL
// ==========================
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("❌ Error no manejado:", err);
  res.status(500).json({ error: "Error interno del servidor" });
});

export default app;