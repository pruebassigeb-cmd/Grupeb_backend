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
        pp.descripcion_papel,
        pp.activo,
        pp.created_at,
        tp.nombre                        AS tipo_producto,
        u.nombre || ' ' || u.apellido    AS creado_por,

        -- Tipos de papel y calibres de todos los grupos (separados por " / ")
        mat_preview.primer_tipo_papel,
        mat_preview.primer_calibre,
        mat_preview.primer_pliego,

        -- Archivos para vista previa en la tabla
        arch_prev.archivos_raw

      FROM producto_papel pp
      LEFT JOIN cat_tipo_producto_papel tp ON tp.idcat_tipo_producto_papel = pp.idcat_tipo_producto_papel
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
        u.nombre  || ' ' || u.apellido AS creado_por_nombre
      FROM producto_papel pp
      LEFT JOIN cat_tipo_producto_papel tp ON tp.idcat_tipo_producto_papel = pp.idcat_tipo_producto_papel
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
        rm.nombre   AS refuerzo_material,
        rmed.nombre AS refuerzo_medida,
        bm.nombre   AS base_material,
        em.nombre   AS empaque
      FROM acabados_papel a
      LEFT JOIN cat_tipo_pegado       tp   ON tp.idcat_tipo_pegado       = a.idcat_tipo_pegado
      LEFT JOIN cat_pegamento         pg   ON pg.idcat_pegamento         = a.idcat_pegamento
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
      grupos = [],
      suaje,
      acabados,
      maquinaria,
    } = req.body;

    const idusuario = (req as any).user?.id ?? null;

    if (!idcat_tipo_producto_papel)
      return res.status(400).json({ error: "El tipo de producto es requerido" });

    // Validación del desplegable fijo — evita guardar basura si llega algo
    // fuera de las 5 opciones (por bug de frontend o llamada directa a la API).
    const TAMANOS_VALIDOS = ["Mini", "Chico", "Mediano", "Grande", "Extragrande"];
    if (tamano_prod != null && tamano_prod !== "" && !TAMANOS_VALIDOS.includes(tamano_prod)) {
      return res.status(400).json({ error: "tamano_prod inválido" });
    }

    await client.query("BEGIN");

    // ── 1. Producto padre ─────────────────────────────────────────────────
    const { rows: prodRows } = await client.query(`
      INSERT INTO producto_papel (
        idproductos, idcat_tipo_producto_papel,
        descripcion_papel, ancho, fuelle, altura, medida, tamano_asa_default,
        tamano_prod,
        creado_por, actualizado_por
      ) VALUES (2, $1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
      RETURNING idproducto_papel
    `, [
      idcat_tipo_producto_papel,
      descripcion_papel ?? null,
      ancho ?? null, fuelle ?? null, altura ?? null, medida ?? null,
      typeof tamano_asa_default === "string" && tamano_asa_default.trim()
        ? tamano_asa_default.trim()
        : null,
      tamano_prod || null,
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
          idcat_refuerzo_material, idcat_refuerzo_medidas,
          idcat_base_material, base_medida,
          idcat_empaque, pzs_caja
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING idacabados_papel
      `, [
        idproducto_papel,
        acabados.idcat_tipo_pegado       ?? null,
        acabados.idcat_pegamento         ?? null,
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
      grupos = [],
      suaje,
      acabados,
      maquinaria,
    } = req.body;

    const idusuario = (req as any).user?.id ?? null;

    // Validación del desplegable fijo, misma lógica que en creación.
    const TAMANOS_VALIDOS = ["Mini", "Chico", "Mediano", "Grande", "Extragrande"];
    if (tamano_prod != null && tamano_prod !== "" && !TAMANOS_VALIDOS.includes(tamano_prod)) {
      return res.status(400).json({ error: "tamano_prod inválido" });
    }

    const { rows: check } = await client.query(
      `SELECT idproducto_papel FROM producto_papel WHERE idproducto_papel = $1 AND activo = true`, [id]
    );
    if (check.length === 0)
      return res.status(404).json({ error: "Producto no encontrado" });

    await client.query("BEGIN");

    // ── 1. Producto padre ─────────────────────────────────────────────────
    await client.query(`
      UPDATE producto_papel SET
        idcat_tipo_producto_papel = $1,
        descripcion_papel = $2,
        ancho = $3, fuelle = $4, altura = $5, medida = $6,
        tamano_asa_default = $7,
        tamano_prod = $8,
        actualizado_por = $9,
        updated_at = NOW()
      WHERE idproducto_papel = $10
    `, [
      idcat_tipo_producto_papel,
      descripcion_papel ?? null,
      ancho ?? null, fuelle ?? null, altura ?? null, medida ?? null,
      typeof tamano_asa_default === "string" && tamano_asa_default.trim()
        ? tamano_asa_default.trim()
        : null,
      tamano_prod || null,
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
            idcat_refuerzo_material = $3, idcat_refuerzo_medidas = $4,
            idcat_base_material = $5, base_medida = $6,
            idcat_empaque = $7, pzs_caja = $8
          WHERE idacabados_papel = $9
        `, [
          acabados.idcat_tipo_pegado       ?? null,
          acabados.idcat_pegamento         ?? null,
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
            idcat_refuerzo_material, idcat_refuerzo_medidas,
            idcat_base_material, base_medida,
            idcat_empaque, pzs_caja
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING idacabados_papel
        `, [
          id,
          acabados.idcat_tipo_pegado       ?? null,
          acabados.idcat_pegamento         ?? null,
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
// DELETE /productos-papel/:id
// ═══════════════════════════════════════════════════════════════════════════
export const eliminarProductoPapel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      `UPDATE producto_papel SET activo = false, updated_at = NOW()
       WHERE idproducto_papel = $1 AND activo = true
       RETURNING idproducto_papel`,
      [id]
    );

    if (rows.length === 0)
      return res.status(404).json({ error: "Producto no encontrado" });

    console.log(`✅ Producto papel eliminado: id=${id}`);
    return res.json({ message: "Producto eliminado correctamente" });

  } catch (error: any) {
    console.error("❌ DELETE PRODUCTO PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al eliminar el producto" });
  }
};