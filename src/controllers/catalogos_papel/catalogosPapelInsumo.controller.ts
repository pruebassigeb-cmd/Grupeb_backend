import { Request, Response } from "express";
import { pool } from "../../config/db";
import {
  CATALOGOS_SINCRONIZADOS,
  CatKeySincronizado,
  crearInsumoConEspejo,
  desactivarInsumoCompleto,
  reactivarInsumoCompleto,
} from "../../services/insumoCatalogoBridge";

// ═══════════════════════════════════════════════════════════════════════════
// Este controller es NUEVO y AUTÓNOMO — no reemplaza tu catalogos_papel
// existente (no tengo ese archivo, así que no lo toco para no romper nada).
// Cubre exclusivamente el alta/baja de los 6 catálogos que ahora viven
// unificados con el sistema de Proveedores/Insumos:
//   tipo_papel · pegamento · laminado · sacabocados · perforado · matrix
//
// El usuario de "Catálogos de papel" sigue viendo pestañas normales; el tipo
// de insumo queda implícito por la pestaña en la que está (no elige nada).
// El resultado de dar de alta aquí es EXACTAMENTE el mismo `insumo` que si se
// hubiera creado desde Proveedores/Insumos — es el mismo dato, dos puertas.
// ═══════════════════════════════════════════════════════════════════════════

const CAT_KEYS_VALIDOS = Object.keys(CATALOGOS_SINCRONIZADOS) as CatKeySincronizado[];

function esCatKeyValido(catKey: string): catKey is CatKeySincronizado {
  return CAT_KEYS_VALIDOS.includes(catKey as CatKeySincronizado);
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /catalogos-papel/insumo/:catKey?activo=true|false
// Lista el catálogo (leyendo directo de la tabla cat_* — ya está sincronizada)
// ═══════════════════════════════════════════════════════════════════════════
export const listarCatalogoInsumo = async (req: Request, res: Response) => {
  try {
    const { catKey } = req.params as { catKey: string };
    const { activo } = req.query;

    if (!esCatKeyValido(catKey)) {
      return res.status(400).json({ error: `Catálogo inválido: ${catKey}` });
    }

    const cfg = CATALOGOS_SINCRONIZADOS[catKey];
    let where = "";
    const values: any[] = [];
    if (activo === "true" || activo === "false") {
      where = "WHERE activo = $1";
      values.push(activo === "true");
    }

    const { rows } = await pool.query(
      `SELECT ${cfg.pk} AS id, ${cfg.columnaNombre} AS nombre, activo, insumo_idinsumo
       FROM ${cfg.tabla}
       ${where}
       ORDER BY ${cfg.columnaNombre} ASC`,
      values
    );

    return res.json(rows);
  } catch (error: any) {
    console.error("❌ LISTAR CATALOGO INSUMO ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener el catálogo" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /catalogos-papel/insumo/:catKey
// body: { nombre: string, medida?: string }
// El tipo queda implícito por :catKey (la pestaña activa en el frontend).
// Para sacabocados/perforado, si mandan `medida`, se concatena al nombre
// antes de crear el insumo (así se confirmó: la medida vive en el nombre).
// ═══════════════════════════════════════════════════════════════════════════
export const crearCatalogoInsumo = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { catKey } = req.params as { catKey: string };
    const { nombre, medida } = req.body;

    if (!esCatKeyValido(catKey)) {
      return res.status(400).json({ error: `Catálogo inválido: ${catKey}` });
    }
    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ error: "El nombre es requerido" });
    }

    const nombreCompleto = medida && String(medida).trim()
      ? `${String(nombre).trim()} ${String(medida).trim()}`
      : String(nombre).trim();

    await client.query("BEGIN");
    const { idinsumo, catRow, yaExistia } = await crearInsumoConEspejo(client, {
      catKey,
      nombreCompleto,
    });
    await client.query("COMMIT");

    const cfg = CATALOGOS_SINCRONIZADOS[catKey];
    console.log(`✅ Catálogo "${catKey}" ${yaExistia ? "reutilizado" : "creado"}: ${nombreCompleto} (insumo #${idinsumo})`);

    return res.status(201).json({
      id: catRow[cfg.pk],
      nombre: catRow[cfg.columnaNombre],
      activo: catRow.activo,
      insumo_idinsumo: idinsumo,
      yaExistia,
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ CREAR CATALOGO INSUMO ERROR:", error.message);
    return res.status(500).json({ error: error.message || "Error al crear el registro" });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /catalogos-papel/insumo/:catKey/:id  (desactivar)
// Desactiva el INSUMO completo (y por lo tanto su espejo aquí) — coherente
// con que la baja real vive del lado de insumo, no del lado del espejo.
// ═══════════════════════════════════════════════════════════════════════════
export const desactivarCatalogoInsumo = async (req: Request, res: Response) => {
  try {
    const { catKey, id } = req.params as { catKey: string; id: string };
    if (!esCatKeyValido(catKey)) {
      return res.status(400).json({ error: `Catálogo inválido: ${catKey}` });
    }
    const cfg = CATALOGOS_SINCRONIZADOS[catKey];

    const { rows } = await pool.query(
      `SELECT insumo_idinsumo FROM ${cfg.tabla} WHERE ${cfg.pk} = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "No encontrado" });

    if (rows[0].insumo_idinsumo) {
      await desactivarInsumoCompleto(rows[0].insumo_idinsumo);
    } else {
      // Registro histórico sin insumo vinculado (previo a la migración) —
      // se desactiva solo en la tabla cat_* directamente.
      await pool.query(`UPDATE ${cfg.tabla} SET activo = false WHERE ${cfg.pk} = $1`, [id]);
    }

    return res.json({ message: "Desactivado correctamente" });
  } catch (error: any) {
    console.error("❌ DESACTIVAR CATALOGO INSUMO ERROR:", error.message);
    return res.status(500).json({ error: "Error al desactivar" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /catalogos-papel/insumo/:catKey/:id/reactivar
// ═══════════════════════════════════════════════════════════════════════════
export const reactivarCatalogoInsumo = async (req: Request, res: Response) => {
  try {
    const { catKey, id } = req.params as { catKey: string; id: string };
    if (!esCatKeyValido(catKey)) {
      return res.status(400).json({ error: `Catálogo inválido: ${catKey}` });
    }
    const cfg = CATALOGOS_SINCRONIZADOS[catKey];

    const { rows } = await pool.query(
      `SELECT insumo_idinsumo FROM ${cfg.tabla} WHERE ${cfg.pk} = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "No encontrado" });

    if (rows[0].insumo_idinsumo) {
      await reactivarInsumoCompleto(rows[0].insumo_idinsumo);
    } else {
      await pool.query(`UPDATE ${cfg.tabla} SET activo = true WHERE ${cfg.pk} = $1`, [id]);
    }

    return res.json({ message: "Reactivado correctamente" });
  } catch (error: any) {
    console.error("❌ REACTIVAR CATALOGO INSUMO ERROR:", error.message);
    return res.status(500).json({ error: "Error al reactivar" });
  }
};