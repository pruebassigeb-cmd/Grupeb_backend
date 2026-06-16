// src/routes/catTextura.routes.ts
// ─────────────────────────────────────────────────────────────────────────
// Única ruta NUEVA de backend para esta feature: el catálogo de texturas.
//
// - El foil (GET /foil → getFoils) ya existe en tus rutas de foil; si no,
//   agrégalo igual que abajo.
// - La cotización de papel NO necesita ruta nueva: viaja por el mismo
//   POST que ya pega a crearCotizacion (el helper distingue por tipoCotizacion).
// - La ruta del mock (POST /cotizaciones-papel/mock) puede eliminarse.
//
// Ajusta la ruta de import al lugar real de tu controller.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { getTexturas } from "../../controllers/producto_papel/cattextura.controller";
// import { authMiddleware } from "../middlewares/auth"; // si tus catálogos van protegidos

const router = Router();

router.get("/cat-textura", /* authMiddleware, */ getTexturas);

export default router;

// ─────────────────────────────────────────────────────────────────────────
// En tu app principal (app.ts / index.ts), monta el router:
//
//   import catTexturaRoutes from "./routes/catTextura.routes";
//   app.use("/", catTexturaRoutes);            // queda como GET /cat-textura
//
// O, si prefieres meter la ruta dentro de un router de catálogos que ya
// tengas, solo agrega la línea `router.get("/cat-textura", getTexturas);` ahí.
// ─────────────────────────────────────────────────────────────────────────