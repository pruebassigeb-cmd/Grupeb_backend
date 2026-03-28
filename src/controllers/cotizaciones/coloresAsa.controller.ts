import { Request, Response } from "express";
import { pool } from "../../config/db";

export const getColoresAsa = async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id_color, color FROM color_asa ORDER BY id_color`
    );
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET COLORES ASA ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener colores de asa" });
  }
};