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
}

// ============================================
// BUSCAR TARIFA CORRECTA (sin caras)
// ============================================
const buscarTarifa = (
  tarifas: TarifaProduccion[],
  tintasId: number,
  pesoTotalKg: number
): TarifaProduccion | null => {
  const pesoRedondeado = Math.round(pesoTotalKg * 100) / 100;

  const tarifa = tarifas.find(
    (t) =>
      t.tintas_idtintas === tintasId &&
      pesoRedondeado >= (t.kg_min ?? 0) &&
      (t.kg_max === null || pesoRedondeado <= t.kg_max)
  );

  if (!tarifa) {
    console.warn("⚠️ No se encontró tarifa para:", {
      pesoTotalKg,
      pesoRedondeado,
      tintasId,
    });
    return null;
  }

  return tarifa;
};

// ============================================
// CALCULAR PRECIO UNITARIO (BACKEND)
// ============================================
const calcularPrecioUnitarioBackend = (
  cantidad: number,
  porKilo: number,
  tintasId: number,
  tarifas: TarifaProduccion[]
): ResultadoCalculo | null => {
  if (cantidad <= 0 || porKilo <= 0 || !tarifas.length) return null;

  const peso_total_kg = cantidad / porKilo;

  const tarifa = buscarTarifa(tarifas, tintasId, peso_total_kg);
  if (!tarifa) return null;

  const costo_produccion = peso_total_kg * tarifa.precio;
  const costo_merma = costo_produccion * (tarifa.merma_porcentaje / 100);
  const costo_total = costo_produccion;
  const precio_unitario = costo_produccion / cantidad;

  console.log("💰 Cálculo producción (BACKEND):", {
    cantidad,
    peso_total_kg: peso_total_kg.toFixed(2) + " kg",
    rango_aplicado: `${tarifa.kg_min ?? 0} - ${tarifa.kg_max ?? "∞"} kg`,
    tintas: tintasId,
    precio_kg: "$" + tarifa.precio,
    merma: tarifa.merma_porcentaje + "%",
    costo_produccion: "$" + costo_produccion.toFixed(2),
    costo_merma: "$" + costo_merma.toFixed(2) + " (informativo)",
    costo_total: "$" + costo_total.toFixed(2),
    precio_unitario: "$" + precio_unitario.toFixed(4),
  });

  return {
    peso_total_kg,
    precio_kg: tarifa.precio,
    merma_porcentaje: tarifa.merma_porcentaje,
    costo_produccion,
    costo_merma,
    costo_total,
    precio_unitario,
    kilogramos_rango: tarifa.kg_min ?? 0,
    tarifa_id: tarifa.idtarifas_produccion,
    kilogramos_id: tarifa.kilogramos_idkilogramos,
  };
};

// ============================================
// ENDPOINT: CALCULAR PRECIO PREVIEW
// ============================================
export const calcularPrecioPreview = async (req: Request, res: Response) => {
  try {
    const { cantidad, porKilo, tintasId } = req.body;

    if (!cantidad || !porKilo || !tintasId) {
      return res.status(400).json({
        error: "Se requieren: cantidad, porKilo, tintasId",
      });
    }

    if (cantidad <= 0 || porKilo <= 0) {
      return res.status(400).json({
        error: "Cantidad y porKilo deben ser mayores a 0",
      });
    }

    const { rows: tarifasRows } = await pool.query<TarifaProduccion>(`
      SELECT 
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
      ORDER BY k.kg_min ASC
    `);

    if (tarifasRows.length === 0) {
      return res.status(404).json({
        error: "No hay tarifas configuradas en el sistema",
      });
    }

    const resultado = calcularPrecioUnitarioBackend(
      Number(cantidad),
      Number(porKilo),
      Number(tintasId),
      tarifasRows
    );

    if (!resultado) {
      return res.status(404).json({
        error: "No se encontró tarifa aplicable para estos parámetros",
        detalles: {
          cantidad,
          peso_kg: (Number(cantidad) / Number(porKilo)).toFixed(2),
          tintasId,
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
export const calcularPreciosBatch = async (req: Request, res: Response) => {
  try {
    const { cantidades, porKilo, tintasId } = req.body;

    if (!Array.isArray(cantidades) || cantidades.length === 0) {
      return res.status(400).json({
        error: "Se requiere un array de cantidades",
      });
    }

    if (!porKilo || !tintasId) {
      return res.status(400).json({
        error: "Se requieren: porKilo, tintasId",
      });
    }

    const { rows: tarifasRows } = await pool.query<TarifaProduccion>(`
      SELECT 
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
      ORDER BY k.kg_min ASC
    `);

    if (tarifasRows.length === 0) {
      return res.status(404).json({
        error: "No hay tarifas configuradas en el sistema",
      });
    }

    const resultados = cantidades.map((cantidad) => {
      if (cantidad <= 0) return null;
      return calcularPrecioUnitarioBackend(
        Number(cantidad),
        Number(porKilo),
        Number(tintasId),
        tarifasRows
      );
    });

    return res.json({ success: true, resultados });

  } catch (error: any) {
    console.error("❌ CALCULAR PRECIOS BATCH ERROR:", error.message);
    return res.status(500).json({
      error: "Error al calcular precios",
      detalles: error.message,
    });
  }
};