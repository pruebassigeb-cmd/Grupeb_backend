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
        p.rfc_proveedor,
        p.regimen_fiscal_idregimen_fiscal,
        rf.codigo           AS regimen_fiscal_codigo,
        rf.tipo_regimen     AS regimen_fiscal_nombre,
        COUNT(pp.idproveedor_producto)::int AS total_productos,
        pf.condicion_compra,
        pf.dias_credito
      FROM proveedor p
      LEFT JOIN regimen_fiscal rf ON rf.idregimen_fiscal = p.regimen_fiscal_idregimen_fiscal
      LEFT JOIN proveedor_producto pp
        ON pp.proveedor_idproveedor = p.idproveedor AND pp.activo = true
      LEFT JOIN LATERAL (
        SELECT condicion_compra, dias_credito
        FROM proveedor_facturacion
        WHERE proveedor_idproveedor = p.idproveedor AND activo = true
        ORDER BY created_at
        LIMIT 1
      ) pf ON true
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
    query += ` GROUP BY p.idproveedor, rf.codigo, rf.tipo_regimen, pf.condicion_compra, pf.dias_credito ORDER BY p.nombre`;

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
      `SELECT
         p.idproveedor, p.nombre, p.contacto, p.telefono, p.correo,
         p.direccion, p.notas, p.activo, p.created_at,
         p.rfc_proveedor,
         p.regimen_fiscal_idregimen_fiscal,
         rf.codigo       AS regimen_fiscal_codigo,
         rf.tipo_regimen AS regimen_fiscal_nombre
       FROM proveedor p
       LEFT JOIN regimen_fiscal rf ON rf.idregimen_fiscal = p.regimen_fiscal_idregimen_fiscal
       WHERE p.idproveedor = $1`,
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
  pp.clave_producto,
  pp.minimo_compra,
  pp.unidad,
  pp.producto_sat_idproducto_sat,
  ps.clave  AS producto_sat_clave,
  ps.pdft   AS producto_sat_nombre,
  ti.idtipo_insumo,
  ti.nombre AS tipo_insumo_nombre
