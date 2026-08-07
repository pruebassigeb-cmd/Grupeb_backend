// src/types/cotizadorLibre/cotizadorLibreCorreo.types.ts

export interface EnviarPdfCotizadorLibreRequest {
  tipo: "cotizacion" | "pedido";
  folio: string;
  pdfBase64: string;
  nombreArchivo: string;
}

export interface EnviarPdfCotizadorLibreResponse {
  enviado: true;
}