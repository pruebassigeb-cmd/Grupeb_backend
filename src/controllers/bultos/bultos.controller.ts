import { Request, Response } from "express";
import { pool } from "../../config/db";

// ─────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────
type ProcesoOrigen = "bolseo" | "asa_flexible" | "empaque_papel";

interface FkBulto {
  tipo: ProcesoOrigen;
  id:   number;
}

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

// ─────────────────────────────────────────────
// HELPER — resuelve qué FK usar
// ─────────────────────────────────────────────
async function resolverFkBulto(idproduccion: number): Promise<FkBulto | null> {
  const { rows: empaqueRows } = await pool.query(
    `SELECT idempaque_papel FROM empaque_papel WHERE orden_produccion_idproduccion = $1`,
    [idproduccion]
  );
  if (empaqueRows.length > 0) {
    return {
      tipo: "empaque_papel",
      id: Number(empaqueRows[0].idempaque_papel),
    };
  }

  const { rows: asaRows } = await pool.query(
    `SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = $1`,
    [idproduccion]
  );
  if (asaRows.length > 0) {
    return { tipo: "asa_flexible", id: Number(asaRows[0].idasa_flexible) };
  }
  const { rows: bolRows } = await pool.query(
    `SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = $1`,
    [idproduccion]
  );
  if (bolRows.length > 0) {
    return { tipo: "bolseo", id: Number(bolRows[0].idbolseo) };
  }
  return null;
}

// ─────────────────────────────────────────────
// HELPER — obtiene modo_cantidad de la orden
// ─────────────────────────────────────────────
async function getModoOrden(idproduccion: number): Promise<"unidad" | "kilo"> {
  const { rows } = await pool.query(`
    SELECT sd.modo_cantidad
    FROM orden_produccion op
    JOIN solicitud_producto sp ON sp.idsolicitud_producto = op.idsolicitud_producto
    JOIN solicitud_detalle sd  ON sd.solicitud_producto_id = sp.idsolicitud_producto
                               AND sd.aprobado = true
    WHERE op.idproduccion = $1
    LIMIT 1
  `, [idproduccion]);
  return (rows[0]?.modo_cantidad === "kilo") ? "kilo" : "unidad";
}

// ─────────────────────────────────────────────
// HELPER — valida estado de orden y proceso final
// ─────────────────────────────────────────────
function validarEstadoOrden(ordenRow: any): string | null {
  const estadoOrden       = Number(ordenRow.idestado_produccion_cat);
  const procesoActual     = ordenRow.proceso_actual;
  const bultosFinalizados = Boolean(ordenRow.bultos_finalizado);

  const ordenTerminada    = estadoOrden === ESTADO_PROD.TERMINADO && procesoActual === null;
  const esEmpaquePapel     = ordenRow.tipo_material === "papel";
  const esProcesosFinales =
    Number(procesoActual) === PROCESO.BOLSEO ||
    Number(procesoActual) === PROCESO.ASA_FLEXIBLE ||
    esEmpaquePapel;

  if (!ordenTerminada && !esProcesosFinales) {
    return "La orden debe estar en el último proceso de producción para registrar bultos";
  }
  if (bultosFinalizados) {
    return "Los bultos de esta orden ya fueron finalizados. No se pueden agregar más.";
  }
  return null;
}

// ─────────────────────────────────────────────
// HELPER — calcula límite disponible y empacado
// ─────────────────────────────────────────────
async function calcularLimiteYEmpacado(
  idproduccion: number,
  fk: FkBulto,
  modoOrden: "unidad" | "kilo"
): Promise<{ limiteDisponible: number | null; totalEmpacado: number }> {
  const tablaProceso = fk.tipo;
  const campoFinal = tablaProceso === "empaque_papel"
    ? "bolsas_entregadas_final"
    : modoOrden === "kilo"
      ? (tablaProceso === "bolseo" ? "kilos_bolseados" : "kilos_finales")
      : (tablaProceso === "bolseo" ? "piezas_bolseadas" : "pzas_finales");

  const { rows: procesoRows } = await pool.query(
    `SELECT estado_produccion_cat_idestado_produccion_cat AS estado, ${campoFinal} AS campo_final
     FROM ${tablaProceso} WHERE orden_produccion_idproduccion = $1`,
    [idproduccion]
  );

  let limiteDisponible: number | null = null;
  if (procesoRows.length > 0) {
    const estProc = Number(procesoRows[0].estado);
    if (estProc === ESTADO_PROD.TERMINADO) {
      const v = procesoRows[0].campo_final;
      limiteDisponible = v != null ? Number(v) : null;
    } else {
      const { rows: avRows } = await pool.query(
        `SELECT COALESCE(SUM(cantidad), 0) AS total
         FROM avance_proceso
         WHERE orden_produccion_idproduccion = $1 AND tabla_proceso = $2`,
        [idproduccion, tablaProceso]
      );
      const totalAv = Number(avRows[0]?.total ?? 0);
      limiteDisponible = totalAv > 0 ? totalAv : null;
    }
  }

  const { rows: totalBultosRows } = await pool.query(
    `SELECT COALESCE(SUM(${modoOrden === "kilo" ? "peso_producto" : "cantidad_unidades"}), 0) AS total
     FROM bultos b
     WHERE
       b.bolseo_idbolseo IN (SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = $1)
       OR b.asa_flexible_idasa_flexible IN (SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = $1)
       OR b.empaque_papel_idempaque_papel IN (SELECT idempaque_papel FROM empaque_papel WHERE orden_produccion_idproduccion = $1)`,
    [idproduccion]
  );
  const totalEmpacado = Number(totalBultosRows[0]?.total ?? 0);

  return { limiteDisponible, totalEmpacado };
}

