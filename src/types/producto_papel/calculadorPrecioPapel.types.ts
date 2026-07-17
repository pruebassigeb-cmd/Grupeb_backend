export type ReferenciaCantidadPrecioPapel = "precio1" | "precio2" | "precio3" | string;

export interface CantidadCalculoPrecioPapelInput {
  referencia: ReferenciaCantidadPrecioPapel;
  cantidad: number;
}

export interface AcabadosCalculoPrecioPapelInput {
  tintas_frente: number;
  tintas_dentro: number;
  laminado: boolean;
  hot_stamping: boolean;
  alto_relieve: boolean;
  textura: boolean;
  uv: boolean;
  asa: boolean;
}

export interface CalcularPrecioPapelInput {
  idproducto_papel: number;
  idgrupo_papel: number;
  cantidades: CantidadCalculoPrecioPapelInput[];
  acabados: AcabadosCalculoPrecioPapelInput;
}

export type CodigoAdvertenciaPrecioPapel =
  | "PRODUCTO_INACTIVO"
  | "PRECIO_BASE_NO_CONFIGURADO"
  | "PRODUCTO_SIN_TAMANO"
  | "SIN_ESCALAS_ACTIVAS"
  | "ACABADO_NO_EXISTE"
  | "ACABADO_INACTIVO"
  | "TARIFA_NO_CONFIGURADA"
  | "TARIFA_INACTIVA"
  | "COSTO_LAMINADO_NO_CONFIGURADO";

export interface AdvertenciaPrecioPapel {
  codigo: CodigoAdvertenciaPrecioPapel;
  mensaje: string;
  acabado_clave?: string;
  acabado_nombre?: string;
  cantidad?: number;
  escala_aplicada?: number | null;
}

export interface DesglosePrecioPapel {
  clave: string;
  nombre: string;
  origen: "matriz" | "producto";
  tarifa_unitaria: number | null;
  multiplicador: number;
  incremento: number;
  configurado: boolean;
}

export interface EscalaAplicadaPrecioPapel {
  id: number;
  cantidad: number;
}

export interface ResultadoCantidadPrecioPapel {
  referencia: ReferenciaCantidadPrecioPapel;
  cantidad: number;
  escala_aplicada: EscalaAplicadaPrecioPapel | null;
  precio_base: number;
  incremento_acabados: number;
  incremento_laminado: number;
  precio_calculado: number;
  desglose: DesglosePrecioPapel[];
  advertencias: AdvertenciaPrecioPapel[];
}

export interface CalcularPrecioPapelResponse {
  producto: {
    idproducto_papel: number;
    idgrupo_papel: number;
    id_tamano_producto: number | null;
    tamano_producto: string | null;
  };
  resultados: ResultadoCantidadPrecioPapel[];
}

export interface ContextoCalculoPrecioPapelDb {
  idproducto_papel: number;
  producto_activo: boolean;
  idgrupo_papel: number | null;
  precio_base: number | string | null;
  costo_laminado: number | string | null;
  id_tamano_producto: number | null;
  tamano_producto: string | null;
}

export interface TarifaCalculoPrecioPapelDb {
  id_escala: number;
  cantidad_escala: number;
  id_acabado: number | null;
  acabado_clave: string | null;
  acabado_nombre: string | null;
  tipo_calculo: string | null;
  acabado_activo: boolean | null;
  precio_unitario: number | string | null;
  tarifa_activa: boolean | null;
}
