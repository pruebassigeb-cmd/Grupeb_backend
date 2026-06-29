import { Request, Response } from "express";
import { pool } from "../../config/db";

// ════════════════════════════════════════════════════════════════════════
// PROCESOS DE PAPEL — Orquestador
//
// Espejo conceptual de procesos.controller.ts (plástico), pero adaptado a
// una cascada DINÁMICA: plástico resuelve "qué procesos aplican" vía
// tipo_producto_plastico_proceso (fijo por tipo de producto). Papel no
// tiene eso — el cliente decide proceso por proceso al cotizar/pedir, así
// que la fuente de verdad es solicitud_producto_papel (campos uv,
// idcat_laminado, idfoil, idcat_textura, alto_relieve, metodo_hojeado,
// lleva_armado), no una tabla de configuración fija.
//
// proceso_cat SÍ es una tabla real y compartida entre materiales
// (confirmado: ya tiene 5 filas de plástico, IDs 1-5). Los 11 procesos de
// papel se insertan ahí (ver ddl_incremental_procesos_papel.sql) y
// continúan la serial sin colisión. Por eso este controlador NO
// hardcodea IDs — los resuelve por nombre_proceso contra la tabla real,
// con un caché simple en memoria (la tabla es prácticamente estática, no
// vale la pena consultarla en cada request).
//
// orden_produccion.proceso_actual se reutiliza tal cual para papel (un
// solo campo, compartido de verdad entre materiales — sin columnas
// paralelas por material, sin rangos numéricos hardcodeados).
//
// Estados de la orden: NO se crean códigos EN_X por proceso (a diferencia
// de plástico). Se usan los mismos 5 genéricos
// (PENDIENTE/EN_PROCESO/TERMINADO/RESAGADO/NO_APLICA) — el campo
// proceso_actual ya indica en cuál proceso está.
// ════════════════════════════════════════════════════════════════════════

const ESTADO_PROD = {
  PENDIENTE: 1,
  EN_PROCESO: 2,
  TERMINADO: 3,
  RESAGADO: 4,
  NO_APLICA: 5,
} as const;

// Nombres EXACTOS insertados en proceso_cat.nombre_proceso (ver DDL
// incremental). Estas claves son estables y se usan como identificador
// lógico interno en TODO este archivo — los idproceso_cat reales se
// resuelven en runtime contra la BD, nunca se hardcodean.
const NOMBRE_PROCESO_CAT_PAPEL = {
  HOJEADO: "Hojeado",
  GUILLOTINA: "Guillotina",
  IMPRESION: "Impresión Papel",
  LAMINACION: "Laminación",
  BARNIZ_UV: "Barniz UV Papel",
  HOT_STAMPING: "Hot Stamping",
  TEXTURIZADO: "Texturizado",
  ALTO_RELIEVE: "Alto Relieve",
  SUAJE: "Suaje Papel",
  ARMADO: "Armado",
  EMPAQUE: "Empaque Papel",
} as const;

type ClaveProcesoPapel = keyof typeof NOMBRE_PROCESO_CAT_PAPEL;

// Orden de cascada fijo de referencia (cuando todos aplican). Hojeado y
// Guillotina comparten la misma posición relativa porque son mutuamente
// excluyentes — nunca coexisten en el array filtrado real.
const ORDEN_CLAVES_PAPEL: ClaveProcesoPapel[] = [
  "HOJEADO", "GUILLOTINA", "IMPRESION", "LAMINACION", "BARNIZ_UV",
  "HOT_STAMPING", "TEXTURIZADO", "ALTO_RELIEVE", "SUAJE", "ARMADO", "EMPAQUE",
];

const TABLA_POR_CLAVE_PAPEL: Record<ClaveProcesoPapel, string> = {
  HOJEADO: "hojeado_papel",
  GUILLOTINA: "guillotina_papel",
  IMPRESION: "impresion_papel",
  LAMINACION: "laminacion_papel",
  BARNIZ_UV: "barniz_uv_papel",
  HOT_STAMPING: "hot_stamping_papel",
  TEXTURIZADO: "texturizado_papel",
  ALTO_RELIEVE: "alto_relieve_papel",
  SUAJE: "suaje_produccion_papel",
  ARMADO: "armado_papel",
  EMPAQUE: "empaque_papel",
};

// ── Caché en memoria: idproceso_cat real <-> clave lógica ──────────────
// proceso_cat es prácticamente estática (cambia solo si se agregan
// procesos nuevos), así que cachear evita un round-trip a BD en cada
// request. Se recarga sola si el proceso Node se reinicia.
let cacheClaveAId: Map<ClaveProcesoPapel, number> | null = null;
let cacheIdAClave: Map<number, ClaveProcesoPapel> | null = null;

async function cargarCacheProcesoCatPapel(): Promise<void> {
  const nombres = Object.values(NOMBRE_PROCESO_CAT_PAPEL);
  const { rows } = await pool.query(
    `SELECT idproceso_cat, nombre_proceso FROM proceso_cat WHERE nombre_proceso = ANY($1)`,
    [nombres]
  );

  const claveAId = new Map<ClaveProcesoPapel, number>();
  const idAClave = new Map<number, ClaveProcesoPapel>();

  for (const [clave, nombre] of Object.entries(NOMBRE_PROCESO_CAT_PAPEL) as [ClaveProcesoPapel, string][]) {
    const fila = rows.find((r: any) => r.nombre_proceso === nombre);
    if (fila) {
      claveAId.set(clave, Number(fila.idproceso_cat));
      idAClave.set(Number(fila.idproceso_cat), clave);
    }
  }

  if (claveAId.size !== Object.keys(NOMBRE_PROCESO_CAT_PAPEL).length) {
    const faltantes = Object.entries(NOMBRE_PROCESO_CAT_PAPEL)
      .filter(([clave]) => !claveAId.has(clave as ClaveProcesoPapel))
      .map(([, nombre]) => nombre);
    throw new Error(
      `proceso_cat no tiene registrados todos los procesos de papel. Faltan: ${faltantes.join(", ")}. ` +
      `Corre ddl_incremental_procesos_papel.sql antes de usar este endpoint.`
    );
  }

  cacheClaveAId = claveAId;
  cacheIdAClave = idAClave;
}