// ─────────────────────────────────────────────
// GET /api/seguimiento/:idproduccion/bultos
// ─────────────────────────────────────────────
export const getBultos = async (req: Request, res: Response): Promise<Response> => {
  try {
    const idproduccion = Number(req.params.idproduccion);

    const { rows: ordenRows } = await pool.query(
      `SELECT bultos_finalizado FROM orden_produccion WHERE idproduccion = $1`,
      [idproduccion]
    );
    if (ordenRows.length === 0) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    const bultos_finalizado = Boolean(ordenRows[0].bultos_finalizado);
    const modoOrden = await getModoOrden(idproduccion);

    const { rows } = await pool.query(
      `SELECT
         b.idbulto,
         b.cantidad_unidades,
         b.fecha_creacion,
         b.peso_producto,
         b.peso,
         b.alto,
         b.largo,
         b.ancho,
         b.numero_parcialidad,
         CASE
           WHEN b.bolseo_idbolseo             IS NOT NULL THEN 'bolseo'
           WHEN b.asa_flexible_idasa_flexible IS NOT NULL THEN 'asa_flexible'
           WHEN b.empaque_papel_idempaque_papel IS NOT NULL THEN 'empaque_papel'
         END AS proceso_origen
       FROM bultos b
       WHERE
         b.bolseo_idbolseo IN (
           SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = $1
         )
         OR
         b.asa_flexible_idasa_flexible IN (
           SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = $1
         )
         OR
         b.empaque_papel_idempaque_papel IN (
           SELECT idempaque_papel FROM empaque_papel WHERE orden_produccion_idproduccion = $1
         )
       ORDER BY b.idbulto ASC`,
      [idproduccion]
    );

    const total_unidades = rows.reduce((sum: number, r: any) => sum + Number(r.cantidad_unidades ?? 0), 0);
    const total_kg       = rows.reduce((sum: number, r: any) => sum + Number(r.peso_producto ?? 0), 0);

    return res.json({
      bultos_finalizado,
      modo_cantidad: modoOrden,
      bultos: rows.map((r: any) => ({
        idbulto:             Number(r.idbulto),
        cantidad_unidades:   Number(r.cantidad_unidades),
        fecha_creacion:      r.fecha_creacion,
        proceso_origen:      r.proceso_origen as ProcesoOrigen,
        numero_parcialidad:  r.numero_parcialidad != null ? Number(r.numero_parcialidad) : null,
        peso_producto: r.peso_producto != null ? Number(r.peso_producto) : null,
        peso:  r.peso  != null ? Number(r.peso)  : null,
        alto:  r.alto  != null ? Number(r.alto)  : null,
        largo: r.largo != null ? Number(r.largo) : null,
        ancho: r.ancho != null ? Number(r.ancho) : null,
      })),
      total_bultos:   rows.length,
      total_unidades,
      total_kg: Math.round(total_kg * 100) / 100,
    });
  } catch (error: any) {
    console.error("❌ GET BULTOS ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener bultos" });
  }
};

