import { Request, Response } from "express";
import { pool } from "../../config/db";

// ═══════════════════════════════════════════════════════════════════════════════
// TIPOS DE INSUMO  (catálogo)
// ═══════════════════════════════════════════════════════════════════════════════

export const getTiposInsumo = async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT idtipo_insumo, nombre
       FROM tipo_insumo
       WHERE activo = true
       ORDER BY nombre`
    );
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET TIPOS INSUMO ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener tipos de insumo" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// PROVEEDORES — CRUD
// ═══════════════════════════════════════════════════════════════════════════════

// GET /proveedores
export const getProveedores = async (req: Request, res: Response) => {
  try {
    const { q, activo } = req.query;

    let query = `
      SELECT
        p.idproveedor,
        p.nombre,
        p.contacto,
        p.telefono,
        p.correo,
        p.direccion,
        p.notas,
        p.activo,
        p.created_at,
        COUNT(pp.idproveedor_producto)::int AS total_productos
      FROM proveedor p
      LEFT JOIN proveedor_producto pp
        ON pp.proveedor_idproveedor = p.idproveedor AND pp.activo = true
    `;

    const params: any[] = [];
    const where: string[] = [];

    if (q) {
      params.push(`%${q}%`);
      where.push(`(
        p.nombre    ILIKE $${params.length} OR
        p.contacto  ILIKE $${params.length} OR
        p.correo    ILIKE $${params.length} OR
        p.telefono  ILIKE $${params.length}
      )`);
    }

    if (activo !== undefined) {
      params.push(activo === "true");
      where.push(`p.activo = $${params.length}`);
    }

    if (where.length) query += ` WHERE ${where.join(" AND ")}`;
    query += ` GROUP BY p.idproveedor ORDER BY p.nombre`;

    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET PROVEEDORES ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener proveedores" });
  }
};

// GET /proveedores/:id
export const getProveedorById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const { rows: provRows } = await pool.query(
      `SELECT idproveedor, nombre, contacto, telefono, correo, direccion, notas, activo, created_at
       FROM proveedor WHERE idproveedor = $1`,
      [id]
    );

    if (provRows.length === 0)
      return res.status(404).json({ error: "Proveedor no encontrado" });

    const { rows: prodRows } = await pool.query(
      `SELECT
         pp.idproveedor_producto,
         pp.nombre,
         pp.codigo,
         pp.precio,
         pp.notas,
         pp.activo,
         ti.idtipo_insumo,
         ti.nombre AS tipo_insumo_nombre
       FROM proveedor_producto pp
       JOIN tipo_insumo ti ON ti.idtipo_insumo = pp.tipo_insumo_id
       WHERE pp.proveedor_idproveedor = $1
       ORDER BY ti.nombre, pp.nombre`,
      [id]
    );

    return res.json({ ...provRows[0], productos: prodRows });
  } catch (error: any) {
    console.error("❌ GET PROVEEDOR BY ID ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener proveedor" });
  }
};

// POST /proveedores
export const crearProveedor = async (req: Request, res: Response) => {
  try {
    const { nombre, contacto, telefono, correo, direccion, notas } = req.body;

    if (!nombre?.trim())
      return res.status(400).json({ error: "El nombre es requerido" });

    const { rows } = await pool.query(
      `INSERT INTO proveedor (nombre, contacto, telefono, correo, direccion, notas)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        nombre.trim(),
        contacto?.trim()  || null,
        telefono?.trim()  || null,
        correo?.trim()    || null,
        direccion?.trim() || null,
        notas?.trim()     || null,
      ]
    );

    console.log(`✅ Proveedor creado: ${rows[0].idproveedor} — ${rows[0].nombre}`);
    return res.status(201).json({ message: "Proveedor creado", proveedor: rows[0] });
  } catch (error: any) {
    console.error("❌ CREAR PROVEEDOR ERROR:", error.message);
    return res.status(500).json({ error: "Error al crear proveedor" });
  }
};

