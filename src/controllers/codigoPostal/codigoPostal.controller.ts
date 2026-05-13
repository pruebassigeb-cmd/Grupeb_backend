import { Request, Response } from "express";
import { pool } from "../../config/db";

export const buscarPorCP = async (req: Request, res: Response): Promise<void> => {
  const cp = req.params.cp as string; // ← cast aquí
  if (!/^\d{5}$/.test(cp)) {
    res.status(400).json({ error: "CP inválido" });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT colonia, municipio AS poblacion, estado
       FROM codigos_postales
       WHERE codigo_postal = $1
       ORDER BY colonia ASC`,
      [cp]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "CP no encontrado" });
      return;
    }

    res.json(result.rows);
  } catch (error) {
    console.error("❌ Error al buscar CP:", error);
    res.status(500).json({ error: "Error al buscar código postal" });
  }
};