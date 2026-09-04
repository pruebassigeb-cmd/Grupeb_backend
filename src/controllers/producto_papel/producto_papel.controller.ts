import { iniciarTx, qAudit } from "../../middlewares/auditoria";
import { Request, Response } from "express";
import { pool } from "../../config/db";
import { getPresignedUrl } from "../../config/multer";

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS DE FORMATO NUMÉRICO (ancho / fuelle / altura / medida)
// ═══════════════════════════════════════════════════════════════════════════
// Postgres regresa las columnas numeric como texto con ceros decimales fijos
// (ej. "12.00"). limpiarNumero los deja como "12" (o "12.5" si el decimal es
// real). Se aplica aquí, en el backend, para que CUALQUIER consumidor
// (frontend de alta, PDF, futuras vistas) reciba el valor ya correcto sin
// tener que repetir el filtro en cada lugar donde se use.
function limpiarNumero(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : String(v);
}

// El cálculo se realiza en el frontend para mostrarlo en tiempo real. El
// backend no lo recalcula: únicamente valida el valor recibido antes de
// guardarlo en producto_papel.costo_laminado.
function costoLaminadoONull(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === "") return null;

  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero < 0) return null;

  return Number(numero.toFixed(4));
}

// Recalcula "medida" a partir de ancho/fuelle/altura YA limpios, con la
// misma regla que usa el frontend: "ancho+fuellexaltura" si hay fuelle
// distinto de 0, o "anchoxaltura" si no. Si no hay ancho ni altura, se
// respeta la medida ya guardada en BD (por si el producto no usa estos
// campos y la medida se capturó como texto libre).
function recalcularMedida(anchoLimpio: string | null, fuelleLimpio: string | null, alturaLimpio: string | null, medidaOriginal: string | null): string | null {
  if (!anchoLimpio && !alturaLimpio) return medidaOriginal;
  const tieneFuelle = fuelleLimpio && fuelleLimpio !== "0";
  return tieneFuelle
    ? `${anchoLimpio ?? ""}+${fuelleLimpio}x${alturaLimpio ?? ""}`
    : `${anchoLimpio ?? ""}x${alturaLimpio ?? ""}`;
}

