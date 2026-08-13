import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  getRoles,
  getPrivilegiosByRol,
  crearRol,
  editarRol,
  actualizarPrivilegiosRol,
} from "../../controllers/roles/roles.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";

const PERMISO = "seguridad.roles.gestionar";

const router = Router();

// ==========================
// HELMET
// ==========================
router.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

// ==========================
// RATE LIMITING
// ==========================
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,
  message: { 
    error: "Demasiadas solicitudes. Intenta más tarde." 
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(generalLimiter);

// ==========================
// RUTAS
// ==========================
router.get("/", authMiddleware, getRoles);
router.get("/:id/privilegios", authMiddleware, getPrivilegiosByRol);
router.post("/", authMiddleware, checkPermiso(PERMISO), crearRol);
router.put("/:id", authMiddleware, checkPermiso(PERMISO), editarRol);
router.put("/:id/privilegios", authMiddleware, checkPermiso(PERMISO), actualizarPrivilegiosRol);

export default router;