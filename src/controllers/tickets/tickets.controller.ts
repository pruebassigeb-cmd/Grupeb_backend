import { Response } from "express";
import { pool } from "../../config/db";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { qAudit } from "../../middlewares/auditoria";
import { enviarCorreo } from "../../services/email/mailer";
import { getPresignedUrl } from "../../config/multer";

// ==========================
// HORAS HÁBILES — 8:00 a 18:00, lunes a viernes (10 h/día).
//
// No pretende ser un calendario laboral estricto (no contempla festivos):
// es un estimado para planear y comparar, no una validación que bloquee
// nada — así se pidió a propósito. Vive aquí porque es exclusivo de
// tickets; si el resto de SIGEB ya tiene su propio contarDiasHabiles, no
// se comparte a propósito para no acoplar módulos que no se pidieron.
// ==========================
const HORA_INICIO = 8;
const HORA_FIN = 18;
export const HORAS_POR_DIA = HORA_FIN - HORA_INICIO; // 10

const esFinDeSemana = (d: Date) => d.getDay() === 0 || d.getDay() === 6;

/** Recorre hacia adelante hasta el próximo inicio de jornada hábil
 *  (8:00 de un día entre semana). Si ya está dentro de horario hábil,
 *  la deja igual. */
function inicioJornadaSiguiente(fecha: Date): Date {
  const d = new Date(fecha);
  if (d.getHours() >= HORA_FIN || esFinDeSemana(d)) {
    d.setDate(d.getDate() + 1);
    d.setHours(HORA_INICIO, 0, 0, 0);
    while (esFinDeSemana(d)) d.setDate(d.getDate() + 1);
  } else if (d.getHours() < HORA_INICIO) {
    d.setHours(HORA_INICIO, 0, 0, 0);
  }
  while (esFinDeSemana(d)) {
    d.setDate(d.getDate() + 1);
    d.setHours(HORA_INICIO, 0, 0, 0);
  }
  return d;
}

/** Suma horas hábiles a partir de una fecha, saltando fines de semana y
 *  fuera de horario. Ej.: martes 4pm + 3h → martes 6pm... como ya no caben
 *  más ese día, sigue al miércoles 8am con lo que sobre. */
function sumarHorasHabiles(desde: Date, horas: number): Date {
  let actual = inicioJornadaSiguiente(desde);
  let restante = horas;
  while (restante > 0) {
    const finDia = new Date(actual);
    finDia.setHours(HORA_FIN, 0, 0, 0);
    const disponibleHoy = (finDia.getTime() - actual.getTime()) / 3_600_000;
    if (restante <= disponibleHoy) {
      actual = new Date(actual.getTime() + restante * 3_600_000);
      restante = 0;
    } else {
      restante -= disponibleHoy;
      actual = inicioJornadaSiguiente(finDia);
    }
  }
  return actual;
}

/** Horas hábiles transcurridas entre dos fechas — para saber cuánto se
 *  tardó "de verdad" en tiempo de trabajo, no en tiempo de reloj. */
export function horasHabilesEntre(inicio: Date, fin: Date): number {
  if (fin <= inicio) return 0;
  let actual = inicioJornadaSiguiente(inicio);
  let total = 0;
  let vueltas = 0;
  while (actual < fin && vueltas < 1000) {
    const finDia = new Date(actual);
    finDia.setHours(HORA_FIN, 0, 0, 0);
    const corte = fin < finDia ? fin : finDia;
    if (corte > actual) total += (corte.getTime() - actual.getTime()) / 3_600_000;
    actual = inicioJornadaSiguiente(finDia);
    vueltas++;
  }
  return Math.round(total * 100) / 100;
}

// El acceso a tickets es 100% manual por privilegio, sin atajos — ni por
// rol ni por acceso_total. Antes esResolutorTickets daba acceso automático
// a cualquiera con rol "Super Usuario", lo que hacía inútil desmarcar la
// casilla en Roles y Privilegios para ese rol: aunque se quitara, el atajo
// lo seguía dejando pasar. Ahora depende ÚNICAMENTE de que 'tickets.crear'
// o 'tickets.resolver' esté en user.privilegios — y esos privilegios ya se
// calculan bien para CUALQUIER usuario desde el fix en auth.controller.ts
// (antes acceso_total=true cortaba ese cálculo entero y el JWT nunca traía
// privilegios reales).
export const esResolutorTickets = (user?: AuthRequest["user"]): boolean => {
  if (!user) return false;
  return (user.privilegios ?? []).includes("tickets.resolver");
};

// Candado base: ¿puede este usuario entrar al módulo, aunque sea solo a
// reportar? También sin bypass de acceso_total — un Admin sin la casilla
// marcada no debe poder ni ver la cola ni crear tickets.
export const tieneAccesoTickets = (user?: AuthRequest["user"]): boolean => {
  if (!user) return false;
  const p = user.privilegios ?? [];
  return p.includes("tickets.crear") || p.includes("tickets.resolver");
};

const PRIORIDADES = ["Baja", "Media", "Alta", "Urgente", "Prioritario"];
const ESTADOS = ["Pendiente", "En proceso", "Finalizado", "Cancelado"];

