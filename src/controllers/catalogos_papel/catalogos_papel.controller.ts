import type { Request, Response } from "express";
import { pool } from "../../config/db";

// ═══════════════════════════════════════════════════════════════════════════
// MAPA DE CATÁLOGOS VÁLIDOS
// ═══════════════════════════════════════════════════════════════════════════
const CATALOGOS: Record<string, { tabla: string; pk: string; tieneMedida: boolean; tieneNumMaquina: boolean }> = {
  tipo_producto:      { tabla: "cat_tipo_producto_papel", pk: "idcat_tipo_producto_papel", tieneMedida: false, tieneNumMaquina: false },
  tipo_papel:         { tabla: "cat_tipo_papel",          pk: "idcat_tipo_papel",          tieneMedida: false, tieneNumMaquina: false },
  calibre:            { tabla: "cat_calibre",             pk: "idcat_calibre",             tieneMedida: false, tieneNumMaquina: false },
  tipo_pegado:        { tabla: "cat_tipo_pegado",         pk: "idcat_tipo_pegado",         tieneMedida: false, tieneNumMaquina: false },
  pegamento:          { tabla: "cat_pegamento",           pk: "idcat_pegamento",           tieneMedida: false, tieneNumMaquina: false },
  tipo_asa:           { tabla: "cat_tipo_asa",            pk: "idcat_tipo_asa",            tieneMedida: false, tieneNumMaquina: false },
  laminado:           { tabla: "cat_laminado",            pk: "idcat_laminado",            tieneMedida: false, tieneNumMaquina: false },
  refuerzo_medidas:   { tabla: "cat_refuerzo_medidas",    pk: "idcat_refuerzo_medidas",    tieneMedida: false, tieneNumMaquina: false },
  refuerzo_material:  { tabla: "cat_refuerzo_material",   pk: "idcat_refuerzo_material",   tieneMedida: false, tieneNumMaquina: false },
  empaque:            { tabla: "cat_empaque",             pk: "idcat_empaque",             tieneMedida: false, tieneNumMaquina: false },
  sacabocados:        { tabla: "cat_sacabocados",         pk: "idcat_sacabocados",         tieneMedida: true,  tieneNumMaquina: false },
  perforado:          { tabla: "cat_perforado",           pk: "idcat_perforado",           tieneMedida: true,  tieneNumMaquina: false },
  hojeado_guillotina: { tabla: "cat_hojeado_guillotina",  pk: "idcat_hojeado_guillotina",  tieneMedida: false, tieneNumMaquina: true  },
  impresora:          { tabla: "cat_impresora",           pk: "idcat_impresora",           tieneMedida: false, tieneNumMaquina: true  },
  hs_ar:              { tabla: "cat_hs_ar",               pk: "idcat_hs_ar",               tieneMedida: false, tieneNumMaquina: true  },
  suaje_maquina:      { tabla: "cat_suaje_maquina",       pk: "idcat_suaje_maquina",       tieneMedida: false, tieneNumMaquina: true  },
  uv:                 { tabla: "cat_uv",                  pk: "idcat_uv",                  tieneMedida: false, tieneNumMaquina: true  },
  textura:            { tabla: "cat_textura",             pk: "idcat_textura",             tieneMedida: false, tieneNumMaquina: true  },
  empalme:            { tabla: "cat_empalme",             pk: "idcat_empalme",             tieneMedida: false, tieneNumMaquina: true  },
  armado:             { tabla: "cat_armado",              pk: "idcat_armado",              tieneMedida: false, tieneNumMaquina: true  },
  asas_maquina:       { tabla: "cat_asas_maquina",        pk: "idcat_asas_maquina",        tieneMedida: false, tieneNumMaquina: true  },
  desbarbe:           { tabla: "cat_desbarbe",            pk: "idcat_desbarbe",            tieneMedida: false, tieneNumMaquina: true  },
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /catalogos-papel
// ═══════════════════════════════════════════════════════════════════════════
export const getCatalogosPapel = async (_req: Request, res: Response) => {
  try {
    const resultado: Record<string, any[]> = {};

    await Promise.all(
      Object.entries(CATALOGOS).map(async ([key, { tabla, pk }]) => {
        const { rows } = await pool.query(
          `SELECT * FROM ${tabla} WHERE activo = true ORDER BY ${pk} ASC`
        );
        resultado[key] = rows;
      })
    );

    console.log("✅ Catálogos papel obtenidos");
    return res.json(resultado);

  } catch (error: any) {
    console.error("❌ GET CATÁLOGOS PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener catálogos de papel" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /catalogos-papel/inactivos
// ═══════════════════════════════════════════════════════════════════════════
export const getCatalogosInactivos = async (_req: Request, res: Response) => {
  try {
    const resultado: Record<string, any[]> = {};

    await Promise.all(
      Object.entries(CATALOGOS).map(async ([key, { tabla, pk }]) => {
        const { rows } = await pool.query(
          `SELECT * FROM ${tabla} WHERE activo = false ORDER BY ${pk} ASC`
        );
        resultado[key] = rows;
      })
    );

    console.log("✅ Catálogos inactivos obtenidos");
    return res.json(resultado);

  } catch (error: any) {
    console.error("❌ GET CATÁLOGOS INACTIVOS ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener catálogos inactivos" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /catalogos-papel/:catalogo
// ═══════════════════════════════════════════════════════════════════════════
export const agregarItemCatalogo = async (req: Request, res: Response) => {
  try {
    const catalogo = req.params.catalogo as string;
    const { nombre, medida, numero_maquina } = req.body;

    const cat = CATALOGOS[catalogo];
    if (!cat) return res.status(400).json({ error: `Catálogo '${catalogo}' no válido` });
    if (!nombre?.trim()) return res.status(400).json({ error: "El campo 'nombre' es requerido" });

    let query: string;
    let values: any[];

    if (cat.tieneNumMaquina) {
      query = `INSERT INTO ${cat.tabla} (nombre, numero_maquina) VALUES ($1, $2) RETURNING *`;
      values = [nombre.trim(), numero_maquina?.trim() ?? null];
    } else if (cat.tieneMedida) {
      query = `INSERT INTO ${cat.tabla} (nombre, medida) VALUES ($1, $2) RETURNING *`;
      values = [nombre.trim(), medida?.trim() ?? null];
    } else {
      query = `INSERT INTO ${cat.tabla} (nombre) VALUES ($1) RETURNING *`;
      values = [nombre.trim()];
    }

    const { rows } = await pool.query(query, values);
    console.log(`✅ Item agregado a ${cat.tabla}: ${nombre}`);
    return res.status(201).json(rows[0]);

  } catch (error: any) {
    console.error("❌ POST CATÁLOGO PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al agregar item al catálogo" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// PUT /catalogos-papel/:catalogo/:id
// ═══════════════════════════════════════════════════════════════════════════
export const editarItemCatalogo = async (req: Request, res: Response) => {
  try {
    const catalogo = req.params.catalogo as string;
    const { id } = req.params;
    const { nombre, medida, numero_maquina } = req.body;

    const cat = CATALOGOS[catalogo];
    if (!cat) return res.status(400).json({ error: `Catálogo '${catalogo}' no válido` });
    if (!nombre?.trim()) return res.status(400).json({ error: "El campo 'nombre' es requerido" });

    let query: string;
    let values: any[];

    if (cat.tieneNumMaquina) {
      query = `UPDATE ${cat.tabla} SET nombre = $1, numero_maquina = $2 WHERE ${cat.pk} = $3 RETURNING *`;
      values = [nombre.trim(), numero_maquina?.trim() ?? null, id];
    } else if (cat.tieneMedida) {
      query = `UPDATE ${cat.tabla} SET nombre = $1, medida = $2 WHERE ${cat.pk} = $3 RETURNING *`;
      values = [nombre.trim(), medida?.trim() ?? null, id];
    } else {
      query = `UPDATE ${cat.tabla} SET nombre = $1 WHERE ${cat.pk} = $2 RETURNING *`;
      values = [nombre.trim(), id];
    }

    const { rows } = await pool.query(query, values);
    if (rows.length === 0) return res.status(404).json({ error: "Item no encontrado" });

    console.log(`✅ Item actualizado en ${cat.tabla} id=${id}`);
    return res.json(rows[0]);

  } catch (error: any) {
    console.error("❌ PUT CATÁLOGO PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al editar item del catálogo" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /catalogos-papel/:catalogo/:id
// ═══════════════════════════════════════════════════════════════════════════
export const eliminarItemCatalogo = async (req: Request, res: Response) => {
  try {
    const catalogo = req.params.catalogo as string;
    const { id } = req.params;

    const cat = CATALOGOS[catalogo];
    if (!cat) return res.status(400).json({ error: `Catálogo '${catalogo}' no válido` });

    const { rows } = await pool.query(
      `UPDATE ${cat.tabla} SET activo = false WHERE ${cat.pk} = $1 RETURNING *`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Item no encontrado" });

    console.log(`✅ Item desactivado en ${cat.tabla} id=${id}`);
    return res.json({ message: "Item eliminado correctamente", item: rows[0] });

  } catch (error: any) {
    console.error("❌ DELETE CATÁLOGO PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al eliminar item del catálogo" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /catalogos-papel/:catalogo/:id/reactivar
// ═══════════════════════════════════════════════════════════════════════════
export const reactivarItemCatalogo = async (req: Request, res: Response) => {
  try {
    const catalogo = req.params.catalogo as string;
    const { id } = req.params;

    const cat = CATALOGOS[catalogo];
    if (!cat) return res.status(400).json({ error: `Catálogo '${catalogo}' no válido` });

    const { rows } = await pool.query(
      `UPDATE ${cat.tabla} SET activo = true WHERE ${cat.pk} = $1 RETURNING *`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Item no encontrado" });

    console.log(`✅ Item reactivado en ${cat.tabla} id=${id}`);
    return res.json({ message: "Item reactivado correctamente", item: rows[0] });

  } catch (error: any) {
    console.error("❌ PATCH REACTIVAR CATÁLOGO ERROR:", error.message);
    return res.status(500).json({ error: "Error al reactivar item del catálogo" });
  }
};