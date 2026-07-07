import { Request, Response } from "express";
import { pool } from "../../config/db";

// ══════════════════════════════════════════════════════════════════════════
// OBTENER CATÁLOGOS PLÁSTICO (solo activos — para usar en el selector del
// formulario de alta/edición de producto)
// ══════════════════════════════════════════════════════════════════════════
export const getCatalogosPlastico = async (req: Request, res: Response) => {
  try {
    console.log("📋 Obteniendo catálogos de productos plástico");

    const [tiposProducto, materiales, calibres] = await Promise.all([
      pool.query(`
        SELECT
          idtipo_producto_plastico as id,
          material_plastico_producto as nombre,
          productos_idProductos as producto_id
        FROM tipo_producto_plastico
        WHERE activo = true
        ORDER BY material_plastico_producto ASC
      `),
      pool.query(`
        SELECT
          idmaterial_plastico as id,
          tipo_material as nombre,
          valor
        FROM material_plastico
        WHERE activo = true
        ORDER BY tipo_material ASC
      `),
      pool.query(`
        SELECT
          idcalibre as id,
          calibre as valor
        FROM calibre
        WHERE activo = true
        ORDER BY calibre ASC
      `),
    ]);

    console.log("✅ Catálogos obtenidos exitosamente");

    res.json({
      tiposProducto: tiposProducto.rows,
      materiales: materiales.rows,
      calibres: calibres.rows,
    });
  } catch (error: any) {
    console.error("❌ GET CATÁLOGOS PLÁSTICO ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener catálogos" });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// OBTENER CALIBRES (NORMAL O BOPP) — solo activos
// ══════════════════════════════════════════════════════════════════════════
export const getCalibres = async (req: Request, res: Response) => {
  try {
    const { tipo } = req.query;

    console.log("📋 Obteniendo calibres:", { tipo });

    let query = "";

    if (tipo === "bopp") {
      query = `
        SELECT
          idcalibre as id,
          calibre_bopp as valor,
          gramos
        FROM calibre
        WHERE calibre_bopp IS NOT NULL AND activo = true
        ORDER BY calibre_bopp ASC
      `;
    } else {
      query = `
        SELECT
          idcalibre as id,
          calibre as valor
        FROM calibre
        WHERE activo = true
        ORDER BY calibre ASC
      `;
    }

    const result = await pool.query(query);

    console.log(`✅ Calibres obtenidos (${tipo || "normal"}): ${result.rowCount}`);

    res.json(result.rows);
  } catch (error: any) {
    console.error("❌ GET CALIBRES ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener calibres" });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// HELPER: SELECT base con CASE para calibre BOPP (solo productos activos)
// ══════════════════════════════════════════════════════════════════════════
const SELECT_PRODUCTO = `
  SELECT
    cp.idconfiguracion_plastico AS id,
    cp.altura,
    cp.fuelle_fondo,
    cp.refuerzo,
    cp.ancho,
    cp.fuelle_latIz  AS fuelle_lateral_izquierdo,
    cp.fuelle_latDe  AS fuelle_lateral_derecho,
    cp.medida,
    cp.por_kilo,
    tpp.material_plastico_producto AS tipo_producto,
    mp.tipo_material               AS material,

    CASE
      WHEN UPPER(mp.tipo_material) = 'BOPP' AND c.calibre_bopp IS NOT NULL
        THEN c.calibre_bopp
      ELSE c.calibre
    END AS calibre,

    CASE
      WHEN UPPER(mp.tipo_material) = 'BOPP'
        THEN c.gramos
      ELSE NULL
    END AS gramos,

    cp.tipo_producto_plastico_plastico_idtipo_producto_plastico AS tipo_producto_id,
    cp.material_plastico_plastico_idmaterial_plastico            AS material_id,
    cp.calibre_idcalibre                                         AS calibre_id
  FROM configuracion_plastico cp
  INNER JOIN tipo_producto_plastico tpp
    ON cp.tipo_producto_plastico_plastico_idtipo_producto_plastico = tpp.idtipo_producto_plastico
  INNER JOIN material_plastico mp
    ON cp.material_plastico_plastico_idmaterial_plastico = mp.idmaterial_plastico
  INNER JOIN calibre c
    ON cp.calibre_idcalibre = c.idcalibre
  WHERE cp.activo = true
`;

// ══════════════════════════════════════════════════════════════════════════
// BUSCAR PRODUCTOS PLÁSTICO
// ══════════════════════════════════════════════════════════════════════════
export const searchProductosPlastico = async (req: Request, res: Response) => {
  try {
    const { query } = req.query;

    console.log("🔍 Buscando productos plástico:", { query });

    if (!query || typeof query !== "string" || query.trim() === "") {
      const result = await pool.query(`
        ${SELECT_PRODUCTO}
        ORDER BY cp.idconfiguracion_plastico DESC
        LIMIT 50
      `);
      console.log(`✅ Últimos 50 productos obtenidos: ${result.rowCount}`);
      return res.json(result.rows);
    }

    const searchTerm = `%${query.trim()}%`;

    const result = await pool.query(
      `
      ${SELECT_PRODUCTO}
        AND (
          cp.medida ILIKE $1 OR
          tpp.material_plastico_producto ILIKE $1 OR
          mp.tipo_material ILIKE $1 OR
          CAST(
            CASE
              WHEN UPPER(mp.tipo_material) = 'BOPP' AND c.calibre_bopp IS NOT NULL
                THEN c.calibre_bopp
              ELSE c.calibre
            END
          AS TEXT) ILIKE $1
        )
      ORDER BY cp.idconfiguracion_plastico DESC
      LIMIT 50
      `,
      [searchTerm]
    );

    console.log(`✅ Productos encontrados: ${result.rowCount}`);
    res.json(result.rows);
  } catch (error: any) {
    console.error("❌ SEARCH PRODUCTOS PLÁSTICO ERROR:", error.message);
    res.status(500).json({ error: "Error al buscar productos" });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// VERIFICAR SI PRODUCTO EXISTE (por combinación exacta, solo activos)
// ══════════════════════════════════════════════════════════════════════════
export const verificarProductoExiste = async (req: Request, res: Response) => {
  try {
    const { tipo_producto_id, material_id, calibre_id, medida } = req.body;

    console.log("🔍 Verificando si producto existe:", {
      tipo_producto_id, material_id, calibre_id, medida,
    });

    const result = await pool.query(
      `
      SELECT
        cp.idconfiguracion_plastico as id,
        cp.medida,
        cp.por_kilo
      FROM configuracion_plastico cp
      WHERE
        cp.tipo_producto_plastico_plastico_idtipo_producto_plastico = $1 AND
        cp.material_plastico_plastico_idmaterial_plastico = $2 AND
        cp.calibre_idcalibre = $3 AND
        cp.medida = $4 AND
        cp.activo = true
      LIMIT 1
      `,
      [tipo_producto_id, material_id, calibre_id, medida]
    );

    if (result.rowCount && result.rowCount > 0) {
      console.log("✅ Producto existe:", result.rows[0]);
      return res.json({ existe: true, producto: result.rows[0] });
    }

    console.log("ℹ️ Producto no existe");
    res.json({ existe: false, producto: null });
  } catch (error: any) {
    console.error("❌ VERIFICAR PRODUCTO ERROR:", error.message);
    res.status(500).json({ error: "Error al verificar producto" });
  }
};