// ─────────────────────────────────────────────
// POST /api/seguimiento/:idproduccion/bultos
// ─────────────────────────────────────────────
export const agregarBulto = async (req: Request, res: Response): Promise<Response> => {
  try {
    const idproduccion = Number(req.params.idproduccion);

    const cantidad_unidades = req.body.cantidad_unidades != null ? Number(req.body.cantidad_unidades) : null;
    const peso_producto     = req.body.peso_producto     != null ? Number(req.body.peso_producto)     : null;
    const peso              = req.body.peso              != null ? Number(req.body.peso)              : null;
    const alto              = req.body.alto              != null ? Number(req.body.alto)              : null;
    const largo             = req.body.largo             != null ? Number(req.body.largo)             : null;
    const ancho             = req.body.ancho             != null ? Number(req.body.ancho)             : null;

    const { rows: ordenRows } = await pool.query(
      `SELECT op.idestado_produccion_cat, op.proceso_actual,
              op.bultos_finalizado, sp.tipo_material
       FROM orden_produccion op
       JOIN solicitud_producto sp
         ON sp.idsolicitud_producto = op.idsolicitud_producto
       WHERE op.idproduccion = $1`,
      [idproduccion]
    );
    if (ordenRows.length === 0) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    const errorEstado = validarEstadoOrden(ordenRows[0]);
    if (errorEstado) return res.status(400).json({ error: errorEstado });

    const modoOrden = await getModoOrden(idproduccion);

    if (modoOrden === "kilo") {
      if (!peso_producto || peso_producto <= 0) {
        return res.status(400).json({ error: "El peso del producto es requerido y debe ser mayor a 0" });
      }
    } else {
      if (!cantidad_unidades || cantidad_unidades <= 0) {
        return res.status(400).json({ error: "La cantidad de unidades debe ser mayor a 0" });
      }
    }

    const fk = await resolverFkBulto(idproduccion);
    if (!fk) {
      return res.status(404).json({
        error: "No existe registro de bolseo ni asa_flexible para esta orden",
      });
    }

    const { limiteDisponible, totalEmpacado } = await calcularLimiteYEmpacado(idproduccion, fk, modoOrden);
    if (limiteDisponible !== null) {
      const valorNuevo = modoOrden === "kilo" ? (peso_producto ?? 0) : (cantidad_unidades ?? 0);
      const proyectado = totalEmpacado + valorNuevo;
      const unidad     = modoOrden === "kilo" ? "kg" : "pzas";

      if (proyectado > limiteDisponible) {
        const restante = Math.max(limiteDisponible - totalEmpacado, 0);
        return res.status(400).json({
          error: `No puedes empacar más de lo producido. ` +
                 `Límite: ${limiteDisponible.toLocaleString("es-MX")} ${unidad}. ` +
                 `Ya empacaste ${totalEmpacado.toLocaleString("es-MX")} ${unidad}, ` +
                 `puedes registrar hasta ${restante.toLocaleString("es-MX")} ${unidad} más.`,
          limite:    limiteDisponible,
          empacado:  totalEmpacado,
          restante,
        });
      }
    }

    const columnaFk =
      fk.tipo === "bolseo"
        ? "bolseo_idbolseo"
        : fk.tipo === "asa_flexible"
          ? "asa_flexible_idasa_flexible"
          : "empaque_papel_idempaque_papel";

    const { rows: inserted } = await pool.query(
      `INSERT INTO bultos (${columnaFk}, cantidad_unidades, peso_producto, peso, alto, largo, ancho)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING idbulto, cantidad_unidades, fecha_creacion, peso_producto, peso, alto, largo, ancho`,
      [fk.id, cantidad_unidades ?? null, peso_producto, peso, alto, largo, ancho]
    );

    const r = inserted[0];
    return res.status(201).json({
      idbulto:             Number(r.idbulto),
      cantidad_unidades:   Number(r.cantidad_unidades),
      fecha_creacion:      r.fecha_creacion,
      proceso_origen:      fk.tipo,
      numero_parcialidad:  null,
      peso_producto: r.peso_producto != null ? Number(r.peso_producto) : null,
      peso:  r.peso  != null ? Number(r.peso)  : null,
      alto:  r.alto  != null ? Number(r.alto)  : null,
      largo: r.largo != null ? Number(r.largo) : null,
      ancho: r.ancho != null ? Number(r.ancho) : null,
    });
  } catch (error: any) {
    console.error("❌ AGREGAR BULTO ERROR:", error.message);
    return res.status(500).json({ error: "Error al agregar bulto" });
  }
};