// ==========================
// HELPER — ¿esta persona es una de las responsables reales del ticket?
// Ya NO es solo "asignado_a === yo" — la fuente de verdad es la tabla
// ticket_asignado, que puede tener a varias personas. Se usa en todos los
// puntos donde antes se checaba asignado_a a secas (cambiar estado,
// rebotar, comentar).
// ==========================
async function esCoAsignado(idticket: number | string, usuarioId: number): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM ticket_asignado WHERE idticket = $1 AND usuario_id = $2 LIMIT 1",
    [idticket, usuarioId]
  );
  return rows.length > 0;
}

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
    const { titulo, descripcion, ubicacion, prioridad = "Media", idticket_relacionado, es_personal, estrellas = 1 } = req.body;

    if (!titulo?.trim()) return res.status(400).json({ error: "El título es requerido" });
    if (!descripcion?.trim()) return res.status(400).json({ error: "La descripción es requerida" });
    if (!PRIORIDADES.includes(prioridad)) return res.status(400).json({ error: "Prioridad inválida" });
    if (!Number.isInteger(Number(estrellas)) || Number(estrellas) < 1 || Number(estrellas) > 5) {
      return res.status(400).json({ error: "Las estrellas deben ser un número del 1 al 5" });
    }

    if (idticket_relacionado != null) {
      const relCheck = await pool.query(
        "SELECT idticket FROM ticket WHERE idticket = $1 AND eliminado_at IS NULL",
        [idticket_relacionado]
      );
      if (relCheck.rowCount === 0) {
        return res.status(400).json({ error: "El ticket relacionado no existe" });
      }
    }

    const esPersonal = !!es_personal;

    const ticket = await req.tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO ticket (titulo, descripcion, ubicacion, prioridad, estrellas, idticket_relacionado, creado_por, es_personal, asignado_a, estado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING idticket`,
        [
          titulo.trim(),
          descripcion.trim(),
          ubicacion?.trim() || null,
          prioridad,
          Number(estrellas),
          idticket_relacionado || null,
          req.user!.id,
          esPersonal,
          // Un ticket personal queda autoasignado a quien lo crea desde el
          // arranque — es un pendiente propio, no algo que espera en cola.
          esPersonal ? req.user!.id : null,
          "Pendiente",
        ]
      );

      const idticket = rows[0].idticket;

      const { rows: actualizado } = await client.query(
        `UPDATE ticket SET folio = $1 WHERE idticket = $2 RETURNING *`,
        [folioDe(idticket), idticket]
      );

      return actualizado[0];
    });

    // Los tickets personales no avisan a nadie más — son un pendiente propio,
    // no algo que un dev tenga que ir a tomar de la cola.
    if (!esPersonal) {
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
    }

    res.status(201).json(ticket);
  } catch (error: any) {
    console.error("❌ CREAR TICKET ERROR:", error.message);
    res.status(500).json({ error: "Error al crear el ticket" });
  }
};

// ==========================
// GET /api/tickets/usuarios-asignables
// Cualquiera con acceso al módulo (Admin o Super Usuario) puede ser
// destino de una asignación directa — mismo criterio que quién puede
// entrar al módulo (rol Admin/Super Usuario o privilegio explícito).
// ==========================
export const usuariosAsignables = async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.idusuario, u.nombre, u.apellido, u.roles_idroles, r.nombre AS rol,
              a.public_id AS foto_public_id
         FROM usuarios u
         JOIN roles r ON r.idroles = u.roles_idroles
         LEFT JOIN archivos a ON a.id_archivo = u.foto_id_archivo
         LEFT JOIN privilegios_has_usuarios phu ON phu.usuarios_idusuario = u.idusuario
         LEFT JOIN privilegios p1 ON p1.idprivilegios = phu.privilegios_idprivilegios
                                  AND p1.clave IN ('tickets.crear', 'tickets.resolver')
         LEFT JOIN roles_privilegios rp ON rp.roles_idroles = r.idroles
         LEFT JOIN privilegios p2 ON p2.idprivilegios = rp.privilegios_idprivilegios
                                  AND p2.clave IN ('tickets.crear', 'tickets.resolver')
        WHERE u.activo = true
          AND u.eliminado_at IS NULL
          AND (r.nombre IN ('Admin', 'Super Usuario') OR p1.idprivilegios IS NOT NULL OR p2.idprivilegios IS NOT NULL)
        ORDER BY u.nombre`
    );

    const usuarios = await Promise.all(
      rows.map(async (u: any) => ({
        idusuario: u.idusuario,
        nombre: u.nombre,
        apellido: u.apellido,
        rol: u.rol,
        foto_url: u.foto_public_id ? await getPresignedUrl(u.foto_public_id) : null,
      }))
    );

    res.json(usuarios);
  } catch (error: any) {
    console.error("❌ USUARIOS ASIGNABLES ERROR:", error.message);
    res.status(500).json({ error: "Error al listar usuarios" });
  }
};

// ==========================
// PATCH /api/tickets/:id/asignar — asignación directa a cualquiera
// (Admin o Super Usuario), exclusiva de Super Usuario. Si el ticket era
// personal, deja de serlo — ya no es "solo para mí", ahora tiene dueño
// asignado formalmente.
// ==========================
export const asignarTicketA = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { usuario_id } = req.body;

    if (!Number.isInteger(Number(usuario_id))) {
      return res.status(400).json({ error: "usuario_id es requerido" });
    }

    const destino = await pool.query(
      "SELECT idusuario, correo FROM usuarios WHERE idusuario = $1 AND activo = true AND eliminado_at IS NULL",
      [usuario_id]
    );
    if (destino.rowCount === 0) {
      return res.status(400).json({ error: "Ese usuario no existe o está inactivo" });
    }

    const ticket = await req.tx(async (client) => {
      const { rows } = await client.query(
        `UPDATE ticket
            SET asignado_a = $1,
                es_personal = false,
                estado = 'Pendiente'
          WHERE idticket = $2 AND eliminado_at IS NULL
          RETURNING *`,
        [usuario_id, id]
      );
      if (rows[0]) {
        // Reserva nueva = arranque limpio. Si el ticket ya traía
        // co-asignados de antes (ej. venía de estar "en proceso" con 2
        // personas y se reasigna en frío), se reemplazan por la persona
        // nueva — no tendría sentido que alguien más siguiera en la lista
        // de un ticket que se está reservando desde cero para alguien más.
        await client.query("DELETE FROM ticket_asignado WHERE idticket = $1", [id]);
        await client.query(
          "INSERT INTO ticket_asignado (idticket, usuario_id) VALUES ($1, $2)",
          [id, usuario_id]
        );
      }
      return rows[0];
    });

    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });

    const { rows: personas } = await pool.query(
      "SELECT correo FROM usuarios WHERE idusuario = $1",
      [ticket.creado_por]
    );
    const destinatarios = [...new Set([personas[0]?.correo, destino.rows[0].correo])].filter(Boolean) as string[];

    if (destinatarios.length > 0) {
      enviarCorreo({
        para: destinatarios,
        asunto: `🎫 Ticket ${ticket.folio} reservado para ti`,
        html: `<p>El ticket <strong>${ticket.folio}</strong> — "${ticket.titulo}" quedó reservado para ${destino.rows[0].correo} (asignado por ${req.user!.correo}). Todavía tiene que confirmarlo/tomarlo para que arranque como "En proceso" — nadie más lo puede tomar mientras tanto.</p>`,
      }).catch((e) => console.error("❌ Correo ticket asignado:", e.message));
    }

    res.json(ticket);
  } catch (error: any) {
    console.error("❌ ASIGNAR TICKET ERROR:", error.message);
    res.status(500).json({ error: "Error al asignar el ticket" });
  }
};