FROM proveedor_producto pp
JOIN tipo_insumo ti ON ti.idtipo_insumo = pp.tipo_insumo_id
LEFT JOIN producto_sat ps ON ps.idproducto_sat = pp.producto_sat_idproducto_sat
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
    const {
      nombre, contacto, telefono, correo, direccion, notas,
      rfc_proveedor, regimen_fiscal_idregimen_fiscal
    } = req.body;

    if (!nombre?.trim())
      return res.status(400).json({ error: "El nombre es requerido" });

    const { rows } = await pool.query(
      `INSERT INTO proveedor
         (nombre, contacto, telefono, correo, direccion, notas,
          rfc_proveedor, regimen_fiscal_idregimen_fiscal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        nombre.trim(),
        contacto?.trim() || null,
        telefono?.trim() || null,
        correo?.trim() || null,
        direccion?.trim() || null,
        notas?.trim() || null,
        rfc_proveedor?.trim() || null,
        regimen_fiscal_idregimen_fiscal || null,
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
    const {
      nombre, contacto, telefono, correo, direccion, notas, activo,
      rfc_proveedor, regimen_fiscal_idregimen_fiscal
    } = req.body;

    if (!nombre?.trim())
      return res.status(400).json({ error: "El nombre es requerido" });

    const { rowCount, rows } = await pool.query(
      `UPDATE proveedor SET
         nombre                          = $1,
         contacto                        = $2,
         telefono                        = $3,
         correo                          = $4,
         direccion                       = $5,
         notas                           = $6,
         activo                          = $7,
         rfc_proveedor                   = $8,
         regimen_fiscal_idregimen_fiscal = $9
       WHERE idproveedor = $10
       RETURNING *`,
      [
        nombre.trim(),
        contacto?.trim() || null,
        telefono?.trim() || null,
        correo?.trim() || null,
        direccion?.trim() || null,
        notas?.trim() || null,
        activo !== undefined ? activo : true,
        rfc_proveedor?.trim() || null,
        regimen_fiscal_idregimen_fiscal || null,
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

export const getProductosProveedor = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { tipo } = req.query;

    let query = `
      SELECT
        pp.idproveedor_producto,
        pp.nombre,
        pp.codigo,
        pp.precio,
        pp.notas,
        pp.activo,
        pp.clave_producto,
        pp.minimo_compra,
        pp.unidad,
        pp.producto_sat_idproducto_sat,
        ps.clave  AS producto_sat_clave,
        ps.pdft   AS producto_sat_nombre,
        ti.idtipo_insumo,
        ti.nombre AS tipo_insumo_nombre,
        p.nombre  AS proveedor_nombre
      FROM proveedor_producto pp
      JOIN tipo_insumo ti ON ti.idtipo_insumo = pp.tipo_insumo_id
      JOIN proveedor   p  ON p.idproveedor    = pp.proveedor_idproveedor
      LEFT JOIN producto_sat ps ON ps.idproducto_sat = pp.producto_sat_idproducto_sat
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

export const buscarInsumos = async (req: Request, res: Response) => {
  try {
    const { tipo, q } = req.query;

    let query = `
      SELECT
        pp.idproveedor_producto,
        pp.nombre,
        pp.codigo,
        pp.precio,
        pp.clave_producto,
        pp.minimo_compra,
        pp.unidad,
        pp.producto_sat_idproducto_sat,
        ps.clave  AS producto_sat_clave,
        ps.pdft   AS producto_sat_nombre,
        ti.nombre AS tipo_insumo_nombre,
        p.nombre  AS proveedor_nombre,
        p.idproveedor
      FROM proveedor_producto pp
      JOIN tipo_insumo ti ON ti.idtipo_insumo = pp.tipo_insumo_id
      JOIN proveedor   p  ON p.idproveedor    = pp.proveedor_idproveedor
      LEFT JOIN producto_sat ps ON ps.idproducto_sat = pp.producto_sat_idproducto_sat
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
    const {
      tipo_insumo_id, nombre, codigo, precio, notas,
      clave_producto, minimo_compra, unidad,
      producto_sat_idproducto_sat
    } = req.body;

    if (!tipo_insumo_id || !nombre?.trim())
      return res.status(400).json({ error: "tipo_insumo_id y nombre son requeridos" });

    const { rows: prov } = await pool.query(
      `SELECT idproveedor FROM proveedor WHERE idproveedor = $1 AND activo = true`, [id]
    );
    if (prov.length === 0)
      return res.status(404).json({ error: "Proveedor no encontrado" });

    const { rows } = await pool.query(
      `INSERT INTO proveedor_producto
         (proveedor_idproveedor, tipo_insumo_id, nombre, codigo, precio, notas,
          clave_producto, minimo_compra, unidad, producto_sat_idproducto_sat)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        id, tipo_insumo_id, nombre.trim(),
        codigo?.trim() || null,
        precio != null ? Number(precio) : null,
        notas?.trim() || null,
        clave_producto?.trim() || null,
        minimo_compra != null ? Number(minimo_compra) : null,
        unidad || null,
        producto_sat_idproducto_sat || null,
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
    const {
      tipo_insumo_id, nombre, codigo, precio, notas, activo,
      clave_producto, minimo_compra, unidad,
      producto_sat_idproducto_sat
    } = req.body;

    if (!tipo_insumo_id || !nombre?.trim())
      return res.status(400).json({ error: "tipo_insumo_id y nombre son requeridos" });

    const { rowCount, rows } = await pool.query(
      `UPDATE proveedor_producto SET
         tipo_insumo_id              = $1,
         nombre                      = $2,
         codigo                      = $3,
         precio                      = $4,
         notas                       = $5,
         activo                      = $6,
         clave_producto              = $7,
         minimo_compra               = $8,
         unidad                      = $9,
         producto_sat_idproducto_sat = $10
       WHERE idproveedor_producto = $11
       RETURNING *`,
      [
        tipo_insumo_id, nombre.trim(),
        codigo?.trim() || null,
        precio != null ? Number(precio) : null,
        notas?.trim() || null,
        activo !== undefined ? activo : true,
        clave_producto?.trim() || null,
        minimo_compra != null ? Number(minimo_compra) : null,
        unidad || null,
        producto_sat_idproducto_sat || null,
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
        error: "Ya existe un insumo con ese nombre para este tipo.",
        existente: existentes[0],
      });
    }

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
          error: `Ya existe un insumo con el código "${codigo.trim()}".`,
          existente: existentesCodigo[0],
        });
      }
    }

    const { rows } = await client.query(
      `INSERT INTO proveedor_producto
         (proveedor_idproveedor, tipo_insumo_id, nombre, codigo, activo)
       VALUES ($1, $2, $3, $4, true)
       RETURNING *`,
      [proveedor_idproveedor || null, tipo_insumo_id, nombre.trim(), codigo?.trim() || null]
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
      `INSERT INTO tipo_insumo (nombre, activo) VALUES ($1, true) RETURNING *`,
      [nombre.trim()]
    );

    console.log(`✅ Tipo insumo creado: ${rows[0].idtipo_insumo} — ${rows[0].nombre}`);
    return res.status(201).json({ message: "Tipo creado", tipo: rows[0] });
  } catch (error: any) {
    console.error("❌ CREAR TIPO INSUMO ERROR:", error.message);
    return res.status(500).json({ error: "Error al crear tipo de insumo" });
  }
};

