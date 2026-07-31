import { Response } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import {
  obtenerTipoCambioActual,
  obtenerHistorialTipoCambio,
  registrarTipoCambioManual,
} from "../../services/tipoCambio/tipoCambio.service";

// ============================================================
// OBTENER TIPO DE CAMBIO VIGENTE
// ============================================================
export const getTipoCambioActual = async (req: AuthRequest, res: Response) => {
  try {
    const actual = await obtenerTipoCambioActual();
    if (!actual) {
      return res
        .status(404)
        .json({ error: "Aún no hay tipo de cambio registrado" });
    }
    return res.json(actual);
  } catch (error: any) {
    console.error("❌ GET TIPO DE CAMBIO ACTUAL ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener el tipo de cambio" });
  }
};

// ============================================================
// HISTORIAL
// ============================================================
export const getTipoCambioHistorial = async (req: AuthRequest, res: Response) => {
  try {
    const limite = req.query.limite ? Number(req.query.limite) : 30;
    const historial = await obtenerHistorialTipoCambio(limite);
    return res.json(historial);
  } catch (error: any) {
    console.error("❌ GET HISTORIAL TIPO DE CAMBIO ERROR:", error.message);
    return res
      .status(500)
      .json({ error: "Error al obtener el historial de tipo de cambio" });
  }
};

// ============================================================
// CAPTURA / CORRECCIÓN MANUAL
// ============================================================
export const putTipoCambioManual = async (req: AuthRequest, res: Response) => {
  try {
    const { valor } = req.body;
    if (!valor || Number(valor) <= 0) {
      return res.status(400).json({ error: "Se requiere un valor mayor a 0" });
    }

    const usuarioId = req.user!.id;
    const actualizado = await registrarTipoCambioManual(Number(valor), usuarioId);
    return res.json(actualizado);
  } catch (error: any) {
    console.error("❌ PUT TIPO DE CAMBIO MANUAL ERROR:", error.message);
    return res
      .status(500)
      .json({ error: "Error al registrar el tipo de cambio" });
  }
};
