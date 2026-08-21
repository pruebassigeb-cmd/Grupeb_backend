import { Response } from "express";
import { pool } from "../../config/db";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { qAudit } from "../../middlewares/auditoria";
import { enviarCorreo } from "../../services/email/mailer";
import { getPresignedUrl } from "../../config/multer";

// Admin y Super Usuario comparten acceso_total = true en tu base, así que
// usuarioTienePermiso() (que hace bypass total con acceso_total) NO sirve
// para distinguirlos — le daría a Admin los mismos poderes de resolver que
// a Super Usuario. Aquí, a propósito, NO se mira acceso_total: solo cuenta
// el rol exacto o el privilegio explícito. El resto del sistema sigue
// usando el bypass normal sin tocarse — este helper es exclusivo de tickets.
export const esResolutorTickets = (user?: AuthRequest["user"]): boolean => {
  if (!user) return false;
  if (user.rol === "Super Usuario") return true;
  return (user.privilegios ?? []).includes("tickets.resolver");
};

const PRIORIDADES = ["Baja", "Media", "Alta", "Urgente"];
const ESTADOS = ["Pendiente", "En proceso", "Finalizado", "Cancelado"];

// ==========================
// HELPER — correos de todos los que pueden resolver tickets.
//
// OJO: a propósito NO se usa "r.acceso_total = true" aquí — Admin también
// tiene acceso_total = true igual que Super Usuario (ver esResolutorTickets
// más abajo), así que ese criterio metía a los admins en los correos de
// "todos los que pueden resolver". El criterio real es: rol exacto
// "Super Usuario", o el privilegio tickets.resolver asignado explícito
// (directo al usuario o heredado de su rol) — mismo criterio que
// esResolutorTickets, para que correos y permisos nunca se desalineen.
// ==========================
async function correosResolutores(): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.correo
       FROM usuarios u
       JOIN roles r ON r.idroles = u.roles_idroles
       LEFT JOIN privilegios_has_usuarios phu
              ON phu.usuarios_idusuario = u.idusuario
       LEFT JOIN privilegios p1
              ON p1.idprivilegios = phu.privilegios_idprivilegios
             AND p1.clave = 'tickets.resolver'
       LEFT JOIN roles_privilegios rp
              ON rp.roles_idroles = r.idroles
       LEFT JOIN privilegios p2
              ON p2.idprivilegios = rp.privilegios_idprivilegios
             AND p2.clave = 'tickets.resolver'
      WHERE u.activo = true
        AND u.eliminado_at IS NULL
        AND (r.nombre = 'Super Usuario' OR p1.idprivilegios IS NOT NULL OR p2.idprivilegios IS NOT NULL)`
  );
  return rows.map((r: any) => r.correo).filter(Boolean);
}

function folioDe(idticket: number): string {
  return `TCK-${new Date().getFullYear()}-${String(idticket).padStart(5, "0")}`;
}

// ==========================
// POST /api/tickets — crear
// ==========================
export const crearTicket = async (req: AuthRequest, res: Response) => {
  try {
    const { titulo, descripcion, ubicacion, prioridad = "Media", idticket_relacionado } = req.body;

    if (!titulo?.trim()) return res.status(400).json({ error: "El título es requerido" });
    if (!descripcion?.trim()) return res.status(400).json({ error: "La descripción es requerida" });
    if (!PRIORIDADES.includes(prioridad)) return res.status(400).json({ error: "Prioridad inválida" });

    if (idticket_relacionado != null) {
      const relCheck = await pool.query(
        "SELECT idticket FROM ticket WHERE idticket = $1 AND eliminado_at IS NULL",
        [idticket_relacionado]
      );
      if (relCheck.rowCount === 0) {
        return res.status(400).json({ error: "El ticket relacionado no existe" });
      }
    }

    const ticket = await req.tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO ticket (titulo, descripcion, ubicacion, prioridad, idticket_relacionado, creado_por)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING idticket`,
        [
          titulo.trim(),
          descripcion.trim(),
          ubicacion?.trim() || null,
          prioridad,
          idticket_relacionado || null,
          req.user!.id,
        ]
      );

      const idticket = rows[0].idticket;

      const { rows: actualizado } = await client.query(
        `UPDATE ticket SET folio = $1 WHERE idticket = $2 RETURNING *`,
        [folioDe(idticket), idticket]
      );

      return actualizado[0];
    });

    // El creador siempre se entera de su propio ticket. Nadie está
    // asignado todavía → además, correo a TODOS los que pueden resolver.
    correosResolutores()
      .then((destinatariosResolutores) => {
        const destinatarios = [...new Set([req.user!.correo, ...destinatariosResolutores])];
        return enviarCorreo({
          para: destinatarios,
          asunto: `🎫 Nuevo ticket ${ticket.folio}: ${ticket.titulo}`,
          html: `
            <p>Se reportó un ticket nuevo y todavía no tiene responsable.</p>
            <p><strong>${ticket.titulo}</strong></p>
            <p>${ticket.descripcion}</p>
            <p>Prioridad: <strong>${ticket.prioridad}</strong>${ticket.ubicacion ? ` · Ubicación: ${ticket.ubicacion}` : ""}</p>
            <p>Folio: ${ticket.folio}</p>
          `,
        });
      })
      .catch((e) => console.error("❌ Correo ticket nuevo:", e.message));

    res.status(201).json(ticket);
  } catch (error: any) {
    console.error("❌ CREAR TICKET ERROR:", error.message);
    res.status(500).json({ error: "Error al crear el ticket" });
  }
};

