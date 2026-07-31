// src/types/cotizadorLibre/cotizadorLibreClientes.types.ts

export interface BuscarClienteRequest {
  empresa?: string;
  rfc?: string;
  telefono?: string;
  correo?: string;
}

export interface BuscarClienteResponseSinMatch {
  match: false;
}

export interface BuscarClienteResponseConMatch {
  match: true;
  cliente_id: number;
  impresion: {
    correo_mask: string | null;
    telefono_mask: string | null;
  };
}

export type BuscarClienteResponse =
  | BuscarClienteResponseSinMatch
  | BuscarClienteResponseConMatch;

export interface EnviarCodigoRequest {
  cliente_id: number;
}

export interface EnviarCodigoResponse {
  enviado: true;
  expira_en: string;
}

export interface ConfirmarCodigoRequest {
  cliente_id: number;
  codigo: string;
}

export type MotivoFalloVerificacion =
  | "sin_codigo_activo"
  | "expirado"
  | "demasiados_intentos"
  | "codigo_incorrecto";

export interface ConfirmarCodigoResponseExito {
  verificado: true;
}

export interface ConfirmarCodigoResponseFallo {
  verificado: false;
  motivo: MotivoFalloVerificacion;
  intentos_restantes?: number;
}

export type ConfirmarCodigoResponse =
  | ConfirmarCodigoResponseExito
  | ConfirmarCodigoResponseFallo;
