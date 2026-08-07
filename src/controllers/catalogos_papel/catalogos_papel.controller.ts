import { qAudit } from "../../middlewares/auditoria";
import type { Request, Response } from "express";
import { pool } from "../../config/db";

// ═══════════════════════════════════════════════════════════════════════════
// MAPA DE CATÁLOGOS VÁLIDOS
// ═══════════════════════════════════════════════════════════════════════════
const CATALOGOS: Record<string, {
  tabla: string;
  pk: string;
  tieneMedida: boolean;
  tieneNumMaquina: boolean;
  campoNombre?: string;
  esCorte?: boolean;
  esDoble?: boolean;
  esPuntos?: boolean;
  esRolloLam?: boolean;
  tieneTipoMaquina?: boolean;
}> = {
  tipo_producto: { tabla: "cat_tipo_producto_papel", pk: "idcat_tipo_producto_papel", tieneMedida: false, tieneNumMaquina: false },
  tipo_papel: { tabla: "cat_tipo_papel", pk: "idcat_tipo_papel", tieneMedida: false, tieneNumMaquina: false },
  calibre: { tabla: "cat_calibre", pk: "idcat_calibre", tieneMedida: false, tieneNumMaquina: false },
  tipo_pegado: { tabla: "cat_tipo_pegado", pk: "idcat_tipo_pegado", tieneMedida: false, tieneNumMaquina: false },
  pegamento: { tabla: "cat_pegamento", pk: "idcat_pegamento", tieneMedida: false, tieneNumMaquina: false },
  tipo_asa: { tabla: "cat_tipo_asa", pk: "idcat_tipo_asa", tieneMedida: false, tieneNumMaquina: false },
  laminado: { tabla: "cat_laminado", pk: "idcat_laminado", tieneMedida: false, tieneNumMaquina: false },
  laminado_maquina: { tabla: "cat_laminado_maquina", pk: "idcat_laminado_maquina", tieneMedida: false, tieneNumMaquina: true },
  refuerzo_medidas: { tabla: "cat_refuerzo_medidas", pk: "idcat_refuerzo_medidas", tieneMedida: false, tieneNumMaquina: false },
  refuerzo_material: { tabla: "cat_refuerzo_material", pk: "idcat_refuerzo_material", tieneMedida: false, tieneNumMaquina: false },
  empaque: { tabla: "cat_empaque", pk: "idcat_empaque", tieneMedida: false, tieneNumMaquina: false },
  sacabocados: { tabla: "cat_sacabocados", pk: "idcat_sacabocados", tieneMedida: true, tieneNumMaquina: false },
  perforado: { tabla: "cat_perforado", pk: "idcat_perforado", tieneMedida: true, tieneNumMaquina: false },
  hojeado_guillotina: { tabla: "cat_hojeado_guillotina", pk: "idcat_hojeado_guillotina", tieneMedida: false, tieneNumMaquina: true, tieneTipoMaquina: true },
  impresora: { tabla: "cat_impresora", pk: "idcat_impresora", tieneMedida: false, tieneNumMaquina: true },
  hs_ar: { tabla: "cat_hs_ar", pk: "idcat_hs_ar", tieneMedida: false, tieneNumMaquina: true },
  suaje_maquina: { tabla: "cat_suaje_maquina", pk: "idcat_suaje_maquina", tieneMedida: false, tieneNumMaquina: true },
  uv: { tabla: "cat_uv", pk: "idcat_uv", tieneMedida: false, tieneNumMaquina: true },
  textura: { tabla: "cat_textura", pk: "idcat_textura", tieneMedida: false, tieneNumMaquina: false },
  texturizadora: { tabla: "cat_texturizadora", pk: "idcat_texturizadora", tieneMedida: false, tieneNumMaquina: true },
  empaque_maquina: { tabla: "cat_empaque_maquina", pk: "idcat_empaque_maquina", tieneMedida: false, tieneNumMaquina: true },
  empalme: { tabla: "cat_empalme", pk: "idcat_empalme", tieneMedida: false, tieneNumMaquina: true },
  armado: { tabla: "cat_armado", pk: "idcat_armado", tieneMedida: false, tieneNumMaquina: true },
  asas_maquina: { tabla: "cat_asas_maquina", pk: "idcat_asas_maquina", tieneMedida: false, tieneNumMaquina: true },
  desbarbe: { tabla: "cat_desbarbe", pk: "idcat_desbarbe", tieneMedida: false, tieneNumMaquina: true },
  matrix: { tabla: "matrix", pk: "idmatrix", tieneMedida: false, tieneNumMaquina: false, campoNombre: "medida_matrix" },
  // ── Nuevos ────────────────────────────────────────────────────────────
  puntos: { tabla: "cat_puntos", pk: "idcat_punto", tieneMedida: false, tieneNumMaquina: false, esPuntos: true },
  cortes: { tabla: "cat_cortes", pk: "idcat_corte", tieneMedida: false, tieneNumMaquina: false, esCorte: true },
  dobles: { tabla: "cat_dobles", pk: "idcat_doble", tieneMedida: false, tieneNumMaquina: false, esDoble: true },
  // NUEVO: catálogo de rollos de laminado. El usuario captura solo el
  // número de ancho (ej. "38.5") y el backend arma el nombre final
  // ("38.5 cm") — ver ramas esRolloLam más abajo. Se usa desde
  // FormularioProductoPapelAlta.tsx (campo "Rollo de laminado") y desde
  // el panel general de Catálogos.
  rollo_lam: { tabla: "rollo_lam", pk: "idrollo_lam", tieneMedida: false, tieneNumMaquina: false, esRolloLam: true },
};

