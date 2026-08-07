// src/controllers/cotizadorLibre/cotizadorLibreCatalogo.controller.ts
import { Request, Response } from "express";
import { pool } from "../../config/db";

// ============================================================================
// ⚠️ productos.idproductos = 1 corresponde a 'Plástico' — confirmado contra
// datos reales (SELECT idproductos, tipo_producto FROM productos), no por
// nombre de texto, para evitar problemas de codificación de acentos.
// Si algún día se reordena esa tabla catálogo, ajustar esta constante.
// ============================================================================
const ID_PRODUCTOS_PLASTICO = 1;

// ==========================
// 1. TIPOS (categoría "Tipo" — Bolsas, Cajas, Sobres, Etiquetas, etc.)
// ==========================
export const getTiposCotizadorLibre = async (req: Request, res: Response) => {
  try {
    const categoria = String(req.query.categoria || "");

    if (categoria === "papel") {
      const { rows } = await pool.query(
        `SELECT idcat_tipo_producto_papel AS id, nombre
         FROM cat_tipo_producto_papel
         WHERE activo = true
         ORDER BY nombre`
      );
      return res.json(rows);
    }

    if (categoria === "plastico") {
      // Solo se muestra al público lo que ya es un tipo de bolsa terminado
      // (Bolsa plana, troquelada, envíos, celofán, asa flexible...). El
      // resto (Bobina, Rollo perforado, Faldón, Lámina) son tipos que
      // todavía no están configurados como producto — no es que sean
      // materia prima, simplemente aún no tienen esa configuración. Filtro
      // dinámico por nombre, sin lista de IDs fija: cualquier tipo nuevo
      // que se llame "Bolsa ..." aparece solo, sin tocar este código.
      const { rows } = await pool.query(
        `SELECT t.idtipo_producto_plastico AS id, t.material_plastico_producto AS nombre
         FROM tipo_producto_plastico t
         WHERE t.activo = true
           AND t.productos_idproductos = $1
           AND LOWER(t.material_plastico_producto) LIKE '%bolsa%'
         ORDER BY t.material_plastico_producto`,
        [ID_PRODUCTOS_PLASTICO]
      );
      return res.json(rows);
    }

    return res.status(400).json({ error: "categoria debe ser 'papel' o 'plastico'." });
  } catch (error: any) {
    console.error("❌ GET TIPOS COTIZADOR LIBRE ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener el catálogo de tipos." });
  }
};

// ==========================
// 2. MEDIDAS (productos reales filtrados por tipo — la "medida" ES el
// producto específico, no un catálogo separado)
// ==========================
export const getMedidasCotizadorLibre = async (req: Request, res: Response) => {
  try {
    const categoria = String(req.query.categoria || "");
    const idTipo = Number(req.query.idTipo);

    if (!Number.isInteger(idTipo) || idTipo <= 0) {
      return res.status(400).json({ error: "idTipo es requerido y debe ser válido." });
    }

    if (categoria === "papel") {
      const { rows } = await pool.query(
        `SELECT idproducto_papel AS id, medida, ancho, fuelle, altura, descripcion_papel
         FROM producto_papel
         WHERE activo = true
           AND (origen_expo IS NOT TRUE)
           AND idcat_tipo_producto_papel = $1
         ORDER BY medida`,
        [idTipo]
      );
      return res.json(rows);
    }

    if (categoria === "plastico") {
      const { rows } = await pool.query(
        `SELECT idconfiguracion_plastico AS id, medida, ancho, altura,
                fuelle_fondo, fuelle_latiz, fuelle_latde, por_kilo
         FROM configuracion_plastico
         WHERE activo = true
           AND (origen_expo IS NOT TRUE)
           AND tipo_producto_plastico_plastico_idtipo_producto_plastico = $1
         ORDER BY medida`,
        [idTipo]
      );
      return res.json(rows);
    }

    return res.status(400).json({ error: "categoria debe ser 'papel' o 'plastico'." });
  } catch (error: any) {
    console.error("❌ GET MEDIDAS COTIZADOR LIBRE ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener el catálogo de medidas." });
  }
};

