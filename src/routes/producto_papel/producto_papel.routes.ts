import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  getProductosPapel,
  getProductoPapelById,
  crearProductoPapel,
  actualizarProductoPapel,
  actualizarCostoBaseGrupos,
  actualizarCostoLaminado,
  eliminarProductoPapel,
  registrarProductoPapelEnBlancoExpo,
} from "../../controllers/producto_papel/producto_papel.controller";
import { cargaMasivaProductosPapel } from "../../controllers/producto_papel/carga_masiva_papel.controller";
import { descargarReporteCatalogos } from "../../controllers/producto_papel/reporte_catalogos.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
import { upload } from "../../config/multer"; // ← el mismo multer que ya usas para subir a S3


const router = Router();

router.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: "Demasiadas solicitudes. Intenta más tarde." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(limiter);

const PERMISO = "catalogos.productos_papel.gestionar";

// ── GET — cualquier autenticado ───────────────────────────────────────────
router.get("/", authMiddleware, getProductosPapel);
router.get("/:id", authMiddleware, getProductoPapelById);

// ── Registro EN BLANCO desde Expo — cualquier autenticado, SIN el permiso
// especial de "Gestionar Productos Papel" (cualquiera que cotice en Expo
// puede necesitar crear un producto nuevo sobre la marcha). Validación
// propia y relajada dentro del controller — ver producto_papel.controller.ts.
router.post("/en-blanco-expo", authMiddleware, registrarProductoPapelEnBlancoExpo);

// ── Carga masiva — requiere permiso ───────────────────────────────────────
// Reutiliza el `upload` (memoria + S3) que ya tienes en config/multer.ts.
// Ese multer acepta cualquier mimetype; la validación de que sea .xlsx
// se hace DENTRO del controller (cargaMasivaProductosPapel), no aquí.
router.post(
  "/carga-masiva",
  authMiddleware,
  checkPermiso(PERMISO),
  upload.single("archivo"),
  cargaMasivaProductosPapel
);

router.post(
  "/carga-masiva/reporte",
  authMiddleware,
  checkPermiso(PERMISO),
  descargarReporteCatalogos
);

// ── Escritura — requiere permiso ──────────────────────────────────────────
router.post(
  "/",
  authMiddleware,
  checkPermiso(PERMISO),
  crearProductoPapel
);

router.put(
  "/:id",
  authMiddleware,
  checkPermiso(PERMISO),
  actualizarProductoPapel
);

// ── Edición inline del costo base (uno o varios grupos) — mismo permiso de
// escritura que el PUT completo, pero sin exigir el resto del formulario.
// Usado por el modo "Editar costos base" de Papel.tsx (celdas editables en
// la tabla y en el detalle expandido).
router.patch(
  "/:id/costo-base",
  authMiddleware,
  checkPermiso(PERMISO),
  actualizarCostoBaseGrupos
);

// ── Edición rápida del costo de laminado (rollo, desarrollo, piezas de
// suaje y el resultado calculado), desde el modal de Papel.tsx.
router.patch(
  "/:id/costo-laminado",
  authMiddleware,
  checkPermiso(PERMISO),
  actualizarCostoLaminado
);

router.delete(
  "/:id",
  authMiddleware,
  checkPermiso(PERMISO),
  eliminarProductoPapel
);

export default router;