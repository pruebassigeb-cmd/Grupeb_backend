import { qAudit } from "../../middlewares/auditoria";
import type { Request, Response } from "express";
import { pool } from "../../config/db";

// ═══════════════════════════════════════════════════════════════════════════
// Colores de asa — tabla `color_asa`. A propósito NO tiene FK hacia
// cat_tipo_asa: son catálogos independientes que solo comparten pestaña en
// la UI (confirmado con el usuario). El color se usa como color_asa_id en
// solicitud_producto, elegido junto con (pero no ligado a) el tipo de asa.
// ═══════════════════════════════════════════════════════════════════════════

const HEX_RE = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;

export const getColoresAsaAdmin = async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id_color, color, hex, activo FROM color_asa WHERE activo = true ORDER BY color`
    );
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET COLORES ASA ADMIN ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener colores de asa" });
  }
};

export const getColoresAsaInactivos = async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id_color, color, hex, activo FROM color_asa WHERE activo = false ORDER BY color`
    );
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET COLORES ASA INACTIVOS ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener colores de asa inactivos" });
  }
};

export const crearColorAsa = async (req: Request, res: Response) => {
  try {
    const color = String(req.body.color ?? "").trim();
    const hex = req.body.hex ? String(req.body.hex).trim() : null;
    if (!color) return res.status(400).json({ error: "El nombre del color es obligatorio" });
    if (hex && !HEX_RE.test(hex)) return res.status(400).json({ error: "Formato de hex inválido" });

    const { rows } = await qAudit(req)(
      `INSERT INTO color_asa (color, hex) VALUES ($1, $2) RETURNING id_color, color, hex, activo`,
      [color, hex]
    );
    return res.status(201).json(rows[0]);
  } catch (error: any) {
    console.error("❌ CREAR COLOR ASA ERROR:", error.message);
    return res.status(500).json({ error: "Error al crear el color de asa" });
  }
};

export const editarColorAsa = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const color = String(req.body.color ?? "").trim();
    const hex = req.body.hex ? String(req.body.hex).trim() : null;
    if (!color) return res.status(400).json({ error: "El nombre del color es obligatorio" });
    if (hex && !HEX_RE.test(hex)) return res.status(400).json({ error: "Formato de hex inválido" });

    const { rows } = await qAudit(req)(
      `UPDATE color_asa SET color = $1, hex = $2 WHERE id_color = $3 RETURNING id_color, color, hex, activo`,
      [color, hex, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Color no encontrado" });
    return res.json(rows[0]);
  } catch (error: any) {
    console.error("❌ EDITAR COLOR ASA ERROR:", error.message);
    return res.status(500).json({ error: "Error al editar el color de asa" });
  }
};

export const desactivarColorAsa = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rows } = await qAudit(req)(
      `UPDATE color_asa SET activo = false WHERE id_color = $1 RETURNING id_color`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Color no encontrado" });
    return res.json({ message: "Color desactivado" });
  } catch (error: any) {
    console.error("❌ DESACTIVAR COLOR ASA ERROR:", error.message);
    return res.status(500).json({ error: "Error al desactivar el color de asa" });
  }
};

export const reactivarColorAsa = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rows } = await qAudit(req)(
      `UPDATE color_asa SET activo = true WHERE id_color = $1 RETURNING id_color`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Color no encontrado" });
    return res.json({ message: "Color reactivado" });
  } catch (error: any) {
    console.error("❌ REACTIVAR COLOR ASA ERROR:", error.message);
    return res.status(500).json({ error: "Error al reactivar el color de asa" });
  }
};