// ==========================
// POST /api/tickets/:id/unirse
// El botón "➕👥" — otro resolutor (Super Usuario o quien tenga
// tickets.resolver) se suma como responsable de un ticket que YA está en
// proceso con alguien más. No le quita nada al que ya lo tenía: ahora los
// dos (o más) son responsables por igual — cualquiera puede cambiar el
// estado, comentar o finalizarlo, y al finalizar queda finalizado para
// todos.
//
// A propósito NO sirve para "reservar" un ticket libre (para eso está
// tomarTicket) — unirse solo aplica a uno que YA tiene dueño y ya está
// activo. Así se evita confundir "tomar de la cola" con "sumarme a algo
// que ya empezó".
// ==========================
export const unirseTicket = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!esResolutorTickets(req.user)) {
      return res.status(403).json({ error: "Solo un resolutor puede sumarse a un ticket" });
    }

    const actual = await pool.query(
      "SELECT idticket, folio, titulo, estado, asignado_a, creado_por FROM ticket WHERE idticket = $1 AND eliminado_at IS NULL",
      [id]
    );
    if (actual.rowCount === 0) return res.status(404).json({ error: "Ticket no encontrado" });

    const t = actual.rows[0];

    if (["Finalizado", "Cancelado"].includes(t.estado)) {
      return res.status(400).json({ error: "Este ticket ya se cerró" });
    }
    if (t.estado !== "En proceso") {
      return res.status(400).json({ error: "Solo puedes sumarte a un ticket que ya está confirmado (En proceso) — este todavía está pendiente de confirmar" });
    }
    if (t.asignado_a === null) {
      return res.status(400).json({ error: "Este ticket todavía no lo toma nadie — usa 'Tomar ticket' en vez de unirte" });
    }
    if (await esCoAsignado(String(id), req.user!.id)) {
      return res.status(400).json({ error: "Ya eres responsable de este ticket" });
    }

    await pool.query(
      "INSERT INTO ticket_asignado (idticket, usuario_id) VALUES ($1, $2) ON CONFLICT (idticket, usuario_id) DO NOTHING",
      [id, req.user!.id]
    );

    const { rows: yaAsignados } = await pool.query(
      `SELECT u.correo FROM ticket_asignado ta
       JOIN usuarios u ON u.idusuario = ta.usuario_id
       WHERE ta.idticket = $1`,
      [id]
    );
    const { rows: creadorRows } = await pool.query("SELECT correo FROM usuarios WHERE idusuario = $1", [t.creado_por]);
    const destinatarios = [...new Set([creadorRows[0]?.correo, ...yaAsignados.map((r) => r.correo)])].filter(Boolean) as string[];

    if (destinatarios.length > 0) {
      enviarCorreo({
        para: destinatarios,
        asunto: `🎫 ${req.user!.correo} se sumó al ticket ${t.folio}`,
        html: `<p><strong>${req.user!.correo}</strong> se sumó como responsable del ticket <strong>${t.folio}</strong> — "${t.titulo}". Ahora son varios trabajando en él.</p>`,
      }).catch((e) => console.error("❌ Correo unirse ticket:", e.message));
    }

    res.json({ mensaje: "Te uniste al ticket" });
  } catch (error: any) {
    console.error("❌ UNIRSE TICKET ERROR:", error.message);
    res.status(500).json({ error: "Error al unirte al ticket" });
  }
};

// ==========================
// POST /api/tickets/:id/liberar
// Convierte un ticket personal en uno normal y lo regresa a la cola sin
// dueño, para que cualquier Super Usuario lo pueda tomar. Lo puede hacer
// el propio creador (soltando su pendiente) o cualquier resolutor.
// ==========================
export const liberarTicket = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const actual = await pool.query(
      "SELECT idticket, creado_por, estado FROM ticket WHERE idticket = $1 AND eliminado_at IS NULL",
      [id]
    );
    if (actual.rowCount === 0) return res.status(404).json({ error: "Ticket no encontrado" });

    const esDueno = actual.rows[0].creado_por === req.user!.id;
    if (!esDueno && !esResolutorTickets(req.user)) {
      return res.status(403).json({ error: "No puedes liberar este ticket" });
    }
    if (["Finalizado", "Cancelado"].includes(actual.rows[0].estado)) {
      return res.status(400).json({ error: "Este ticket ya se cerró, no se puede liberar" });
    }

    const ticket = await req.tx(async (client) => {
      const { rows } = await client.query(
        `UPDATE ticket
            SET asignado_a = NULL,
                es_personal = false,
                estado = 'Pendiente'
          WHERE idticket = $1 AND eliminado_at IS NULL
          RETURNING *`,
        [id]
      );
      return rows[0];
    });

    correosResolutores()
      .then((destinatarios) => {
        if (destinatarios.length === 0) return;
        return enviarCorreo({
          para: destinatarios,
          asunto: `🎫 Ticket ${ticket.folio} liberado`,
          html: `<p>El ticket <strong>${ticket.folio}</strong> — "${ticket.titulo}" quedó libre y disponible para tomarse.</p>`,
        });
      })
      .catch((e) => console.error("❌ Correo ticket liberado:", e.message));

    res.json(ticket);
  } catch (error: any) {
    console.error("❌ LIBERAR TICKET ERROR:", error.message);
    res.status(500).json({ error: "Error al liberar el ticket" });
  }
};