async function getMapaProcesoCatPapel(): Promise<{
  claveAId: Map<ClaveProcesoPapel, number>;
  idAClave: Map<number, ClaveProcesoPapel>;
}> {
  if (!cacheClaveAId || !cacheIdAClave) {
    await cargarCacheProcesoCatPapel();
  }
  return { claveAId: cacheClaveAId!, idAClave: cacheIdAClave! };
}

// Campos editables por tabla (cascada entrada->merma->salida + propios de
// la corrida). Usado por finalizarProceso/editarProceso para saber qué
// columnas aceptar del body. NO incluye campos de ficha (esos viven en
// solicitud_producto_papel / detalle_material_papel y se traen por JOIN
// en getProcesosOrdenPapel, jamás se escriben aquí).
const CAMPOS_PROCESO_PAPEL: Record<string, string[]> = {
  hojeado_papel: ["maquinaria_idmaquinaria", "cantidad_hojeado", "merma", "cantidad_entregada"],
  guillotina_papel: ["maquinaria_idmaquinaria", "pliegos", "cortes", "merma", "cantidad_entregada"],
  impresion_papel: ["maquina", "pliegos_entrada", "merma", "pliegos_entregados"],
  laminacion_papel: ["maquina", "bobina_cm", "metros", "rollos", "desarrollo_mm", "ctes_mod", "pliegos_entrada", "merma", "pliegos_entregados"],
  barniz_uv_papel: ["maquina", "pliegos_entrada", "merma", "pliegos_entregados"],
  hot_stamping_papel: ["maquina", "pliegos_entrada", "merma", "pliegos_entregados"],
  texturizado_papel: ["maquina", "pliegos_entrada", "merma", "pliegos_entregados"],
  alto_relieve_papel: ["maquina", "pliegos_entrada", "merma", "pliegos_entregados"],
  suaje_produccion_papel: ["maquina", "suaje_idsuaje_papel", "pliegos_entrada", "merma", "pliegos_entregados"],
  armado_papel: ["maquina", "pliegos_entrada", "bolsas_armadas", "merma", "bolsas_entregadas"],
  empaque_papel: ["maquina", "bolsas_entrada", "merma", "bolsas_entregadas_final"],
};

// Campo "de entrada" (lo que viene del proceso anterior) por tabla — se
// usa para heredar el valor al inicializar el siguiente proceso al
// finalizar uno.
const CAMPO_ENTRADA_PAPEL: Record<string, string | null> = {
  hojeado_papel: null, // primer proceso posible, no tiene entrada de otro proceso de papel
  guillotina_papel: null, // idem
  impresion_papel: "pliegos_entrada",
  laminacion_papel: "pliegos_entrada",
  barniz_uv_papel: "pliegos_entrada",
  hot_stamping_papel: "pliegos_entrada",
  texturizado_papel: "pliegos_entrada",
  alto_relieve_papel: "pliegos_entrada",
  suaje_produccion_papel: "pliegos_entrada",
  armado_papel: "pliegos_entrada",
  empaque_papel: "bolsas_entrada", // cambia de unidad: bolsas, no pliegos
};

// Campo "de salida final" (lo que entrega cuando el proceso termina) por
// tabla — es lo que se hereda como entrada del siguiente proceso, y lo
// que se usa para calcular el límite de avance.
const CAMPO_SALIDA_PAPEL: Record<string, string> = {
  hojeado_papel: "cantidad_entregada",
  guillotina_papel: "cantidad_entregada",
  impresion_papel: "pliegos_entregados",
  laminacion_papel: "pliegos_entregados",
  barniz_uv_papel: "pliegos_entregados",
  hot_stamping_papel: "pliegos_entregados",
  texturizado_papel: "pliegos_entregados",
  alto_relieve_papel: "pliegos_entregados",
  suaje_produccion_papel: "pliegos_entregados",
  armado_papel: "bolsas_entregadas",
  empaque_papel: "bolsas_entregadas_final",
};

const AVANCE_UNIDAD_PAPEL: Record<string, "pliegos" | "bolsas"> = {
  hojeado_papel: "pliegos",
  guillotina_papel: "pliegos",
  impresion_papel: "pliegos",
  laminacion_papel: "pliegos",
  barniz_uv_papel: "pliegos",
  hot_stamping_papel: "pliegos",
  texturizado_papel: "pliegos",
  alto_relieve_papel: "pliegos",
  suaje_produccion_papel: "pliegos",
  armado_papel: "bolsas",
  empaque_papel: "bolsas",
};

const TABLAS_VALIDAS_PAPEL = Object.values(TABLA_POR_CLAVE_PAPEL);

