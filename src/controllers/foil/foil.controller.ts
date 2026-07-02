import { Request, Response } from "express";
import { pool } from "../../config/db";

// ═══════════════════════════════════════════════════════════════════════════
// GET /foil  — listado global (usado por FoilPanel), AGRUPADO por foil con
// todos sus proveedores anidados en `.proveedores`.
// ═══════════════════════════════════════════════════════════════════════════
export const getFoils = async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        f.idfoil,
        f.colorfoil,
        f.codigofoil,
        f.clavefoil,
        f.activo,
        f.created_at,
        COALESCE(prov_agg.proveedores, '[]') AS proveedores,
        COALESCE(pres_agg.presentaciones, '[]') AS presentaciones
      FROM foil f
      LEFT JOIN LATERAL (
        SELECT JSON_AGG(
          JSON_BUILD_OBJECT(
            'idfoil_proveedor', fp.idfoil_proveedor,
            'idproveedor', pv.idproveedor,
            'proveedor_nombre', pv.nombre,
            'codigo', fp.codigo,
            'precio', fp.precio,
            'notas', fp.notas,
            'minimo_compra', fp.minimo_compra,
            'unidad', fp.unidad
          ) ORDER BY pv.nombre
        ) AS proveedores
        FROM foil_proveedor fp
        JOIN proveedor pv ON pv.idproveedor = fp.proveedor_idproveedor AND pv.activo = true
        WHERE fp.idfoil = f.idfoil AND fp.activo = true
      ) prov_agg ON true
      LEFT JOIN LATERAL (
        SELECT JSON_AGG(
          JSON_BUILD_OBJECT('idfoil_presentacion', fpres.idfoil_presentacion, 'presentacion', fpres.presentacion)
          ORDER BY fpres.idfoil_presentacion
        ) AS presentaciones
        FROM foil_presentacion fpres
        WHERE fpres.idfoil = f.idfoil AND fpres.activo = true
      ) pres_agg ON true
      WHERE f.activo = true
      ORDER BY f.colorfoil
    `);
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET FOILS ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener foils" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /proveedores/:id/foil  — foils que vende ESE proveedor (flat, un
// renglón por relación foil-proveedor, igual forma que antes).
// ═══════════════════════════════════════════════════════════════════════════
export const getFoilByProveedor = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(`
      SELECT
        f.idfoil,
        f.colorfoil,
        f.codigofoil,
        f.clavefoil,
        f.activo,
        f.created_at,
        fp.idfoil_proveedor,
        fp.codigo,
        fp.precio,
        fp.notas,
        fp.minimo_compra,
        fp.unidad,
        COALESCE(pres_agg.presentaciones, '[]') AS presentaciones
      FROM foil f
      JOIN foil_proveedor fp ON fp.idfoil = f.idfoil AND fp.activo = true
      LEFT JOIN LATERAL (
        SELECT JSON_AGG(
          JSON_BUILD_OBJECT('idfoil_presentacion', fpres.idfoil_presentacion, 'presentacion', fpres.presentacion)
          ORDER BY fpres.idfoil_presentacion
        ) AS presentaciones
        FROM foil_presentacion fpres
        WHERE fpres.idfoil = f.idfoil AND fpres.activo = true
      ) pres_agg ON true
      WHERE fp.proveedor_idproveedor = $1 AND f.activo = true
      ORDER BY f.idfoil DESC
    `, [id]);

    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET FOIL BY PROVEEDOR ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener foils del proveedor" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /foil/:idFoil  — un foil, con TODOS sus proveedores anidados.
// ═══════════════════════════════════════════════════════════════════════════
export const getFoilById = async (req: Request, res: Response) => {
  try {
    const { idFoil } = req.params;

    const { rows: foilRows } = await pool.query(`
      SELECT
        f.idfoil,
        f.colorfoil,
        f.codigofoil,
        f.clavefoil,
        f.activo,
        f.created_at,
        COALESCE(prov_agg.proveedores, '[]') AS proveedores
      FROM foil f
      LEFT JOIN LATERAL (
        SELECT JSON_AGG(
          JSON_BUILD_OBJECT(
            'idfoil_proveedor', fp.idfoil_proveedor,
            'idproveedor', pv.idproveedor,
            'proveedor_nombre', pv.nombre,
            'codigo', fp.codigo,
            'precio', fp.precio,
            'notas', fp.notas,
            'minimo_compra', fp.minimo_compra,
            'unidad', fp.unidad
          ) ORDER BY pv.nombre
        ) AS proveedores
        FROM foil_proveedor fp
        JOIN proveedor pv ON pv.idproveedor = fp.proveedor_idproveedor AND pv.activo = true
        WHERE fp.idfoil = f.idfoil AND fp.activo = true
      ) prov_agg ON true
      WHERE f.idfoil = $1 AND f.activo = true
    `, [idFoil]);

    if (!foilRows.length)
      return res.status(404).json({ error: "Foil no encontrado" });

    const foil = foilRows[0];

    const { rows: presentaciones } = await pool.query(`
      SELECT idfoil_presentacion, presentacion
      FROM foil_presentacion
      WHERE idfoil = $1 AND activo = true
      ORDER BY idfoil_presentacion
    `, [idFoil]);

    foil.presentaciones = presentaciones;

    return res.json(foil);
  } catch (error: any) {
    console.error("❌ GET FOIL BY ID ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener el foil" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// PUT /proveedores/:id/foil/:idFoil
//
// :id = proveedor "desde el cual" editas. El body puede traer
// `proveedores_ids: number[]` para reemplazar el conjunto completo de
// proveedores ligados a este foil; si no viene, solo se actualiza la
// identidad del foil (colorfoil/codigofoil/clavefoil) y la relación de :id.
// ═══════════════════════════════════════════════════════════════════════════
export const actualizarFoil = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { id, idFoil } = req.params;
    const { colorfoil, codigofoil, precio, notas, minimo_compra, unidad, presentaciones, proveedores_ids } = req.body;

    if (!colorfoil?.trim()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "colorfoil es requerido" });
    }

    // Verificar que el foil está ligado al proveedor desde el que editas
    const { rows: check } = await client.query(`
      SELECT f.idfoil, pv.nombre AS proveedor_nombre
      FROM foil f
      JOIN foil_proveedor fp ON fp.idfoil = f.idfoil AND fp.activo = true
      JOIN proveedor pv ON pv.idproveedor = fp.proveedor_idproveedor
      WHERE f.idfoil = $1 AND fp.proveedor_idproveedor = $2 AND f.activo = true
    `, [idFoil, id]);

    if (!check.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Foil no encontrado para este proveedor" });
    }

    const clavefoil = [
      check[0].proveedor_nombre.substring(0, 2).toUpperCase(),
      colorfoil.trim().substring(0, 3).toUpperCase(),
      codigofoil?.trim() ?? "",
    ].join("");

    // 1. Identidad del foil (COMPARTIDA entre todos sus proveedores)
    await client.query(`
      UPDATE foil SET colorfoil = $1, codigofoil = $2, clavefoil = $3
      WHERE idfoil = $4
    `, [colorfoil.trim(), codigofoil?.trim() || null, clavefoil, idFoil]);

    // 2. Determinar el conjunto final de proveedores
    const idsFinales: number[] = Array.isArray(proveedores_ids) && proveedores_ids.length > 0
      ? proveedores_ids.map(Number)
      : [Number(id)]; // si no mandan la lista, al menos conserva el actual

    // 3. Dar de baja relaciones que ya no aplican
    await client.query(`
      UPDATE foil_proveedor SET activo = false
      WHERE idfoil = $1 AND proveedor_idproveedor <> ALL($2::int[]) AND activo = true
    `, [idFoil, idsFinales]);

    // 4. Upsert de cada proveedor final (mismo precio/código/notas para todos
    //    los seleccionados — si necesitas precio distinto por proveedor,
    //    edítalo por separado después desde cada relación).
    for (const idProv of idsFinales) {
      await client.query(`
        INSERT INTO foil_proveedor
          (idfoil, proveedor_idproveedor, codigo, precio, notas, minimo_compra, unidad, activo)
        VALUES ($1, $2, $3, $4, $5, $6, $7, true)
        ON CONFLICT (idfoil, proveedor_idproveedor)
        DO UPDATE SET
          codigo = EXCLUDED.codigo,
          precio = EXCLUDED.precio,
          notas = EXCLUDED.notas,
          minimo_compra = EXCLUDED.minimo_compra,
          unidad = EXCLUDED.unidad,
          activo = true
      `, [
        idFoil, idProv,
        codigofoil?.trim() || null,
        precio != null ? Number(precio) : null,
        notas?.trim() || null,
        minimo_compra != null ? Number(minimo_compra) : null,
        unidad || null,
      ]);
    }

    // 5. Presentaciones — delete + reinsert
    await client.query(`DELETE FROM foil_presentacion WHERE idfoil = $1`, [idFoil]);
    for (const p of (presentaciones ?? [])) {
      if (!p?.trim()) continue;
      await client.query(
        `INSERT INTO foil_presentacion (idfoil, presentacion) VALUES ($1, $2)`,
        [idFoil, p.trim()]
      );
    }

    await client.query("COMMIT");
    console.log(`✅ Foil actualizado: id=${idFoil} — ${clavefoil}`);
    return res.json({ message: "Foil actualizado", clavefoil });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ ACTUALIZAR FOIL ERROR:", error.message);
    return res.status(500).json({ error: "Error al actualizar foil", detalle: error.message });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /proveedores/:id/foil/:idFoil
//
// IMPORTANTE — cambio de comportamiento respecto a antes: como un foil
// ahora puede tener varios proveedores, "eliminar" desde la ficha de UN
// proveedor solo desvincula a ESE proveedor (desactiva su fila en
// foil_proveedor). El foil como tal (su identidad/color/clave) sigue vivo
// mientras tenga al menos otro proveedor activo. Si era el último
// proveedor, el foil queda sin proveedores pero no se borra su identidad
// (para no perder historial); si prefieres que también se desactive el
// foil completo cuando se queda sin proveedores, dímelo y lo agrego.
// ═══════════════════════════════════════════════════════════════════════════
export const eliminarFoil = async (req: Request, res: Response) => {
  try {
    const { id, idFoil } = req.params;

    const { rowCount } = await pool.query(`
      UPDATE foil_proveedor SET activo = false
      WHERE idfoil = $1 AND proveedor_idproveedor = $2 AND activo = true
    `, [idFoil, id]);

    if (rowCount === 0)
      return res.status(404).json({ error: "Foil no encontrado para este proveedor" });

    console.log(`✅ Foil desvinculado: idfoil=${idFoil} proveedor=${id}`);
    return res.json({ message: "Foil desvinculado de este proveedor" });
  } catch (error: any) {
    console.error("❌ ELIMINAR FOIL ERROR:", error.message);
    return res.status(500).json({ error: "Error al eliminar foil" });
  }
};