import { Request, Response } from "express";
import { pool } from "../../config/db";
import { getPresignedUrl } from "../../config/multer";

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS DE FORMATO NUMÉRICO (ancho / fuelle / altura / medida)
// ═══════════════════════════════════════════════════════════════════════════
// Postgres regresa las columnas numeric como texto con ceros decimales fijos
// (ej. "12.00"). limpiarNumero los deja como "12" (o "12.5" si el decimal es
// real). Se aplica aquí, en el backend, para que CUALQUIER consumidor
// (frontend de alta, PDF, futuras vistas) reciba el valor ya correcto sin
// tener que repetir el filtro en cada lugar donde se use.
function limpiarNumero(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : String(v);
}

// El cálculo se realiza en el frontend para mostrarlo en tiempo real. El
// backend no lo recalcula: únicamente valida el valor recibido antes de
// guardarlo en producto_papel.costo_laminado.
function costoLaminadoONull(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === "") return null;

  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero < 0) return null;

  return Number(numero.toFixed(4));
}

// Recalcula "medida" a partir de ancho/fuelle/altura YA limpios, con la
// misma regla que usa el frontend: "ancho+fuellexaltura" si hay fuelle
// distinto de 0, o "anchoxaltura" si no. Si no hay ancho ni altura, se
// respeta la medida ya guardada en BD (por si el producto no usa estos
// campos y la medida se capturó como texto libre).
function recalcularMedida(anchoLimpio: string | null, fuelleLimpio: string | null, alturaLimpio: string | null, medidaOriginal: string | null): string | null {
  if (!anchoLimpio && !alturaLimpio) return medidaOriginal;
  const tieneFuelle = fuelleLimpio && fuelleLimpio !== "0";
  return tieneFuelle
    ? `${anchoLimpio ?? ""}+${fuelleLimpio}x${alturaLimpio ?? ""}`
    : `${anchoLimpio ?? ""}x${alturaLimpio ?? ""}`;
}

