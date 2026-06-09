import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  getProductosPapel,
  getProductoPapelById,
  crearProductoPapel,
  actualizarProductoPapel,
  eliminarProductoPapel,
} from "../../controllers/producto_papel/producto_papel.controller";
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

const PERMISO = "Gestionar Productos Papel";

// ── GET — cualquier autenticado ───────────────────────────────────────────
router.get("/", authMiddleware, getProductosPapel);
router.get("/:id", authMiddleware, getProductoPapelById);

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

router.delete(
  "/:id",
  authMiddleware,
  checkPermiso(PERMISO),
  eliminarProductoPapel
);

export default router;