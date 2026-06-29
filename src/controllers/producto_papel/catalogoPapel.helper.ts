type QueryClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>;
};

export type ReporteCatalogos = Record<string, Set<string>>;

type CatalogoSimpleConfig = {
  tabla: string;
  pk: string;
  catalogoKey: string;
  nombreCrudo?: unknown;
  creadoPor?: number | null;
};

type CatalogoMaquinaConfig = CatalogoSimpleConfig & {
  numeroMaquinaCrudo?: unknown;
};

type CatalogoMedidaConfig = {
  tabla: string;
  pk: string;
  catalogoKey: string;
  nombreFijo: string;
  medidaCrudo?: unknown;
};

type CorteDobleConfig = {
  tabla: string;
  pk: string;
  campo: "corte" | "doble";
  catalogoKey: string;
  valorCrudo?: unknown;
  alturaMmCrudo?: unknown;
  idcatPunto?: number | null;
};

type ListaCatalogoConfig = {
  tabla: string;
  pk: string;
  catalogoKey: string;
  textoComas?: unknown;
};

const IDENTIFICADOR_SQL = /^[a-z_][a-z0-9_]*$/i;

function idSql(valor: string): string {
  if (!IDENTIFICADOR_SQL.test(valor)) {
    throw new Error(`Identificador SQL no válido: ${valor}`);
  }
  return valor;
}

function texto(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  const limpio = String(valor).trim();
  return limpio === "" ? null : limpio;
}

function registrarCreado(
  reporte: ReporteCatalogos,
  catalogo: string,
  valor: string
): void {
  if (!reporte[catalogo]) reporte[catalogo] = new Set<string>();
  reporte[catalogo].add(valor);
}

async function buscarPorTexto(
  client: QueryClient,
  tabla: string,
  pk: string,
  campo: string,
  valor: string
): Promise<number | null> {
  const resultado = await client.query(
    `SELECT ${idSql(pk)} AS id
     FROM ${idSql(tabla)}
     WHERE LOWER(TRIM(${idSql(campo)}::text)) = LOWER(TRIM($1))
     ORDER BY CASE WHEN COALESCE(activo, true) THEN 0 ELSE 1 END
     LIMIT 1`,
    [valor]
  );
  return resultado.rows.length > 0 ? Number(resultado.rows[0].id) : null;
}

async function reactivar(
  client: QueryClient,
  tabla: string,
  pk: string,
  id: number
): Promise<void> {
  await client.query(
    `UPDATE ${idSql(tabla)}
     SET activo = true
     WHERE ${idSql(pk)} = $1
       AND COALESCE(activo, true) = false`,
    [id]
  );
}

export function nuevoReporte(): ReporteCatalogos {
  return {};
}

export function reporteAFilas(
  reporte: ReporteCatalogos
): Array<{ catalogo: string; valores: string[] }> {
  return Object.entries(reporte)
    .filter(([, valores]) => valores.size > 0)
    .map(([catalogo, valores]) => ({
      catalogo,
      valores: [...valores].sort((a, b) => a.localeCompare(b, "es")),
    }))
    .sort((a, b) => a.catalogo.localeCompare(b.catalogo, "es"));
}

export async function resolverCatalogoSimple(
  client: QueryClient,
  reporte: ReporteCatalogos,
  config: CatalogoSimpleConfig
): Promise<number | null> {
  const nombre = texto(config.nombreCrudo);
  if (!nombre) return null;

  const tabla = idSql(config.tabla);
  const pk = idSql(config.pk);
  const existente = await buscarPorTexto(
    client,
    tabla,
    pk,
    "nombre",
    nombre
  );

  if (existente != null) {
    await reactivar(client, tabla, pk, existente);
    return existente;
  }

  const creado = await client.query(
    `INSERT INTO ${tabla} (nombre)
     VALUES ($1)
     RETURNING ${pk} AS id`,
    [nombre]
  );
  registrarCreado(reporte, config.catalogoKey, nombre);
  return Number(creado.rows[0].id);
}

export async function resolverCatalogoMaquina(
  client: QueryClient,
  reporte: ReporteCatalogos,
  config: CatalogoMaquinaConfig
): Promise<number | null> {
  const nombre = texto(config.nombreCrudo);
  if (!nombre) return null;

  const tabla = idSql(config.tabla);
  const pk = idSql(config.pk);
  const numeroMaquina = texto(config.numeroMaquinaCrudo);

  const existente = await client.query(
    `SELECT ${pk} AS id
     FROM ${tabla}
     WHERE LOWER(TRIM(nombre)) = LOWER(TRIM($1))
       AND COALESCE(LOWER(TRIM(numero_maquina)), '') =
           COALESCE(LOWER(TRIM($2)), '')
     ORDER BY CASE WHEN COALESCE(activo, true) THEN 0 ELSE 1 END
     LIMIT 1`,
    [nombre, numeroMaquina]
  );

  if (existente.rows.length > 0) {
    const id = Number(existente.rows[0].id);
    await reactivar(client, tabla, pk, id);
    return id;
  }

  const creado = await client.query(
    `INSERT INTO ${tabla} (nombre, numero_maquina)
     VALUES ($1, $2)
     RETURNING ${pk} AS id`,
    [nombre, numeroMaquina]
  );
  registrarCreado(reporte, config.catalogoKey, nombre);
  return Number(creado.rows[0].id);
}

