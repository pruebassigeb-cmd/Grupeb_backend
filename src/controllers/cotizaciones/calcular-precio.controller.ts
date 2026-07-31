// src/controllers/cotizaciones/calcular-precio.controller.ts
import { Request, Response } from "express";
import {
  calcularPreciosPlasticoBatch,
  ErrorCalculoPrecioPlastico,
} from "../../services/plastico/calculadorPrecioPlastico.service";

const numeroPositivo = (valor: unknown): number => {
  const numero = Number(valor);
  return Number.isFinite(numero) && numero > 0 ? numero : 0;
};

// ============================================
// ENDPOINT: CALCULAR PRECIO PREVIEW (una sola cantidad)
// ============================================
export const calcularPrecioPreview = async (req: Request, res: Response) => {
  try {
    const cantidad = numeroPositivo(req.body?.cantidad);

    if (cantidad <= 0) {
      return res.status(400).json({
        error: "Se requiere una cantidad válida.",
      });
    }

    const resultado = await calcularPreciosPlasticoBatch({
      cantidades: [cantidad],
      porKilo: req.body?.porKilo,
      tintasId: req.body?.tintasId,
      tintasCantidad: req.body?.tintasCantidad,
    });

    if (resultado.sin_tintas) {
      return res.json({
        success: true,
        sin_tintas: true,
        tintas_id: null,
        tintas_cantidad: 0,
        resultado: null,
      });
    }

    const primerResultado = resultado.resultados[0];

    if (!primerResultado) {
      return res.status(404).json({
        error: "No se encontró tarifa aplicable para estos parámetros.",
        detalles: {
          cantidad,
          tintas_id: resultado.tintas_id,
          tintas_cantidad: resultado.tintas_cantidad,
        },
      });
    }

    return res.json({ success: true, ...primerResultado });
  } catch (error: any) {
    if (error instanceof ErrorCalculoPrecioPlastico) {
      return res.status(error.statusCode).json({ error: error.message });
    }

    console.error("❌ CALCULAR PRECIO ERROR:", error.message);
    return res.status(500).json({
      error: "Error al calcular precio",
      detalles: error.message,
    });
  }
};

// ============================================
// ENDPOINT: CALCULAR PRECIOS EN BATCH (varias cantidades)
// ============================================
export const calcularPreciosBatch = async (req: Request, res: Response) => {
  try {
    const resultado = await calcularPreciosPlasticoBatch({
      cantidades: Array.isArray(req.body?.cantidades) ? req.body.cantidades : [],
      porKilo: req.body?.porKilo,
      tintasId: req.body?.tintasId,
      tintasCantidad: req.body?.tintasCantidad,
    });

    if (resultado.sin_tintas) {
      return res.json({
        success: true,
        sin_tintas: true,
        tintas_id: null,
        tintas_cantidad: 0,
        resultados: resultado.resultados,
      });
    }

    return res.json({
      success: true,
      tintas_id: resultado.tintas_id,
      tintas_cantidad: resultado.tintas_cantidad,
      resultados: resultado.resultados,
    });
  } catch (error: any) {
    if (error instanceof ErrorCalculoPrecioPlastico) {
      return res.status(error.statusCode).json({ error: error.message });
    }

    console.error("❌ CALCULAR PRECIOS BATCH ERROR:", error.message);
    return res.status(500).json({
      error: "Error al calcular precios",
      detalles: error.message,
    });
  }
};