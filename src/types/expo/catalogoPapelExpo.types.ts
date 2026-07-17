export interface MaterialGrupoPapelDto {
  iddetalle_material: number;
  orden: number;
  idcat_tipo_papel: number | null;
  tipo_papel: string | null;
  idcat_calibre: number | null;
  calibre: string | null;
}


export interface LaminadoPermitidoPapelDto {
  idcat_laminado: number;
  nombre: string;
}

export interface AsaPermitidaPapelDto {
  idcat_tipo_asa: number;
  nombre: string;
}

export interface VariantePapelDbRow {
  idproducto_papel: number;
  idgrupo_papel: number | null;
  categoria: "papel" | "carton";
  tipo_producto: string | null;
  descripcion_papel: string | null;
  medida: string | null;
  ancho: number | string | null;
  fuelle: number | string | null;
  altura: number | string | null;
  id_tamano_producto: number | null;
  tamano_producto: string | null;
  precio_base: number | string | null;
  costo_laminado: number | string | null;
  grupo_descripcion: string | null;
  material: string | null;
  calibre: string | null;
  materiales: MaterialGrupoPapelDto[];
  laminacion: boolean;
  tipo_laminado: string | null;
  idcat_laminado: number | null;
  hs: boolean;
  tipo_hs: string | null;
  idfoil: number | null;
  ar: boolean;
  textura: boolean;
  tipo_textura: string | null;
  idcat_textura: number | null;
  uv: boolean;
  asa: boolean;
  tipo_asa: string | null;
  idcat_tipo_asa: number | null;
  laminados_permitidos: LaminadoPermitidoPapelDto[];
  asas_permitidas: AsaPermitidaPapelDto[];
  tintas_frente_default: number | null;
  tintas_dentro_default: number | null;
  imagen_public_id: string | null;
  origen_expo: boolean;
  precio_500: number | string | null;
  precio_1000: number | string | null;
  precio_3000: number | string | null;
}

export interface CatalogoPapelPropioDto {
  idcatalogo_expo: number;
  idproducto_papel: number;
  idgrupo_papel: number | null;
  categoria: "papel" | "carton";
  nombre: string;
  descripcion_papel: string | null;
  tipo_producto: string | null;
  medida: string | null;
  ancho: number | string | null;
  fuelle: number | string | null;
  altura: number | string | null;
  material: string | null;
  calibre: string | null;
  grupo_descripcion: string | null;
  precio_base: number | null;
  costo_laminado: number | null;
  id_tamano_producto: number | null;
  tamano_producto: string | null;
  laminacion: boolean;
  tipo_laminado: string | null;
  idcat_laminado: number | null;
  hs: boolean;
  tipo_hs: string | null;
  idfoil: number | null;
  ar: boolean;
  textura: boolean;
  tipo_textura: string | null;
  idcat_textura: number | null;
  uv: boolean;
  asa: boolean;
  tipo_asa: string | null;
  idcat_tipo_asa: number | null;
  laminados_permitidos: LaminadoPermitidoPapelDto[];
  asas_permitidas: AsaPermitidaPapelDto[];
  tintas: null;
  otro: null;
  tintas_frente_default: number | null;
  tintas_dentro_default: number | null;
  imagen_url: string | null;
  origen: "expo";
  precio_500: number | null;
  precio_1000: number | null;
  precio_3000: number | null;
}

export interface CatalogoPapelSistemaDto {
  id: number;
  idproducto_papel: number;
  idgrupo_papel: number | null;
  categoria: "papel" | "carton";
  nombre: string;
  descripcion_papel: string | null;
  tipo_producto: string | null;
  medida: string | null;
  ancho: number | string | null;
  fuelle: number | string | null;
  altura: number | string | null;
  primer_material: string | null;
  primer_calibre: string | null;
  material: string | null;
  calibre: string | null;
  grupo_descripcion: string | null;
  precio_base: number | null;
  costo_laminado: number | null;
  id_tamano_producto: number | null;
  tamano_producto: string | null;
  laminacion: boolean;
  tipo_laminado: string | null;
  idcat_laminado: number | null;
  hs: boolean;
  tipo_hs: string | null;
  idfoil: number | null;
  ar: boolean;
  textura: boolean;
  tipo_textura: string | null;
  idcat_textura: number | null;
  uv: boolean;
  asa: boolean;
  tipo_asa: string | null;
  idcat_tipo_asa: number | null;
  laminados_permitidos: LaminadoPermitidoPapelDto[];
  asas_permitidas: AsaPermitidaPapelDto[];
  tintas_frente_default: number | null;
  tintas_dentro_default: number | null;
  imagen_url: string | null;
  origen: "sistema" | "expo";
  precio_500: number | null;
  precio_1000: number | null;
  precio_3000: number | null;
}