// ── GET /proveedores/regimenes-fiscales ───────────────────────────────────────
export const getRegimenesFiscales = async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT idregimen_fiscal, tipo_regimen, codigo
       FROM regimen_fiscal
       ORDER BY codigo`
    );
    return res.json(rows);
  } catch (error: any) {
    return res.status(500).json({ error: "Error al obtener regímenes fiscales" });
  }
};

// ── GET /proveedores/productos-sat ────────────────────────────────────────────
export const getProductosSat = async (req: Request, res: Response) => {
  try {
    const { q } = req.query;
    let query = `SELECT idproducto_sat, clave, pdft FROM producto_sat`;
    const params: any[] = [];

    if (q) {
      params.push(`%${q}%`);
      query += ` WHERE pdft ILIKE $1 OR clave::text ILIKE $1`;
    }

    query += ` ORDER BY pdft LIMIT 50`;
    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (error: any) {
    return res.status(500).json({ error: "Error al obtener productos SAT" });
  }
};

// ── GET /proveedores/:id/domicilio ────────────────────────────────────────────
export const getDomicilioProveedor = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT * FROM proveedor_domicilio WHERE proveedor_idproveedor = $1 LIMIT 1`,
      [id]
    );
    return res.json(rows[0] ?? null);
  } catch (error: any) {
    return res.status(500).json({ error: "Error al obtener domicilio" });
  }
};

// ── PUT /proveedores/:id/domicilio ────────────────────────────────────────────
export const upsertDomicilioProveedor = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { codigo_postal, colonia, domicilio, municipio, estado } = req.body;

    const { rows: existe } = await pool.query(
      `SELECT idproveedor_domicilio FROM proveedor_domicilio WHERE proveedor_idproveedor = $1`,
      [id]
    );

    let result;
    if (existe.length > 0) {
      result = await pool.query(
        `UPDATE proveedor_domicilio SET
           codigo_postal = $1, colonia = $2, domicilio = $3, municipio = $4, estado = $5
         WHERE proveedor_idproveedor = $6
         RETURNING *`,
        [codigo_postal || null, colonia || null, domicilio || null, municipio || null, estado || null, id]
      );
    } else {
      result = await pool.query(
        `INSERT INTO proveedor_domicilio
           (proveedor_idproveedor, codigo_postal, colonia, domicilio, municipio, estado)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [id, codigo_postal || null, colonia || null, domicilio || null, municipio || null, estado || null]
      );
    }
    return res.json({ message: "Domicilio guardado", domicilio: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: "Error al guardar domicilio" });
  }
};

// ── GET /proveedores/:id/facturacion ──────────────────────────────────────────
export const getFacturacionProveedor = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT * FROM proveedor_facturacion
       WHERE proveedor_idproveedor = $1 AND activo = true
       ORDER BY created_at`,
      [id]
    );
    return res.json(rows);
  } catch (error: any) {
    return res.status(500).json({ error: "Error al obtener facturación" });
  }
};

// ── POST /proveedores/:id/facturacion ─────────────────────────────────────────
export const crearFacturacionProveedor = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { banco, cuenta, clabe, convenio, nombre_cuenta, condicion_compra, dias_credito } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO proveedor_facturacion
  (proveedor_idproveedor, banco, cuenta, clabe, convenio, nombre_cuenta, condicion_compra, dias_credito)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
