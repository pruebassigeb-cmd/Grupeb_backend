// src/controllers/producto_papel/catalogoPapel.helper.ts
//
// Helper interno del módulo de producto_papel (mismo patrón que
// cotizacionPapel.helper.ts dentro de controllers/cotizaciones/).
//
// Resuelve un NOMBRE de catálogo a su ID. Si no existe, lo crea
// automáticamente y lo registra en un "reporte" para devolverlo al final
// de la carga masiva (opción 3 que elegimos: crear + avisar).
//
// Se usa dentro de la MISMA transacción (mismo `client`) que el resto
// de la carga masiva, para que si algo falla después, el rollback también
// deshaga los catálogos recién creados (consistencia total).

import { PoolClient } from "pg";

export interface ReporteCatalogos {
  // key = nombre de catálogo (ej "tipo_papel"), value = lista de nombres nuevos creados
  nuevos: Record<string, Set<string>>;
}

export function nuevoReporte(): ReporteCatalogos {
  return { nuevos: {} };
}

function registrarNuevo(reporte: ReporteCatalogos, catalogo: string, nombre: string) {
  if (!reporte.nuevos[catalogo]) reporte.nuevos[catalogo] = new Set();
  reporte.nuevos[catalogo].add(nombre);
}

/**
 * Resuelve un catálogo simple: tabla con (pk serial, nombre varchar, activo boolean).
 * Ejemplos: cat_tipo_papel, cat_tipo_producto_papel, cat_tipo_asa, cat_laminado,
 *           cat_tipo_pegado, cat_pegamento, cat_refuerzo_material, cat_refuerzo_medidas,
 *           cat_empaque.
 *
 * Devuelve null si `nombreCrudo` viene vacío/undefined (campo opcional sin valor).
 */
export async function resolverCatalogoSimple(
  client: PoolClient,
  reporte: ReporteCatalogos,
  opts: {
    tabla: string;          // ej "cat_tipo_papel"
    pk: string;             // ej "idcat_tipo_papel"
    catalogoKey: string;    // clave legible para el reporte, ej "tipo_papel"
    nombreCrudo: string | null | undefined;
    creadoPor: number | null;
  }
): Promise<number | null> {
  const { tabla, pk, catalogoKey, creadoPor } = opts;
  const nombre = (opts.nombreCrudo ?? "").trim();
  if (!nombre) return null;

  // Búsqueda case-insensitive para evitar duplicados por mayúsculas/espacios
  const { rows: existe } = await client.query(
    `SELECT ${pk} AS id FROM ${tabla} WHERE LOWER(TRIM(nombre)) = LOWER($1) LIMIT 1`,
    [nombre]
  );
  if (existe.length > 0) return existe[0].id;

  // No existe → lo creamos (todas estas tablas solo tienen columna `nombre` insertable)
  const { rows: creado } = await client.query(
    `INSERT INTO ${tabla} (nombre) VALUES ($1) RETURNING ${pk} AS id`,
    [nombre]
  );
  registrarNuevo(reporte, catalogoKey, nombre);
  return creado[0].id;
}

/**
 * Resuelve catálogos con número de máquina (cat_impresora, cat_uv, cat_textura, etc.)
 * — misma tabla (pk, nombre, activo, numero_maquina).
 * Si no existe, se crea con numero_maquina = null (no viene en el Excel multi-select).
 */
export async function resolverCatalogoMaquina(
  client: PoolClient,
  reporte: ReporteCatalogos,
  opts: { tabla: string; pk: string; catalogoKey: string; nombreCrudo: string }
): Promise<number | null> {
  const { tabla, pk, catalogoKey } = opts;
  const nombre = (opts.nombreCrudo ?? "").trim();
  if (!nombre) return null;

  const { rows: existe } = await client.query(
    `SELECT ${pk} AS id FROM ${tabla} WHERE LOWER(TRIM(nombre)) = LOWER($1) LIMIT 1`,
    [nombre]
  );
  if (existe.length > 0) return existe[0].id;

  const { rows: creado } = await client.query(
    `INSERT INTO ${tabla} (nombre) VALUES ($1) RETURNING ${pk} AS id`,
    [nombre]
  );
  registrarNuevo(reporte, catalogoKey, nombre);
  return creado[0].id;
}

