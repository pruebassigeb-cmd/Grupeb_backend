import { getPresignedUrl } from "../../config/multer";
import { buscarVariantesPapel } from "../../repositories/expo/catalogoPapelExpo.repository";
import type {
  CatalogoPapelPropioDto,
  CatalogoPapelSistemaDto,
  VariantePapelDbRow,
} from "../../types/expo/catalogoPapelExpo.types";

const URL_TTL_MS = 5 * 60 * 1000;
const MAX_FIRMAS_EN_PARALELO = 8;

interface UrlCacheItem {
  url: string | null;
  expiresAt: number;
}

interface VariantePapelConImagen extends VariantePapelDbRow {
  imagen_url: string | null;
}

const urlCache = new Map<string, UrlCacheItem>();

const aNumeroNullable = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const numero = Number(value);
  return Number.isFinite(numero) ? numero : null;
};

async function ejecutarConConcurrencia<T>(
  items: T[],
  limite: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let indice = 0;

  const consumir = async () => {
    while (indice < items.length) {
      const actual = items[indice++];
      await worker(actual);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limite, items.length) }, consumir),
  );
}

async function obtenerUrlsFirmadas(
  publicIds: Array<string | null>,
): Promise<Map<string, string | null>> {
  const ahora = Date.now();
  const unicos = Array.from(
    new Set(publicIds.filter((id): id is string => Boolean(id))),
  );
  const resultado = new Map<string, string | null>();
  const pendientes: string[] = [];

  for (const publicId of unicos) {
    const cacheado = urlCache.get(publicId);
    if (cacheado && cacheado.expiresAt > ahora) {
      resultado.set(publicId, cacheado.url);
    } else {
      pendientes.push(publicId);
    }
  }

  await ejecutarConConcurrencia(
    pendientes,
    MAX_FIRMAS_EN_PARALELO,
    async (publicId) => {
      try {
        const url = await getPresignedUrl(publicId);
        urlCache.set(publicId, {
          url,
          expiresAt: Date.now() + URL_TTL_MS,
        });
        resultado.set(publicId, url);
      } catch (error) {
        console.error(`[EXPO] No se pudo firmar la imagen ${publicId}:`, error);
        urlCache.set(publicId, {
          url: null,
          expiresAt: Date.now() + 30_000,
        });
        resultado.set(publicId, null);
      }
    },
  );

  return resultado;
}

const nombreProducto = (fila: VariantePapelDbRow): string =>
  fila.descripcion_papel?.trim()
  || fila.tipo_producto?.trim()
  || fila.medida?.trim()
  || `Producto de ${fila.categoria}`;

async function cargarVariantesConImagen(
  params: Parameters<typeof buscarVariantesPapel>[0],
): Promise<VariantePapelConImagen[]> {
  const filas = await buscarVariantesPapel(params);
  const urls = await obtenerUrlsFirmadas(
    filas.map((fila) => fila.imagen_public_id),
  );

  return filas.map((fila) => ({
    ...fila,
    imagen_url: fila.imagen_public_id
      ? (urls.get(fila.imagen_public_id) ?? null)
      : null,
  }));
}

