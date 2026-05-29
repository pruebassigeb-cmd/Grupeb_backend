import { Request, Response } from "express";
import { pool } from "../../config/db";

// ==========================
// CREAR NOTA DE REMISIÓN MULTI-PEDIDO
// POST /notas-remision/multi
// ==========================
export const crearNotaMulti = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { envios_ids, tipo_entrega, chofer_idusuario, unidad_idunidad, observaciones } = req.body;

    if (!envios_ids?.length)
      return res.status(400).json({ error: "envios_ids es requerido" });

    if (!["recoleccion", "local"].includes(tipo_entrega))
      return res.status(400).json({ error: "tipo_entrega debe ser 'recoleccion' o 'local'" });

    if (tipo_entrega === "local" && (!chofer_idusuario || !unidad_idunidad))
      return res.status(400).json({ error: "Para entrega local se requiere chofer y unidad" });

    const anio = new Date().getFullYear();
    const prefijo = `N${anio}`;

    const { rows: ultimoRows } = await client.query(
      `SELECT no_nota FROM nota_remision WHERE no_nota LIKE $1 ORDER BY idnota DESC LIMIT 1`,
      [`${prefijo}%`]
    );

    let consecutivo = 1;
    if (ultimoRows.length) {
      const numStr = ultimoRows[0].no_nota.replace(prefijo, "");
      consecutivo = parseInt(numStr, 10) + 1;
    }

    const no_nota = `${prefijo}${String(consecutivo).padStart(3, "0")}`;

    const { rows: notaRows } = await client.query(
      `INSERT INTO nota_remision (no_nota, envio_idenvio, es_multi, tipo_entrega, chofer_idusuario, unidad_idunidad, observaciones)
       VALUES ($1, NULL, TRUE, $2, $3, $4, $5)
       RETURNING idnota, no_nota, created_at`,
      [no_nota, tipo_entrega, chofer_idusuario || null, unidad_idunidad || null, observaciones?.trim() || null]
    );

    const idnota = notaRows[0].idnota;

    for (const idenvio of envios_ids) {
      await client.query(
        `INSERT INTO nota_remision_envio (nota_remision_idnota, envio_idenvio)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [idnota, idenvio]
      );
    }

    await client.query("COMMIT");

    const datos = await _getDatosNotaMulti(idnota);
    res.status(201).json(datos);
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ CREAR NOTA MULTI ERROR:", error.message);
    res.status(500).json({ error: "Error al crear nota de remisión" });
  } finally {
    client.release();
  }
};

// ==========================
// GET NOTA MULTI POR ID
// GET /notas-remision/multi/:idnota
// ==========================
export const getNotaMulti = async (req: Request, res: Response) => {
  try {
    const { idnota } = req.params;
    const datos = await _getDatosNotaMulti(Number(idnota));
    if (!datos) return res.status(404).json({ error: "Nota no encontrada" });
    res.json(datos);
  } catch (error: any) {
    console.error("❌ GET NOTA MULTI ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener nota" });
  }
};

// ==========================
// GET NOTAS REMISIÓN PARA BITÁCORA
// GET /notas-remision/bitacora
// ==========================
export const getNotasBitacora = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        nr.idnota,
        nr.no_nota,
        nr.created_at,
        nr.es_multi,
        nr.tipo_entrega,
        nr.estado,
        nr.observaciones,
        nr.recoleccion_nombre_quien_recogio,
        nr.recoleccion_empresa,
        nr.recoleccion_unidad_marca,
        nr.recoleccion_unidad_modelo,
        nr.recoleccion_unidad_placas,
        nr.recoleccion_fecha,
        nr.local_hora_salida,
        nr.local_hora_llegada,
        nr.local_observacion,
        nr.local_observacion_extra,
        nr.local_firma,
        (SELECT STRING_AGG(s2.no_pedido, ', ' ORDER BY s2.no_pedido)
         FROM nota_remision_envio nre2
         JOIN envio e2     ON e2.idenvio     = nre2.envio_idenvio
         JOIN solicitud s2 ON s2.idsolicitud = e2.solicitud_idsolicitud
         WHERE nre2.nota_remision_idnota = nr.idnota) AS no_pedido,
        (SELECT COALESCE(cli2.impresion, cli2.empresa, cli2.razon_social, '')
         FROM nota_remision_envio nre2
         JOIN envio e2      ON e2.idenvio      = nre2.envio_idenvio
         JOIN solicitud s2  ON s2.idsolicitud  = e2.solicitud_idsolicitud
         JOIN clientes cli2 ON cli2.idclientes = s2.clientes_idclientes
         WHERE nre2.nota_remision_idnota = nr.idnota
         ORDER BY e2.idenvio ASC
         LIMIT 1) AS cliente,
        (SELECT COUNT(DISTINCT nre2.envio_idenvio)
         FROM nota_remision_envio nre2
         WHERE nre2.nota_remision_idnota = nr.idnota) AS total_pedidos,
        (SELECT COUNT(eb2.idenvio_bulto)
         FROM nota_remision_envio nre2
         JOIN envio_bulto eb2 ON eb2.envio_idenvio = nre2.envio_idenvio
         WHERE nre2.nota_remision_idnota = nr.idnota) AS total_bultos,
        u.idusuario  AS chofer_id,
        u.nombre     AS chofer_nombre,
        u.apellido   AS chofer_apellido,
        un.idunidad  AS unidad_id,
        un.marca     AS unidad_marca,
        un.modelo    AS unidad_modelo,
        un.placa     AS unidad_placa
      FROM nota_remision nr
      LEFT JOIN usuarios u  ON u.idusuario = nr.chofer_idusuario
      LEFT JOIN unidades un ON un.idunidad = nr.unidad_idunidad
      WHERE nr.es_multi = TRUE
        AND EXISTS (
          SELECT 1 FROM nota_remision_envio nre
          WHERE nre.nota_remision_idnota = nr.idnota
        )
      ORDER BY nr.created_at DESC
    `);

    res.json(rows.map((r: any) => ({
      idnota: Number(r.idnota),
      no_nota: r.no_nota,
      created_at: r.created_at,
      es_multi: Boolean(r.es_multi),
      tipo_entrega: r.tipo_entrega,
      estado: r.estado || "pendiente",
      observaciones: r.observaciones || null,
      no_pedido: r.no_pedido || "",
      cliente: r.cliente || "",
      total_pedidos: Number(r.total_pedidos),
      total_bultos: Number(r.total_bultos),
      recoleccion_datos: r.recoleccion_nombre_quien_recogio ? {
        nombre_quien_recogio: r.recoleccion_nombre_quien_recogio,
        empresa: r.recoleccion_empresa || null,
        unidad_marca: r.recoleccion_unidad_marca || null,
        unidad_modelo: r.recoleccion_unidad_modelo || null,
        unidad_placas: r.recoleccion_unidad_placas || null,
        fecha: r.recoleccion_fecha || null,
      } : null,
      local_datos: (r.local_hora_salida != null || r.local_hora_llegada != null || r.local_firma != null || r.local_observacion != null) ? {
        hora_salida: r.local_hora_salida ? r.local_hora_salida.toISOString() : null,
        hora_llegada: r.local_hora_llegada ? r.local_hora_llegada.toISOString() : null,
        observacion: r.local_observacion || null,
        observacion_extra: r.local_observacion_extra || null,
        firma: r.local_firma || null,
      } : null,
      chofer: r.chofer_id ? {
        idusuario: Number(r.chofer_id),
        nombre: `${r.chofer_nombre} ${r.chofer_apellido}`,
      } : null,
      unidad: r.unidad_id ? {
        idunidad: Number(r.unidad_id),
        nombre: `${r.unidad_marca} ${r.unidad_modelo} — ${r.unidad_placa}`,
      } : null,
    })));
  } catch (error: any) {
    console.error("❌ GET NOTAS BITACORA ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener notas de remisión" });
  }
};