// ==========================
// GET /api/tickets/contador — para el badge del sidebar.
// Admin ve el conteo de LOS SUYOS; Super Usuario ve el conteo de la cola
// completa. Nunca cuenta Finalizado ni Cancelado.
// ==========================
export const contadorTickets = async (req: AuthRequest, res: Response) => {
  try {
    const esResolutor = esResolutorTickets(req.user);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS activos
         FROM ticket
        WHERE eliminado_at IS NULL
          AND archivado = false
          AND estado IN ('Pendiente', 'En proceso')
          ${esResolutor ? "" : "AND creado_por = $1"}`,
      esResolutor ? [] : [req.user!.id]
    );
    res.json({ activos: rows[0].activos });
  } catch (error: any) {
    console.error("❌ CONTADOR TICKETS ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener el contador" });
  }
};

// ==========================
// GET /api/tickets/mios — tickets que YO reporté
// ==========================
export const misTickets = async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, resp.nombre AS asignado_nombre, resp.apellido AS asignado_apellido
         FROM ticket t
         LEFT JOIN usuarios resp ON resp.idusuario = t.asignado_a
        WHERE t.creado_por = $1 AND t.eliminado_at IS NULL
        ORDER BY t.created_at DESC`,
      [req.user!.id]
    );
    res.json(rows);
  } catch (error: any) {
    console.error("❌ MIS TICKETS ERROR:", error.message);
    res.status(500).json({ error: "Error al listar tus tickets" });
  }
};

