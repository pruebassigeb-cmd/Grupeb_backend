// src/types/cotizadorLibre/cotizadorLibreCotizaciones.types.ts

export interface ProductoPapelCotizadorLibreInput {
  categoria: "papel";
  idproducto_papel: number;
  idgrupo_papel: number;
  cantidad: number;
  acabados: {
    tintas_frente?: number;
    tintas_dentro?: number;
    idcat_laminado?: number | null;
    idfoil?: number | null;
    idcat_textura?: number | null;
    id_asa?: number | null;
    alto_relieve?: boolean;
    uv?: boolean;
  };
}

export interface ProductoPlasticoCotizadorLibreInput {
  categoria: "plastico";
  idconfiguracion_plastico: number;
  cantidad: number;
  tintasId: number;
}

export type ProductoCotizadorLibreInput =
  | ProductoPapelCotizadorLibreInput
  | ProductoPlasticoCotizadorLibreInput;

export interface CrearCotizacionCotizadorLibreRequest {
  clienteId: number;
  tipo: "cotizacion" | "pedido";
  // Viene del resultado de Fase 4.4 (IdentificacionCliente). Si es false,
  // la solicitud se guarda igual pero con estado 'en_revision', sin
  // aprobación automática ni fijado de maquinaria — un asesor la revisa
  // manualmente después.
  verificado: boolean;
  productos: ProductoCotizadorLibreInput[];
}

export interface CrearCotizacionCotizadorLibreResponse {
  idsolicitud: number;
  estado: string;
  no_cotizacion: string | null;
  no_pedido: string | null;
}