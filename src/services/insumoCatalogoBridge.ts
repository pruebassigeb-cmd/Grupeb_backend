import { pool } from "../config/db";

// ═══════════════════════════════════════════════════════════════════════════
// PUENTE insumo ⟷ catálogos de papel sincronizados
//
// Fuente de verdad: `insumo` (+ `insumo_proveedor` para precios/proveedores).
// Las tablas cat_* de papel siguen existiendo tal cual (las usan las FKs de
// producción: detalle_material_papel, acabados_papel, suaje_papel, etc.) y se
// mantienen como un "espejo" — se crean/actualizan/activan/desactivan
// automáticamente cuando pasa algo del lado de `insumo`, sin importar si el
// alta se originó desde Proveedores/Insumos o desde Catálogos de papel.
// ═══════════════════════════════════════════════════════════════════════════

export type CatKeySincronizado =
  | "tipo_papel"
  | "pegamento"
  | "laminado"
  | "sacabocados"
  | "perforado"
  | "matrix";

interface CatalogoSyncConfig {
  tabla: string;
  pk: string;
  /** Columna de la tabla cat_* que guarda el nombre visible (en `matrix` es `medida_matrix`) */
  columnaNombre: string;
  tipoInsumoNombre: string;
}

export const CATALOGOS_SINCRONIZADOS: Record<CatKeySincronizado, CatalogoSyncConfig> = {
  tipo_papel:  { tabla: "cat_tipo_papel",  pk: "idcat_tipo_papel",  columnaNombre: "nombre",        tipoInsumoNombre: "Tipo de papel" },
  pegamento:   { tabla: "cat_pegamento",   pk: "idcat_pegamento",   columnaNombre: "nombre",        tipoInsumoNombre: "Pegamento" },
  laminado:    { tabla: "cat_laminado",    pk: "idcat_laminado",    columnaNombre: "nombre",        tipoInsumoNombre: "Laminado" },
  sacabocados: { tabla: "cat_sacabocados", pk: "idcat_sacabocados", columnaNombre: "nombre",        tipoInsumoNombre: "Sacabocados" },
  perforado:   { tabla: "cat_perforado",   pk: "idcat_perforado",   columnaNombre: "nombre",        tipoInsumoNombre: "Perforado" },
  matrix:      { tabla: "matrix",          pk: "idmatrix",          columnaNombre: "medida_matrix", tipoInsumoNombre: "Matrix" },
};

/** ¿El nombre de un tipo_insumo corresponde a uno de los catálogos sincronizados? */
export function catKeyDesdeTipoInsumoNombre(nombreTipo: string): CatKeySincronizado | null {
  const entry = Object.entries(CATALOGOS_SINCRONIZADOS).find(
    ([, cfg]) => cfg.tipoInsumoNombre.toLowerCase() === nombreTipo.trim().toLowerCase()
  );
  return entry ? (entry[0] as CatKeySincronizado) : null;
}

async function getIdTipoInsumo(client: any, nombreTipo: string): Promise<number> {
  const { rows } = await client.query(
    `SELECT idtipo_insumo FROM tipo_insumo WHERE LOWER(TRIM(nombre)) = LOWER(TRIM($1)) LIMIT 1`,
    [nombreTipo]
  );
  if (rows.length === 0) {
    throw new Error(
      `No existe el tipo de insumo "${nombreTipo}". Corre la migración 002_unificar_catalogos_papel_insumo.sql`
    );
  }
  return rows[0].idtipo_insumo;
}

/**
 * Wrapper de conveniencia: dado un tipo_insumo_id (tal como llega en el body
 * de las rutas de Proveedores), resuelve si corresponde a un catálogo
 * sincronizado y, si aplica, crea/actualiza su espejo en cat_*. No hace nada
 * si el tipo de insumo no es uno de los 6 sincronizados.
 */
export async function sincronizarEspejoSiAplica(
  client: any,
  idinsumo: number,
  tipoInsumoId: number,
  nombreCompleto: string
) {
  const { rows } = await client.query(
    `SELECT nombre FROM tipo_insumo WHERE idtipo_insumo = $1`,
    [tipoInsumoId]
  );
  if (rows.length === 0) return;
  const catKey = catKeyDesdeTipoInsumoNombre(rows[0].nombre);
  if (!catKey) return;
  await upsertEspejoCat(client, catKey, idinsumo, nombreCompleto.trim());
}

/**
 * Crea (o reutiliza si ya existe un insumo con el mismo nombre+tipo) el
 * insumo correspondiente a `catKey`, y crea/reactiva su fila espejo en la
 * tabla cat_* asociada. `nombreCompleto` ya debe incluir la medida si aplica
 * (ej. "Sacabocado 3 mm") — la medida se guarda como parte del nombre, no en
 * una columna aparte (así se confirmó para mantenerlo simple).
 *
 * Debe llamarse dentro de una transacción del caller (pasa el `client`).
 */