// ==========================
// MARCAR SALIDA LOCAL (NUEVO)
// PATCH /notas-remision/:idnota/marcar-salida-local
// ==========================
export const marcarSalidaLocalNota = async (req: Request, res: Response) => {
  try {
    const { idnota } = req.params;

    const result = await pool.query(
      `UPDATE nota_remision
       SET local_hora_salida = NOW()
       WHERE idnota = $1
         AND tipo_entrega = 'local'
         AND local_hora_salida IS NULL
       RETURNING idnota`,
      [idnota]
    );

    if (!result.rowCount)
      return res.status(400).json({ error: "Nota no encontrada o salida ya registrada" });

    await pool.query(
      `UPDATE envio SET estado = 'en_camino'
       WHERE idenvio IN (
         SELECT envio_idenvio FROM nota_remision_envio
         WHERE nota_remision_idnota = $1
       )`,
      [idnota]
    );

    res.json({ message: "Salida registrada correctamente" });
  } catch (error: any) {
    console.error("❌ MARCAR SALIDA LOCAL NOTA ERROR:", error.message);
    res.status(500).json({ error: "Error al registrar salida" });
  }
};

// ==========================
// MARCAR LLEGADA / ENTREGA LOCAL
// PATCH /notas-remision/:idnota/marcar-entregado-local
// ==========================
export const marcarEntregadoLocalNota = async (req: Request, res: Response) => {
  try {
    const { idnota } = req.params;
    const { hora_llegada, observacion, observacion_extra, firma } = req.body;

    const observacionesValidas = ["E", "RA", "RD", "PD"];
    if (observacion && !observacionesValidas.includes(observacion))
      return res.status(400).json({ error: "Observación inválida. Valores: E, RA, RD, PD" });

    const result = await pool.query(
      `UPDATE nota_remision
       SET estado                  = 'entregado',
           local_hora_llegada      = COALESCE($1::timestamp, NOW()),
           local_observacion       = COALESCE($2, local_observacion),
           local_observacion_extra = COALESCE($3, local_observacion_extra),
           local_firma             = COALESCE($4, local_firma)
       WHERE idnota = $5
       RETURNING idnota`,
      [
        hora_llegada      || null,
        observacion       || null,
        observacion_extra || null,
        firma             || null,
        idnota,
      ]
    );

    if (!result.rowCount)
      return res.status(404).json({ error: "Nota no encontrada" });

    await pool.query(
      `UPDATE envio SET estado = 'entregado'
       WHERE idenvio IN (
         SELECT envio_idenvio FROM nota_remision_envio
         WHERE nota_remision_idnota = $1
       )`,
      [idnota]
    );

    res.json({ message: "Entrega registrada correctamente" });
  } catch (error: any) {
    console.error("❌ MARCAR ENTREGADO LOCAL NOTA ERROR:", error.message);
    res.status(500).json({ error: "Error al registrar entrega" });
  }
};