/**
 * Resuelve calibre — se identifica por el campo `nombre` tal cual viene
 * escrito en el Excel: "14pts", "180gms", "24ect".
 */
export async function resolverCalibre(
  client: PoolClient,
  reporte: ReporteCatalogos,
  calibreCrudo: string | null | undefined
): Promise<number | null> {
  return resolverCatalogoSimple(client, reporte, {
    tabla: "cat_calibre",
    pk: "idcat_calibre",
    catalogoKey: "calibre",
    nombreCrudo: calibreCrudo,
    creadoPor: null,
  });
}

/**
 * Sacabocados / Perforado: tabla tiene (pk, nombre, medida, activo).
 * En el Excel solo se captura la MEDIDA (ej "3 mm"); el `nombre` se
 * fija automáticamente como "Sacabocado" / "Perforación" — igual que
 * hace agregarItemCatalogo en tu controller de catálogos.
 */
export async function resolverPorMedida(
  client: PoolClient,
  reporte: ReporteCatalogos,
  opts: {
    tabla: string;              // "cat_sacabocados" | "cat_perforado"
    pk: string;                 // "idcat_sacabocados" | "idcat_perforado"
    catalogoKey: string;        // "sacabocados" | "perforado"
    nombreFijo: string;         // "Sacabocado" | "Perforación"
    medidaCrudo: string | null | undefined;
  }
): Promise<number | null> {
  const { tabla, pk, catalogoKey, nombreFijo } = opts;
  const medida = (opts.medidaCrudo ?? "").trim();
  if (!medida) return null;

  const { rows: existe } = await client.query(
    `SELECT ${pk} AS id FROM ${tabla} WHERE LOWER(TRIM(medida)) = LOWER($1) LIMIT 1`,
    [medida]
  );
  if (existe.length > 0) return existe[0].id;

  const { rows: creado } = await client.query(
    `INSERT INTO ${tabla} (nombre, medida) VALUES ($1, $2) RETURNING ${pk} AS id`,
    [nombreFijo, medida]
  );
  registrarNuevo(reporte, catalogoKey, medida);
  return creado[0].id;
}

/**
 * Cortes / Dobles: tabla tiene (pk, corte|doble, altura, activo, idcat_punto).
 * Se identifica por el valor en pulgadas (ej `0.937"`).
 */
export async function resolverCorteDoble(
  client: PoolClient,
  reporte: ReporteCatalogos,
  opts: {
    tabla: "cat_cortes" | "cat_dobles";
    pk: "idcat_corte" | "idcat_doble";
    campo: "corte" | "doble";
    catalogoKey: "cortes" | "dobles";
    valorCrudo: string | null | undefined;   // ej 0.937"
    alturaMmCrudo: string | number | null | undefined; // ej 23.8
    idcatPunto: number | null;
  }
): Promise<number | null> {
  const { tabla, pk, campo, catalogoKey, idcatPunto } = opts;
  let valor = (opts.valorCrudo ?? "").toString().trim();
  if (!valor) return null;
  if (!valor.endsWith('"')) valor = `${valor}"`;

  const { rows: existe } = await client.query(
    `SELECT ${pk} AS id FROM ${tabla} WHERE LOWER(TRIM(${campo})) = LOWER($1) LIMIT 1`,
    [valor]
  );
  if (existe.length > 0) return existe[0].id;

  let alturaVal: string | null = null;
  if (opts.alturaMmCrudo !== null && opts.alturaMmCrudo !== undefined && opts.alturaMmCrudo !== "") {
    const alturaStr = opts.alturaMmCrudo.toString().trim();
    alturaVal = alturaStr.toLowerCase().endsWith("mm") ? alturaStr : `${alturaStr} mm`;
  }

  const { rows: creado } = await client.query(
    `INSERT INTO ${tabla} (${campo}, altura, idcat_punto) VALUES ($1, $2, $3) RETURNING ${pk} AS id`,
    [valor, alturaVal, idcatPunto]
  );
  registrarNuevo(reporte, catalogoKey, valor);
  return creado[0].id;
}

