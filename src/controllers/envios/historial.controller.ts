import { Request, Response } from "express";
import { pool } from "../../config/db";

// ============================================================
// HELPER: construir cláusulas WHERE dinámicas
// ============================================================
function buildWhereLocal(params: {
  fecha_inicio?: string;
  fecha_fin?: string;
  idunidad?: string;
  idusuario?: string;
  no_pedido?: string;
  cliente?: string;
}): { clause: string; values: any[] } {
  const conds: string[] = [];
  const values: any[]   = [];
  let   i = 1;

  if (params.fecha_inicio) {
    conds.push(`br.fecha >= $${i++}`);
    values.push(params.fecha_inicio);
  }
  if (params.fecha_fin) {
    conds.push(`br.fecha <= $${i++}`);
    values.push(params.fecha_fin);
  }
  if (params.idunidad) {
    conds.push(`un.idunidad = $${i++}`);
    values.push(Number(params.idunidad));
  }
  if (params.idusuario) {
    conds.push(`u.idusuario = $${i++}`);
    values.push(Number(params.idusuario));
  }
  if (params.no_pedido) {
    conds.push(`s.no_pedido ILIKE $${i++}`);
    values.push(`%${params.no_pedido}%`);
  }
  if (params.cliente) {
    conds.push(`(cli.impresion ILIKE $${i++} OR cli.empresa ILIKE $${i++})`);
    values.push(`%${params.cliente}%`, `%${params.cliente}%`);
    // i already incremented twice inside push — correct below
    // Actually we need to handle i correctly for two placeholders
    // Let's redo this safely
  }

  return { clause: conds.length ? "AND " + conds.join(" AND ") : "", values };
}

// Safe version with explicit index tracking
function buildWhereLocalSafe(params: {
  fecha_inicio?: string;
  fecha_fin?:    string;
  idunidad?:     string;
  idusuario?:    string;
  no_pedido?:    string;
  cliente?:      string;
}): { clause: string; values: any[] } {
  const conds: string[] = [];
  const values: any[]   = [];

  if (params.fecha_inicio) {
    values.push(params.fecha_inicio);
    conds.push(`br.fecha >= $${values.length}`);
  }
  if (params.fecha_fin) {
    values.push(params.fecha_fin);
    conds.push(`br.fecha <= $${values.length}`);
  }
  if (params.idunidad) {
    values.push(Number(params.idunidad));
    conds.push(`un.idunidad = $${values.length}`);
  }
  if (params.idusuario) {
    values.push(Number(params.idusuario));
    conds.push(`u.idusuario = $${values.length}`);
  }
  if (params.no_pedido) {
    values.push(`%${params.no_pedido}%`);
    conds.push(`s.no_pedido ILIKE $${values.length}`);
  }
  if (params.cliente) {
    values.push(`%${params.cliente}%`);
    conds.push(`(cli.impresion ILIKE $${values.length} OR cli.empresa ILIKE $${values.length})`);
  }

  return {
    clause: conds.length ? "AND " + conds.join(" AND ") : "",
    values,
  };
}

function buildWherePaqSafe(params: {
  fecha_inicio?:    string;
  fecha_fin?:       string;
  idpaqueteria?:    string;
  numero_guia?:     string;
  no_pedido?:       string;
  cliente?:         string;
  estado?:          string;
}): { clause: string; values: any[] } {
  const conds: string[] = [];
  const values: any[]   = [];

  if (params.fecha_inicio) {
    values.push(params.fecha_inicio);
    conds.push(`DATE(e.fecha_envio) >= $${values.length}`);
  }
  if (params.fecha_fin) {
    values.push(params.fecha_fin);
    conds.push(`DATE(e.fecha_envio) <= $${values.length}`);
  }
  if (params.idpaqueteria) {
    values.push(Number(params.idpaqueteria));
    conds.push(`p.idpaqueteria = $${values.length}`);
  }
  if (params.numero_guia) {
    values.push(`%${params.numero_guia}%`);
    conds.push(`e.numero_guia ILIKE $${values.length}`);
  }
  if (params.no_pedido) {
    values.push(`%${params.no_pedido}%`);
    conds.push(`s.no_pedido ILIKE $${values.length}`);
  }
  if (params.cliente) {
    values.push(`%${params.cliente}%`);
    conds.push(`(cli.impresion ILIKE $${values.length} OR cli.empresa ILIKE $${values.length})`);
  }
  if (params.estado) {
    values.push(params.estado);
    conds.push(`e.estado = $${values.length}`);
  }

  return {
    clause: conds.length ? "AND " + conds.join(" AND ") : "",
    values,
  };
}