const CLAVE_MAQUINA_POR_TABLA: Record<string, string> = {
  hojeado_papel: "hojeado_guillotina",
  guillotina_papel: "hojeado_guillotina",
  impresion_papel: "impresora",
  laminacion_papel: "laminado_maquina",
  barniz_uv_papel: "uv",
  hot_stamping_papel: "hs_ar",
  texturizado_papel: "texturizadora",
  alto_relieve_papel: "hs_ar",
  suaje_produccion_papel: "suaje_maquina",
  armado_papel: "armado",
  empaque_papel: "empaque_maquina",
};

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

/**
 * Determina qué procesos aplican a una orden de papel específica, en
 * orden de cascada real, devolviendo los idproceso_cat REALES (resueltos
 * vía caché contra proceso_cat). Fuente de verdad: solicitud_producto_papel
 * de la solicitud_producto asociada a la orden — NO maquinaria_*, NO una
 * tabla de configuración por tipo de producto (a diferencia de plástico).
 * Esto es porque en papel el cliente decide proceso por proceso al
 * cotizar o pedir, no es una propiedad fija del tipo de producto.
 */
async function getProcesosDeOrdenPapel(client: any, idproduccion: number): Promise<number[]> {
  const { claveAId } = await getMapaProcesoCatPapel();

  const { rows } = await client.query(
    `
    SELECT
      spp.metodo_hojeado,
      spp.idcat_laminado,
      spp.uv,
      spp.idfoil,
      spp.idcat_textura,
      spp.alto_relieve,
      spp.lleva_armado
    FROM orden_produccion op
    JOIN solicitud_producto sp ON sp.idsolicitud_producto = op.idsolicitud_producto
    JOIN solicitud_producto_papel spp ON spp.idsolicitud_producto = sp.idsolicitud_producto
    WHERE op.idproduccion = $1
    `,
    [idproduccion]
  );

  if (rows.length === 0) return [];
  const r = rows[0];

  const clavesAplican: ClaveProcesoPapel[] = [];

  if (r.metodo_hojeado === "hojeado") clavesAplican.push("HOJEADO");
  if (r.metodo_hojeado === "guillotina") clavesAplican.push("GUILLOTINA");

  // Impresión, Suaje y Empaque son obligatorios siempre (confirmado).
  clavesAplican.push("IMPRESION");

  if (r.idcat_laminado != null) clavesAplican.push("LAMINACION");
  if (r.uv === true) clavesAplican.push("BARNIZ_UV");
  if (r.idfoil != null) clavesAplican.push("HOT_STAMPING");
  if (r.idcat_textura != null) clavesAplican.push("TEXTURIZADO");
  if (r.alto_relieve === true) clavesAplican.push("ALTO_RELIEVE");

  clavesAplican.push("SUAJE");

  if (r.lleva_armado === true) clavesAplican.push("ARMADO");

  clavesAplican.push("EMPAQUE");

  // Preservar el orden de cascada real, filtrando solo a los que
  // aplican, y traducir a idproceso_cat real.
  return ORDEN_CLAVES_PAPEL
    .filter((clave) => clavesAplican.includes(clave))
    .map((clave) => claveAId.get(clave)!);
}

async function getMaquinaElegidaPapel(
  client: any,
  idproduccion: number,
  tablaProceso: string
): Promise<{ id: number; nombre: string } | null> {
  const clave = CLAVE_MAQUINA_POR_TABLA[tablaProceso];
  if (!clave) return null;

  const { rows } = await client.query(
    `SELECT
       spm.idmaquina AS id,
       spm.nombre_maquina AS nombre
     FROM orden_produccion op
     JOIN solicitud_producto_papel spp
       ON spp.idsolicitud_producto = op.idsolicitud_producto
     JOIN solicitud_producto_papel_maquinaria spm
       ON spm.idsolicitud_producto_papel = spp.idsolicitud_producto_papel
      AND spm.proceso = $2
     WHERE op.idproduccion = $1`,
    [idproduccion, clave]
  );

  const maquina = rows[0];
  if (!maquina?.id) return null;
  return { id: Number(maquina.id), nombre: String(maquina.nombre ?? "") };
}

function getSiguienteProcesoPapel(procesos: number[], procesoActual: number): number | null {
  const idx = procesos.indexOf(procesoActual);
  if (idx === -1) return null;
  return procesos[idx + 1] ?? null;
}

async function getProcesoActualOrdenPapel(
  client: any,
  idproduccion: number
): Promise<{ procesoActualCat: number | null; estadoOrden: number }> {
  const { rows } = await client.query(
    `SELECT proceso_actual, idestado_produccion_cat FROM orden_produccion WHERE idproduccion = $1`,
    [idproduccion]
  );
  if (rows.length === 0) return { procesoActualCat: null, estadoOrden: ESTADO_PROD.PENDIENTE };
  return {
    procesoActualCat: rows[0].proceso_actual,
    estadoOrden: rows[0].idestado_produccion_cat,
  };
}

async function getTablaPorIdProcesoCat(idProcesoCat: number): Promise<string | null> {
  const { idAClave } = await getMapaProcesoCatPapel();
  const clave = idAClave.get(idProcesoCat);
  return clave ? TABLA_POR_CLAVE_PAPEL[clave] : null;
}

async function getIdProcesoCatPorTabla(tabla: string): Promise<number | null> {
  const { claveAId } = await getMapaProcesoCatPapel();
  const clave = (Object.entries(TABLA_POR_CLAVE_PAPEL) as [ClaveProcesoPapel, string][])
    .find(([, t]) => t === tabla)?.[0];
  return clave ? claveAId.get(clave) ?? null : null;
}

