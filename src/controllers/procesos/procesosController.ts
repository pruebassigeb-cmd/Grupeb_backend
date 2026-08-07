import { iniciarTx } from "../../middlewares/auditoria";
import { Request, Response } from "express";
import { pool } from "../../config/db";

const ESTADO_PROD = {
  PENDIENTE: 1,
  EN_PROCESO: 2,
  TERMINADO: 3,
  RESAGADO: 4,
  NO_APLICA: 5,
  EN_EXTRUSION: 6,
  EN_IMPRESION: 7,
  EN_BOLSEO: 8,
  EN_TROQUELADO: 9,
  EN_ASA_FLEXIBLE: 10,
} as const;

const PROCESO = {
  EXTRUSION: 1,
  IMPRESION: 2,
  ASA_FLEXIBLE: 3,
  TROQUELADO: 4,
  BOLSEO: 5,
} as const;

const ORDEN_PROCESOS = [1, 2, 5, 3, 4];

const PROCESO_TABLA: Record<number, string> = {
  [PROCESO.EXTRUSION]: "extrusion",
  [PROCESO.IMPRESION]: "impresion",
  [PROCESO.BOLSEO]: "bolseo",
  [PROCESO.ASA_FLEXIBLE]: "asa_flexible",
};

const PROCESO_ESTADO: Record<number, number> = {
  [PROCESO.EXTRUSION]: ESTADO_PROD.EN_EXTRUSION,
  [PROCESO.IMPRESION]: ESTADO_PROD.EN_IMPRESION,
  [PROCESO.BOLSEO]: ESTADO_PROD.EN_BOLSEO,
  [PROCESO.ASA_FLEXIBLE]: ESTADO_PROD.EN_ASA_FLEXIBLE,
};

const CAMPOS_PROCESO: Record<string, string[]> = {
  extrusion: ["kilos_extruir", "metros_extruir", "merma", "k_para_impresion", "metros_extruidos"],
  impresion: ["kilos_imprimir", "metros_imprimir", "merma", "kilos_impresos", "metros_impresos"],
  bolseo: ["kilos_bolsear", "kilos_bolseados", "kilos_merma", "piezas_bolseadas", "piezas_merma"],
  asa_flexible: ["pzas_finales", "merma", "piezas_recibidas", "kilos_recibidos", "kilos_merma", "kilos_finales"],
};

const AVANCE_CONFIG: Record<string, { campo: string; unidad: "kg" | "pzas" }> = {
  extrusion: { campo: "kilos_extruidos_parcial", unidad: "kg" },
  impresion: { campo: "kilos_impresos_parcial", unidad: "kg" },
  bolseo: { campo: "piezas_bolseadas_parcial", unidad: "pzas" },
  asa_flexible: { campo: "pzas_finales_parcial", unidad: "pzas" },
};

const MAQUINAS_IMPRESION = ["kidder", "sicosa"] as const;
type MaquinaImpresion = typeof MAQUINAS_IMPRESION[number];

// ============================================================
// HELPERS
// ============================================================

async function getProcesosDeOrden(client: any, idproduccion: number): Promise<number[]> {
  const { rows } = await client.query(`
    SELECT DISTINCT tppp.idproceso_cat
    FROM orden_produccion op
    JOIN solicitud_producto sp
        ON sp.idsolicitud_producto = op.idsolicitud_producto
    JOIN configuracion_plastico cfg
        ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
    JOIN tipo_producto_plastico_proceso tppp
        ON tppp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
    WHERE op.idproduccion = $1
  `, [idproduccion]);
  const ids = rows.map((r: any) => Number(r.idproceso_cat));
  return ORDEN_PROCESOS.filter(id => ids.includes(id));
}

function getSiguienteProceso(procesos: number[], procesoActual: number): number | null {
  const idx = procesos.indexOf(procesoActual);
  if (idx === -1) return null;
  for (let i = idx + 1; i < procesos.length; i++) {
    const candidato = procesos[i];
    if (PROCESO_TABLA[candidato]) return candidato;
  }
  return null;
}
   
async function getProcesoActualOrden(
  client: any, idproduccion: number
): Promise<{ procesoActualCat: number | null; estadoOrden: number }> {
  const { rows } = await client.query(
    `SELECT proceso_actual, idestado_produccion_cat FROM orden_produccion WHERE idproduccion = $1`,
    [idproduccion]
  );
  if (rows.length === 0) return { procesoActualCat: null, estadoOrden: 1 };
  return {
    procesoActualCat: rows[0].proceso_actual,
    estadoOrden: rows[0].idestado_produccion_cat,
  };
}