/**
 * Puntos: tabla (idcat_punto, puntos integer, activo). Identificado por
 * el número directo, ej "8".
 */
export async function resolverPuntos(
  client: PoolClient,
  reporte: ReporteCatalogos,
  puntosCrudo: string | number | null | undefined
): Promise<number | null> {
  if (puntosCrudo === null || puntosCrudo === undefined || puntosCrudo === "") return null;
  const puntos = parseInt(puntosCrudo.toString().trim(), 10);
  if (isNaN(puntos)) return null;

  const { rows: existe } = await client.query(
    `SELECT idcat_punto AS id FROM cat_puntos WHERE puntos = $1 LIMIT 1`,
    [puntos]
  );
  if (existe.length > 0) return existe[0].id;

  const { rows: creado } = await client.query(
    `INSERT INTO cat_puntos (puntos) VALUES ($1) RETURNING idcat_punto AS id`,
    [puntos]
  );
  registrarNuevo(reporte, "puntos", String(puntos));
  return creado[0].id;
}

/**
 * Matrix: tabla (idmatrix, medida_matrix, activo). Identificado por el
 * texto de medida tal cual, ej "0.5 x 1.5".
 */
export async function resolverMatrix(
  client: PoolClient,
  reporte: ReporteCatalogos,
  medidaCrudo: string | null | undefined
): Promise<number | null> {
  const medida = (medidaCrudo ?? "").trim();
  if (!medida) return null;

  const { rows: existe } = await client.query(
    `SELECT idmatrix AS id FROM matrix WHERE LOWER(TRIM(medida_matrix)) = LOWER($1) LIMIT 1`,
    [medida]
  );
  if (existe.length > 0) return existe[0].id;

  const { rows: creado } = await client.query(
    `INSERT INTO matrix (medida_matrix) VALUES ($1) RETURNING idmatrix AS id`,
    [medida]
  );
  registrarNuevo(reporte, "matrix", medida);
  return creado[0].id;
}

/**
 * Resuelve una lista de nombres separados por coma (multi-select) contra
 * un catálogo simple. Devuelve los IDs resueltos/creados.
 * Útil para: asas, laminados, y cada tabla de maquinaria.
 */
export async function resolverListaCatalogoSimple(
  client: PoolClient,
  reporte: ReporteCatalogos,
  opts: { tabla: string; pk: string; catalogoKey: string; textoComas: string | null | undefined }
): Promise<number[]> {
  const texto = (opts.textoComas ?? "").trim();
  if (!texto) return [];
  const nombres = texto.split(",").map(s => s.trim()).filter(Boolean);
  const ids: number[] = [];
  for (const nombre of nombres) {
    const id = await resolverCatalogoSimple(client, reporte, {
      tabla: opts.tabla,
      pk: opts.pk,
      catalogoKey: opts.catalogoKey,
      nombreCrudo: nombre,
      creadoPor: null,
    });
    if (id != null) ids.push(id);
  }
  return ids;
}

/** Convierte el Set acumulado en un arreglo plano de filas para el reporte Excel. */
export function reporteAFilas(reporte: ReporteCatalogos): { catalogo: string; valor_nuevo: string }[] {
  const filas: { catalogo: string; valor_nuevo: string }[] = [];
  for (const [catalogo, valores] of Object.entries(reporte.nuevos)) {
    for (const valor of valores) {
      filas.push({ catalogo, valor_nuevo: valor });
    }
  }
  return filas;
}