/**
 * Inicializa el campo proceso_actual de la orden al primer proceso que
 * aplica. Se llama al crear la orden de producción de papel (análogo a
 * inicializarPrimerProceso de plástico).
 */
export async function inicializarPrimerProcesoPapel(client: any, idproduccion: number): Promise<void> {
  const procesos = await getProcesosDeOrdenPapel(client, idproduccion);
  const primero = procesos[0] ?? null;
  if (primero !== null) {
    await client.query(
      `UPDATE orden_produccion SET proceso_actual = $1 WHERE idproduccion = $2`,
      [primero, idproduccion]
    );
  }
}

async function procesoAnteriorTieneAvanceOTerminadoPapel(
  client: any,
  idproduccion: number,
  procesos: number[],
  procesoActualCat: number
): Promise<boolean> {
  const idx = procesos.indexOf(procesoActualCat);
  if (idx <= 0) return true; // primer proceso, no tiene anterior

  const catAnterior = procesos[idx - 1];
  const tablaAnterior = await getTablaPorIdProcesoCat(catAnterior);
  if (!tablaAnterior) return true;

  const { rows: estadoRows } = await client.query(
    `SELECT estado_produccion_cat_idestado_produccion_cat AS estado
     FROM ${tablaAnterior} WHERE orden_produccion_idproduccion = $1`,
    [idproduccion]
  );
  if (estadoRows.length > 0 && Number(estadoRows[0].estado) === ESTADO_PROD.TERMINADO) return true;

  const { rows: avanceRows } = await client.query(
    `SELECT 1 FROM avance_proceso
     WHERE orden_produccion_idproduccion = $1 AND tabla_proceso = $2 LIMIT 1`,
    [idproduccion, tablaAnterior]
  );
  return avanceRows.length > 0;
}

async function procesoAnteriorEstaTerminadoPapel(
  client: any,
  idproduccion: number,
  procesos: number[],
  procesoActualCat: number
): Promise<boolean> {
  const idx = procesos.indexOf(procesoActualCat);
  if (idx <= 0) return true;

  const catAnterior = procesos[idx - 1];
  const tablaAnterior = await getTablaPorIdProcesoCat(catAnterior);
  if (!tablaAnterior) return true;

  const { rows } = await client.query(
    `SELECT estado_produccion_cat_idestado_produccion_cat AS estado
     FROM ${tablaAnterior} WHERE orden_produccion_idproduccion = $1`,
    [idproduccion]
  );
  return rows.length > 0 && Number(rows[0].estado) === ESTADO_PROD.TERMINADO;
}

/**
 * Límite de avance: cuánto puede avanzar el proceso actual según lo que
 * ya entregó (o lleva acumulado) el proceso anterior. Espejo de
 * getLimiteAvanceAnterior de plástico, pero sin la complejidad de
 * conversión kilo<->pieza (papel siempre trabaja en pliegos/bolsas,
 * nunca kilos).
 */
async function getLimiteAvanceAnteriorPapel(
  client: any,
  idproduccion: number,
  procesos: number[],
  tablaProceso: string
): Promise<number | null> {
  const catActual = await getIdProcesoCatPorTabla(tablaProceso);
  if (!catActual) return null;

  const idx = procesos.indexOf(catActual);
  if (idx <= 0) return null; // primer proceso de la cascada, no tiene límite previo

  const catAnterior = procesos[idx - 1];
  const tablaAnterior = await getTablaPorIdProcesoCat(catAnterior);
  if (!tablaAnterior) return null;

  const campoSalida = CAMPO_SALIDA_PAPEL[tablaAnterior];
  if (!campoSalida) return null;

  const { rows: regRows } = await client.query(
    `SELECT estado_produccion_cat_idestado_produccion_cat AS estado, ${campoSalida} AS campo_final
     FROM ${tablaAnterior}
     WHERE orden_produccion_idproduccion = $1`,
    [idproduccion]
  );

  if (regRows.length === 0) return null;

  const estadoAnterior = Number(regRows[0].estado);

  if (estadoAnterior === ESTADO_PROD.TERMINADO) {
    const v = regRows[0].campo_final;
    return v == null ? null : Number(v);
  }

  const { rows: avRows } = await client.query(
    `SELECT COALESCE(SUM(cantidad), 0) AS total
     FROM avance_proceso
     WHERE orden_produccion_idproduccion = $1 AND tabla_proceso = $2`,
    [idproduccion, tablaAnterior]
  );

  const total = Number(avRows[0]?.total ?? 0);
  return total > 0 ? total : null;
}

