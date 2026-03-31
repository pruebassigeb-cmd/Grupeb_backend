import { Request, Response } from "express";
import { pool } from "../../config/db";

const ESTADO_PROD = {
  PENDIENTE:       1,
  EN_PROCESO:      2,
  TERMINADO:       3,
  RESAGADO:        4,
  NO_APLICA:       5,
  EN_EXTRUSION:    6,
  EN_IMPRESION:    7,
  EN_BOLSEO:       8,
  EN_TROQUELADO:   9,
  EN_ASA_FLEXIBLE: 10,
} as const;

const PROCESO = {
  EXTRUSION:    1,
  IMPRESION:    2,
  ASA_FLEXIBLE: 3,
  TROQUELADO:   4,
  BOLSEO:       5,
} as const;

const ORDEN_PROCESOS = [1, 2, 5, 3, 4];

const PROCESO_TABLA: Record<number, string> = {
  [PROCESO.EXTRUSION]:    "extrusion",
  [PROCESO.IMPRESION]:    "impresion",
  [PROCESO.BOLSEO]:       "bolseo",
  [PROCESO.ASA_FLEXIBLE]: "asa_flexible",
};

const PROCESO_ESTADO: Record<number, number> = {
  [PROCESO.EXTRUSION]:    ESTADO_PROD.EN_EXTRUSION,
  [PROCESO.IMPRESION]:    ESTADO_PROD.EN_IMPRESION,
  [PROCESO.BOLSEO]:       ESTADO_PROD.EN_BOLSEO,
  [PROCESO.ASA_FLEXIBLE]: ESTADO_PROD.EN_ASA_FLEXIBLE,
};

const CAMPOS_PROCESO: Record<string, string[]> = {
  extrusion:    ["kilos_extruir", "metros_extruir", "merma", "k_para_impresion", "metros_extruidos"],
  impresion:    ["kilos_imprimir", "metros_imprimir", "merma", "kilos_impresos", "metros_impresos"],
  bolseo:       ["kilos_bolsear", "kilos_bolseados", "kilos_merma", "piezas_bolseadas", "piezas_merma"],
  asa_flexible: ["pzas_finales", "merma", "piezas_recibidas"],
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
    console.log(`Proceso cat ${candidato} sin tabla, saltando...`);
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
    estadoOrden:      rows[0].idestado_produccion_cat,
  };
}