// ==========================
// GET /api/tickets/equipo-activo
// Para el panel "quién trae qué" del tablero: solo devs con AL MENOS un
// ticket En proceso asignado — si nadie tiene nada, la lista sale vacía y
// el frontend no dibuja el panel.
// ==========================
export const equipoActivo = async (_req: AuthRequest, res: Response) => {
  try {
    // Un dev puede tener 3 tipos de ticket bajo su nombre ahora:
    //   · En proceso normal — ya confirmado, trabajando de verdad.
    //   · Pendiente + rebotado=true — se lo rebotaron a él directo, no lo
    //     ha confirmado todavía.
    //   · Pendiente + rebotado=false pero con asignado_a — se lo asignaron
    //     directo (asignarTicketA), está "reservado" para él, tampoco lo
    //     ha confirmado.
    // Los tres se listan igual (como si ya lo trajera tomado), y el
    // frontend distingue con el indicador según t.estado/t.rebotado.
    const { rows } = await pool.query(
      `SELECT u.idusuario, u.nombre, u.apellido, a.public_id AS foto_public_id,
              t.idticket, t.folio, t.titulo, t.prioridad, t.estado, t.rebotado
         FROM ticket t
         JOIN ticket_asignado ta ON ta.idticket = t.idticket
         JOIN usuarios u ON u.idusuario = ta.usuario_id
         LEFT JOIN archivos a ON a.id_archivo = u.foto_id_archivo
        WHERE t.eliminado_at IS NULL AND t.archivado = false AND t.es_personal = false
          AND (t.estado = 'En proceso' OR (t.estado = 'Pendiente' AND t.asignado_a IS NOT NULL))
        ORDER BY u.nombre, t.created_at DESC`
    );

    const porUsuario = new Map<number, any>();
    for (const r of rows) {
      if (!porUsuario.has(r.idusuario)) {
        porUsuario.set(r.idusuario, {
          idusuario: r.idusuario,
          nombre: r.nombre,
          apellido: r.apellido,
          foto_public_id: r.foto_public_id,
          tickets: [],
        });
      }
      porUsuario.get(r.idusuario).tickets.push({
        idticket: r.idticket,
        folio: r.folio,
        titulo: r.titulo,
        prioridad: r.prioridad,
        estado: r.estado,
        rebotado: r.rebotado,
      });
    }

    const equipo = await Promise.all(
      [...porUsuario.values()].map(async (u) => ({
        idusuario: u.idusuario,
        nombre: u.nombre,
        apellido: u.apellido,
        foto_url: u.foto_public_id ? await getPresignedUrl(u.foto_public_id) : null,
        tickets: u.tickets,
      }))
    );

    res.json(equipo);
  } catch (error: any) {
    console.error("❌ EQUIPO ACTIVO ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener el equipo activo" });
  }
};