// ─────────────────────────────────────────────
// POST /api/seguimiento/:idproduccion/bultos/batch
// ─────────────────────────────────────────────
export const agregarBultosBatch = async (req: Request, res: Response): Promise<Response> => {
  try {
    const idproduccion = Number(req.params.idproduccion);

    const cantidad_unidades = req.body.cantidad_unidades != null ? Number(req.body.cantidad_unidades) : null;
    const repeticiones      = Math.max(1, Math.min(50, Number(req.body.repeticiones) || 1));
    const peso_producto     = req.body.peso_producto != null ? Number(req.body.peso_producto) : null;
    const peso              = req.body.peso  != null ? Number(req.body.peso)  : null;
    const alto              = req.body.alto  != null ? Number(req.body.alto)  : null;
    const largo             = req.body.largo != null ? Number(req.body.largo) : null;
    const ancho             = req.body.ancho != null ? Number(req.body.ancho) : null;

    const { rows: ordenRows } = await pool.query(
      `SELECT op.idestado_produccion_cat, op.proceso_actual,
              op.bultos_finalizado, sp.tipo_material
       FROM orden_produccion op
       JOIN solicitud_producto sp
         ON sp.idsolicitud_producto = op.idsolicitud_producto
       WHERE op.idproduccion = $1`,
      [idproduccion]
    );
    if (ordenRows.length === 0) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    const errorEstado = validarEstadoOrden(ordenRows[0]);
    if (errorEstado) return res.status(400).json({ error: errorEstado });

    const modoOrden = await getModoOrden(idproduccion);

    if (modoOrden === "kilo") {
      if (!peso_producto || peso_producto <= 0) {
        return res.status(400).json({ error: "El peso del producto es requerido y debe ser mayor a 0" });
      }
    } else {
      if (!cantidad_unidades || cantidad_unidades <= 0) {
        return res.status(400).json({ error: "La cantidad de unidades debe ser mayor a 0" });
      }
    }

    const fk = await resolverFkBulto(idproduccion);
    if (!fk) {
      return res.status(404).json({
        error: "No existe registro de bolseo ni asa_flexible para esta orden",
      });
    }

    const { limiteDisponible, totalEmpacado } = await calcularLimiteYEmpacado(idproduccion, fk, modoOrden);
    if (limiteDisponible !== null) {
      const valorUnitario = modoOrden === "kilo" ? (peso_producto ?? 0) : (cantidad_unidades ?? 0);
      const proyectado    = totalEmpacado + valorUnitario * repeticiones;
      const unidad        = modoOrden === "kilo" ? "kg" : "pzas";

      if (proyectado > limiteDisponible) {
        const restante        = Math.max(limiteDisponible - totalEmpacado, 0);
        const maxRepeticiones = valorUnitario > 0 ? Math.floor(restante / valorUnitario) : 0;
        return res.status(400).json({
          error:
            `No puedes empacar más de lo producido. ` +
            `Límite: ${limiteDisponible.toLocaleString("es-MX")} ${unidad}. ` +
            `Ya empacaste ${totalEmpacado.toLocaleString("es-MX")} ${unidad}. ` +
            `Con ${valorUnitario.toLocaleString("es-MX")} ${unidad}/bulto puedes registrar máximo ${maxRepeticiones} bulto(s) más.`,
          limite:           limiteDisponible,
          empacado:         totalEmpacado,
          restante,
          max_repeticiones: maxRepeticiones,
        });
      }
    }

    const columnaFk =
      fk.tipo === "bolseo"
        ? "bolseo_idbolseo"
        : fk.tipo === "asa_flexible"
          ? "asa_flexible_idasa_flexible"
          : "empaque_papel_idempaque_papel";

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const insertados: any[] = [];
      for (let i = 0; i < repeticiones; i++) {
        const { rows: inserted } = await client.query(
          `INSERT INTO bultos (${columnaFk}, cantidad_unidades, peso_producto, peso, alto, largo, ancho)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING idbulto, cantidad_unidades, fecha_creacion, peso_producto, peso, alto, largo, ancho`,
          [fk.id, cantidad_unidades ?? null, peso_producto, peso, alto, largo, ancho]
        );
        insertados.push(inserted[0]);
      }

      await client.query("COMMIT");

      const valorUnitario = modoOrden === "kilo" ? (peso_producto ?? 0) : (cantidad_unidades ?? 0);

      return res.status(201).json({
        bultos: insertados.map(r => ({
          idbulto:             Number(r.idbulto),
          cantidad_unidades:   Number(r.cantidad_unidades),
          fecha_creacion:      r.fecha_creacion,
          proceso_origen:      fk.tipo,
          numero_parcialidad:  null,
          peso_producto: r.peso_producto != null ? Number(r.peso_producto) : null,
          peso:  r.peso  != null ? Number(r.peso)  : null,
          alto:  r.alto  != null ? Number(r.alto)  : null,
          largo: r.largo != null ? Number(r.largo) : null,
          ancho: r.ancho != null ? Number(r.ancho) : null,
        })),
        repeticiones,
        total_bultos_agregados:   repeticiones,
        total_unidades_agregadas: Math.round(valorUnitario * repeticiones * 100) / 100,
      });
    } catch (txError) {
      await client.query("ROLLBACK");
      throw txError;
    } finally {
      client.release();
    }
  } catch (error: any) {
    console.error("❌ AGREGAR BULTOS BATCH ERROR:", error.message);
    return res.status(500).json({ error: "Error al agregar bultos en lote" });
  }
};