export async function inicializarPrimerProceso(client: any, idproduccion: number): Promise<void> {
  const procesos = await getProcesosDeOrden(client, idproduccion);
  const primero  = procesos.find(p => PROCESO_TABLA[p] !== undefined) ?? null;
  if (primero !== null) {
    await client.query(
      `UPDATE orden_produccion SET proceso_actual = $1 WHERE idproduccion = $2`,
      [primero, idproduccion]
    );
  }
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
        op.repeticion_kidder,
        op.repeticion_sicosa
      FROM orden_produccion op
      JOIN estado_produccion_cat ep ON ep.idestado_produccion_cat = op.idestado_produccion_cat
      JOIN solicitud_producto sp    ON sp.idsolicitud_producto    = op.idsolicitud_producto
      JOIN configuracion_plastico cfg
          ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      JOIN solicitud s ON s.idsolicitud = op.idsolicitud
      WHERE op.idproduccion = $1
    `, [idproduccion]);

    if (ordenRows.length === 0)
      return res.status(404).json({ error: "Orden no encontrada" });

    const orden  = ordenRows[0];
    const idtipo = orden.idtipo_producto;

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
          idproceso_cat:  p.idproceso_cat,
          nombre_proceso: p.nombre_proceso,
          tabla:          null,
          registro:       null,
          estado:         "no_aplica",
          observaciones:  null,
        };
      }

      const { rows: regRows } = await pool.query(
        `SELECT * FROM ${tabla} WHERE orden_produccion_idproduccion = $1`,
        [idproduccion]
      );

      const registro = regRows[0] ?? null;
      let estado = "pendiente";

      if (registro) {
        const est = Number(registro.estado_produccion_cat_idestado_produccion_cat);
        if      (est === ESTADO_PROD.TERMINADO)              estado = "terminado";
        else if (est === ESTADO_PROD.RESAGADO)               estado = "resagado";
        else if (est === ESTADO_PROD.EN_PROCESO || est >= 6) estado = "en_proceso";
        else                                                  estado = "pendiente";
      }

      return {
        idproceso_cat:  p.idproceso_cat,
        nombre_proceso: p.nombre_proceso,
        tabla,
        registro,
        estado,
        observaciones: registro?.observaciones || null,
      };
    }));

    const procesosConObsAnteriores = procesosConRegistros.map((proceso, index) => {
      let observacionesProcesoAnterior = null;
      if (index > 0) {
        const procesoAnterior = procesosConRegistros[index - 1];
        observacionesProcesoAnterior = procesoAnterior?.observaciones || null;
      }
      return { ...proceso, observaciones_proceso_anterior: observacionesProcesoAnterior };
    });

    let procesoActual = orden.proceso_actual;
    if (procesoActual && !PROCESO_TABLA[procesoActual]) {
      const todosProcesos = procesosRows.map((p: any) => Number(p.idproceso_cat));
      procesoActual = getSiguienteProceso(todosProcesos, procesoActual);
    }

    return res.json({
      idproduccion:      Number(idproduccion),
      no_produccion:     orden.no_produccion,
      no_pedido:         orden.no_pedido,
      proceso_actual:    procesoActual,
      estado_id:         orden.idestado_produccion_cat,
      estado_nombre:     orden.estado_nombre,
      repeticion_kidder: orden.repeticion_kidder ?? null,
      repeticion_sicosa: orden.repeticion_sicosa ?? null,
      procesos:          procesosConObsAnteriores,
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

    await client.query("BEGIN");

    let { procesoActualCat } = await getProcesoActualOrden(client, Number(idproduccion));

    if (procesoActualCat && !PROCESO_TABLA[procesoActualCat]) {
      const procesos = await getProcesosDeOrden(client, Number(idproduccion));
      procesoActualCat = getSiguienteProceso(procesos, procesoActualCat);
      if (procesoActualCat) {
        await client.query(
          `UPDATE orden_produccion SET proceso_actual = $1 WHERE idproduccion = $2`,
          [procesoActualCat, idproduccion]
        );
      }
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

    if (procesoActualCat === PROCESO.IMPRESION) {
      if (!maquina || !MAQUINAS_IMPRESION.includes(maquina as MaquinaImpresion)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Debes seleccionar una maquina de impresion: kidder o sicosa" });
      }
    }

    const { rows: existeRows } = await client.query(
      `SELECT * FROM ${tabla} WHERE orden_produccion_idproduccion = $1`,
      [idproduccion]
    );

    if (procesoActualCat === PROCESO.EXTRUSION) {
      const { rows: ordenMermaRows } = await client.query(`
        SELECT kilos_merma, metros_merma FROM orden_produccion WHERE idproduccion = $1
      `, [idproduccion]);

      const kilos_extruir  = ordenMermaRows[0]?.kilos_merma  ?? null;
      const metros_extruir = ordenMermaRows[0]?.metros_merma ?? null;

      if (existeRows.length === 0) {
        await client.query(`
          INSERT INTO extrusion (
            estado_produccion_cat_idestado_produccion_cat,
            orden_produccion_idproduccion,
            fecha_creacion, fecha_inicio,
            metros_extruir, kilos_extruir,
            observaciones
          ) VALUES ($1, $2, NOW(), NOW(), $3, $4, NULL)
        `, [ESTADO_PROD.EN_PROCESO, idproduccion, metros_extruir, kilos_extruir]);
      } else if (!existeRows[0].fecha_inicio) {
        await client.query(`
          UPDATE extrusion
          SET fecha_inicio  = NOW(),
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
          INSERT INTO impresion (
            estado_produccion_cat_idestado_produccion_cat,
            orden_produccion_idproduccion,
            fecha_creacion, fecha_inicio,
            maquina, observaciones
          ) VALUES ($1, $2, NOW(), NOW(), $3, NULL)
        `, [ESTADO_PROD.EN_PROCESO, idproduccion, maquinaCompleta]);
      } else if (!existeRows[0].fecha_inicio) {
        await client.query(`
          UPDATE impresion
          SET fecha_inicio = NOW(),
              estado_produccion_cat_idestado_produccion_cat = $1,
              maquina = $2
          WHERE orden_produccion_idproduccion = $3
        `, [ESTADO_PROD.EN_PROCESO, maquinaCompleta, idproduccion]);
      }

    } else {
      if (existeRows.length === 0) {
        await client.query(`
          INSERT INTO ${tabla} (
            estado_produccion_cat_idestado_produccion_cat,
            orden_produccion_idproduccion,
            fecha_creacion, fecha_inicio,
            observaciones
          ) VALUES ($1, $2, NOW(), NOW(), NULL)
        `, [ESTADO_PROD.EN_PROCESO, idproduccion]);
      } else if (!existeRows[0].fecha_inicio) {
        await client.query(`
          UPDATE ${tabla}
          SET fecha_inicio = NOW(),
              estado_produccion_cat_idestado_produccion_cat = $1
          WHERE orden_produccion_idproduccion = $2
        `, [ESTADO_PROD.EN_PROCESO, idproduccion]);
      }
    }

    const estadoOrden = PROCESO_ESTADO[procesoActualCat] ?? ESTADO_PROD.EN_PROCESO;
    await client.query(
      `UPDATE orden_produccion SET idestado_produccion_cat = $1 WHERE idproduccion = $2`,
      [estadoOrden, idproduccion]
    );

    await client.query("COMMIT");

    return res.json({
      message:        `Proceso ${tabla} iniciado`,
      idproduccion:   Number(idproduccion),
      proceso_actual: procesoActualCat,
      tabla,
      estado_id:      estadoOrden,
      maquina:        procesoActualCat === PROCESO.IMPRESION ? maquina    : undefined,
      repeticion:     procesoActualCat === PROCESO.IMPRESION ? repeticion : undefined,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("INICIAR PROCESO ERROR:", error.message);
    return res.status(500).json({ error: "Error al iniciar proceso" });
  } finally {
    client.release();
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
    await client.query("BEGIN");

    const procesos = await getProcesosDeOrden(client, Number(idproduccion));
    let { procesoActualCat } = await getProcesoActualOrden(client, Number(idproduccion));

    if (procesoActualCat && !PROCESO_TABLA[procesoActualCat]) {
      procesoActualCat = getSiguienteProceso(procesos, procesoActualCat);
      if (procesoActualCat) {
        await client.query(
          `UPDATE orden_produccion SET proceso_actual = $1 WHERE idproduccion = $2`,
          [procesoActualCat, idproduccion]
        );
      }
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
      `SELECT * FROM ${tabla} WHERE orden_produccion_idproduccion = $1`,
      [idproduccion]
    );

    if (procesoRows.length === 0 || !procesoRows[0].fecha_inicio) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El proceso no ha sido iniciado aun" });
    }

    const campos     = CAMPOS_PROCESO[tabla] ?? [];
    const setClauses = ["fecha_fin = NOW()", "estado_produccion_cat_idestado_produccion_cat = $1"];
    const values: any[] = [ESTADO_PROD.TERMINADO];
    let paramIdx = 2;

    for (const campo of campos) {
      if (datos[campo] !== undefined && datos[campo] !== null) {
        setClauses.push(`${campo} = $${paramIdx}`);
        values.push(datos[campo]);
        paramIdx++;
      }
    }

    if (datos.observaciones !== undefined) {
      setClauses.push(`observaciones = $${paramIdx}`);
      values.push(datos.observaciones);
      paramIdx++;
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
      let kilosSiguiente:  number | null = null;

      if (procesoActualCat === PROCESO.EXTRUSION) {
        metrosSiguiente = datos.metros_extruidos  ? Number(datos.metros_extruidos)  : null;
        kilosSiguiente  = datos.k_para_impresion  ? Number(datos.k_para_impresion)  : null;
      } else if (procesoActualCat === PROCESO.IMPRESION) {
        metrosSiguiente = datos.metros_impresos   ? Number(datos.metros_impresos)   : null;
        kilosSiguiente  = datos.kilos_impresos    ? Number(datos.kilos_impresos)    : null;
      }

      if (tablaSiguiente === "impresion") {
        await client.query(`
          INSERT INTO impresion (
            estado_produccion_cat_idestado_produccion_cat,
            orden_produccion_idproduccion,
            fecha_creacion, metros_imprimir, kilos_imprimir, observaciones
          ) VALUES ($1, $2, NOW(), $3, $4, NULL)
          ON CONFLICT DO NOTHING
        `, [ESTADO_PROD.PENDIENTE, idproduccion, metrosSiguiente, kilosSiguiente]);

      } else if (tablaSiguiente === "bolseo") {
        await client.query(`
          INSERT INTO bolseo (
            estado_produccion_cat_idestado_produccion_cat,
            orden_produccion_idproduccion,
            fecha_creacion, kilos_bolsear, observaciones
          ) VALUES ($1, $2, NOW(), $3, NULL)
          ON CONFLICT DO NOTHING
        `, [ESTADO_PROD.PENDIENTE, idproduccion, kilosSiguiente]);

      } else if (tablaSiguiente === "asa_flexible") {
        const piezasRecibidas = datos.piezas_bolseadas ? Number(datos.piezas_bolseadas) : null;
        await client.query(`
          INSERT INTO asa_flexible (
            estado_produccion_cat_idestado_produccion_cat,
            orden_produccion_idproduccion,
            fecha_creacion, piezas_recibidas, observaciones
          ) VALUES ($1, $2, NOW(), $3, NULL)
          ON CONFLICT DO NOTHING
        `, [ESTADO_PROD.PENDIENTE, idproduccion, piezasRecibidas]);

      } else {
        await client.query(`
          INSERT INTO ${tablaSiguiente} (
            estado_produccion_cat_idestado_produccion_cat,
            orden_produccion_idproduccion,
            fecha_creacion, observaciones
          ) VALUES ($1, $2, NOW(), NULL)
          ON CONFLICT DO NOTHING
        `, [ESTADO_PROD.PENDIENTE, idproduccion]);
      }

      await client.query(`
        UPDATE orden_produccion
        SET proceso_actual = $1, idestado_produccion_cat = $2
        WHERE idproduccion = $3
      `, [siguienteProceso, ESTADO_PROD.PENDIENTE, idproduccion]);

    } else {
      await client.query(`
        UPDATE orden_produccion
        SET idestado_produccion_cat = $1, proceso_actual = NULL
        WHERE idproduccion = $2
      `, [ESTADO_PROD.TERMINADO, idproduccion]);
    }

    await client.query("COMMIT");

    return res.json({
      message:           `Proceso ${tabla} finalizado`,
      idproduccion:      Number(idproduccion),
      proceso_terminado: procesoActualCat,
      siguiente_proceso: siguienteProceso,
      orden_completada:  siguienteProceso === null,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("FINALIZAR PROCESO ERROR:", error.message);
    return res.status(500).json({ error: "Error al finalizar proceso" });
  } finally {
    client.release();
  }
};

// ============================================================
// PUT /procesos/:idproduccion/resagar
// ============================================================
export const resagarProceso = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { idproduccion } = req.params as { idproduccion: string };
    await client.query("BEGIN");

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

    await client.query(`
      UPDATE ${tabla}
      SET estado_produccion_cat_idestado_produccion_cat = $1
      WHERE orden_produccion_idproduccion = $2
    `, [ESTADO_PROD.RESAGADO, idproduccion]);

    await client.query(
      `UPDATE orden_produccion SET idestado_produccion_cat = $1 WHERE idproduccion = $2`,
      [ESTADO_PROD.RESAGADO, idproduccion]
    );

    await client.query("COMMIT");

    return res.json({
      message:      "Proceso marcado como resagado",
      idproduccion: Number(idproduccion),
      tabla,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("RESAGAR PROCESO ERROR:", error.message);
    return res.status(500).json({ error: "Error al resagar proceso" });
  } finally {
    client.release();
  }
};

// ============================================================
// PUT /procesos/:idproduccion/editar/:tabla
// Edita los datos de un proceso YA TERMINADO y propaga
// los cambios al siguiente proceso si ya fue creado
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

    await client.query("BEGIN");

    const { rows: procesoRows } = await client.query(
      `SELECT * FROM ${tabla} WHERE orden_produccion_idproduccion = $1`,
      [idproduccion]
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
      setClauses.push(`observaciones = $${paramIdx}`);
      values.push(datos.observaciones || null);
      paramIdx++;
    }

    if (tabla === "impresion" && datos.maquina !== undefined) {
      const maquinaCompleta = datos.repeticion
        ? `${datos.maquina} | ${datos.repeticion}`
        : datos.maquina;
      setClauses.push(`maquina = $${paramIdx}`);
      values.push(maquinaCompleta);
      paramIdx++;
    }

    if (datos.fecha_inicio !== undefined) {
      setClauses.push(`fecha_inicio = $${paramIdx}`);
      values.push(datos.fecha_inicio || null);
      paramIdx++;
    }

    if (datos.fecha_fin !== undefined) {
      setClauses.push(`fecha_fin = $${paramIdx}`);
      values.push(datos.fecha_fin || null);
      paramIdx++;
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

    // ── Propagar cambios al siguiente proceso ──────────────
    if (tabla === "extrusion") {
      // extrusion → impresion: kilos_imprimir y metros_imprimir
      const kilosSiguiente  = datos.k_para_impresion !== undefined ? datos.k_para_impresion  : null;
      const metrosSiguiente = datos.metros_extruidos !== undefined ? datos.metros_extruidos  : null;

      if (kilosSiguiente !== null || metrosSiguiente !== null) {
        const impClauses: string[] = [];
        const impValues:  any[]    = [];
        let   impIdx = 1;

        if (kilosSiguiente !== null) {
          impClauses.push(`kilos_imprimir = $${impIdx++}`);
          impValues.push(kilosSiguiente);
        }
        if (metrosSiguiente !== null) {
          impClauses.push(`metros_imprimir = $${impIdx++}`);
          impValues.push(metrosSiguiente);
        }

        impValues.push(idproduccion);
        await client.query(
          `UPDATE impresion SET ${impClauses.join(", ")}
           WHERE orden_produccion_idproduccion = $${impIdx}`,
          impValues
        );
      }

    } else if (tabla === "impresion") {
      // impresion → bolseo: kilos_bolsear
      if (datos.kilos_impresos !== undefined && datos.kilos_impresos !== null && datos.kilos_impresos !== "") {
        await client.query(
          `UPDATE bolseo SET kilos_bolsear = $1
           WHERE orden_produccion_idproduccion = $2`,
          [datos.kilos_impresos, idproduccion]
        );
      }

    } else if (tabla === "bolseo") {
      // bolseo → asa_flexible: piezas_recibidas
      if (datos.piezas_bolseadas !== undefined && datos.piezas_bolseadas !== null && datos.piezas_bolseadas !== "") {
        await client.query(
          `UPDATE asa_flexible SET piezas_recibidas = $1
           WHERE orden_produccion_idproduccion = $2`,
          [datos.piezas_bolseadas, idproduccion]
        );
      }
    }
    // ── fin propagación ────────────────────────────────────

    await client.query("COMMIT");

    return res.json({
      message:      `Proceso ${tabla} actualizado`,
      idproduccion: Number(idproduccion),
      tabla,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("EDITAR PROCESO ERROR:", error.message);
    return res.status(500).json({ error: "Error al editar proceso" });
  } finally {
    client.release();
  }
};