export async function crearInsumoConEspejo(
  client: any,
  params: { catKey: CatKeySincronizado; nombreCompleto: string }
): Promise<{ idinsumo: number; catRow: any; yaExistia: boolean }> {
  const cfg = CATALOGOS_SINCRONIZADOS[params.catKey];
  const nombreCompleto = params.nombreCompleto.trim();
  const idTipoInsumo = await getIdTipoInsumo(client, cfg.tipoInsumoNombre);

  const { rows: existentes } = await client.query(
    `SELECT idinsumo FROM insumo
     WHERE tipo_insumo_id = $1 AND LOWER(TRIM(nombre)) = LOWER(TRIM($2))`,
    [idTipoInsumo, nombreCompleto]
  );

  let idinsumo: number;
  let yaExistia = false;

  if (existentes.length > 0) {
    idinsumo = existentes[0].idinsumo;
    yaExistia = true;
    // Si ya existía pero estaba desactivado, reactivarlo aquí tiene sentido
    // (el usuario lo está volviendo a dar de alta activamente).
    await client.query(`UPDATE insumo SET activo = true WHERE idinsumo = $1`, [idinsumo]);
  } else {
    const { rows } = await client.query(
      `INSERT INTO insumo (tipo_insumo_id, nombre, activo)
       VALUES ($1, $2, true)
       RETURNING idinsumo`,
      [idTipoInsumo, nombreCompleto]
    );
    idinsumo = rows[0].idinsumo;
  }

  const catRow = await upsertEspejoCat(client, params.catKey, idinsumo, nombreCompleto);
  return { idinsumo, catRow, yaExistia };
}

async function upsertEspejoCat(
  client: any,
  catKey: CatKeySincronizado,
  idinsumo: number,
  nombreCompleto: string
) {
  const cfg = CATALOGOS_SINCRONIZADOS[catKey];

  const { rows: existeEspejo } = await client.query(
    `SELECT ${cfg.pk} AS id FROM ${cfg.tabla} WHERE insumo_idinsumo = $1`,
    [idinsumo]
  );

  if (existeEspejo.length > 0) {
    await client.query(
      `UPDATE ${cfg.tabla} SET ${cfg.columnaNombre} = $1, activo = true WHERE ${cfg.pk} = $2`,
      [nombreCompleto, existeEspejo[0].id]
    );
    const { rows } = await client.query(`SELECT * FROM ${cfg.tabla} WHERE ${cfg.pk} = $1`, [existeEspejo[0].id]);
    return rows[0];
  }

  const { rows } = await client.query(
    `INSERT INTO ${cfg.tabla} (${cfg.columnaNombre}, activo, insumo_idinsumo)
     VALUES ($1, true, $2)
     RETURNING *`,
    [nombreCompleto, idinsumo]
  );
  return rows[0];
}

/**
 * Sincroniza el espejo cat_* de un insumo YA EXISTENTE (ej. cuando se renombra
 * desde el lado de Proveedores/Insumos). No crea insumo nuevo — si el tipo del
 * insumo no corresponde a un catálogo sincronizado, no hace nada.
 */
export async function sincronizarEspejoDesdeInsumo(
  client: any,
  idinsumo: number,
  tipoInsumoNombre: string,
  nombreCompleto: string
) {
  const catKey = catKeyDesdeTipoInsumoNombre(tipoInsumoNombre);
  if (!catKey) return;
  await upsertEspejoCat(client, catKey, idinsumo, nombreCompleto.trim());
}

/**
 * Desactiva el insumo COMPLETO (independiente de cuántos proveedores tenga —
 * eso lo maneja `insumo_proveedor` por separado) y su espejo en cat_*, si
 * corresponde a un catálogo sincronizado. Nunca borra nada de la BD.
 */
export async function desactivarInsumoCompleto(idinsumo: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `UPDATE insumo SET activo = false WHERE idinsumo = $1 RETURNING idinsumo, tipo_insumo_id, nombre`,
      [idinsumo]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const { rows: tipoRows } = await client.query(
      `SELECT nombre FROM tipo_insumo WHERE idtipo_insumo = $1`,
      [rows[0].tipo_insumo_id]
    );
    const catKey = tipoRows[0] ? catKeyDesdeTipoInsumoNombre(tipoRows[0].nombre) : null;
    if (catKey) {
      const cfg = CATALOGOS_SINCRONIZADOS[catKey];
      await client.query(`UPDATE ${cfg.tabla} SET activo = false WHERE insumo_idinsumo = $1`, [idinsumo]);
    }

    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Reactiva el insumo completo y su espejo (si corresponde). */
export async function reactivarInsumoCompleto(idinsumo: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `UPDATE insumo SET activo = true WHERE idinsumo = $1 RETURNING idinsumo, tipo_insumo_id, nombre`,
      [idinsumo]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const { rows: tipoRows } = await client.query(
      `SELECT nombre FROM tipo_insumo WHERE idtipo_insumo = $1`,
      [rows[0].tipo_insumo_id]
    );
    const catKey = tipoRows[0] ? catKeyDesdeTipoInsumoNombre(tipoRows[0].nombre) : null;
    if (catKey) {
      const cfg = CATALOGOS_SINCRONIZADOS[catKey];
      await client.query(`UPDATE ${cfg.tabla} SET activo = true WHERE insumo_idinsumo = $1`, [idinsumo]);
    }

    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}