// ==========================
// GET /api/tickets/estadisticas/:usuarioId
// Exclusivo de resolutor (Super Usuario o quien tenga tickets.resolver) —
// mismo criterio de privilegio real que todo lo demás del módulo, no un
// atajo por nombre de rol.
//
// Junta lo que hay disponible en la base hoy: cuántos ha resuelto/tiene en
// proceso/canceló, cuántos ha reportado, qué tan seguido cumple el
// compromiso, y qué tan cerca anda su tiempo real del estimado. No hay
// bitácora de "quién rebotó qué" todavía, así que eso no se puede
// desglosar histórico — solo el estado actual de lo que tiene asignado.
// ==========================
export const estadisticasResponsable = async (req: AuthRequest, res: Response) => {
  try {
    if (!esResolutorTickets(req.user)) {
      return res.status(403).json({ error: "Solo un resolutor puede ver estadísticas de otros" });
    }

    const { usuarioId } = req.params;
    if (!Number.isInteger(Number(usuarioId))) {
      return res.status(400).json({ error: "usuarioId inválido" });
    }

    const usuarioRow = await pool.query(
      `SELECT u.idusuario, u.nombre, u.apellido, r.nombre AS rol, a.public_id AS foto_public_id
         FROM usuarios u
         LEFT JOIN roles r ON r.idroles = u.roles_idroles
         LEFT JOIN archivos a ON a.id_archivo = u.foto_id_archivo
        WHERE u.idusuario = $1 AND u.eliminado_at IS NULL`,
      [usuarioId]
    );
    if (usuarioRow.rowCount === 0) return res.status(404).json({ error: "Usuario no encontrado" });
    const u = usuarioRow.rows[0];

    const { rows: statsRows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE t.estado = 'Finalizado')  AS finalizados,
         COUNT(*) FILTER (WHERE t.estado = 'En proceso')  AS en_proceso,
         COUNT(*) FILTER (WHERE t.estado = 'Cancelado')   AS cancelados,
         COUNT(*) FILTER (WHERE t.estado = 'Finalizado' AND t.fecha_compromiso IS NOT NULL) AS con_compromiso,
         COUNT(*) FILTER (WHERE t.estado = 'Finalizado' AND t.fecha_compromiso IS NOT NULL
                                AND t.fecha_cierre <= t.fecha_compromiso) AS a_tiempo,
         ROUND(AVG(
           CASE WHEN t.estado = 'Finalizado' AND t.duracion_estimada_horas > 0 AND t.tiempo_real_horas IS NOT NULL
                THEN ((t.tiempo_real_horas - t.duracion_estimada_horas) / t.duracion_estimada_horas) * 100
           END
         )::numeric, 1) AS pct_promedio_vs_estimado,
         COUNT(*) FILTER (WHERE t.estado = 'Finalizado' AND t.prioridad = 'Prioritario') AS prioritario,
         COUNT(*) FILTER (WHERE t.estado = 'Finalizado' AND t.prioridad = 'Urgente') AS urgente,
         COUNT(*) FILTER (WHERE t.estado = 'Finalizado' AND t.prioridad = 'Alta')    AS alta,
         COUNT(*) FILTER (WHERE t.estado = 'Finalizado' AND t.prioridad = 'Media')   AS media,
         COUNT(*) FILTER (WHERE t.estado = 'Finalizado' AND t.prioridad = 'Baja')    AS baja
       FROM ticket t
       JOIN ticket_asignado ta ON ta.idticket = t.idticket
      WHERE ta.usuario_id = $1 AND t.eliminado_at IS NULL`,
      [usuarioId]
    );
    const stats = statsRows[0];

    const { rows: reportadosRows } = await pool.query(
      `SELECT COUNT(*)::int AS reportados
         FROM ticket
        WHERE creado_por = $1 AND eliminado_at IS NULL`,
      [usuarioId]
    );

    res.json({
      idusuario: u.idusuario,
      nombre: u.nombre,
      apellido: u.apellido,
      rol: u.rol,
      foto_url: u.foto_public_id ? await getPresignedUrl(u.foto_public_id) : null,
      finalizados: Number(stats.finalizados),
      en_proceso: Number(stats.en_proceso),
      cancelados: Number(stats.cancelados),
      reportados: reportadosRows[0].reportados,
      con_compromiso: Number(stats.con_compromiso),
      a_tiempo: Number(stats.a_tiempo),
      pct_promedio_vs_estimado: stats.pct_promedio_vs_estimado != null ? Number(stats.pct_promedio_vs_estimado) : null,
      por_prioridad: {
        Prioritario: Number(stats.prioritario),
        Urgente: Number(stats.urgente),
        Alta: Number(stats.alta),
        Media: Number(stats.media),
        Baja: Number(stats.baja),
      },
    });
  } catch (error: any) {
    console.error("❌ ESTADISTICAS RESPONSABLE ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener estadísticas" });
  }
};

// ==========================
// POST /api/tickets/:id/rebotar
// Solo quien TIENE asignado el ticket lo puede rebotar (mismo criterio de
// dueño que /estado). Vuelve a Pendiente sin nadie asignado, marcado como
// rebotado — el tablero lo muestra en su propia columna, separado de los
// Pendientes normales, mientras siga sin tomarse de nuevo. Quien lo rebotó
// puede volver a tomarlo después si quiere; no queda bloqueado para él.
// ==========================
export const rebotarTicket = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { motivo, asignar_a } = req.body;

    const actual = await pool.query(
      "SELECT idticket, creado_por, asignado_a, estado FROM ticket WHERE idticket = $1 AND eliminado_at IS NULL",
      [id]
    );
    if (actual.rowCount === 0) return res.status(404).json({ error: "Ticket no encontrado" });

    if (!(await esCoAsignado(String(id), req.user!.id))) {
      return res.status(403).json({ error: "Solo quien tiene asignado el ticket lo puede rebotar" });
    }
    if (["Finalizado", "Cancelado"].includes(actual.rows[0].estado)) {
      return res.status(400).json({ error: "Este ticket ya se cerró, no se puede rebotar" });
    }

    // Rebotar "a alguien" (admin o súper usuario autorizado) es distinto de
    // rebotar "al montón": si viene destino, se valida igual que en
    // asignarTicketA y el ticket pasa derecho a esa persona ya en proceso.
    let destino: { idusuario: number; correo: string } | null = null;
    if (asignar_a != null) {
      const destinoRow = await pool.query(
        "SELECT idusuario, correo FROM usuarios WHERE idusuario = $1 AND activo = true AND eliminado_at IS NULL",
        [asignar_a]
      );
      if (destinoRow.rowCount === 0) {
        return res.status(400).json({ error: "Ese usuario no existe o está inactivo" });
      }
      destino = destinoRow.rows[0];
    }

    const ticket = await req.tx(async (client) => {
      const { rows } = await client.query(
        `UPDATE ticket
            SET asignado_a = $3,
                estado = 'Pendiente',
                rebotado = true,
                motivo_rebote = $1,
                rebotado_en = now(),
                fecha_compromiso = NULL,
                duracion_estimada_horas = NULL,
                tomado_en = CASE WHEN $4 THEN now() ELSE tomado_en END
          WHERE idticket = $2 AND eliminado_at IS NULL
          RETURNING *`,
        [motivo?.trim() || null, id, destino?.idusuario ?? null, !!destino]
      );
      // Rebotar limpia TODA la lista de responsables — si eran 2 personas
      // trabajando en el ticket, las 2 se sueltan; si hay destino, arranca
      // limpio con esa sola persona (igual que en asignarTicketA).
      await client.query("DELETE FROM ticket_asignado WHERE idticket = $1", [id]);
      if (destino) {
        await client.query("INSERT INTO ticket_asignado (idticket, usuario_id) VALUES ($1, $2)", [id, destino.idusuario]);
      }
      return rows[0];
    });

    const { rows: creadorRow } = await pool.query("SELECT correo FROM usuarios WHERE idusuario = $1", [ticket.creado_por]);

    if (destino) {
      // Fue directo a alguien — solo se enteran los 2 involucrados, igual
      // que una asignación normal.
      const destinatarios = [...new Set([creadorRow[0]?.correo, destino.correo])].filter(Boolean) as string[];
      if (destinatarios.length > 0) {
        enviarCorreo({
          para: destinatarios,
          asunto: `🎫 Ticket ${ticket.folio} rebotado a ${destino.correo}`,
          html: `
            <p>El ticket <strong>${ticket.folio}</strong> — "${ticket.titulo}" fue rebotado por ${req.user!.correo} directo a ${destino.correo}.</p>
            ${ticket.motivo_rebote ? `<p>Motivo: ${ticket.motivo_rebote}</p>` : ""}
          `,
        }).catch((e) => console.error("❌ Correo ticket rebotado a alguien:", e.message));
      }
    } else {
      // Vuelve al montón sin dueño — le avisa a quien reportó + a todos los
      // que pueden resolver, igual que cuando se crea uno nuevo.
      correosResolutores()
        .then((destinatariosResolutores) => {
          const destinatarios = [...new Set([creadorRow[0]?.correo, ...destinatariosResolutores])].filter(Boolean) as string[];
          if (destinatarios.length === 0) return;
          return enviarCorreo({
            para: destinatarios,
            asunto: `🎫 Ticket ${ticket.folio} regresado a la cola`,
            html: `
              <p>El ticket <strong>${ticket.folio}</strong> — "${ticket.titulo}" fue rebotado por ${req.user!.correo} y quedó disponible otra vez.</p>
              ${ticket.motivo_rebote ? `<p>Motivo: ${ticket.motivo_rebote}</p>` : ""}
            `,
          });
        })
        .catch((e) => console.error("❌ Correo ticket rebotado:", e.message));
    }

    res.json(ticket);
  } catch (error: any) {
    console.error("❌ REBOTAR TICKET ERROR:", error.message);
    res.status(500).json({ error: "Error al rebotar el ticket" });
  }
};

// ==========================
// GET /api/tickets/notificaciones
// "Campanita" por ticket: true si hay un comentario o imagen más nuevo que
// la última vez que ESTE usuario abrió ESE ticket, y no fue él quien lo
// puso. Respeta notas internas (un Admin no cuenta como no-leído algo que
// de todas formas no puede ver). El alcance de "qué tickets me importan" es
// el mismo que ya usa el contador: Admin = los suyos, Super Usuario = toda
// la cola activa.
// ==========================
export const notificacionesTickets = async (req: AuthRequest, res: Response) => {
  try {
    const esResolutor = esResolutorTickets(req.user);
    const usuarioId = req.user!.id;

    const { rows } = await pool.query(
      `SELECT t.idticket,
              EXISTS (
                SELECT 1 FROM ticket_comentario c
                 WHERE c.idticket = t.idticket
                   AND c.eliminado_at IS NULL
                   AND c.creado_por <> $1
                   AND c.created_at > COALESCE(tv.visto_en, '-infinity'::timestamp)
                   AND (c.es_interno = false OR $2)
                UNION
                SELECT 1 FROM archivos a
                 WHERE (
                         a.ticket_id = t.idticket
                         OR a.ticket_comentario_id IN (
                              SELECT idticket_comentario FROM ticket_comentario WHERE idticket = t.idticket
                            )
                       )
                   AND a.subido_por <> $1
                   AND a.created_at > COALESCE(tv.visto_en, '-infinity'::timestamp)
              ) AS no_leido
         FROM ticket t
         LEFT JOIN ticket_visto tv ON tv.idticket = t.idticket AND tv.usuario_id = $1
        WHERE t.eliminado_at IS NULL
          AND t.archivado = false
          AND (
                t.creado_por = $1
                OR t.asignado_a = $1
                OR ($2 AND t.es_personal = false)
              )`,
      [usuarioId, esResolutor]
    );

    const porTicket: Record<number, boolean> = {};
    let total = 0;
    for (const r of rows) {
      porTicket[r.idticket] = r.no_leido;
      if (r.no_leido) total++;
    }

    res.json({ porTicket, total });
  } catch (error: any) {
    console.error("❌ NOTIFICACIONES TICKETS ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener notificaciones" });
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
          AND (
                creado_por = $1
                OR asignado_a = $1
                OR ($2 AND es_personal = false)
              )`,
      [req.user!.id, esResolutor]
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
/** Le agrega asignado_foto_url a una lista de tickets que ya trae
 *  asignado_foto_public_id en el SELECT — evita repetir el Promise.all en
 *  cada endpoint que lista tickets. También resuelve la foto de CADA
 *  responsable dentro de "asignados" (el json_agg trae foto_public_id en
 *  crudo, aquí se convierte a URL firmada igual que la del principal). */
async function conFotoAsignado(rows: any[]): Promise<any[]> {
  return Promise.all(
    rows.map(async (r) => {
      const { asignado_foto_public_id, asignados, ...resto } = r;
      const asignadosConFoto = await Promise.all(
        (asignados ?? []).map(async (a: any) => ({
          idusuario: a.idusuario,
          nombre: a.nombre,
          apellido: a.apellido,
          foto_url: a.foto_public_id ? await getPresignedUrl(a.foto_public_id) : null,
        }))
      );
      return {
        ...resto,
        asignado_foto_url: asignado_foto_public_id ? await getPresignedUrl(asignado_foto_public_id) : null,
        asignados: asignadosConFoto,
      };
    })
  );
}

export const misTickets = async (req: AuthRequest, res: Response) => {
  try {
    // "Mis tickets" para un Admin son dos cosas, no una: lo que él reportó
    // Y lo que le hayan asignado directo (ver asignarTicketA) — antes solo
    // veía lo primero, así que un ticket asignado por un Super Usuario le
    // quedaba invisible por completo.
    const { rows } = await pool.query(
      `SELECT t.*,
              creador.nombre AS creador_nombre, creador.apellido AS creador_apellido,
              resp.nombre AS asignado_nombre, resp.apellido AS asignado_apellido,
              fotoResp.public_id AS asignado_foto_public_id,
              (
                SELECT COALESCE(json_agg(json_build_object(
                         'idusuario', u2.idusuario,
                         'nombre', u2.nombre,
                         'apellido', u2.apellido,
                         'foto_public_id', af2.public_id
                       ) ORDER BY ta2.asignado_en), '[]'::json)
                  FROM ticket_asignado ta2
                  JOIN usuarios u2 ON u2.idusuario = ta2.usuario_id
                  LEFT JOIN archivos af2 ON af2.id_archivo = u2.foto_id_archivo
                 WHERE ta2.idticket = t.idticket
              ) AS asignados
         FROM ticket t
         JOIN usuarios creador ON creador.idusuario = t.creado_por
         LEFT JOIN usuarios resp ON resp.idusuario = t.asignado_a
         LEFT JOIN archivos fotoResp ON fotoResp.id_archivo = resp.foto_id_archivo
        WHERE (t.creado_por = $1 OR t.asignado_a = $1
               OR EXISTS (SELECT 1 FROM ticket_asignado ta WHERE ta.idticket = t.idticket AND ta.usuario_id = $1))
          AND t.eliminado_at IS NULL
        ORDER BY t.created_at DESC`,
      [req.user!.id]
    );
    res.json(await conFotoAsignado(rows));
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

    // "es_personal = false" para todos, salvo que el personal sea TUYO — un
    // ticket privado de alguien más nunca debe aparecer en la cola general.
    const condiciones: string[] = [
      "t.eliminado_at IS NULL",
      "t.archivado = $1",
      "(t.es_personal = false OR t.creado_por = $2)",
    ];
    const params: any[] = [archivado, req.user!.id];

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
              resp.nombre AS asignado_nombre, resp.apellido AS asignado_apellido,
              fotoResp.public_id AS asignado_foto_public_id,
              (
                SELECT COALESCE(json_agg(json_build_object(
                         'idusuario', u2.idusuario,
                         'nombre', u2.nombre,
                         'apellido', u2.apellido,
                         'foto_public_id', af2.public_id
                       ) ORDER BY ta2.asignado_en), '[]'::json)
                  FROM ticket_asignado ta2
                  JOIN usuarios u2 ON u2.idusuario = ta2.usuario_id
                  LEFT JOIN archivos af2 ON af2.id_archivo = u2.foto_id_archivo
                 WHERE ta2.idticket = t.idticket
              ) AS asignados
         FROM ticket t
         JOIN usuarios creador ON creador.idusuario = t.creado_por
         LEFT JOIN usuarios resp ON resp.idusuario = t.asignado_a
         LEFT JOIN archivos fotoResp ON fotoResp.id_archivo = resp.foto_id_archivo
        WHERE ${condiciones.join(" AND ")}
        ORDER BY t.created_at DESC`,
      params
    );
    res.json(await conFotoAsignado(rows));
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

    // Ya no se restringe a "dueño o resolutor" — desde que la cola completa
    // se abrió a todo el mundo (cualquiera con acceso al módulo VE todos los
    // tickets no-personales en el tablero), el detalle tiene que poder
    // abrirse igual, si no la lista miente ("lo veo pero no lo puedo abrir").
    // Lo único que sigue bloqueado de verdad es un personal de alguien más.
    if (ticket.es_personal && ticket.creado_por !== req.user!.id) {
      // Un personal es privado de verdad: ni un Super Usuario puede
      // curiosear el de alguien más entrando por la URL/id directo.
      return res.status(403).json({ error: "Este ticket es personal de otra persona" });
    }

    // Marca como visto AHORA — así la campanita de no-leído de este ticket
    // se apaga sola para este usuario. No se espera a que termine (no hace
    // falta bloquear la respuesta por esto).
    pool
      .query(
        `INSERT INTO ticket_visto (idticket, usuario_id, visto_en)
         VALUES ($1, $2, now())
         ON CONFLICT (idticket, usuario_id) DO UPDATE SET visto_en = now()`,
        [id, req.user!.id]
      )
      .catch((e) => console.error("❌ Marcar ticket visto:", e.message));

    // Sigue haciendo falta para UNA cosa: filtrar notas internas del hilo
    // de comentarios (esas sí quedan exclusivas de resolutor, aunque el
    // ticket completo ya sea visible para cualquiera).
    const puedeResolver = esResolutorTickets(req.user);

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

    // Lista completa de responsables reales — puede ser más de uno desde
    // que existe "unirse". asignado_nombre/asignado_apellido (arriba) se
    // quedan como el "principal" para no romper nada que ya los use; esto
    // es la lista completa para mostrar todos los avatares.
    const { rows: asignadosRaw } = await pool.query(
      `SELECT u.idusuario, u.nombre, u.apellido, a.public_id AS foto_public_id
         FROM ticket_asignado ta
         JOIN usuarios u ON u.idusuario = ta.usuario_id
         LEFT JOIN archivos a ON a.id_archivo = u.foto_id_archivo
        WHERE ta.idticket = $1
        ORDER BY ta.asignado_en ASC`,
      [id]
    );
    const asignados = await Promise.all(
      asignadosRaw.map(async (u: any) => ({
        idusuario: u.idusuario,
        nombre: u.nombre,
        apellido: u.apellido,
        foto_url: u.foto_public_id ? await getPresignedUrl(u.foto_public_id) : null,
      }))
    );

    res.json({ ...ticket, comentarios, archivos, asignados });
  } catch (error: any) {
    console.error("❌ DETALLE TICKET ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener el ticket" });
  }
};

// ==========================
// PATCH /api/tickets/:id/prioridad
// A diferencia de /estado, aquí SÍ se puede en cualquier momento y por
// cualquiera con acceso al ticket (dueño, asignado o resolutor) — cambiar
// la prioridad no tiene el mismo riesgo de "dos personas pisándose" que
// cambiar el estado, así que no hace falta ser tan estricto.
// ==========================
export const cambiarPrioridadTicket = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { prioridad } = req.body;
    if (!PRIORIDADES.includes(prioridad)) return res.status(400).json({ error: "Prioridad inválida" });

    const actual = await pool.query(
      "SELECT idticket, creado_por, asignado_a FROM ticket WHERE idticket = $1 AND eliminado_at IS NULL",
      [id]
    );
    if (actual.rowCount === 0) return res.status(404).json({ error: "Ticket no encontrado" });

    const t = actual.rows[0];
    // Antes: dueño, asignado o resolutor. Ahora, a propósito, SOLO quien
    // reportó el ticket puede subir/bajar su prioridad — es quien mejor
    // sabe qué tan urgente es de verdad, y evita que alguien más la infle
    // o la baje sin que el que reportó se entere.
    if (t.creado_por !== req.user!.id) {
      return res.status(403).json({ error: "Solo quien reportó el ticket puede cambiar su prioridad" });
    }

    const ticket = await qAudit(req)(
      "UPDATE ticket SET prioridad = $1 WHERE idticket = $2 AND eliminado_at IS NULL RETURNING *",
      [prioridad, id]
    );

    res.json(ticket.rows[0]);
  } catch (error: any) {
    console.error("❌ CAMBIAR PRIORIDAD ERROR:", error.message);
    res.status(500).json({ error: "Error al cambiar la prioridad" });
  }
};

// ==========================
// PATCH /api/tickets/:id/estrellas
// 1 a 3 — desempata importancia entre tickets de la MISMA prioridad. Mismo
// candado que la prioridad: solo quien reportó el ticket la puede tocar.
// ==========================
export const cambiarEstrellasTicket = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { estrellas } = req.body;
    if (!Number.isInteger(Number(estrellas)) || Number(estrellas) < 1 || Number(estrellas) > 5) {
      return res.status(400).json({ error: "Las estrellas deben ser un número del 1 al 5" });
    }

    const actual = await pool.query(
      "SELECT idticket, creado_por FROM ticket WHERE idticket = $1 AND eliminado_at IS NULL",
      [id]
    );
    if (actual.rowCount === 0) return res.status(404).json({ error: "Ticket no encontrado" });

    if (actual.rows[0].creado_por !== req.user!.id) {
      return res.status(403).json({ error: "Solo quien reportó el ticket puede cambiar sus estrellas" });
    }

    const ticket = await qAudit(req)(
      "UPDATE ticket SET estrellas = $1 WHERE idticket = $2 AND eliminado_at IS NULL RETURNING *",
      [Number(estrellas), id]
    );

    res.json(ticket.rows[0]);
  } catch (error: any) {
    console.error("❌ CAMBIAR ESTRELLAS ERROR:", error.message);
    res.status(500).json({ error: "Error al cambiar las estrellas" });
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
      "SELECT idticket, asignado_a, tomado_en FROM ticket WHERE idticket = $1 AND eliminado_at IS NULL",
      [id]
    );
    if (actual.rowCount === 0) return res.status(404).json({ error: "Ticket no encontrado" });
    // Ya no es "asignado_a === yo" a secas — cualquiera de los responsables
    // reales (ticket_asignado) puede mover el estado. Si son 2 personas
    // trabajando en el mismo ticket, cualquiera de las dos lo puede
    // finalizar por igual.
    if (!(await esCoAsignado(String(id), req.user!.id))) {
      return res.status(403).json({
        error: actual.rows[0].asignado_a
          ? "Solo quien tiene asignado el ticket puede cambiar su estado"
          : "Nadie ha tomado este ticket todavía — tómalo primero",
      });
    }

    const esFinal = estado === "Finalizado";
    // "Cierre" ahora es Finalizado O Cancelado — los dos necesitan
    // fecha_cierre guardada para que el cron de archivado (ver
    // jobs/archivarTicketsFinalizados.cron.ts) sepa desde cuándo contar los
    // 5 días hábiles. tiempo_real_horas sigue siendo exclusivo de
    // Finalizado — no tiene sentido comparar tiempo real vs. estimado en
    // uno que se canceló.
    const esCierre = esFinal || estado === "Cancelado";
    // Se calcula ANTES de la transacción porque necesita tomado_en, que ya
    // se leyó arriba — evita una segunda vuelta a la base para lo mismo.
    const tiempoReal =
      esFinal && actual.rows[0].tomado_en
        ? horasHabilesEntre(new Date(actual.rows[0].tomado_en), new Date())
        : null;

    const ticket = await req.tx(async (client) => {
      const { rows } = await client.query(
        `UPDATE ticket
            SET estado = $1,
                fecha_cierre = CASE WHEN $5 THEN now() ELSE fecha_cierre END,
                tiempo_real_horas = CASE WHEN $3 THEN $4 ELSE tiempo_real_horas END
          WHERE idticket = $2 AND eliminado_at IS NULL
          RETURNING *`,
        [estado, id, esFinal, tiempoReal, esCierre]
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
// POST /api/tickets/:id/tomar
// Sirve para DOS cosas ahora:
//   1) Agarrar un ticket libre de la cola — exclusivo de resolutor.
//   2) Confirmar una reserva que ya es tuya (te la asignaron directo con
//      asignarTicketA, y quedó "reservada" en Pendiente) — esto lo puede
//      hacer cualquiera con acceso al módulo, sin importar el rol, porque
//      ya es SU ticket, no está agarrando algo de la cola general.
// Falla con 409 si alguien más ya lo tomó primero — evita condición de
// carrera cuando dos devs le dan clic casi al mismo tiempo.
// ==========================
export const tomarTicket = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const diasHabiles = Number(req.body?.dias_habiles) || 0;
    const horasHabiles = Number(req.body?.horas_habiles) || 0;
    const minutosHabiles = Number(req.body?.minutos_habiles) || 0;
    const duracionTotal = Math.round((diasHabiles * HORAS_POR_DIA + horasHabiles + minutosHabiles / 60) * 100) / 100;

    if (duracionTotal < 0) return res.status(400).json({ error: "La duración no puede ser negativa" });

    const actual = await pool.query(
      "SELECT idticket, asignado_a, estado FROM ticket WHERE idticket = $1 AND eliminado_at IS NULL",
      [id]
    );
    if (actual.rowCount === 0) return res.status(404).json({ error: "Ticket no encontrado" });
    if (["Finalizado", "Cancelado"].includes(actual.rows[0].estado)) {
      return res.status(400).json({ error: "Este ticket ya se cerró" });
    }

    const yaEsReservaMia = actual.rows[0].asignado_a === req.user!.id;
    const estaLibre = actual.rows[0].asignado_a === null;

    if (!yaEsReservaMia && !estaLibre) {
      return res.status(409).json({ error: "Este ticket ya fue tomado por alguien más" });
    }
    // Agarrar algo libre de la cola SÍ sigue siendo exclusivo de resolutor
    // — confirmar tu propia reserva no, porque ahí no le estás quitando
    // nada a nadie más, ya era tuyo.
    if (estaLibre && !esResolutorTickets(req.user)) {
      return res.status(403).json({ error: "Solo un resolutor puede tomar tickets libres de la cola" });
    }

    const ahora = new Date();
    const fechaCompromiso = duracionTotal > 0 ? sumarHorasHabiles(ahora, duracionTotal) : null;

    const ticket = await req.tx(async (client) => {
      const { rows } = await client.query(
        `UPDATE ticket
            SET asignado_a = $1,
                estado = 'En proceso',
                tomado_en = now(),
                duracion_estimada_horas = $3,
                fecha_compromiso = $4
          WHERE idticket = $2 AND eliminado_at IS NULL
            AND (asignado_a IS NULL OR asignado_a = $1)
          RETURNING *`,
        [req.user!.id, id, duracionTotal > 0 ? duracionTotal : null, fechaCompromiso]
      );
      if (rows[0]) {
        await client.query(
          `INSERT INTO ticket_asignado (idticket, usuario_id) VALUES ($1, $2)
           ON CONFLICT (idticket, usuario_id) DO NOTHING`,
          [id, req.user!.id]
        );
      }
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
        html: `
          <p>El ticket <strong>${ticket.folio}</strong> — "${ticket.titulo}" fue tomado por ${req.user!.correo}. Ya está en proceso.</p>
          ${ticket.fecha_compromiso ? `<p>Compromiso estimado: ${new Date(ticket.fecha_compromiso).toLocaleString("es-MX")}</p>` : ""}
        `,
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
      // "Tuyo" es lo mismo que en detalleTicket: lo reportaste, te lo
      // asignaron directo, o eres uno de los co-asignados de la lista real
      // (ticket_asignado) — ya no solo asignado_a a secas.
      const propio = await pool.query(
        `SELECT 1 FROM ticket t
          WHERE t.idticket = $1 AND t.eliminado_at IS NULL
            AND (t.creado_por = $2 OR t.asignado_a = $2
                 OR EXISTS (SELECT 1 FROM ticket_asignado ta WHERE ta.idticket = t.idticket AND ta.usuario_id = $2))`,
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