const normalizarTipoMaquinaHojeado = (valor: unknown): "hojeadora" | "guillotina" | null => {
  if (typeof valor !== "string") return null;
  const v = valor.trim().toLowerCase();
  if (v === "hojeadora" || v === "hojeado") return "hojeadora";
  if (v === "guillotina") return "guillotina";
  return null;
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: query de listado según el catálogo y estado activo
// ═══════════════════════════════════════════════════════════════════════════
const buildListQuery = (key: string, cat: (typeof CATALOGOS)[string], activo: boolean): string => {
  const flag = activo ? "true" : "false";

  if (cat.esCorte) {
    return `
      SELECT c.idcat_corte AS id, c.corte AS nombre, c.altura, c.idcat_punto, p.puntos
      FROM cat_cortes c
      LEFT JOIN cat_puntos p ON p.idcat_punto = c.idcat_punto
      WHERE c.activo = ${flag}
      ORDER BY c.idcat_corte ASC`;
  }
  if (cat.esDoble) {
    return `
      SELECT d.idcat_doble AS id, d.doble AS nombre, d.altura, d.idcat_punto, p.puntos
      FROM cat_dobles d
      LEFT JOIN cat_puntos p ON p.idcat_punto = d.idcat_punto
      WHERE d.activo = ${flag}
      ORDER BY d.idcat_doble ASC`;
  }
  if (cat.esRolloLam) {
    return `
      SELECT idrollo_lam AS id, nombre, medida_ancho, activo
      FROM rollo_lam
      WHERE activo = ${flag}
      ORDER BY medida_ancho ASC`;
  }
  if (cat.esPuntos) {
    return `
      SELECT idcat_punto, puntos::text AS nombre, puntos, activo
      FROM cat_puntos
      WHERE activo = ${flag}
      ORDER BY puntos ASC`;
  }
  if (cat.campoNombre) {
    return `
      SELECT ${cat.pk}, ${cat.campoNombre} AS nombre, activo
      FROM ${cat.tabla}
      WHERE activo = ${flag}
      ORDER BY ${cat.campoNombre} ASC`;
  }
  return `SELECT * FROM ${cat.tabla} WHERE activo = ${flag} ORDER BY ${cat.pk} ASC`;
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /catalogos-papel
// ═══════════════════════════════════════════════════════════════════════════
export const getCatalogosPapel = async (_req: Request, res: Response) => {
  try {
    const resultado: Record<string, any[]> = {};

    await Promise.all(
      Object.entries(CATALOGOS).map(async ([key, cat]) => {
        const { rows } = await pool.query(buildListQuery(key, cat, true));
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
      Object.entries(CATALOGOS).map(async ([key, cat]) => {
        const { rows } = await pool.query(buildListQuery(key, cat, false));
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
    const { nombre, medida, numero_maquina, altura, idcat_punto, tipo_maquina } = req.body;

    const cat = CATALOGOS[catalogo];
    if (!cat) return res.status(400).json({ error: `Catálogo '${catalogo}' no válido` });
    if (!nombre?.trim()) return res.status(400).json({ error: "El campo 'nombre' es requerido" });

    let query: string;
    let values: any[];

    if (cat.esCorte) {
      const corteVal = nombre.trim().endsWith('"') ? nombre.trim() : `${nombre.trim()}"`;
      const alturaVal = altura?.trim()
        ? (altura.trim().endsWith("mm") ? altura.trim() : `${altura.trim()} mm`)
        : null;
      query = `
        WITH ins AS (
          INSERT INTO cat_cortes (corte, altura, idcat_punto)
          VALUES ($1, $2, $3)
          RETURNING *
        )
        SELECT ins.idcat_corte AS id, ins.corte AS nombre, ins.altura, ins.idcat_punto, p.puntos
        FROM ins
        LEFT JOIN cat_puntos p ON p.idcat_punto = ins.idcat_punto`;
      values = [corteVal, alturaVal, idcat_punto ?? null];

    } else if (cat.esDoble) {
      const dobleVal = nombre.trim().endsWith('"') ? nombre.trim() : `${nombre.trim()}"`;
      const alturaVal = altura?.trim()
        ? (altura.trim().endsWith("mm") ? altura.trim() : `${altura.trim()} mm`)
        : null;
      query = `
        WITH ins AS (
          INSERT INTO cat_dobles (doble, altura, idcat_punto)
          VALUES ($1, $2, $3)
          RETURNING *
        )
        SELECT ins.idcat_doble AS id, ins.doble AS nombre, ins.altura, ins.idcat_punto, p.puntos
        FROM ins
        LEFT JOIN cat_puntos p ON p.idcat_punto = ins.idcat_punto`;
      values = [dobleVal, alturaVal, idcat_punto ?? null];

    } else if (cat.esRolloLam) {
      // El usuario escribe solo el número (ej. "38.5"); el nombre final
      // ("38.5 cm") se arma aquí siempre, nunca lo manda el frontend.
      const medida_ancho = Number.parseFloat(String(nombre).trim().replace(",", "."));
      if (isNaN(medida_ancho)) {
        return res.status(400).json({ error: "El ancho del rollo debe ser un número (ej. 38.5)" });
      }
      const nombreFinal = `${medida_ancho} cm`;
      query = `
        INSERT INTO rollo_lam (nombre, medida_ancho)
        VALUES ($1, $2)
        RETURNING idrollo_lam AS id, nombre, medida_ancho, activo`;
      values = [nombreFinal, medida_ancho];

    } else if (cat.esPuntos) {
      const puntosVal = parseInt(nombre.trim(), 10);
      if (isNaN(puntosVal)) return res.status(400).json({ error: "El valor de puntos debe ser numérico" });
      query = `
        INSERT INTO cat_puntos (puntos)
        VALUES ($1)
        RETURNING idcat_punto, puntos::text AS nombre, puntos, activo`;
      values = [puntosVal];

    } else if (cat.campoNombre) {
      query = `INSERT INTO ${cat.tabla} (${cat.campoNombre}) VALUES ($1) RETURNING ${cat.pk}, ${cat.campoNombre} AS nombre, activo`;
      values = [nombre.trim()];

    } else if (cat.tieneTipoMaquina) {
      const tipoMaquina = normalizarTipoMaquinaHojeado(tipo_maquina);
      if (!tipoMaquina) {
        return res.status(400).json({ error: "Selecciona si la máquina es Hojeadora o Guillotina" });
      }
      query = `INSERT INTO ${cat.tabla} (nombre, numero_maquina, tipo_maquina) VALUES ($1, $2, $3) RETURNING *`;
      values = [nombre.trim(), numero_maquina?.trim() ?? null, tipoMaquina];

    } else if (cat.tieneNumMaquina) {
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
    const { nombre, medida, numero_maquina, altura, idcat_punto, tipo_maquina } = req.body;

    const cat = CATALOGOS[catalogo];
    if (!cat) return res.status(400).json({ error: `Catálogo '${catalogo}' no válido` });
    if (!nombre?.trim()) return res.status(400).json({ error: "El campo 'nombre' es requerido" });

    let query: string;
    let values: any[];

    if (cat.esCorte) {
      const corteVal = nombre.trim().endsWith('"') ? nombre.trim() : `${nombre.trim()}"`;
      const alturaVal = altura?.trim()
        ? (altura.trim().endsWith("mm") ? altura.trim() : `${altura.trim()} mm`)
        : null;
      query = `
        WITH upd AS (
          UPDATE cat_cortes
          SET corte = $1, altura = $2, idcat_punto = $3
          WHERE idcat_corte = $4
          RETURNING *
        )
        SELECT upd.idcat_corte AS id, upd.corte AS nombre, upd.altura, upd.idcat_punto, p.puntos
        FROM upd
        LEFT JOIN cat_puntos p ON p.idcat_punto = upd.idcat_punto`;
      values = [corteVal, alturaVal, idcat_punto ?? null, id];

    } else if (cat.esDoble) {
      const dobleVal = nombre.trim().endsWith('"') ? nombre.trim() : `${nombre.trim()}"`;
      const alturaVal = altura?.trim()
        ? (altura.trim().endsWith("mm") ? altura.trim() : `${altura.trim()} mm`)
        : null;
      query = `
        WITH upd AS (
          UPDATE cat_dobles
          SET doble = $1, altura = $2, idcat_punto = $3
          WHERE idcat_doble = $4
          RETURNING *
        )
        SELECT upd.idcat_doble AS id, upd.doble AS nombre, upd.altura, upd.idcat_punto, p.puntos
        FROM upd
        LEFT JOIN cat_puntos p ON p.idcat_punto = upd.idcat_punto`;
      values = [dobleVal, alturaVal, idcat_punto ?? null, id];

    } else if (cat.esRolloLam) {
      const medida_ancho = Number.parseFloat(String(nombre).trim().replace(",", "."));
      if (isNaN(medida_ancho)) {
        return res.status(400).json({ error: "El ancho del rollo debe ser un número (ej. 38.5)" });
      }
      const nombreFinal = `${medida_ancho} cm`;
      query = `
        UPDATE rollo_lam SET nombre = $1, medida_ancho = $2
        WHERE idrollo_lam = $3
        RETURNING idrollo_lam AS id, nombre, medida_ancho, activo`;
      values = [nombreFinal, medida_ancho, id];

    } else if (cat.esPuntos) {
      const puntosVal = parseInt(nombre.trim(), 10);
      if (isNaN(puntosVal)) return res.status(400).json({ error: "El valor de puntos debe ser numérico" });
      query = `
        UPDATE cat_puntos SET puntos = $1
        WHERE idcat_punto = $2
        RETURNING idcat_punto, puntos::text AS nombre, puntos, activo`;
      values = [puntosVal, id];

    } else if (cat.campoNombre) {
      query = `UPDATE ${cat.tabla} SET ${cat.campoNombre} = $1 WHERE ${cat.pk} = $2 RETURNING ${cat.pk}, ${cat.campoNombre} AS nombre, activo`;
      values = [nombre.trim(), id];

    } else if (cat.tieneTipoMaquina) {
      const tipoMaquina = normalizarTipoMaquinaHojeado(tipo_maquina);
      if (!tipoMaquina) {
        return res.status(400).json({ error: "Selecciona si la máquina es Hojeadora o Guillotina" });
      }
      query = `UPDATE ${cat.tabla} SET nombre = $1, numero_maquina = $2, tipo_maquina = $3 WHERE ${cat.pk} = $4 RETURNING *`;
      values = [nombre.trim(), numero_maquina?.trim() ?? null, tipoMaquina, id];

    } else if (cat.tieneNumMaquina) {
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

    const { rows } = await qAudit(req)(
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

    const { rows } = await qAudit(req)(
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