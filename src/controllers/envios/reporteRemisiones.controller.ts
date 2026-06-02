import { Request, Response } from "express";
import { pool } from "../../config/db";

// ==========================
// GET /historial/remisiones/clientes
// ==========================
export const getClientesConPedidosActivos = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT
        cli.idclientes,
        cli.empresa,
        cli.razon_social,
        cli.impresion,
        COUNT(DISTINCT s.idsolicitud) AS total_pedidos
      FROM solicitud s
      JOIN clientes cli ON cli.idclientes = s.clientes_idclientes
      WHERE s.estado = 'pedido'
        AND s.no_pedido IS NOT NULL
      GROUP BY cli.idclientes, cli.empresa, cli.razon_social, cli.impresion
      ORDER BY cli.impresion ASC NULLS LAST
    `);
    res.json(rows.map((r: any) => ({
      idclientes:    Number(r.idclientes),
      nombre:        r.impresion || r.empresa || r.razon_social || "",
      empresa:       r.empresa || "",
      total_pedidos: Number(r.total_pedidos),
    })));
  } catch (error: any) {
    console.error("❌ GET CLIENTES REMISIONES ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener clientes" });
  }
};

// ==========================
// GET /historial/remisiones/pedidos/:idclientes
// ==========================
export const getPedidosCliente = async (req: Request, res: Response) => {
  try {
    const { idclientes } = req.params;

    const { rows: pedidosRows } = await pool.query(`
      SELECT DISTINCT s.idsolicitud, s.no_pedido, s.fecha
      FROM solicitud s
      WHERE s.clientes_idclientes = $1
        AND s.estado = 'pedido'
        AND s.no_pedido IS NOT NULL
      ORDER BY s.no_pedido DESC
    `, [idclientes]);

    if (!pedidosRows.length) return res.json([]);

    const idsolicitudes = pedidosRows.map((r: any) => r.idsolicitud);

    const { rows: productosRows } = await pool.query(`
      SELECT
        sp.solicitud_idsolicitud          AS idsolicitud,
        sp.idsolicitud_producto,
        sp.descripcion,
        tpp.material_plastico_producto    AS nombre_producto,
        cfg.medida,
        sd.cantidad                       AS cantidad_total,
        sd.kilogramos                     AS kg_total,
        sd.modo_cantidad,
        COALESCE(SUM(
          CASE WHEN eb.bultos_idbulto IS NOT NULL THEN
            CASE WHEN sd.modo_cantidad = 'kilo'
                 THEN COALESCE(b.peso_producto, 0)
                 ELSE COALESCE(b.cantidad_unidades, 0)
            END
          ELSE 0 END
        ), 0)                             AS cantidad_entregada,
        COUNT(DISTINCT eb.bultos_idbulto) AS bultos_entregados
      FROM solicitud_producto sp
      JOIN LATERAL (
        SELECT cantidad, kilogramos, modo_cantidad
        FROM solicitud_detalle
        WHERE solicitud_producto_id = sp.idsolicitud_producto
          AND aprobado = true
        ORDER BY idsolicitud_detalle DESC
        LIMIT 1
      ) sd ON true
      LEFT JOIN orden_produccion op ON op.idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN bolseo bol ON bol.orden_produccion_idproduccion = op.idproduccion
      LEFT JOIN asa_flexible af ON af.orden_produccion_idproduccion = op.idproduccion
      LEFT JOIN bultos b ON (b.bolseo_idbolseo = bol.idbolseo OR b.asa_flexible_idasa_flexible = af.idasa_flexible)
      LEFT JOIN envio_bulto eb ON eb.bultos_idbulto = b.idbulto
      LEFT JOIN configuracion_plastico cfg
        ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN tipo_producto_plastico tpp
        ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      WHERE sp.solicitud_idsolicitud = ANY($1::int[])
      GROUP BY sp.solicitud_idsolicitud, sp.idsolicitud_producto, sp.descripcion,
               tpp.material_plastico_producto, cfg.medida, sd.cantidad, sd.kilogramos, sd.modo_cantidad
      ORDER BY sp.idsolicitud_producto ASC
    `, [idsolicitudes]);

    const productosPorPedido: Record<number, any[]> = {};
    for (const p of productosRows) {
      const id = Number(p.idsolicitud);
      if (!productosPorPedido[id]) productosPorPedido[id] = [];
      productosPorPedido[id].push({
        idsolicitud_producto: Number(p.idsolicitud_producto),
        descripcion:          p.descripcion || null,
        nombre_producto:      p.nombre_producto || "",
        medida:               p.medida || "",
        modo_cantidad:        p.modo_cantidad || "unidad",
        cantidad_total:       p.cantidad_total != null ? Number(p.cantidad_total) : null,
        kg_total:             p.kg_total != null ? Number(p.kg_total) : null,
        cantidad_entregada:   Number(p.cantidad_entregada),
        bultos_entregados:    Number(p.bultos_entregados),
      });
    }

    res.json(pedidosRows.map((r: any) => ({
      idsolicitud: Number(r.idsolicitud),
      no_pedido:   r.no_pedido,
      fecha:       r.fecha,
      productos:   productosPorPedido[Number(r.idsolicitud)] || [],
    })));
  } catch (error: any) {
    console.error("❌ GET PEDIDOS CLIENTE REMISIONES ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener pedidos" });
  }
};

// ==========================
// POST /historial/remisiones/entregas
// ==========================
export const getHistorialEntregas = async (req: Request, res: Response) => {
  try {
    const { idsolicitudes } = req.body as { idsolicitudes: number[] };
    if (!idsolicitudes?.length)
      return res.status(400).json({ error: "idsolicitudes es requerido" });

    // ── Query principal: un registro por envío ─────────────────────────────
    const { rows: enviosRows } = await pool.query(`
      SELECT
        e.idenvio,
        e.tipo,
        e.estado,
        e.es_parcialidad,
        e.fecha_envio,
        e.numero_guia,
        e.observaciones,
        s.idsolicitud,
        s.no_pedido,
        nr.idnota         AS nota_simple_id,
        nr.no_nota        AS nota_simple_no,
        nr.observaciones  AS nota_simple_obs,
        nrm.idnota        AS nota_multi_id,
        nrm.no_nota       AS nota_multi_no,
        nrm.observaciones AS nota_multi_obs,
        br.observacion        AS bitacora_observacion,
        br.observacion_extra  AS bitacora_observacion_extra,
        COUNT(DISTINCT b.idbulto) AS total_bultos,
        SUM(
          CASE
            WHEN sd.modo_cantidad = 'kilo' THEN COALESCE(b.peso_producto, 0)
            ELSE COALESCE(b.cantidad_unidades, 0)
          END
        ) AS cantidad_entregada,
        MIN(sd.modo_cantidad) AS modo_cantidad
      FROM envio e
      JOIN solicitud s ON s.idsolicitud = e.solicitud_idsolicitud
      LEFT JOIN envio_bulto eb ON eb.envio_idenvio = e.idenvio
      LEFT JOIN bultos b ON b.idbulto = eb.bultos_idbulto
      LEFT JOIN bolseo bol ON bol.idbolseo = b.bolseo_idbolseo
      LEFT JOIN asa_flexible af ON af.idasa_flexible = b.asa_flexible_idasa_flexible
      LEFT JOIN orden_produccion op
        ON op.idproduccion = COALESCE(bol.orden_produccion_idproduccion, af.orden_produccion_idproduccion)
      LEFT JOIN solicitud_producto sp ON sp.idsolicitud_producto = op.idsolicitud_producto
      LEFT JOIN LATERAL (
        SELECT modo_cantidad FROM solicitud_detalle
        WHERE solicitud_producto_id = sp.idsolicitud_producto AND aprobado = true
        ORDER BY idsolicitud_detalle DESC LIMIT 1
      ) sd ON sp.idsolicitud_producto IS NOT NULL
      LEFT JOIN nota_remision nr
        ON nr.envio_idenvio = e.idenvio AND nr.es_multi = FALSE
      LEFT JOIN nota_remision_envio nre ON nre.envio_idenvio = e.idenvio
      LEFT JOIN nota_remision nrm
        ON nrm.idnota = nre.nota_remision_idnota AND nrm.es_multi = TRUE
      LEFT JOIN bitacora_reparto br ON br.envio_idenvio = e.idenvio
      WHERE e.solicitud_idsolicitud = ANY($1::int[])
      GROUP BY
        e.idenvio, e.tipo, e.estado, e.es_parcialidad,
        e.fecha_envio, e.numero_guia, e.observaciones,
        s.idsolicitud, s.no_pedido,
        nr.idnota, nr.no_nota, nr.observaciones,
        nrm.idnota, nrm.no_nota, nrm.observaciones,
        br.observacion, br.observacion_extra
      ORDER BY s.no_pedido ASC, e.fecha_envio ASC
    `, [idsolicitudes]);

    // ── Query secundaria: desglose por producto por envío ──────────────────
    const allEnvioIds = enviosRows.map((r: any) => Number(r.idenvio));
    const productosDetalleMap = new Map<number, any[]>();

    if (allEnvioIds.length) {
      const { rows: detRows } = await pool.query(`
        SELECT
          eb.envio_idenvio                           AS idenvio,
          COALESCE(tpp.material_plastico_producto, '') AS nombre_producto,
          COALESCE(cfg.medida, '')                   AS medida,
          sp.descripcion,
          COUNT(b.idbulto)                           AS total_bultos,
          SUM(
            CASE
              WHEN sd.modo_cantidad = 'kilo' THEN COALESCE(b.peso_producto, 0)
              ELSE COALESCE(b.cantidad_unidades, 0)
            END
          )                                          AS cantidad,
          MIN(sd.modo_cantidad)                      AS modo_cantidad
        FROM envio_bulto eb
        JOIN bultos b ON b.idbulto = eb.bultos_idbulto
        LEFT JOIN bolseo bol ON bol.idbolseo = b.bolseo_idbolseo
        LEFT JOIN asa_flexible af ON af.idasa_flexible = b.asa_flexible_idasa_flexible
        LEFT JOIN orden_produccion op
          ON op.idproduccion = COALESCE(bol.orden_produccion_idproduccion, af.orden_produccion_idproduccion)
        LEFT JOIN solicitud_producto sp ON sp.idsolicitud_producto = op.idsolicitud_producto
        LEFT JOIN LATERAL (
          SELECT modo_cantidad FROM solicitud_detalle
          WHERE solicitud_producto_id = sp.idsolicitud_producto AND aprobado = true
          ORDER BY idsolicitud_detalle DESC LIMIT 1
        ) sd ON sp.idsolicitud_producto IS NOT NULL
        LEFT JOIN configuracion_plastico cfg
          ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
        LEFT JOIN tipo_producto_plastico tpp
          ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
        WHERE eb.envio_idenvio = ANY($1::int[])
        GROUP BY eb.envio_idenvio, tpp.material_plastico_producto, cfg.medida, sp.descripcion, sd.modo_cantidad
        ORDER BY eb.envio_idenvio, tpp.material_plastico_producto
      `, [allEnvioIds]);

      for (const p of detRows) {
        const id = Number(p.idenvio);
        if (!productosDetalleMap.has(id)) productosDetalleMap.set(id, []);
        productosDetalleMap.get(id)!.push({
          nombre_producto: p.nombre_producto || "",
          medida:          p.medida || "",
          descripcion:     p.descripcion || null,
          total_bultos:    Number(p.total_bultos),
          cantidad:        Number(p.cantidad || 0),
          modo_cantidad:   p.modo_cantidad || "unidad",
        });
      }
    }

    // ── Agrupar por pedido ─────────────────────────────────────────────────
    const porPedido: Record<number, any[]> = {};

    for (const r of enviosRows) {
      const id = Number(r.idsolicitud);
      if (!porPedido[id]) porPedido[id] = [];

      const nota_no  = r.nota_multi_no  || r.nota_simple_no  || null;
      const nota_id  = r.nota_multi_id  || r.nota_simple_id  || null;
      const es_multi = !!r.nota_multi_id;

      porPedido[id].push({
        idenvio:            Number(r.idenvio),
        tipo:               r.tipo,
        estado:             r.estado,
        es_parcialidad:     Boolean(r.es_parcialidad),
        fecha_envio:        r.fecha_envio,
        numero_guia:        r.numero_guia  || null,
        observaciones:      r.observaciones || null,
        observacion:        r.bitacora_observacion       || null,  // ← código E/RA/RD/PD
        observacion_extra:  r.bitacora_observacion_extra || null,  // ← texto libre
        total_bultos:       Number(r.total_bultos),
        cantidad_entregada: Number(r.cantidad_entregada || 0),
        modo_cantidad:      r.modo_cantidad || "unidad",
        nota_no,
        nota_id:            nota_id ? Number(nota_id) : null,
        idnota:             nota_id ? Number(nota_id) : null,
        es_multi,
        nota_observaciones: r.nota_multi_obs || r.nota_simple_obs || null,
        productos_detalle:  productosDetalleMap.get(Number(r.idenvio)) || [],
      });
    }

    const resultado = idsolicitudes.map(id => {
      const entregas       = porPedido[id] || [];
      const total_entregado = entregas.reduce((s, e) => s + Number(e.cantidad_entregada || 0), 0);
      const total_bultos    = entregas.reduce((s, e) => s + Number(e.total_bultos    || 0), 0);
      return {
        idsolicitud:     id,
        entregas,
        total_entregas:  entregas.length,
        total_entregado: Math.round(total_entregado),
        total_bultos,
      };
    });

    res.json(resultado);
  } catch (error: any) {
    console.error("❌ GET HISTORIAL ENTREGAS ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener historial de entregas" });
  }
};