export async function inicializarPrimerProceso(client: any, idproduccion: number): Promise<void> {
  const procesos = await getProcesosDeOrden(client, idproduccion);
  const primero = procesos.find(p => PROCESO_TABLA[p] !== undefined) ?? null;
  if (primero !== null) {
    await client.query(
      `UPDATE orden_produccion SET proceso_actual = $1 WHERE idproduccion = $2`,
      [primero, idproduccion]
    );
  }
}

async function procesoAnteriorTieneAvance(
  client: any, idproduccion: number, procesos: number[], procesoActualCat: number
): Promise<boolean> {
  const idx = procesos.indexOf(procesoActualCat);
  if (idx <= 0) return true;

  const catAnterior = procesos[idx - 1];
  const tablaAnterior = PROCESO_TABLA[catAnterior];
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

async function procesoAnteriorEstaTerminado(
  client: any, idproduccion: number, procesos: number[], procesoActualCat: number
): Promise<boolean> {
  const idx = procesos.indexOf(procesoActualCat);
  if (idx <= 0) return true;

  const catAnterior = procesos[idx - 1];
  const tablaAnterior = PROCESO_TABLA[catAnterior];
  if (!tablaAnterior) return true;

  const { rows } = await client.query(
    `SELECT estado_produccion_cat_idestado_produccion_cat AS estado
     FROM ${tablaAnterior} WHERE orden_produccion_idproduccion = $1`,
    [idproduccion]
  );
  return rows.length > 0 && Number(rows[0].estado) === ESTADO_PROD.TERMINADO;
}

async function getLimiteAvanceAnterior(
  client: any,
  idproduccion: number,
  procesos: number[],
  tablaProceso: string,
  porKilo: number | null,
  modoOrden: "unidad" | "kilo" = "unidad"
): Promise<number | null> {
  const catActual = Object.entries(PROCESO_TABLA).find(([, t]) => t === tablaProceso)?.[0];
  if (!catActual) return null;

  const idx = procesos.indexOf(Number(catActual));
  if (idx <= 0) return null;

  const catAnterior = procesos[idx - 1];
  const tablaAnterior = PROCESO_TABLA[catAnterior];
  if (!tablaAnterior) return null;

  const necesitaConversion = tablaAnterior === "impresion" && tablaProceso === "bolseo" && modoOrden === "unidad";

  const campoFinal: Record<string, string> = {
    extrusion: "k_para_impresion",
    impresion: "kilos_impresos",
    bolseo: tablaProceso === "asa_flexible" && modoOrden === "kilo"
      ? "kilos_bolseados"
      : "piezas_bolseadas",
    asa_flexible: modoOrden === "kilo" ? "kilos_finales" : "pzas_finales",
  };
  const campo = campoFinal[tablaAnterior];
  if (!campo) return null;

  const { rows: regRows } = await client.query(
    `SELECT estado_produccion_cat_idestado_produccion_cat AS estado, ${campo} AS campo_final
     FROM ${tablaAnterior}
     WHERE orden_produccion_idproduccion = $1`,
    [idproduccion]
  );

  if (regRows.length === 0) return null;

  const estadoAnterior = Number(regRows[0].estado);

  if (estadoAnterior === ESTADO_PROD.TERMINADO) {
    const v = regRows[0].campo_final;
    if (v == null) return null;
    const valorBase = Number(v);
    if (necesitaConversion && porKilo != null && porKilo > 0) {
      return Math.floor(valorBase * porKilo);
    }
    return valorBase;
  }

  const { rows: avRows } = await client.query(
    `SELECT COALESCE(SUM(cantidad), 0) AS total
     FROM avance_proceso
     WHERE orden_produccion_idproduccion = $1 AND tabla_proceso = $2`,
    [idproduccion, tablaAnterior]
  );

  const total = Number(avRows[0]?.total ?? 0);
  if (total <= 0) return null;

  if (necesitaConversion && porKilo != null && porKilo > 0) {
    return Math.floor(total * porKilo);
  }
  return total;
}

// ============================================================
// GET /procesos/:idproduccion
// ============================================================
export const getProcesosOrden = async (req: Request, res: Response) => {
  try {
    const { idproduccion } = req.params as { idproduccion: string };

    const { rows: ordenRows } = await pool.query(`
      SELECT
        op.idproduccion, op.no_produccion, op.fecha,
        op.proceso_actual, op.idestado_produccion_cat,
        ep.nombre AS estado_nombre,
        s.no_pedido, sp.idsolicitud_producto,
        cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico AS idtipo_producto,
        op.repeticion_kidder, op.repeticion_sicosa,
        cfg.por_kilo,
        sd.modo_cantidad
      FROM orden_produccion op
      JOIN estado_produccion_cat ep ON ep.idestado_produccion_cat = op.idestado_produccion_cat
      JOIN solicitud_producto sp    ON sp.idsolicitud_producto    = op.idsolicitud_producto
      JOIN configuracion_plastico cfg
          ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      JOIN solicitud s ON s.idsolicitud = op.idsolicitud
      LEFT JOIN solicitud_detalle sd ON sd.solicitud_producto_id = sp.idsolicitud_producto AND sd.aprobado = true
      WHERE op.idproduccion = $1
    `, [idproduccion]);

    if (ordenRows.length === 0)
      return res.status(404).json({ error: "Orden no encontrada" });

    const orden = ordenRows[0];
    const idtipo = orden.idtipo_producto;
    const porKilo = orden.por_kilo != null ? Number(orden.por_kilo) : null;
    const modoOrdenPedido = (orden.modo_cantidad ?? 'unidad') as 'unidad' | 'kilo';

    const { rows: procesosRawRows } = await pool.query(`
      SELECT tppp.idproceso_cat, pc.nombre_proceso
      FROM tipo_producto_plastico_proceso tppp
      JOIN proceso_cat pc ON pc.idproceso_cat = tppp.idproceso_cat
      WHERE tppp.idtipo_producto_plastico = $1
    `, [idtipo]);

    const procesosRows = ORDEN_PROCESOS
      .filter(id => procesosRawRows.some((r: any) => Number(r.idproceso_cat) === id))
      .map(id => procesosRawRows.find((r: any) => Number(r.idproceso_cat) === id));

    const procesosConRegistros = await Promise.all(procesosRows.map(async (p: any) => {
      const tabla = PROCESO_TABLA[p.idproceso_cat];

      if (!tabla) {
        return {
          idproceso_cat: p.idproceso_cat, nombre_proceso: p.nombre_proceso,
          tabla: null, registro: null, estado: "no_aplica",
          observaciones: null, avances: [], total_avances: 0,
        };
      }

      const { rows: regRows } = await pool.query(
        `SELECT * FROM ${tabla} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
      );

      const registro = regRows[0] ?? null;
      let estado = "pendiente";
      if (registro) {
        const est = Number(registro.estado_produccion_cat_idestado_produccion_cat);
        if (est === ESTADO_PROD.TERMINADO) estado = "terminado";
        else if (est === ESTADO_PROD.RESAGADO) estado = "resagado";
        else if (est === ESTADO_PROD.EN_PROCESO || est >= 6) estado = "en_proceso";
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
        idproceso_cat: p.idproceso_cat, nombre_proceso: p.nombre_proceso,
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
          const necesitaConversion = anterior.tabla === "impresion" && proceso.tabla === "bolseo"
            && modoOrdenPedido === "unidad";

          if (estNum === ESTADO_PROD.TERMINADO) {
            if (anterior.tabla === "extrusion") {
              const v = anterior.registro.k_para_impresion;
              limiteAvance = v != null ? Number(v) : null;
            } else if (anterior.tabla === "impresion") {
              const v = anterior.registro.kilos_impresos;
              if (v != null) {
                const base = Number(v);
                limiteAvance = (necesitaConversion && porKilo != null && porKilo > 0)
                  ? Math.floor(base * porKilo)
                  : base;
              }
            } else if (anterior.tabla === "bolseo") {
              const v = modoOrdenPedido === "kilo"
                ? anterior.registro.kilos_bolseados
                : anterior.registro.piezas_bolseadas;
              limiteAvance = v != null ? Number(v) : null;
            }
          } else {
            const totalAnt = anterior.total_avances ?? 0;
            if (totalAnt > 0) {
              limiteAvance = (necesitaConversion && porKilo != null && porKilo > 0)
                ? Math.floor(totalAnt * porKilo)
                : totalAnt;
            }
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
    if (procesoActual && !PROCESO_TABLA[procesoActual]) {
      const todosProcesos = procesosRows.map((p: any) => Number(p.idproceso_cat));
      procesoActual = getSiguienteProceso(todosProcesos, procesoActual);
    }

    return res.json({
      idproduccion: Number(idproduccion),
      no_produccion: orden.no_produccion,
      no_pedido: orden.no_pedido,
      proceso_actual: procesoActual,
      estado_id: orden.idestado_produccion_cat,
      estado_nombre: orden.estado_nombre,
      repeticion_kidder: orden.repeticion_kidder ?? null,
      repeticion_sicosa: orden.repeticion_sicosa ?? null,
      procesos: procesosFinales,
    });

  } catch (error: any) {
    console.error("GET PROCESOS ORDEN ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener procesos" });
  }
};

// ============================================================
// POST /procesos/:idproduccion/iniciar
// ============================================================
export const iniciarProceso = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { idproduccion } = req.params as { idproduccion: string };
    const { maquina, repeticion } = req.body as { maquina?: string; repeticion?: string };

    await iniciarTx(req, client);

    const procesos = await getProcesosDeOrden(client, Number(idproduccion));

    let procesoActualCat: number | null = null;
    let existeRows: any[] = [];

    for (const cat of procesos) {
      const tabla = PROCESO_TABLA[cat];
      if (!tabla) continue;
      const { rows } = await client.query(
        `SELECT * FROM ${tabla} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
      );
      if (rows.length > 0 && !rows[0].fecha_inicio) {
        procesoActualCat = cat; existeRows = rows; break;
      }
    }

    if (!procesoActualCat) {
      let { procesoActualCat: fromOrden } = await getProcesoActualOrden(client, Number(idproduccion));
      if (fromOrden && !PROCESO_TABLA[fromOrden]) {
        fromOrden = getSiguienteProceso(procesos, fromOrden);
        if (fromOrden) {
          await client.query(
            `UPDATE orden_produccion SET proceso_actual = $1 WHERE idproduccion = $2`,
            [fromOrden, idproduccion]
          );
        }
      }
      procesoActualCat = fromOrden; existeRows = [];
    }

    if (!procesoActualCat) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "La orden no tiene proceso pendiente" });
    }

    const tabla = PROCESO_TABLA[procesoActualCat];
    if (!tabla) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: `Proceso ${procesoActualCat} no tiene tabla asociada` });
    }

    if (existeRows.length === 0) {
      const { rows } = await client.query(
        `SELECT * FROM ${tabla} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
      );
      existeRows = rows;
    }

    if (existeRows.length > 0 && existeRows[0].fecha_inicio) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Este proceso ya fue iniciado" });
    }

    const idx = procesos.indexOf(procesoActualCat);
    if (idx > 0) {
      const puedeIniciar = await procesoAnteriorTieneAvance(client, Number(idproduccion), procesos, procesoActualCat);
      if (!puedeIniciar) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "El proceso anterior debe tener al menos un avance registrado o estar finalizado para poder iniciar este proceso",
        });
      }
    }

    if (procesoActualCat === PROCESO.IMPRESION) {
      if (!maquina || !MAQUINAS_IMPRESION.includes(maquina as MaquinaImpresion)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Debes seleccionar una maquina de impresion: kidder o sicosa" });
      }
    }

    if (procesoActualCat === PROCESO.EXTRUSION) {
      const { rows: mermaRows } = await client.query(
        `SELECT kilos_merma, metros_merma FROM orden_produccion WHERE idproduccion = $1`, [idproduccion]
      );
      const kilos_extruir = mermaRows[0]?.kilos_merma ?? null;
      const metros_extruir = mermaRows[0]?.metros_merma ?? null;

      if (existeRows.length === 0) {
        await client.query(`
          INSERT INTO extrusion (estado_produccion_cat_idestado_produccion_cat, orden_produccion_idproduccion,
            fecha_creacion, fecha_inicio, metros_extruir, kilos_extruir, observaciones)
          VALUES ($1, $2, NOW(), NOW(), $3, $4, NULL)
        `, [ESTADO_PROD.EN_PROCESO, idproduccion, metros_extruir, kilos_extruir]);
      } else {
        await client.query(`
          UPDATE extrusion SET fecha_inicio = NOW(),
            estado_produccion_cat_idestado_produccion_cat = $1,
            metros_extruir = COALESCE(metros_extruir, $2),
            kilos_extruir  = COALESCE(kilos_extruir,  $3)
          WHERE orden_produccion_idproduccion = $4
        `, [ESTADO_PROD.EN_PROCESO, metros_extruir, kilos_extruir, idproduccion]);
      }

    } else if (procesoActualCat === PROCESO.IMPRESION) {
      const maquinaCompleta = repeticion ? `${maquina} | ${repeticion}` : (maquina ?? null);
      if (existeRows.length === 0) {
        await client.query(`
          INSERT INTO impresion (estado_produccion_cat_idestado_produccion_cat, orden_produccion_idproduccion,
            fecha_creacion, fecha_inicio, maquina, observaciones)
          VALUES ($1, $2, NOW(), NOW(), $3, NULL)
        `, [ESTADO_PROD.EN_PROCESO, idproduccion, maquinaCompleta]);
      } else {
        await client.query(`
          UPDATE impresion SET fecha_inicio = NOW(),
            estado_produccion_cat_idestado_produccion_cat = $1, maquina = $2
          WHERE orden_produccion_idproduccion = $3
        `, [ESTADO_PROD.EN_PROCESO, maquinaCompleta, idproduccion]);
      }

    } else {
      if (existeRows.length === 0) {
        await client.query(`
          INSERT INTO ${tabla} (estado_produccion_cat_idestado_produccion_cat, orden_produccion_idproduccion,
            fecha_creacion, fecha_inicio, observaciones)
          VALUES ($1, $2, NOW(), NOW(), NULL)
        `, [ESTADO_PROD.EN_PROCESO, idproduccion]);
      } else {
        await client.query(`
          UPDATE ${tabla} SET fecha_inicio = NOW(),
            estado_produccion_cat_idestado_produccion_cat = $1
          WHERE orden_produccion_idproduccion = $2
        `, [ESTADO_PROD.EN_PROCESO, idproduccion]);
      }
    }

    const estadoOrden = PROCESO_ESTADO[procesoActualCat] ?? ESTADO_PROD.EN_PROCESO;
    await client.query(
      `UPDATE orden_produccion SET idestado_produccion_cat = $1, proceso_actual = $2 WHERE idproduccion = $3`,
      [estadoOrden, procesoActualCat, idproduccion]
    );

    await client.query("COMMIT");
    return res.json({
      message: `Proceso ${tabla} iniciado`, idproduccion: Number(idproduccion),
      proceso_actual: procesoActualCat, tabla, estado_id: estadoOrden,
      maquina: procesoActualCat === PROCESO.IMPRESION ? maquina : undefined,
      repeticion: procesoActualCat === PROCESO.IMPRESION ? repeticion : undefined,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("INICIAR PROCESO ERROR:", error.message);
    return res.status(500).json({ error: "Error al iniciar proceso" });
  } finally { client.release(); }
};

// ============================================================
// POST /procesos/:idproduccion/avance
// ============================================================
export const registrarAvance = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { idproduccion } = req.params as { idproduccion: string };
    const { cantidad, observaciones, tabla_proceso } = req.body as {
      cantidad: number | string; observaciones?: string; tabla_proceso: string;
    };

    if (!cantidad || Number(cantidad) <= 0) {
      return res.status(400).json({ error: "La cantidad debe ser mayor a 0" });
    }

    const tablasValidas = ["extrusion", "impresion", "bolseo", "asa_flexible"];
    if (!tabla_proceso || !tablasValidas.includes(tabla_proceso)) {
      return res.status(400).json({ error: "Debes indicar el proceso válido (tabla_proceso)" });
    }

    await iniciarTx(req, client);

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

    const procesos = await getProcesosDeOrden(client, Number(idproduccion));

    const { rows: configOrdenRows } = await client.query(`
      SELECT cfg.por_kilo, sd.modo_cantidad
      FROM orden_produccion op
      JOIN solicitud_producto sp ON sp.idsolicitud_producto = op.idsolicitud_producto
      JOIN configuracion_plastico cfg ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN solicitud_detalle sd ON sd.solicitud_producto_id = sp.idsolicitud_producto AND sd.aprobado = true
      WHERE op.idproduccion = $1 LIMIT 1
    `, [idproduccion]);
    const porKiloAvance = configOrdenRows[0]?.por_kilo != null ? Number(configOrdenRows[0].por_kilo) : null;
    const modoOrdenAvance = (configOrdenRows[0]?.modo_cantidad ?? "unidad") as "unidad" | "kilo";

    const limiteAnterior = await getLimiteAvanceAnterior(client, Number(idproduccion), procesos, tabla_proceso, porKiloAvance, modoOrdenAvance);

    if (limiteAnterior !== null) {
      const { rows: acumRows } = await client.query(
        `SELECT COALESCE(SUM(cantidad), 0) AS total
     FROM avance_proceso
     WHERE orden_produccion_idproduccion = $1 AND tabla_proceso = $2`,
        [idproduccion, tabla_proceso]
      );

      const acumuladoActual = Number(acumRows[0]?.total ?? 0);
      const nuevaCantidad = Number(cantidad);
      const proyectado = acumuladoActual + nuevaCantidad;

      if (proyectado > limiteAnterior) {
        console.warn(
          `[AVISO] Sobreproducción detectada en ${tabla_proceso}. ` +
          `Límite: ${limiteAnterior}, proyectado: ${proyectado}`
        );
      }
    }

    const esProcesoPorKiloAvance =
      modoOrdenAvance === "kilo" &&
      (tabla_proceso === "bolseo" || tabla_proceso === "asa_flexible");

    const config = AVANCE_CONFIG[tabla_proceso];
    const unidad = esProcesoPorKiloAvance ? "kg" : (config?.unidad ?? "kg");

    const { rows: inserted } = await client.query(
      `INSERT INTO avance_proceso
         (orden_produccion_idproduccion, tabla_proceso, cantidad, unidad, observaciones, fecha_registro)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING idavance, cantidad, unidad, observaciones, fecha_registro`,
      [idproduccion, tabla_proceso, Number(cantidad), unidad, observaciones?.trim() || null]
    );

    // ── Marcar orden como parcialidad al registrar el primer avance ──────────
    await client.query(`
      UPDATE orden_produccion
      SET es_parcialidad = true
      WHERE idproduccion = $1
        AND es_parcialidad = false
    `, [idproduccion]);

    // Desbloquear siguiente proceso
    const procesoActualCat = Object.entries(PROCESO_TABLA).find(([, t]) => t === tabla_proceso)?.[0];
    const siguienteCat = procesoActualCat
      ? getSiguienteProceso(procesos, Number(procesoActualCat)) : null;

    if (siguienteCat !== null) {
      const tablaSiguiente = PROCESO_TABLA[siguienteCat];
      if (tablaSiguiente) {
        const { rows: sigExiste } = await client.query(
          `SELECT 1 FROM ${tablaSiguiente} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
        );
        if (sigExiste.length === 0) {
          await client.query(`
            INSERT INTO ${tablaSiguiente}
              (estado_produccion_cat_idestado_produccion_cat, orden_produccion_idproduccion, fecha_creacion, observaciones)
            VALUES ($1, $2, NOW(), NULL) ON CONFLICT DO NOTHING
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
    console.error("REGISTRAR AVANCE ERROR:", error.message);
    return res.status(500).json({ error: "Error al registrar avance" });
  } finally { client.release(); }
};

// ============================================================
// GET /procesos/:idproduccion/avances
// ============================================================
export const getAvancesProceso = async (req: Request, res: Response) => {
  try {
    const { idproduccion } = req.params as { idproduccion: string };
    const { tabla } = req.query as { tabla?: string };

    let query = `SELECT idavance, tabla_proceso, cantidad, unidad, observaciones, fecha_registro
                 FROM avance_proceso WHERE orden_produccion_idproduccion = $1`;
    const params: any[] = [idproduccion];

    if (tabla) { query += ` AND tabla_proceso = $2`; params.push(tabla); }
    query += ` ORDER BY fecha_registro ASC`;

    const { rows } = await pool.query(query, params);

    const totalPorTabla: Record<string, number> = {};
    for (const row of rows) {
      const t = row.tabla_proceso;
      totalPorTabla[t] = (totalPorTabla[t] ?? 0) + Number(row.cantidad ?? 0);
    }

    return res.json({ idproduccion: Number(idproduccion), avances: rows, totales: totalPorTabla });

  } catch (error: any) {
    console.error("GET AVANCES ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener avances" });
  }
};

// ============================================================
// PUT /procesos/:idproduccion/finalizar
// ============================================================
export const finalizarProceso = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { idproduccion } = req.params as { idproduccion: string };
    const datos = req.body;
    await iniciarTx(req, client);

    const procesos = await getProcesosDeOrden(client, Number(idproduccion));

    let procesoActualCat: number | null = null;

    if (datos.tabla_proceso) {
      const entry = Object.entries(PROCESO_TABLA).find(([, t]) => t === datos.tabla_proceso);
      if (entry) procesoActualCat = Number(entry[0]);
    }

    if (!procesoActualCat) {
      for (const cat of procesos) {
        const tabla = PROCESO_TABLA[cat];
        if (!tabla) continue;
        const { rows } = await client.query(
          `SELECT estado_produccion_cat_idestado_produccion_cat AS estado, fecha_inicio
           FROM ${tabla} WHERE orden_produccion_idproduccion = $1`,
          [idproduccion]
        );
        if (rows.length > 0 && rows[0].fecha_inicio) {
          const est = Number(rows[0].estado);
          if (est !== ESTADO_PROD.TERMINADO && est !== ESTADO_PROD.RESAGADO) {
            procesoActualCat = cat; break;
          }
        }
      }
    }

    if (!procesoActualCat) {
      let { procesoActualCat: fromOrden } = await getProcesoActualOrden(client, Number(idproduccion));
      if (fromOrden && !PROCESO_TABLA[fromOrden]) fromOrden = getSiguienteProceso(procesos, fromOrden);
      procesoActualCat = fromOrden;
    }

    if (!procesoActualCat) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No hay proceso activo en esta orden" });
    }

    const tabla = PROCESO_TABLA[procesoActualCat];
    if (!tabla) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: `Proceso ${procesoActualCat} no tiene tabla asociada` });
    }

    const { rows: procesoRows } = await client.query(
      `SELECT * FROM ${tabla} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
    );
    if (procesoRows.length === 0 || !procesoRows[0].fecha_inicio) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El proceso no ha sido iniciado aun" });
    }

    const anteriorTerminado = await procesoAnteriorEstaTerminado(client, Number(idproduccion), procesos, procesoActualCat);
    if (!anteriorTerminado) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El proceso anterior debe estar finalizado para poder finalizar este proceso" });
    }

    const campos = CAMPOS_PROCESO[tabla] ?? [];
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
      `UPDATE ${tabla} SET ${setClauses.join(", ")} WHERE orden_produccion_idproduccion = $${paramIdx}`,
      values
    );

    const siguienteProceso = getSiguienteProceso(procesos, procesoActualCat);

    if (siguienteProceso !== null) {
      const tablaSiguiente = PROCESO_TABLA[siguienteProceso];
      let metrosSiguiente: number | null = null;
      let kilosSiguiente: number | null = null;

      if (procesoActualCat === PROCESO.EXTRUSION) {
        metrosSiguiente = datos.metros_extruidos ? Number(datos.metros_extruidos) : null;
        kilosSiguiente = datos.k_para_impresion ? Number(datos.k_para_impresion) : null;
      } else if (procesoActualCat === PROCESO.IMPRESION) {
        metrosSiguiente = datos.metros_impresos ? Number(datos.metros_impresos) : null;
        kilosSiguiente = datos.kilos_impresos ? Number(datos.kilos_impresos) : null;
      }

      const { rows: sigExisteRows } = await client.query(
        `SELECT 1 FROM ${tablaSiguiente} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
      );
      const sigYaExiste = sigExisteRows.length > 0;

      if (tablaSiguiente === "impresion") {
        if (!sigYaExiste) {
          await client.query(`
            INSERT INTO impresion (estado_produccion_cat_idestado_produccion_cat, orden_produccion_idproduccion,
              fecha_creacion, metros_imprimir, kilos_imprimir, observaciones)
            VALUES ($1, $2, NOW(), $3, $4, NULL)
          `, [ESTADO_PROD.PENDIENTE, idproduccion, metrosSiguiente, kilosSiguiente]);
        } else {
          await client.query(`
            UPDATE impresion SET metros_imprimir = COALESCE($1, metros_imprimir),
              kilos_imprimir = COALESCE($2, kilos_imprimir) WHERE orden_produccion_idproduccion = $3
          `, [metrosSiguiente, kilosSiguiente, idproduccion]);
        }
      } else if (tablaSiguiente === "bolseo") {
        if (!sigYaExiste) {
          await client.query(`
            INSERT INTO bolseo (estado_produccion_cat_idestado_produccion_cat, orden_produccion_idproduccion,
              fecha_creacion, kilos_bolsear, observaciones)
            VALUES ($1, $2, NOW(), $3, NULL)
          `, [ESTADO_PROD.PENDIENTE, idproduccion, kilosSiguiente]);
        } else {
          await client.query(`
            UPDATE bolseo SET kilos_bolsear = COALESCE($1, kilos_bolsear)
            WHERE orden_produccion_idproduccion = $2
          `, [kilosSiguiente, idproduccion]);
        }
      } else if (tablaSiguiente === "asa_flexible") {
        const piezasRecibidas = datos.piezas_bolseadas ? Number(datos.piezas_bolseadas) : null;
        const kilosRecibidos = datos.kilos_bolseados ? Number(datos.kilos_bolseados) : null;

        if (!sigYaExiste) {
          await client.query(`
            INSERT INTO asa_flexible (
              estado_produccion_cat_idestado_produccion_cat,
              orden_produccion_idproduccion,
              fecha_creacion,
              piezas_recibidas,
              kilos_recibidos,
              observaciones
            )
            VALUES ($1, $2, NOW(), $3, $4, NULL)
          `, [ESTADO_PROD.PENDIENTE, idproduccion, piezasRecibidas, kilosRecibidos]);
        } else {
          await client.query(`
            UPDATE asa_flexible
            SET piezas_recibidas = COALESCE($1, piezas_recibidas),
                kilos_recibidos  = COALESCE($2, kilos_recibidos)
            WHERE orden_produccion_idproduccion = $3
          `, [piezasRecibidas, kilosRecibidos, idproduccion]);
        }
      } else {
        if (!sigYaExiste) {
          await client.query(`
            INSERT INTO ${tablaSiguiente} (estado_produccion_cat_idestado_produccion_cat, orden_produccion_idproduccion,
              fecha_creacion, observaciones)
            VALUES ($1, $2, NOW(), NULL)
          `, [ESTADO_PROD.PENDIENTE, idproduccion]);
        }
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
      message: `Proceso ${tabla} finalizado`, idproduccion: Number(idproduccion),
      proceso_terminado: procesoActualCat, siguiente_proceso: siguienteProceso,
      orden_completada: siguienteProceso === null,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("FINALIZAR PROCESO ERROR:", error.message);
    return res.status(500).json({ error: "Error al finalizar proceso" });
  } finally { client.release(); }
};

// ============================================================
// PUT /procesos/:idproduccion/resagar
// ============================================================
export const resagarProceso = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { idproduccion } = req.params as { idproduccion: string };
    await iniciarTx(req, client);

    const { procesoActualCat } = await getProcesoActualOrden(client, Number(idproduccion));
    if (!procesoActualCat) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No hay proceso activo" });
    }

    const tabla = PROCESO_TABLA[procesoActualCat];
    if (!tabla) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Proceso sin tabla asociada" });
    }

    await client.query(
      `UPDATE ${tabla} SET estado_produccion_cat_idestado_produccion_cat = $1 WHERE orden_produccion_idproduccion = $2`,
      [ESTADO_PROD.RESAGADO, idproduccion]
    );
    await client.query(
      `UPDATE orden_produccion SET idestado_produccion_cat = $1 WHERE idproduccion = $2`,
      [ESTADO_PROD.RESAGADO, idproduccion]
    );

    await client.query("COMMIT");
    return res.json({ message: "Proceso marcado como resagado", idproduccion: Number(idproduccion), tabla });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("RESAGAR PROCESO ERROR:", error.message);
    return res.status(500).json({ error: "Error al resagar proceso" });
  } finally { client.release(); }
};

// ============================================================
// PUT /procesos/:idproduccion/editar/:tabla
// ============================================================
export const editarProceso = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { idproduccion, tabla } = req.params as { idproduccion: string; tabla: string };
    const datos = req.body;

    const tablasValidas = ["extrusion", "impresion", "bolseo", "asa_flexible"];
    if (!tablasValidas.includes(tabla)) {
      return res.status(400).json({ error: `Tabla invalida: ${tabla}` });
    }

    await iniciarTx(req, client);

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

    const campos = CAMPOS_PROCESO[tabla] ?? [];
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
    if (tabla === "impresion" && datos.maquina !== undefined) {
      const maquinaCompleta = datos.repeticion ? `${datos.maquina} | ${datos.repeticion}` : datos.maquina;
      setClauses.push(`maquina = $${paramIdx}`); values.push(maquinaCompleta); paramIdx++;
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

    if (tabla === "extrusion") {
      const kilosSig = datos.k_para_impresion !== undefined ? datos.k_para_impresion : null;
      const metrosSig = datos.metros_extruidos !== undefined ? datos.metros_extruidos : null;
      if (kilosSig !== null || metrosSig !== null) {
        const ic: string[] = []; const iv: any[] = []; let ii = 1;
        if (kilosSig !== null) { ic.push(`kilos_imprimir = $${ii++}`); iv.push(kilosSig); }
        if (metrosSig !== null) { ic.push(`metros_imprimir = $${ii++}`); iv.push(metrosSig); }
        iv.push(idproduccion);
        await client.query(`UPDATE impresion SET ${ic.join(", ")} WHERE orden_produccion_idproduccion = $${ii}`, iv);
      }
    } else if (tabla === "impresion") {
      if (datos.kilos_impresos != null && datos.kilos_impresos !== "") {
        await client.query(
          `UPDATE bolseo SET kilos_bolsear = $1 WHERE orden_produccion_idproduccion = $2`,
          [datos.kilos_impresos, idproduccion]
        );
      }
    } else if (tabla === "bolseo") {
      const updates: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (datos.piezas_bolseadas != null && datos.piezas_bolseadas !== "") {
        updates.push(`piezas_recibidas = $${idx++}`);
        params.push(datos.piezas_bolseadas);
      }

      if (datos.kilos_bolseados != null && datos.kilos_bolseados !== "") {
        updates.push(`kilos_recibidos = $${idx++}`);
        params.push(datos.kilos_bolseados);
      }

      if (updates.length > 0) {
        params.push(idproduccion);
        await client.query(
          `UPDATE asa_flexible SET ${updates.join(", ")} WHERE orden_produccion_idproduccion = $${idx}`,
          params
        );
      }
    }

    await client.query("COMMIT");
    return res.json({ message: `Proceso ${tabla} actualizado`, idproduccion: Number(idproduccion), tabla });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("EDITAR PROCESO ERROR:", error.message);
    return res.status(500).json({ error: "Error al editar proceso" });
  } finally { client.release(); }
};