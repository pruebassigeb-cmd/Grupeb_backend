import { Response } from "express";
import { pool } from "../../config/db";
import { AuthRequest } from "../../middlewares/auth.middleware";
import {
  TABLAS_AUDITABLES,
  CAMPOS_TECNICOS,
  humanizarCampo,
  type TablaAuditable,
} from "../../config/auditoria.tablas";

/**
 * AUDITORÍA — lectura
 *
 * Un solo endpoint sirve a las dos formas de presentarlo:
 *
 *   - modo discreto  → el botón ⓘ del catálogo usa `sello`
 *   - modo principal → el bloque de pagos/diseño usa `sello` + `eventos`
 *
 * Se devuelven las dos cosas siempre porque el costo de traer el timeline
 * ya paginado es bajo y evita una segunda petición cuando el usuario
 * despliega el detalle.
 */

const COLUMNAS_SELLO = [
  "creado_por",
  "created_at",
  "actualizado_por",
  "updated_at",
  "eliminado_at",
  "eliminado_por",
];

const LIMITE_EVENTOS_MAX = 200;

interface UsuarioResumen {
  id: number;
  nombre: string;
}

// ============================================================
// HELPERS
// ============================================================

/** Resuelve varios ids de usuario de un jalón. Los que no existan
 *  (o vengan en NULL) simplemente no aparecen en el mapa. */
const resolverUsuarios = async (
  ids: (number | null | undefined)[]
): Promise<Map<number, UsuarioResumen>> => {
  const unicos = [...new Set(ids.filter((x): x is number => typeof x === "number"))];
  const mapa = new Map<number, UsuarioResumen>();

  if (unicos.length === 0) return mapa;

  const { rows } = await pool.query(
    `SELECT idusuario, nombre, apellido
       FROM usuarios
      WHERE idusuario = ANY($1::int[])`,
    [unicos]
  );

  for (const r of rows) {
    mapa.set(r.idusuario, {
      id: r.idusuario,
      nombre: [r.nombre, r.apellido].filter(Boolean).join(" ") || `Usuario ${r.idusuario}`,
    });
  }

  return mapa;
};

/** Campos que nunca salen: los técnicos comunes + los que la tabla oculte. */
const camposProhibidos = (config: TablaAuditable): Set<string> =>
  new Set([...CAMPOS_TECNICOS, ...(config.ocultar ?? [])]);

const etiquetaDe = (config: TablaAuditable, campo: string): string =>
  config.campos?.[campo] ?? humanizarCampo(campo);

/**
 * Diff legible de un renglón de la bitácora.
 *
 * En INSERT no hay diff: mostrar "todos los campos cambiaron" es ruido, el
 * evento ya dice "se creó". En DELETE tampoco — el evento ya lo dice.
 */
const construirCambios = (
  config: TablaAuditable,
  accion: string,
  antes: Record<string, any> | null,
  despues: Record<string, any> | null,
  campos: string[] | null
) => {
  if (accion !== "UPDATE" || !campos) return [];

  const prohibidos = camposProhibidos(config);

  return campos
    .filter((c) => !prohibidos.has(c))
    .map((campo) => ({
      campo,
      etiqueta: etiquetaDe(config, campo),
      antes: antes ? (antes[campo] ?? null) : null,
      despues: despues ? (despues[campo] ?? null) : null,
    }));
};

// ============================================================
// GET /api/auditoria/:tabla/:id
// ============================================================

