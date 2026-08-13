import { Request, Response, NextFunction } from "express";
import { PoolClient } from "pg";
import { pool } from "../config/db";

/**
 * AUDITORÍA — puente entre Express y Postgres
 *
 * Los triggers de la base leen el usuario con:
 *     current_setting('app.usuario_id')
 *
 * Ese valor solo existe dentro de la transacción que lo declara,
 * gracias a SET LOCAL. Por eso toda escritura que deba quedar
 * auditada tiene que pasar por conAuditoria().
 *
 * Regla práctica: si el query es INSERT, UPDATE o DELETE, va
 * dentro de conAuditoria(). Los SELECT pueden seguir usando
 * pool.query() directo.
 */

export interface ContextoAuditoria {
  endpoint?: string;
  metodo?: string;
  ip?: string;
}

/**
 * Adjunta a req un ejecutor de transacciones ya configurado con el
 * usuario autenticado. Se monta DESPUÉS del authMiddleware.
 *
 *   app.use(authMiddleware);
 *   app.use(contextoAuditoria);
 */
export const contextoAuditoria = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const contexto: ContextoAuditoria = {
    endpoint: req.originalUrl,
    metodo: req.method,
    ip: req.ip,
  };

  // req.tx() se llama DESPUÉS de este middleware, así que resuelve el
  // usuario en ese momento (no aquí) — de otro modo un middleware
  // posterior en la cadena (ej. resolverOperadorProceso, fase 5) que
  // ajuste req.operadorId nunca se reflejaría, porque el usuarioId ya
  // habría quedado fijo en este closure.
  (req as any).tx = <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> =>
    conAuditoria(usuarioIdParaAuditoria(req), fn, contexto);

  next();
};

/**
 * A quién se le atribuye la escritura. Por default el usuario de la sesión
 * (req.user.id) — pero si resolverOperadorProceso (fase 5, ver
 * middlewares/procesoToken.middleware.ts) validó un token de proceso, usa
 * ese operador real en su lugar. Así la bitácora de una acción hecha por la
 * cuenta compartida de Planta, verificada por un operador puntual, queda a
 * nombre del operador y no de la cuenta compartida.
 */
export function usuarioIdParaAuditoria(req: Request): number | null {
  return (req as any).operadorId ?? (req as any).user?.id ?? null;
}

/**
 * Abre una transacción, declara quién la ejecuta y corre el callback.
 * Hace COMMIT si todo salió bien, ROLLBACK si algo tronó, y siempre
 * libera la conexión.
 *
 * El SET LOCAL muere con la transacción, así que no hay riesgo de
 * que el usuario se quede pegado en una conexión del pool y se le
 * atribuyan cambios a alguien más. Ese es justo el bug que evita
 * usar SET LOCAL en lugar de SET.
 */
