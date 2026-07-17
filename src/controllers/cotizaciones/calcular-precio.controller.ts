import { Request, Response } from "express";
import { pool } from "../../config/db";

// ============================================
// TIPOS
// ============================================
interface TarifaProduccion {
  idtarifas_produccion: number;
  tintas_idtintas: number;
  kilogramos_idkilogramos: number;
  precio: number;
  merma_porcentaje: number;
  kg: number;
  kg_min: number | null;
  kg_max: number | null;
}

interface ResultadoCalculo {
  peso_total_kg: number;
  precio_kg: number;
  merma_porcentaje: number;
  costo_produccion: number;
  costo_merma: number;
  costo_total: number;
  precio_unitario: number;
  kilogramos_rango: number;
  tarifa_id: number;
  kilogramos_id: number;
  tintas_id: number;
  tintas_cantidad: number | null;
}

const numeroPositivo = (valor: unknown): number => {
  const numero = Number(valor);
  return Number.isFinite(numero) && numero > 0 ? numero : 0;
};

const enteroPositivo = (valor: unknown): number => {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero > 0 ? numero : 0;
};

async function resolverTintas(
  tintasIdValor: unknown,
  tintasCantidadValor: unknown,
): Promise<{ id: number; cantidad: number | null } | null> {
  const tintasId = enteroPositivo(tintasIdValor);

  if (tintasId > 0) {
    const { rows } = await pool.query<{
      idtintas: number;
      cantidad: number | null;
    }>(
      `SELECT idtintas, cantidad
       FROM tintas
       WHERE idtintas = $1
       LIMIT 1`,
      [tintasId],
    );

    return rows[0]
      ? { id: Number(rows[0].idtintas), cantidad: Number(rows[0].cantidad) }
      : null;
  }

  const cantidad = enteroPositivo(tintasCantidadValor);
  if (cantidad <= 0) return null;

  const { rows } = await pool.query<{
    idtintas: number;
    cantidad: number | null;
  }>(
    `SELECT idtintas, cantidad
     FROM tintas
     WHERE cantidad = $1
     ORDER BY idtintas
     LIMIT 1`,
    [cantidad],
  );

  return rows[0]
    ? { id: Number(rows[0].idtintas), cantidad: Number(rows[0].cantidad) }
    : null;
}

// ============================================
// BUSCAR TARIFA CORRECTA
// ============================================
const buscarTarifa = (
  tarifas: TarifaProduccion[],
  pesoTotalKg: number,
): TarifaProduccion | null => {
  const pesoRedondeado = Math.round(pesoTotalKg * 100) / 100;

  return tarifas.find(
    (tarifa) =>
      pesoRedondeado >= (tarifa.kg_min ?? 0) &&
      (tarifa.kg_max === null || pesoRedondeado <= tarifa.kg_max),
  ) ?? null;
};

// ============================================
// CALCULAR PRECIO UNITARIO
// ============================================
const calcularPrecioUnitarioBackend = (
  cantidad: number,
  porKilo: number,
  tintas: { id: number; cantidad: number | null },
  tarifas: TarifaProduccion[],
): ResultadoCalculo | null => {
  if (cantidad <= 0 || porKilo <= 0 || tarifas.length === 0) return null;

  const peso_total_kg = cantidad / porKilo;
  const tarifa = buscarTarifa(tarifas, peso_total_kg);
  if (!tarifa) return null;

  const costo_produccion = peso_total_kg * Number(tarifa.precio);
  const costo_merma =
    costo_produccion * (Number(tarifa.merma_porcentaje) / 100);

  // Se conserva el comportamiento comercial actual:
  // la merma es informativa y no se suma al precio.
  const costo_total = costo_produccion;
  const precio_unitario = costo_total / cantidad;

  return {
    peso_total_kg,
    precio_kg: Number(tarifa.precio),
    merma_porcentaje: Number(tarifa.merma_porcentaje),
    costo_produccion,
    costo_merma,
    costo_total,
    precio_unitario,
    kilogramos_rango: Number(tarifa.kg_min ?? 0),
    tarifa_id: Number(tarifa.idtarifas_produccion),
    kilogramos_id: Number(tarifa.kilogramos_idkilogramos),
    tintas_id: tintas.id,
    tintas_cantidad: tintas.cantidad,
  };
};