function mapearFilaCatalogoPropio(
  fila: VariantePapelConImagen,
): CatalogoPapelPropioDto {
  return {
    idcatalogo_expo: fila.idproducto_papel,
    idproducto_papel: fila.idproducto_papel,
    idgrupo_papel: fila.idgrupo_papel,
    categoria: fila.categoria,
    nombre: nombreProducto(fila),
    descripcion_papel: fila.descripcion_papel,
    tipo_producto: fila.tipo_producto,
    medida: fila.medida,
    ancho: fila.ancho,
    fuelle: fila.fuelle,
    altura: fila.altura,
    material: fila.material,
    calibre: fila.calibre,
    grupo_descripcion: fila.grupo_descripcion,
    precio_base: aNumeroNullable(fila.precio_base),
    costo_laminado: aNumeroNullable(fila.costo_laminado),
    id_tamano_producto: fila.id_tamano_producto,
    tamano_producto: fila.tamano_producto,
    laminacion: fila.laminacion,
    tipo_laminado: fila.tipo_laminado,
    idcat_laminado: fila.idcat_laminado,
    hs: fila.hs,
    tipo_hs: fila.tipo_hs,
    idfoil: fila.idfoil,
    ar: fila.ar,
    textura: fila.textura,
    tipo_textura: fila.tipo_textura,
    idcat_textura: fila.idcat_textura,
    uv: fila.uv,
    asa: fila.asa,
    tipo_asa: fila.tipo_asa,
    idcat_tipo_asa: fila.idcat_tipo_asa,
    laminados_permitidos: fila.laminados_permitidos,
    asas_permitidas: fila.asas_permitidas,
    tintas: null,
    otro: null,
    tintas_frente_default: fila.tintas_frente_default,
    tintas_dentro_default: fila.tintas_dentro_default,
    imagen_url: fila.imagen_url,
    origen: "expo",
    precio_500: aNumeroNullable(fila.precio_500),
    precio_1000: aNumeroNullable(fila.precio_1000),
    precio_3000: aNumeroNullable(fila.precio_3000),
  };
}

export async function listarCatalogoPapelPropio(): Promise<CatalogoPapelPropioDto[]> {
  const filas = await cargarVariantesConImagen({ origenExpo: true });
  return filas.map(mapearFilaCatalogoPropio);
}

export async function listarCatalogoPapelSistema(): Promise<CatalogoPapelSistemaDto[]> {
  // Sin filtro de origen para conservar el comportamiento actual de
  // /catalogo/sistema: devuelve todos los activos y el frontend deduplica los
  // que también vienen en catálogo propio.
  const filas = await cargarVariantesConImagen({});

  return filas.map((fila) => ({
    id: fila.idproducto_papel,
    idproducto_papel: fila.idproducto_papel,
    idgrupo_papel: fila.idgrupo_papel,
    categoria: fila.categoria,
    nombre: fila.tipo_producto || nombreProducto(fila),
    descripcion_papel: fila.descripcion_papel,
    tipo_producto: fila.tipo_producto,
    medida: fila.medida,
    ancho: fila.ancho,
    fuelle: fila.fuelle,
    altura: fila.altura,
    primer_material: fila.material,
    primer_calibre: fila.calibre,
    material: fila.material,
    calibre: fila.calibre,
    grupo_descripcion: fila.grupo_descripcion,
    precio_base: aNumeroNullable(fila.precio_base),
    costo_laminado: aNumeroNullable(fila.costo_laminado),
    id_tamano_producto: fila.id_tamano_producto,
    tamano_producto: fila.tamano_producto,
    laminacion: fila.laminacion,
    tipo_laminado: fila.tipo_laminado,
    idcat_laminado: fila.idcat_laminado,
    hs: fila.hs,
    tipo_hs: fila.tipo_hs,
    idfoil: fila.idfoil,
    ar: fila.ar,
    textura: fila.textura,
    tipo_textura: fila.tipo_textura,
    idcat_textura: fila.idcat_textura,
    uv: fila.uv,
    asa: fila.asa,
    tipo_asa: fila.tipo_asa,
    idcat_tipo_asa: fila.idcat_tipo_asa,
    laminados_permitidos: fila.laminados_permitidos,
    asas_permitidas: fila.asas_permitidas,
    tintas_frente_default: fila.tintas_frente_default,
    tintas_dentro_default: fila.tintas_dentro_default,
    imagen_url: fila.imagen_url,
    origen: fila.origen_expo ? "expo" : "sistema",
    precio_500: aNumeroNullable(fila.precio_500),
    precio_1000: aNumeroNullable(fila.precio_1000),
    precio_3000: aNumeroNullable(fila.precio_3000),
  }));
}

export async function obtenerProductoPapelCatalogoExpoPorId(
  idProductoPapel: number,
): Promise<CatalogoPapelPropioDto | null> {
  const filas = await cargarVariantesConImagen({ idProductoPapel });
  return filas.length ? mapearFilaCatalogoPropio(filas[0]) : null;
}
