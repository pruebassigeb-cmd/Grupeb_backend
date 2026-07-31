// src/services/plastico/calculadorPrecioPlastico.service.ts
import { pool } from "../../config/db";

// ==========================
// ERROR TIPADO — mismo patrón que ErrorCalculoPrecioPapel
// ==========================
export class ErrorCalculoPrecioPlastico extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "ErrorCalculoPrecioPlastico";
  }
}

// ==========================
// TIPOS
// ==========================
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

export interface ResultadoCalculoPrecioPlastico {
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

export interface CalcularPreciosPlasticoBatchInput {
  cantidades: number[];
  porKilo: number;
  tintasId?: number;
  tintasCantidad?: number;
}

export interface CalcularPreciosPlasticoBatchResultado {
  sin_tintas: boolean;
  tintas_id: number | null;
  tintas_cantidad: number | null;
  resultados: Array<ResultadoCalculoPrecioPlastico | null>;
}

// ==========================
// HELPERS — idénticos a los que vivían en el controller original
// ==========================
const numeroPositivo = (valor: unknown): number => {
  const numero = Number(valor);
  return Number.isFinite(numero) && numero > 0 ? numero : 0;
};

const enteroPositivo = (valor: unknown): number => {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero > 0 ? numero : 0;
};

const esSolicitudSinTintas = (
  tintasIdValor: unknown,
  tintasCantidadValor: unknown,
): boolean => {
  const tintasId = enteroPositivo(tintasIdValor);
  const cantidad = Number(tintasCantidadValor);

  return tintasId === 0 && Number.isInteger(cantidad) && cantidad === 0;
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

const calcularPrecioUnitarioInterno = (
  cantidad: number,
  porKilo: number,
  tintas: { id: number; cantidad: number | null },
  tarifas: TarifaProduccion[],
): ResultadoCalculoPrecioPlastico | null => {
  if (cantidad <= 0 || porKilo <= 0 || tarifas.length === 0) return null;

  const peso_total_kg = cantidad / porKilo;
  const tarifa = buscarTarifa(tarifas, peso_total_kg);
  if (!tarifa) return null;

  const costo_produccion = peso_total_kg * Number(tarifa.precio);
  const costo_merma =
    costo_produccion * (Number(tarifa.merma_porcentaje) / 100);

  // Comportamiento comercial vigente: la merma es informativa y NO se suma
  // al precio (ver calcular-precio.controller.ts original — no se altera
  // esta regla de negocio al mover la lógica aquí).
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

// ==========================
// FUNCIÓN PÚBLICA DEL SERVICE — usada por el controller HTTP existente
// y, directo (sin HTTP), por el envoltorio del Cotizador Interactivo.
// ==========================
export async function calcularPreciosPlasticoBatch(
  input: CalcularPreciosPlasticoBatchInput,
): Promise<CalcularPreciosPlasticoBatchResultado> {
  const cantidades = Array.isArray(input.cantidades)
    ? input.cantidades.map((valor) => numeroPositivo(valor))
    : [];

  const porKilo = numeroPositivo(input.porKilo);

  if (cantidades.length === 0) {
    throw new ErrorCalculoPrecioPlastico("Se requiere un arreglo de cantidades.");
  }

  if (esSolicitudSinTintas(input.tintasId, input.tintasCantidad)) {
    return {
      sin_tintas: true,
      tintas_id: null,
      tintas_cantidad: 0,
      resultados: cantidades.map(() => null),
    };
  }

  const tintas = await resolverTintas(input.tintasId, input.tintasCantidad);

  if (porKilo <= 0 || !tintas) {
    throw new ErrorCalculoPrecioPlastico(
      "Se requieren porKilo y tintasId o tintasCantidad válidos.",
    );
  }

  const tarifas = await cargarTarifas(tintas.id);

  if (tarifas.length === 0) {
    throw new ErrorCalculoPrecioPlastico(
      "No hay tarifas configuradas para la cantidad de tintas seleccionada.",
      404,
    );
  }

  const resultados: Array<ResultadoCalculoPrecioPlastico | null> = cantidades.map(
    (cantidad) => {
      if (cantidad <= 0) return null;
      return calcularPrecioUnitarioInterno(cantidad, porKilo, tintas, tarifas);
    },
  );

  return {
    sin_tintas: false,
    tintas_id: tintas.id,
    tintas_cantidad: tintas.cantidad,
    resultados,
  };
}