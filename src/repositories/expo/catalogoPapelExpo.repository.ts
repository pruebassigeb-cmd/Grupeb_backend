import type { QueryResult, QueryResultRow } from "pg";
import { pool } from "../../config/db";
import type { VariantePapelDbRow } from "../../types/expo/catalogoPapelExpo.types";

interface QueryExecutor {
  query<R extends QueryResultRow = any>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export interface BuscarVariantesPapelParams {
  origenExpo?: boolean;
  idProductoPapel?: number;
  soloActivos?: boolean;
}

/**
 * Devuelve una fila por combinación producto_papel + grupo_papel.
 *
 * La consulta concentra producto, grupo, materiales, tamaño, acabados por
 * defecto e imagen en una sola llamada para evitar consultas N+1.
 */
export async function buscarVariantesPapel(
  params: BuscarVariantesPapelParams = {},
  db: QueryExecutor = pool,
): Promise<VariantePapelDbRow[]> {
  const origenExpo = typeof params.origenExpo === "boolean" ? params.origenExpo : null;
  const idProductoPapel = Number.isInteger(params.idProductoPapel)
    ? params.idProductoPapel!
    : null;
  const soloActivos = params.soloActivos !== false;

  const { rows } = await db.query<VariantePapelDbRow>(
    `
      SELECT
        pp.idproducto_papel,
        gp.idgrupo_papel,
        CASE WHEN pp.idproductos = 3 THEN 'carton' ELSE 'papel' END AS categoria,
        ctp.nombre AS tipo_producto,
        pp.descripcion_papel,
        pp.medida,
        pp.ancho,
        pp.fuelle,
        pp.altura,
        pp.tamano_prod AS id_tamano_producto,
        ctm.nombre AS tamano_producto,
        gp.precio_sugerido AS precio_base,
        pp.costo_laminado,

        materiales.grupo_descripcion,
        materiales.material,
        materiales.calibre,
        COALESCE(materiales.items, '[]'::jsonb) AS materiales,

        (lam.idcat_laminado IS NOT NULL) AS laminacion,
        lam.nombre AS tipo_laminado,
        lam.idcat_laminado,

        (pad.idfoil_default IS NOT NULL) AS hs,
        CASE
          WHEN fo.idfoil IS NULL THEN NULL
          ELSE CONCAT(
            fo.colorfoil,
            CASE
              WHEN fo.codigofoil IS NOT NULL AND BTRIM(fo.codigofoil) <> ''
                THEN ' ' || fo.codigofoil
              ELSE ''
            END
          )
        END AS tipo_hs,
        fo.idfoil,

        COALESCE(pad.alto_relieve_default, FALSE) AS ar,
        (pad.idcat_textura_default IS NOT NULL) AS textura,
        tex.nombre AS tipo_textura,
        pad.idcat_textura_default AS idcat_textura,
        COALESCE(pad.uv_default, FALSE) AS uv,

        (asa.idcat_tipo_asa IS NOT NULL) AS asa,
        asa.nombre AS tipo_asa,
        asa.idcat_tipo_asa,
        COALESCE(laminados_lista.items, '[]'::jsonb) AS laminados_permitidos,
        COALESCE(asas_lista.items, '[]'::jsonb) AS asas_permitidas,

        tf.cantidad AS tintas_frente_default,
        td.cantidad AS tintas_dentro_default,
        img.public_id AS imagen_public_id,
        pp.origen_expo,

        -- Se conservan temporalmente para no romper plástico/flujo legado.
        pp.precio_500,
        pp.precio_1000,
        pp.precio_3000

      FROM producto_papel pp

      LEFT JOIN cat_tipo_producto_papel ctp
        ON ctp.idcat_tipo_producto_papel = pp.idcat_tipo_producto_papel

      LEFT JOIN cat_tamano_producto ctm
        ON ctm.idcat_tamano_producto = pp.tamano_prod

      -- LEFT JOIN permite mostrar productos antiguos que todavía no tengan
      -- grupo; el calculador será quien advierta que falta precio base.
      LEFT JOIN grupo_papel gp
        ON gp.idproducto_papel = pp.idproducto_papel

      LEFT JOIN producto_acabado_default pad
        ON pad.idproducto_papel = pp.idproducto_papel

      LEFT JOIN LATERAL (
        SELECT
          STRING_AGG(
            CONCAT_WS(
              ' ',
              NULLIF(BTRIM(ctp2.nombre), ''),
              NULLIF(BTRIM(cc.nombre), '')
            ),
            ' + ' ORDER BY dmp.orden, dmp.iddetalle_material
          ) AS grupo_descripcion,
          STRING_AGG(
            COALESCE(ctp2.nombre, ''),
            ' + ' ORDER BY dmp.orden, dmp.iddetalle_material
          ) AS material,
          STRING_AGG(
            COALESCE(cc.nombre, ''),
            ' + ' ORDER BY dmp.orden, dmp.iddetalle_material
          ) AS calibre,
          JSONB_AGG(
            JSONB_BUILD_OBJECT(
              'iddetalle_material', dmp.iddetalle_material,
              'orden', dmp.orden,
              'idcat_tipo_papel', dmp.idcat_tipo_papel,
              'tipo_papel', ctp2.nombre,
              'idcat_calibre', dmp.idcat_calibre,
              'calibre', cc.nombre
            )
            ORDER BY dmp.orden, dmp.iddetalle_material
          ) AS items
        FROM detalle_material_papel dmp
        LEFT JOIN cat_tipo_papel ctp2
          ON ctp2.idcat_tipo_papel = dmp.idcat_tipo_papel
        LEFT JOIN cat_calibre cc
          ON cc.idcat_calibre = dmp.idcat_calibre
        WHERE dmp.idgrupo_papel = gp.idgrupo_papel
      ) materiales ON TRUE

      -- El valor seleccionado por defecto es independiente de las opciones
      -- permitidas. Si el default es NULL, el producto debe entrar al cotizador
      -- sin laminado/asa aunque sí tenga alternativas disponibles.
      LEFT JOIN LATERAL (
        SELECT al.idcat_laminado, cl.nombre
        FROM acabados_papel ap
        JOIN acabados_laminado al
          ON al.idacabados_papel = ap.idacabados_papel
        JOIN cat_laminado cl
          ON cl.idcat_laminado = al.idcat_laminado
        WHERE ap.idproducto_papel = pp.idproducto_papel
          AND al.idcat_laminado = pad.idcat_laminado_default
        ORDER BY al.idacabados_laminado
        LIMIT 1
      ) lam ON TRUE

      LEFT JOIN LATERAL (
        SELECT aa.idcat_tipo_asa, ta.nombre
        FROM acabados_papel ap
        JOIN acabados_asas aa
          ON aa.idacabados_papel = ap.idacabados_papel
        JOIN cat_tipo_asa ta
          ON ta.idcat_tipo_asa = aa.idcat_tipo_asa
        WHERE ap.idproducto_papel = pp.idproducto_papel
          AND aa.idcat_tipo_asa = pad.idcat_tipo_asa_default
        ORDER BY aa.idacabados_asa
        LIMIT 1
      ) asa ON TRUE

      LEFT JOIN LATERAL (
        SELECT JSONB_AGG(
          JSONB_BUILD_OBJECT(
            'idcat_laminado', opciones.idcat_laminado,
            'nombre', opciones.nombre
          )
          ORDER BY opciones.nombre
        ) AS items
        FROM (
          SELECT DISTINCT cl.idcat_laminado, cl.nombre
          FROM acabados_papel ap
          JOIN acabados_laminado al
            ON al.idacabados_papel = ap.idacabados_papel
          JOIN cat_laminado cl
            ON cl.idcat_laminado = al.idcat_laminado
          WHERE ap.idproducto_papel = pp.idproducto_papel
        ) opciones
      ) laminados_lista ON TRUE

      LEFT JOIN LATERAL (
        SELECT JSONB_AGG(
          JSONB_BUILD_OBJECT(
            'idcat_tipo_asa', opciones.idcat_tipo_asa,
            'nombre', opciones.nombre
          )
          ORDER BY opciones.nombre
        ) AS items
        FROM (
          SELECT DISTINCT ta.idcat_tipo_asa, ta.nombre
          FROM acabados_papel ap
          JOIN acabados_asas aa
            ON aa.idacabados_papel = ap.idacabados_papel
          JOIN cat_tipo_asa ta
            ON ta.idcat_tipo_asa = aa.idcat_tipo_asa
          WHERE ap.idproducto_papel = pp.idproducto_papel
        ) opciones
      ) asas_lista ON TRUE

      LEFT JOIN foil fo
        ON fo.idfoil = pad.idfoil_default

      LEFT JOIN cat_textura tex
        ON tex.idcat_textura = pad.idcat_textura_default

      LEFT JOIN tintas tf
        ON tf.idtintas = pad.idtintas_frente_default

      LEFT JOIN tintas td
        ON td.idtintas = pad.idtintas_dentro_default

      LEFT JOIN LATERAL (
        SELECT a.public_id
        FROM archivos a
        WHERE a.idproducto_papel = pp.idproducto_papel
          AND a.categoria = 'imagen-suaje-papel'
        ORDER BY a.id_archivo DESC
        LIMIT 1
      ) img ON TRUE

      WHERE ($1::boolean = FALSE OR pp.activo = TRUE)
        AND ($2::boolean IS NULL OR pp.origen_expo = $2)
        AND ($3::integer IS NULL OR pp.idproducto_papel = $3)

      ORDER BY
        pp.idproducto_papel DESC,
        COALESCE(gp.orden, 1),
        gp.idgrupo_papel
    `,
    [soloActivos, origenExpo, idProductoPapel],
  );

  return rows;
}
