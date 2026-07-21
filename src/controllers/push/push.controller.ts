// src/controllers/push/push.controller.ts
import { Response } from "express";
import { pool } from "../../config/db";
import type { AuthRequest } from "../../middlewares/auth.middleware";

export const suscribirPush = async (req: AuthRequest, res: Response) => {
  try {
    const usuarioId = req.user?.id;
    if (!usuarioId) return res.status(401).json({ error: "No autenticado" });

    const { endpoint, keys } = req.body;
    if (!endpoint || !keys) {
      return res.status(400).json({ error: "Se requiere endpoint y keys de la suscripción" });
    }

    await pool.query(
      `INSERT INTO push_subscriptions (usuario_id, endpoint, keys)
       VALUES ($1, $2, $3)
       ON CONFLICT (endpoint) DO UPDATE SET usuario_id = EXCLUDED.usuario_id, keys = EXCLUDED.keys`,
      [usuarioId, endpoint, JSON.stringify(keys)]
    );

    return res.json({ message: "Suscripción registrada" });
  } catch (e: any) {
    console.error("❌ SUSCRIBIR PUSH ERROR:", e.message);
    return res.status(500).json({ error: "No se pudo registrar la suscripción" });
  }
};

export const desuscribirPush = async (req: AuthRequest, res: Response) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: "Se requiere endpoint" });

    await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
    return res.json({ message: "Suscripción eliminada" });
  } catch (e: any) {
    console.error("❌ DESUSCRIBIR PUSH ERROR:", e.message);
    return res.status(500).json({ error: "No se pudo eliminar la suscripción" });
  }
};
