import { Request, Response } from "express";
import { pool } from "../../config/db";
import {
  sincronizarEspejoSiAplica,
  sincronizarEspejoDesdeInsumo,
  desactivarInsumoCompleto,
  reactivarInsumoCompleto,
} from "../../services/insumoCatalogoBridge";

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

// ═══════════════════════════════════════════════════════════════════════════════
// GET /proveedores  (lista con total_productos)
// ═══════════════════════════════════════════════════════════════════════════════
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
        COALESCE(ins.total, 0) + COALESCE(fo.total, 0) AS total_productos,
        pf.condicion_compra,
        pf.dias_credito
      FROM proveedor p
      LEFT JOIN regimen_fiscal rf ON rf.idregimen_fiscal = p.regimen_fiscal_idregimen_fiscal
      LEFT JOIN (
        SELECT proveedor_idproveedor, COUNT(*)::int AS total
        FROM insumo_proveedor
        WHERE activo = true
        GROUP BY proveedor_idproveedor
      ) ins ON ins.proveedor_idproveedor = p.idproveedor
      LEFT JOIN (
        SELECT proveedor_idproveedor, COUNT(*)::int AS total
        FROM foil_proveedor
        WHERE activo = true
        GROUP BY proveedor_idproveedor
      ) fo ON fo.proveedor_idproveedor = p.idproveedor
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
    query += ` ORDER BY p.nombre`;

    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET PROVEEDORES ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener proveedores" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /proveedores/:id  (detalle + lista de sus productos)
