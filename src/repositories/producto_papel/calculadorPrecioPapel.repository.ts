import type { QueryResult, QueryResultRow } from "pg";
import { pool } from "../../config/db";
import type {
  ContextoCalculoPrecioPapelDb,
  TarifaCalculoPrecioPapelDb,
} from "../../types/producto_papel/calculadorPrecioPapel.types";

export interface QueryExecutor {
  query<R extends QueryResultRow = any>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export async function obtenerContextoCalculoPrecioPapel(
  idProductoPapel: number,
  idGrupoPapel: number,
  db: QueryExecutor = pool,
): Promise<ContextoCalculoPrecioPapelDb | null> {
  const { rows } = await db.query<ContextoCalculoPrecioPapelDb>(
    `
      SELECT
        pp.idproducto_papel,
        COALESCE(pp.activo, FALSE) AS producto_activo,
        gp.idgrupo_papel,
        gp.precio_sugerido AS precio_base,
        pp.costo_laminado,
        pp.tamano_prod AS id_tamano_producto,
        ctp.nombre AS tamano_producto
      FROM producto_papel pp
      LEFT JOIN grupo_papel gp
        ON gp.idproducto_papel = pp.idproducto_papel
       AND gp.idgrupo_papel = $2
      LEFT JOIN cat_tamano_producto ctp
        ON ctp.idcat_tamano_producto = pp.tamano_prod
      WHERE pp.idproducto_papel = $1
      LIMIT 1
    `,
    [idProductoPapel, idGrupoPapel],
  );

  return rows[0] ?? null;
}

/**
 * Obtiene en una sola consulta todas las escalas activas y las tarifas de los
 * acabados solicitados para el tamaño del producto. De esta manera una fila
 * con hasta tres cantidades no provoca una consulta por cantidad/acabado.
 */
export async function obtenerMatrizCalculoPrecioPapel(
  idTamanoProducto: number | null,
  clavesAcabado: string[],
  db: QueryExecutor = pool,
): Promise<TarifaCalculoPrecioPapelDb[]> {
  const { rows } = await db.query<TarifaCalculoPrecioPapelDb>(
    `
      WITH escalas AS (
        SELECT idcat_escala_costo, cantidad
        FROM cat_escala_costo
        WHERE activo = TRUE
      ),
      acabados AS (
        SELECT
          idcat_acabado_costo,
          clave,
          nombre,
          tipo_calculo,
          activo,
          orden
        FROM cat_acabado_costo
        WHERE clave = ANY($2::text[])
      )
      SELECT
        e.idcat_escala_costo AS id_escala,
        e.cantidad AS cantidad_escala,
        a.idcat_acabado_costo AS id_acabado,
        a.clave AS acabado_clave,
        a.nombre AS acabado_nombre,
        a.tipo_calculo,
        a.activo AS acabado_activo,
        ac.precio_unitario,
        ac.activo AS tarifa_activa
      FROM escalas e
      LEFT JOIN acabados a ON TRUE
      LEFT JOIN acabado_costo ac
        ON ac.idcat_acabado_costo = a.idcat_acabado_costo
       AND ac.idcat_tamano_producto = $1
       AND ac.idcat_escala_costo = e.idcat_escala_costo
      ORDER BY e.cantidad, a.orden, a.nombre
    `,
    [idTamanoProducto, clavesAcabado],
  );

  return rows;
}
