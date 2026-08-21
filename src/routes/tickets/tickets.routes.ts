import { Router } from "express";
import { authMiddleware, checkAnyPermiso, AuthRequest } from "../../middlewares/auth.middleware";
import { Response, NextFunction } from "express";
import {
  crearTicket,
  misTickets,
  listarTickets,
  detalleTicket,
  cambiarEstadoTicket,
  tomarTicket,
  comentarTicket,
  contadorTickets,
  esResolutorTickets,
} from "../../controllers/tickets/tickets.controller";

// No usa checkPermiso("tickets.resolver") a propósito: Admin y Super
// Usuario comparten acceso_total = true, y checkPermiso hace bypass total
// con ese flag — le daría a Admin los mismos poderes que a Super Usuario.
// Este middleware es exclusivo de tickets y sí distingue el rol real.
const checkResolutorTickets = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json({ error: "Usuario no autenticado" });
  if (!esResolutorTickets(req.user)) {
    return res.status(403).json({ error: "Esta acción es exclusiva de Super Usuario" });
  }
  next();
};

const router = Router();

// Todo el módulo requiere sesión — la distinción reportero/resolutor pasa
// por checkAnyPermiso/checkResolutorTickets en cada ruta, no por un rol literal.
router.use(authMiddleware);

router.post("/", checkAnyPermiso("tickets.crear", "tickets.resolver"), crearTicket);
router.get("/mios", checkAnyPermiso("tickets.crear", "tickets.resolver"), misTickets);
router.get("/contador", checkAnyPermiso("tickets.crear", "tickets.resolver"), contadorTickets);
router.get("/", checkResolutorTickets, listarTickets);
router.get("/:id", checkAnyPermiso("tickets.crear", "tickets.resolver"), detalleTicket);
router.patch("/:id/estado", checkResolutorTickets, cambiarEstadoTicket);
router.post("/:id/tomar", checkResolutorTickets, tomarTicket);
router.post("/:id/comentarios", checkAnyPermiso("tickets.crear", "tickets.resolver"), comentarTicket);

export default router;