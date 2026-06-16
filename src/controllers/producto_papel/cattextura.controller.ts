import { Request, Response } from "express";
import { pool } from "../../config/db";

// ═══════════════════════════════════════════════════════════════════════════
// GET /cat-textura  — listado para el dropdown de "Texturizado" en cotización papel
// ═══════════════════════════════════════════════════════════════════════════
export const getTexturas = async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT idcat_textura, nombre, numero_maquina
      FROM cat_textura
      WHERE activo = true
      ORDER BY nombre ASC
    `);
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET TEXTURAS ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener texturas" });
  }
};