// ════════════════════════════════════════════════════════════════════════
// GET /procesos-papel/:idproduccion
// ════════════════════════════════════════════════════════════════════════
export const getProcesosOrdenPapel = async (req: Request, res: Response) => {
  try {
    const { idproduccion } = req.params as { idproduccion: string };
    const { idAClave } = await getMapaProcesoCatPapel();

    const { rows: ordenRows } = await pool.query(`
      SELECT
        op.idproduccion, op.no_produccion, op.fecha,
        op.proceso_actual, op.idestado_produccion_cat,
        ep.nombre AS estado_nombre,
        s.no_pedido, sp.idsolicitud_producto
      FROM orden_produccion op
      JOIN estado_produccion_cat ep ON ep.idestado_produccion_cat = op.idestado_produccion_cat
      JOIN solicitud_producto sp    ON sp.idsolicitud_producto    = op.idsolicitud_producto
      JOIN solicitud s ON s.idsolicitud = op.idsolicitud
      WHERE op.idproduccion = $1
    `, [idproduccion]);

    if (ordenRows.length === 0)
      return res.status(404).json({ error: "Orden no encontrada" });

    const orden = ordenRows[0];

    const procesosIds = await getProcesosDeOrdenPapel(pool, Number(idproduccion));

    if (procesosIds.length === 0) {
      return res.status(400).json({
        error: "No se pudo determinar los procesos de esta orden de papel. Verifica que solicitud_producto_papel tenga metodo_hojeado capturado.",
      });
    }

    const procesosConRegistros = await Promise.all(procesosIds.map(async (idProcesoCat) => {
      const clave = idAClave.get(idProcesoCat)!;
      const tabla = TABLA_POR_CLAVE_PAPEL[clave];
      const nombreProceso = NOMBRE_PROCESO_CAT_PAPEL[clave];

      const { rows: regRows } = await pool.query(
        `SELECT * FROM ${tabla} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
      );

      const registro = regRows[0] ?? null;
      let estado = "pendiente";
      if (registro) {
        const est = Number(registro.estado_produccion_cat_idestado_produccion_cat);
        if (est === ESTADO_PROD.TERMINADO) estado = "terminado";
        else if (est === ESTADO_PROD.RESAGADO) estado = "resagado";
        else if (est === ESTADO_PROD.EN_PROCESO) estado = "en_proceso";
        else estado = "pendiente";
      }

      const { rows: avancesRows } = await pool.query(
        `SELECT idavance, cantidad, unidad, observaciones, fecha_registro
         FROM avance_proceso
         WHERE orden_produccion_idproduccion = $1 AND tabla_proceso = $2
         ORDER BY fecha_registro ASC`,
        [idproduccion, tabla]
      );

      const totalAvances = avancesRows.reduce((sum: number, a: any) => sum + Number(a.cantidad ?? 0), 0);

      return {
        idproceso_cat: idProcesoCat,
        nombre_proceso: nombreProceso,
        tabla, registro, estado,
        observaciones: registro?.observaciones || null,
        avances: avancesRows,
        total_avances: Math.round(totalAvances * 100) / 100,
      };
    }));

    const procesosConLimite = procesosConRegistros.map((proceso, index) => {
      let limiteAvance: number | null = null;

      if (index > 0) {
        const anterior = procesosConRegistros[index - 1];
        if (anterior?.registro) {
          const estNum = Number(anterior.registro.estado_produccion_cat_idestado_produccion_cat);
          const campoSalida = CAMPO_SALIDA_PAPEL[anterior.tabla];

          if (estNum === ESTADO_PROD.TERMINADO) {
            const v = anterior.registro[campoSalida];
            limiteAvance = v != null ? Number(v) : null;
          } else {
            const totalAnt = anterior.total_avances ?? 0;
            limiteAvance = totalAnt > 0 ? totalAnt : null;
          }
        }
      }

      return { ...proceso, limite_avance: limiteAvance };
    });

    const procesosFinales = procesosConLimite.map((proceso, index) => {
      const obsAnterior = index > 0 ? (procesosConLimite[index - 1]?.observaciones || null) : null;
      return { ...proceso, observaciones_proceso_anterior: obsAnterior };
    });

    let procesoActual = orden.proceso_actual;
    if (procesoActual && !idAClave.has(Number(procesoActual))) {
      // El proceso_actual guardado ya no aplica (ej. cambió la config del
      // pedido) — buscar el siguiente válido dentro de los que sí aplican.
      procesoActual = getSiguienteProcesoPapel(procesosIds, Number(procesoActual)) ?? procesosIds[0];
    }

    return res.json({
      idproduccion: Number(idproduccion),
      no_produccion: orden.no_produccion,
      no_pedido: orden.no_pedido,
      proceso_actual: procesoActual,
      estado_id: orden.idestado_produccion_cat,
      estado_nombre: orden.estado_nombre,
      procesos: procesosFinales,
    });

  } catch (error: any) {
    console.error("GET PROCESOS ORDEN PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener procesos de papel" });
  }
};

// ════════════════════════════════════════════════════════════════════════
// POST /procesos-papel/:idproduccion/iniciar
// ════════════════════════════════════════════════════════════════════════
export const iniciarProcesoPapel = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { idproduccion } = req.params as { idproduccion: string };
    const { tabla_proceso, maquina, maquinaria_idmaquinaria } = req.body as {
      tabla_proceso?: string;
      maquina?: string;
      maquinaria_idmaquinaria?: number | string;
    };

    if (!tabla_proceso || !TABLAS_VALIDAS_PAPEL.includes(tabla_proceso)) {
      return res.status(400).json({ error: "Debes indicar el proceso válido (tabla_proceso)" });
    }

    await client.query("BEGIN");

    const procesos = await getProcesosDeOrdenPapel(client, Number(idproduccion));
    const procesoActualCat = await getIdProcesoCatPorTabla(tabla_proceso);
    const maquinaPedido = await getMaquinaElegidaPapel(
      client,
      Number(idproduccion),
      tabla_proceso
    );
    const maquinaFinal = maquina || maquinaPedido?.nombre || undefined;
    const maquinariaIdFinal =
      maquinaria_idmaquinaria || maquinaPedido?.id || undefined;

    if (!procesoActualCat || !procesos.includes(procesoActualCat)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Este proceso no aplica a esta orden de papel" });
    }

    const { rows: existeRows } = await client.query(
      `SELECT * FROM ${tabla_proceso} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
    );

    if (existeRows.length > 0 && existeRows[0].fecha_inicio) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Este proceso ya fue iniciado" });
    }

    const idx = procesos.indexOf(procesoActualCat);
    if (idx > 0) {
      const puedeIniciar = await procesoAnteriorTieneAvanceOTerminadoPapel(
        client, Number(idproduccion), procesos, procesoActualCat
      );
      if (!puedeIniciar) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "El proceso anterior debe tener al menos un avance registrado o estar finalizado para poder iniciar este proceso",
        });
      }
    }

    if (existeRows.length === 0) {
      const columnas = ["estado_produccion_cat_idestado_produccion_cat", "orden_produccion_idproduccion", "fecha_creacion", "fecha_inicio"];
      const valores: any[] = [ESTADO_PROD.EN_PROCESO, idproduccion];
      let placeholders = ["$1", "$2", "NOW()", "NOW()"];

      if (
        ["hojeado_papel", "guillotina_papel"].includes(tabla_proceso) &&
        maquinariaIdFinal
      ) {
        columnas.push("maquinaria_idmaquinaria");
        valores.push(Number(maquinariaIdFinal));
        placeholders.push(`$${valores.length}`);
      } else if (maquinaFinal) {
        columnas.push("maquina");
        valores.push(maquinaFinal);
        placeholders.push(`$${valores.length}`);
      }

      await client.query(
        `INSERT INTO ${tabla_proceso} (${columnas.join(", ")}) VALUES (${placeholders.join(", ")})`,
        valores
      );
    } else {
      const setClauses = ["fecha_inicio = NOW()", "estado_produccion_cat_idestado_produccion_cat = $1"];
      const values: any[] = [ESTADO_PROD.EN_PROCESO];
      let paramIdx = 2;

      if (
        ["hojeado_papel", "guillotina_papel"].includes(tabla_proceso) &&
        maquinariaIdFinal
      ) {
        setClauses.push(`maquinaria_idmaquinaria = $${paramIdx}`);
        values.push(Number(maquinariaIdFinal));
        paramIdx++;
      } else if (maquinaFinal) {
        setClauses.push(`maquina = $${paramIdx}`);
        values.push(maquinaFinal);
        paramIdx++;
      }

      values.push(idproduccion);
      await client.query(
        `UPDATE ${tabla_proceso} SET ${setClauses.join(", ")} WHERE orden_produccion_idproduccion = $${paramIdx}`,
        values
      );
    }

    await client.query(
      `UPDATE orden_produccion SET idestado_produccion_cat = $1, proceso_actual = $2 WHERE idproduccion = $3`,
      [ESTADO_PROD.EN_PROCESO, procesoActualCat, idproduccion]
    );

    await client.query("COMMIT");
    return res.json({
      message: `Proceso ${tabla_proceso} iniciado`,
      idproduccion: Number(idproduccion),
      proceso_actual: procesoActualCat,
      tabla: tabla_proceso,
      estado_id: ESTADO_PROD.EN_PROCESO,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("INICIAR PROCESO PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al iniciar proceso de papel" });
  } finally { client.release(); }
};

