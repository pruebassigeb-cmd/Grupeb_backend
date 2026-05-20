import { Request, Response } from "express";
import { pool } from "../../config/db";

// ==========================
// OBTENER TODOS LOS REGÍMENES FISCALES
// ==========================
export const getRegimenesFiscales = async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT 
        idregimen_fiscal,
        tipo_regimen,
        codigo
      FROM regimen_fiscal
      ORDER BY tipo_regimen ASC
    `);

    res.json(result.rows);
  } catch (error: any) {
    console.error("❌ GET REGÍMENES FISCALES ERROR:", error.message);
    res.status(500).json({ 
      error: "Error al obtener regímenes fiscales" 
    });
  }
};

// ==========================
// OBTENER TODOS LOS MÉTODOS DE PAGO
// ==========================
export const getMetodosPago = async (req: Request, res: Response) => {
  try {
    await pool.query("SET client_encoding TO 'UTF8'");

    const result = await pool.query(`
      SELECT 
        idmetodo_pago,
        codigo,
        tipo_pago
      FROM metodo_pago
      ORDER BY tipo_pago ASC
    `);

    console.log("MÉTODOS PAGO:", result.rows);

    res
      .setHeader("Content-Type", "application/json; charset=utf-8")
      .status(200)
      .json(result.rows);

  } catch (error: any) {
    console.error("❌ GET MÉTODOS DE PAGO ERROR:", error.message);
    res.status(500).json({ 
      error: "Error al obtener métodos de pago" 
    });
  }
};

// ==========================
// OBTENER TODAS LAS FORMAS DE PAGO
// ==========================
export const getFormasPago = async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT 
        idforma_pago,
        tipo_forma,
        codigo
      FROM forma_pago
      ORDER BY tipo_forma ASC
    `);

    res.json(result.rows);
  } catch (error: any) {
    console.error("❌ GET FORMAS DE PAGO ERROR:", error.message);
    res.status(500).json({ 
      error: "Error al obtener formas de pago" 
    });
  }
};