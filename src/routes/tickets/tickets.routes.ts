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
  usuariosAsignables,
  asignarTicketA,
  liberarTicket,
  equipoActivo,
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
router.get("/equipo-activo", checkResolutorTickets, equipoActivo);
router.get("/usuarios-asignables", checkResolutorTickets, usuariosAsignables);
router.get("/", checkResolutorTickets, listarTickets);
router.get("/:id", checkAnyPermiso("tickets.crear", "tickets.resolver"), detalleTicket);
// /estado va con checkAnyPermiso a propósito: un Admin dueño de un ticket
// PERSONAL también necesita poder moverlo. El candado real (solo quien
// tiene asignado_a === yo puede tocarlo) vive dentro del controller.
router.patch("/:id/estado", checkAnyPermiso("tickets.crear", "tickets.resolver"), cambiarEstadoTicket);
router.post("/:id/tomar", checkResolutorTickets, tomarTicket);
router.patch("/:id/asignar", checkResolutorTickets, asignarTicketA);
router.post("/:id/liberar", checkAnyPermiso("tickets.crear", "tickets.resolver"), liberarTicket);
router.post("/:id/comentarios", checkAnyPermiso("tickets.crear", "tickets.resolver"), comentarTicket);

export default router;