export async function resolverCalibre(
  client: QueryClient,
  reporte: ReporteCatalogos,
  calibreCrudo: unknown
): Promise<number | null> {
  return resolverCatalogoSimple(client, reporte, {
    tabla: "cat_calibre",
    pk: "idcat_calibre",
    catalogoKey: "calibre",
    nombreCrudo: calibreCrudo,
  });
}

export async function resolverPorMedida(
  client: QueryClient,
  reporte: ReporteCatalogos,
  config: CatalogoMedidaConfig
): Promise<number | null> {
  const medida = texto(config.medidaCrudo);
  if (!medida) return null;

  const tabla = idSql(config.tabla);
  const pk = idSql(config.pk);
  const nombre = texto(config.nombreFijo) ?? medida;
  const existente = await client.query(
    `SELECT ${pk} AS id
     FROM ${tabla}
     WHERE LOWER(TRIM(COALESCE(medida, ''))) = LOWER(TRIM($1))
     ORDER BY CASE WHEN COALESCE(activo, true) THEN 0 ELSE 1 END
     LIMIT 1`,
    [medida]
  );

  if (existente.rows.length > 0) {
    const id = Number(existente.rows[0].id);
    await reactivar(client, tabla, pk, id);
    return id;
  }

  const creado = await client.query(
    `INSERT INTO ${tabla} (nombre, medida)
     VALUES ($1, $2)
     RETURNING ${pk} AS id`,
    [nombre, medida]
  );
  registrarCreado(reporte, config.catalogoKey, medida);
  return Number(creado.rows[0].id);
}

export async function resolverPuntos(
  client: QueryClient,
  reporte: ReporteCatalogos,
  puntosCrudos: unknown
): Promise<number | null> {
  const valor = texto(puntosCrudos);
  if (!valor) return null;

  const puntos = Number.parseInt(valor, 10);
  if (!Number.isFinite(puntos)) {
    throw new Error(`Puntos no válidos: "${valor}"`);
  }

  const existente = await client.query(
    `SELECT idcat_punto AS id
     FROM cat_puntos
     WHERE puntos = $1
     LIMIT 1`,
    [puntos]
  );

  if (existente.rows.length > 0) {
    const id = Number(existente.rows[0].id);
    await reactivar(client, "cat_puntos", "idcat_punto", id);
    return id;
  }

  const creado = await client.query(
    `INSERT INTO cat_puntos (puntos)
     VALUES ($1)
     RETURNING idcat_punto AS id`,
    [puntos]
  );
  registrarCreado(reporte, "puntos", String(puntos));
  return Number(creado.rows[0].id);
}

export async function resolverCorteDoble(
  client: QueryClient,
  reporte: ReporteCatalogos,
  config: CorteDobleConfig
): Promise<number | null> {
  const valor = texto(config.valorCrudo);
  if (!valor) return null;

  const tabla = idSql(config.tabla);
  const pk = idSql(config.pk);
  const campo = idSql(config.campo);
  const altura = texto(config.alturaMmCrudo);

  const existente = await buscarPorTexto(
    client,
    tabla,
    pk,
    campo,
    valor
  );
  if (existente != null) {
    await reactivar(client, tabla, pk, existente);
    await client.query(
      `UPDATE ${tabla}
       SET altura = COALESCE($1, altura),
           idcat_punto = COALESCE($2, idcat_punto)
       WHERE ${pk} = $3`,
      [altura, config.idcatPunto ?? null, existente]
    );
    return existente;
  }

  const creado = await client.query(
    `INSERT INTO ${tabla} (${campo}, altura, idcat_punto)
     VALUES ($1, $2, $3)
     RETURNING ${pk} AS id`,
    [valor, altura, config.idcatPunto ?? null]
  );
  registrarCreado(reporte, config.catalogoKey, valor);
  return Number(creado.rows[0].id);
}

export async function resolverMatrix(
  client: QueryClient,
  reporte: ReporteCatalogos,
  matrixCrudo: unknown
): Promise<number | null> {
  const medida = texto(matrixCrudo);
  if (!medida) return null;

  const existente = await buscarPorTexto(
    client,
    "matrix",
    "idmatrix",
    "medida_matrix",
    medida
  );
  if (existente != null) {
    await reactivar(client, "matrix", "idmatrix", existente);
    return existente;
  }

  const creado = await client.query(
    `INSERT INTO matrix (medida_matrix)
     VALUES ($1)
     RETURNING idmatrix AS id`,
    [medida]
  );
  registrarCreado(reporte, "matrix", medida);
  return Number(creado.rows[0].id);
}

export async function resolverListaCatalogoSimple(
  client: QueryClient,
  reporte: ReporteCatalogos,
  config: ListaCatalogoConfig
): Promise<number[]> {
  const entrada = texto(config.textoComas);
  if (!entrada) return [];

  const nombres = [
    ...new Set(
      entrada
        .split(/[,;\n]+/)
        .map(valor => valor.trim())
        .filter(Boolean)
    ),
  ];

  const ids: number[] = [];
  for (const nombre of nombres) {
    const id = await resolverCatalogoSimple(client, reporte, {
      tabla: config.tabla,
      pk: config.pk,
      catalogoKey: config.catalogoKey,
      nombreCrudo: nombre,
    });
    if (id != null) ids.push(id);
  }
  return ids;
}