// ─────────────────────────────────────────────
// DELETE /api/seguimiento/:idproduccion/bultos/:idbulto
// ─────────────────────────────────────────────
export const eliminarBulto = async (req: Request, res: Response): Promise<Response> => {
  try {
    const idproduccion = Number(req.params.idproduccion);
    const idbulto      = Number(req.params.idbulto);

    const { rows: ordenRows } = await pool.query(
      `SELECT bultos_finalizado FROM orden_produccion WHERE idproduccion = $1`,
      [idproduccion]
    );
    if (ordenRows.length === 0) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }
    if (Boolean(ordenRows[0].bultos_finalizado)) {
      return res.status(400).json({ error: "Los bultos ya fueron finalizados. No se pueden eliminar." });
    }

    const { rows } = await pool.query(
      `SELECT b.idbulto FROM bultos b
       WHERE b.idbulto = $1
         AND (
           b.bolseo_idbolseo IN (
             SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = $2
           )
           OR
           b.asa_flexible_idasa_flexible IN (
             SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = $2
           )
           OR
           b.empaque_papel_idempaque_papel IN (
             SELECT idempaque_papel FROM empaque_papel WHERE orden_produccion_idproduccion = $2
           )
         )`,
      [idbulto, idproduccion]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Bulto no encontrado" });
    }

    await pool.query(`DELETE FROM bultos WHERE idbulto = $1`, [idbulto]);
    return res.json({ message: "Bulto eliminado", idbulto });
  } catch (error: any) {
    console.error("❌ ELIMINAR BULTO ERROR:", error.message);
    return res.status(500).json({ error: "Error al eliminar bulto" });
  }
};

// ─────────────────────────────────────────────
// PATCH /api/seguimiento/:idproduccion/bultos/finalizar
// ─────────────────────────────────────────────
export const finalizarBultos = async (req: Request, res: Response): Promise<Response> => {
  try {
    const idproduccion = Number(req.params.idproduccion);

    const { rows: ordenRows } = await pool.query(
      `SELECT bultos_finalizado FROM orden_produccion WHERE idproduccion = $1`,
      [idproduccion]
    );
    if (ordenRows.length === 0) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }
    if (Boolean(ordenRows[0].bultos_finalizado)) {
      return res.status(400).json({ error: "Los bultos ya fueron finalizados previamente" });
    }

    const { rows: bultosRows } = await pool.query(
      `SELECT COUNT(*) AS total FROM bultos b
       WHERE
         b.bolseo_idbolseo IN (
           SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = $1
         )
         OR
         b.asa_flexible_idasa_flexible IN (
           SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = $1
         )
         OR
         b.empaque_papel_idempaque_papel IN (
           SELECT idempaque_papel FROM empaque_papel WHERE orden_produccion_idproduccion = $1
         )`,
      [idproduccion]
    );
    if (Number(bultosRows[0].total) === 0) {
      return res.status(400).json({ error: "Debes registrar al menos un bulto antes de finalizar" });
    }

    const { rows: procesoFinalRows } = await pool.query(`
      SELECT
        COALESCE(emp.estado_produccion_cat_idestado_produccion_cat,
                 af.estado_produccion_cat_idestado_produccion_cat,
                 bol.estado_produccion_cat_idestado_produccion_cat) AS estado_final,
        CASE
          WHEN emp.idempaque_papel IS NOT NULL THEN 'empaque_papel'
          WHEN af.idasa_flexible IS NOT NULL THEN 'asa_flexible'
          ELSE 'bolseo'
        END AS proceso_final
      FROM orden_produccion op
      LEFT JOIN empaque_papel emp ON emp.orden_produccion_idproduccion = op.idproduccion
      LEFT JOIN asa_flexible af  ON af.orden_produccion_idproduccion  = op.idproduccion
      LEFT JOIN bolseo bol       ON bol.orden_produccion_idproduccion = op.idproduccion
      WHERE op.idproduccion = $1
      LIMIT 1
    `, [idproduccion]);

    if (procesoFinalRows.length > 0) {
      const estadoFinal = Number(procesoFinalRows[0].estado_final);
      const nombreFinal =
        procesoFinalRows[0].proceso_final === "empaque_papel"
          ? "Empaque de papel"
          : procesoFinalRows[0].proceso_final === "asa_flexible"
            ? "Asa flexible"
            : "Bolseo";
      if (estadoFinal !== ESTADO_PROD.TERMINADO) {
        return res.status(400).json({
          error: `El proceso de ${nombreFinal} debe estar finalizado antes de poder cerrar los bultos.`,
        });
      }
    }

    await pool.query(
      `UPDATE orden_produccion SET bultos_finalizado = TRUE WHERE idproduccion = $1`,
      [idproduccion]
    );

    return res.json({ message: "Bultos finalizados correctamente", idproduccion, bultos_finalizado: true });
  } catch (error: any) {
    console.error("❌ FINALIZAR BULTOS ERROR:", error.message);
    return res.status(500).json({ error: "Error al finalizar bultos" });
  }
};