// ==========================
// MARCAR NOTA COMO RECOLECTADA
// PATCH /notas-remision/:idnota/marcar-recogido
// ==========================
export const marcarRecolectadoNota = async (req: Request, res: Response) => {
  try {
    const { idnota } = req.params;
    const { nombre_quien_recogio, empresa, unidad_marca, unidad_modelo, unidad_placas } = req.body;

    if (!nombre_quien_recogio?.trim())
      return res.status(400).json({ error: "El nombre de quien recogió es requerido" });

    const result = await pool.query(
      `UPDATE nota_remision
       SET recoleccion_nombre_quien_recogio = $1,
           recoleccion_empresa              = $2,
           recoleccion_unidad_marca         = $3,
           recoleccion_unidad_modelo        = $4,
           recoleccion_unidad_placas        = $5,
           recoleccion_fecha                = NOW(),
           estado                           = 'entregado'
       WHERE idnota = $6
       RETURNING idnota`,
      [
        nombre_quien_recogio.trim(),
        empresa?.trim()       || null,
        unidad_marca?.trim()  || null,
        unidad_modelo?.trim() || null,
        unidad_placas?.trim() || null,
        idnota,
      ]
    );

    if (!result.rowCount)
      return res.status(404).json({ error: "Nota no encontrada" });

    await pool.query(
      `UPDATE envio SET estado = 'entregado'
       WHERE idenvio IN (
         SELECT envio_idenvio FROM nota_remision_envio
         WHERE nota_remision_idnota = $1
       )`,
      [idnota]
    );

    res.json({ message: "Recolección registrada correctamente" });
  } catch (error: any) {
    console.error("❌ MARCAR RECOLECTADO NOTA ERROR:", error.message);
    res.status(500).json({ error: "Error al registrar recolección" });
  }
};

