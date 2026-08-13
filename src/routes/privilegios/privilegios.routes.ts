import { Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  getPrivilegios,
  getModulos,
  crearPrivilegio,
  editarPrivilegio,
  toggleActivoPrivilegio,
} from "../../controllers/privilegios/privilegios.controller";
import { authMiddleware, checkPermiso } from "../../middlewares/auth.middleware";

const PERMISO = "seguridad.privilegios.gestionar";

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
  windowMs: 15 * 60 * 1000,
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
// modulos va antes de cualquier ruta con :id para que Express no la
// confunda con un parámetro.
// ==========================
router.get("/modulos", authMiddleware, getModulos);
router.get("/", authMiddleware, getPrivilegios);
router.post("/", authMiddleware, checkPermiso(PERMISO), crearPrivilegio);
router.put("/:id", authMiddleware, checkPermiso(PERMISO), editarPrivilegio);
router.patch("/:id/activo", authMiddleware, checkPermiso(PERMISO), toggleActivoPrivilegio);

export default router;