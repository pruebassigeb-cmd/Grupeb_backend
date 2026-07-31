// src/controllers/cotizadorLibre/cotizadorLibrePrecio.controller.ts
import { Request, Response } from "express";
import {
  calcularPrecioPapel,
  ErrorCalculoPrecioPapel,
} from "../../services/producto_papel/calculadorPrecioPapel.service";
import {
  calcularPreciosPlasticoBatch,
  ErrorCalculoPrecioPlastico,
} from "../../services/plastico/calculadorPrecioPlastico.service";
import type {
  CalcularPrecioCotizadorLibreRequest,
  CalcularPrecioCotizadorLibreResponse,
} from "../../types/cotizadorLibre/cotizadorLibrePrecio.types";

function respuestaPublicaPapel(
  resultado: Awaited<ReturnType<typeof calcularPrecioPapel>>["resultados"][number],
): CalcularPrecioCotizadorLibreResponse {
  // Si el motor regresó advertencias (tarifa no configurada, producto sin
  // tamaño, producto inactivo, etc.), el precio puede estar incompleto.
  // Nunca se expone el detalle técnico de la advertencia al cliente público;
  // se traduce a un mensaje seguro y genérico.
  if (resultado.advertencias.length > 0) {
    return {
      disponible: false,
      precio_unitario: null,
      mensaje: "No se pudo calcular un precio confiable para esta configuración todavía. Un asesor puede ayudarte a cotizarlo.",
    };
  }

  return {
    disponible: true,
    precio_unitario: resultado.precio_calculado,
    mensaje: null,
  };
}

function respuestaPublicaPlastico(
  resultado: Awaited<ReturnType<typeof calcularPreciosPlasticoBatch>>,
): CalcularPrecioCotizadorLibreResponse {
  if (resultado.sin_tintas) {
    return {
      disponible: true,
      precio_unitario: null,
      mensaje: "Este producto no requiere tintas; el precio base aplica sin cargos adicionales de impresión.",
    };
  }

  const primerResultado = resultado.resultados[0];

  if (!primerResultado) {
    return {
      disponible: false,
      precio_unitario: null,
      mensaje: "No se encontró una tarifa aplicable para esta configuración. Un asesor puede ayudarte a cotizarlo.",
    };
  }

  return {
    disponible: true,
    precio_unitario: Number(primerResultado.precio_unitario.toFixed(2)),
    mensaje: null,
  };
}

// ==========================
// ENDPOINT PÚBLICO ÚNICO
// ==========================
export const calcularPrecioCotizadorLibre = async (req: Request, res: Response) => {
  try {
    const body = req.body as CalcularPrecioCotizadorLibreRequest;

    if (body.categoria !== "papel" && body.categoria !== "plastico") {
      return res.status(400).json({ error: "categoria debe ser 'papel' o 'plastico'." });
    }

    if (!Number.isInteger(body.cantidad) || body.cantidad <= 0) {
      return res.status(400).json({ error: "cantidad debe ser un entero mayor a cero." });
    }

    if (body.categoria === "papel") {
      if (!body.papel) {
        return res.status(400).json({ error: "Falta el objeto 'papel' en la solicitud." });
      }

      const resultadoMotor = await calcularPrecioPapel({
        idproducto_papel: body.papel.idproducto_papel,
        idgrupo_papel: body.papel.idgrupo_papel,
        cantidades: [{ referencia: "unica", cantidad: body.cantidad }],
        acabados: {
          tintas_frente: body.papel.acabados?.tintas_frente ?? 0,
          tintas_dentro: body.papel.acabados?.tintas_dentro ?? 0,
          laminado: body.papel.acabados?.laminado ?? false,
          hot_stamping: body.papel.acabados?.hot_stamping ?? false,
          alto_relieve: body.papel.acabados?.alto_relieve ?? false,
          textura: body.papel.acabados?.textura ?? false,
          uv: body.papel.acabados?.uv ?? false,
          asa: body.papel.acabados?.asa ?? false,
        },
      });

      return res.json(respuestaPublicaPapel(resultadoMotor.resultados[0]));
    }

    // categoria === "plastico"
    if (!body.plastico) {
      return res.status(400).json({ error: "Falta el objeto 'plastico' en la solicitud." });
    }

    const resultadoMotor = await calcularPreciosPlasticoBatch({
      cantidades: [body.cantidad],
      porKilo: body.plastico.porKilo,
      tintasId: body.plastico.tintasId,
      tintasCantidad: body.plastico.tintasCantidad,
    });

    return res.json(respuestaPublicaPlastico(resultadoMotor));
  } catch (error: any) {
    if (error instanceof ErrorCalculoPrecioPapel || error instanceof ErrorCalculoPrecioPlastico) {
      // Errores de validación de entrada — responsabilidad del frontend,
      // no fugan información de negocio.
      return res.status(error.statusCode).json({ error: error.message });
    }

    console.error("❌ CALCULAR PRECIO COTIZADOR LIBRE ERROR:", error.message);
    return res.status(500).json({
      error: "No se pudo calcular el precio. Intenta de nuevo en unos momentos.",
    });
  }
};