// ============================================================
// GET /historial/local
// Query params: fecha_inicio, fecha_fin, idunidad, idusuario,
//               no_pedido, cliente
// ============================================================
export const getHistorialLocal = async (req: Request, res: Response) => {
  try {
    const { fecha_inicio, fecha_fin, idunidad, idusuario, no_pedido, cliente } =
      req.query as Record<string, string | undefined>;

    const { clause, values } = buildWhereLocalSafe({
      fecha_inicio, fecha_fin, idunidad, idusuario, no_pedido, cliente,
    });

    const { rows } = await pool.query(`
      SELECT
        br.idbitacora,
        br.fecha,
        br.hora_salida,
        br.hora_llegada,
        br.observacion,
        br.observacion_extra,
        br.firma,
        e.idenvio,
        e.estado,
        e.es_parcialidad,
        s.no_pedido,
        cli.empresa,
        cli.impresion,
        u.idusuario,
        u.nombre   AS chofer_nombre,
        u.apellido AS chofer_apellido,
        un.idunidad,
        un.tipo    AS unidad_tipo,
        un.marca   AS unidad_marca,
        un.modelo  AS unidad_modelo,
        un.placa   AS unidad_placa,
        COUNT(eb.idenvio_bulto) AS total_bultos
      FROM bitacora_reparto br
      JOIN envio e        ON e.idenvio               = br.envio_idenvio
      JOIN solicitud s    ON s.idsolicitud            = e.solicitud_idsolicitud
      JOIN clientes cli   ON cli.idclientes           = s.clientes_idclientes
      JOIN usuarios u     ON u.idusuario              = br.usuarios_idusuario
      JOIN unidades un    ON un.idunidad              = br.unidades_idunidad
      LEFT JOIN envio_bulto eb ON eb.envio_idenvio    = e.idenvio
      WHERE 1=1
      ${clause}
      GROUP BY
        br.idbitacora, br.fecha, br.hora_salida, br.hora_llegada,
        br.observacion, br.observacion_extra, br.firma,
        e.idenvio, e.estado, e.es_parcialidad,
        s.no_pedido, cli.empresa, cli.impresion,
        u.idusuario, u.nombre, u.apellido,
        un.idunidad, un.tipo, un.marca, un.modelo, un.placa
      ORDER BY br.fecha DESC, br.idbitacora DESC
    `, values);

    const data = rows.map((r: any) => ({
      idbitacora:        Number(r.idbitacora),
      fecha:             r.fecha,
      hora_salida:       r.hora_salida       || null,
      hora_llegada:      r.hora_llegada      || null,
      observacion:       r.observacion       || null,
      observacion_extra: r.observacion_extra || null,
      firma:             r.firma             || null,
      idenvio:           Number(r.idenvio),
      estado:            r.estado,
      es_parcialidad:    r.es_parcialidad,
      no_pedido:         r.no_pedido,
      cliente:           r.impresion || r.empresa || "",
      total_bultos:      Number(r.total_bultos),
      chofer: {
        idusuario: Number(r.idusuario),
        nombre:    `${r.chofer_nombre} ${r.chofer_apellido}`,
      },
      unidad: {
        idunidad: Number(r.idunidad),
        tipo:     r.unidad_tipo,
        nombre:   `${r.unidad_marca} ${r.unidad_modelo} — ${r.unidad_placa}`,
      },
    }));

    res.json(data);
  } catch (error: any) {
    console.error("❌ GET HISTORIAL LOCAL ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener historial local" });
  }
};

// ============================================================
// GET /historial/paqueteria
// Query params: fecha_inicio, fecha_fin, idpaqueteria,
//               numero_guia, no_pedido, cliente, estado
// ============================================================
export const getHistorialPaqueteria = async (req: Request, res: Response) => {
  try {
    const {
      fecha_inicio, fecha_fin, idpaqueteria,
      numero_guia, no_pedido, cliente, estado,
    } = req.query as Record<string, string | undefined>;

    const { clause, values } = buildWherePaqSafe({
      fecha_inicio, fecha_fin, idpaqueteria,
      numero_guia, no_pedido, cliente, estado,
    });

    const { rows } = await pool.query(`
      SELECT
        e.idenvio,
        e.estado,
        e.es_parcialidad,
        e.numero_guia,
        e.costo_flete,
        e.fecha_envio,
        e.fecha_entrega_estimada,
        e.observaciones,
        s.no_pedido,
        cli.empresa,
        cli.impresion,
        p.idpaqueteria,
        p.nombre AS paqueteria_nombre,
        COUNT(eb.idenvio_bulto) AS total_bultos
      FROM envio e
      JOIN solicitud s         ON s.idsolicitud      = e.solicitud_idsolicitud
      JOIN clientes cli        ON cli.idclientes      = s.clientes_idclientes
      JOIN paqueteria p        ON p.idpaqueteria      = e.paqueteria_idpaqueteria
      LEFT JOIN envio_bulto eb ON eb.envio_idenvio    = e.idenvio
      WHERE e.tipo = 'paqueteria'
      ${clause}
      GROUP BY
        e.idenvio, e.estado, e.es_parcialidad, e.numero_guia,
        e.costo_flete, e.fecha_envio, e.fecha_entrega_estimada, e.observaciones,
        s.no_pedido, cli.empresa, cli.impresion,
        p.idpaqueteria, p.nombre
      ORDER BY e.fecha_envio DESC
    `, values);

    const data = rows.map((r: any) => ({
      idenvio:                Number(r.idenvio),
      estado:                 r.estado,
      es_parcialidad:         r.es_parcialidad,
      numero_guia:            r.numero_guia            || null,
      costo_flete:            r.costo_flete != null ? Number(r.costo_flete) : null,
      fecha_envio:            r.fecha_envio,
      fecha_entrega_estimada: r.fecha_entrega_estimada || null,
      observaciones:          r.observaciones          || null,
      no_pedido:              r.no_pedido,
      cliente:                r.impresion || r.empresa || "",
      total_bultos:           Number(r.total_bultos),
      paqueteria: {
        idpaqueteria: Number(r.idpaqueteria),
        nombre:       r.paqueteria_nombre,
      },
    }));

    res.json(data);
  } catch (error: any) {
    console.error("❌ GET HISTORIAL PAQUETERIA ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener historial paquetería" });
  }
};