RETURNING *`,
      [id, banco || null, cuenta || null, clabe || null, convenio || null, nombre_cuenta || null, condicion_compra || null, dias_credito || null]
    );
    return res.status(201).json({ message: "Facturación creada", facturacion: rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: "Error al crear facturación" });
  }
};

// ── PUT /proveedores/:id/facturacion/:idFact ──────────────────────────────────
export const actualizarFacturacionProveedor = async (req: Request, res: Response) => {
  try {
    const { idFact } = req.params;
    const { banco, cuenta, clabe, convenio, nombre_cuenta, condicion_compra, activo, dias_credito } = req.body;

    const { rowCount, rows } = await pool.query(
      `UPDATE proveedor_facturacion SET
  banco=$1, cuenta=$2, clabe=$3, convenio=$4,
  nombre_cuenta=$5, condicion_compra=$6, activo=$7, dias_credito=$8
WHERE idproveedor_facturacion=$9
       RETURNING *`,
      [banco || null, cuenta || null, clabe || null, convenio || null,
      nombre_cuenta || null, condicion_compra || null,
      activo !== undefined ? activo : true, dias_credito || null, idFact]
    );
    if (rowCount === 0) return res.status(404).json({ error: "Registro no encontrado" });
    return res.json({ message: "Facturación actualizada", facturacion: rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: "Error al actualizar facturación" });
  }
};

// ── DELETE /proveedores/:id/facturacion/:idFact ───────────────────────────────
export const eliminarFacturacionProveedor = async (req: Request, res: Response) => {
  try {
    const { idFact } = req.params;
    await pool.query(
      `UPDATE proveedor_facturacion SET activo = false WHERE idproveedor_facturacion = $1`,
      [idFact]
    );
    return res.json({ message: "Facturación eliminada" });
  } catch (error: any) {
    return res.status(500).json({ error: "Error al eliminar facturación" });
  }
};

// PUT /proveedores/:id/completo
export const guardarProveedorCompleto = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { id } = req.params;
    const { general, domicilio, facturacion } = req.body;

    // 1. Actualizar datos generales
    const { rows: provRows } = await client.query(
  `UPDATE proveedor SET
     nombre=$1, contacto=$2, telefono=$3, correo=$4,
     notas=$5, rfc_proveedor=$6, regimen_fiscal_idregimen_fiscal=$7
   WHERE idproveedor=$8 RETURNING *`,
  [
    general.nombre?.trim(), general.contacto || null, general.telefono || null,
    general.correo || null, general.notas || null, general.rfc_proveedor || null,
    general.regimen_fiscal_idregimen_fiscal || null, id
  ]
);
    // 2. Upsert domicilio
    const { rows: domExiste } = await client.query(
      `SELECT idproveedor_domicilio FROM proveedor_domicilio WHERE proveedor_idproveedor = $1`, [id]
    );
    if (domExiste.length > 0) {
      await client.query(
        `UPDATE proveedor_domicilio SET codigo_postal=$1, colonia=$2, domicilio=$3, municipio=$4, estado=$5
         WHERE proveedor_idproveedor=$6`,
        [domicilio.codigo_postal || null, domicilio.colonia || null, domicilio.domicilio || null,
        domicilio.municipio || null, domicilio.estado || null, id]
      );
    } else {
      await client.query(
        `INSERT INTO proveedor_domicilio (proveedor_idproveedor,codigo_postal,colonia,domicilio,municipio,estado)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, domicilio.codigo_postal || null, domicilio.colonia || null, domicilio.domicilio || null,
          domicilio.municipio || null, domicilio.estado || null]
      );
    }

    // 3. Insertar registros nuevos de facturación
    for (const f of (facturacion ?? [])) {
      if (f.idproveedor_facturacion) {
        await client.query(
          `UPDATE proveedor_facturacion SET banco=$1,cuenta=$2,clabe=$3,convenio=$4,nombre_cuenta=$5,condicion_compra=$6,dias_credito=$7
           WHERE idproveedor_facturacion=$8`,
          [f.banco || null, f.cuenta || null, f.clabe || null, f.convenio || null,
          f.nombre_cuenta || null, f.condicion_compra || null, f.dias_credito || null, f.idproveedor_facturacion]
        );
      } else {
        await client.query(
          `INSERT INTO proveedor_facturacion (proveedor_idproveedor,banco,cuenta,clabe,convenio,nombre_cuenta,condicion_compra,dias_credito)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, f.banco || null, f.cuenta || null, f.clabe || null, f.convenio || null,
            f.nombre_cuenta || null, f.condicion_compra || null, f.dias_credito || null]
        );
      }
    }

    await client.query("COMMIT");
    return res.json({ message: "Proveedor guardado", proveedor: provRows[0] });
  } catch (error: any) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: "Error al guardar proveedor" });
  } finally {
    client.release();
  }
};