// ════════════════════════════════════════════════════════════════════════
// POST /procesos-papel/:idproduccion/avance
// ════════════════════════════════════════════════════════════════════════
export const registrarAvancePapel = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { idproduccion } = req.params as { idproduccion: string };
    const { cantidad, observaciones, tabla_proceso } = req.body as {
      cantidad: number | string; observaciones?: string; tabla_proceso: string;
    };

    if (!cantidad || Number(cantidad) <= 0) {
      return res.status(400).json({ error: "La cantidad debe ser mayor a 0" });
    }

    if (!tabla_proceso || !TABLAS_VALIDAS_PAPEL.includes(tabla_proceso)) {
      return res.status(400).json({ error: "Debes indicar el proceso válido (tabla_proceso)" });
    }

    await client.query("BEGIN");

    const { rows: procesoRows } = await client.query(
      `SELECT estado_produccion_cat_idestado_produccion_cat AS estado, fecha_inicio
       FROM ${tabla_proceso} WHERE orden_produccion_idproduccion = $1`,
      [idproduccion]
    );

    if (procesoRows.length === 0 || !procesoRows[0].fecha_inicio) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El proceso no ha sido iniciado" });
    }

    const est = Number(procesoRows[0].estado);
    if (est === ESTADO_PROD.TERMINADO) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El proceso ya está terminado" });
    }
    if (est === ESTADO_PROD.RESAGADO) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El proceso está resagado" });
    }

    const procesos = await getProcesosDeOrdenPapel(client, Number(idproduccion));
    const limiteAnterior = await getLimiteAvanceAnteriorPapel(client, Number(idproduccion), procesos, tabla_proceso);

    if (limiteAnterior !== null) {
      const { rows: acumRows } = await client.query(
        `SELECT COALESCE(SUM(cantidad), 0) AS total FROM avance_proceso
         WHERE orden_produccion_idproduccion = $1 AND tabla_proceso = $2`,
        [idproduccion, tabla_proceso]
      );

      const acumuladoActual = Number(acumRows[0]?.total ?? 0);
      const proyectado = acumuladoActual + Number(cantidad);

      if (proyectado > limiteAnterior) {
        console.warn(
          `[AVISO] Sobreproducción detectada en ${tabla_proceso} (papel). ` +
          `Límite: ${limiteAnterior}, proyectado: ${proyectado}`
        );
      }
    }

    const unidad = AVANCE_UNIDAD_PAPEL[tabla_proceso] ?? "pliegos";

    const { rows: inserted } = await client.query(
      `INSERT INTO avance_proceso
         (orden_produccion_idproduccion, tabla_proceso, cantidad, unidad, observaciones, fecha_registro)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING idavance, cantidad, unidad, observaciones, fecha_registro`,
      [idproduccion, tabla_proceso, Number(cantidad), unidad, observaciones?.trim() || null]
    );

    await client.query(`
      UPDATE orden_produccion
      SET es_parcialidad = true
      WHERE idproduccion = $1 AND es_parcialidad = false
    `, [idproduccion]);

    // Desbloquear/inicializar el siguiente proceso si aún no existe
    // (sin datos de entrada todavía — la propagación de cantidades reales
    // ocurre al finalizar, igual que en plástico).
    const procesoActualCat = await getIdProcesoCatPorTabla(tabla_proceso);
    const siguienteCat = procesoActualCat ? getSiguienteProcesoPapel(procesos, procesoActualCat) : null;

    if (siguienteCat !== null) {
      const tablaSiguiente = await getTablaPorIdProcesoCat(siguienteCat);
      if (tablaSiguiente) {
        const { rows: sigExiste } = await client.query(
          `SELECT 1 FROM ${tablaSiguiente} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
        );
        if (sigExiste.length === 0) {
          await client.query(`
            INSERT INTO ${tablaSiguiente}
              (estado_produccion_cat_idestado_produccion_cat, orden_produccion_idproduccion, fecha_creacion)
            VALUES ($1, $2, NOW())
            ON CONFLICT DO NOTHING
          `, [ESTADO_PROD.PENDIENTE, idproduccion]);
        }
      }
    }

    await client.query("COMMIT");
    return res.status(201).json({
      message: "Avance registrado correctamente",
      idproduccion: Number(idproduccion), tabla: tabla_proceso, avance: inserted[0],
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("REGISTRAR AVANCE PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al registrar avance de papel" });
  } finally { client.release(); }
};

// ════════════════════════════════════════════════════════════════════════
// PUT /procesos-papel/:idproduccion/finalizar
// ════════════════════════════════════════════════════════════════════════
export const finalizarProcesoPapel = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { idproduccion } = req.params as { idproduccion: string };
    const datos = req.body;
    const tablaProceso = datos.tabla_proceso as string;

    if (!tablaProceso || !TABLAS_VALIDAS_PAPEL.includes(tablaProceso)) {
      return res.status(400).json({ error: "Debes indicar el proceso válido (tabla_proceso)" });
    }

    await client.query("BEGIN");

    const procesos = await getProcesosDeOrdenPapel(client, Number(idproduccion));
    const procesoActualCat = await getIdProcesoCatPorTabla(tablaProceso);

    if (!procesoActualCat || !procesos.includes(procesoActualCat)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Este proceso no aplica a esta orden de papel" });
    }

    const { rows: procesoRows } = await client.query(
      `SELECT * FROM ${tablaProceso} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
    );
    if (procesoRows.length === 0 || !procesoRows[0].fecha_inicio) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El proceso no ha sido iniciado aun" });
    }

    const anteriorTerminado = await procesoAnteriorEstaTerminadoPapel(
      client, Number(idproduccion), procesos, procesoActualCat
    );
    if (!anteriorTerminado) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El proceso anterior debe estar finalizado para poder finalizar este proceso" });
    }

    const campos = CAMPOS_PROCESO_PAPEL[tablaProceso] ?? [];
    const setClauses = ["fecha_fin = NOW()", "estado_produccion_cat_idestado_produccion_cat = $1"];
    const values: any[] = [ESTADO_PROD.TERMINADO];
    let paramIdx = 2;

    for (const campo of campos) {
      if (datos[campo] !== undefined && datos[campo] !== null) {
        setClauses.push(`${campo} = $${paramIdx}`); values.push(datos[campo]); paramIdx++;
      }
    }
    if (datos.observaciones !== undefined) {
      setClauses.push(`observaciones = $${paramIdx}`); values.push(datos.observaciones); paramIdx++;
    }

    values.push(idproduccion);
    await client.query(
      `UPDATE ${tablaProceso} SET ${setClauses.join(", ")} WHERE orden_produccion_idproduccion = $${paramIdx}`,
      values
    );

    const siguienteProceso = getSiguienteProcesoPapel(procesos, procesoActualCat);

    if (siguienteProceso !== null) {
      const tablaSiguiente = await getTablaPorIdProcesoCat(siguienteProceso);
      if (!tablaSiguiente) {
        await client.query("ROLLBACK");
        return res.status(500).json({ error: "Proceso siguiente sin tabla asociada" });
      }

      const campoSalidaActual = CAMPO_SALIDA_PAPEL[tablaProceso];
      const valorSalida = campoSalidaActual ? (datos[campoSalidaActual] ?? null) : null;
      const campoEntradaSig = CAMPO_ENTRADA_PAPEL[tablaSiguiente];

      const { rows: sigExisteRows } = await client.query(
        `SELECT 1 FROM ${tablaSiguiente} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
      );
      const sigYaExiste = sigExisteRows.length > 0;

      if (!sigYaExiste) {
        if (campoEntradaSig && valorSalida != null) {
          await client.query(`
            INSERT INTO ${tablaSiguiente}
              (estado_produccion_cat_idestado_produccion_cat, orden_produccion_idproduccion, fecha_creacion, ${campoEntradaSig})
            VALUES ($1, $2, NOW(), $3)
          `, [ESTADO_PROD.PENDIENTE, idproduccion, valorSalida]);
        } else {
          await client.query(`
            INSERT INTO ${tablaSiguiente}
              (estado_produccion_cat_idestado_produccion_cat, orden_produccion_idproduccion, fecha_creacion)
            VALUES ($1, $2, NOW())
          `, [ESTADO_PROD.PENDIENTE, idproduccion]);
        }
      } else if (campoEntradaSig && valorSalida != null) {
        await client.query(`
          UPDATE ${tablaSiguiente} SET ${campoEntradaSig} = COALESCE(${campoEntradaSig}, $1)
          WHERE orden_produccion_idproduccion = $2
        `, [valorSalida, idproduccion]);
      }

      await client.query(`
        UPDATE orden_produccion SET proceso_actual = $1, idestado_produccion_cat = $2 WHERE idproduccion = $3
      `, [siguienteProceso, ESTADO_PROD.PENDIENTE, idproduccion]);
    } else {
      await client.query(`
        UPDATE orden_produccion SET idestado_produccion_cat = $1, proceso_actual = NULL WHERE idproduccion = $2
      `, [ESTADO_PROD.TERMINADO, idproduccion]);
    }

    await client.query("COMMIT");
    return res.json({
      message: `Proceso ${tablaProceso} finalizado`, idproduccion: Number(idproduccion),
      proceso_terminado: procesoActualCat, siguiente_proceso: siguienteProceso,
      orden_completada: siguienteProceso === null,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("FINALIZAR PROCESO PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al finalizar proceso de papel" });
  } finally { client.release(); }
};

// ════════════════════════════════════════════════════════════════════════
// PUT /procesos-papel/:idproduccion/editar/:tabla
// ════════════════════════════════════════════════════════════════════════
export const editarProcesoPapel = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { idproduccion, tabla } = req.params as { idproduccion: string; tabla: string };
    const datos = req.body;

    if (!TABLAS_VALIDAS_PAPEL.includes(tabla)) {
      return res.status(400).json({ error: `Tabla invalida: ${tabla}` });
    }

    await client.query("BEGIN");

    const { rows: procesoRows } = await client.query(
      `SELECT * FROM ${tabla} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
    );
    if (procesoRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Proceso no encontrado" });
    }

    const estadoActual = Number(procesoRows[0].estado_produccion_cat_idestado_produccion_cat);
    if (estadoActual !== ESTADO_PROD.TERMINADO) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Solo se pueden editar procesos terminados" });
    }

    const campos = CAMPOS_PROCESO_PAPEL[tabla] ?? [];
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    for (const campo of campos) {
      if (datos[campo] !== undefined) {
        setClauses.push(`${campo} = $${paramIdx}`);
        values.push(datos[campo] !== "" ? datos[campo] : null);
        paramIdx++;
      }
    }
    if (datos.observaciones !== undefined) {
      setClauses.push(`observaciones = $${paramIdx}`); values.push(datos.observaciones || null); paramIdx++;
    }
    if (datos.fecha_inicio !== undefined) {
      setClauses.push(`fecha_inicio = $${paramIdx}`); values.push(datos.fecha_inicio || null); paramIdx++;
    }
    if (datos.fecha_fin !== undefined) {
      setClauses.push(`fecha_fin = $${paramIdx}`); values.push(datos.fecha_fin || null); paramIdx++;
    }

    if (setClauses.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No se enviaron campos para actualizar" });
    }

    values.push(idproduccion);
    await client.query(
      `UPDATE ${tabla} SET ${setClauses.join(", ")} WHERE orden_produccion_idproduccion = $${paramIdx}`,
      values
    );

    // Si se editó el campo de salida y existe el siguiente proceso aún
    // sin iniciar, propagar el nuevo valor como su entrada (igual que
    // plástico hace al editar extrusion/impresion/bolseo).
    const campoSalida = CAMPO_SALIDA_PAPEL[tabla];
    if (campoSalida && datos[campoSalida] != null && datos[campoSalida] !== "") {
      const procesos = await getProcesosDeOrdenPapel(client, Number(idproduccion));
      const catActual = await getIdProcesoCatPorTabla(tabla);
      const siguienteCat = catActual ? getSiguienteProcesoPapel(procesos, catActual) : null;
      const tablaSiguiente = siguienteCat ? await getTablaPorIdProcesoCat(siguienteCat) : null;
      const campoEntradaSig = tablaSiguiente ? CAMPO_ENTRADA_PAPEL[tablaSiguiente] : null;

      if (tablaSiguiente && campoEntradaSig) {
        const { rows: sigRows } = await client.query(
          `SELECT fecha_inicio FROM ${tablaSiguiente} WHERE orden_produccion_idproduccion = $1`,
          [idproduccion]
        );
        // Solo propagar si el siguiente aún no inició (no se quiere
        // pisar trabajo ya en curso).
        if (sigRows.length > 0 && !sigRows[0].fecha_inicio) {
          await client.query(
            `UPDATE ${tablaSiguiente} SET ${campoEntradaSig} = $1 WHERE orden_produccion_idproduccion = $2`,
            [datos[campoSalida], idproduccion]
          );
        }
      }
    }

    await client.query("COMMIT");
    return res.json({ message: `Proceso ${tabla} actualizado`, idproduccion: Number(idproduccion), tabla });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("EDITAR PROCESO PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al editar proceso de papel" });
  } finally { client.release(); }
};