// ─────────────────────────────────────────────
// GET /api/seguimiento/:idproduccion/bultos/etiqueta
// Solo trae bultos con numero_parcialidad IS NULL (aún no enviados)
// Calcula numero_envio_parcial = MAX(numero_parcialidad) + 1
// ─────────────────────────────────────────────
export const getBultosEtiqueta = async (req: Request, res: Response): Promise<Response> => {
  try {
    const idproduccion = Number(req.params.idproduccion);
    const parcialidadParam = req.query.parcialidad
      ? Number(req.query.parcialidad)
      : null;
    const esReimpresion = parcialidadParam !== null;

    const { rows: pedidoRows } = await pool.query(`
      SELECT
        s.no_pedido, s.fecha,
        op.no_produccion, op.idproduccion, op.fecha_entrega, op.bultos_finalizado, op.es_parcialidad,
        cli.razon_social AS cliente, cli.atencion, cli.empresa,
        cli.telefono, cli.celular, cli.correo, cli.impresion AS cliente_impresion,
        COALESCE(de.domicilio,     dom.domicilio)     AS calle,
        COALESCE(de.numero,        dom.numero)        AS numero,
        COALESCE(de.colonia,       dom.colonia)       AS colonia,
        COALESCE(de.codigo_postal, dom.codigo_postal) AS codigo_postal,
        COALESCE(de.poblacion,     dom.poblacion)     AS poblacion,
        COALESCE(de.estado,        dom.estado)        AS estado,
        de.referencia                                 AS referencia_envio,
        tpp.material_plastico_producto AS nombre_producto,
        cfg.medida,
        sp.descripcion,
        mp.tipo_material AS material,
        sd.cantidad, sd.kilogramos, sd.modo_cantidad,
        COALESCE(af.pzas_finales, bol.piezas_bolseadas) AS cantidad_real
      FROM orden_produccion op
      JOIN solicitud_producto sp ON sp.idsolicitud_producto = op.idsolicitud_producto
      JOIN solicitud s           ON s.idsolicitud = sp.solicitud_idsolicitud
      JOIN clientes cli          ON cli.idclientes = s.clientes_idclientes
      LEFT JOIN domicilio dom         ON dom.clientes_idclientes = cli.idclientes
      LEFT JOIN direccion_envio de    ON de.clientes_idclientes  = cli.idclientes
      LEFT JOIN configuracion_plastico cfg ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN tipo_producto_plastico tpp ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN material_plastico mp       ON mp.idmaterial_plastico = cfg.material_plastico_plastico_idmaterial_plastico
      LEFT JOIN solicitud_detalle sd       ON sd.solicitud_producto_id = sp.idsolicitud_producto AND sd.aprobado = true
      LEFT JOIN asa_flexible af            ON af.orden_produccion_idproduccion = op.idproduccion
      LEFT JOIN bolseo bol                 ON bol.orden_produccion_idproduccion = op.idproduccion
      WHERE op.idproduccion = $1
      LIMIT 1
    `, [idproduccion]);

    if (pedidoRows.length === 0) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }
    const pedido = pedidoRows[0];

    const esParcialidad = Boolean(pedido.es_parcialidad);

     if (!esReimpresion && !pedido.bultos_finalizado && !esParcialidad)
      return res.status(403).json({ error: "Los bultos aún no están finalizados" });

    // ── Calcular número de este envío parcial ────────────────────────────────
    // = MAX(numero_parcialidad) de bultos ya marcados + 1
    // Si ningún bulto tiene numero_parcialidad → es el primero → 1
    const { rows: maxRows } = await pool.query(`
      SELECT COALESCE(MAX(b.numero_parcialidad), 0) AS max_parcialidad
      FROM bultos b
      WHERE
        b.bolseo_idbolseo IN (
          SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = $1
        )
        OR
        b.asa_flexible_idasa_flexible IN (
          SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = $1
        )
        OR
        b.empaque_papel_idempaque_papel IN (
          SELECT idempaque_papel FROM empaque_papel WHERE orden_produccion_idproduccion = $1
        )
    `, [idproduccion]);

    const numeroEnvioParcial = esReimpresion
      ? parcialidadParam
      : esParcialidad
        ? Number(maxRows[0].max_parcialidad) + 1
        : null;

    // ── Solo bultos pendientes (numero_parcialidad IS NULL) ──────────────────
    const { rows: bultosRows } = await pool.query(`
      SELECT
        b.idbulto, b.cantidad_unidades, b.fecha_creacion,
        b.peso_producto, b.peso, b.alto, b.largo, b.ancho,
        CASE
          WHEN b.empaque_papel_idempaque_papel IS NOT NULL THEN 'empaque_papel'
          WHEN b.asa_flexible_idasa_flexible IS NOT NULL THEN 'asa_flexible'
          ELSE 'bolseo'
        END AS proceso_origen
      FROM bultos b
      WHERE
        ${esReimpresion
          ? `b.numero_parcialidad = ${parcialidadParam}`
          : `b.numero_parcialidad IS NULL`
        }
        AND (
          b.bolseo_idbolseo IN (
            SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = $1
          )
          OR
          b.asa_flexible_idasa_flexible IN (
            SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = $1
          )
          OR
          b.empaque_papel_idempaque_papel IN (
            SELECT idempaque_papel FROM empaque_papel WHERE orden_produccion_idproduccion = $1
          )
        )
      ORDER BY b.idbulto ASC
    `, [idproduccion]);

    if (bultosRows.length === 0) {
      return res.status(400).json({
        error: "No hay bultos pendientes de etiquetar. Todos los bultos ya fueron incluidos en un envío parcial anterior.",
      });
    }

    const modoOrden = (pedido.modo_cantidad === "kilo") ? "kilo" : "unidad";
    const total_kg  = bultosRows.reduce((sum: number, b: any) => sum + Number(b.peso_producto ?? 0), 0);

    return res.json({
      no_pedido:         pedido.no_pedido,
      no_produccion:     pedido.no_produccion,
      fecha:             pedido.fecha,
      fecha_entrega:     pedido.fecha_entrega     ?? null,
      cliente:           pedido.cliente           || "",
      atencion:          pedido.atencion          || null,
      empresa:           pedido.empresa           || "",
      telefono:          pedido.telefono          || "",
      celular:           pedido.celular           || "",
      correo:            pedido.correo            || "",
      cliente_impresion: pedido.cliente_impresion || "",
      calle:             pedido.calle             || "",
      numero:            pedido.numero            || "",
      colonia:           pedido.colonia           || "",
      codigo_postal:     pedido.codigo_postal      || "",
      poblacion:         pedido.poblacion          || "",
      estado:            pedido.estado             || "",
      referencia_envio:  pedido.referencia_envio   || null,
      nombre_producto:   pedido.nombre_producto    || "",
      descripcion:      pedido.descripcion       || null,
      medida:            pedido.medida             || "",
      material:          pedido.material           || "",
      cantidad_total:    pedido.cantidad_real != null
        ? Number(pedido.cantidad_real)
        : pedido.cantidad ? Number(pedido.cantidad) : null,
      kilogramos:        pedido.kilogramos ? Number(pedido.kilogramos) : null,
      modo_cantidad:     modoOrden,
      total_bultos:      bultosRows.length,
      total_kg:          Math.round(total_kg * 100) / 100,
      es_parcialidad:    esReimpresion ? true : esParcialidad,
      numero_envio_parcial: numeroEnvioParcial,
      bultos: bultosRows.map((b: any) => ({
        idbulto:           Number(b.idbulto),
        cantidad_unidades: Number(b.cantidad_unidades),
        fecha_creacion:    b.fecha_creacion,
        proceso_origen:    b.proceso_origen as ProcesoOrigen,
        peso_producto: b.peso_producto != null ? Number(b.peso_producto) : null,
        peso:  b.peso  != null ? Number(b.peso)  : null,
        alto:  b.alto  != null ? Number(b.alto)  : null,
        largo: b.largo != null ? Number(b.largo) : null,
        ancho: b.ancho != null ? Number(b.ancho) : null,
      })),
    });
  } catch (error: any) {
    console.error("❌ GET BULTOS ETIQUETA ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener datos de etiqueta" });
  }
};

