// src/types/cotizadorLibre/cotizadorLibrePrecio.types.ts

export type CategoriaCotizadorLibre = "papel" | "plastico";

export interface AcabadosPapelInput {
  tintas_frente?: number;
  tintas_dentro?: number;
  laminado?: boolean;
  hot_stamping?: boolean;
  alto_relieve?: boolean;
  textura?: boolean;
  uv?: boolean;
  asa?: boolean;
}

export interface CalcularPrecioCotizadorLibrePapelInput {
  idproducto_papel: number;
  idgrupo_papel: number;
  acabados: AcabadosPapelInput;
}

export interface CalcularPrecioCotizadorLibrePlasticoInput {
  porKilo: number;
  tintasId?: number;
  tintasCantidad?: number;
}

export interface CalcularPrecioCotizadorLibreRequest {
  categoria: CategoriaCotizadorLibre;
  cantidad: number;
  papel?: CalcularPrecioCotizadorLibrePapelInput;
  plastico?: CalcularPrecioCotizadorLibrePlasticoInput;
}

// Respuesta pública unificada — nunca expone tarifas, matrices, ni fórmulas internas.
export interface CalcularPrecioCotizadorLibreResponse {
  disponible: boolean;
  precio_unitario: number | null;
  mensaje: string | null;
}