// ==========================
// HELPER INTERNO
// ==========================
async function _getDatosNotaMulti(idnota: number) {
  const { rows: notaRows } = await pool.query(
    `SELECT nr.idnota, nr.no_nota, nr.created_at, nr.tipo_entrega, nr.observaciones,
            u.nombre AS chofer_nombre, u.apellido AS chofer_apellido,
            un.marca AS unidad_marca, un.modelo AS unidad_modelo, un.placa AS unidad_placa
     FROM nota_remision nr
     LEFT JOIN usuarios  u  ON u.idusuario  = nr.chofer_idusuario
     LEFT JOIN unidades  un ON un.idunidad  = nr.unidad_idunidad
     WHERE nr.idnota = $1`,
    [idnota]
  );
  if (!notaRows.length) return null;
  const nota = notaRows[0];

  const { rows: enviosRows } = await pool.query(
    `SELECT e.idenvio, e.fecha_envio, s.no_pedido, s.idsolicitud,
            cli.empresa, cli.impresion, cli.razon_social,
            df.rfc,
            COALESCE(de.domicilio, d.domicilio)         AS calle_envio,
            COALESCE(de.numero,    d.numero)             AS numero_envio,
            COALESCE(de.colonia,   d.colonia)            AS colonia_envio,
            COALESCE(de.codigo_postal, d.codigo_postal)  AS cp_envio,
            COALESCE(de.poblacion, d.poblacion)          AS poblacion_envio,
            COALESCE(de.estado,    d.estado)             AS estado_envio
     FROM nota_remision_envio nre
     JOIN envio e         ON e.idenvio             = nre.envio_idenvio
     JOIN solicitud s     ON s.idsolicitud          = e.solicitud_idsolicitud
     JOIN clientes cli    ON cli.idclientes         = s.clientes_idclientes
     LEFT JOIN domicilio d          ON d.clientes_idclientes  = cli.idclientes
     LEFT JOIN datos_facturacion df ON df.clientes_idclientes = cli.idclientes
     LEFT JOIN direccion_envio de   ON de.clientes_idclientes = cli.idclientes
     WHERE nre.nota_remision_idnota = $1
     ORDER BY e.idenvio`,
    [idnota]
  );

  const envioIds = enviosRows.map((e: any) => e.idenvio);

  const { rows: productosRows } = await pool.query(
    `SELECT
       tpp.material_plastico_producto AS nombre_producto,
       cfg.medida,
       sp.descripcion,
       s.no_pedido,
       COUNT(b.idbulto)               AS total_bultos,
       SUM(COALESCE(b.cantidad_unidades, 0)) AS total_unidades,
       SUM(COALESCE(b.peso_producto,    0))  AS total_kg,
       MIN(b.cantidad_unidades) AS modo_unidad,
       MIN(b.peso_producto)     AS modo_kg
     FROM envio_bulto eb
     JOIN envio e     ON e.idenvio      = eb.envio_idenvio
     JOIN solicitud s ON s.idsolicitud  = e.solicitud_idsolicitud
     JOIN bultos b ON b.idbulto = eb.bultos_idbulto
     LEFT JOIN bolseo bol ON bol.idbolseo = b.bolseo_idbolseo
     LEFT JOIN asa_flexible af ON af.idasa_flexible = b.asa_flexible_idasa_flexible
     LEFT JOIN orden_produccion op
       ON op.idproduccion = COALESCE(bol.orden_produccion_idproduccion, af.orden_produccion_idproduccion)
     LEFT JOIN solicitud_producto sp ON sp.idsolicitud_producto = op.idsolicitud_producto
     LEFT JOIN configuracion_plastico cfg ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
     LEFT JOIN tipo_producto_plastico tpp ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
     WHERE eb.envio_idenvio = ANY($1::int[])
     GROUP BY tpp.material_plastico_producto, cfg.medida, sp.descripcion, s.no_pedido
     ORDER BY s.no_pedido, tpp.material_plastico_producto`,
    [envioIds]
  );

  const primerEnvio = enviosRows[0];

  return {
    idnota: Number(nota.idnota),
    no_nota: nota.no_nota,
    created_at: nota.created_at,
    es_multi: true,
    tipo_entrega: nota.tipo_entrega,
    observaciones: nota.observaciones || null,
    chofer: nota.chofer_nombre ? { nombre: `${nota.chofer_nombre} ${nota.chofer_apellido}` } : null,
    unidad: nota.unidad_marca ? { nombre: `${nota.unidad_marca} ${nota.unidad_modelo} — ${nota.unidad_placa}` } : null,
    envio: {
      idenvio: null,
      tipo: nota.tipo_entrega,
      fecha_envio: primerEnvio?.fecha_envio ?? new Date().toISOString(),
      no_pedido: enviosRows.map((e: any) => e.no_pedido).join(", "),
      observaciones: null,
    },
    cliente: {
      nombre: primerEnvio ? (primerEnvio.impresion || primerEnvio.empresa || primerEnvio.razon_social || "") : "",
      rfc: primerEnvio?.rfc || "",
      direccion: primerEnvio ? [
        primerEnvio.calle_envio, primerEnvio.numero_envio,
        primerEnvio.colonia_envio, primerEnvio.poblacion_envio, primerEnvio.estado_envio,
      ].filter(Boolean).join(", ") : "",
    },
    pedidos: enviosRows.map((e: any) => ({
      idsolicitud: e.idsolicitud,
      no_pedido: e.no_pedido,
      idenvio: e.idenvio,
    })),
    productos: productosRows.map((p: any) => ({
      nombre_producto: p.nombre_producto,
      medida: p.medida,
      descripcion: p.descripcion || null,
      no_pedido: p.no_pedido,
      total_bultos: Number(p.total_bultos),
      total_unidades: p.modo_unidad != null ? Number(p.total_unidades) : null,
      total_kg: p.modo_kg != null ? Number(p.total_kg) : null,
    })),
  };
}