function limpiarMedidasProducto<T extends { ancho?: unknown; fuelle?: unknown; altura?: unknown; medida?: unknown }>(row: T): T {
  const ancho = limpiarNumero(row.ancho);
  const fuelle = limpiarNumero(row.fuelle);
  const altura = limpiarNumero(row.altura);
  return {
    ...row,
    ancho,
    fuelle,
    altura,
    medida: recalcularMedida(ancho, fuelle, altura, (row.medida as string) ?? null),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ALCANCE (SCOPE): producto normal vs. componente de un producto especial
// ═══════════════════════════════════════════════════════════════════════════
// Fase 1 (migración) le agregó idcomponente_papel a suaje_papel, acabados_papel
// y las 14 maquinaria_* como columna NULLABLE con índice único parcial dual:
// un producto normal sigue usando idproducto_papel (idcomponente_papel queda
// NULL, exactamente como hoy); un producto especial reparte esas mismas
// tablas por componente (una fila por componente, idcomponente_papel poblado,
// idproducto_papel viaja igual como referencia denormalizada porque la
// columna es NOT NULL en las 14 tablas de maquinaria).
//
// Scope encapsula "a quién le pertenece este renglón" para que las funciones
// de suaje/acabados/maquinaria no se dupliquen: una única implementación de
// cada una sirve tanto al producto (scope.idcomponente_papel = null) como a
// cada componente (scope.idcomponente_papel = <id>).
type Scope = { idproducto_papel: number; idcomponente_papel: number | null };

function scopeWhere(scope: Scope, paramIndex: number, alias: string = ""): { sql: string; value: number } {
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  return scope.idcomponente_papel != null
    ? { sql: `${col("idcomponente_papel")} = $${paramIndex}`, value: scope.idcomponente_papel }
    : { sql: `${col("idproducto_papel")} = $${paramIndex} AND ${col("idcomponente_papel")} IS NULL`, value: scope.idproducto_papel };
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS MAQUINARIA MULTISELECT
// ═══════════════════════════════════════════════════════════════════════════
const MAQ_PIVOTS: Record<string, { tabla: string; col: string }> = {
  hojeado_guillotina: { tabla: "maquinaria_hojeado_guillotina", col: "idcat_hojeado_guillotina" },
  impresora:          { tabla: "maquinaria_impresora",          col: "idcat_impresora"          },
  hs_ar:              { tabla: "maquinaria_hs_ar",              col: "idcat_hs_ar"              },
  suaje_maquina:      { tabla: "maquinaria_suaje_maquina",      col: "idcat_suaje_maquina"      },
  uv:                 { tabla: "maquinaria_uv",                 col: "idcat_uv"                 },
  texturizadora:      { tabla: "maquinaria_texturizadora",      col: "idcat_texturizadora"      },
  empalme:            { tabla: "maquinaria_empalme",            col: "idcat_empalme"            },
  armado:             { tabla: "maquinaria_armado",             col: "idcat_armado"             },
  asas_maquina:       { tabla: "maquinaria_asas_maquina",       col: "idcat_asas_maquina"       },
  desbarbe:           { tabla: "maquinaria_desbarbe",           col: "idcat_desbarbe"           },
  laminado_maquina:   { tabla: "maquinaria_laminado",           col: "idcat_laminado_maquina"   },
  empaque_maquina:    { tabla: "maquinaria_empaque",            col: "idcat_empaque_maquina"    },
  // NOTA: maquinaria_alto_relieve y maquinaria_textura existen en BD (y ya
  // quedaron preparadas en Fase 1 con el mismo idcomponente_papel) pero hoy
  // ningún formulario las captura — no se agregan aquí para no inventar una
  // capacidad que el producto normal tampoco tiene. El día que se exponga
  // esa selección de máquina, entra a este mapa igual que las demás y queda
  // servida por componente sin más cambios.
};

const CAT_TABLES: Record<string, string> = {
  hojeado_guillotina: "cat_hojeado_guillotina",
  impresora:          "cat_impresora",
  hs_ar:              "cat_hs_ar",
  suaje_maquina:      "cat_suaje_maquina",
  uv:                 "cat_uv",
  texturizadora:      "cat_texturizadora",
  empalme:            "cat_empalme",
  armado:             "cat_armado",
  asas_maquina:       "cat_asas_maquina",
  desbarbe:           "cat_desbarbe",
  laminado_maquina:   "cat_laminado_maquina",
  empaque_maquina:    "cat_empaque_maquina",
};

async function insertarMaquinaria(client: any, scope: Scope, maquinaria: Record<string, number[]>) {
  for (const [key, pivot] of Object.entries(MAQ_PIVOTS)) {
    const ids: number[] = maquinaria[key] ?? [];
    for (const id of ids) {
      await client.query(
        `INSERT INTO ${pivot.tabla} (idproducto_papel, idcomponente_papel, ${pivot.col})
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [scope.idproducto_papel, scope.idcomponente_papel, id]
      );
    }
  }
}

async function eliminarMaquinaria(client: any, scope: Scope) {
  const where = scopeWhere(scope, 1);
  for (const pivot of Object.values(MAQ_PIVOTS)) {
    await client.query(`DELETE FROM ${pivot.tabla} WHERE ${where.sql}`, [where.value]);
  }
}

async function getMaquinaria(scope: Scope) {
  const result: Record<string, { id: number; nombre: string; numero_maquina?: string | null; tipo_maquina?: string | null }[]> = {};
  const where = scopeWhere(scope, 1, "m");
  for (const [key, pivot] of Object.entries(MAQ_PIVOTS)) {
    const cat = CAT_TABLES[key];
    const extraSelect = key === "hojeado_guillotina"
      ? ", c.numero_maquina, c.tipo_maquina"
      : ", c.numero_maquina";
    const { rows } = await pool.query(
      `SELECT m.${pivot.col} AS id, c.nombre${extraSelect}
       FROM ${pivot.tabla} m
       JOIN ${cat} c ON c.${pivot.col} = m.${pivot.col}
       WHERE ${where.sql}
       ORDER BY c.nombre ASC`,
      [where.value]
    );
    result[key] = rows;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS LAMINADO MULTISELECT
// ═══════════════════════════════════════════════════════════════════════════
async function insertarLaminado(client: any, idacabados_papel: number, laminados: number[]) {
  for (const idcat_laminado of laminados) {
    await client.query(
      `INSERT INTO acabados_laminado (idacabados_papel, idcat_laminado)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [idacabados_papel, idcat_laminado]
    );
  }
}

async function getLaminado(idacabados_papel: number) {
  const { rows } = await pool.query(
    `SELECT al.idcat_laminado AS id, cl.nombre
     FROM acabados_laminado al
     JOIN cat_laminado cl ON cl.idcat_laminado = al.idcat_laminado
     WHERE al.idacabados_papel = $1`,
    [idacabados_papel]
  );
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS SUAJE / ACABADOS — upsert por scope (producto o componente)
// ═══════════════════════════════════════════════════════════════════════════
// Extraídos de lo que antes vivía inline, duplicado, en crearProductoPapel y
// actualizarProductoPapel. Ahora una sola implementación sirve a ambos y,
// con scope.idcomponente_papel, también a cada componente de un producto
// especial — que es exactamente donde antes se hubiera tenido que duplicar
// por tercera vez.
async function upsertSuaje(client: any, scope: Scope, suaje: any): Promise<void> {
  if (!suaje) return;

  const where = scopeWhere(scope, 1);
  const { rows: existe } = await client.query(
    `SELECT idsuaje_papel FROM suaje_papel WHERE ${where.sql}`,
    [where.value]
  );

  const valores = [
    suaje.numero              ?? null,
    suaje.pzs                 ?? null,
    suaje.tamano              ?? null,
    suaje.corte1_tipo         ?? null,
    suaje.corte1_medida       ?? null,
    suaje.idcat_corte         ?? null,
    suaje.idcat_punto_corte   ?? null,
    suaje.dobles1_tipo        ?? null,
    suaje.dobles1_medida      ?? null,
    suaje.idcat_doble         ?? null,
    suaje.idcat_punto_doble   ?? null,
    suaje.metros              ?? null,
    suaje.idcat_matrix        ?? null,
    suaje.tiempo_arreglo      ?? null,
    suaje.idcat_sacabocados   ?? null,
    suaje.cantidad_sacabocado ?? null,
    suaje.idcat_perforado     ?? null,
    suaje.cantidad_perforado  ?? null,
    suaje.herramental_desbarbe === true,
    suaje.no_desbarbe         ?? null,
  ];

  if (existe.length > 0) {
    await client.query(`
      UPDATE suaje_papel SET
        numero = $1, pzs = $2, tamano = $3,
        corte1_tipo = $4, corte1_medida = $5, idcat_corte = $6, idcat_punto_corte = $7,
        dobles1_tipo = $8, dobles1_medida = $9, idcat_doble = $10, idcat_punto_doble = $11,
        metros = $12, idcat_matrix = $13, tiempo_arreglo = $14,
        idcat_sacabocados = $15, cantidad_sacabocado = $16,
        idcat_perforado   = $17, cantidad_perforado  = $18,
        herramental_desbarbe = $19, no_desbarbe = $20
      WHERE idsuaje_papel = $21
    `, [...valores, existe[0].idsuaje_papel]);
  } else {
    await client.query(`
      INSERT INTO suaje_papel (
        idproducto_papel, idcomponente_papel,
        numero, pzs, tamano,
        corte1_tipo, corte1_medida, idcat_corte, idcat_punto_corte,
        dobles1_tipo, dobles1_medida, idcat_doble, idcat_punto_doble,
        metros, idcat_matrix, tiempo_arreglo,
        idcat_sacabocados, cantidad_sacabocado,
        idcat_perforado,   cantidad_perforado,
        herramental_desbarbe, no_desbarbe
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
    `, [scope.idproducto_papel, scope.idcomponente_papel, ...valores]);
  }
}

async function getSuaje(scope: Scope) {
  const where = scopeWhere(scope, 1, "s");
  const { rows } = await pool.query(`
    SELECT
      s.*,
      sc.nombre  AS sacabocado_nombre,
      sc.medida  AS sacabocado_medida,
      pe.nombre  AS perforado_nombre,
      pe.medida  AS perforado_medida,
      mx.medida_matrix AS matrix_nombre,
      mx.idmatrix      AS idcat_matrix,
      pc.puntos  AS puntos_corte,
      pd.puntos  AS puntos_doble
    FROM suaje_papel s
    LEFT JOIN cat_sacabocados sc ON sc.idcat_sacabocados = s.idcat_sacabocados
    LEFT JOIN cat_perforado   pe ON pe.idcat_perforado   = s.idcat_perforado
    LEFT JOIN matrix          mx ON mx.idmatrix          = s.idcat_matrix
    LEFT JOIN cat_puntos      pc ON pc.idcat_punto       = s.idcat_punto_corte
    LEFT JOIN cat_puntos      pd ON pd.idcat_punto       = s.idcat_punto_doble
    WHERE ${where.sql}
  `, [where.value]);
  return rows[0] ?? null;
}

async function upsertAcabados(client: any, scope: Scope, acabados: any): Promise<void> {
  if (!acabados) return;

  const where = scopeWhere(scope, 1);
  const { rows: existe } = await client.query(
    `SELECT idacabados_papel FROM acabados_papel WHERE ${where.sql}`,
    [where.value]
  );

  const valores = [
    acabados.idcat_tipo_pegado       ?? null,
    acabados.idcat_pegamento         ?? null,
    acabados.idrollo_lam             ?? null,
    acabados.desarrollo_laminado     ?? null,
    acabados.idcat_refuerzo_material ?? null,
    acabados.idcat_refuerzo_medidas  ?? null,
    acabados.idcat_base_material     ?? null,
    acabados.base_medida             ?? null,
    acabados.idcat_empaque           ?? null,
    acabados.pzs_caja                ?? null,
    acabados.lleva_uv               === true,
    acabados.lleva_alto_relieve     === true,
    acabados.lleva_textura          === true,
    acabados.lleva_hot_stamping     === true,
    // Campos propios del proceso "Pegado" de la ruta (Fase 2) -- ver nota
    // en la migración: distintos de idcat_tipo_pegado/idcat_pegamento de
    // arriba, que son de Armado.
    acabados.idcat_tipo_pegado_pegado ?? null,
    acabados.que_se_pega              ?? null,
  ];

  let idacabados_papel: number;
  if (existe.length > 0) {
    idacabados_papel = existe[0].idacabados_papel;
    await client.query(`
      UPDATE acabados_papel SET
        idcat_tipo_pegado = $1, idcat_pegamento = $2,
        idrollo_lam = $3, desarrollo_laminado = $4,
        idcat_refuerzo_material = $5, idcat_refuerzo_medidas = $6,
        idcat_base_material = $7, base_medida = $8,
        idcat_empaque = $9, pzs_caja = $10,
        lleva_uv = $11, lleva_alto_relieve = $12,
        lleva_textura = $13, lleva_hot_stamping = $14,
        idcat_tipo_pegado_pegado = $15, que_se_pega = $16
      WHERE idacabados_papel = $17
    `, [...valores, idacabados_papel]);
  } else {
    const { rows: nuevo } = await client.query(`
      INSERT INTO acabados_papel (
        idproducto_papel, idcomponente_papel,
        idcat_tipo_pegado, idcat_pegamento,
        idrollo_lam, desarrollo_laminado,
        idcat_refuerzo_material, idcat_refuerzo_medidas,
        idcat_base_material, base_medida,
        idcat_empaque, pzs_caja,
        lleva_uv, lleva_alto_relieve, lleva_textura, lleva_hot_stamping,
        idcat_tipo_pegado_pegado, que_se_pega
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING idacabados_papel
    `, [scope.idproducto_papel, scope.idcomponente_papel, ...valores]);
    idacabados_papel = nuevo[0].idacabados_papel;
  }

  await client.query(`DELETE FROM acabados_asas WHERE idacabados_papel = $1`, [idacabados_papel]);
  const asas: number[] = acabados.asas ?? [];
  for (const idcat_tipo_asa of asas) {
    await client.query(`
      INSERT INTO acabados_asas (idacabados_papel, idcat_tipo_asa)
      VALUES ($1, $2) ON CONFLICT DO NOTHING
    `, [idacabados_papel, idcat_tipo_asa]);
  }

  await client.query(`DELETE FROM acabados_laminado WHERE idacabados_papel = $1`, [idacabados_papel]);
  await insertarLaminado(client, idacabados_papel, acabados.laminados ?? []);
}

async function getAcabados(scope: Scope) {
  const where = scopeWhere(scope, 1, "a");
  const { rows } = await pool.query(`
    SELECT
      a.*,
      tp.nombre   AS tipo_pegado,
      pg.nombre   AS pegamento,
      tpp.nombre  AS tipo_pegado_pegado,
      rl.nombre        AS rollo_lam,
      rl.medida_ancho  AS rollo_lam_medida_ancho,
      rm.nombre        AS refuerzo_material,
      rmed.nombre AS refuerzo_medida,
      bm.nombre   AS base_material,
      em.nombre   AS empaque
    FROM acabados_papel a
    LEFT JOIN cat_tipo_pegado       tp   ON tp.idcat_tipo_pegado       = a.idcat_tipo_pegado
    LEFT JOIN cat_pegamento         pg   ON pg.idcat_pegamento         = a.idcat_pegamento
    -- Catálogo propio del proceso "Pegado" de la ruta (Fase 2) -- mismo
    -- catálogo cat_tipo_pegado, columna distinta (idcat_tipo_pegado_pegado).
    LEFT JOIN cat_tipo_pegado       tpp  ON tpp.idcat_tipo_pegado      = a.idcat_tipo_pegado_pegado
    LEFT JOIN rollo_lam             rl   ON rl.idrollo_lam             = a.idrollo_lam
    LEFT JOIN cat_refuerzo_material rm   ON rm.idcat_refuerzo_material = a.idcat_refuerzo_material
    LEFT JOIN cat_refuerzo_medidas  rmed ON rmed.idcat_refuerzo_medidas = a.idcat_refuerzo_medidas
    LEFT JOIN cat_refuerzo_material bm   ON bm.idcat_refuerzo_material = a.idcat_base_material
    LEFT JOIN cat_empaque           em   ON em.idcat_empaque           = a.idcat_empaque
    WHERE ${where.sql}
  `, [where.value]);

  if (rows.length === 0) return null;
  const acabados = rows[0];

  const { rows: asasRows } = await pool.query(`
    SELECT aa.idacabados_asa, ta.idcat_tipo_asa, ta.nombre AS tipo_asa
    FROM acabados_asas aa
    JOIN cat_tipo_asa ta ON ta.idcat_tipo_asa = aa.idcat_tipo_asa
    WHERE aa.idacabados_papel = $1
  `, [acabados.idacabados_papel]);

  acabados.asas      = asasRows;
  acabados.laminados = await getLaminado(acabados.idacabados_papel);
  return acabados;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS COMPONENTE_PAPEL (Fase 2: productos especiales)
// ═══════════════════════════════════════════════════════════════════════════
// Un componente = una orden de producción planeada (ver modulo-productos-
// especiales.html, sección "Modelo de datos"). Aquí solo vive el alta/lectura
// de la DEFINICIÓN del producto: componente_papel, su ruta de procesos
// (componente_papel_proceso) y qué material trabaja cada proceso
// (componente_papel_proceso_material). Convertir esto en N órdenes de
// producción reales es motor de seguimiento — Fase 7, no esta.

async function getComponentes(idproducto_papel: number) {
  const { rows: compRows } = await pool.query(`
    SELECT idcomponente_papel, tipo, orden, nombre, es_union
    FROM componente_papel
    WHERE idproducto_papel = $1
    ORDER BY es_union ASC, orden ASC NULLS LAST, idcomponente_papel ASC
  `, [idproducto_papel]);

  const componentes: any[] = [];
  for (const comp of compRows) {
    const scope: Scope = { idproducto_papel, idcomponente_papel: comp.idcomponente_papel };

    const { rows: procesoRows } = await pool.query(`
      SELECT cpp.idcomponente_papel_proceso, cpp.idproceso_cat, cpp.orden, cpp.observaciones,
             cpp.veces,
             pc.nombre_proceso,
             -- NUEVO: tabla/familia del proceso. nombre_proceso es texto libre
             -- del catálogo y no sirve para decidir nada por código; la columna
             -- tabla es la llave estable con la que ya se resuelve la máquina
             -- de cada proceso (ver CLAVE_MAQUINA_POR_TABLA). La cotización y
             -- el pedido la usan para mostrar SOLO los campos de los procesos
             -- que el producto especial realmente tiene en su ruta
             -- (impresion_papel, laminacion_papel, armado_papel...).
             pc.tabla, pc.familia
      FROM componente_papel_proceso cpp
      JOIN proceso_cat pc ON pc.idproceso_cat = cpp.idproceso_cat
      WHERE cpp.idcomponente_papel = $1
      ORDER BY cpp.orden ASC
    `, [comp.idcomponente_papel]);

    for (const proceso of procesoRows) {
      const { rows: matRows } = await pool.query(
        `SELECT iddetalle_material FROM componente_papel_proceso_material WHERE idcomponente_papel_proceso = $1`,
        [proceso.idcomponente_papel_proceso]
      );
      proceso.materiales = matRows.map((r: any) => r.iddetalle_material);
    }

    componentes.push({
      ...comp,
      procesos:   procesoRows,
      suaje:      await getSuaje(scope),
      acabados:   await getAcabados(scope),
      maquinaria: await getMaquinaria(scope),
    });
  }
  return componentes;
}

// Crea/actualiza únicamente el "caparazón" del componente (tipo, orden,
// nombre, es_union) — mismo patrón de preservar id que grupos/materiales:
// si trae idcomponente_papel y ya existía, UPDATE; si no, INSERT. Devuelve
// el mapa client_key → idcomponente_papel real (para resolver la asignación
// de materiales y las referencias de proceso más abajo, en la misma
// petición) y el set de ids conservados (para poder borrar los que ya no
// vinieron, al final de actualizarProductoPapel).
async function upsertComponentesShell(
  client: any,
  idproducto_papel: number,
  componentesEntrantes: any[],
  idusuario: number | null,
  idsExistentes: Set<number>
): Promise<{ clientKeyToId: Map<string, number>; idsConservados: Set<number> }> {
  const clientKeyToId = new Map<string, number>();
  const idsConservados = new Set<number>();

  for (const comp of componentesEntrantes) {
    const idEntrante = Number(comp.idcomponente_papel) || null;
    let idcomponente_papel: number;

    if (idEntrante && idsExistentes.has(idEntrante)) {
      await client.query(`
        UPDATE componente_papel SET
          tipo = $1, orden = $2, nombre = $3, es_union = $4,
          actualizado_por = $5, updated_at = NOW()
        WHERE idcomponente_papel = $6 AND idproducto_papel = $7
      `, [comp.tipo, comp.orden ?? null, comp.nombre ?? null, comp.es_union === true, idusuario, idEntrante, idproducto_papel]);
      idcomponente_papel = idEntrante;
    } else {
      const { rows } = await client.query(`
        INSERT INTO componente_papel (idproducto_papel, tipo, orden, nombre, es_union, creado_por, actualizado_por)
        VALUES ($1, $2, $3, $4, $5, $6, $6)
        RETURNING idcomponente_papel
      `, [idproducto_papel, comp.tipo, comp.orden ?? null, comp.nombre ?? null, comp.es_union === true, idusuario]);
      idcomponente_papel = rows[0].idcomponente_papel;
    }

    idsConservados.add(idcomponente_papel);
    if (comp.client_key != null) clientKeyToId.set(String(comp.client_key), idcomponente_papel);
  }

  return { clientKeyToId, idsConservados };
}

// Ruta de procesos de UN componente ya resuelto (idcomponente_papel real).
// materialClientKeyToId resuelve las referencias a materiales nuevos
// (creados en esta misma petición, sin id todavía); un número plano en
// proceso.materiales se toma como iddetalle_material ya existente.
async function upsertComponenteProcesos(
  client: any,
  idcomponente_papel: number,
  procesosEntrantes: any[],
  materialClientKeyToId: Map<string, number>,
  idusuario: number | null
): Promise<void> {
  const { rows: existentes } = await client.query(
    `SELECT idcomponente_papel_proceso FROM componente_papel_proceso WHERE idcomponente_papel = $1`,
    [idcomponente_papel]
  );
  const idsExistentes = new Set<number>(existentes.map((r: any) => r.idcomponente_papel_proceso));
  const idsConservados = new Set<number>();

  for (let pi = 0; pi < procesosEntrantes.length; pi++) {
    const proceso = procesosEntrantes[pi];
    const ordenProceso = proceso.orden ?? pi + 1;
    // `veces` = cuántas pasadas trae este paso de la ruta ("Laminación x2").
    // Default 1 -- mismo significado que hoy (una sola pasada), y coincide
    // con el DEFAULT de la columna en BD (Fase 2). Nunca menor a 1.
    const vecesProceso = Math.max(1, Number(proceso.veces) || 1);
    const idProcesoEntrante = Number(proceso.idcomponente_papel_proceso) || null;
    let idcomponente_papel_proceso: number;

    if (idProcesoEntrante && idsExistentes.has(idProcesoEntrante)) {
      await client.query(`
        UPDATE componente_papel_proceso SET
          idproceso_cat = $1, orden = $2, observaciones = $3, veces = $4,
          actualizado_por = $5, updated_at = NOW()
        WHERE idcomponente_papel_proceso = $6 AND idcomponente_papel = $7
      `, [proceso.idproceso_cat, ordenProceso, proceso.observaciones ?? null, vecesProceso, idusuario, idProcesoEntrante, idcomponente_papel]);
      idcomponente_papel_proceso = idProcesoEntrante;
    } else {
      const { rows } = await client.query(`
        INSERT INTO componente_papel_proceso (idcomponente_papel, idproceso_cat, orden, observaciones, veces, creado_por, actualizado_por)
        VALUES ($1, $2, $3, $4, $5, $6, $6)
        RETURNING idcomponente_papel_proceso
      `, [idcomponente_papel, proceso.idproceso_cat, ordenProceso, proceso.observaciones ?? null, vecesProceso, idusuario]);
      idcomponente_papel_proceso = rows[0].idcomponente_papel_proceso;
    }
    idsConservados.add(idcomponente_papel_proceso);

    // Qué material(es) trabaja este proceso. Se recalcula completo en cada
    // guardado (borrar + reinsertar el vínculo, no el material ni el
    // proceso) porque es una tabla puente sin datos propios que preservar.
    await client.query(
      `DELETE FROM componente_papel_proceso_material WHERE idcomponente_papel_proceso = $1`,
      [idcomponente_papel_proceso]
    );
    const materialesRefs: (string | number)[] = proceso.materiales ?? [];
    for (const ref of materialesRefs) {
      const iddetalle_material = typeof ref === "number" ? ref : materialClientKeyToId.get(String(ref));
      if (!iddetalle_material) continue; // referencia que no se pudo resolver: se ignora, no tumba el alta completa
      await client.query(`
        INSERT INTO componente_papel_proceso_material (idcomponente_papel_proceso, iddetalle_material)
        VALUES ($1, $2) ON CONFLICT DO NOTHING
      `, [idcomponente_papel_proceso, iddetalle_material]);
    }
  }

  const idsAEliminar = [...idsExistentes].filter(pid => !idsConservados.has(pid));
  if (idsAEliminar.length > 0) {
    await client.query(
      `DELETE FROM componente_papel_proceso WHERE idcomponente_papel_proceso = ANY($1::int[])`,
      [idsAEliminar]
    );
  }
}

// Borra los componentes que existían y ya no vinieron en esta edición.
// CASCADE se encarga de su suaje/acabados/maquinaria/procesos; SET NULL
// desasigna (no borra) los materiales que le apuntaban. Si algún componente
// ya generó una orden de producción real (Fase 7), la FK orden_produccion
// .idcomponente_papel (ON DELETE NO ACTION) rechaza el borrado y el error
// sube tal cual al catch de arriba — proteger el historial de producción
// importa más que dejar borrar cualquier cosa desde este formulario.
async function eliminarComponentesNoConservados(client: any, idproducto_papel: number, idsConservados: Set<number>): Promise<void> {
  const ids = [...idsConservados];
  await client.query(
    `DELETE FROM componente_papel WHERE idproducto_papel = $1 AND NOT (idcomponente_papel = ANY($2::int[]))`,
    [idproducto_papel, ids]
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /productos-papel
// ═══════════════════════════════════════════════════════════════════════════
export const getProductosPapel = async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        pp.idproducto_papel,
        pp.ancho,
        pp.fuelle,
        pp.altura,
        pp.medida,
        pp.tamano_asa_default,
        pp.tamano_prod,
        pp.costo_laminado,
        ctam.nombre                      AS tamano_prod_nombre,
        pp.descripcion_papel,
        pp.activo,
        pp.created_at,
        pp.origen_expo,
        -- NUEVO (reestructura de especiales): nadie lo pedía aquí porque el
        -- listado enumera columnas a mano (a diferencia de getProductoPapelById,
        -- que hace pp.* y por eso ya lo traía). Papel.tsx y ProductoEspecial.tsx
        -- lo necesitan para mostrar cada quien solo lo suyo.
        pp.es_especial,
        tp.nombre                        AS tipo_producto,
        u.nombre || ' ' || u.apellido    AS creado_por,

        -- Tipos de papel y calibres de todos los grupos (separados por " / ")
        mat_preview.primer_tipo_papel,
        mat_preview.primer_calibre,
        mat_preview.primer_pliego,

        -- Costo base = precio_sugerido del Grupo 1 (para mostrar en la tabla
        -- principal sin tener que abrir el detalle del producto). También se
        -- manda su idgrupo_papel para poder editar ese costo directo desde
        -- la celda de la tabla (modo edición inline), y el total de grupos
        -- para saber si el producto tiene más de una opción de material.
        grupo1.idgrupo_papel              AS idgrupo_papel_grupo1,
        grupo1.precio_sugerido            AS costo_base_grupo1,
        grupos_total.total                AS total_grupos,

        -- Datos para el modal general de costo de laminado (ver lateral
        -- lam_info / suaje_info más abajo)
        lam_info.idrollo_lam,
        lam_info.rollo_lam_nombre,
        lam_info.rollo_lam_medida_ancho,
        lam_info.desarrollo_laminado,
        suaje_info.piezas_suaje,

        -- Archivos para vista previa en la tabla
        arch_prev.archivos_raw,

        -- ═══════════════════════════════════════════════════════════════
        -- % DE COMPLETITUD DEL PRODUCTO
        -- ═══════════════════════════════════════════════════════════════
        -- Compara cuántos campos relevantes están llenos contra el total
        -- posible: generales (7) + suaje (16) + acabados (12) +
        -- maquinaria (12) + materiales (variable según cuántos haya) +
        -- archivos (1). Se calcula aquí, en la misma consulta que ya arma
        -- el listado, para no tener que pedir el detalle de cada producto
        -- por separado (evita N+1 peticiones).
        ROUND(
          (
            (
              (CASE WHEN pp.descripcion_papel IS NOT NULL AND pp.descripcion_papel <> '' THEN 1 ELSE 0 END) +
              (CASE WHEN pp.ancho IS NOT NULL THEN 1 ELSE 0 END) +
              (CASE WHEN pp.fuelle IS NOT NULL THEN 1 ELSE 0 END) +
              (CASE WHEN pp.altura IS NOT NULL THEN 1 ELSE 0 END) +
              (CASE WHEN pp.medida IS NOT NULL AND pp.medida <> '' THEN 1 ELSE 0 END) +
              (CASE WHEN pp.tamano_asa_default IS NOT NULL AND pp.tamano_asa_default <> '' THEN 1 ELSE 0 END) +
              -- CORREGIDO: tamano_prod ahora es FK (integer), ya no texto —
              -- comparar contra '' truena ("invalid input syntax for
              -- integer"). Solo se checa que no sea null.
              (CASE WHEN pp.tamano_prod IS NOT NULL THEN 1 ELSE 0 END)
            )
            + suaje_stats.llenos
            + acabados_stats.llenos
            + maq_stats.llenos
            + mat_stats.llenos
            + (CASE WHEN EXISTS (SELECT 1 FROM archivos ar WHERE ar.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END)
          )::numeric
          / (7 + 16 + 12 + 12 + mat_stats.total + 1) * 100
        ) AS completitud_pct

      FROM producto_papel pp
      LEFT JOIN cat_tipo_producto_papel tp ON tp.idcat_tipo_producto_papel = pp.idcat_tipo_producto_papel
      LEFT JOIN cat_tamano_producto ctam ON ctam.idcat_tamano_producto = pp.tamano_prod
      LEFT JOIN usuarios u ON u.idusuario = pp.creado_por

      -- Todos los tipos de papel y calibres de todos los grupos
      LEFT JOIN LATERAL (
        SELECT
          string_agg(DISTINCT ctp.nombre, ' / ' ORDER BY ctp.nombre) AS primer_tipo_papel,
          string_agg(DISTINCT cal.nombre, ' / ' ORDER BY cal.nombre) AS primer_calibre,
          MIN(dm.pliego)                                              AS primer_pliego
        FROM grupo_papel gp
        JOIN detalle_material_papel dm ON dm.idgrupo_papel = gp.idgrupo_papel
        LEFT JOIN cat_tipo_papel ctp ON ctp.idcat_tipo_papel = dm.idcat_tipo_papel
        LEFT JOIN cat_calibre    cal ON cal.idcat_calibre    = dm.idcat_calibre
        WHERE gp.idproducto_papel = pp.idproducto_papel
      ) mat_preview ON true

      -- Grupo 1 (el de menor "orden", o el idgrupo_papel más chico si no hay
      -- orden) — su precio_sugerido es el "costo base" del producto
      LEFT JOIN LATERAL (
        SELECT g1.idgrupo_papel, g1.precio_sugerido
        FROM grupo_papel g1
        WHERE g1.idproducto_papel = pp.idproducto_papel
        ORDER BY g1.orden ASC NULLS LAST, g1.idgrupo_papel ASC
        LIMIT 1
      ) grupo1 ON true

      -- Cuántos grupos (opciones de material) tiene el producto en total —
      -- se usa en la tabla para avisar cuando hay más de uno y así el
      -- usuario sepa que debe abrir el detalle para editar los demás costos.
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS total
        FROM grupo_papel gt
        WHERE gt.idproducto_papel = pp.idproducto_papel
      ) grupos_total ON true

      -- Datos que alimentan la fórmula de costo de laminado (ver
      -- costoLaminado.utils.ts en el frontend) — se traen aquí, en el mismo
      -- listado, para que el modal general de "Editar costos de laminado"
      -- pueda mostrar todos los productos de un jalón sin pedir el detalle
      -- de cada uno por separado.
      LEFT JOIN LATERAL (
        SELECT
          a.idrollo_lam,
          rl.nombre       AS rollo_lam_nombre,
          rl.medida_ancho AS rollo_lam_medida_ancho,
          a.desarrollo_laminado
        FROM acabados_papel a
        LEFT JOIN rollo_lam rl ON rl.idrollo_lam = a.idrollo_lam
        WHERE a.idproducto_papel = pp.idproducto_papel
        LIMIT 1
      ) lam_info ON true

      LEFT JOIN LATERAL (
        SELECT s.pzs AS piezas_suaje
        FROM suaje_papel s
        WHERE s.idproducto_papel = pp.idproducto_papel
        LIMIT 1
      ) suaje_info ON true

      -- Archivos para preview (max 3, priorizando imagen primero).
      -- 'imagen-producto-especial' (Fase 6: foto del producto especial, ver
      -- nota en getProductoPapelById) va primero que todo: es la portada del
      -- producto, y en un especial no hay imagen de suaje que le compita por
      -- el primer lugar.
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id_archivo', a.id_archivo,
            'public_id',  a.public_id,
            'categoria',  a.categoria,
            'nombre',     a.nombre,
            'tipo',       a.tipo
          )
          ORDER BY
            CASE a.categoria
              WHEN 'imagen-producto-especial' THEN 1
              WHEN 'imagen-suaje-papel'        THEN 2
              WHEN 'catalogo-suaje-papel'      THEN 3
              WHEN 'rendimiento-suaje-papel'   THEN 4
              ELSE 5
            END,
            a.id_archivo ASC
        ) AS archivos_raw
        FROM (
          SELECT * FROM archivos
          WHERE idproducto_papel = pp.idproducto_papel
          ORDER BY
            CASE categoria
              WHEN 'imagen-producto-especial' THEN 1
              WHEN 'imagen-suaje-papel'        THEN 2
              WHEN 'catalogo-suaje-papel'      THEN 3
              WHEN 'rendimiento-suaje-papel'   THEN 4
              ELSE 5
            END,
            id_archivo ASC
          LIMIT 3
        ) a
      ) arch_prev ON true

      -- ═══════════════════════════════════════════════════════════════════
      -- LATERALES PARA COMPLETITUD (cada uno siempre regresa 1 fila, aunque
      -- el producto no tenga suaje/acabados/materiales, porque son
      -- funciones de agregación sin GROUP BY)
      -- ═══════════════════════════════════════════════════════════════════
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(
          (CASE WHEN s.numero IS NOT NULL AND s.numero <> '' THEN 1 ELSE 0 END) +
          (CASE WHEN s.pzs IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN s.tamano IS NOT NULL AND s.tamano <> '' THEN 1 ELSE 0 END) +
          (CASE WHEN s.metros IS NOT NULL AND s.metros <> '' THEN 1 ELSE 0 END) +
          (CASE WHEN s.idcat_matrix IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN s.tiempo_arreglo IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN s.corte1_tipo IS NOT NULL AND s.corte1_tipo <> '' THEN 1 ELSE 0 END) +
          (CASE WHEN s.corte1_medida IS NOT NULL AND s.corte1_medida <> '' THEN 1 ELSE 0 END) +
          (CASE WHEN s.idcat_punto_corte IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN s.dobles1_tipo IS NOT NULL AND s.dobles1_tipo <> '' THEN 1 ELSE 0 END) +
          (CASE WHEN s.dobles1_medida IS NOT NULL AND s.dobles1_medida <> '' THEN 1 ELSE 0 END) +
          (CASE WHEN s.idcat_punto_doble IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN s.idcat_sacabocados IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN s.cantidad_sacabocado IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN s.idcat_perforado IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN s.cantidad_perforado IS NOT NULL THEN 1 ELSE 0 END)
        ), 0) AS llenos
        FROM suaje_papel s
        WHERE s.idproducto_papel = pp.idproducto_papel
      ) suaje_stats ON true

      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(
          (CASE WHEN a.idcat_tipo_pegado IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN a.idcat_pegamento IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM acabados_laminado al WHERE al.idacabados_papel = a.idacabados_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN a.idrollo_lam IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN a.desarrollo_laminado IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN a.idcat_refuerzo_material IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN a.idcat_refuerzo_medidas IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN a.idcat_base_material IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN a.base_medida IS NOT NULL AND a.base_medida <> '' THEN 1 ELSE 0 END) +
          (CASE WHEN a.idcat_empaque IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN a.pzs_caja IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM acabados_asas aa WHERE aa.idacabados_papel = a.idacabados_papel) THEN 1 ELSE 0 END)
        ), 0) AS llenos
        FROM acabados_papel a
        WHERE a.idproducto_papel = pp.idproducto_papel
      ) acabados_stats ON true

      LEFT JOIN LATERAL (
        SELECT
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_hojeado_guillotina m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_impresora        m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_hs_ar            m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_suaje_maquina    m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_uv               m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_texturizadora    m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_empalme         m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_armado          m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_asas_maquina    m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_desbarbe        m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_laminado        m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END) +
          (CASE WHEN EXISTS (SELECT 1 FROM maquinaria_empaque         m WHERE m.idproducto_papel = pp.idproducto_papel) THEN 1 ELSE 0 END)
          AS llenos
      ) maq_stats ON true

      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(
            (CASE WHEN dm.idcat_tipo_papel IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN dm.idcat_calibre IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN dm.pliego IS NOT NULL AND dm.pliego <> '' THEN 1 ELSE 0 END) +
            (CASE WHEN dm.rendimiento IS NOT NULL AND dm.rendimiento <> '' THEN 1 ELSE 0 END) +
            (CASE WHEN dm.corte IS NOT NULL AND dm.corte <> '' THEN 1 ELSE 0 END) +
            (CASE WHEN dm.hoj_bobina IS NOT NULL AND dm.hoj_bobina <> '' THEN 1 ELSE 0 END) +
            (CASE WHEN dm.hoj_corte IS NOT NULL AND dm.hoj_corte <> '' THEN 1 ELSE 0 END) +
            (CASE WHEN dm.hoj_rendimiento IS NOT NULL AND dm.hoj_rendimiento <> '' THEN 1 ELSE 0 END) +
            (CASE WHEN dm.hoj_guillotina IS NOT NULL AND dm.hoj_guillotina <> '' THEN 1 ELSE 0 END) +
            (CASE WHEN dm.hoj_hilo IS NOT NULL AND dm.hoj_hilo <> '' THEN 1 ELSE 0 END) +
            (CASE WHEN dm.hoj_bobina_extra IS NOT NULL AND dm.hoj_bobina_extra <> '' THEN 1 ELSE 0 END)
          ), 0)
          + COALESCE(COUNT(DISTINCT CASE WHEN g.precio_sugerido IS NOT NULL THEN g.idgrupo_papel END), 0)
          AS llenos,
          GREATEST(
            COUNT(dm.iddetalle_material) * 11 + COUNT(DISTINCT g.idgrupo_papel),
            1
          ) AS total
        FROM grupo_papel g
        LEFT JOIN detalle_material_papel dm ON dm.idgrupo_papel = g.idgrupo_papel
        WHERE g.idproducto_papel = pp.idproducto_papel
      ) mat_stats ON true

      WHERE pp.activo = true
      ORDER BY pp.idproducto_papel DESC
    `);

    // Generar presigned URLs para los archivos de preview + limpiar medidas
    const rowsConUrls = await Promise.all(
      rows.map(async (row) => {
        const archivosRaw: any[] = row.archivos_raw ?? [];
        const archivos_preview = await Promise.all(
          archivosRaw.map(async (a) => ({
            id_archivo: a.id_archivo,
            nombre:     a.nombre,
            categoria:  a.categoria,
            tipo:       a.tipo,
            url:        await getPresignedUrl(a.public_id),
          }))
        );
        const { archivos_raw, ...rest } = row;
        return limpiarMedidasProducto({ ...rest, archivos_preview });
      })
    );

    console.log(`✅ Productos papel obtenidos: ${rowsConUrls.length}`);
    return res.json(rowsConUrls);

  } catch (error: any) {
    console.error("❌ GET PRODUCTOS PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener productos de papel" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /productos-papel/:id
// ═══════════════════════════════════════════════════════════════════════════
export const getProductoPapelById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Guarda de id numérico. Sin esto, cualquier ruta hermana que se
    // registre DESPUÉS de ":id" (por ejemplo /productos-papel/algo) cae
    // aquí, Postgres truena con "invalid input syntax for type integer" y
    // el catch de abajo lo convierte en un 500 que no dice nada. Pasó justo
    // eso con el catálogo de procesos. Ahora responde 404, que es lo que
    // realmente significa.
    //
    // String(id): en estas tipificaciones de Express req.params viene como
    // string | string[], así que test(id) directo no compila.
    if (!/^\d+$/.test(String(id))) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    const { rows: prodRows } = await pool.query(`
      SELECT
        pp.*,
        tp.nombre              AS tipo_producto,
        ctam.nombre            AS tamano_prod_nombre,
        u.nombre  || ' ' || u.apellido AS creado_por_nombre
      FROM producto_papel pp
      LEFT JOIN cat_tipo_producto_papel tp ON tp.idcat_tipo_producto_papel = pp.idcat_tipo_producto_papel
      LEFT JOIN cat_tamano_producto ctam ON ctam.idcat_tamano_producto = pp.tamano_prod
      LEFT JOIN usuarios u ON u.idusuario = pp.creado_por
      WHERE pp.idproducto_papel = $1 AND pp.activo = true
    `, [id]);

    if (prodRows.length === 0)
      return res.status(404).json({ error: "Producto no encontrado" });

    const producto = limpiarMedidasProducto(prodRows[0]);

    // ── Grupos y materiales ───────────────────────────────────────────────
    const { rows: grupoRows } = await pool.query(`
      SELECT
        g.idgrupo_papel,
        g.precio_sugerido,
        g.orden,
        dm.iddetalle_material,
        dm.pliego,
        dm.rendimiento,
        dm.corte,
        dm.hoj_bobina,
        dm.hoj_corte,
        dm.hoj_rendimiento,
        dm.hoj_guillotina,
        dm.hoj_hilo,
        dm.hoj_bobina_extra,
        dm.orden             AS material_orden,
        dm.idcomponente_papel,
        dm.ancho              AS material_ancho,
        dm.fuelle             AS material_fuelle,
        dm.altura             AS material_altura,
        dm.medida             AS material_medida,
        dm.metodo_preparacion,
        tp.nombre            AS tipo_papel,
        tp.idcat_tipo_papel,
        cal.nombre           AS calibre,
        cal.idcat_calibre
      FROM grupo_papel g
      LEFT JOIN detalle_material_papel dm ON dm.idgrupo_papel = g.idgrupo_papel
      LEFT JOIN cat_tipo_papel tp ON tp.idcat_tipo_papel = dm.idcat_tipo_papel
      LEFT JOIN cat_calibre cal  ON cal.idcat_calibre    = dm.idcat_calibre
      WHERE g.idproducto_papel = $1
      ORDER BY g.orden ASC, dm.orden ASC
    `, [id]);

    const gruposMap: Record<number, any> = {};
    for (const row of grupoRows) {
      if (!gruposMap[row.idgrupo_papel]) {
        gruposMap[row.idgrupo_papel] = {
          idgrupo_papel:   row.idgrupo_papel,
          precio_sugerido: row.precio_sugerido,
          orden:           row.orden,
          materiales:      [],
        };
      }
      if (row.iddetalle_material) {
        const medidasMaterial = limpiarMedidasProducto({
          ancho:  row.material_ancho,
          fuelle: row.material_fuelle,
          altura: row.material_altura,
          medida: row.material_medida,
        });
        gruposMap[row.idgrupo_papel].materiales.push({
          iddetalle_material: row.iddetalle_material,
          // NUEVO (Fase 2): a qué componente está asignado este material.
          // NULL en un producto normal — no cambia nada de lo existente.
          idcomponente_papel: row.idcomponente_papel,
          tipo_papel:         row.tipo_papel,
          idcat_tipo_papel:   row.idcat_tipo_papel,
          calibre:            row.calibre,
          idcat_calibre:      row.idcat_calibre,
          pliego:             row.pliego,
          rendimiento:        row.rendimiento,
          corte:              row.corte,
          hojeado: {
            bobina:      row.hoj_bobina,
            corte:       row.hoj_corte,
            rendimiento: row.hoj_rendimiento,
            guillotina:  row.hoj_guillotina,
            hilo:        row.hoj_hilo,
            bobina_extra: row.hoj_bobina_extra,
          },
          // NUEVO (Fase 2): medida por material y método de preparación.
          ancho:              medidasMaterial.ancho,
          fuelle:             medidasMaterial.fuelle,
          altura:             medidasMaterial.altura,
          medida:             medidasMaterial.medida,
          metodo_preparacion: row.metodo_preparacion,
          orden: row.material_orden,
        });
      }
    }
    producto.grupos = Object.values(gruposMap);

    // ── Suaje / Acabados / Maquinaria (a nivel producto) ────────────────────
    // scope con idcomponente_papel: null = "lo del producto", exactamente lo
    // mismo que se leía antes de Fase 1. En un producto especial (es_especial
    // = true) estas tres vienen vacías a propósito: viven repartidas por
    // componente (ver producto.componentes más abajo), no en el producto.
    const scopeProducto: Scope = { idproducto_papel: Number(id), idcomponente_papel: null };
    producto.suaje      = await getSuaje(scopeProducto);
    producto.acabados   = await getAcabados(scopeProducto);
    producto.maquinaria = await getMaquinaria(scopeProducto);

    // ── Componentes (Fase 2: productos especiales) ──────────────────────────
    // Vacío ([]) en cualquier producto normal — no cambia nada de lo anterior.
    producto.componentes = await getComponentes(Number(id));

    // ── Archivos ──────────────────────────────────────────────────────────
    const { rows: archivosRows } = await pool.query(`
      SELECT id_archivo, nombre, tipo, mime_type, public_id, tamano_kb, categoria
      FROM archivos
      WHERE idproducto_papel = $1
      ORDER BY id_archivo ASC
    `, [id]);

    producto.archivos = await Promise.all(
      archivosRows.map(async (a) => ({
        ...a,
        url: await getPresignedUrl(a.public_id),
      }))
    );

    console.log(`✅ Producto papel obtenido: id=${id}`);
    return res.json(producto);

  } catch (error: any) {
    console.error("❌ GET PRODUCTO PAPEL BY ID ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener el producto" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /productos-papel
// ═══════════════════════════════════════════════════════════════════════════
export const crearProductoPapel = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const {
      idcat_tipo_producto_papel,
      descripcion_papel,
      ancho, fuelle, altura, medida,
      tamano_asa_default,
      tamano_prod,
      costo_laminado,
      grupos = [],
      suaje,
      acabados,
      maquinaria,
      // NUEVO (Fase 2): productos especiales de papel.
      // es_especial = false (default): todo se comporta exactamente igual
      // que hoy — suaje/acabados/maquinaria a nivel producto, sin componentes.
      // es_especial = true: suaje/acabados/maquinaria de arriba se IGNORAN
      // (deben venir NULL/omitidos desde el formulario) y en su lugar cada
      // componente trae los suyos. Ver "El diseño" y "Modelo de datos" en
      // modulo-productos-especiales.html para el porqué de esta forma.
      es_especial = false,
      componentes = [],
    } = req.body;

    const idusuario = (req as any).user?.id ?? null;

    if (!idcat_tipo_producto_papel)
      return res.status(400).json({ error: "El tipo de producto es requerido" });

    // NUEVO: tamano_prod ahora es FK a cat_tamano_producto (id numérico),
    // ya no un desplegable fijo de 5 strings. Aquí solo se valida que sea
    // un entero (o null); que el id exista de verdad lo garantiza la FK
    // real en la BD (fk_producto_papel_tamano_prod) — si no existe, el
    // INSERT de abajo truena con un error de FK, capturado en el catch.
    if (tamano_prod != null && tamano_prod !== "" && !Number.isInteger(Number(tamano_prod))) {
      return res.status(400).json({ error: "tamano_prod inválido" });
    }

    const costoLaminadoValidado = costoLaminadoONull(costo_laminado);
    if (
      costo_laminado !== null &&
      costo_laminado !== undefined &&
      costo_laminado !== "" &&
      costoLaminadoValidado === null
    ) {
      return res.status(400).json({ error: "costo_laminado inválido" });
    }

    // CORREGIDO (Jose, 2026-09-03): "productos" es el catálogo maestro
    // (1=Plástico, 2=Papel, 3=Cartón, 4=Especial -- ver backfill/alta de la
    // fila 4 que Jose corre aparte). Antes TODO producto de papel, incluidos
    // los especiales, se guardaba con idproductos=2 fijo -- así que el
    // catálogo maestro nunca sabía que un producto era especial. Ahora se
    // decide según es_especial.
    const idproductosProducto = es_especial === true ? 4 : 2;

    // ── Validación de duplicados por descripción + medida ──────────────────
    // Solo se valida cuando ambos campos vienen con contenido: si alguno
    // llega vacío no hay forma confiable de determinar si es "el mismo"
    // producto, así que se deja pasar (sigue siendo opcional en contexto
    // de cotización). Se compara solo contra la misma familia (papel normal
    // vs especial) -- un especial y un papel normal con la misma
    // descripción+medida no son necesariamente "el mismo producto".
    const descripcionNorm = typeof descripcion_papel === "string" ? descripcion_papel.trim() : "";
    const medidaNorm = typeof medida === "string" ? medida.trim() : "";
    if (descripcionNorm && medidaNorm) {
      const { rows: dup } = await client.query(
        `SELECT idproducto_papel FROM producto_papel
         WHERE idproductos = $1 AND activo = true
           AND TRIM(LOWER(descripcion_papel)) = TRIM(LOWER($2))
           AND TRIM(LOWER(COALESCE(medida, ''))) = TRIM(LOWER($3))
         LIMIT 1`,
        [idproductosProducto, descripcionNorm, medidaNorm]
      );
      if (dup.length > 0) {
        return res.status(409).json({
          error: "Ya existe un producto registrado con esa descripción y medida",
          idproducto_papel: dup[0].idproducto_papel,
        });
      }
    }

    await iniciarTx(req, client);

    // ── 1. Producto padre ─────────────────────────────────────────────────
    // NOTA: origen_expo NO se manda aquí — este endpoint es el alta manual
    // desde la página de Papel, así que se queda en el DEFAULT false de la
    // columna. Solo resolverFKsProductoExpo (creación automática desde
    // Expo) lo marca en true.
    const { rows: prodRows } = await client.query(`
      INSERT INTO producto_papel (
        idproductos, idcat_tipo_producto_papel,
        descripcion_papel, ancho, fuelle, altura, medida, tamano_asa_default,
        tamano_prod, costo_laminado, es_especial,
        creado_por, actualizado_por
      ) VALUES ($12, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
      RETURNING idproducto_papel
    `, [
      idcat_tipo_producto_papel,
      descripcion_papel ?? null,
      ancho ?? null, fuelle ?? null, altura ?? null, medida ?? null,
      typeof tamano_asa_default === "string" && tamano_asa_default.trim()
        ? tamano_asa_default.trim()
        : null,
      tamano_prod || null,
      costoLaminadoValidado,
      es_especial === true,
      idusuario,
      idproductosProducto,
    ]);

    const idproducto_papel = prodRows[0].idproducto_papel;

    // ── 2. Componentes — solo el "caparazón" (tipo/orden/nombre/es_union) ───
    // Va ANTES de materiales porque detalle_material_papel.idcomponente_papel
    // necesita que el componente ya exista para poder apuntarle. clientKeyToId
    // resuelve, más abajo, a qué componente va cada material entrante (todavía
    // sin id real porque el producto se está creando desde cero).
    const { clientKeyToId: componenteClientKeyToId } = await upsertComponentesShell(
      client, idproducto_papel, componentes, idusuario, new Set<number>()
    );

    // ── 3. Grupos y materiales ────────────────────────────────────────────
    // materialClientKeyToId resuelve, en el paso 4, a qué material apunta
    // cada proceso de cada componente (mat.client_key → iddetalle_material
    // real, recién creado aquí).
    const materialClientKeyToId = new Map<string, number>();

    for (let gi = 0; gi < grupos.length; gi++) {
      const grupo = grupos[gi];

      const { rows: grupoRows } = await client.query(`
        INSERT INTO grupo_papel (idproducto_papel, precio_sugerido, orden, creado_por, actualizado_por)
        VALUES ($1, $2, $3, $4, $4)
        RETURNING idgrupo_papel
      `, [idproducto_papel, grupo.precio_sugerido ?? null, gi + 1, idusuario]);

      const idgrupo_papel = grupoRows[0].idgrupo_papel;

      const materiales = grupo.materiales ?? [];
      for (let mi = 0; mi < materiales.length; mi++) {
        const mat = materiales[mi];
        // A qué componente se asigna este material (columna "Asignación"
        // del diseño). NULL si el producto no es especial o el material no
        // trae asignación — igual que hoy.
        const idcomponente_papel = mat.componente_client_key != null
          ? componenteClientKeyToId.get(String(mat.componente_client_key)) ?? null
          : null;

        const medidasMaterial = limpiarMedidasProducto({
          ancho: mat.ancho, fuelle: mat.fuelle, altura: mat.altura, medida: mat.medida,
        });

        const { rows: detalleRows } = await client.query(`
          INSERT INTO detalle_material_papel (
            idgrupo_papel, idcomponente_papel,
            idcat_tipo_papel, idcat_calibre,
            pliego, rendimiento, corte,
            hoj_bobina, hoj_corte, hoj_rendimiento, hoj_guillotina, hoj_hilo, hoj_bobina_extra,
            ancho, fuelle, altura, medida, metodo_preparacion,
            orden, creado_por, actualizado_por
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20)
          RETURNING iddetalle_material
        `, [
          idgrupo_papel,
          idcomponente_papel,
          mat.idcat_tipo_papel ?? null,
          mat.idcat_calibre    ?? null,
          mat.pliego           ?? null,
          mat.rendimiento      ?? null,
          mat.corte            ?? null,
          mat.hojeado?.bobina       ?? null,
          mat.hojeado?.corte        ?? null,
          mat.hojeado?.rendimiento  ?? null,
          mat.hojeado?.guillotina   ?? null,
          mat.hojeado?.hilo         ?? null,
          mat.hojeado?.bobina_extra ?? null,
          medidasMaterial.ancho,
          medidasMaterial.fuelle,
          medidasMaterial.altura,
          medidasMaterial.medida,
          mat.metodo_preparacion ?? null,
          mi + 1,
          idusuario,
        ]);

        if (mat.client_key != null) {
          materialClientKeyToId.set(String(mat.client_key), detalleRows[0].iddetalle_material);
        }
      }
    }

    // ── 4. Ruta de procesos de cada componente + suaje/acabados/maquinaria ──
    // Producto normal (es_especial = false, componentes = []): este for no
    // itera nada y el flujo de abajo (suaje/acabados/maquinaria "sueltos")
    // corre exactamente como antes de Fase 2.
    for (const comp of componentes) {
      if (comp.client_key == null) continue;
      const idcomponente_papel = componenteClientKeyToId.get(String(comp.client_key));
      if (!idcomponente_papel) continue;

      await upsertComponenteProcesos(client, idcomponente_papel, comp.procesos ?? [], materialClientKeyToId, idusuario);

      const scopeComponente: Scope = { idproducto_papel, idcomponente_papel };
      await upsertSuaje(client, scopeComponente, comp.suaje);
      await upsertAcabados(client, scopeComponente, comp.acabados);
      if (comp.maquinaria) await insertarMaquinaria(client, scopeComponente, comp.maquinaria);
    }

    // ── 5. Suaje / Acabados / Maquinaria — a nivel producto ─────────────────
    // Solo aplica al producto normal. En un producto especial, el formulario
    // no debe mandar estos tres a nivel raíz (ya viajaron por componente
    // arriba) — si los manda de todos modos, aquí no se ignoran a propósito:
    // se guardarían como "lo del producto", conviviendo con lo de sus
    // componentes, que es justo lo que NO se quiere. Fase 4 (UI) es quien
    // debe garantizar que nunca se manden ambos a la vez.
    const scopeProducto: Scope = { idproducto_papel, idcomponente_papel: null };
    await upsertSuaje(client, scopeProducto, suaje);
    await upsertAcabados(client, scopeProducto, acabados);
    if (maquinaria) await insertarMaquinaria(client, scopeProducto, maquinaria);

    await client.query("COMMIT");
    console.log(`✅ Producto papel creado: id=${idproducto_papel}`);
    return res.status(201).json({ message: "Producto registrado correctamente", idproducto_papel });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ POST PRODUCTO PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al registrar el producto", detalle: error.message });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// PUT /productos-papel/:id
// ═══════════════════════════════════════════════════════════════════════════
export const actualizarProductoPapel = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const {
      idcat_tipo_producto_papel,
      descripcion_papel,
      ancho, fuelle, altura, medida,
      tamano_asa_default,
      tamano_prod,
      costo_laminado,
      grupos = [],
      suaje,
      acabados,
      maquinaria,
      // NUEVO (Fase 2): ver el comentario equivalente en crearProductoPapel.
      es_especial = false,
      componentes = [],
    } = req.body;

    const idusuario = (req as any).user?.id ?? null;

    // NUEVO: misma lógica que en crearProductoPapel — tamano_prod ya es FK.
    if (tamano_prod != null && tamano_prod !== "" && !Number.isInteger(Number(tamano_prod))) {
      return res.status(400).json({ error: "tamano_prod inválido" });
    }

    const costoLaminadoValidado = costoLaminadoONull(costo_laminado);
    if (
      costo_laminado !== null &&
      costo_laminado !== undefined &&
      costo_laminado !== "" &&
      costoLaminadoValidado === null
    ) {
      return res.status(400).json({ error: "costo_laminado inválido" });
    }

    const { rows: check } = await client.query(
      `SELECT idproducto_papel FROM producto_papel WHERE idproducto_papel = $1 AND activo = true`, [id]
    );
    if (check.length === 0)
      return res.status(404).json({ error: "Producto no encontrado" });

    // Igual que en crearProductoPapel: el catálogo maestro "productos"
    // distingue especial (4) de papel normal (2) (Jose, 2026-09-03).
    const idproductosProducto = es_especial === true ? 4 : 2;

    // ── Validación de duplicados por descripción + medida ──────────────────
    // Misma regla que en creación, pero excluyendo al propio producto que
    // se está editando (si no, siempre "chocaría" consigo mismo). Se
    // compara solo contra la misma familia (papel normal vs especial).
    const descripcionNorm = typeof descripcion_papel === "string" ? descripcion_papel.trim() : "";
    const medidaNorm = typeof medida === "string" ? medida.trim() : "";
    if (descripcionNorm && medidaNorm) {
      const { rows: dup } = await client.query(
        `SELECT idproducto_papel FROM producto_papel
         WHERE idproductos = $1 AND activo = true
           AND idproducto_papel <> $2
           AND TRIM(LOWER(descripcion_papel)) = TRIM(LOWER($3))
           AND TRIM(LOWER(COALESCE(medida, ''))) = TRIM(LOWER($4))
         LIMIT 1`,
        [idproductosProducto, id, descripcionNorm, medidaNorm]
      );
      if (dup.length > 0) {
        return res.status(409).json({
          error: "Ya existe otro producto registrado con esa descripción y medida",
          idproducto_papel: dup[0].idproducto_papel,
        });
      }
    }

    await iniciarTx(req, client);

    // ── 1. Producto padre ─────────────────────────────────────────────────
    // origen_expo tampoco se toca aquí — una vez marcado (por la creación
    // automática desde Expo) se queda así aunque después se edite a mano
    // desde esta página; solo cambia sus datos, no su origen.
    await client.query(`
      UPDATE producto_papel SET
        idcat_tipo_producto_papel = $1,
        descripcion_papel = $2,
        ancho = $3, fuelle = $4, altura = $5, medida = $6,
        tamano_asa_default = $7,
        tamano_prod = $8,
        costo_laminado = $9,
        es_especial = $10,
        idproductos = $13,
        actualizado_por = $11,
        updated_at = NOW()
      WHERE idproducto_papel = $12
    `, [
      idcat_tipo_producto_papel,
      descripcion_papel ?? null,
      ancho ?? null, fuelle ?? null, altura ?? null, medida ?? null,
      typeof tamano_asa_default === "string" && tamano_asa_default.trim()
        ? tamano_asa_default.trim()
        : null,
      tamano_prod || null,
      costoLaminadoValidado,
      es_especial === true,
      idusuario, id,
      idproductosProducto,
    ]);

    // ── 2. Componentes — mismo patrón de preservar id que grupos/materiales ─
    // Va antes de materiales por la misma razón que en crearProductoPapel:
    // detalle_material_papel.idcomponente_papel necesita que el componente
    // ya exista (o siga existiendo con el mismo id) antes de asignarle nada.
    const { rows: componentesExistentesRows } = await client.query(
      `SELECT idcomponente_papel FROM componente_papel WHERE idproducto_papel = $1`, [id]
    );
    const idsComponenteExistentes = new Set<number>(componentesExistentesRows.map((r: any) => r.idcomponente_papel));

    // CORREGIDO (llave duplicada "componente_papel_union_uq"): antes se
    // borraban los componentes que el cliente ya no traía DESPUÉS de hacer
    // los upserts (ver el borrado que había al final, sobre
    // idsComponenteConservados). Si el usuario cambiaba de modo de
    // asignación ("Misma orden" ↔ "Órdenes independientes") en un producto
    // YA guardado, el formulario manda una OP de unión/única nueva sin
    // idcomponente_papel (MaterialesAsignacion.tsx las reconstruye desde
    // cero a propósito, ver elegirMisma/elegirIndependientes) mientras la
    // vieja todavía existe en la base -- el INSERT de la nueva chocaba con
    // esa vieja antes de que le tocara su turno de borrarse, y la
    // restricción de unicidad (una sola fila es_union/tipo='unica' por
    // producto) tronaba en el acto.
    //
    // El fix es de orden, no de la restricción: se borra ANTES de insertar,
    // usando como "lo que se conserva" únicamente los ids que el cliente
    // mandó y que YA existían (los sin idcomponente_papel son nuevos por
    // definición y no hay nada que protegerles borrando antes de tiempo).
    const idsComponenteRetenidosPorCliente = new Set<number>(
      componentes
        .map((c: any) => Number(c.idcomponente_papel) || null)
        .filter((v: number | null): v is number => v != null && idsComponenteExistentes.has(v))
    );
    await eliminarComponentesNoConservados(client, Number(id), idsComponenteRetenidosPorCliente);

    const { clientKeyToId: componenteClientKeyToId } =
      await upsertComponentesShell(client, Number(id), componentes, idusuario, idsComponenteExistentes);

    // ── 3. Grupos y materiales — actualizar en vez de recrear ──────────────
    // Antes esto borraba TODOS los grupo_papel/detalle_material_papel del
    // producto y los volvía a insertar con ids nuevos. El problema: un
    // pedido ya creado guarda una referencia fija a esos ids
    // (solicitud_producto.grupo_papel_idgrupo_papel), y la consulta que
    // arma la orden de producción/PDF (getOrdenProduccion) hace JOIN por
    // ese id. Si el id ya no existe, ese JOIN no encuentra nada y el PDF
    // sale con pliego/rendimiento/corte/hojeado/material/calibre en blanco
    // — aunque el pedido nunca haya cambiado, solo por haber editado el
    // producto después. Ahora se actualiza cada grupo/material por su id
    // (si el formulario lo trae, porque ya existía) y solo se crean/borran
    // los que de verdad se agregaron/quitaron en esta edición.
    const { rows: existentesRows } = await client.query(`
      SELECT g.idgrupo_papel, dm.iddetalle_material
      FROM grupo_papel g
      LEFT JOIN detalle_material_papel dm ON dm.idgrupo_papel = g.idgrupo_papel
      WHERE g.idproducto_papel = $1
    `, [id]);
    const idsGrupoExistentes = new Set<number>(existentesRows.map((r: any) => r.idgrupo_papel));
    const idsDetalleExistentes = new Set<number>(
      existentesRows
        .filter((r: any) => r.iddetalle_material != null)
        .map((r: any) => r.iddetalle_material)
    );

    const idsGrupoConservados = new Set<number>();
    const idsDetalleConservados = new Set<number>();
    // materialClientKeyToId resuelve, en el paso 4, a qué material apunta
    // cada proceso de cada componente. Los materiales que ya existían (traen
    // iddetalle_material) también se registran aquí bajo su propio id como
    // client_key, para que un proceso pueda referenciarlos con cualquiera de
    // los dos (ver upsertComponenteProcesos: acepta número plano o client_key).
    const materialClientKeyToId = new Map<string, number>();

    for (let gi = 0; gi < grupos.length; gi++) {
      const grupo = grupos[gi];
      const idGrupoEntrante = Number(grupo.idgrupo_papel) || null;

      let idgrupo_papel: number;
      if (idGrupoEntrante && idsGrupoExistentes.has(idGrupoEntrante)) {
        await client.query(`
          UPDATE grupo_papel SET
            precio_sugerido = $1, orden = $2, actualizado_por = $3
          WHERE idgrupo_papel = $4 AND idproducto_papel = $5
        `, [grupo.precio_sugerido ?? null, gi + 1, idusuario, idGrupoEntrante, id]);
        idgrupo_papel = idGrupoEntrante;
      } else {
        const { rows: grupoRows } = await client.query(`
          INSERT INTO grupo_papel (idproducto_papel, precio_sugerido, orden, creado_por, actualizado_por)
          VALUES ($1, $2, $3, $4, $4)
          RETURNING idgrupo_papel
        `, [id, grupo.precio_sugerido ?? null, gi + 1, idusuario]);
        idgrupo_papel = grupoRows[0].idgrupo_papel;
      }
      idsGrupoConservados.add(idgrupo_papel);

      const materiales = grupo.materiales ?? [];
      for (let mi = 0; mi < materiales.length; mi++) {
        const mat = materiales[mi];
        const idDetalleEntrante = Number(mat.iddetalle_material) || null;

        // A qué componente se asigna este material ("Asignación" del
        // diseño). Se resuelve por client_key — cubre tanto un componente
        // nuevo en esta misma edición como uno que ya existía (ver el
        // comentario en upsertComponentesShell: el mapa se llena para
        // ambos casos). NULL si el producto no es especial.
        const idcomponente_papel = mat.componente_client_key != null
          ? componenteClientKeyToId.get(String(mat.componente_client_key)) ?? null
          : null;

        const medidasMaterial = limpiarMedidasProducto({
          ancho: mat.ancho, fuelle: mat.fuelle, altura: mat.altura, medida: mat.medida,
        });

        let iddetalle_material: number;

        if (idDetalleEntrante && idsDetalleExistentes.has(idDetalleEntrante)) {
          await client.query(`
            UPDATE detalle_material_papel SET
              idgrupo_papel = $1, idcomponente_papel = $2,
              idcat_tipo_papel = $3, idcat_calibre = $4,
              pliego = $5, rendimiento = $6, corte = $7,
              hoj_bobina = $8, hoj_corte = $9, hoj_rendimiento = $10,
              hoj_guillotina = $11, hoj_hilo = $12, hoj_bobina_extra = $13,
              ancho = $14, fuelle = $15, altura = $16, medida = $17, metodo_preparacion = $18,
              orden = $19, actualizado_por = $20
            WHERE iddetalle_material = $21
          `, [
            idgrupo_papel,
            idcomponente_papel,
            mat.idcat_tipo_papel ?? null,
            mat.idcat_calibre    ?? null,
            mat.pliego           ?? null,
            mat.rendimiento      ?? null,
            mat.corte            ?? null,
            mat.hojeado?.bobina       ?? null,
            mat.hojeado?.corte        ?? null,
            mat.hojeado?.rendimiento  ?? null,
            mat.hojeado?.guillotina   ?? null,
            mat.hojeado?.hilo         ?? null,
            mat.hojeado?.bobina_extra ?? null,
            medidasMaterial.ancho,
            medidasMaterial.fuelle,
            medidasMaterial.altura,
            medidasMaterial.medida,
            mat.metodo_preparacion ?? null,
            mi + 1,
            idusuario,
            idDetalleEntrante,
          ]);
          idsDetalleConservados.add(idDetalleEntrante);
          iddetalle_material = idDetalleEntrante;
        } else {
          const { rows: detalleRows } = await client.query(`
            INSERT INTO detalle_material_papel (
              idgrupo_papel, idcomponente_papel,
              idcat_tipo_papel, idcat_calibre,
              pliego, rendimiento, corte,
              hoj_bobina, hoj_corte, hoj_rendimiento, hoj_guillotina, hoj_hilo, hoj_bobina_extra,
              ancho, fuelle, altura, medida, metodo_preparacion,
              orden, creado_por, actualizado_por
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20)
            RETURNING iddetalle_material
          `, [
            idgrupo_papel,
            idcomponente_papel,
            mat.idcat_tipo_papel ?? null,
            mat.idcat_calibre    ?? null,
            mat.pliego           ?? null,
            mat.rendimiento      ?? null,
            mat.corte            ?? null,
            mat.hojeado?.bobina       ?? null,
            mat.hojeado?.corte        ?? null,
            mat.hojeado?.rendimiento  ?? null,
            mat.hojeado?.guillotina   ?? null,
            mat.hojeado?.hilo         ?? null,
            mat.hojeado?.bobina_extra ?? null,
            medidasMaterial.ancho,
            medidasMaterial.fuelle,
            medidasMaterial.altura,
            medidasMaterial.medida,
            mat.metodo_preparacion ?? null,
            mi + 1,
            idusuario,
          ]);
          idsDetalleConservados.add(detalleRows[0].iddetalle_material);
          iddetalle_material = detalleRows[0].iddetalle_material;
        }

        if (mat.client_key != null) materialClientKeyToId.set(String(mat.client_key), iddetalle_material);
        materialClientKeyToId.set(String(iddetalle_material), iddetalle_material);
      }
    }

    // Solo se borran los grupos/materiales que de verdad se quitaron en
    // esta edición (los que no llegaron con su id). Los materiales primero,
    // por si la FK de detalle_material_papel no tiene ON DELETE CASCADE.
    const idsGrupoAEliminar = [...idsGrupoExistentes].filter(gid => !idsGrupoConservados.has(gid));
    if (idsGrupoAEliminar.length > 0) {
      await client.query(
        `DELETE FROM detalle_material_papel WHERE idgrupo_papel = ANY($1::int[])`,
        [idsGrupoAEliminar]
      );
      await client.query(
        `DELETE FROM grupo_papel WHERE idgrupo_papel = ANY($1::int[])`,
        [idsGrupoAEliminar]
      );
    }

    const idsDetalleAEliminar = [...idsDetalleExistentes].filter(did => !idsDetalleConservados.has(did));
    if (idsDetalleAEliminar.length > 0) {
      await client.query(
        `DELETE FROM detalle_material_papel WHERE iddetalle_material = ANY($1::int[])`,
        [idsDetalleAEliminar]
      );
    }

    // ── 4. Ruta de procesos de cada componente + su suaje/acabados/maquinaria
    // Producto normal (es_especial = false, componentes = []): este for no
    // itera nada, igual que en crearProductoPapel.
    for (const comp of componentes) {
      if (comp.client_key == null) continue;
      const idcomponente_papel = componenteClientKeyToId.get(String(comp.client_key));
      if (!idcomponente_papel) continue;

      await upsertComponenteProcesos(client, idcomponente_papel, comp.procesos ?? [], materialClientKeyToId, idusuario);

      const scopeComponente: Scope = { idproducto_papel: Number(id), idcomponente_papel };
      await upsertSuaje(client, scopeComponente, comp.suaje);
      await upsertAcabados(client, scopeComponente, comp.acabados);
      if (comp.maquinaria) {
        await eliminarMaquinaria(client, scopeComponente);
        await insertarMaquinaria(client, scopeComponente, comp.maquinaria);
      }
    }

    // El borrado de componentes que ya no vinieron en esta edición se movió
    // ANTES del upsert (ver el comentario junto a
    // idsComponenteRetenidosPorCliente, más arriba) -- ya no va aquí.

    // ── 5. Suaje / Acabados / Maquinaria — a nivel producto ─────────────────
    // Mismo comentario que en crearProductoPapel: solo aplica al producto
    // normal; en uno especial esto no debería recibir datos desde Fase 4 (UI).
    const scopeProducto: Scope = { idproducto_papel: Number(id), idcomponente_papel: null };
    await upsertSuaje(client, scopeProducto, suaje);
    await upsertAcabados(client, scopeProducto, acabados);
    if (maquinaria) {
      await eliminarMaquinaria(client, scopeProducto);
      await insertarMaquinaria(client, scopeProducto, maquinaria);
    }

    // ── 6. Reflejar el cambio en Catálogo Expo si algún registro apunta a
    // este mismo producto (idproducto_papel) ────────────────────────────────
    // Esta dirección (Sistema → Expo) es distinta a la de Expo → Sistema:
    // aquí no hace falta el checkeo de "uso externo" porque el Sistema es la
    // fuente de verdad — Expo solo es un catálogo secundario que debe
    // reflejar la realidad, así que siempre se actualiza si hay un vínculo.
    const { rows: primerMaterial } = await client.query(`
      SELECT ctp.nombre AS material, cc.nombre AS calibre
      FROM detalle_material_papel dmp
      JOIN grupo_papel gp ON gp.idgrupo_papel = dmp.idgrupo_papel
      LEFT JOIN cat_tipo_papel ctp ON ctp.idcat_tipo_papel = dmp.idcat_tipo_papel
      LEFT JOIN cat_calibre cc ON cc.idcat_calibre = dmp.idcat_calibre
      WHERE gp.idproducto_papel = $1
      ORDER BY gp.orden ASC, dmp.orden ASC LIMIT 1`, [id]);
    const materialSync = primerMaterial[0]?.material ?? null;
    const calibreSync = primerMaterial[0]?.calibre ?? null;

    await client.query(
      `UPDATE catalogo_expo SET
         medida = COALESCE($1, medida),
         material = COALESCE($2, material),
         calibre = COALESCE($3, calibre)
       WHERE idproducto_papel = $4 AND activo = true`,
      [medida || null, materialSync, calibreSync, id]
    );

    await client.query("COMMIT");
    console.log(`✅ Producto papel actualizado: id=${id}`);
    return res.json({ message: "Producto actualizado correctamente" });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ PUT PRODUCTO PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al actualizar el producto", detalle: error.message });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /productos-papel/:id/costo-base
// ═══════════════════════════════════════════════════════════════════════════
// Actualización rápida del costo base (precio_sugerido) de uno o varios
// grupos de un producto, SIN pasar por el formulario completo de edición.
// Se usa desde el botón "Costo base" en la tabla de Papel.tsx: permite
// registrar el costo por primera vez (si quedó vacío al dar de alta) o
// corregirlo después, sin tocar materiales, suaje, acabados ni maquinaria.
// Un producto puede tener 1 o N grupos (opciones de material), cada uno con
// su propio costo — por eso el body acepta un arreglo de grupos.
export const actualizarCostoBaseGrupos = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { grupos } = req.body as {
      grupos: { idgrupo_papel: number; precio_sugerido: number | string | null }[];
    };

    if (!Array.isArray(grupos) || grupos.length === 0) {
      return res.status(400).json({ error: "Se requiere al menos un grupo" });
    }

    const idusuario = (req as any).user?.id ?? null;

    await iniciarTx(req, client);

    // Confirma que el producto exista y esté activo antes de tocar sus grupos.
    const { rows: prodRows } = await client.query(
      `SELECT idproducto_papel FROM producto_papel WHERE idproducto_papel = $1 AND activo = true`,
      [id]
    );
    if (prodRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    const actualizados: { idgrupo_papel: number; precio_sugerido: number | null }[] = [];

    for (const g of grupos) {
      if (!g.idgrupo_papel) continue;

      const precio =
        g.precio_sugerido === null || g.precio_sugerido === undefined || g.precio_sugerido === ""
          ? null
          : Number(g.precio_sugerido);

      if (precio !== null && (!Number.isFinite(precio) || precio < 0)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Costo inválido para el grupo ${g.idgrupo_papel}` });
      }

      // El WHERE idproducto_papel = $4 evita que, por error, se actualice un
      // grupo que en realidad pertenece a otro producto.
      const { rows } = await client.query(
        `UPDATE grupo_papel
         SET precio_sugerido = $1, actualizado_por = $2
         WHERE idgrupo_papel = $3 AND idproducto_papel = $4
         RETURNING idgrupo_papel, precio_sugerido`,
        [precio, idusuario, g.idgrupo_papel, id]
      );

      if (rows.length > 0) actualizados.push(rows[0]);
    }

    await client.query("COMMIT");
    console.log(`✅ Costo base actualizado: producto=${id}, grupos=${actualizados.length}`);
    return res.json({ message: "Costo base actualizado correctamente", grupos: actualizados });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ PATCH COSTO BASE PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al actualizar el costo base", detalle: error.message });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /productos-papel/:id/costo-laminado
