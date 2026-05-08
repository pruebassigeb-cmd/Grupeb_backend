import { Request, Response } from "express";
import { pool } from "../../config/db";

// ==========================
// OBTENER TODAS LAS UNIDADES
// ==========================
export const getUnidades = async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT idunidad, tipo, marca, modelo, placa, num_serie,
             num_motor, color, propietario, activo, created_at
      FROM unidades
      ORDER BY idunidad DESC
    `);
    res.json(result.rows);
  } catch (error: any) {
    console.error("❌ GET UNIDADES ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener unidades" });
  }
};

// ==========================
// OBTENER UNIDAD POR ID
// ==========================
export const getUnidadById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT idunidad, tipo, marca, modelo, placa, num_serie,
              num_motor, color, propietario, activo, created_at
       FROM unidades WHERE idunidad = $1 LIMIT 1`,
      [id]
    );
    if ((result.rowCount ?? 0) === 0)
      return res.status(404).json({ error: "Unidad no encontrada" });
    res.json(result.rows[0]);
  } catch (error: any) {
    console.error("❌ GET UNIDAD BY ID ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener unidad" });
  }
};

// ==========================
// CREAR UNIDAD
// ==========================
export const createUnidad = async (req: Request, res: Response) => {
  try {
    const {
      tipo, marca, modelo, placa,
      num_serie, num_motor, color, propietario,
    } = req.body;

    if (!tipo || !marca || !modelo || !placa) {
      return res.status(400).json({ error: "Tipo, marca, modelo y placa son requeridos" });
    }

    // Verificar placa única
    const existePlaca = await pool.query(
      "SELECT 1 FROM unidades WHERE UPPER(placa) = UPPER($1) LIMIT 1",
      [placa]
    );
    if ((existePlaca.rowCount ?? 0) > 0)
      return res.status(400).json({ error: "Ya existe una unidad con esa placa" });

    const result = await pool.query(
      `INSERT INTO unidades (tipo, marca, modelo, placa, num_serie, num_motor, color, propietario)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING idunidad, tipo, marca, modelo, placa, num_serie, num_motor, color, propietario, activo`,
      [
        tipo.trim(), marca.trim(), modelo.trim(), placa.trim().toUpperCase(),
        num_serie?.trim() || null, num_motor?.trim() || null,
        color?.trim() || null, propietario?.trim() || null,
      ]
    );

    console.log("✅ Unidad creada:", result.rows[0].idunidad);
    res.status(201).json({ message: "Unidad creada exitosamente", unidad: result.rows[0] });
  } catch (error: any) {
    console.error("❌ CREATE UNIDAD ERROR:", error.message);
    res.status(500).json({ error: "Error al crear unidad" });
  }
};

// ==========================
// ACTUALIZAR UNIDAD
// ==========================
export const updateUnidad = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      tipo, marca, modelo, placa,
      num_serie, num_motor, color, propietario, activo,
    } = req.body;

    if (!tipo || !marca || !modelo || !placa) {
      return res.status(400).json({ error: "Tipo, marca, modelo y placa son requeridos" });
    }

    // Verificar placa única (excepto la misma unidad)
    const existePlaca = await pool.query(
      "SELECT 1 FROM unidades WHERE UPPER(placa) = UPPER($1) AND idunidad != $2 LIMIT 1",
      [placa, id]
    );
    if ((existePlaca.rowCount ?? 0) > 0)
      return res.status(400).json({ error: "Ya existe una unidad con esa placa" });

    const result = await pool.query(
      `UPDATE unidades
       SET tipo=$1, marca=$2, modelo=$3, placa=$4, num_serie=$5,
           num_motor=$6, color=$7, propietario=$8, activo=$9
       WHERE idunidad=$10
       RETURNING idunidad, tipo, marca, modelo, placa, num_serie, num_motor, color, propietario, activo`,
      [
        tipo.trim(), marca.trim(), modelo.trim(), placa.trim().toUpperCase(),
        num_serie?.trim() || null, num_motor?.trim() || null,
        color?.trim() || null, propietario?.trim() || null,
        activo ?? true, id,
      ]
    );

    if ((result.rowCount ?? 0) === 0)
      return res.status(404).json({ error: "Unidad no encontrada" });

    console.log("✅ Unidad actualizada:", id);
    res.json({ message: "Unidad actualizada exitosamente", unidad: result.rows[0] });
  } catch (error: any) {
    console.error("❌ UPDATE UNIDAD ERROR:", error.message);
    res.status(500).json({ error: "Error al actualizar unidad" });
  }
};

// ==========================
// ELIMINAR UNIDAD
// ==========================
export const deleteUnidad = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Verificar si tiene envíos asociados
    const tieneEnvios = await pool.query(
      "SELECT 1 FROM envio WHERE unidades_idunidad = $1 LIMIT 1",
      [id]
    );
    if ((tieneEnvios.rowCount ?? 0) > 0)
      return res.status(400).json({ error: "No se puede eliminar una unidad que tiene envíos registrados" });

    const result = await pool.query(
      "DELETE FROM unidades WHERE idunidad = $1 RETURNING idunidad",
      [id]
    );

    if ((result.rowCount ?? 0) === 0)
      return res.status(404).json({ error: "Unidad no encontrada" });

    console.log("✅ Unidad eliminada:", id);
    res.json({ message: "Unidad eliminada exitosamente" });
  } catch (error: any) {
    console.error("❌ DELETE UNIDAD ERROR:", error.message);
    res.status(500).json({ error: "Error al eliminar unidad" });
  }
};