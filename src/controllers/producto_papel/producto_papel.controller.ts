import { Request, Response } from "express";
import { pool } from "../../config/db";
import { getPresignedUrl } from "../../config/multer";

// ═══════════════════════════════════════════════════════════════════════════
// GET /productos-papel
// Lista todos los productos de papel con info básica
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
        pp.activo,
        pp.created_at,
        tp.nombre              AS tipo_producto,
        u.nombre  || ' ' || u.apellido AS creado_por
      FROM producto_papel pp
      LEFT JOIN cat_tipo_producto_papel tp ON tp.idcat_tipo_producto_papel = pp.idcat_tipo_producto_papel
      LEFT JOIN usuarios u ON u.idusuario = pp.creado_por
      WHERE pp.activo = true
      ORDER BY pp.idproducto_papel DESC
    `);

    console.log(`✅ Productos papel obtenidos: ${rows.length}`);
    return res.json(rows);

  } catch (error: any) {
    console.error("❌ GET PRODUCTOS PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener productos de papel" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /productos-papel/:id
// Detalle completo de un producto con grupos, materiales, suaje, acabados y maquinaria
// ═══════════════════════════════════════════════════════════════════════════
export const getProductoPapelById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // ── Producto base ─────────────────────────────────────────────────────
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

    const producto = prodRows[0];

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

    // Agrupar materiales por grupo
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
        pe.medida  AS perforado_medida
      FROM suaje_papel s
      LEFT JOIN cat_sacabocados sc ON sc.idcat_sacabocados = s.idcat_sacabocados
      LEFT JOIN cat_perforado   pe ON pe.idcat_perforado   = s.idcat_perforado
      WHERE s.idproducto_papel = $1
    `, [id]);
    producto.suaje = suajeRows[0] ?? null;

    // ── Acabados ──────────────────────────────────────────────────────────
    const { rows: acabadosRows } = await pool.query(`
      SELECT
        a.*,
        tp.nombre  AS tipo_pegado,
        pg.nombre  AS pegamento,
        lm.nombre  AS laminado,
        rm.nombre  AS refuerzo_material,
        rmed.nombre AS refuerzo_medida,
        bm.nombre  AS base_material,
        em.nombre  AS empaque
      FROM acabados_papel a
      LEFT JOIN cat_tipo_pegado       tp   ON tp.idcat_tipo_pegado      = a.idcat_tipo_pegado
      LEFT JOIN cat_pegamento         pg   ON pg.idcat_pegamento        = a.idcat_pegamento
      LEFT JOIN cat_laminado          lm   ON lm.idcat_laminado         = a.idcat_laminado
      LEFT JOIN cat_refuerzo_material rm   ON rm.idcat_refuerzo_material = a.idcat_refuerzo_material
      LEFT JOIN cat_refuerzo_medidas  rmed ON rmed.idcat_refuerzo_medidas = a.idcat_refuerzo_medidas
      LEFT JOIN cat_refuerzo_material bm   ON bm.idcat_refuerzo_material = a.idcat_base_material
      LEFT JOIN cat_empaque           em   ON em.idcat_empaque          = a.idcat_empaque
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

      acabados.asas = asasRows;
      producto.acabados = acabados;
    } else {
      producto.acabados = null;
    }

    // ── Maquinaria ────────────────────────────────────────────────────────
    const { rows: maqRows } = await pool.query(`
      SELECT
        m.*,
        hg.nombre  AS hojeado_guillotina,
        imp.nombre AS impresora,
        hs.nombre  AS hs_ar,
        sm.nombre  AS suaje_maquina,
        uv.nombre  AS uv,
        tx.nombre  AS textura,
        em.nombre  AS empalme,
        ar.nombre  AS armado,
        am.nombre  AS asas_maquina,
        db.nombre  AS desbarbe
      FROM maquinaria_papel m
      LEFT JOIN cat_hojeado_guillotina hg  ON hg.idcat_hojeado_guillotina  = m.idcat_hojeado_guillotina
      LEFT JOIN cat_impresora         imp  ON imp.idcat_impresora          = m.idcat_impresora
      LEFT JOIN cat_hs_ar             hs   ON hs.idcat_hs_ar               = m.idcat_hs_ar
      LEFT JOIN cat_suaje_maquina     sm   ON sm.idcat_suaje_maquina       = m.idcat_suaje_maquina
      LEFT JOIN cat_uv                uv   ON uv.idcat_uv                  = m.idcat_uv
      LEFT JOIN cat_textura           tx   ON tx.idcat_textura             = m.idcat_textura
      LEFT JOIN cat_empalme           em   ON em.idcat_empalme             = m.idcat_empalme
      LEFT JOIN cat_armado            ar   ON ar.idcat_armado              = m.idcat_armado
      LEFT JOIN cat_asas_maquina      am   ON am.idcat_asas_maquina        = m.idcat_asas_maquina
      LEFT JOIN cat_desbarbe          db   ON db.idcat_desbarbe            = m.idcat_desbarbe
      WHERE m.idproducto_papel = $1
    `, [id]);
    producto.maquinaria = maqRows[0] ?? null;

    // ── Archivos (con presigned URLs) ─────────────────────────────────────
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
// Crear un producto completo con grupos, materiales, suaje, acabados y maquinaria
// ═══════════════════════════════════════════════════════════════════════════
export const crearProductoPapel = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const {
      idcat_tipo_producto_papel,
      ancho, fuelle, altura, medida,
      grupos = [],
      suaje,
      acabados,
      maquinaria,
    } = req.body;

    const idusuario = (req as any).user?.idusuario ?? null;

    if (!idcat_tipo_producto_papel)
      return res.status(400).json({ error: "El tipo de producto es requerido" });

    await client.query("BEGIN");

    // ── 1. Insertar producto padre ────────────────────────────────────────
    const { rows: prodRows } = await client.query(`
      INSERT INTO producto_papel (
        idproductos, idcat_tipo_producto_papel,
        ancho, fuelle, altura, medida,
        creado_por, actualizado_por
      ) VALUES (2, $1, $2, $3, $4, $5, $6, $6)
      RETURNING idproducto_papel
    `, [
      idcat_tipo_producto_papel,
      ancho ?? null, fuelle ?? null, altura ?? null, medida ?? null,
      idusuario,
    ]);

    const idproducto_papel = prodRows[0].idproducto_papel;

    // ── 2. Insertar grupos y materiales ───────────────────────────────────
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
            hoj_bobina, hoj_corte, hoj_rendimiento, hoj_guillotina, hoj_hilo,
            orden, creado_por, actualizado_por
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
        `, [
          idgrupo_papel,
          mat.idcat_tipo_papel ?? null,
          mat.idcat_calibre    ?? null,
          mat.pliego           ?? null,
          mat.rendimiento      ?? null,
          mat.corte            ?? null,
          mat.hojeado?.bobina      ?? null,
          mat.hojeado?.corte       ?? null,
          mat.hojeado?.rendimiento ?? null,
          mat.hojeado?.guillotina  ?? null,
          mat.hojeado?.hilo        ?? null,
          mi + 1,
          idusuario,
        ]);
      }
    }

    // ── 3. Insertar suaje ─────────────────────────────────────────────────
    if (suaje) {
      await client.query(`
        INSERT INTO suaje_papel (
          idproducto_papel,
          numero, pzs, tamano,
          corte1_tipo, corte1_medida,
          dobles1_tipo, dobles1_medida,
          metros, matrix, tiempo_arreglo,
          idcat_sacabocados, cantidad_sacabocado,
          idcat_perforado,   cantidad_perforado
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `, [
        idproducto_papel,
        suaje.numero          ?? null,
        suaje.pzs             ?? null,
        suaje.tamano          ?? null,
        suaje.corte1_tipo     ?? null,
        suaje.corte1_medida   ?? null,
        suaje.dobles1_tipo    ?? null,
        suaje.dobles1_medida  ?? null,
        suaje.metros          ?? null,
        suaje.matrix          ?? null,
        suaje.tiempo_arreglo  ?? null,
        suaje.idcat_sacabocados    ?? null,
        suaje.cantidad_sacabocado  ?? null,
        suaje.idcat_perforado      ?? null,
        suaje.cantidad_perforado   ?? null,
      ]);
    }

    // ── 4. Insertar acabados ──────────────────────────────────────────────
    if (acabados) {
      const { rows: acabadosRows } = await client.query(`
        INSERT INTO acabados_papel (
          idproducto_papel,
          idcat_tipo_pegado, idcat_pegamento, idcat_laminado,
          idcat_refuerzo_material, idcat_refuerzo_medidas,
          idcat_base_material, base_medida,
          idcat_empaque, pzs_caja
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING idacabados_papel
      `, [
        idproducto_papel,
        acabados.idcat_tipo_pegado       ?? null,
        acabados.idcat_pegamento         ?? null,
        acabados.idcat_laminado          ?? null,
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
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `, [idacabados_papel, idcat_tipo_asa]);
      }
    }

    // ── 5. Insertar maquinaria ────────────────────────────────────────────
    if (maquinaria) {
      await client.query(`
        INSERT INTO maquinaria_papel (
          idproducto_papel,
          idcat_hojeado_guillotina, idcat_impresora, idcat_hs_ar,
          idcat_suaje_maquina, idcat_uv, idcat_textura,
          idcat_empalme, idcat_armado, idcat_asas_maquina, idcat_desbarbe
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [
        idproducto_papel,
        maquinaria.idcat_hojeado_guillotina ?? null,
        maquinaria.idcat_impresora          ?? null,
        maquinaria.idcat_hs_ar              ?? null,
        maquinaria.idcat_suaje_maquina      ?? null,
        maquinaria.idcat_uv                 ?? null,
        maquinaria.idcat_textura            ?? null,
        maquinaria.idcat_empalme            ?? null,
        maquinaria.idcat_armado             ?? null,
        maquinaria.idcat_asas_maquina       ?? null,
        maquinaria.idcat_desbarbe           ?? null,
      ]);
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
      ancho, fuelle, altura, medida,
      grupos = [],
      suaje,
      acabados,
      maquinaria,
    } = req.body;

    const idusuario = (req as any).user?.idusuario ?? null;

    const { rows: check } = await client.query(
      `SELECT idproducto_papel FROM producto_papel WHERE idproducto_papel = $1 AND activo = true`, [id]
    );
    if (check.length === 0)
      return res.status(404).json({ error: "Producto no encontrado" });

    await client.query("BEGIN");

    // ── 1. Actualizar producto padre ──────────────────────────────────────
    await client.query(`
      UPDATE producto_papel SET
        idcat_tipo_producto_papel = $1,
        ancho = $2, fuelle = $3, altura = $4, medida = $5,
        actualizado_por = $6,
        updated_at = NOW()
      WHERE idproducto_papel = $7
    `, [
      idcat_tipo_producto_papel,
      ancho ?? null, fuelle ?? null, altura ?? null, medida ?? null,
      idusuario, id,
    ]);

    // ── 2. Grupos y materiales — eliminar y reinsertar ────────────────────
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
            hoj_bobina, hoj_corte, hoj_rendimiento, hoj_guillotina, hoj_hilo,
            orden, creado_por, actualizado_por
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
        `, [
          idgrupo_papel,
          mat.idcat_tipo_papel ?? null,
          mat.idcat_calibre    ?? null,
          mat.pliego           ?? null,
          mat.rendimiento      ?? null,
          mat.corte            ?? null,
          mat.hojeado?.bobina      ?? null,
          mat.hojeado?.corte       ?? null,
          mat.hojeado?.rendimiento ?? null,
          mat.hojeado?.guillotina  ?? null,
          mat.hojeado?.hilo        ?? null,
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
            corte1_tipo = $4, corte1_medida = $5,
            dobles1_tipo = $6, dobles1_medida = $7,
            metros = $8, matrix = $9, tiempo_arreglo = $10,
            idcat_sacabocados = $11, cantidad_sacabocado = $12,
            idcat_perforado   = $13, cantidad_perforado  = $14
          WHERE idproducto_papel = $15
        `, [
          suaje.numero ?? null, suaje.pzs ?? null, suaje.tamano ?? null,
          suaje.corte1_tipo ?? null, suaje.corte1_medida ?? null,
          suaje.dobles1_tipo ?? null, suaje.dobles1_medida ?? null,
          suaje.metros ?? null, suaje.matrix ?? null, suaje.tiempo_arreglo ?? null,
          suaje.idcat_sacabocados ?? null, suaje.cantidad_sacabocado ?? null,
          suaje.idcat_perforado   ?? null, suaje.cantidad_perforado  ?? null,
          id,
        ]);
      } else {
        await client.query(`
          INSERT INTO suaje_papel (
            idproducto_papel,
            numero, pzs, tamano,
            corte1_tipo, corte1_medida,
            dobles1_tipo, dobles1_medida,
            metros, matrix, tiempo_arreglo,
            idcat_sacabocados, cantidad_sacabocado,
            idcat_perforado,   cantidad_perforado
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        `, [
          id,
          suaje.numero ?? null, suaje.pzs ?? null, suaje.tamano ?? null,
          suaje.corte1_tipo ?? null, suaje.corte1_medida ?? null,
          suaje.dobles1_tipo ?? null, suaje.dobles1_medida ?? null,
          suaje.metros ?? null, suaje.matrix ?? null, suaje.tiempo_arreglo ?? null,
          suaje.idcat_sacabocados ?? null, suaje.cantidad_sacabocado ?? null,
          suaje.idcat_perforado   ?? null, suaje.cantidad_perforado  ?? null,
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
            idcat_tipo_pegado = $1, idcat_pegamento = $2, idcat_laminado = $3,
            idcat_refuerzo_material = $4, idcat_refuerzo_medidas = $5,
            idcat_base_material = $6, base_medida = $7,
            idcat_empaque = $8, pzs_caja = $9
          WHERE idacabados_papel = $10
        `, [
          acabados.idcat_tipo_pegado       ?? null,
          acabados.idcat_pegamento         ?? null,
          acabados.idcat_laminado          ?? null,
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
            idcat_tipo_pegado, idcat_pegamento, idcat_laminado,
            idcat_refuerzo_material, idcat_refuerzo_medidas,
            idcat_base_material, base_medida,
            idcat_empaque, pzs_caja
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          RETURNING idacabados_papel
        `, [
          id,
          acabados.idcat_tipo_pegado       ?? null,
          acabados.idcat_pegamento         ?? null,
          acabados.idcat_laminado          ?? null,
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
    }

    // ── 5. Maquinaria — upsert ────────────────────────────────────────────
    if (maquinaria) {
      const { rows: maqCheck } = await client.query(
        `SELECT idmaquinaria_papel FROM maquinaria_papel WHERE idproducto_papel = $1`, [id]
      );

      if (maqCheck.length > 0) {
        await client.query(`
          UPDATE maquinaria_papel SET
            idcat_hojeado_guillotina = $1, idcat_impresora = $2, idcat_hs_ar = $3,
            idcat_suaje_maquina = $4, idcat_uv = $5, idcat_textura = $6,
            idcat_empalme = $7, idcat_armado = $8,
            idcat_asas_maquina = $9, idcat_desbarbe = $10
          WHERE idproducto_papel = $11
        `, [
          maquinaria.idcat_hojeado_guillotina ?? null,
          maquinaria.idcat_impresora          ?? null,
          maquinaria.idcat_hs_ar              ?? null,
          maquinaria.idcat_suaje_maquina      ?? null,
          maquinaria.idcat_uv                 ?? null,
          maquinaria.idcat_textura            ?? null,
          maquinaria.idcat_empalme            ?? null,
          maquinaria.idcat_armado             ?? null,
          maquinaria.idcat_asas_maquina       ?? null,
          maquinaria.idcat_desbarbe           ?? null,
          id,
        ]);
      } else {
        await client.query(`
          INSERT INTO maquinaria_papel (
            idproducto_papel,
            idcat_hojeado_guillotina, idcat_impresora, idcat_hs_ar,
            idcat_suaje_maquina, idcat_uv, idcat_textura,
            idcat_empalme, idcat_armado, idcat_asas_maquina, idcat_desbarbe
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `, [
          id,
          maquinaria.idcat_hojeado_guillotina ?? null,
          maquinaria.idcat_impresora          ?? null,
          maquinaria.idcat_hs_ar              ?? null,
          maquinaria.idcat_suaje_maquina      ?? null,
          maquinaria.idcat_uv                 ?? null,
          maquinaria.idcat_textura            ?? null,
          maquinaria.idcat_empalme            ?? null,
          maquinaria.idcat_armado             ?? null,
          maquinaria.idcat_asas_maquina       ?? null,
          maquinaria.idcat_desbarbe           ?? null,
        ]);
      }
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