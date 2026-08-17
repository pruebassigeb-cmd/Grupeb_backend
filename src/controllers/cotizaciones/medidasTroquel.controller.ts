import { Request, Response } from "express";
import { pool } from "../../config/db";

export const getMedidasTroquel = async (_req: Request, res: Response) => {
  try {
    console.log("🔍 GET MEDIDAS TROQUEL llamado");
    const { rows } = await pool.query(
      `SELECT id_medidatro, medida FROM medidas_troquel WHERE activo = true ORDER BY id_medidatro`
    );
    console.log("🔍 MEDIDAS TROQUEL resultado:", rows);
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET MEDIDAS TROQUEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener medidas de troquel" });
  }
};