function limpiarMedidasProducto<T extends { ancho?: unknown; fuelle?: unknown; altura?: unknown; medida?: unknown }>(row: T): T {
  const ancho = limpiarNumero(row.ancho);
  const fuelle = limpiarNumero(row.fuelle);
  const altura = limpiarNumero(row.altura);
  return {
    ...row,
    ancho,
    fuelle,
    altura,
    medida: recalcularMedida(ancho, fuelle, altura, (row.medida as string) ?? null),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS MAQUINARIA MULTISELECT
// ═══════════════════════════════════════════════════════════════════════════
const MAQ_PIVOTS: Record<string, { tabla: string; col: string }> = {
  hojeado_guillotina: { tabla: "maquinaria_hojeado_guillotina", col: "idcat_hojeado_guillotina" },
  impresora:          { tabla: "maquinaria_impresora",          col: "idcat_impresora"          },
  hs_ar:              { tabla: "maquinaria_hs_ar",              col: "idcat_hs_ar"              },
  suaje_maquina:      { tabla: "maquinaria_suaje_maquina",      col: "idcat_suaje_maquina"      },
  uv:                 { tabla: "maquinaria_uv",                 col: "idcat_uv"                 },
  texturizadora:      { tabla: "maquinaria_texturizadora",      col: "idcat_texturizadora"      },
  empalme:            { tabla: "maquinaria_empalme",            col: "idcat_empalme"            },
  armado:             { tabla: "maquinaria_armado",             col: "idcat_armado"             },
  asas_maquina:       { tabla: "maquinaria_asas_maquina",       col: "idcat_asas_maquina"       },
  desbarbe:           { tabla: "maquinaria_desbarbe",           col: "idcat_desbarbe"           },
  laminado_maquina:   { tabla: "maquinaria_laminado",           col: "idcat_laminado_maquina"   },
  empaque_maquina:    { tabla: "maquinaria_empaque",            col: "idcat_empaque_maquina"    },
};

const CAT_TABLES: Record<string, string> = {
  hojeado_guillotina: "cat_hojeado_guillotina",
  impresora:          "cat_impresora",
  hs_ar:              "cat_hs_ar",
  suaje_maquina:      "cat_suaje_maquina",
  uv:                 "cat_uv",
  texturizadora:      "cat_texturizadora",
  empalme:            "cat_empalme",
  armado:             "cat_armado",
  asas_maquina:       "cat_asas_maquina",
  desbarbe:           "cat_desbarbe",
  laminado_maquina:   "cat_laminado_maquina",
  empaque_maquina:    "cat_empaque_maquina",
};

async function insertarMaquinaria(client: any, idproducto_papel: number, maquinaria: Record<string, number[]>) {
  for (const [key, pivot] of Object.entries(MAQ_PIVOTS)) {
    const ids: number[] = maquinaria[key] ?? [];
    for (const id of ids) {
      await client.query(
        `INSERT INTO ${pivot.tabla} (idproducto_papel, ${pivot.col})
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [idproducto_papel, id]
      );
    }
  }
}

async function eliminarMaquinaria(client: any, idproducto_papel: number) {
  for (const pivot of Object.values(MAQ_PIVOTS)) {
    await client.query(
      `DELETE FROM ${pivot.tabla} WHERE idproducto_papel = $1`,
      [idproducto_papel]
    );
  }
}

async function getMaquinaria(id: number) {
  const result: Record<string, { id: number; nombre: string; numero_maquina?: string | null; tipo_maquina?: string | null }[]> = {};
  for (const [key, pivot] of Object.entries(MAQ_PIVOTS)) {
    const cat = CAT_TABLES[key];
    const extraSelect = key === "hojeado_guillotina"
      ? ", c.numero_maquina, c.tipo_maquina"
      : ", c.numero_maquina";
    const { rows } = await pool.query(
      `SELECT m.${pivot.col} AS id, c.nombre${extraSelect}
       FROM ${pivot.tabla} m
       JOIN ${cat} c ON c.${pivot.col} = m.${pivot.col}
       WHERE m.idproducto_papel = $1
       ORDER BY c.nombre ASC`,
      [id]
    );
    result[key] = rows;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS LAMINADO MULTISELECT
// ═══════════════════════════════════════════════════════════════════════════
async function insertarLaminado(client: any, idacabados_papel: number, laminados: number[]) {
  for (const idcat_laminado of laminados) {
    await client.query(
      `INSERT INTO acabados_laminado (idacabados_papel, idcat_laminado)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [idacabados_papel, idcat_laminado]
    );
  }
}

async function getLaminado(idacabados_papel: number) {
  const { rows } = await pool.query(
    `SELECT al.idcat_laminado AS id, cl.nombre
     FROM acabados_laminado al
     JOIN cat_laminado cl ON cl.idcat_laminado = al.idcat_laminado
     WHERE al.idacabados_papel = $1`,
    [idacabados_papel]
  );
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /productos-papel
// ═══════════════════════════════════════════════════════════════════════════
export const getProductosPapel = async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        pp.idproducto_papel,
        pp.ancho,
        pp.fuelle,
        pp.altura,
        pp.medida,
        pp.tamano_asa_default,
        pp.tamano_prod,
        pp.costo_laminado,
        ctam.nombre                      AS tamano_prod_nombre,
        pp.descripcion_papel,
        pp.activo,
        pp.created_at,
        pp.origen_expo,
        tp.nombre                        AS tipo_producto,
        u.nombre || ' ' || u.apellido    AS creado_por,

        -- Tipos de papel y calibres de todos los grupos (separados por " / ")
        mat_preview.primer_tipo_papel,
        mat_preview.primer_calibre,
        mat_preview.primer_pliego,

        -- Costo base = precio_sugerido del Grupo 1 (para mostrar en la tabla
        -- principal sin tener que abrir el detalle del producto). También se
        -- manda su idgrupo_papel para poder editar ese costo directo desde
        -- la celda de la tabla (modo edición inline), y el total de grupos
        -- para saber si el producto tiene más de una opción de material.
        grupo1.idgrupo_papel              AS idgrupo_papel_grupo1,
        grupo1.precio_sugerido            AS costo_base_grupo1,
        grupos_total.total                AS total_grupos,

        -- Datos para el modal general de costo de laminado (ver lateral
        -- lam_info / suaje_info más abajo)
        lam_info.idrollo_lam,
        lam_info.rollo_lam_nombre,
        lam_info.rollo_lam_medida_ancho,
        lam_info.desarrollo_laminado,
        suaje_info.piezas_suaje,

        -- Archivos para vista previa en la tabla
        arch_prev.archivos_raw,

        -- ═══════════════════════════════════════════════════════════════
        -- % DE COMPLETITUD DEL PRODUCTO
        -- ═══════════════════════════════════════════════════════════════
        -- Compara cuántos campos relevantes están llenos contra el total
        -- posible: generales (7) + suaje (16) + acabados (12) +
        -- maquinaria (12) + materiales (variable según cuántos haya) +
        -- archivos (1). Se calcula aquí, en la misma consulta que ya arma
        -- el listado, para no tener que pedir el detalle de cada producto
        -- por separado (evita N+1 peticiones).
        ROUND(
          (
            (
              (CASE WHEN pp.descripcion_papel IS NOT NULL AND pp.descripcion_papel <> '' THEN 1 ELSE 0 END) +
              (CASE WHEN pp.ancho IS NOT NULL THEN 1 ELSE 0 END) +
              (CASE WHEN pp.fuelle IS NOT NULL THEN 1 ELSE 0 END) +
              (CASE WHEN pp.altura IS NOT NULL THEN 1 ELSE 0 END) +
              (CASE WHEN pp.medida IS NOT NULL AND pp.medida <> '' THEN 1 ELSE 0 END) +
              (CASE WHEN pp.tamano_asa_default IS NOT NULL AND pp.tamano_asa_default <> '' THEN 1 ELSE 0 END) +
              -- CORREGIDO: tamano_prod ahora es FK (integer), ya no texto —
              -- comparar contra '' truena ("invalid input syntax for
              -- integer"). Solo se checa que no sea null.
              (CASE WHEN pp.tamano_prod IS NOT NULL THEN 1 ELSE 0 END)
            )
            + suaje_stats.llenos
            + acabados_stats.llenos
            + maq_stats.llenos
            + mat_stats.llenos
            + (CASE WHEN EXISTS (SELECT 1 FROM archivos ar WHERE ar.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END)
          )::numeric
          / (7 + 16 + 12 + 12 + mat_stats.total + 1) * 100
        ) AS completitud_pct

      FROM producto_papel pp
      LEFT JOIN cat_tipo_producto_papel tp ON tp.idcat_tipo_producto_papel = pp.idcat_tipo_producto_papel
      LEFT JOIN cat_tamano_producto ctam ON ctam.idcat_tamano_producto = pp.tamano_prod
      LEFT JOIN usuarios u ON u.idusuario = pp.creado_por

      -- Todos los tipos de papel y calibres de todos los grupos
      LEFT JOIN LATERAL (
        SELECT
          string_agg(DISTINCT ctp.nombre, ' / ' ORDER BY ctp.nombre) AS primer_tipo_papel,
          string_agg(DISTINCT cal.nombre, ' / ' ORDER BY cal.nombre) AS primer_calibre,
          MIN(dm.pliego)                                              AS primer_pliego
        FROM grupo_papel gp
        JOIN detalle_material_papel dm ON dm.idgrupo_papel = gp.idgrupo_papel
        LEFT JOIN cat_tipo_papel ctp ON ctp.idcat_tipo_papel = dm.idcat_tipo_papel
        LEFT JOIN cat_calibre    cal ON cal.idcat_calibre    = dm.idcat_calibre
        WHERE gp.idproducto_papel = pp.idproducto_papel
      ) mat_preview ON true

      -- Grupo 1 (el de menor "orden", o el idgrupo_papel más chico si no hay
      -- orden) — su precio_sugerido es el "costo base" del producto
      LEFT JOIN LATERAL (
        SELECT g1.idgrupo_papel, g1.precio_sugerido
        FROM grupo_papel g1
        WHERE g1.idproducto_papel = pp.idproducto_papel
        ORDER BY g1.orden ASC NULLS LAST, g1.idgrupo_papel ASC
        LIMIT 1
      ) grupo1 ON true

      -- Cuántos grupos (opciones de material) tiene el producto en total —
      -- se usa en la tabla para avisar cuando hay más de uno y así el
      -- usuario sepa que debe abrir el detalle para editar los demás costos.
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS total
        FROM grupo_papel gt
        WHERE gt.idproducto_papel = pp.idproducto_papel
      ) grupos_total ON true

      -- Datos que alimentan la fórmula de costo de laminado (ver
      -- costoLaminado.utils.ts en el frontend) — se traen aquí, en el mismo
      -- listado, para que el modal general de "Editar costos de laminado"
      -- pueda mostrar todos los productos de un jalón sin pedir el detalle
      -- de cada uno por separado.
      LEFT JOIN LATERAL (
        SELECT
          a.idrollo_lam,
          rl.nombre       AS rollo_lam_nombre,
          rl.medida_ancho AS rollo_lam_medida_ancho,
          a.desarrollo_laminado
        FROM acabados_papel a
        LEFT JOIN rollo_lam rl ON rl.idrollo_lam = a.idrollo_lam
        WHERE a.idproducto_papel = pp.idproducto_papel
        LIMIT 1
      ) lam_info ON true

      LEFT JOIN LATERAL (
        SELECT s.pzs AS piezas_suaje
        FROM suaje_papel s
        WHERE s.idproducto_papel = pp.idproducto_papel
        LIMIT 1
      ) suaje_info ON true

      -- Archivos para preview (max 3, priorizando imagen primero)
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id_archivo', a.id_archivo,
            'public_id',  a.public_id,
            'categoria',  a.categoria,
            'nombre',     a.nombre,
            'tipo',       a.tipo
          )
          ORDER BY
            CASE a.categoria
              WHEN 'imagen-suaje-papel'      THEN 1
              WHEN 'catalogo-suaje-papel'    THEN 2
              WHEN 'rendimiento-suaje-papel' THEN 3
              ELSE 4
            END,
            a.id_archivo ASC
        ) AS archivos_raw
        FROM (
          SELECT * FROM archivos
          WHERE idproducto_papel = pp.idproducto_papel
          ORDER BY
            CASE categoria
              WHEN 'imagen-suaje-papel'      THEN 1
              WHEN 'catalogo-suaje-papel'    THEN 2
              WHEN 'rendimiento-suaje-papel' THEN 3
              ELSE 4
            END,
            id_archivo ASC
          LIMIT 3
        ) a
      ) arch_prev ON true

      -- ═══════════════════════════════════════════════════════════════════
      -- LATERALES PARA COMPLETITUD (cada uno siempre regresa 1 fila, aunque
      -- el producto no tenga suaje/acabados/materiales, porque son
      -- funciones de agregación sin GROUP BY)
      -- ═══════════════════════════════════════════════════════════════════
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(
          (CASE WHEN s.numero IS NOT NULL AND s.numero <> '' THEN 1 ELSE 0 END) +
          (CASE WHEN s.pzs IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN s.tamano IS NOT NULL AND s.tamano <> '' THEN 1 ELSE 0 END) +
          (CASE WHEN s.metros IS NOT NULL AND s.metros <> '' THEN 1 ELSE 0 END) +
          (CASE WHEN s.idcat_matrix IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN s.tiempo_arreglo IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN s.corte1_tipo IS NOT NULL AND s.corte1_tipo <> '' THEN 1 ELSE 0 END) +
          (CASE WHEN s.corte1_medida IS NOT NULL AND s.corte1_medida <> '' THEN 1 ELSE 0 END) +
          (CASE WHEN s.idcat_punto_corte IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN s.dobles1_tipo IS NOT NULL AND s.dobles1_tipo <> '' THEN 1 ELSE 0 END) +
          (CASE WHEN s.dobles1_medida IS NOT NULL AND s.dobles1_medida <> '' THEN 1 ELSE 0 END) +
          (CASE WHEN s.idcat_punto_doble IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN s.idcat_sacabocados IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN s.cantidad_sacabocado IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN s.idcat_perforado IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN s.cantidad_perforado IS NOT NULL THEN 1 ELSE 0 END)
        ), 0) AS llenos
        FROM suaje_papel s
        WHERE s.idproducto_papel = pp.idproducto_papel
      ) suaje_stats ON true

      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(
          (CASE WHEN a.idcat_tipo_pegado IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN a.idcat_pegamento IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM acabados_laminado al WHERE al.idacabados_papel = a.idacabados_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN a.idrollo_lam IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN a.desarrollo_laminado IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN a.idcat_refuerzo_material IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN a.idcat_refuerzo_medidas IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN a.idcat_base_material IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN a.base_medida IS NOT NULL AND a.base_medida <> '' THEN 1 ELSE 0 END) +
          (CASE WHEN a.idcat_empaque IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN a.pzs_caja IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM acabados_asas aa WHERE aa.idacabados_papel = a.idacabados_papel) THEN 1 ELSE 0 END)
        ), 0) AS llenos
        FROM acabados_papel a
        WHERE a.idproducto_papel = pp.idproducto_papel
      ) acabados_stats ON true

      LEFT JOIN LATERAL (
        SELECT
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_hojeado_guillotina m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_impresora        m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_hs_ar            m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_suaje_maquina    m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_uv               m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_texturizadora    m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_empalme         m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_armado          m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_asas_maquina    m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_desbarbe        m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_laminado        m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_empaque         m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END)
          AS llenos
      ) maq_stats ON true

      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(
            (CASE WHEN dm.idcat_tipo_papel IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN dm.idcat_calibre IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN dm.pliego IS NOT NULL AND dm.pliego <> '' THEN 1 ELSE 0 END) +
            (CASE WHEN dm.rendimiento IS NOT NULL AND dm.rendimiento <> '' THEN 1 ELSE 0 END) +
            (CASE WHEN dm.corte IS NOT NULL AND dm.corte <> '' THEN 1 ELSE 0 END) +
            (CASE WHEN dm.hoj_bobina IS NOT NULL AND dm.hoj_bobina <> '' THEN 1 ELSE 0 END) +
            (CASE WHEN dm.hoj_corte IS NOT NULL AND dm.hoj_corte <> '' THEN 1 ELSE 0 END) +
            (CASE WHEN dm.hoj_rendimiento IS NOT NULL AND dm.hoj_rendimiento <> '' THEN 1 ELSE 0 END) +
            (CASE WHEN dm.hoj_guillotina IS NOT NULL AND dm.hoj_guillotina <> '' THEN 1 ELSE 0 END) +
            (CASE WHEN dm.hoj_hilo IS NOT NULL AND dm.hoj_hilo <> '' THEN 1 ELSE 0 END) +
            (CASE WHEN dm.hoj_bobina_extra IS NOT NULL AND dm.hoj_bobina_extra <> '' THEN 1 ELSE 0 END)
          ), 0)
          + COALESCE(COUNT(DISTINCT CASE WHEN g.precio_sugerido IS NOT NULL THEN g.idgrupo_papel END), 0)
          AS llenos,
          GREATEST(
            COUNT(dm.iddetalle_material) * 11 + COUNT(DISTINCT g.idgrupo_papel),
            1
          ) AS total
        FROM grupo_papel g
        LEFT JOIN detalle_material_papel dm ON dm.idgrupo_papel = g.idgrupo_papel
        WHERE g.idproducto_papel = pp.idproducto_papel
      ) mat_stats ON true

      WHERE pp.activo = true
      ORDER BY pp.idproducto_papel DESC
    `);

    // Generar presigned URLs para los archivos de preview + limpiar medidas
    const rowsConUrls = await Promise.all(
      rows.map(async (row) => {
        const archivosRaw: any[] = row.archivos_raw ?? [];
        const archivos_preview = await Promise.all(
          archivosRaw.map(async (a) => ({
            id_archivo: a.id_archivo,
            nombre:     a.nombre,
            categoria:  a.categoria,
            tipo:       a.tipo,
            url:        await getPresignedUrl(a.public_id),
          }))
        );
        const { archivos_raw, ...rest } = row;
        return limpiarMedidasProducto({ ...rest, archivos_preview });
      })
    );

    console.log(`✅ Productos papel obtenidos: ${rowsConUrls.length}`);
    return res.json(rowsConUrls);

  } catch (error: any) {
    console.error("❌ GET PRODUCTOS PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener productos de papel" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /productos-papel/:id
// ═══════════════════════════════════════════════════════════════════════════
export const getProductoPapelById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const { rows: prodRows } = await pool.query(`
      SELECT
        pp.*,
        tp.nombre              AS tipo_producto,
        ctam.nombre            AS tamano_prod_nombre,
        u.nombre  || ' ' || u.apellido AS creado_por_nombre
      FROM producto_papel pp
      LEFT JOIN cat_tipo_producto_papel tp ON tp.idcat_tipo_producto_papel = pp.idcat_tipo_producto_papel
      LEFT JOIN cat_tamano_producto ctam ON ctam.idcat_tamano_producto = pp.tamano_prod
      LEFT JOIN usuarios u ON u.idusuario = pp.creado_por
      WHERE pp.idproducto_papel = $1 AND pp.activo = true
    `, [id]);

    if (prodRows.length === 0)
      return res.status(404).json({ error: "Producto no encontrado" });

    const producto = limpiarMedidasProducto(prodRows[0]);

    // ── Grupos y materiales ───────────────────────────────────────────────
    const { rows: grupoRows } = await pool.query(`
      SELECT
        g.idgrupo_papel,
        g.precio_sugerido,
        g.orden,
        dm.iddetalle_material,
        dm.pliego,
        dm.rendimiento,
        dm.corte,
        dm.hoj_bobina,
        dm.hoj_corte,
        dm.hoj_rendimiento,
        dm.hoj_guillotina,
        dm.hoj_hilo,
        dm.hoj_bobina_extra,
        dm.orden             AS material_orden,
        tp.nombre            AS tipo_papel,
        tp.idcat_tipo_papel,
        cal.nombre           AS calibre,
        cal.idcat_calibre
      FROM grupo_papel g
      LEFT JOIN detalle_material_papel dm ON dm.idgrupo_papel = g.idgrupo_papel
      LEFT JOIN cat_tipo_papel tp ON tp.idcat_tipo_papel = dm.idcat_tipo_papel
      LEFT JOIN cat_calibre cal  ON cal.idcat_calibre    = dm.idcat_calibre
      WHERE g.idproducto_papel = $1
      ORDER BY g.orden ASC, dm.orden ASC
    `, [id]);

    const gruposMap: Record<number, any> = {};
    for (const row of grupoRows) {
      if (!gruposMap[row.idgrupo_papel]) {
        gruposMap[row.idgrupo_papel] = {
          idgrupo_papel:   row.idgrupo_papel,
          precio_sugerido: row.precio_sugerido,
          orden:           row.orden,
          materiales:      [],
        };
      }
      if (row.iddetalle_material) {
        gruposMap[row.idgrupo_papel].materiales.push({
          iddetalle_material: row.iddetalle_material,
          tipo_papel:         row.tipo_papel,
          idcat_tipo_papel:   row.idcat_tipo_papel,
          calibre:            row.calibre,
          idcat_calibre:      row.idcat_calibre,
          pliego:             row.pliego,
          rendimiento:        row.rendimiento,
          corte:              row.corte,
          hojeado: {
            bobina:      row.hoj_bobina,
            corte:       row.hoj_corte,
            rendimiento: row.hoj_rendimiento,
            guillotina:  row.hoj_guillotina,
            hilo:        row.hoj_hilo,
            bobina_extra: row.hoj_bobina_extra,
          },
          orden: row.material_orden,
        });
      }
    }
    producto.grupos = Object.values(gruposMap);

    // ── Suaje ─────────────────────────────────────────────────────────────
    const { rows: suajeRows } = await pool.query(`
      SELECT
        s.*,
        sc.nombre  AS sacabocado_nombre,
        sc.medida  AS sacabocado_medida,
        pe.nombre  AS perforado_nombre,
        pe.medida  AS perforado_medida,
        mx.medida_matrix AS matrix_nombre,
        mx.idmatrix      AS idcat_matrix,
        pc.puntos  AS puntos_corte,
        pd.puntos  AS puntos_doble
      FROM suaje_papel s
      LEFT JOIN cat_sacabocados sc ON sc.idcat_sacabocados = s.idcat_sacabocados
      LEFT JOIN cat_perforado   pe ON pe.idcat_perforado   = s.idcat_perforado
      LEFT JOIN matrix          mx ON mx.idmatrix          = s.idcat_matrix
      LEFT JOIN cat_puntos      pc ON pc.idcat_punto       = s.idcat_punto_corte
      LEFT JOIN cat_puntos      pd ON pd.idcat_punto       = s.idcat_punto_doble
      WHERE s.idproducto_papel = $1
    `, [id]);
    producto.suaje = suajeRows[0] ?? null;

    // ── Acabados ──────────────────────────────────────────────────────────
    const { rows: acabadosRows } = await pool.query(`
      SELECT
        a.*,
        tp.nombre   AS tipo_pegado,
        pg.nombre   AS pegamento,
        rl.nombre        AS rollo_lam,
        rl.medida_ancho  AS rollo_lam_medida_ancho,
        rm.nombre        AS refuerzo_material,
        rmed.nombre AS refuerzo_medida,
        bm.nombre   AS base_material,
        em.nombre   AS empaque
      FROM acabados_papel a
      LEFT JOIN cat_tipo_pegado       tp   ON tp.idcat_tipo_pegado       = a.idcat_tipo_pegado
      LEFT JOIN cat_pegamento         pg   ON pg.idcat_pegamento         = a.idcat_pegamento
      LEFT JOIN rollo_lam             rl   ON rl.idrollo_lam             = a.idrollo_lam
      LEFT JOIN cat_refuerzo_material rm   ON rm.idcat_refuerzo_material = a.idcat_refuerzo_material
      LEFT JOIN cat_refuerzo_medidas  rmed ON rmed.idcat_refuerzo_medidas = a.idcat_refuerzo_medidas
      LEFT JOIN cat_refuerzo_material bm   ON bm.idcat_refuerzo_material = a.idcat_base_material
      LEFT JOIN cat_empaque           em   ON em.idcat_empaque           = a.idcat_empaque
      WHERE a.idproducto_papel = $1
    `, [id]);

    if (acabadosRows.length > 0) {
      const acabados = acabadosRows[0];

      const { rows: asasRows } = await pool.query(`
        SELECT aa.idacabados_asa, ta.idcat_tipo_asa, ta.nombre AS tipo_asa
        FROM acabados_asas aa
        JOIN cat_tipo_asa ta ON ta.idcat_tipo_asa = aa.idcat_tipo_asa
        WHERE aa.idacabados_papel = $1
      `, [acabados.idacabados_papel]);

      acabados.asas      = asasRows;
      acabados.laminados = await getLaminado(acabados.idacabados_papel);
      producto.acabados  = acabados;
    } else {
      producto.acabados = null;
    }

    // ── Maquinaria ────────────────────────────────────────────────────────
    producto.maquinaria = await getMaquinaria(Number(id));

    // ── Archivos ──────────────────────────────────────────────────────────
    const { rows: archivosRows } = await pool.query(`
      SELECT id_archivo, nombre, tipo, mime_type, public_id, tamano_kb, categoria
      FROM archivos
      WHERE idproducto_papel = $1
      ORDER BY id_archivo ASC
    `, [id]);

    producto.archivos = await Promise.all(
      archivosRows.map(async (a) => ({
        ...a,
        url: await getPresignedUrl(a.public_id),
      }))
    );

    console.log(`✅ Producto papel obtenido: id=${id}`);
    return res.json(producto);

  } catch (error: any) {
    console.error("❌ GET PRODUCTO PAPEL BY ID ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener el producto" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /productos-papel
// ═══════════════════════════════════════════════════════════════════════════
export const crearProductoPapel = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const {
      idcat_tipo_producto_papel,
      descripcion_papel,
      ancho, fuelle, altura, medida,
      tamano_asa_default,
      tamano_prod,
      costo_laminado,
      grupos = [],
      suaje,
      acabados,
      maquinaria,
    } = req.body;

    const idusuario = (req as any).user?.id ?? null;

    if (!idcat_tipo_producto_papel)
      return res.status(400).json({ error: "El tipo de producto es requerido" });

    // NUEVO: tamano_prod ahora es FK a cat_tamano_producto (id numérico),
    // ya no un desplegable fijo de 5 strings. Aquí solo se valida que sea
    // un entero (o null); que el id exista de verdad lo garantiza la FK
    // real en la BD (fk_producto_papel_tamano_prod) — si no existe, el
    // INSERT de abajo truena con un error de FK, capturado en el catch.
    if (tamano_prod != null && tamano_prod !== "" && !Number.isInteger(Number(tamano_prod))) {
      return res.status(400).json({ error: "tamano_prod inválido" });
    }

    const costoLaminadoValidado = costoLaminadoONull(costo_laminado);
    if (
      costo_laminado !== null &&
      costo_laminado !== undefined &&
      costo_laminado !== "" &&
      costoLaminadoValidado === null
    ) {
      return res.status(400).json({ error: "costo_laminado inválido" });
    }

    // ── Validación de duplicados por descripción + medida ──────────────────
    // Solo se valida cuando ambos campos vienen con contenido: si alguno
    // llega vacío no hay forma confiable de determinar si es "el mismo"
    // producto, así que se deja pasar (sigue siendo opcional en contexto
    // de cotización).
    const descripcionNorm = typeof descripcion_papel === "string" ? descripcion_papel.trim() : "";
    const medidaNorm = typeof medida === "string" ? medida.trim() : "";
    if (descripcionNorm && medidaNorm) {
      const { rows: dup } = await client.query(
        `SELECT idproducto_papel FROM producto_papel
         WHERE idproductos = 2 AND activo = true
           AND TRIM(LOWER(descripcion_papel)) = TRIM(LOWER($1))
           AND TRIM(LOWER(COALESCE(medida, ''))) = TRIM(LOWER($2))
         LIMIT 1`,
        [descripcionNorm, medidaNorm]
      );
      if (dup.length > 0) {
        return res.status(409).json({
          error: "Ya existe un producto registrado con esa descripción y medida",
          idproducto_papel: dup[0].idproducto_papel,
        });
      }
    }

    await client.query("BEGIN");

    // ── 1. Producto padre ─────────────────────────────────────────────────
    // NOTA: origen_expo NO se manda aquí — este endpoint es el alta manual
    // desde la página de Papel, así que se queda en el DEFAULT false de la
    // columna. Solo resolverFKsProductoExpo (creación automática desde
    // Expo) lo marca en true.
    const { rows: prodRows } = await client.query(`
      INSERT INTO producto_papel (
        idproductos, idcat_tipo_producto_papel,
        descripcion_papel, ancho, fuelle, altura, medida, tamano_asa_default,
        tamano_prod, costo_laminado,
        creado_por, actualizado_por
      ) VALUES (2, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
      RETURNING idproducto_papel
    `, [
      idcat_tipo_producto_papel,
      descripcion_papel ?? null,
      ancho ?? null, fuelle ?? null, altura ?? null, medida ?? null,
      typeof tamano_asa_default === "string" && tamano_asa_default.trim()
        ? tamano_asa_default.trim()
        : null,
      tamano_prod || null,
      costoLaminadoValidado,
      idusuario,
    ]);

    const idproducto_papel = prodRows[0].idproducto_papel;

    // ── 2. Grupos y materiales ────────────────────────────────────────────
    for (let gi = 0; gi < grupos.length; gi++) {
      const grupo = grupos[gi];

      const { rows: grupoRows } = await client.query(`
        INSERT INTO grupo_papel (idproducto_papel, precio_sugerido, orden, creado_por, actualizado_por)
        VALUES ($1, $2, $3, $4, $4)
        RETURNING idgrupo_papel
      `, [idproducto_papel, grupo.precio_sugerido ?? null, gi + 1, idusuario]);

      const idgrupo_papel = grupoRows[0].idgrupo_papel;

      const materiales = grupo.materiales ?? [];
      for (let mi = 0; mi < materiales.length; mi++) {
        const mat = materiales[mi];
        await client.query(`
          INSERT INTO detalle_material_papel (
            idgrupo_papel,
            idcat_tipo_papel, idcat_calibre,
            pliego, rendimiento, corte,
            hoj_bobina, hoj_corte, hoj_rendimiento, hoj_guillotina, hoj_hilo, hoj_bobina_extra,
            orden, creado_por, actualizado_por
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
        `, [
          idgrupo_papel,
          mat.idcat_tipo_papel ?? null,
          mat.idcat_calibre    ?? null,
          mat.pliego           ?? null,
          mat.rendimiento      ?? null,
          mat.corte            ?? null,
          mat.hojeado?.bobina       ?? null,
          mat.hojeado?.corte        ?? null,
          mat.hojeado?.rendimiento  ?? null,
          mat.hojeado?.guillotina   ?? null,
          mat.hojeado?.hilo         ?? null,
          mat.hojeado?.bobina_extra ?? null,
          mi + 1,
          idusuario,
        ]);
      }
    }

    // ── 3. Suaje ──────────────────────────────────────────────────────────
    if (suaje) {
      await client.query(`
        INSERT INTO suaje_papel (
          idproducto_papel,
          numero, pzs, tamano,
          corte1_tipo, corte1_medida, idcat_corte, idcat_punto_corte,
          dobles1_tipo, dobles1_medida, idcat_doble, idcat_punto_doble,
          metros, idcat_matrix, tiempo_arreglo,
          idcat_sacabocados, cantidad_sacabocado,
          idcat_perforado,   cantidad_perforado,
          herramental_desbarbe, no_desbarbe
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      `, [
        idproducto_papel,
        suaje.numero              ?? null,
        suaje.pzs                 ?? null,
        suaje.tamano              ?? null,
        suaje.corte1_tipo         ?? null,
        suaje.corte1_medida       ?? null,
        suaje.idcat_corte         ?? null,
        suaje.idcat_punto_corte   ?? null,
        suaje.dobles1_tipo        ?? null,
        suaje.dobles1_medida      ?? null,
        suaje.idcat_doble         ?? null,
        suaje.idcat_punto_doble   ?? null,
        suaje.metros              ?? null,
        suaje.idcat_matrix        ?? null,
        suaje.tiempo_arreglo      ?? null,
        suaje.idcat_sacabocados   ?? null,
        suaje.cantidad_sacabocado ?? null,
        suaje.idcat_perforado     ?? null,
        suaje.cantidad_perforado  ?? null,
        suaje.herramental_desbarbe === true,
        suaje.no_desbarbe         ?? null,
      ]);
    }

    // ── 4. Acabados ───────────────────────────────────────────────────────
    if (acabados) {
      const { rows: acabadosRows } = await client.query(`
        INSERT INTO acabados_papel (
          idproducto_papel,
          idcat_tipo_pegado, idcat_pegamento,
          idrollo_lam, desarrollo_laminado,
          idcat_refuerzo_material, idcat_refuerzo_medidas,
          idcat_base_material, base_medida,
          idcat_empaque, pzs_caja
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING idacabados_papel
      `, [
        idproducto_papel,
        acabados.idcat_tipo_pegado       ?? null,
        acabados.idcat_pegamento         ?? null,
        acabados.idrollo_lam         ?? null,
        acabados.desarrollo_laminado     ?? null,
        acabados.idcat_refuerzo_material ?? null,
        acabados.idcat_refuerzo_medidas  ?? null,
        acabados.idcat_base_material     ?? null,
        acabados.base_medida             ?? null,
        acabados.idcat_empaque           ?? null,
        acabados.pzs_caja               ?? null,
      ]);

      const idacabados_papel = acabadosRows[0].idacabados_papel;

      const asas: number[] = acabados.asas ?? [];
      for (const idcat_tipo_asa of asas) {
        await client.query(`
          INSERT INTO acabados_asas (idacabados_papel, idcat_tipo_asa)
          VALUES ($1, $2) ON CONFLICT DO NOTHING
        `, [idacabados_papel, idcat_tipo_asa]);
      }

      await insertarLaminado(client, idacabados_papel, acabados.laminados ?? []);
    }

    // ── 5. Maquinaria ─────────────────────────────────────────────────────
    if (maquinaria) {
      await insertarMaquinaria(client, idproducto_papel, maquinaria);
    }

    await client.query("COMMIT");
    console.log(`✅ Producto papel creado: id=${idproducto_papel}`);
    return res.status(201).json({ message: "Producto registrado correctamente", idproducto_papel });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ POST PRODUCTO PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al registrar el producto", detalle: error.message });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// PUT /productos-papel/:id
// ═══════════════════════════════════════════════════════════════════════════
export const actualizarProductoPapel = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const {
      idcat_tipo_producto_papel,
      descripcion_papel,
      ancho, fuelle, altura, medida,
      tamano_asa_default,
      tamano_prod,
      costo_laminado,
      grupos = [],
      suaje,
      acabados,
      maquinaria,
    } = req.body;

    const idusuario = (req as any).user?.id ?? null;

    // NUEVO: misma lógica que en crearProductoPapel — tamano_prod ya es FK.
    if (tamano_prod != null && tamano_prod !== "" && !Number.isInteger(Number(tamano_prod))) {
      return res.status(400).json({ error: "tamano_prod inválido" });
    }

    const costoLaminadoValidado = costoLaminadoONull(costo_laminado);
    if (
      costo_laminado !== null &&
      costo_laminado !== undefined &&
      costo_laminado !== "" &&
      costoLaminadoValidado === null
    ) {
      return res.status(400).json({ error: "costo_laminado inválido" });
    }

    const { rows: check } = await client.query(
      `SELECT idproducto_papel FROM producto_papel WHERE idproducto_papel = $1 AND activo = true`, [id]
    );
    if (check.length === 0)
      return res.status(404).json({ error: "Producto no encontrado" });

    // ── Validación de duplicados por descripción + medida ──────────────────
    // Misma regla que en creación, pero excluyendo al propio producto que
    // se está editando (si no, siempre "chocaría" consigo mismo).
    const descripcionNorm = typeof descripcion_papel === "string" ? descripcion_papel.trim() : "";
    const medidaNorm = typeof medida === "string" ? medida.trim() : "";
    if (descripcionNorm && medidaNorm) {
      const { rows: dup } = await client.query(
        `SELECT idproducto_papel FROM producto_papel
         WHERE idproductos = 2 AND activo = true
           AND idproducto_papel <> $1
           AND TRIM(LOWER(descripcion_papel)) = TRIM(LOWER($2))
           AND TRIM(LOWER(COALESCE(medida, ''))) = TRIM(LOWER($3))
         LIMIT 1`,
        [id, descripcionNorm, medidaNorm]
      );
      if (dup.length > 0) {
        return res.status(409).json({
          error: "Ya existe otro producto registrado con esa descripción y medida",
          idproducto_papel: dup[0].idproducto_papel,
        });
      }
    }

    await client.query("BEGIN");

    // ── 1. Producto padre ─────────────────────────────────────────────────
    // origen_expo tampoco se toca aquí — una vez marcado (por la creación
    // automática desde Expo) se queda así aunque después se edite a mano
    // desde esta página; solo cambia sus datos, no su origen.
    await client.query(`
      UPDATE producto_papel SET
        idcat_tipo_producto_papel = $1,
        descripcion_papel = $2,
        ancho = $3, fuelle = $4, altura = $5, medida = $6,
        tamano_asa_default = $7,
        tamano_prod = $8,
        costo_laminado = $9,
        actualizado_por = $10,
        updated_at = NOW()
      WHERE idproducto_papel = $11
    `, [
      idcat_tipo_producto_papel,
      descripcion_papel ?? null,
      ancho ?? null, fuelle ?? null, altura ?? null, medida ?? null,
      typeof tamano_asa_default === "string" && tamano_asa_default.trim()
        ? tamano_asa_default.trim()
        : null,
      tamano_prod || null,
      costoLaminadoValidado,
      idusuario, id,
    ]);

    // ── 2. Grupos y materiales ────────────────────────────────────────────
    await client.query(`DELETE FROM grupo_papel WHERE idproducto_papel = $1`, [id]);

    for (let gi = 0; gi < grupos.length; gi++) {
      const grupo = grupos[gi];

      const { rows: grupoRows } = await client.query(`
        INSERT INTO grupo_papel (idproducto_papel, precio_sugerido, orden, creado_por, actualizado_por)
        VALUES ($1, $2, $3, $4, $4)
        RETURNING idgrupo_papel
      `, [id, grupo.precio_sugerido ?? null, gi + 1, idusuario]);

      const idgrupo_papel = grupoRows[0].idgrupo_papel;

      const materiales = grupo.materiales ?? [];
      for (let mi = 0; mi < materiales.length; mi++) {
        const mat = materiales[mi];
        await client.query(`
          INSERT INTO detalle_material_papel (
            idgrupo_papel,
            idcat_tipo_papel, idcat_calibre,
            pliego, rendimiento, corte,
            hoj_bobina, hoj_corte, hoj_rendimiento, hoj_guillotina, hoj_hilo, hoj_bobina_extra,
            orden, creado_por, actualizado_por
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
        `, [
          idgrupo_papel,
          mat.idcat_tipo_papel ?? null,
          mat.idcat_calibre    ?? null,
          mat.pliego           ?? null,
          mat.rendimiento      ?? null,
          mat.corte            ?? null,
          mat.hojeado?.bobina       ?? null,
          mat.hojeado?.corte        ?? null,
          mat.hojeado?.rendimiento  ?? null,
          mat.hojeado?.guillotina   ?? null,
          mat.hojeado?.hilo         ?? null,
          mat.hojeado?.bobina_extra ?? null,
          mi + 1,
          idusuario,
        ]);
      }
    }

    // ── 3. Suaje — upsert ─────────────────────────────────────────────────
    if (suaje) {
      const { rows: suajeCheck } = await client.query(
        `SELECT idsuaje_papel FROM suaje_papel WHERE idproducto_papel = $1`, [id]
      );

      if (suajeCheck.length > 0) {
        await client.query(`
          UPDATE suaje_papel SET
            numero = $1, pzs = $2, tamano = $3,
            corte1_tipo = $4, corte1_medida = $5, idcat_corte = $6, idcat_punto_corte = $7,
            dobles1_tipo = $8, dobles1_medida = $9, idcat_doble = $10, idcat_punto_doble = $11,
            metros = $12, idcat_matrix = $13, tiempo_arreglo = $14,
            idcat_sacabocados = $15, cantidad_sacabocado = $16,
            idcat_perforado   = $17, cantidad_perforado  = $18,
            herramental_desbarbe = $19, no_desbarbe = $20
          WHERE idproducto_papel = $21
        `, [
          suaje.numero              ?? null,
          suaje.pzs                 ?? null,
          suaje.tamano              ?? null,
          suaje.corte1_tipo         ?? null,
          suaje.corte1_medida       ?? null,
          suaje.idcat_corte         ?? null,
          suaje.idcat_punto_corte   ?? null,
          suaje.dobles1_tipo        ?? null,
          suaje.dobles1_medida      ?? null,
          suaje.idcat_doble         ?? null,
          suaje.idcat_punto_doble   ?? null,
          suaje.metros              ?? null,
          suaje.idcat_matrix        ?? null,
          suaje.tiempo_arreglo      ?? null,
          suaje.idcat_sacabocados   ?? null,
          suaje.cantidad_sacabocado ?? null,
          suaje.idcat_perforado     ?? null,
          suaje.cantidad_perforado  ?? null,
          suaje.herramental_desbarbe === true,
          suaje.no_desbarbe         ?? null,
          id,
        ]);
      } else {
        await client.query(`
          INSERT INTO suaje_papel (
            idproducto_papel,
            numero, pzs, tamano,
            corte1_tipo, corte1_medida, idcat_corte, idcat_punto_corte,
            dobles1_tipo, dobles1_medida, idcat_doble, idcat_punto_doble,
            metros, idcat_matrix, tiempo_arreglo,
            idcat_sacabocados, cantidad_sacabocado,
            idcat_perforado,   cantidad_perforado,
            herramental_desbarbe, no_desbarbe
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        `, [
          id,
          suaje.numero              ?? null,
          suaje.pzs                 ?? null,
          suaje.tamano              ?? null,
          suaje.corte1_tipo         ?? null,
          suaje.corte1_medida       ?? null,
          suaje.idcat_corte         ?? null,
          suaje.idcat_punto_corte   ?? null,
          suaje.dobles1_tipo        ?? null,
          suaje.dobles1_medida      ?? null,
          suaje.idcat_doble         ?? null,
          suaje.idcat_punto_doble   ?? null,
          suaje.metros              ?? null,
          suaje.idcat_matrix        ?? null,
          suaje.tiempo_arreglo      ?? null,
          suaje.idcat_sacabocados   ?? null,
          suaje.cantidad_sacabocado ?? null,
          suaje.idcat_perforado     ?? null,
          suaje.cantidad_perforado  ?? null,
          suaje.herramental_desbarbe === true,
          suaje.no_desbarbe         ?? null,
        ]);
      }
    }

    // ── 4. Acabados — upsert ──────────────────────────────────────────────
    if (acabados) {
      const { rows: acabadosCheck } = await client.query(
        `SELECT idacabados_papel FROM acabados_papel WHERE idproducto_papel = $1`, [id]
      );

      let idacabados_papel: number;

      if (acabadosCheck.length > 0) {
        idacabados_papel = acabadosCheck[0].idacabados_papel;
        await client.query(`
          UPDATE acabados_papel SET
            idcat_tipo_pegado = $1, idcat_pegamento = $2,
            idrollo_lam = $3, desarrollo_laminado = $4,
            idcat_refuerzo_material = $5, idcat_refuerzo_medidas = $6,
            idcat_base_material = $7, base_medida = $8,
            idcat_empaque = $9, pzs_caja = $10
          WHERE idacabados_papel = $11
        `, [
          acabados.idcat_tipo_pegado       ?? null,
          acabados.idcat_pegamento         ?? null,
          acabados.idrollo_lam         ?? null,
          acabados.desarrollo_laminado     ?? null,
          acabados.idcat_refuerzo_material ?? null,
          acabados.idcat_refuerzo_medidas  ?? null,
          acabados.idcat_base_material     ?? null,
          acabados.base_medida             ?? null,
          acabados.idcat_empaque           ?? null,
          acabados.pzs_caja               ?? null,
          idacabados_papel,
        ]);
      } else {
        const { rows: newAcabados } = await client.query(`
          INSERT INTO acabados_papel (
            idproducto_papel,
            idcat_tipo_pegado, idcat_pegamento,
            idrollo_lam, desarrollo_laminado,
            idcat_refuerzo_material, idcat_refuerzo_medidas,
            idcat_base_material, base_medida,
            idcat_empaque, pzs_caja
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          RETURNING idacabados_papel
        `, [
          id,
          acabados.idcat_tipo_pegado       ?? null,
          acabados.idcat_pegamento         ?? null,
          acabados.idrollo_lam         ?? null,
          acabados.desarrollo_laminado     ?? null,
          acabados.idcat_refuerzo_material ?? null,
          acabados.idcat_refuerzo_medidas  ?? null,
          acabados.idcat_base_material     ?? null,
          acabados.base_medida             ?? null,
          acabados.idcat_empaque           ?? null,
          acabados.pzs_caja               ?? null,
        ]);
        idacabados_papel = newAcabados[0].idacabados_papel;
      }

      await client.query(`DELETE FROM acabados_asas WHERE idacabados_papel = $1`, [idacabados_papel]);
      const asas: number[] = acabados.asas ?? [];
      for (const idcat_tipo_asa of asas) {
        await client.query(`
          INSERT INTO acabados_asas (idacabados_papel, idcat_tipo_asa)
          VALUES ($1, $2) ON CONFLICT DO NOTHING
        `, [idacabados_papel, idcat_tipo_asa]);
      }

      await client.query(`DELETE FROM acabados_laminado WHERE idacabados_papel = $1`, [idacabados_papel]);
      await insertarLaminado(client, idacabados_papel, acabados.laminados ?? []);
    }

    // ── 5. Maquinaria ─────────────────────────────────────────────────────
    if (maquinaria) {
      await eliminarMaquinaria(client, Number(id));
      await insertarMaquinaria(client, Number(id), maquinaria);
    }

    // ── 6. Reflejar el cambio en Catálogo Expo si algún registro apunta a
    // este mismo producto (idproducto_papel) ────────────────────────────────
    // Esta dirección (Sistema → Expo) es distinta a la de Expo → Sistema:
    // aquí no hace falta el checkeo de "uso externo" porque el Sistema es la
    // fuente de verdad — Expo solo es un catálogo secundario que debe
    // reflejar la realidad, así que siempre se actualiza si hay un vínculo.
    const { rows: primerMaterial } = await client.query(`
      SELECT ctp.nombre AS material, cc.nombre AS calibre
      FROM detalle_material_papel dmp
      JOIN grupo_papel gp ON gp.idgrupo_papel = dmp.idgrupo_papel
      LEFT JOIN cat_tipo_papel ctp ON ctp.idcat_tipo_papel = dmp.idcat_tipo_papel
      LEFT JOIN cat_calibre cc ON cc.idcat_calibre = dmp.idcat_calibre
      WHERE gp.idproducto_papel = $1
      ORDER BY gp.orden ASC, dmp.orden ASC LIMIT 1`, [id]);
    const materialSync = primerMaterial[0]?.material ?? null;
    const calibreSync = primerMaterial[0]?.calibre ?? null;

    await client.query(
      `UPDATE catalogo_expo SET
         medida = COALESCE($1, medida),
         material = COALESCE($2, material),
         calibre = COALESCE($3, calibre)
       WHERE idproducto_papel = $4 AND activo = true`,
      [medida || null, materialSync, calibreSync, id]
    );

    await client.query("COMMIT");
    console.log(`✅ Producto papel actualizado: id=${id}`);
    return res.json({ message: "Producto actualizado correctamente" });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ PUT PRODUCTO PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al actualizar el producto", detalle: error.message });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /productos-papel/:id/costo-base
// ═══════════════════════════════════════════════════════════════════════════
// Actualización rápida del costo base (precio_sugerido) de uno o varios
// grupos de un producto, SIN pasar por el formulario completo de edición.
// Se usa desde el botón "Costo base" en la tabla de Papel.tsx: permite
// registrar el costo por primera vez (si quedó vacío al dar de alta) o
// corregirlo después, sin tocar materiales, suaje, acabados ni maquinaria.
// Un producto puede tener 1 o N grupos (opciones de material), cada uno con
// su propio costo — por eso el body acepta un arreglo de grupos.
export const actualizarCostoBaseGrupos = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { grupos } = req.body as {
      grupos: { idgrupo_papel: number; precio_sugerido: number | string | null }[];
    };

    if (!Array.isArray(grupos) || grupos.length === 0) {
      return res.status(400).json({ error: "Se requiere al menos un grupo" });
    }

    const idusuario = (req as any).user?.id ?? null;

    await client.query("BEGIN");

    // Confirma que el producto exista y esté activo antes de tocar sus grupos.
    const { rows: prodRows } = await client.query(
      `SELECT idproducto_papel FROM producto_papel WHERE idproducto_papel = $1 AND activo = true`,
      [id]
    );
    if (prodRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    const actualizados: { idgrupo_papel: number; precio_sugerido: number | null }[] = [];

    for (const g of grupos) {
      if (!g.idgrupo_papel) continue;

      const precio =
        g.precio_sugerido === null || g.precio_sugerido === undefined || g.precio_sugerido === ""
          ? null
          : Number(g.precio_sugerido);

      if (precio !== null && (!Number.isFinite(precio) || precio < 0)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Costo inválido para el grupo ${g.idgrupo_papel}` });
      }

      // El WHERE idproducto_papel = $4 evita que, por error, se actualice un
      // grupo que en realidad pertenece a otro producto.
      const { rows } = await client.query(
        `UPDATE grupo_papel
         SET precio_sugerido = $1, actualizado_por = $2
         WHERE idgrupo_papel = $3 AND idproducto_papel = $4
         RETURNING idgrupo_papel, precio_sugerido`,
        [precio, idusuario, g.idgrupo_papel, id]
      );

      if (rows.length > 0) actualizados.push(rows[0]);
    }

    await client.query("COMMIT");
    console.log(`✅ Costo base actualizado: producto=${id}, grupos=${actualizados.length}`);
    return res.json({ message: "Costo base actualizado correctamente", grupos: actualizados });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ PATCH COSTO BASE PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al actualizar el costo base", detalle: error.message });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /productos-papel/:id/costo-laminado
// ═══════════════════════════════════════════════════════════════════════════
// Actualización rápida del costo de laminado, SIN pasar por el formulario
// completo. A diferencia del costo base (un solo número), aquí se tocan 3
// campos que alimentan la fórmula (ver costoLaminado.utils.ts en el
// frontend): idrollo_lam y desarrollo_laminado (en acabados_papel) y pzs
// (en suaje_papel) — más el resultado ya calculado, que se guarda en
// producto_papel.costo_laminado igual que hace actualizarProductoPapel
// (el backend no recalcula, solo valida).
//
// IMPORTANTE: acabados_papel y suaje_papel tienen muchas otras columnas
// (pegamento, refuerzo, empaque, corte, dobles, etc.) que este endpoint NO
// debe tocar — por eso los UPDATE de abajo solo mencionan las columnas que
// nos interesan, a diferencia del upsert completo de actualizarProductoPapel.
export const actualizarCostoLaminado = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { idrollo_lam, desarrollo_laminado, piezas_suaje, costo_laminado } = req.body as {
      idrollo_lam?: number | string | null;
      desarrollo_laminado?: number | string | null;
      piezas_suaje?: number | string | null;
      costo_laminado?: number | string | null;
    };

    const idusuario = (req as any).user?.id ?? null;

    const costoLaminadoValidado = costoLaminadoONull(costo_laminado);
    if (
      costo_laminado !== null && costo_laminado !== undefined && costo_laminado !== "" &&
      costoLaminadoValidado === null
    ) {
      return res.status(400).json({ error: "costo_laminado inválido" });
    }

    const desarrolloValidado =
      desarrollo_laminado === null || desarrollo_laminado === undefined || desarrollo_laminado === ""
        ? null
        : Number(desarrollo_laminado);
    if (desarrolloValidado !== null && (!Number.isFinite(desarrolloValidado) || desarrolloValidado < 0)) {
      return res.status(400).json({ error: "desarrollo_laminado inválido" });
    }

    await client.query("BEGIN");

    const { rows: prodRows } = await client.query(
      `SELECT idproducto_papel FROM producto_papel WHERE idproducto_papel = $1 AND activo = true`,
      [id]
    );
    if (prodRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    // ── 1. producto_papel.costo_laminado ──────────────────────────────────
    await client.query(
      `UPDATE producto_papel SET costo_laminado = $1, actualizado_por = $2 WHERE idproducto_papel = $3`,
      [costoLaminadoValidado, idusuario, id]
    );

    // ── 2. acabados_papel: idrollo_lam / desarrollo_laminado (parcial) ────
    const { rows: acabadosCheck } = await client.query(
      `SELECT idacabados_papel FROM acabados_papel WHERE idproducto_papel = $1`, [id]
    );
    if (acabadosCheck.length > 0) {
      await client.query(
        `UPDATE acabados_papel SET idrollo_lam = $1, desarrollo_laminado = $2 WHERE idacabados_papel = $3`,
        [idrollo_lam ?? null, desarrolloValidado, acabadosCheck[0].idacabados_papel]
      );
    } else {
      await client.query(
        `INSERT INTO acabados_papel (idproducto_papel, idrollo_lam, desarrollo_laminado) VALUES ($1, $2, $3)`,
        [id, idrollo_lam ?? null, desarrolloValidado]
      );
    }

    // ── 3. suaje_papel.pzs (parcial) ──────────────────────────────────────
    const { rows: suajeCheck } = await client.query(
      `SELECT idsuaje_papel FROM suaje_papel WHERE idproducto_papel = $1`, [id]
    );
    if (suajeCheck.length > 0) {
      await client.query(
        `UPDATE suaje_papel SET pzs = $1 WHERE idsuaje_papel = $2`,
        [piezas_suaje ?? null, suajeCheck[0].idsuaje_papel]
      );
    } else {
      // herramental_desbarbe se manda explícito en false porque, igual que
      // en crearProductoPapel, la columna no admite NULL.
      await client.query(
        `INSERT INTO suaje_papel (idproducto_papel, pzs, herramental_desbarbe) VALUES ($1, $2, false)`,
        [id, piezas_suaje ?? null]
      );
    }

    await client.query("COMMIT");
    console.log(`✅ Costo laminado actualizado: producto=${id}`);
    return res.json({
      message: "Costo de laminado actualizado correctamente",
      costo_laminado: costoLaminadoValidado,
      idrollo_lam: idrollo_lam ?? null,
      desarrollo_laminado: desarrolloValidado,
      piezas_suaje: piezas_suaje ?? null,
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ PATCH COSTO LAMINADO PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al actualizar el costo de laminado", detalle: error.message });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /productos-papel/en-blanco-expo
// ═══════════════════════════════════════════════════════════════════════════
// Registro relajado — a diferencia de crearProductoPapel (el alta normal de
// la página de Papel), aquí NO se exige idcat_tipo_producto_papel ni ningún
// otro campo. Se usa cuando alguien cotiza en Expo un producto que no existe
// todavía: se guarda lo que sí se tiene (nombre, medida si acaso) y el resto
// queda en null, marcado con origen_expo=true — la idea es completarlo
// después, cuando esa cotización se convierta en pedido real.
export const registrarProductoPapelEnBlancoExpo = async (req: Request, res: Response) => {
  try {
    const { nombre, categoria, medida, material, calibre, tipo_producto, altura, ancho, fuelle,
      precio_500, precio_1000, precio_3000 } = req.body;

    if (!nombre?.trim())
      return res.status(400).json({ error: "El nombre es requerido" });

    const idproductos = categoria === "carton" ? 3 : 2;
    const idusuario = (req as any).user?.id ?? null;
    const num = (v: any) => (v != null && v !== "") ? Number(v) : null;

    let idcatTipoProductoPapel: number | null = null;
    if (tipo_producto) {
      const { rows: tpRows } = await pool.query(
        `SELECT idcat_tipo_producto_papel FROM cat_tipo_producto_papel WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
        [`%${String(tipo_producto).toLowerCase()}%`]
      );
      idcatTipoProductoPapel = tpRows[0]?.idcat_tipo_producto_papel ?? null;
    }

    const { rows: ppRows } = await pool.query(`
      INSERT INTO producto_papel (
        idproductos, idcat_tipo_producto_papel, descripcion_papel,
        ancho, fuelle, altura, medida, precio_500, precio_1000, precio_3000,
        activo, origen_expo, creado_por, actualizado_por
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,true,$11,$11)
      RETURNING idproducto_papel`,
      [idproductos, idcatTipoProductoPapel, nombre.trim(),
       ancho || null, fuelle || null, altura || null, medida || null,
       num(precio_500), num(precio_1000), num(precio_3000), idusuario]
    );
    const idproducto_papel = ppRows[0].idproducto_papel;

    // Si ya viene material/calibre (aunque sea parcial), se guarda de una
    // vez en el primer grupo — si no, se completa después al editar.
    if (material || calibre) {
      let idcatTipoPapel: number | null = null;
      if (material) {
        const { rows } = await pool.query(
          `SELECT idcat_tipo_papel FROM cat_tipo_papel WHERE LOWER(nombre) = LOWER($1) LIMIT 1`, [material]
        );
        idcatTipoPapel = rows[0]?.idcat_tipo_papel ?? null;
      }
      let idcatCalibre: number | null = null;
      if (calibre) {
        const { rows } = await pool.query(
          `SELECT idcat_calibre FROM cat_calibre WHERE LOWER(nombre) = LOWER($1) LIMIT 1`, [calibre]
        );
        idcatCalibre = rows[0]?.idcat_calibre ?? null;
      }
      if (idcatTipoPapel || idcatCalibre) {
        const { rows: gpRows } = await pool.query(
          `INSERT INTO grupo_papel (idproducto_papel, precio_sugerido, orden) VALUES ($1,NULL,1) RETURNING idgrupo_papel`,
          [idproducto_papel]
        );
        await pool.query(
          `INSERT INTO detalle_material_papel (idgrupo_papel, idcat_tipo_papel, idcat_calibre, orden) VALUES ($1,$2,$3,1)`,
          [gpRows[0].idgrupo_papel, idcatTipoPapel, idcatCalibre]
        );
      }
    }

    console.log(`✅ Producto papel EN BLANCO (Expo) creado: id=${idproducto_papel}`);
    return res.status(201).json({ idproducto_papel });
  } catch (error: any) {
    console.error("❌ REGISTRAR PRODUCTO PAPEL EN BLANCO (Expo) ERROR:", error.message);
    return res.status(500).json({ error: "Error al registrar el producto" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /productos-papel/:id
// ═══════════════════════════════════════════════════════════════════════════
export const eliminarProductoPapel = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query("BEGIN");

    const { rows } = await client.query(
      `UPDATE producto_papel SET activo = false, updated_at = NOW()
       WHERE idproducto_papel = $1 AND activo = true
       RETURNING idproducto_papel`,
      [id]
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    // Si el producto ya no existe en el sistema, cualquier registro de
    // Catálogo Expo que lo usaba queda obsoleto — se desactiva también,
    // sin checkeo de "uso externo" (esa protección aplica al sentido
    // contrario, Expo → Sistema, no aquí).
    await client.query(
      `UPDATE catalogo_expo SET activo = false WHERE idproducto_papel = $1 AND activo = true`,
      [id]
    );

    await client.query("COMMIT");
    console.log(`✅ Producto papel eliminado: id=${id}`);
    return res.json({ message: "Producto eliminado correctamente" });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ DELETE PRODUCTO PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al eliminar el producto" });
  } finally {
    client.release();
  }
};