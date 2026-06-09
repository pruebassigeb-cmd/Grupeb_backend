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
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";

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