// ═══════════════════════════════════════════════════════════════════════════
// Actualización rápida del costo de laminado, SIN pasar por el formulario
// completo. A diferencia del costo base (un solo número), aquí se tocan 3
// campos que alimentan la fórmula (ver costoLaminado.utils.ts en el
// frontend): idrollo_lam y desarrollo_laminado (en acabados_papel) y pzs
// (en suaje_papel) — más el resultado ya calculado, que se guarda en
// producto_papel.costo_laminado igual que hace actualizarProductoPapel
// (el backend no recalcula, solo valida).
//
// IMPORTANTE: acabados_papel y suaje_papel tienen muchas otras columnas
// (pegamento, refuerzo, empaque, corte, dobles, etc.) que este endpoint NO
// debe tocar — por eso los UPDATE de abajo solo mencionan las columnas que
// nos interesan, a diferencia del upsert completo de actualizarProductoPapel.
export const actualizarCostoLaminado = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { idrollo_lam, desarrollo_laminado, piezas_suaje, costo_laminado } = req.body as {
      idrollo_lam?: number | string | null;
      desarrollo_laminado?: number | string | null;
      piezas_suaje?: number | string | null;
      costo_laminado?: number | string | null;
    };

    const idusuario = (req as any).user?.id ?? null;

    const costoLaminadoValidado = costoLaminadoONull(costo_laminado);
    if (
      costo_laminado !== null && costo_laminado !== undefined && costo_laminado !== "" &&
      costoLaminadoValidado === null
    ) {
      return res.status(400).json({ error: "costo_laminado inválido" });
    }

    const desarrolloValidado =
      desarrollo_laminado === null || desarrollo_laminado === undefined || desarrollo_laminado === ""
        ? null
        : Number(desarrollo_laminado);
    if (desarrolloValidado !== null && (!Number.isFinite(desarrolloValidado) || desarrolloValidado < 0)) {
      return res.status(400).json({ error: "desarrollo_laminado inválido" });
    }

    await iniciarTx(req, client);

    const { rows: prodRows } = await client.query(
      `SELECT idproducto_papel FROM producto_papel WHERE idproducto_papel = $1 AND activo = true`,
      [id]
    );
    if (prodRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    // ── 1. producto_papel.costo_laminado ──────────────────────────────────
    await client.query(
      `UPDATE producto_papel SET costo_laminado = $1, actualizado_por = $2 WHERE idproducto_papel = $3`,
      [costoLaminadoValidado, idusuario, id]
    );

    // ── 2. acabados_papel: idrollo_lam / desarrollo_laminado (parcial) ────
    const { rows: acabadosCheck } = await client.query(
      `SELECT idacabados_papel FROM acabados_papel WHERE idproducto_papel = $1`, [id]
    );
    if (acabadosCheck.length > 0) {
      await client.query(
        `UPDATE acabados_papel SET idrollo_lam = $1, desarrollo_laminado = $2 WHERE idacabados_papel = $3`,
        [idrollo_lam ?? null, desarrolloValidado, acabadosCheck[0].idacabados_papel]
      );
    } else {
      await client.query(
        `INSERT INTO acabados_papel (idproducto_papel, idrollo_lam, desarrollo_laminado) VALUES ($1, $2, $3)`,
        [id, idrollo_lam ?? null, desarrolloValidado]
      );
    }

    // ── 3. suaje_papel.pzs (parcial) ──────────────────────────────────────
    const { rows: suajeCheck } = await client.query(
      `SELECT idsuaje_papel FROM suaje_papel WHERE idproducto_papel = $1`, [id]
    );
    if (suajeCheck.length > 0) {
      await client.query(
        `UPDATE suaje_papel SET pzs = $1 WHERE idsuaje_papel = $2`,
        [piezas_suaje ?? null, suajeCheck[0].idsuaje_papel]
      );
    } else {
      // herramental_desbarbe se manda explícito en false porque, igual que
      // en crearProductoPapel, la columna no admite NULL.
      await client.query(
        `INSERT INTO suaje_papel (idproducto_papel, pzs, herramental_desbarbe) VALUES ($1, $2, false)`,
        [id, piezas_suaje ?? null]
      );
    }

    await client.query("COMMIT");
    console.log(`✅ Costo laminado actualizado: producto=${id}`);
    return res.json({
      message: "Costo de laminado actualizado correctamente",
      costo_laminado: costoLaminadoValidado,
      idrollo_lam: idrollo_lam ?? null,
      desarrollo_laminado: desarrolloValidado,
      piezas_suaje: piezas_suaje ?? null,
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ PATCH COSTO LAMINADO PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al actualizar el costo de laminado", detalle: error.message });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /productos-papel/en-blanco-expo
// ═══════════════════════════════════════════════════════════════════════════
// Registro relajado — a diferencia de crearProductoPapel (el alta normal de
// la página de Papel), aquí NO se exige idcat_tipo_producto_papel ni ningún
// otro campo. Se usa cuando alguien cotiza en Expo un producto que no existe
// todavía: se guarda lo que sí se tiene (nombre, medida si acaso) y el resto
// queda en null, marcado con origen_expo=true — la idea es completarlo
// después, cuando esa cotización se convierta en pedido real.
export const registrarProductoPapelEnBlancoExpo = async (req: Request, res: Response) => {
  try {
    const { nombre, categoria, medida, material, calibre, tipo_producto, altura, ancho, fuelle,
      precio_500, precio_1000, precio_3000 } = req.body;

    if (!nombre?.trim())
      return res.status(400).json({ error: "El nombre es requerido" });

    const idproductos = categoria === "carton" ? 3 : 2;
    const idusuario = (req as any).user?.id ?? null;
    const num = (v: any) => (v != null && v !== "") ? Number(v) : null;

    let idcatTipoProductoPapel: number | null = null;
    if (tipo_producto) {
      const { rows: tpRows } = await pool.query(
        `SELECT idcat_tipo_producto_papel FROM cat_tipo_producto_papel WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
        [`%${String(tipo_producto).toLowerCase()}%`]
      );
      idcatTipoProductoPapel = tpRows[0]?.idcat_tipo_producto_papel ?? null;
    }

    const { rows: ppRows } = await qAudit(req)(`
      INSERT INTO producto_papel (
        idproductos, idcat_tipo_producto_papel, descripcion_papel,
        ancho, fuelle, altura, medida, precio_500, precio_1000, precio_3000,
        activo, origen_expo, creado_por, actualizado_por
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,true,$11,$11)
      RETURNING idproducto_papel`,
      [idproductos, idcatTipoProductoPapel, nombre.trim(),
       ancho || null, fuelle || null, altura || null, medida || null,
       num(precio_500), num(precio_1000), num(precio_3000), idusuario]
    );
    const idproducto_papel = ppRows[0].idproducto_papel;

    // Si ya viene material/calibre (aunque sea parcial), se guarda de una
    // vez en el primer grupo — si no, se completa después al editar.
    if (material || calibre) {
      let idcatTipoPapel: number | null = null;
      if (material) {
        const { rows } = await pool.query(
          `SELECT idcat_tipo_papel FROM cat_tipo_papel WHERE LOWER(nombre) = LOWER($1) LIMIT 1`, [material]
        );
        idcatTipoPapel = rows[0]?.idcat_tipo_papel ?? null;
      }
      let idcatCalibre: number | null = null;
      if (calibre) {
        const { rows } = await pool.query(
          `SELECT idcat_calibre FROM cat_calibre WHERE LOWER(nombre) = LOWER($1) LIMIT 1`, [calibre]
        );
        idcatCalibre = rows[0]?.idcat_calibre ?? null;
      }
      if (idcatTipoPapel || idcatCalibre) {
        const { rows: gpRows } = await qAudit(req)(
          `INSERT INTO grupo_papel (idproducto_papel, precio_sugerido, orden) VALUES ($1,NULL,1) RETURNING idgrupo_papel`,
          [idproducto_papel]
        );
        await qAudit(req)(
          `INSERT INTO detalle_material_papel (idgrupo_papel, idcat_tipo_papel, idcat_calibre, orden) VALUES ($1,$2,$3,1)`,
          [gpRows[0].idgrupo_papel, idcatTipoPapel, idcatCalibre]
        );
      }
    }

    console.log(`✅ Producto papel EN BLANCO (Expo) creado: id=${idproducto_papel}`);
    return res.status(201).json({ idproducto_papel });
  } catch (error: any) {
    console.error("❌ REGISTRAR PRODUCTO PAPEL EN BLANCO (Expo) ERROR:", error.message);
    return res.status(500).json({ error: "Error al registrar el producto" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /productos-papel/:id
// ═══════════════════════════════════════════════════════════════════════════
export const eliminarProductoPapel = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await iniciarTx(req, client);

    const { rows } = await client.query(
      `UPDATE producto_papel SET activo = false, updated_at = NOW()
       WHERE idproducto_papel = $1 AND activo = true
       RETURNING idproducto_papel`,
      [id]
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    // Si el producto ya no existe en el sistema, cualquier registro de
    // Catálogo Expo que lo usaba queda obsoleto — se desactiva también,
    // sin checkeo de "uso externo" (esa protección aplica al sentido
    // contrario, Expo → Sistema, no aquí).
    await client.query(
      `UPDATE catalogo_expo SET activo = false WHERE idproducto_papel = $1 AND activo = true`,
      [id]
    );

    await client.query("COMMIT");
    console.log(`✅ Producto papel eliminado: id=${id}`);
    return res.json({ message: "Producto eliminado correctamente" });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ DELETE PRODUCTO PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al eliminar el producto" });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET catálogo de proceso_cat (Fase 5: productos especiales — ruta de procesos)
// ═══════════════════════════════════════════════════════════════════════════
// Nadie exponía proceso_cat a un cliente hasta ahora: procesosPapel.controller.ts
// lo resuelve internamente por nombre_proceso (con su propio caché en
// memoria) para decidir la cascada de una orden real, pero nunca lo lista
// para que un formulario lo use. El nuevo panel "Ruta de procesos" del alta
// de productos especiales necesita justo eso: con qué procesos puede armar
// la ruta de cada componente.
//
// activo = true deja fuera "Almacén / Despacho" (Fase 1 la sembró inactiva
// a propósito — "queda preparado aunque el motor no lo use todavía", ver
// modulo-productos-especiales.html) y cualquier otro proceso que se
// desactive más adelante sin borrarlo.
//
// RUTA — en producto_papel.routes.ts, que ya está montado en
// /api/productos-papel:
//
//   router.get("/procesos/catalogo", authMiddleware, getProcesosCat);
//
// Son DOS segmentos a propósito. La primera versión usaba uno solo
// ("/procesos-cat-papel") y eso obligaba a registrarla ANTES que
// router.get("/:id", ...), porque ":id" combina con cualquier segmento: al
// quedar después, la petición caía en getProductoPapelById con
// id="procesos-cat-papel", Postgres tronaba con "invalid input syntax for
// type integer" y salía un 500 sin explicación. Con dos segmentos ya no
// puede pasar, así que la ruta puede ir en cualquier parte del archivo —
// como está hoy, debajo de "/:id".
export const getProcesosCat = async (_req: Request, res: Response) => {
  try {
    // familia = 'papel': proceso_cat guarda TODAS las familias en la misma
    // tabla, así que sin este filtro la ruta de un producto de papel ofrecía
    // también extrusión, impresión, bolseo y asa flexible, que son de
    // plástico y no pintan nada aquí (lo reportó Jose).
    //
    // tabla <> 'pegado_papel' (Jose, 2026-09-03): Pegado resultó ser el
    // mismo proceso que Empaque en la práctica, así que se saca del
    // catálogo para que ya no se pueda AGREGAR a una ruta nueva. No se
    // borra ni se desactiva la fila en proceso_cat -- eso rompería órdenes
    // viejas que ya lo tienen capturado -- solo se excluye de esta lista,
    // que es la que alimenta "+ Agregar proceso".
    const { rows } = await pool.query(`
      SELECT idproceso_cat, nombre_proceso, familia, tabla
      FROM proceso_cat
      WHERE activo = true
        AND LOWER(COALESCE(familia, '')) = 'papel'
        AND tabla <> 'pegado_papel'
      ORDER BY idproceso_cat ASC
    `);
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET PROCESOS CAT ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener el catálogo de procesos" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// NOTAS DEL PRODUCTO (Fase 6: productos especiales)
// ═══════════════════════════════════════════════════════════════════════════
// El panel "Notas" de la Ruta de procesos mostraba solo texto armado a
// partir de los materiales (nombre, calibre, componente) — no eran notas de
// verdad, no se podían editar ni agregar (Jose). Esto es una lista real: el
// usuario las escribe y las guarda, tabla nueva `producto_papel_nota`
// (idproducto_papel, texto), con soft delete igual que el resto del
// esquema. Requiere la migración que se le pasó a Jose por chat antes de
// activar estas rutas.
//
// RUTAS — en producto_papel.routes.ts, mismo patrón de 2 segmentos que
// getProcesosCat para que ":id" nunca se las coma:
//
//   router.get("/:id/notas",      authMiddleware, getNotasProducto);
//   router.post("/:id/notas",     authMiddleware, checkPermiso(PERMISO), crearNotaProducto);
//   router.put("/notas/:idnota",  authMiddleware, checkPermiso(PERMISO), actualizarNotaProducto);
//   router.delete("/notas/:idnota", authMiddleware, checkPermiso(PERMISO), eliminarNotaProducto);

export const getNotasProducto = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!/^\d+$/.test(String(id))) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }
    const { rows } = await pool.query(
      `SELECT idnota_producto_papel, texto, created_at, updated_at
       FROM producto_papel_nota
       WHERE idproducto_papel = $1 AND eliminado_at IS NULL
       ORDER BY created_at ASC`,
      [id]
    );
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET NOTAS PRODUCTO ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener las notas del producto" });
  }
};

export const crearNotaProducto = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!/^\d+$/.test(String(id))) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }
    const texto = String(req.body?.texto ?? "").trim();
    if (!texto) {
      return res.status(400).json({ error: "La nota no puede estar vacía" });
    }
    const result = await qAudit(req)(
      `INSERT INTO producto_papel_nota (idproducto_papel, texto, creado_por)
       VALUES ($1, $2, $3)
       RETURNING idnota_producto_papel, texto, created_at, updated_at`,
      [id, texto, (req as any).user?.id ?? null]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error: any) {
    console.error("❌ CREAR NOTA PRODUCTO ERROR:", error.message);
    return res.status(500).json({ error: "Error al guardar la nota" });
  }
};

export const actualizarNotaProducto = async (req: Request, res: Response) => {
  try {
    const { idnota } = req.params;
    if (!/^\d+$/.test(String(idnota))) {
      return res.status(404).json({ error: "Nota no encontrada" });
    }
    const texto = String(req.body?.texto ?? "").trim();
    if (!texto) {
      return res.status(400).json({ error: "La nota no puede estar vacía" });
    }
    const result = await qAudit(req)(
      `UPDATE producto_papel_nota
       SET texto = $1, actualizado_por = $2, updated_at = now()
       WHERE idnota_producto_papel = $3 AND eliminado_at IS NULL
       RETURNING idnota_producto_papel, texto, created_at, updated_at`,
      [texto, (req as any).user?.id ?? null, idnota]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Nota no encontrada" });
    }
    return res.json(result.rows[0]);
  } catch (error: any) {
    console.error("❌ ACTUALIZAR NOTA PRODUCTO ERROR:", error.message);
    return res.status(500).json({ error: "Error al actualizar la nota" });
  }
};

export const eliminarNotaProducto = async (req: Request, res: Response) => {
  try {
    const { idnota } = req.params;
    if (!/^\d+$/.test(String(idnota))) {
      return res.status(404).json({ error: "Nota no encontrada" });
    }
    const result = await qAudit(req)(
      `UPDATE producto_papel_nota
       SET eliminado_at = now(), eliminado_por = $1
       WHERE idnota_producto_papel = $2 AND eliminado_at IS NULL
       RETURNING idnota_producto_papel`,
      [(req as any).user?.id ?? null, idnota]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Nota no encontrada" });
    }
    return res.json({ message: "Nota eliminada" });
  } catch (error: any) {
    console.error("❌ ELIMINAR NOTA PRODUCTO ERROR:", error.message);
    return res.status(500).json({ error: "Error al eliminar la nota" });
  }
};