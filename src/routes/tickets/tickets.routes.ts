import { Router } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { Response, NextFunction } from "express";
import {
  crearTicket,
  misTickets,
  listarTickets,
  detalleTicket,
  cambiarEstadoTicket,
  cambiarPrioridadTicket,
  tomarTicket,
  comentarTicket,
  contadorTickets,
  notificacionesTickets,
  usuariosAsignables,
  asignarTicketA,
  liberarTicket,
  rebotarTicket,
  equipoActivo,
  tieneAccesoTickets,
} from "../../controllers/tickets/tickets.controller";

// Ya NO se usa checkAnyPermiso() de auth.middleware para tickets — esa
// función hace bypass total con acceso_total (usuarioTienePermiso), y tanto
// Admin como Super Usuario tienen acceso_total = true. Eso significaba que
// desmarcar la casilla "tickets.crear"/"tickets.resolver" en Roles y
// Privilegios no servía de nada: el bypass los dejaba pasar de todas formas.
// Los dos middlewares de aquí SÍ exigen el privilegio real, sin importar
// rol ni acceso_total — el candado vive 100% en user.privilegios.
const checkAccesoTickets = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json({ error: "Usuario no autenticado" });
  if (!tieneAccesoTickets(req.user)) {
    return res.status(403).json({ error: "No tienes acceso a Mesa de Tickets" });
  }
  next();
};

const router = Router();

// Todo el módulo requiere sesión — el candado fino de "esto es exclusivo
// de resolutor" (agarrar de la cola libre, asignar en frío) ya no vive en
// un middleware de ruta — vive DENTRO de cada controller
// (esResolutorTickets), porque varias de estas acciones dependen del
// estado actual del ticket, no solo del rol de quien llama.
router.use(authMiddleware);

router.post("/", checkAccesoTickets, crearTicket);
router.get("/mios", checkAccesoTickets, misTickets);
router.get("/contador", checkAccesoTickets, contadorTickets);
router.get("/notificaciones", checkAccesoTickets, notificacionesTickets);
router.get("/equipo-activo", checkAccesoTickets, equipoActivo);
// Abierto a cualquiera con acceso al módulo — un Admin también necesita
// esta lista para poder rebotar SU propio ticket directo a alguien (ver
// rebotarTicket). La acción de asignar en frío (PATCH /asignar) sigue
// siendo exclusiva de resolutor más abajo; esto es solo el catálogo.
router.get("/usuarios-asignables", checkAccesoTickets, usuariosAsignables);
// Ya no exclusiva de resolutor — cualquiera con acceso al módulo puede VER
// la cola completa (quién está trabajando en qué), aunque solo pueda
// actuar sobre lo suyo. La privacidad de los tickets personales ya está
// protegida dentro de listarTickets() (es_personal = false OR creado_por =
// tú), así que abrir esto no filtra nada que no debiera verse.
router.get("/", checkAccesoTickets, listarTickets);
router.get("/:id", checkAccesoTickets, detalleTicket);
// /estado va con checkAccesoTickets a propósito: un Admin dueño de un
// ticket PERSONAL también necesita poder moverlo. El candado real (solo
// quien tiene asignado_a === yo puede tocarlo) vive dentro del controller.
router.patch("/:id/estado", checkAccesoTickets, cambiarEstadoTicket);
// /prioridad es más permisivo a propósito: dueño, asignado o resolutor,
// en cualquier momento — el candado fino vive dentro del controller.
router.patch("/:id/prioridad", checkAccesoTickets, cambiarPrioridadTicket);
// checkAccesoTickets, no un candado exclusivo de resolutor — tomarTicket()
// ahora sirve también para que alguien confirme una reserva que ya es
// suya (asignada directo), y eso lo puede hacer cualquiera con acceso al
// módulo. El candado real de "agarrar algo libre de la cola = solo
// resolutor" vive dentro del controller (ver esResolutorTickets ahí).
router.post("/:id/tomar", checkAccesoTickets, tomarTicket);
// Ya no exclusiva de Super Usuario — Admin también puede asignar
// directamente. El ticket queda "reservado" en Pendiente, no salta solo a
// En proceso — la persona destino confirma con /tomar (ver arriba).
router.patch("/:id/asignar", checkAccesoTickets, asignarTicketA);
router.post("/:id/liberar", checkAccesoTickets, liberarTicket);
router.post("/:id/rebotar", checkAccesoTickets, rebotarTicket);
router.post("/:id/comentarios", checkAccesoTickets, comentarTicket);

export default router;