// PUT /proveedores/:id
export const actualizarProveedor = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { nombre, contacto, telefono, correo, direccion, notas, activo } = req.body;

    if (!nombre?.trim())
      return res.status(400).json({ error: "El nombre es requerido" });

    const { rowCount, rows } = await pool.query(
      `UPDATE proveedor SET
         nombre    = $1,
         contacto  = $2,
         telefono  = $3,
         correo    = $4,
         direccion = $5,
         notas     = $6,
         activo    = $7
       WHERE idproveedor = $8
       RETURNING *`,
      [
        nombre.trim(),
        contacto?.trim()  || null,
        telefono?.trim()  || null,
        correo?.trim()    || null,
        direccion?.trim() || null,
        notas?.trim()     || null,
        activo !== undefined ? activo : true,
        id,
      ]
    );

    if (rowCount === 0)
      return res.status(404).json({ error: "Proveedor no encontrado" });

    return res.json({ message: "Proveedor actualizado", proveedor: rows[0] });
  } catch (error: any) {
    console.error("❌ ACTUALIZAR PROVEEDOR ERROR:", error.message);
    return res.status(500).json({ error: "Error al actualizar proveedor" });
  }
};

// DELETE /proveedores/:id  →  soft delete
export const eliminarProveedor = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const { rowCount } = await pool.query(
      `UPDATE proveedor SET activo = false WHERE idproveedor = $1`,
      [id]
    );

    if (rowCount === 0)
      return res.status(404).json({ error: "Proveedor no encontrado" });

    return res.json({ message: "Proveedor desactivado" });
  } catch (error: any) {
    console.error("❌ ELIMINAR PROVEEDOR ERROR:", error.message);
    return res.status(500).json({ error: "Error al eliminar proveedor" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCTOS DEL PROVEEDOR — CRUD
// ═══════════════════════════════════════════════════════════════════════════════

// GET /proveedores/:id/productos   (ya incluido en getProveedorById, pero
//                                   este endpoint sirve para filtrar por tipo)
export const getProductosProveedor = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { tipo } = req.query; // tipo_insumo_id opcional

    let query = `
      SELECT
        pp.idproveedor_producto,
        pp.nombre,
        pp.codigo,
        pp.precio,
        pp.notas,
        pp.activo,
        ti.idtipo_insumo,
        ti.nombre AS tipo_insumo_nombre,
        p.nombre  AS proveedor_nombre
      FROM proveedor_producto pp
      JOIN tipo_insumo ti ON ti.idtipo_insumo = pp.tipo_insumo_id
      JOIN proveedor   p  ON p.idproveedor    = pp.proveedor_idproveedor
      WHERE pp.proveedor_idproveedor = $1 AND pp.activo = true
    `;
    const params: any[] = [id];

    if (tipo) {
      params.push(tipo);
      query += ` AND pp.tipo_insumo_id = $${params.length}`;
    }

    query += ` ORDER BY ti.nombre, pp.nombre`;

    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET PRODUCTOS PROVEEDOR ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener productos del proveedor" });
  }
};

// GET /insumos?tipo=1&q=rojo   ← usado por el desplegable en cotización
// Devuelve insumos de TODOS los proveedores, filtrados por tipo y búsqueda
export const buscarInsumos = async (req: Request, res: Response) => {
  try {
    const { tipo, q } = req.query;

    let query = `
      SELECT
        pp.idproveedor_producto,
        pp.nombre,
        pp.codigo,
        pp.precio,
        ti.nombre AS tipo_insumo_nombre,
        p.nombre  AS proveedor_nombre,
        p.idproveedor
      FROM proveedor_producto pp
      JOIN tipo_insumo ti ON ti.idtipo_insumo = pp.tipo_insumo_id
      JOIN proveedor   p  ON p.idproveedor    = pp.proveedor_idproveedor
      WHERE pp.activo = true AND p.activo = true
    `;
    const params: any[] = [];

    if (tipo) {
      params.push(tipo);
      query += ` AND pp.tipo_insumo_id = $${params.length}`;
    }

    if (q) {
      params.push(`%${q}%`);
      query += ` AND (pp.nombre ILIKE $${params.length} OR pp.codigo ILIKE $${params.length})`;
    }

    query += ` ORDER BY pp.nombre LIMIT 50`;

    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ BUSCAR INSUMOS ERROR:", error.message);
    return res.status(500).json({ error: "Error al buscar insumos" });
  }
};

// POST /proveedores/:id/productos
export const crearProductoProveedor = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { tipo_insumo_id, nombre, codigo, precio, notas } = req.body;

    if (!tipo_insumo_id || !nombre?.trim())
      return res.status(400).json({ error: "tipo_insumo_id y nombre son requeridos" });

    // Verificar que el proveedor existe
    const { rows: prov } = await pool.query(
      `SELECT idproveedor FROM proveedor WHERE idproveedor = $1 AND activo = true`, [id]
    );
    if (prov.length === 0)
      return res.status(404).json({ error: "Proveedor no encontrado" });

    const { rows } = await pool.query(
      `INSERT INTO proveedor_producto
         (proveedor_idproveedor, tipo_insumo_id, nombre, codigo, precio, notas)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        id,
        tipo_insumo_id,
        nombre.trim(),
        codigo?.trim()  || null,
        precio != null  ? Number(precio) : null,
        notas?.trim()   || null,
      ]
    );

    console.log(`✅ Producto creado: ${rows[0].idproveedor_producto} — ${rows[0].nombre}`);
    return res.status(201).json({ message: "Producto creado", producto: rows[0] });
  } catch (error: any) {
    console.error("❌ CREAR PRODUCTO PROVEEDOR ERROR:", error.message);
    return res.status(500).json({ error: "Error al crear producto" });
  }
};

// PUT /proveedores/:id/productos/:idProducto
export const actualizarProductoProveedor = async (req: Request, res: Response) => {
  try {
    const { idProducto } = req.params;
    const { tipo_insumo_id, nombre, codigo, precio, notas, activo } = req.body;

    if (!tipo_insumo_id || !nombre?.trim())
      return res.status(400).json({ error: "tipo_insumo_id y nombre son requeridos" });

    const { rowCount, rows } = await pool.query(
      `UPDATE proveedor_producto SET
         tipo_insumo_id = $1,
         nombre         = $2,
         codigo         = $3,
         precio         = $4,
         notas          = $5,
         activo         = $6
       WHERE idproveedor_producto = $7
       RETURNING *`,
      [
        tipo_insumo_id,
        nombre.trim(),
        codigo?.trim()  || null,
        precio != null  ? Number(precio) : null,
        notas?.trim()   || null,
        activo !== undefined ? activo : true,
        idProducto,
      ]
    );

    if (rowCount === 0)
      return res.status(404).json({ error: "Producto no encontrado" });

    return res.json({ message: "Producto actualizado", producto: rows[0] });
  } catch (error: any) {
    console.error("❌ ACTUALIZAR PRODUCTO PROVEEDOR ERROR:", error.message);
    return res.status(500).json({ error: "Error al actualizar producto" });
  }
};

// DELETE /proveedores/:id/productos/:idProducto  →  soft delete
export const eliminarProductoProveedor = async (req: Request, res: Response) => {
  try {
    const { idProducto } = req.params;

    const { rowCount } = await pool.query(
      `UPDATE proveedor_producto SET activo = false WHERE idproveedor_producto = $1`,
      [idProducto]
    );

    if (rowCount === 0)
      return res.status(404).json({ error: "Producto no encontrado" });

    return res.json({ message: "Producto desactivado" });
  } catch (error: any) {
    console.error("❌ ELIMINAR PRODUCTO PROVEEDOR ERROR:", error.message);
    return res.status(500).json({ error: "Error al eliminar producto" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /proveedores/insumos/registrar-rapido
// ═══════════════════════════════════════════════════════════════════════════════
export const registrarInsumoRapido = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { tipo_insumo_id, nombre, codigo, proveedor_idproveedor } = req.body;

    if (!tipo_insumo_id || !nombre?.trim())
      return res.status(400).json({ error: "tipo_insumo_id y nombre son requeridos" });

    // ── Verificar duplicado por nombre ────────────────────────────────────────
    const { rows: existentes } = await client.query(
      `SELECT idproveedor_producto, nombre, codigo, proveedor_idproveedor
       FROM proveedor_producto
       WHERE tipo_insumo_id = $1
         AND LOWER(TRIM(nombre)) = LOWER(TRIM($2))
         AND activo = true
         ${proveedor_idproveedor ? "AND proveedor_idproveedor = $3" : ""}
       LIMIT 1`,
      proveedor_idproveedor
        ? [tipo_insumo_id, nombre.trim(), proveedor_idproveedor]
        : [tipo_insumo_id, nombre.trim()]
    );

    if (existentes.length > 0) {
      return res.status(409).json({
        error:     "Ya existe un insumo con ese nombre para este tipo.",
        existente: existentes[0],
      });
    }

    // ── Verificar duplicado por código ────────────────────────────────────────
    if (codigo?.trim()) {
      const { rows: existentesCodigo } = await client.query(
        `SELECT idproveedor_producto, nombre, codigo
         FROM proveedor_producto
         WHERE tipo_insumo_id = $1
           AND LOWER(TRIM(codigo)) = LOWER(TRIM($2))
           AND activo = true
         LIMIT 1`,
        [tipo_insumo_id, codigo.trim()]
      );
      if (existentesCodigo.length > 0) {
        return res.status(409).json({
          error:     `Ya existe un insumo con el código "${codigo.trim()}".`,
          existente: existentesCodigo[0],
        });
      }
    }

    // ── Insertar ──────────────────────────────────────────────────────────────
    const { rows } = await client.query(
      `INSERT INTO proveedor_producto
         (proveedor_idproveedor, tipo_insumo_id, nombre, codigo, activo)
       VALUES ($1, $2, $3, $4, true)
       RETURNING *`,
      [
        proveedor_idproveedor || null,
        tipo_insumo_id,
        nombre.trim(),
        codigo?.trim() || null,
      ]
    );

    let resultado = { ...rows[0], proveedor_nombre: null as string | null };

    if (proveedor_idproveedor) {
      const { rows: prov } = await client.query(
        `SELECT nombre FROM proveedor WHERE idproveedor = $1`, [proveedor_idproveedor]
      );
      resultado.proveedor_nombre = prov[0]?.nombre ?? null;
    }

    console.log(`✅ Insumo rápido creado: ${resultado.idproveedor_producto} — ${resultado.nombre}`);
    return res.status(201).json({ message: "Insumo registrado", producto: resultado });

  } catch (error: any) {
    console.error("❌ REGISTRAR INSUMO RÁPIDO ERROR:", error.message);
    return res.status(500).json({ error: "Error al registrar insumo", detalle: error.message });
  } finally {
    client.release();
  }
};

// POST /proveedores/tipos-insumo
export const crearTipoInsumo = async (req: Request, res: Response) => {
  try {
    const { nombre } = req.body;
    if (!nombre?.trim())
      return res.status(400).json({ error: "El nombre es requerido" });

    // Verificar duplicado
    const { rows: existe } = await pool.query(
      `SELECT idtipo_insumo, nombre FROM tipo_insumo
       WHERE LOWER(TRIM(nombre)) = LOWER(TRIM($1)) LIMIT 1`,
      [nombre.trim()]
    );
    if (existe.length > 0)
      return res.status(409).json({
        error: `Ya existe el tipo "${existe[0].nombre}"`,
        existente: existe[0],
      });

    const { rows } = await pool.query(
      `INSERT INTO tipo_insumo (nombre, activo)
       VALUES ($1, true) RETURNING *`,
      [nombre.trim()]
    );

    console.log(`✅ Tipo insumo creado: ${rows[0].idtipo_insumo} — ${rows[0].nombre}`);
    return res.status(201).json({ message: "Tipo creado", tipo: rows[0] });
  } catch (error: any) {
    console.error("❌ CREAR TIPO INSUMO ERROR:", error.message);
    return res.status(500).json({ error: "Error al crear tipo de insumo" });
  }
};