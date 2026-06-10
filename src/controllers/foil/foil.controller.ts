import { Request, Response } from "express";
import { pool } from "../../config/db";

// ═══════════════════════════════════════════════════════════════════════════
// GET /proveedores/:id/foil
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
        pp.idproveedor_producto,
        pp.precio,
        pp.notas,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT('idfoil_presentacion', fp.idfoil_presentacion, 'presentacion', fp.presentacion)
            ORDER BY fp.idfoil_presentacion
          ) FILTER (WHERE fp.idfoil_presentacion IS NOT NULL),
          '[]'
        ) AS presentaciones
      FROM foil f
      JOIN proveedor_producto pp ON pp.idproveedor_producto = f.idproveedor_producto
      LEFT JOIN foil_presentacion fp ON fp.idfoil = f.idfoil AND fp.activo = true
      WHERE pp.proveedor_idproveedor = $1
        AND f.activo = true
        AND pp.activo = true
      GROUP BY f.idfoil, pp.idproveedor_producto, pp.precio, pp.notas
      ORDER BY f.idfoil DESC
    `, [id]);

    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET FOIL BY PROVEEDOR ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener foils del proveedor" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /proveedores/:id/foil/:idFoil
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
        pp.idproveedor_producto,
        pp.precio,
        pp.notas,
        pp.minimo_compra,
        pp.unidad,
        p.idproveedor,
        p.nombre AS proveedor_nombre
      FROM foil f
      JOIN proveedor_producto pp ON pp.idproveedor_producto = f.idproveedor_producto
      JOIN proveedor p ON p.idproveedor = pp.proveedor_idproveedor
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
// POST /proveedores/:id/foil
// ═══════════════════════════════════════════════════════════════════════════
export const crearFoil = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { id } = req.params;
    const { colorfoil, codigofoil, precio, notas, minimo_compra, unidad, presentaciones } = req.body;

    if (!colorfoil?.trim())
      return res.status(400).json({ error: "colorfoil es requerido" });

    const { rows: prov } = await client.query(
      `SELECT nombre FROM proveedor WHERE idproveedor = $1 AND activo = true`, [id]
    );
    if (!prov.length)
      return res.status(404).json({ error: "Proveedor no encontrado" });

    const { rows: tipo } = await client.query(
      `SELECT idtipo_insumo FROM tipo_insumo WHERE LOWER(nombre) = 'foil' AND activo = true LIMIT 1`
    );
    if (!tipo.length)
      return res.status(400).json({ error: "Tipo de insumo 'Foil' no está registrado en catálogo" });

    const clavefoil = [
      prov[0].nombre.substring(0, 2).toUpperCase(),
      colorfoil.trim().substring(0, 3).toUpperCase(),
      codigofoil?.trim() ?? "",
    ].join("");

    // 1. Insert base en proveedor_producto
    const { rows: pp } = await client.query(`
      INSERT INTO proveedor_producto
        (proveedor_idproveedor, tipo_insumo_id, nombre, codigo, precio, notas, minimo_compra, unidad, activo)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
      RETURNING idproveedor_producto
    `, [
      id,
      tipo[0].idtipo_insumo,
      colorfoil.trim(),
      codigofoil?.trim() || null,
      precio != null ? Number(precio) : null,
      notas?.trim() || null,
      minimo_compra != null ? Number(minimo_compra) : null,
      unidad || null,
    ]);

    // 2. Insert detalle foil
    const { rows: foilRows } = await client.query(`
      INSERT INTO foil (idproveedor_producto, colorfoil, codigofoil, clavefoil)
      VALUES ($1, $2, $3, $4)
      RETURNING idfoil
    `, [pp[0].idproveedor_producto, colorfoil.trim(), codigofoil?.trim() || null, clavefoil]);

    // 3. Insert presentaciones
    for (const p of (presentaciones ?? [])) {
      if (!p?.trim()) continue;
      await client.query(
        `INSERT INTO foil_presentacion (idfoil, presentacion) VALUES ($1, $2)`,
        [foilRows[0].idfoil, p.trim()]
      );
    }

    await client.query("COMMIT");
    console.log(`✅ Foil creado: ${foilRows[0].idfoil} — ${clavefoil}`);
    return res.status(201).json({
      message: "Foil registrado",
      idfoil: foilRows[0].idfoil,
      clavefoil,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ CREAR FOIL ERROR:", error.message);
    return res.status(500).json({ error: "Error al registrar foil", detalle: error.message });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// PUT /proveedores/:id/foil/:idFoil
// ═══════════════════════════════════════════════════════════════════════════
export const actualizarFoil = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { id, idFoil } = req.params;
    const { colorfoil, codigofoil, precio, notas, minimo_compra, unidad, presentaciones } = req.body;

    if (!colorfoil?.trim())
      return res.status(400).json({ error: "colorfoil es requerido" });

    // Verificar que el foil pertenece al proveedor
    const { rows: check } = await client.query(`
      SELECT f.idfoil, pp.idproveedor_producto, p.nombre AS proveedor_nombre
      FROM foil f
      JOIN proveedor_producto pp ON pp.idproveedor_producto = f.idproveedor_producto
      JOIN proveedor p ON p.idproveedor = pp.proveedor_idproveedor
      WHERE f.idfoil = $1 AND pp.proveedor_idproveedor = $2 AND f.activo = true
    `, [idFoil, id]);

    if (!check.length)
      return res.status(404).json({ error: "Foil no encontrado para este proveedor" });

    // Regenerar clave con nuevo color/código
    const clavefoil = [
      check[0].proveedor_nombre.substring(0, 2).toUpperCase(),
      colorfoil.trim().substring(0, 3).toUpperCase(),
      codigofoil?.trim() ?? "",
    ].join("");

    // 1. Actualizar proveedor_producto
    await client.query(`
      UPDATE proveedor_producto SET
        nombre        = $1,
        codigo        = $2,
        precio        = $3,
        notas         = $4,
        minimo_compra = $5,
        unidad        = $6
      WHERE idproveedor_producto = $7
    `, [
      colorfoil.trim(),
      codigofoil?.trim() || null,
      precio != null ? Number(precio) : null,
      notas?.trim() || null,
      minimo_compra != null ? Number(minimo_compra) : null,
      unidad || null,
      check[0].idproveedor_producto,
    ]);

    // 2. Actualizar foil
    await client.query(`
      UPDATE foil SET colorfoil = $1, codigofoil = $2, clavefoil = $3
      WHERE idfoil = $4
    `, [colorfoil.trim(), codigofoil?.trim() || null, clavefoil, idFoil]);

    // 3. Presentaciones — delete + reinsert
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
// DELETE /proveedores/:id/foil/:idFoil  → soft delete
// ═══════════════════════════════════════════════════════════════════════════
export const eliminarFoil = async (req: Request, res: Response) => {
  try {
    const { id, idFoil } = req.params;

    const { rowCount } = await pool.query(`
      UPDATE foil SET activo = false
      WHERE idfoil = $1
        AND idproveedor_producto IN (
          SELECT idproveedor_producto FROM proveedor_producto
          WHERE proveedor_idproveedor = $2
        )
    `, [idFoil, id]);

    if (rowCount === 0)
      return res.status(404).json({ error: "Foil no encontrado" });

    // Soft delete también en proveedor_producto
    await pool.query(`
      UPDATE proveedor_producto SET activo = false
      WHERE idproveedor_producto = (
        SELECT idproveedor_producto FROM foil WHERE idfoil = $1
      )
    `, [idFoil]);

    console.log(`✅ Foil eliminado: id=${idFoil}`);
    return res.json({ message: "Foil desactivado" });
  } catch (error: any) {
    console.error("❌ ELIMINAR FOIL ERROR:", error.message);
    return res.status(500).json({ error: "Error al eliminar foil" });
  }
};

// GET /foil  — listado global para catálogos
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
        pp.idproveedor_producto,
        pp.precio,
        pp.notas,
        pp.minimo_compra,
        pp.unidad,
        p.idproveedor,
        p.nombre AS proveedor_nombre,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT('idfoil_presentacion', fp.idfoil_presentacion, 'presentacion', fp.presentacion)
            ORDER BY fp.idfoil_presentacion
          ) FILTER (WHERE fp.idfoil_presentacion IS NOT NULL),
          '[]'
        ) AS presentaciones
      FROM foil f
      JOIN proveedor_producto pp ON pp.idproveedor_producto = f.idproveedor_producto
      JOIN proveedor p ON p.idproveedor = pp.proveedor_idproveedor
      LEFT JOIN foil_presentacion fp ON fp.idfoil = f.idfoil AND fp.activo = true
      WHERE f.activo = true AND pp.activo = true
      GROUP BY f.idfoil, pp.idproveedor_producto, pp.precio, pp.notas,
               pp.minimo_compra, pp.unidad, p.idproveedor, p.nombre
      ORDER BY p.nombre, f.colorfoil
    `);
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET FOILS ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener foils" });
  }
};