// ═══════════════════════════════════════════════════════════════════════════════
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
         ip.idinsumo_proveedor AS idproveedor_producto,
         i.idinsumo,
         i.nombre,
         ip.codigo,
         ip.precio,
         ip.notas,
         ip.activo,
         i.activo AS insumo_activo,
         i.clave_producto,
         ip.minimo_compra,
         i.unidad,
         i.producto_sat_idproducto_sat,
         ps.clave  AS producto_sat_clave,
         ps.pdft   AS producto_sat_nombre,
         ti.idtipo_insumo,
         ti.nombre AS tipo_insumo_nombre
       FROM insumo_proveedor ip
       JOIN insumo i       ON i.idinsumo = ip.insumo_idinsumo
       JOIN tipo_insumo ti ON ti.idtipo_insumo = i.tipo_insumo_id
       LEFT JOIN producto_sat ps ON ps.idproducto_sat = i.producto_sat_idproducto_sat
       WHERE ip.proveedor_idproveedor = $1
       ORDER BY ti.nombre, i.nombre`,
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
// GET /proveedores/:id/productos  (lista de productos de ESE proveedor)
// ═══════════════════════════════════════════════════════════════════════════════
export const getProductosProveedor = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { tipo } = req.query;

    let query = `
      SELECT
        ip.idinsumo_proveedor AS idproveedor_producto,
        i.nombre,
        ip.codigo,
        ip.precio,
        ip.notas,
        ip.activo,
        i.clave_producto,
        ip.minimo_compra,
        i.unidad,
        i.producto_sat_idproducto_sat,
        ps.clave  AS producto_sat_clave,
        ps.pdft   AS producto_sat_nombre,
        ti.idtipo_insumo,
        ti.nombre AS tipo_insumo_nombre,
        pv.nombre AS proveedor_nombre
      FROM insumo_proveedor ip
      JOIN insumo i       ON i.idinsumo = ip.insumo_idinsumo
      JOIN tipo_insumo ti ON ti.idtipo_insumo = i.tipo_insumo_id
      JOIN proveedor pv   ON pv.idproveedor   = ip.proveedor_idproveedor
      LEFT JOIN producto_sat ps ON ps.idproducto_sat = i.producto_sat_idproducto_sat
      WHERE ip.proveedor_idproveedor = $1 AND ip.activo = true
    `;
    const params: any[] = [id];

    if (tipo) {
      params.push(tipo);
      query += ` AND i.tipo_insumo_id = $${params.length}`;
    }

    query += ` ORDER BY ti.nombre, i.nombre`;

    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET PRODUCTOS PROVEEDOR ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener productos del proveedor" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /proveedores/insumos  (búsqueda global — AGRUPADA por insumo)
// ═══════════════════════════════════════════════════════════════════════════════
export const buscarInsumos = async (req: Request, res: Response) => {
  try {
    const { tipo, q, activo } = req.query;
    // Por defecto solo activos (comportamiento previo intacto); activo=false
    // permite listar los desactivados para el toggle "ver inactivos".
    const filtroActivo = activo === "false" ? false : true;

    let query = `
      SELECT
        i.idinsumo,
        i.nombre,
        i.clave_producto,
        i.unidad,
        i.activo,
        ti.idtipo_insumo,
        ti.nombre AS tipo_insumo_nombre,
        COALESCE(
          json_agg(
            json_build_object(
              'idinsumo_proveedor', ip.idinsumo_proveedor,
              'idproveedor', pv.idproveedor,
              'proveedor_nombre', pv.nombre,
              'codigo', ip.codigo,
              'precio', ip.precio
            )
            ORDER BY pv.nombre
          ) FILTER (WHERE ip.idinsumo_proveedor IS NOT NULL),
          '[]'
        ) AS proveedores
      FROM insumo i
      JOIN tipo_insumo ti ON ti.idtipo_insumo = i.tipo_insumo_id
      LEFT JOIN insumo_proveedor ip
        ON ip.insumo_idinsumo = i.idinsumo AND ip.activo = true
      LEFT JOIN proveedor pv
        ON pv.idproveedor = ip.proveedor_idproveedor AND pv.activo = true
      WHERE i.activo = $1
    `;
    const params: any[] = [filtroActivo];

    if (tipo) {
      params.push(tipo);
      query += ` AND i.tipo_insumo_id = $${params.length}`;
    }

    if (q) {
      params.push(`%${q}%`);
      query += ` AND (i.nombre ILIKE $${params.length} OR ip.codigo ILIKE $${params.length})`;
    }

    query += `
      GROUP BY i.idinsumo, i.nombre, i.clave_producto, i.unidad, i.activo, ti.idtipo_insumo, ti.nombre
      ORDER BY i.nombre
      LIMIT 50
    `;

    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ BUSCAR INSUMOS ERROR:", error.message);
    return res.status(500).json({ error: "Error al buscar insumos" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /proveedores/:id/productos  (agregar insumo a ESE proveedor)
// ✅ Ahora, si el tipo de insumo corresponde a un catálogo de papel
// sincronizado (Tipo de papel, Pegamento, Laminado, Sacabocados, Perforado,
// Matrix), se crea/actualiza automáticamente su espejo en cat_*.
// ═══════════════════════════════════════════════════════════════════════════════
export const crearProductoProveedor = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { id } = req.params;
    const {
      tipo_insumo_id, nombre, codigo, precio, notas,
      clave_producto, minimo_compra, unidad,
      producto_sat_idproducto_sat
    } = req.body;

    if (!tipo_insumo_id || !nombre?.trim()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "tipo_insumo_id y nombre son requeridos" });
    }

    const { rows: prov } = await client.query(
      `SELECT idproveedor FROM proveedor WHERE idproveedor = $1 AND activo = true`, [id]
    );
    if (prov.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Proveedor no encontrado" });
    }

    // Busca o crea la identidad del insumo (compartida entre proveedores)
    const { rows: insumoExiste } = await client.query(
      `SELECT idinsumo FROM insumo
       WHERE tipo_insumo_id = $1 AND LOWER(TRIM(nombre)) = LOWER(TRIM($2))`,
      [tipo_insumo_id, nombre.trim()]
    );

    let idinsumo: number;
    if (insumoExiste.length > 0) {
      idinsumo = insumoExiste[0].idinsumo;
      await client.query(
        `UPDATE insumo SET
           clave_producto = COALESCE($1, clave_producto),
           unidad = COALESCE($2, unidad),
           producto_sat_idproducto_sat = COALESCE($3, producto_sat_idproducto_sat)
         WHERE idinsumo = $4`,
        [clave_producto?.trim() || null, unidad || null, producto_sat_idproducto_sat || null, idinsumo]
      );
    } else {
      const { rows: nuevoInsumo } = await client.query(
        `INSERT INTO insumo (tipo_insumo_id, nombre, clave_producto, unidad, producto_sat_idproducto_sat)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING idinsumo`,
        [tipo_insumo_id, nombre.trim(), clave_producto?.trim() || null, unidad || null, producto_sat_idproducto_sat || null]
      );
      idinsumo = nuevoInsumo[0].idinsumo;
    }

    // ✅ Sincroniza espejo en cat_* si el tipo de insumo aplica
    await sincronizarEspejoSiAplica(client, idinsumo, tipo_insumo_id, nombre.trim());

    const { rows: yaExiste } = await client.query(
      `SELECT idinsumo_proveedor FROM insumo_proveedor
       WHERE insumo_idinsumo = $1 AND proveedor_idproveedor = $2`,
      [idinsumo, id]
    );
    if (yaExiste.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Este proveedor ya tiene registrado este insumo" });
    }

    const { rows } = await client.query(
      `INSERT INTO insumo_proveedor
         (insumo_idinsumo, proveedor_idproveedor, codigo, precio, notas, minimo_compra)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        idinsumo, id,
        codigo?.trim() || null,
        precio != null ? Number(precio) : null,
        notas?.trim() || null,
        minimo_compra != null ? Number(minimo_compra) : null,
      ]
    );

    await client.query("COMMIT");
    console.log(`✅ Producto creado: ${rows[0].idinsumo_proveedor} — ${nombre.trim()}`);
    return res.status(201).json({
      message: "Producto creado",
      producto: { ...rows[0], nombre: nombre.trim(), idproveedor_producto: rows[0].idinsumo_proveedor },
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ CREAR PRODUCTO PROVEEDOR ERROR:", error.message);
    return res.status(500).json({ error: "Error al crear producto" });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// PUT /proveedores/:id/productos/:idProducto
// ✅ Si se renombra el insumo y su tipo es un catálogo sincronizado, el
// espejo en cat_* se actualiza también.
// ═══════════════════════════════════════════════════════════════════════════════
export const actualizarProductoProveedor = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { idProducto } = req.params; // = idinsumo_proveedor
    const {
      tipo_insumo_id, nombre, codigo, precio, notas, activo,
      clave_producto, minimo_compra, unidad,
      producto_sat_idproducto_sat
    } = req.body;

    if (!tipo_insumo_id || !nombre?.trim()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "tipo_insumo_id y nombre son requeridos" });
    }

    const { rows: ipRows } = await client.query(
      `SELECT insumo_idinsumo FROM insumo_proveedor WHERE idinsumo_proveedor = $1`,
      [idProducto]
    );
    if (ipRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Producto no encontrado" });
    }
    const idinsumo = ipRows[0].insumo_idinsumo;

    // NOTA: esto actualiza la identidad del insumo, que es COMPARTIDA.
    // Si el insumo tiene otros proveedores, también verán este cambio de nombre.
    await client.query(
      `UPDATE insumo SET
         tipo_insumo_id = $1,
         nombre = $2,
         clave_producto = $3,
         unidad = $4,
         producto_sat_idproducto_sat = $5
       WHERE idinsumo = $6`,
      [
        tipo_insumo_id, nombre.trim(),
        clave_producto?.trim() || null,
        unidad || null,
        producto_sat_idproducto_sat || null,
        idinsumo,
      ]
    );

    // ✅ Sincroniza espejo en cat_* (rename) si el tipo de insumo aplica
    await sincronizarEspejoSiAplica(client, idinsumo, tipo_insumo_id, nombre.trim());

    const { rows } = await client.query(
      `UPDATE insumo_proveedor SET
         codigo = $1,
         precio = $2,
         notas = $3,
         activo = $4,
         minimo_compra = $5
       WHERE idinsumo_proveedor = $6
       RETURNING *`,
      [
        codigo?.trim() || null,
        precio != null ? Number(precio) : null,
        notas?.trim() || null,
        activo !== undefined ? activo : true,
        minimo_compra != null ? Number(minimo_compra) : null,
        idProducto,
      ]
    );

    await client.query("COMMIT");
    return res.json({
      message: "Producto actualizado",
      producto: { ...rows[0], nombre: nombre.trim(), idproveedor_producto: rows[0].idinsumo_proveedor },
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ ACTUALIZAR PRODUCTO PROVEEDOR ERROR:", error.message);
    return res.status(500).json({ error: "Error al actualizar producto" });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /proveedores/:id/productos/:idProducto → desactiva SOLO ese vínculo
// insumo-proveedor (el insumo puede seguir teniendo otros proveedores activos).
// Para desactivar el INSUMO completo, usa desactivarInsumo más abajo.
// ═══════════════════════════════════════════════════════════════════════════════
export const eliminarProductoProveedor = async (req: Request, res: Response) => {
  try {
    const { idProducto } = req.params; // = idinsumo_proveedor
    const { rowCount } = await pool.query(
      `UPDATE insumo_proveedor SET activo = false WHERE idinsumo_proveedor = $1`,
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
// ✅ NUEVO — PATCH /proveedores/insumos/:idinsumo  (desactivar INSUMO completo)
// Esto es distinto de eliminarProductoProveedor: aquí se da de baja el insumo
// en sí (independiente de con cuántos proveedores esté vinculado), y si su
// tipo corresponde a un catálogo de papel sincronizado, también se desactiva
// su espejo en cat_*. Nunca se borra información de la base de datos.
// ═══════════════════════════════════════════════════════════════════════════════
export const desactivarInsumo = async (req: Request, res: Response) => {
  try {
    const { idinsumo } = req.params;
    const resultado = await desactivarInsumoCompleto(Number(idinsumo));
    if (!resultado) return res.status(404).json({ error: "Insumo no encontrado" });
    console.log(`✅ Insumo desactivado: ${resultado.idinsumo} — ${resultado.nombre}`);
    return res.json({ message: "Insumo desactivado", insumo: resultado });
  } catch (error: any) {
    console.error("❌ DESACTIVAR INSUMO ERROR:", error.message);
    return res.status(500).json({ error: "Error al desactivar insumo" });
  }
};

// ✅ NUEVO — PATCH /proveedores/insumos/:idinsumo/reactivar
export const reactivarInsumo = async (req: Request, res: Response) => {
  try {
    const { idinsumo } = req.params;
    const resultado = await reactivarInsumoCompleto(Number(idinsumo));
    if (!resultado) return res.status(404).json({ error: "Insumo no encontrado o ya está activo" });
    console.log(`✅ Insumo reactivado: ${resultado.idinsumo} — ${resultado.nombre}`);
    return res.json({ message: "Insumo reactivado", insumo: resultado });
  } catch (error: any) {
    console.error("❌ REACTIVAR INSUMO ERROR:", error.message);
    return res.status(500).json({ error: "Error al reactivar insumo" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /proveedores/insumos/registrar-rapido  ← ahora acepta varios proveedores
// ✅ También sincroniza espejo en cat_* si el tipo de insumo aplica.
// ═══════════════════════════════════════════════════════════════════════════════
export const registrarInsumoRapido = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const {
      tipo_insumo_id, nombre, codigo, proveedores_ids,
      precio, notas, clave_producto, minimo_compra, unidad,
      producto_sat_idproducto_sat,
    } = req.body;
 
    if (!tipo_insumo_id || !nombre?.trim()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "tipo_insumo_id y nombre son requeridos" });
    }
 
    const idsProveedores: number[] = Array.isArray(proveedores_ids)
      ? proveedores_ids.map(Number).filter((n) => !Number.isNaN(n))
      : [];
 
    const { rows: existentes } = await client.query(
      `SELECT idinsumo, nombre FROM insumo
       WHERE tipo_insumo_id = $1 AND LOWER(TRIM(nombre)) = LOWER(TRIM($2))
       LIMIT 1`,
      [tipo_insumo_id, nombre.trim()]
    );
    if (existentes.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Ya existe un insumo con ese nombre para este tipo.",
        existente: existentes[0],
      });
    }
 
    if (codigo?.trim()) {
      const { rows: existentesCodigo } = await client.query(
        `SELECT i.idinsumo, i.nombre, ip.codigo
         FROM insumo_proveedor ip
         JOIN insumo i ON i.idinsumo = ip.insumo_idinsumo
         WHERE i.tipo_insumo_id = $1
           AND LOWER(TRIM(ip.codigo)) = LOWER(TRIM($2))
           AND ip.activo = true
         LIMIT 1`,
        [tipo_insumo_id, codigo.trim()]
      );
      if (existentesCodigo.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `Ya existe un insumo con el código "${codigo.trim()}".`,
          existente: existentesCodigo[0],
        });
      }
    }
 
    // ✅ NUEVO: clave_producto, unidad y producto_sat ahora sí se guardan
    const { rows: nuevoInsumo } = await client.query(
      `INSERT INTO insumo (tipo_insumo_id, nombre, clave_producto, unidad, producto_sat_idproducto_sat, activo)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING *`,
      [
        tipo_insumo_id,
        nombre.trim(),
        clave_producto?.trim() || null,
        unidad || null,
        producto_sat_idproducto_sat || null,
      ]
    );
    const insumo = nuevoInsumo[0];
 
    await sincronizarEspejoSiAplica(client, insumo.idinsumo, tipo_insumo_id, nombre.trim());
 
    const precioFinal = precio !== undefined && precio !== null && precio !== "" ? Number(precio) : null;
    const notasFinal = notas?.trim() || null;
    const minimoFinal = minimo_compra !== undefined && minimo_compra !== null && minimo_compra !== "" ? Number(minimo_compra) : null;
 
    const proveedoresCreados: any[] = [];
    if (idsProveedores.length > 0) {
      const { rows: provRows } = await client.query(
        `SELECT idproveedor, nombre FROM proveedor
         WHERE idproveedor = ANY($1::int[]) AND activo = true`,
        [idsProveedores]
      );
      for (const prov of provRows) {
        // ✅ NUEVO: precio, notas y minimo_compra ahora se guardan (mismo
        // valor para todos los proveedores marcados, igual que en Foil)
        const { rows: ipRows } = await client.query(
          `INSERT INTO insumo_proveedor (insumo_idinsumo, proveedor_idproveedor, codigo, precio, notas, minimo_compra, activo)
           VALUES ($1, $2, $3, $4, $5, $6, true)
           ON CONFLICT (insumo_idinsumo, proveedor_idproveedor) DO NOTHING
           RETURNING *`,
          [insumo.idinsumo, prov.idproveedor, codigo?.trim() || null, precioFinal, notasFinal, minimoFinal]
        );
        if (ipRows.length > 0) {
          proveedoresCreados.push({
            idinsumo_proveedor: ipRows[0].idinsumo_proveedor,
            idproveedor: prov.idproveedor,
            proveedor_nombre: prov.nombre,
            codigo: ipRows[0].codigo,
            precio: ipRows[0].precio,
          });
        }
      }
    }
 
    await client.query("COMMIT");
 
    const resultado = {
      idinsumo: insumo.idinsumo,
      nombre: insumo.nombre,
      clave_producto: insumo.clave_producto,
      unidad: insumo.unidad,
      idtipo_insumo: tipo_insumo_id,
      proveedores: proveedoresCreados,
    };
 
    console.log(`✅ Insumo rápido creado: ${insumo.idinsumo} — ${insumo.nombre} (${proveedoresCreados.length} proveedor/es)`);
    return res.status(201).json({ message: "Insumo registrado", producto: resultado });
 
  } catch (error: any) {
    await client.query("ROLLBACK");
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

// ═══════════════════════════════════════════════════════════════════════════════
// POST /proveedores/:id/foil  ← ahora acepta varios proveedores
// ═══════════════════════════════════════════════════════════════════════════════
export const crearFoil = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
 
    const { id } = req.params; // idproveedor "principal" (compatibilidad con la ruta actual)
    const {
      colorfoil, codigofoil, presentaciones, proveedores_ids,
      precio, notas, minimo_compra, unidad,
      producto_sat_idproducto_sat, // ✅ NUEVO
    } = req.body;
 
    if (!colorfoil?.trim()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "colorfoil es requerido" });
    }
 
    const idsProveedores: number[] = Array.isArray(proveedores_ids) && proveedores_ids.length > 0
      ? proveedores_ids.map(Number)
      : [Number(id)];
 
    const { rows: provRows } = await client.query(
      `SELECT idproveedor, nombre FROM proveedor WHERE idproveedor = ANY($1::int[]) AND activo = true`,
      [idsProveedores]
    );
    if (provRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Proveedor no encontrado" });
    }
 
    const clavefoil = [
      provRows[0].nombre.substring(0, 2).toUpperCase(),
      colorfoil.trim().substring(0, 3).toUpperCase(),
      codigofoil?.trim() ?? "",
    ].join("");
 
    // ✅ NUEVO: producto_sat_idproducto_sat se guarda desde la creación
    const { rows: foilRows } = await client.query(
      `INSERT INTO foil (colorfoil, codigofoil, clavefoil, producto_sat_idproducto_sat)
       VALUES ($1, $2, $3, $4)
       RETURNING idfoil`,
      [colorfoil.trim(), codigofoil?.trim() || null, clavefoil, producto_sat_idproducto_sat || null]
    );
    const idfoil = foilRows[0].idfoil;
 
    const precioFinal = precio !== undefined && precio !== null && precio !== "" ? Number(precio) : null;
    const notasFinal = notas?.trim() || null;
    const minimoFinal = minimo_compra !== undefined && minimo_compra !== null && minimo_compra !== "" ? Number(minimo_compra) : null;
    const unidadFinal = unidad || null;
 
    for (const prov of provRows) {
      // ✅ De paso, esto también arregla que antes precio/notas/minimo/unidad
      // no se guardaban al CREAR (solo se guardaban al editar) — ahora sí.
      await client.query(
        `INSERT INTO foil_proveedor (idfoil, proveedor_idproveedor, codigo, precio, notas, minimo_compra, unidad)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (idfoil, proveedor_idproveedor) DO NOTHING`,
        [idfoil, prov.idproveedor, codigofoil?.trim() || null, precioFinal, notasFinal, minimoFinal, unidadFinal]
      );
    }
 
    for (const p of (presentaciones ?? [])) {
      if (!p?.trim()) continue;
      await client.query(
        `INSERT INTO foil_presentacion (idfoil, presentacion) VALUES ($1, $2)`,
        [idfoil, p.trim()]
      );
    }
 
    await client.query("COMMIT");
 
    console.log(`✅ Foil creado: ${idfoil} — ${clavefoil}`);
    return res.status(201).json({
      message: "Foil registrado",
      idfoil,
      clavefoil,
      proveedores: provRows.map((p) => p.idproveedor),
    });
 
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ CREAR FOIL ERROR:", error.message);
    return res.status(500).json({ error: "Error al registrar foil", detalle: error.message });
  } finally {
    client.release();
  }
};

