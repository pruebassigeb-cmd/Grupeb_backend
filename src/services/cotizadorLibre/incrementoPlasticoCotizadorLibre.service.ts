// src/services/cotizadorLibre/incrementoPlasticoCotizadorLibre.service.ts
import { pool } from "../../config/db";

// ============================================================================
// Detección por nombre (en código, no en BD — así lo pidió Toni: si el
// nombre del tipo de producto cambia algún día, se ajusta aquí sin migrar
// nada). Normaliza acentos, mayúsculas/minúsculas y separadores para que
// "Bolsa Asa Flexible", "asa flexible" y "ASA-FLEXIBLE" matcheen igual.
// ============================================================================
const normalizar = (texto: string): string =>
  texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita acentos
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ""); // quita espacios, guiones, etc.

export interface DeteccionTipoProductoPlastico {
  esAsaFlexible: boolean;
  esBolsaEnvios: boolean;
}

export async function detectarTipoProductoPlastico(
  idTipoProductoPlastico: number
): Promise<DeteccionTipoProductoPlastico> {
  const { rows } = await pool.query<{ nombre: string }>(
    `SELECT material_plastico_producto AS nombre
     FROM tipo_producto_plastico
     WHERE idtipo_producto_plastico = $1`,
    [idTipoProductoPlastico]
  );

  const nombreNormalizado = rows[0]?.nombre ? normalizar(rows[0].nombre) : "";

  return {
    esAsaFlexible: nombreNormalizado.includes("asaflexible"),
    esBolsaEnvios: nombreNormalizado.includes("envios"),
  };
}

// ============================================================================
// Búsqueda del incremento aplicable — mismo shape de query para ambas
// tablas, la única diferencia es que cinta_seguridad además filtra por
// cinta_seguridad_id (cada cinta tiene su propia escala).
// ============================================================================
async function buscarIncrementoAsaFlexible(cantidad: number): Promise<number> {
  const { rows } = await pool.query<{ incremento_por_pieza: string }>(
    `SELECT incremento_por_pieza
     FROM escala_incremento_asa_flexible
     WHERE activo = true
       AND $1 >= rango_min
       AND (rango_max IS NULL OR $1 <= rango_max)
     LIMIT 1`,
    [cantidad]
  );

  return rows[0] ? Number(rows[0].incremento_por_pieza) : 0;
}

async function buscarIncrementoCintaSeguridad(
  cantidad: number,
  cintaSeguridadId: number
): Promise<number> {
  const { rows } = await pool.query<{ incremento_por_pieza: string }>(
    `SELECT incremento_por_pieza
     FROM escala_incremento_cinta_seguridad
     WHERE activo = true
       AND cinta_seguridad_id = $2
       AND $1 >= rango_min
       AND (rango_max IS NULL OR $1 <= rango_max)
     LIMIT 1`,
    [cantidad, cintaSeguridadId]
  );

  return rows[0] ? Number(rows[0].incremento_por_pieza) : 0;
}

export interface CalcularIncrementoPlasticoInput {
  idTipoProductoPlastico: number;
  cantidad: number;
  cintaSeguridadId?: number;
}

export interface CalcularIncrementoPlasticoResultado {
  incrementoTotal: number;
  // true si el tipo detectado requiere cinta de seguridad (bolsa envíos) —
  // el controller la usa para exigir cintaSeguridadId en el payload.
  requiereCintaSeguridad: boolean;
  // true específicamente cuando SÍ requiere cinta pero no vino ninguna en
  // el payload — el controller responde 400 con este caso.
  cintaSeguridadFaltante: boolean;
}

export async function calcularIncrementoPlasticoCotizadorLibre(
  input: CalcularIncrementoPlasticoInput
): Promise<CalcularIncrementoPlasticoResultado> {
  const { esAsaFlexible, esBolsaEnvios } = await detectarTipoProductoPlastico(
    input.idTipoProductoPlastico
  );

  if (esBolsaEnvios && !input.cintaSeguridadId) {
    return { incrementoTotal: 0, requiereCintaSeguridad: true, cintaSeguridadFaltante: true };
  }

  let incrementoTotal = 0;

  if (esAsaFlexible) {
    incrementoTotal += await buscarIncrementoAsaFlexible(input.cantidad);
  }

  if (esBolsaEnvios && input.cintaSeguridadId) {
    incrementoTotal += await buscarIncrementoCintaSeguridad(input.cantidad, input.cintaSeguridadId);
  }

  return {
    incrementoTotal,
    requiereCintaSeguridad: esBolsaEnvios,
    cintaSeguridadFaltante: false,
  };
}