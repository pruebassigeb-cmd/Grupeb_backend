// src/types/cotizadorLibre/cotizadorLibreLanding.types.ts

// Secciones válidas del poster. Se valida contra esta lista en el backend
// (sin CHECK en BD) para poder agregar una sección nueva sin migración.
export const SECCIONES_LANDING_COTIZADOR_LIBRE = [
  "lineas",
  "bolsas_plastico",
  "cajas",
  "papel",
  "etiquetas",
  "liston",
  "proyectos_especiales",
] as const;

export type SeccionLandingCotizadorLibre = typeof SECCIONES_LANDING_COTIZADOR_LIBRE[number];

export interface LandingSlotItem {
  id: number;
  seccion: SeccionLandingCotizadorLibre;
  titulo: string;
  orden: number;
  idArchivo: number | null;
  imagenUrl: string | null;
}