// ==========================
// GET NOTA SIMPLE
// GET /notas-remision/:idenvio
// ==========================
export const getOrCreateNota = async (req: Request, res: Response) => {
  try {
    const { idenvio } = req.params;

    const existente = await pool.query(
      `SELECT idnota, no_nota, created_at, observaciones FROM nota_remision WHERE envio_idenvio = $1`,
      [idenvio]
    );

    let no_nota: string;
    let idnota: number;
    let created_at: Date;
    let observaciones: string | null = null;

    if (existente.rows.length > 0) {
      no_nota       = existente.rows[0].no_nota;
      idnota        = existente.rows[0].idnota;
      created_at    = existente.rows[0].created_at;
      observaciones = existente.rows[0].observaciones || null;
    } else {
      const anio = new Date().getFullYear();
      const prefijo = `N${anio}`;

      const ultimo = await pool.query(
        `SELECT no_nota FROM nota_remision WHERE no_nota LIKE $1 ORDER BY idnota DESC LIMIT 1`,
        [`${prefijo}%`]
      );

      let consecutivo = 1;
      if (ultimo.rows.length > 0) {
        const noActual = ultimo.rows[0].no_nota as string;
        consecutivo = parseInt(noActual.replace(prefijo, ""), 10) + 1;
      }

      no_nota = `${prefijo}${String(consecutivo).padStart(3, "0")}`;

      const nueva = await pool.query(
        `INSERT INTO nota_remision (no_nota, envio_idenvio) VALUES ($1, $2)
         RETURNING idnota, no_nota, created_at`,
        [no_nota, idenvio]
      );
      idnota     = nueva.rows[0].idnota;
      created_at = nueva.rows[0].created_at;
    }

    const { rows } = await pool.query(`
      SELECT
        e.idenvio, e.tipo, e.fecha_envio, e.observaciones,
        s.no_pedido,
        cli.empresa, cli.impresion, cli.razon_social,
        df.rfc,
        COALESCE(de.domicilio, d.domicilio)         AS calle_envio,
        COALESCE(de.numero,    d.numero)             AS numero_envio,
        COALESCE(de.colonia,   d.colonia)            AS colonia_envio,
        COALESCE(de.codigo_postal, d.codigo_postal)  AS cp_envio,
        COALESCE(de.poblacion, d.poblacion)          AS poblacion_envio,
        COALESCE(de.estado,    d.estado)             AS estado_envio
      FROM envio e
      JOIN solicitud s               ON s.idsolicitud              = e.solicitud_idsolicitud
      JOIN clientes cli              ON cli.idclientes             = s.clientes_idclientes
      LEFT JOIN domicilio d          ON d.clientes_idclientes      = cli.idclientes
      LEFT JOIN datos_facturacion df ON df.clientes_idclientes     = cli.idclientes
      LEFT JOIN direccion_envio de   ON de.clientes_idclientes     = cli.idclientes
      WHERE e.idenvio = $1 LIMIT 1
    `, [idenvio]);

    if (!rows.length) return res.status(404).json({ error: "Envio no encontrado" });

    const envio = rows[0];

    const { rows: productos } = await pool.query(`
      SELECT
        tpp.material_plastico_producto AS nombre_producto,
        cfg.medida,
        sp.descripcion,
        COUNT(b.idbulto)               AS total_bultos,
        SUM(COALESCE(b.cantidad_unidades, 0)) AS total_unidades,
        SUM(COALESCE(b.peso_producto,    0))  AS total_kg,
        MIN(b.cantidad_unidades) AS modo_unidad,
        MIN(b.peso_producto)     AS modo_kg
      FROM envio_bulto eb
      JOIN bultos b ON b.idbulto = eb.bultos_idbulto
      LEFT JOIN bolseo bol ON bol.idbolseo = b.bolseo_idbolseo
      LEFT JOIN asa_flexible af ON af.idasa_flexible = b.asa_flexible_idasa_flexible
      LEFT JOIN orden_produccion op
        ON op.idproduccion = COALESCE(bol.orden_produccion_idproduccion, af.orden_produccion_idproduccion)
      LEFT JOIN solicitud_producto sp ON sp.idsolicitud_producto = op.idsolicitud_producto
      LEFT JOIN configuracion_plastico cfg ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN tipo_producto_plastico tpp ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      WHERE eb.envio_idenvio = $1
      GROUP BY tpp.material_plastico_producto, cfg.medida, sp.descripcion
      ORDER BY tpp.material_plastico_producto
    `, [idenvio]);

    res.json({
      idnota,
      no_nota,
      created_at,
      observaciones,
      envio: {
        idenvio:       Number(envio.idenvio),
        tipo:          envio.tipo,
        fecha_envio:   envio.fecha_envio,
        no_pedido:     envio.no_pedido,
        observaciones: envio.observaciones,
      },
      cliente: {
        nombre:    envio.impresion || envio.empresa || envio.razon_social || "",
        rfc:       envio.rfc || "",
        direccion: [envio.calle_envio, envio.numero_envio, envio.colonia_envio, envio.poblacion_envio, envio.estado_envio]
          .filter(Boolean).join(", "),
      },
      productos: productos.map((p: any) => ({
        nombre_producto: p.nombre_producto,
        medida:          p.medida,
        descripcion:     p.descripcion || null,
        total_bultos:    Number(p.total_bultos),
        total_unidades:  p.modo_unidad != null ? Number(p.total_unidades) : null,
        total_kg:        p.modo_kg     != null ? Number(p.total_kg)       : null,
      })),
    });
  } catch (error: any) {
    console.error("❌ GET OR CREATE NOTA ERROR:", error.message);
    res.status(500).json({ error: "Error al generar nota de remision" });
  }
};