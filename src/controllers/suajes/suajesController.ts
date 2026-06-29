// src/controllers/suajes/suajesController.ts
import { Request, Response } from "express";
import { pool } from "../../config/db";

// ============================================================
// OBTENER SUAJES
// Trae todos los registros de asa_suaje donde idproductos = 1 (Plástico)
// ya que cotizacion_producto es exclusivo de productos plásticos
// ============================================================
export const getSuajes = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        s.idsuaje,
        s.tipo,
        s.idproductos,
        p.tipo_producto
      FROM asa_suaje s
      JOIN productos p ON p.idproductos = s.idproductos
      WHERE s.idproductos = 1
      ORDER BY s.tipo ASC
    `);
      
    console.log(`✅ Suajes obtenidos: ${rows.length}`);
    return res.json(rows);

  } catch (error: any) {
    console.error("❌ GET SUAJES ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener suajes" });
  }
};