// ==========================
// GET /api/tickets — cola completa (solo tickets.resolver)
// Query params opcionales: estado, prioridad, archivado ("true"/"false")
// ==========================
export const listarTickets = async (req: AuthRequest, res: Response) => {
  try {
    const { estado, prioridad } = req.query;
    const archivado = req.query.archivado === "true";

    const condiciones: string[] = ["t.eliminado_at IS NULL", "t.archivado = $1"];
    const params: any[] = [archivado];

    if (estado && ESTADOS.includes(String(estado))) {
      params.push(estado);
      condiciones.push(`t.estado = $${params.length}`);
    }
    if (prioridad && PRIORIDADES.includes(String(prioridad))) {
      params.push(prioridad);
      condiciones.push(`t.prioridad = $${params.length}`);
    }

    const { rows } = await pool.query(
      `SELECT t.*,
              creador.nombre AS creador_nombre, creador.apellido AS creador_apellido,
              resp.nombre AS asignado_nombre, resp.apellido AS asignado_apellido
         FROM ticket t
         JOIN usuarios creador ON creador.idusuario = t.creado_por
         LEFT JOIN usuarios resp ON resp.idusuario = t.asignado_a
        WHERE ${condiciones.join(" AND ")}
        ORDER BY t.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (error: any) {
    console.error("❌ LISTAR TICKETS ERROR:", error.message);
    res.status(500).json({ error: "Error al listar tickets" });
  }
};

// ==========================
// GET /api/tickets/:id — detalle (dueño o resolutor)
// Los comentarios internos se filtran server-side si no eres resolutor.
// ==========================
export const detalleTicket = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!Number.isInteger(Number(id))) return res.status(400).json({ error: "Id inválido" });

    const { rows } = await pool.query(
      `SELECT t.*,
              creador.nombre AS creador_nombre, creador.apellido AS creador_apellido,
              resp.nombre AS asignado_nombre, resp.apellido AS asignado_apellido,
              rel.folio AS relacionado_folio
         FROM ticket t
         JOIN usuarios creador ON creador.idusuario = t.creado_por
         LEFT JOIN usuarios resp ON resp.idusuario = t.asignado_a
         LEFT JOIN ticket rel ON rel.idticket = t.idticket_relacionado
        WHERE t.idticket = $1 AND t.eliminado_at IS NULL`,
      [id]
    );
    const ticket = rows[0];
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });

    const puedeResolver = esResolutorTickets(req.user);
    const esDueno = ticket.creado_por === req.user!.id;
    if (!puedeResolver && !esDueno) {
      return res.status(403).json({ error: "No tienes acceso a este ticket" });
    }

    const { rows: comentarios } = await pool.query(
      `SELECT c.idticket_comentario, c.comentario, c.es_interno, c.created_at,
              u.nombre, u.apellido
         FROM ticket_comentario c
         JOIN usuarios u ON u.idusuario = c.creado_por
        WHERE c.idticket = $1 AND c.eliminado_at IS NULL
          ${puedeResolver ? "" : "AND c.es_interno = false"}
        ORDER BY c.created_at ASC`,
      [id]
    );

    const { rows: archivosRaw } = await pool.query(
      `SELECT id_archivo, nombre, public_id, tamano_kb, created_at, ticket_comentario_id
         FROM archivos
        WHERE eliminado_at IS NULL
          AND (
            ticket_id = $1
            OR ticket_comentario_id IN (
              SELECT idticket_comentario FROM ticket_comentario WHERE idticket = $1
            )
          )`,
      [id]
    );

    const archivos = await Promise.all(
      archivosRaw.map(async (a: any) => ({
        ...a,
        url: a.public_id ? await getPresignedUrl(a.public_id) : null,
      }))
    );

    res.json({ ...ticket, comentarios, archivos });
  } catch (error: any) {
    console.error("❌ DETALLE TICKET ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener el ticket" });
  }
};

// ==========================
// PATCH /api/tickets/:id/estado — solo tickets.resolver
// ==========================
export const cambiarEstadoTicket = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { estado } = req.body;
    if (!ESTADOS.includes(estado)) return res.status(400).json({ error: "Estado inválido" });

    const actual = await pool.query(
      "SELECT idticket, asignado_a FROM ticket WHERE idticket = $1 AND eliminado_at IS NULL",
      [id]
    );
    if (actual.rowCount === 0) return res.status(404).json({ error: "Ticket no encontrado" });
    if (actual.rows[0].asignado_a !== req.user!.id) {
      return res.status(403).json({
        error: actual.rows[0].asignado_a
          ? "Solo quien tomó el ticket puede cambiar su estado"
          : "Nadie ha tomado este ticket todavía — tómalo primero",
      });
    }

    const ticket = await req.tx(async (client) => {
      const esFinal = estado === "Finalizado";
      const { rows } = await client.query(
        `UPDATE ticket
            SET estado = $1,
                fecha_cierre = CASE WHEN $3 THEN now() ELSE fecha_cierre END
          WHERE idticket = $2 AND eliminado_at IS NULL
          RETURNING *`,
        [estado, id, esFinal]
      );
      return rows[0];
    });

    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });

    const { rows: personas } = await pool.query(
      `SELECT creador.correo AS correo_creador, resp.correo AS correo_asignado
         FROM ticket t
         JOIN usuarios creador ON creador.idusuario = t.creado_por
         LEFT JOIN usuarios resp ON resp.idusuario = t.asignado_a
        WHERE t.idticket = $1`,
      [id]
    );

    const destinatarios = [personas[0]?.correo_creador, personas[0]?.correo_asignado].filter(Boolean);

    if (destinatarios.length > 0) {
      enviarCorreo({
        para: destinatarios,
        asunto: `🎫 Ticket ${ticket.folio} → ${estado}`,
        html: `<p>El ticket <strong>${ticket.folio}</strong> — "${ticket.titulo}" cambió de estado a <strong>${estado}</strong>.</p>`,
      }).catch((e) => console.error("❌ Correo cambio de estado:", e.message));
    }

    res.json(ticket);
  } catch (error: any) {
    console.error("❌ CAMBIAR ESTADO ERROR:", error.message, "\n", error.stack);
    res.status(500).json({ error: "Error al cambiar el estado" });
  }
};

// ==========================
// POST /api/tickets/:id/tomar — autoasignación (solo tickets.resolver)
// Falla con 409 si alguien más ya lo tomó primero — evita condición de
// carrera cuando dos devs le dan clic casi al mismo tiempo.
// ==========================
export const tomarTicket = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const ticket = await req.tx(async (client) => {
      const { rows } = await client.query(
        `UPDATE ticket
            SET asignado_a = $1,
                estado = CASE WHEN estado = 'Pendiente' THEN 'En proceso' ELSE estado END
          WHERE idticket = $2 AND eliminado_at IS NULL AND asignado_a IS NULL
          RETURNING *`,
        [req.user!.id, id]
      );
      return rows[0];
    });

    if (!ticket) {
      return res.status(409).json({ error: "Este ticket ya fue tomado por alguien más" });
    }

    // De aquí en adelante los correos son solo entre los dos involucrados:
    // quien reportó + quien lo tomó. Ya no le llega a todos los resolutores.
    const { rows: personas } = await pool.query(
      "SELECT correo FROM usuarios WHERE idusuario = $1",
      [ticket.creado_por]
    );
    const destinatarios = [...new Set([personas[0]?.correo, req.user!.correo])].filter(Boolean) as string[];

    if (destinatarios.length > 0) {
      enviarCorreo({
        para: destinatarios,
        asunto: `🎫 Ticket ${ticket.folio} tomado`,
        html: `<p>El ticket <strong>${ticket.folio}</strong> — "${ticket.titulo}" fue tomado por ${req.user!.correo}. Ya está en proceso.</p>`,
      }).catch((e) => console.error("❌ Correo ticket tomado:", e.message));
    }

    res.json(ticket);
  } catch (error: any) {
    console.error("❌ TOMAR TICKET ERROR:", error.message);
    res.status(500).json({ error: "Error al tomar el ticket" });
  }
};

// ==========================
// POST /api/tickets/:id/comentarios
// es_interno solo se respeta si quien comenta tiene tickets.resolver —
// un admin no puede marcar su propio comentario como nota interna.
// ==========================
export const comentarTicket = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { comentario, es_interno } = req.body;

    if (!comentario?.trim()) return res.status(400).json({ error: "El comentario no puede ir vacío" });

    const esResolutor = esResolutorTickets(req.user);
    const esInterno = !!es_interno && esResolutor;

    if (!esResolutor) {
      const propio = await pool.query(
        "SELECT 1 FROM ticket WHERE idticket = $1 AND creado_por = $2 AND eliminado_at IS NULL",
        [id, req.user!.id]
      );
      if (propio.rowCount === 0) {
        return res.status(403).json({ error: "No puedes comentar en un ticket que no es tuyo" });
      }
    }

    const resultado = await qAudit(req)(
      `INSERT INTO ticket_comentario (idticket, comentario, es_interno, creado_por)
       VALUES ($1, $2, $3, $4) RETURNING idticket_comentario, comentario, es_interno, created_at`,
      [id, comentario.trim(), esInterno, req.user!.id]
    );

    res.status(201).json(resultado.rows[0]);
  } catch (error: any) {
    console.error("❌ COMENTAR TICKET ERROR:", error.message);
    res.status(500).json({ error: "Error al comentar" });
  }
};