export const getAuditoriaRegistro = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    // String() explícito: según la versión de @types/express, req.params
    // puede tipar sus valores como string | string[], y un arreglo no sirve
    // ni para indexar la lista blanca ni para consultar.
    const tabla = String(req.params.tabla ?? "");
    const id = String(req.params.id ?? "");

    // ── Lista blanca ─────────────────────────────────────────
    // Es lo único que separa este endpoint de una inyección de
    // identificadores: `tabla` y `config.pk` entran a la consulta como
    // nombres, no como parámetros.
    const config = TABLAS_AUDITABLES[tabla];
    if (!config) {
      res.status(404).json({ error: "Esa tabla no tiene historial consultable" });
      return;
    }

    const registroId = Number(id);
    if (!Number.isInteger(registroId) || registroId <= 0) {
      res.status(400).json({ error: "Id inválido" });
      return;
    }

    // ── Privilegio propio de la tabla ────────────────────────
    if (config.permiso && !req.user?.acceso_total) {
      const tiene = (req.user?.privilegios ?? []).includes(config.permiso);
      if (!tiene) {
        res.status(403).json({ error: "No tienes permisos para ver este historial" });
        return;
      }
    }

    const limite = Math.min(
      Number(req.query.limite) || 50,
      LIMITE_EVENTOS_MAX
    );

    // ── Sello de autoría ─────────────────────────────────────
    // No todas las tablas tienen las 6 columnas: se consulta cuáles
    // existen antes de armar el SELECT.
    const { rows: colsExistentes } = await pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = $1
          AND column_name  = ANY($2::text[])`,
      [tabla, COLUMNAS_SELLO]
    );

    let selloRaw: Record<string, any> = {};
    let registroVivo = false;

    if (colsExistentes.length > 0) {
      const lista = colsExistentes
        .map((c: any) => `"${c.column_name}"`)
        .join(", ");

      const { rows } = await pool.query(
        `SELECT ${lista} FROM public."${tabla}" WHERE "${config.pk}" = $1 LIMIT 1`,
        [registroId]
      );

      if (rows.length > 0) {
        selloRaw = rows[0];
        registroVivo = true;
      }
    }

    // ── Timeline ─────────────────────────────────────────────
    const { rows: eventosRaw } = await pool.query(
      `SELECT idbitacora_cambio,
              accion,
              usuario_id,
              datos_antes,
              datos_despues,
              campos_cambiados,
              contexto,
              created_at
         FROM bitacora_cambios
        WHERE tabla       = $1
          AND registro_id = $2
        ORDER BY idbitacora_cambio DESC
        LIMIT $3`,
      [tabla, registroId, limite]
    );

    // Un DELETE físico quita el renglón vivo, pero no debe volver inaccesible
    // su auditoría. En ese caso se reconstruye el sello desde el último
    // snapshot disponible en la bitácora. Solo es 404 cuando no existe ni el
    // registro ni un solo evento histórico para ese id.
    if (!registroVivo && eventosRaw.length === 0) {
      res.status(404).json({ error: "Registro no encontrado" });
      return;
    }

    if (!registroVivo) {
      const ultimoConDatos = eventosRaw.find(
        (evento: any) => evento.datos_despues || evento.datos_antes
      );
      selloRaw = ultimoConDatos?.datos_despues ?? ultimoConDatos?.datos_antes ?? {};
    }

    // ── Nombres de usuario, todos en una sola consulta ───────
    const usuarios = await resolverUsuarios([
      selloRaw.creado_por,
      selloRaw.actualizado_por,
      selloRaw.eliminado_por,
      ...eventosRaw.map((e: any) => e.usuario_id),
    ]);

    const usuarioDe = (id: number | null | undefined) =>
      typeof id === "number" ? usuarios.get(id) ?? { id, nombre: `Usuario ${id}` } : null;

    res.json({
      tabla,
      etiqueta: config.etiqueta,
      modo: config.modo,
      registroId,

      sello: {
        creadoPor: usuarioDe(selloRaw.creado_por),
        createdAt: selloRaw.created_at ?? null,
        actualizadoPor: usuarioDe(selloRaw.actualizado_por),
        updatedAt: selloRaw.updated_at ?? null,
        eliminadoPor: usuarioDe(selloRaw.eliminado_por),
        eliminadoAt: selloRaw.eliminado_at ?? null,
      },

      eventos: eventosRaw.map((e: any) => ({
        id: e.idbitacora_cambio,
        accion: e.accion,
        fecha: e.created_at,
        usuario: usuarioDe(e.usuario_id),
        endpoint: e.contexto?.endpoint ?? null,
        cambios: construirCambios(
          config,
          e.accion,
          e.datos_antes,
          e.datos_despues,
          e.campos_cambiados
        ),
      })),
    });
  } catch (err: any) {
    console.error("❌ GET AUDITORIA REGISTRO:", err.message);
    res.status(500).json({ error: "Error al obtener el historial" });
  }
};

// ============================================================
// GET /api/auditoria/tablas
// Qué se puede consultar y cómo se debe pintar. El frontend lo usa
// para no duplicar el catálogo de etiquetas.
// ============================================================

export const getTablasAuditables = async (
  _req: AuthRequest,
  res: Response
): Promise<void> => {
  res.json(
    Object.entries(TABLAS_AUDITABLES).map(([tabla, c]) => ({
      tabla,
      etiqueta: c.etiqueta,
      modo: c.modo,
      permiso: c.permiso ?? null,
    }))
  );
};