// ==========================
// 3. DETALLE DE PRODUCTO — PAPEL
// (grupos = opciones de material; asas/laminados permitidos para ESE
// producto específico, vía las tablas de vínculo; texturas/foils sin
// restricción por producto, se ofrece el catálogo activo completo)
// ==========================
export const getDetalleProductoPapelCotizadorLibre = async (req: Request, res: Response) => {
  try {
    const idproducto_papel = Number(req.params.idproducto_papel);

    if (!Number.isInteger(idproducto_papel) || idproducto_papel <= 0) {
      return res.status(400).json({ error: "idproducto_papel inválido." });
    }

    const { rows: productoRows } = await pool.query(
      `SELECT idproducto_papel, medida, ancho, fuelle, altura, descripcion_papel, activo
       FROM producto_papel
       WHERE idproducto_papel = $1 AND activo = true AND (origen_expo IS NOT TRUE)`,
      [idproducto_papel]
    );

    if (productoRows.length === 0) {
      return res.status(404).json({ error: "Producto no encontrado o inactivo." });
    }

    const { rows: grupos } = await pool.query(
      `SELECT g.idgrupo_papel, g.precio_sugerido, dm.idcat_tipo_papel, ctp.nombre AS material
       FROM grupo_papel g
       LEFT JOIN detalle_material_papel dm ON dm.idgrupo_papel = g.idgrupo_papel
       LEFT JOIN cat_tipo_papel ctp ON ctp.idcat_tipo_papel = dm.idcat_tipo_papel
       WHERE g.idproducto_papel = $1
       ORDER BY g.orden`,
      [idproducto_papel]
    );

    const { rows: asas } = await pool.query(
      `SELECT DISTINCT cta.idcat_tipo_asa AS id, cta.nombre
       FROM acabados_papel ap
       JOIN acabados_asas aa ON aa.idacabados_papel = ap.idacabados_papel
       JOIN cat_tipo_asa cta ON cta.idcat_tipo_asa = aa.idcat_tipo_asa
       WHERE ap.idproducto_papel = $1 AND cta.activo = true
       ORDER BY cta.nombre`,
      [idproducto_papel]
    );

    const { rows: laminados } = await pool.query(
      `SELECT DISTINCT cl.idcat_laminado AS id, cl.nombre
       FROM acabados_papel ap
       JOIN acabados_laminado al ON al.idacabados_papel = ap.idacabados_papel
       JOIN cat_laminado cl ON cl.idcat_laminado = al.idcat_laminado
       WHERE ap.idproducto_papel = $1 AND cl.activo = true
       ORDER BY cl.nombre`,
      [idproducto_papel]
    );

    const { rows: texturas } = await pool.query(
      `SELECT idcat_textura AS id, nombre FROM cat_textura WHERE activo = true ORDER BY nombre`
    );

    const { rows: foils } = await pool.query(
      `SELECT idfoil AS id, colorfoil AS nombre FROM foil WHERE activo = true ORDER BY colorfoil`
    );

    return res.json({
      producto: productoRows[0],
      grupos,
      asas,
      laminados,
      texturas,
      foils,
      linea: null, // pendiente — ver §5 de la especificación
    });
  } catch (error: any) {
    console.error("❌ GET DETALLE PRODUCTO PAPEL COTIZADOR LIBRE ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener el detalle del producto." });
  }
};

// ==========================
// 4. DETALLE DE PRODUCTO — PLÁSTICO
// (material/calibre ya son fijos en la fila de configuracion_plastico; la
// única personalización real disponible es el número de tintas)
// ==========================
export const getDetalleProductoPlasticoCotizadorLibre = async (req: Request, res: Response) => {
  try {
    const idconfiguracion_plastico = Number(req.params.idconfiguracion_plastico);

    if (!Number.isInteger(idconfiguracion_plastico) || idconfiguracion_plastico <= 0) {
      return res.status(400).json({ error: "idconfiguracion_plastico inválido." });
    }

    const { rows } = await pool.query(
      `SELECT cp.idconfiguracion_plastico, cp.medida, cp.ancho, cp.altura,
              cp.fuelle_fondo, cp.fuelle_latiz, cp.fuelle_latde, cp.por_kilo, cp.activo,
              mp.tipo_material AS material, c.calibre
       FROM configuracion_plastico cp
       LEFT JOIN material_plastico mp
         ON mp.idmaterial_plastico = cp.material_plastico_plastico_idmaterial_plastico
       LEFT JOIN calibre c ON c.idcalibre = cp.calibre_idcalibre
       WHERE cp.idconfiguracion_plastico = $1 AND cp.activo = true AND (cp.origen_expo IS NOT TRUE)`,
      [idconfiguracion_plastico]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Producto no encontrado o inactivo." });
    }

    const { rows: tintas } = await pool.query(
      `SELECT idtintas AS id, cantidad FROM tintas WHERE cantidad IS NOT NULL ORDER BY cantidad`
    );

    return res.json({
      producto: rows[0],
      tintas,
    });
  } catch (error: any) {
    console.error("❌ GET DETALLE PRODUCTO PLASTICO COTIZADOR LIBRE ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener el detalle del producto." });
  }
};