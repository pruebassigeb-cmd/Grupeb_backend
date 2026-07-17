import type { Request, Response } from "express";
import {
  calcularPrecioPapel,
  ErrorCalculoPrecioPapel,
} from "../../services/producto_papel/calculadorPrecioPapel.service";

export const calcularPrecioPapelController = async (req: Request, res: Response) => {
  try {
    const resultado = await calcularPrecioPapel(req.body);
    return res.json(resultado);
  } catch (error: any) {
    if (error instanceof ErrorCalculoPrecioPapel) {
      return res.status(error.statusCode).json({ error: error.message });
    }

    console.error("[CALCULADOR PRECIO PAPEL]", error);
    return res.status(500).json({
      error: error?.message || "No se pudo calcular el precio de papel.",
    });
  }
};