// ─────────────────────────────────────────────
// PATCH /api/seguimiento/:idproduccion/bultos/marcar-parcialidad
// Body: { numero_parcialidad: number, idbultos: number[] }
// Estampa numero_parcialidad en los bultos recién etiquetados
// ─────────────────────────────────────────────
export const marcarBultosParcialidad = async (req: Request, res: Response): Promise<Response> => {
  try {
    const idproduccion      = Number(req.params.idproduccion);
    const { numero_parcialidad, idbultos } = req.body as {
      numero_parcialidad: number;
      idbultos: number[];
    };

    if (!numero_parcialidad || numero_parcialidad < 1) {
      return res.status(400).json({ error: "numero_parcialidad debe ser mayor a 0" });
    }
    if (!idbultos || !Array.isArray(idbultos) || idbultos.length === 0) {
      return res.status(400).json({ error: "idbultos debe ser un array no vacío" });
    }

    // Verificar que los bultos pertenecen a esta orden
    const { rows: verificacion } = await pool.query(`
      SELECT COUNT(*) AS total FROM bultos b
      WHERE b.idbulto = ANY($1::int[])
        AND (
          b.bolseo_idbolseo IN (
            SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = $2
          )
          OR
          b.asa_flexible_idasa_flexible IN (
            SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = $2
          )
          OR
          b.empaque_papel_idempaque_papel IN (
            SELECT idempaque_papel FROM empaque_papel WHERE orden_produccion_idproduccion = $2
          )
        )
    `, [idbultos, idproduccion]);

    if (Number(verificacion[0].total) !== idbultos.length) {
      return res.status(400).json({ error: "Algunos bultos no pertenecen a esta orden" });
    }

    await pool.query(
      `UPDATE bultos SET numero_parcialidad = $1 WHERE idbulto = ANY($2::int[])`,
      [numero_parcialidad, idbultos]
    );

    return res.json({
      message: `${idbultos.length} bulto(s) marcados como envío parcial ${numero_parcialidad}`,
      numero_parcialidad,
      total_marcados: idbultos.length,
    });
  } catch (error: any) {
    console.error("❌ MARCAR PARCIALIDAD ERROR:", error.message);
    return res.status(500).json({ error: "Error al marcar parcialidad de bultos" });
  }
};