export async function conAuditoria<T>(
  usuarioId: number | null,
  fn: (client: PoolClient) => Promise<T>,
  contexto?: ContextoAuditoria
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query("SELECT set_config('app.usuario_id', $1, true)", [
      usuarioId !== null && usuarioId !== undefined ? String(usuarioId) : "",
    ]);

    if (contexto) {
      await client.query("SELECT set_config('app.contexto', $1, true)", [
        JSON.stringify(contexto),
      ]);
    }

    const resultado = await fn(client);

    await client.query("COMMIT");
    return resultado;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Abre la transacción declarando quién la ejecuta, sobre un client que el
 * controller ya obtuvo por su cuenta.
 *
 * Es la alternativa a req.tx() para los controllers que ya traían su propio
 * pool.connect() + BEGIN/COMMIT/ROLLBACK con validaciones que hacen
 * `return res.status(...)` a media transacción. Reescribir esos a req.tx()
 * significaría reacomodar funciones de 300 y 400 líneas; con esto basta
 * cambiar una línea:
 *
 *     await client.query("BEGIN");   →   await iniciarTx(req, client);
 *
 * Importante: sustituye al BEGIN, no lo acompaña. Y va donde estaba el
 * BEGIN, no antes — si la transacción se abriera antes de las validaciones,
 * un `return` temprano devolvería al pool un client con transacción abierta.
 */
export async function iniciarTx(req: Request, client: PoolClient): Promise<void> {
  await iniciarTxUsuario(client, usuarioIdParaAuditoria(req), {
    endpoint: req.originalUrl,
    metodo: req.method,
    ip: req.ip,
  });
}

/**
 * Reemplazo directo de pool.query() para escrituras sueltas.
 *
 * Muchos handlers hacen un solo INSERT/UPDATE/DELETE con pool.query, sin
 * transacción. pool.query va en autocommit y no puede declarar
 * app.usuario_id (SET LOCAL necesita una transacción), así que esas
 * escrituras quedaban en la bitácora con usuario_id = NULL.
 *
 * Tiene la misma firma que pool.query a propósito: migrar es cambiar el
 * nombre de la llamada, sin tocar el SQL ni los parámetros.
 *
 *     await pool.query(sql, params)   →   await qAudit(req)(sql, params)
 *
 * Para dos o más escrituras que deban ir juntas, usa req.tx() — esto abre
 * una transacción por llamada.
 */
export const qAudit =
  (req: Request) =>
  (text: string, params?: any[]) =>
    conAuditoria(
      usuarioIdParaAuditoria(req),
      (client) => client.query(text, params),
      { endpoint: req.originalUrl, metodo: req.method, ip: req.ip }
    );

/**
 * Igual que iniciarTx pero recibiendo el id del usuario directo, para código
 * que no tiene el `req` a la mano: helpers que ya reciben el usuario por
 * parámetro, o servicios llamados desde un job.
 */
export async function iniciarTxUsuario(
  client: PoolClient,
  usuarioId: number | null,
  contexto?: ContextoAuditoria
): Promise<void> {
  await client.query("BEGIN");

  await client.query("SELECT set_config('app.usuario_id', $1, true)", [
    usuarioId !== null && usuarioId !== undefined ? String(usuarioId) : "",
  ]);

  if (contexto) {
    await client.query("SELECT set_config('app.contexto', $1, true)", [
      JSON.stringify(contexto),
    ]);
  }
}

/**
 * Borrado lógico. Nunca DELETE físico en tablas auditadas: si el
 * registro desaparece, la bitácora apunta a algo que ya no existe
 * y se pierde justo lo que se quería conservar.
 *
 * El trigger fn_tocar_autoria() llena eliminado_por solo.
 */
export async function eliminarLogico(
  client: PoolClient,
  tabla: string,
  columnaPk: string,
  id: number
): Promise<boolean> {
  const result = await client.query(
    `UPDATE ${tabla}
        SET eliminado_at = now()
      WHERE ${columnaPk} = $1
        AND eliminado_at IS NULL`,
    [id]
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Historial de un registro, listo para pintar en pantalla.
 * Devuelve los cambios más recientes primero, con el nombre del
 * usuario ya resuelto.
 */
export async function getHistorial(
  tabla: string,
  registroId: number,
  limite = 50
) {
  const result = await pool.query(
    `SELECT b.idbitacora_cambio,
            b.accion,
            b.campos_cambiados,
            b.datos_antes,
            b.datos_despues,
            b.created_at,
            b.usuario_id,
            u.nombre   AS usuario_nombre,
            u.apellido AS usuario_apellido
       FROM bitacora_cambios b
       LEFT JOIN usuarios u ON u.idusuario = b.usuario_id
      WHERE b.tabla = $1
        AND b.registro_id = $2
      ORDER BY b.created_at DESC
      LIMIT $3`,
    [tabla, registroId, limite]
  );

  return result.rows;
}

/**
 * Diff legible de un cambio. Sirve para el mensaje de sistema que
 * se publica en el chat de la orden de diseño: se calcula una vez
 * y se usa en los dos lados.
 *
 * Los campos técnicos se omiten porque al usuario no le dicen nada.
 */
const CAMPOS_OCULTOS = new Set([
  "updated_at",
  "created_at",
  "actualizado_por",
  "creado_por",
  "eliminado_at",
  "eliminado_por",
]);

export function construirDiff(
  antes: Record<string, any> | null,
  despues: Record<string, any> | null,
  campos: string[] | null,
  etiquetas: Record<string, string> = {}
): { campo: string; etiqueta: string; antes: any; despues: any }[] {
  if (!campos || !despues) return [];

  return campos
    .filter((c) => !CAMPOS_OCULTOS.has(c))
    .map((campo) => ({
      campo,
      etiqueta: etiquetas[campo] ?? campo,
      antes: antes ? antes[campo] : null,
      despues: despues[campo],
    }));
}