async function cargarTarifas(tintasId: number): Promise<TarifaProduccion[]> {
  const { rows } = await pool.query<TarifaProduccion>(
    `SELECT
       tp.idtarifas_produccion,
       tp.tintas_idtintas,
       tp.kilogramos_idkilogramos,
       tp.precio,
       tp.merma_porcentaje,
       k.kg,
       k.kg_min,
       k.kg_max
     FROM tarifas_produccion tp
     INNER JOIN kilogramos k
       ON k.idkilogramos = tp.kilogramos_idkilogramos
     WHERE tp.tintas_idtintas = $1
     ORDER BY k.kg_min ASC`,
    [tintasId],
  );

  return rows;
}

// ============================================
// ENDPOINT: CALCULAR PRECIO PREVIEW
// ============================================
export const calcularPrecioPreview = async (req: Request, res: Response) => {
  try {
    const cantidad = numeroPositivo(req.body?.cantidad);
    const porKilo = numeroPositivo(req.body?.porKilo);
    const tintas = await resolverTintas(
      req.body?.tintasId,
      req.body?.tintasCantidad,
    );

    if (cantidad <= 0 || porKilo <= 0 || !tintas) {
      return res.status(400).json({
        error:
          "Se requieren cantidad, porKilo y tintasId o tintasCantidad válidos.",
      });
    }

    const tarifas = await cargarTarifas(tintas.id);
    if (tarifas.length === 0) {
      return res.status(404).json({
        error: "No hay tarifas configuradas para la cantidad de tintas seleccionada.",
      });
    }

    const resultado = calcularPrecioUnitarioBackend(
      cantidad,
      porKilo,
      tintas,
      tarifas,
    );

    if (!resultado) {
      return res.status(404).json({
        error: "No se encontró tarifa aplicable para estos parámetros.",
        detalles: {
          cantidad,
          peso_kg: (cantidad / porKilo).toFixed(2),
          tintas_id: tintas.id,
          tintas_cantidad: tintas.cantidad,
        },
      });
    }

    return res.json({ success: true, ...resultado });
  } catch (error: any) {
    console.error("❌ CALCULAR PRECIO ERROR:", error.message);
    return res.status(500).json({
      error: "Error al calcular precio",
      detalles: error.message,
    });
  }
};

// ============================================
// ENDPOINT: CALCULAR PRECIOS EN BATCH
// ============================================
export const calcularPreciosBatch = async (
  req: Request,
  res: Response
) => {
  try {
    const cantidades: number[] = Array.isArray(req.body?.cantidades)
      ? (req.body.cantidades as unknown[]).map(
          (valor: unknown): number => numeroPositivo(valor)
        )
      : [];

    const porKilo = numeroPositivo(req.body?.porKilo);

    const tintas = await resolverTintas(
      req.body?.tintasId,
      req.body?.tintasCantidad,
    );

    if (cantidades.length === 0) {
      return res.status(400).json({
        error: "Se requiere un arreglo de cantidades.",
      });
    }

    if (porKilo <= 0 || !tintas) {
      return res.status(400).json({
        error:
          "Se requieren porKilo y tintasId o tintasCantidad válidos.",
      });
    }

    const tarifas = await cargarTarifas(tintas.id);

    if (tarifas.length === 0) {
      return res.status(404).json({
        error:
          "No hay tarifas configuradas para la cantidad de tintas seleccionada.",
      });
    }

    const resultados: Array<ResultadoCalculo | null> = cantidades.map(
      (cantidad: number): ResultadoCalculo | null => {
        if (cantidad <= 0) return null;

        return calcularPrecioUnitarioBackend(
          cantidad,
          porKilo,
          tintas,
          tarifas,
        );
      }
    );

    return res.json({
      success: true,
      tintas_id: tintas.id,
      tintas_cantidad: tintas.cantidad,
      resultados,
    });
  } catch (error: any) {
    console.error(
      "❌ CALCULAR PRECIOS BATCH ERROR:",
      error.message
    );

    return res.status(500).json({
      error: "Error al calcular precios",
      detalles: error.message,
    });
  }
};
