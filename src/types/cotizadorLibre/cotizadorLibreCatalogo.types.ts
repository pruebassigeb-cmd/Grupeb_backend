// src/types/cotizadorLibre/cotizadorLibreCatalogo.types.ts

export interface TipoCatalogoItem {
  id: number;
  nombre: string;
  imagenUrl?: string | null;
}

export interface MedidaPapelItem {
  id: number;
  medida: string | null;
  ancho: number | null;
  fuelle: number | null;
  altura: number | null;
  descripcion_papel: string | null;
  imagenUrl?: string | null;
}

export interface MedidaPlasticoItem {
  id: number;
  medida: string | null;
  ancho: number | null;
  altura: number | null;
  fuelle_fondo: number | null;
  fuelle_latiz: number | null;
  fuelle_latde: number | null;
  por_kilo: number | null;
  descripcion?: string | null;
  imagenUrl?: string | null;
}

export interface GrupoPapelItem {
  idgrupo_papel: number;
  precio_sugerido: number | null;
  idcat_tipo_papel: number | null;
  material: string | null;
  imagenUrl?: string | null;
}

export interface AcabadosPermitidosPapel {
  uv: boolean;
  alto_relieve: boolean;
  textura: boolean;
  hot_stamping: boolean;
}

export interface ImagenesGlobalesPapel {
  hotStamping: string | null;
  altoRelieve: string | null;
  uv: string | null;
}

export interface DetalleProductoPapelResponse {
  producto: {
    idproducto_papel: number;
    medida: string | null;
    ancho: number | null;
    fuelle: number | null;
    altura: number | null;
    descripcion_papel: string | null;
    activo: boolean;
  };
  grupos: GrupoPapelItem[];
  asas: TipoCatalogoItem[];
  laminados: TipoCatalogoItem[];
  texturas: TipoCatalogoItem[];
  foils: TipoCatalogoItem[];
  // Pendiente — aún no existe en el esquema (ver especificación §5).
  // Se deja contemplado desde ahora para no romper el contrato cuando
  // exista: se implementará como columna en la misma tabla que guarda
  // el tamaño (según lo indicado), no como catálogo aparte.
  linea: null;
  acabadosPermitidos: AcabadosPermitidosPapel;
  imagenesGlobales: ImagenesGlobalesPapel;
}

export interface TintaItem {
  id: number;
  cantidad: number | null;
}

export interface DetalleProductoPlasticoResponse {
  producto: {
    idconfiguracion_plastico: number;
    medida: string | null;
    ancho: number | null;
    altura: number | null;
    fuelle_fondo: number | null;
    fuelle_latiz: number | null;
    fuelle_latde: number | null;
    por_kilo: number | null;
    activo: boolean;
    material: string | null;
    calibre: number | null;
  };
  tintas: TintaItem[];
}