// ─────────────────────────────────────────────
// PUT /api/seguimiento/:idproduccion/bultos/:idbulto
// ─────────────────────────────────────────────
export const editarBulto = async (req: Request, res: Response): Promise<Response> => {
  try {
    const idproduccion = Number(req.params.idproduccion);
    const idbulto      = Number(req.params.idbulto);

    const cantidad_unidades = req.body.cantidad_unidades != null ? Number(req.body.cantidad_unidades) : null;
    const peso_producto     = req.body.peso_producto     != null ? Number(req.body.peso_producto)     : null;
    const peso              = req.body.peso              != null ? Number(req.body.peso)              : null;
    const alto              = req.body.alto              != null ? Number(req.body.alto)              : null;
    const largo             = req.body.largo             != null ? Number(req.body.largo)             : null;
    const ancho             = req.body.ancho             != null ? Number(req.body.ancho)             : null;

    const modoOrden = await getModoOrden(idproduccion);

    if (modoOrden === "kilo") {
      if (!peso_producto || peso_producto <= 0) {
        return res.status(400).json({ error: "El peso del producto es requerido y debe ser mayor a 0" });
      }
    } else {
      if (!cantidad_unidades || cantidad_unidades <= 0) {
        return res.status(400).json({ error: "La cantidad de unidades debe ser mayor a 0" });
      }
    }

    const { rows } = await pool.query(
      `SELECT b.idbulto FROM bultos b
       WHERE b.idbulto = $1
         AND (
           b.bolseo_idbolseo IN (
             SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = $2
           )
           OR
           b.asa_flexible_idasa_flexible IN (
             SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = $2
           )
           OR
           b.empaque_papel_idempaque_papel IN (
             SELECT idempaque_papel FROM empaque_papel WHERE orden_produccion_idproduccion = $2
           )
         )`,
      [idbulto, idproduccion]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Bulto no encontrado" });
    }

    const { rows: updated } = await pool.query(
      `UPDATE bultos
       SET cantidad_unidades = $1,
           peso_producto     = $2,
           peso              = $3,
           alto              = $4,
           largo             = $5,
           ancho             = $6
       WHERE idbulto = $7
       RETURNING idbulto, cantidad_unidades, fecha_creacion, peso_producto, peso, alto, largo, ancho, numero_parcialidad`,
      [cantidad_unidades ?? null, peso_producto, peso, alto, largo, ancho, idbulto]
    );

    const r = updated[0];
    const { rows: origenRows } = await pool.query(
      `SELECT CASE
         WHEN empaque_papel_idempaque_papel IS NOT NULL THEN 'empaque_papel'
         WHEN asa_flexible_idasa_flexible IS NOT NULL THEN 'asa_flexible'
         ELSE 'bolseo'
       END AS proceso_origen
       FROM bultos WHERE idbulto = $1`,
      [idbulto]
    );

    return res.json({
      idbulto:             Number(r.idbulto),
      cantidad_unidades:   Number(r.cantidad_unidades),
      fecha_creacion:      r.fecha_creacion,
      proceso_origen:      origenRows[0]?.proceso_origen ?? "bolseo",
      numero_parcialidad:  r.numero_parcialidad != null ? Number(r.numero_parcialidad) : null,
      peso_producto: r.peso_producto != null ? Number(r.peso_producto) : null,
      peso:  r.peso  != null ? Number(r.peso)  : null,
      alto:  r.alto  != null ? Number(r.alto)  : null,
      largo: r.largo != null ? Number(r.largo) : null,
      ancho: r.ancho != null ? Number(r.ancho) : null,
    });
  } catch (error: any) {
    console.error("❌ EDITAR BULTO ERROR:", error.message);
    return res.status(500).json({ error: "Error al editar bulto" });
  }
};
