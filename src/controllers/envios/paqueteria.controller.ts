import { Request, Response } from "express";
import { pool } from "../../config/db";

// ==========================
// OBTENER TODAS LAS PAQUETERÍAS
// ==========================
export const getPaqueterias = async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT idpaqueteria, nombre, telefono, sitioweb,
             calle, numero, colonia, cp, poblacion, estado,
             activo, created_at
      FROM paqueteria
      ORDER BY idpaqueteria ASC
    `);
    res.json(result.rows);
  } catch (error: any) {
    console.error("❌ GET PAQUETERIAS ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener paqueterías" });
  }
};

// ==========================
// OBTENER PAQUETERÍA POR ID
// ==========================
export const getPaqueteriaById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT idpaqueteria, nombre, telefono, sitioweb,
              calle, numero, colonia, cp, poblacion, estado,
              activo, created_at
       FROM paqueteria WHERE idpaqueteria = $1 LIMIT 1`,
      [id]
    );
    if ((result.rowCount ?? 0) === 0)
      return res.status(404).json({ error: "Paquetería no encontrada" });
    res.json(result.rows[0]);
  } catch (error: any) {
    console.error("❌ GET PAQUETERIA BY ID ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener paquetería" });
  }
};

// ==========================
// CREAR PAQUETERÍA
// ==========================
export const createPaqueteria = async (req: Request, res: Response) => {
  try {
    const {
      nombre, telefono, sitioweb,
      calle, numero, colonia, cp, poblacion, estado,
    } = req.body;

    if (!nombre || nombre.trim() === "")
      return res.status(400).json({ error: "El nombre de la paquetería es requerido" });

    const existeNombre = await pool.query(
      "SELECT 1 FROM paqueteria WHERE UPPER(nombre) = UPPER($1) LIMIT 1",
      [nombre.trim()]
    );
    if ((existeNombre.rowCount ?? 0) > 0)
      return res.status(400).json({ error: "Ya existe una paquetería con ese nombre" });

    const result = await pool.query(
      `INSERT INTO paqueteria (nombre, telefono, sitioweb, calle, numero, colonia, cp, poblacion, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING idpaqueteria, nombre, telefono, sitioweb,
                 calle, numero, colonia, cp, poblacion, estado,
                 activo, created_at`,
      [
        nombre.trim(),
        telefono?.trim()  || null,
        sitioweb?.trim()  || null,
        calle?.trim()     || null,
        numero?.trim()    || null,
        colonia?.trim()   || null,
        cp?.trim()        || null,
        poblacion?.trim() || null,
        estado?.trim()    || null,
      ]
    );

    console.log("✅ Paquetería creada:", result.rows[0].idpaqueteria);
    res.status(201).json({ message: "Paquetería creada exitosamente", paqueteria: result.rows[0] });
  } catch (error: any) {
    console.error("❌ CREATE PAQUETERIA ERROR:", error.message);
    res.status(500).json({ error: "Error al crear paquetería" });
  }
};

// ==========================
// ACTUALIZAR PAQUETERÍA
// ==========================
export const updatePaqueteria = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      nombre, activo,
      telefono, sitioweb,
      calle, numero, colonia, cp, poblacion, estado,
    } = req.body;

    if (!nombre || nombre.trim() === "")
      return res.status(400).json({ error: "El nombre de la paquetería es requerido" });

    const existeNombre = await pool.query(
      "SELECT 1 FROM paqueteria WHERE UPPER(nombre) = UPPER($1) AND idpaqueteria != $2 LIMIT 1",
      [nombre.trim(), id]
    );
    if ((existeNombre.rowCount ?? 0) > 0)
      return res.status(400).json({ error: "Ya existe una paquetería con ese nombre" });

    const result = await pool.query(
      `UPDATE paqueteria
       SET nombre   = $1, activo   = $2,
           telefono = $3, sitioweb = $4,
           calle    = $5, numero   = $6,
           colonia  = $7, cp       = $8,
           poblacion= $9, estado   = $10
       WHERE idpaqueteria = $11
       RETURNING idpaqueteria, nombre, telefono, sitioweb,
                 calle, numero, colonia, cp, poblacion, estado,
                 activo, created_at`,
      [
        nombre.trim(),
        activo ?? true,
        telefono?.trim()  || null,
        sitioweb?.trim()  || null,
        calle?.trim()     || null,
        numero?.trim()    || null,
        colonia?.trim()   || null,
        cp?.trim()        || null,
        poblacion?.trim() || null,
        estado?.trim()    || null,
        id,
      ]
    );

    if ((result.rowCount ?? 0) === 0)
      return res.status(404).json({ error: "Paquetería no encontrada" });

    console.log("✅ Paquetería actualizada:", id);
    res.json({ message: "Paquetería actualizada exitosamente", paqueteria: result.rows[0] });
  } catch (error: any) {
    console.error("❌ UPDATE PAQUETERIA ERROR:", error.message);
    res.status(500).json({ error: "Error al actualizar paquetería" });
  }
};

// ==========================
// ELIMINAR PAQUETERÍA
// ==========================
export const deletePaqueteria = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const tieneEnvios = await pool.query(
      "SELECT 1 FROM envio WHERE paqueteria_idpaqueteria = $1 LIMIT 1",
      [id]
    );
    if ((tieneEnvios.rowCount ?? 0) > 0)
      return res.status(400).json({ error: "No se puede eliminar una paquetería que tiene envíos registrados" });

    const result = await pool.query(
      "DELETE FROM paqueteria WHERE idpaqueteria = $1 RETURNING idpaqueteria",
      [id]
    );

    if ((result.rowCount ?? 0) === 0)
      return res.status(404).json({ error: "Paquetería no encontrada" });

    console.log("✅ Paquetería eliminada:", id);
    res.json({ message: "Paquetería eliminada exitosamente" });
  } catch (error: any) {
    console.error("❌ DELETE PAQUETERIA ERROR:", error.message);
    res.status(500).json({ error: "Error al eliminar paquetería" });
  }
};