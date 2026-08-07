import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  getCatalogosPapel,
  getCatalogosInactivos,
  agregarItemCatalogo,
  editarItemCatalogo,
  eliminarItemCatalogo,
  reactivarItemCatalogo,
} from "../../controllers/catalogos_papel/catalogos_papel.controller";
import {
  getImagenesCatalogo,
  subirImagenCatalogo,
  eliminarImagenCatalogo,
} from "../../controllers/catalogos_papel/catalogoImagen.controller";
import {
  getColoresAsaAdmin,
  getColoresAsaInactivos,
  crearColorAsa,
  editarColorAsa,
  desactivarColorAsa,
  reactivarColorAsa,
} from "../../controllers/catalogos_papel/colorAsa.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";
import { upload } from "../../config/multer";

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

const PERMISO = "Gestionar Catálogos Papel";

// ── GET — cualquier autenticado ───────────────────────────────────────────
router.get("/", authMiddleware, getCatalogosPapel);
router.get("/inactivos", authMiddleware, getCatalogosInactivos);

// ── Imágenes de catálogo — deben ir ANTES de /:catalogo y /:catalogo/:id,
// si no Express las confunde con esas rutas comodín. ──────────────────────
router.get("/imagenes", authMiddleware, getImagenesCatalogo);
router.post(
  "/imagenes",
  authMiddleware,
  checkPermiso(PERMISO),
  upload.single("archivo"),
  subirImagenCatalogo
);
router.delete(
  "/imagenes/:id_archivo",
  authMiddleware,
  checkPermiso(PERMISO),
  eliminarImagenCatalogo
);

// ── Colores de asa — mismo motivo de orden que /imagenes. ─────────────────
router.get("/color-asa", authMiddleware, getColoresAsaAdmin);
router.get("/color-asa/inactivos", authMiddleware, getColoresAsaInactivos);
router.post("/color-asa", authMiddleware, checkPermiso(PERMISO), crearColorAsa);
router.put("/color-asa/:id", authMiddleware, checkPermiso(PERMISO), editarColorAsa);
router.delete("/color-asa/:id", authMiddleware, checkPermiso(PERMISO), desactivarColorAsa);
router.patch("/color-asa/:id/reactivar", authMiddleware, checkPermiso(PERMISO), reactivarColorAsa);

// ── Escritura — requiere permiso ──────────────────────────────────────────
router.post(
  "/:catalogo",
  authMiddleware,
  checkPermiso(PERMISO),
  agregarItemCatalogo
);

router.put(
  "/:catalogo/:id",
  authMiddleware,
  checkPermiso(PERMISO),
  editarItemCatalogo
);

router.delete(
  "/:catalogo/:id",
  authMiddleware,
  checkPermiso(PERMISO),
  eliminarItemCatalogo
);

router.patch(
  "/:catalogo/:id/reactivar",
  authMiddleware,
  checkPermiso(PERMISO),
  reactivarItemCatalogo
);

export default router;