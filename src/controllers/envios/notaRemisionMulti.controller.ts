import { Request, Response } from "express";
import { pool } from "../../config/db";

// ==========================
// CREAR NOTA DE REMISIÓN MULTI-PEDIDO
// POST /notas-remision/multi
// Body: {
//   envios_ids: number[],          // ids de los envíos ya creados
//   tipo_entrega: 'recoleccion' | 'local',
//   chofer_idusuario?: number,     // solo si tipo_entrega === 'local'
//   unidad_idunidad?: number,
// }
// ==========================
export const crearNotaMulti = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { envios_ids, tipo_entrega, chofer_idusuario, unidad_idunidad } = req.body;

    if (!envios_ids?.length)
      return res.status(400).json({ error: "envios_ids es requerido" });

    if (!["recoleccion", "local"].includes(tipo_entrega))
      return res.status(400).json({ error: "tipo_entrega debe ser 'recoleccion' o 'local'" });

    if (tipo_entrega === "local" && (!chofer_idusuario || !unidad_idunidad))
      return res.status(400).json({ error: "Para entrega local se requiere chofer y unidad" });

    // Generar número de nota: N + año + consecutivo
    const anio   = new Date().getFullYear();
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

    // Insertar nota (envio_idenvio = null porque es multi)
    const { rows: notaRows } = await client.query(
      `INSERT INTO nota_remision (no_nota, envio_idenvio, es_multi, tipo_entrega, chofer_idusuario, unidad_idunidad)
       VALUES ($1, NULL, TRUE, $2, $3, $4)
       RETURNING idnota, no_nota, created_at`,
      [no_nota, tipo_entrega, chofer_idusuario || null, unidad_idunidad || null]
    );

    const idnota = notaRows[0].idnota;

    // Relacionar con cada envío
    for (const idenvio of envios_ids) {
      await client.query(
        `INSERT INTO nota_remision_envio (nota_remision_idnota, envio_idenvio)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [idnota, idenvio]
      );
    }

    await client.query("COMMIT");

    // Obtener datos completos para el PDF
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
// HELPER INTERNO — construye el objeto completo de la nota multi
// ==========================
async function _getDatosNotaMulti(idnota: number) {
  // Datos de la nota
  const { rows: notaRows } = await pool.query(
    `SELECT nr.idnota, nr.no_nota, nr.created_at, nr.tipo_entrega,
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

  // Envíos vinculados
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

  // Productos agrupados de TODOS los envíos de esta nota
  const envioIds = enviosRows.map((e: any) => e.idenvio);

  const { rows: productosRows } = await pool.query(
    `SELECT
       tpp.material_plastico_producto AS nombre_producto,
       cfg.medida,
       s.no_pedido,
       COUNT(b.idbulto)               AS total_bultos,
       SUM(COALESCE(b.cantidad_unidades, 0)) AS total_unidades,
       SUM(COALESCE(b.peso_producto,    0))  AS total_kg,
       MIN(b.cantidad_unidades) AS modo_unidad,
       MIN(b.peso_producto)     AS modo_kg
     FROM envio_bulto eb
     JOIN envio e    ON e.idenvio   = eb.envio_idenvio
     JOIN solicitud s ON s.idsolicitud = e.solicitud_idsolicitud
     JOIN bultos b ON b.idbulto = eb.bultos_idbulto
     LEFT JOIN bolseo bol ON bol.idbolseo = b.bolseo_idbolseo
     LEFT JOIN asa_flexible af ON af.idasa_flexible = b.asa_flexible_idasa_flexible
     LEFT JOIN orden_produccion op
       ON op.idproduccion = COALESCE(bol.orden_produccion_idproduccion, af.orden_produccion_idproduccion)
     LEFT JOIN solicitud_producto sp ON sp.idsolicitud_producto = op.idsolicitud_producto
     LEFT JOIN configuracion_plastico cfg ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
     LEFT JOIN tipo_producto_plastico tpp ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
     WHERE eb.envio_idenvio = ANY($1::int[])
     GROUP BY tpp.material_plastico_producto, cfg.medida, s.no_pedido
     ORDER BY s.no_pedido, tpp.material_plastico_producto`,
    [envioIds]
  );

  // Usar el primer envío para datos del cliente (en multi puede haber varios clientes,
  // pero en la práctica es siempre la misma empresa con distintos pedidos)
  const primerEnvio = enviosRows[0];

  return {
    idnota:       Number(nota.idnota),
    no_nota:      nota.no_nota,
    created_at:   nota.created_at,
    es_multi:     true,
    tipo_entrega: nota.tipo_entrega,
    chofer: nota.chofer_nombre ? {
      nombre: `${nota.chofer_nombre} ${nota.chofer_apellido}`,
    } : null,
    unidad: nota.unidad_marca ? {
      nombre: `${nota.unidad_marca} ${nota.unidad_modelo} — ${nota.unidad_placa}`,
    } : null,
    // Para la NR multi tomamos la fecha del primer envío
    envio: {
      idenvio:       null,
      tipo:          nota.tipo_entrega,
      fecha_envio:   primerEnvio?.fecha_envio ?? new Date().toISOString(),
      // Lista de no_pedidos separada por coma para encabezado
      no_pedido:     enviosRows.map((e: any) => e.no_pedido).join(", "),
      observaciones: null,
    },
    cliente: {
      nombre:    primerEnvio ? (primerEnvio.impresion || primerEnvio.empresa || primerEnvio.razon_social || "") : "",
      rfc:       primerEnvio?.rfc || "",
      direccion: primerEnvio ? [
        primerEnvio.calle_envio, primerEnvio.numero_envio,
        primerEnvio.colonia_envio, primerEnvio.poblacion_envio, primerEnvio.estado_envio,
      ].filter(Boolean).join(", ") : "",
    },
    // Pedidos individuales (para mostrar desglose)
    pedidos: enviosRows.map((e: any) => ({
      idsolicitud: e.idsolicitud,
      no_pedido:   e.no_pedido,
      idenvio:     e.idenvio,
    })),
    productos: productosRows.map((p: any) => ({
      nombre_producto: p.nombre_producto,
      medida:          p.medida,
      no_pedido:       p.no_pedido,
      total_bultos:    Number(p.total_bultos),
      total_unidades:  p.modo_unidad != null ? Number(p.total_unidades) : null,
      total_kg:        p.modo_kg     != null ? Number(p.total_kg)       : null,
    })),
  };
}

// ==========================
// GET NOTA SIMPLE (ruta original, con retrocompat)
// GET /notas-remision/:idenvio
// ==========================
export const getOrCreateNota = async (req: Request, res: Response) => {
  try {
    const { idenvio } = req.params;

    const existente = await pool.query(
      `SELECT idnota, no_nota, created_at FROM nota_remision WHERE envio_idenvio = $1`,
      [idenvio]
    );

    let no_nota: string;
    let idnota: number;
    let created_at: Date;

    if (existente.rows.length > 0) {
      no_nota    = existente.rows[0].no_nota;
      idnota     = existente.rows[0].idnota;
      created_at = existente.rows[0].created_at;
    } else {
      const anio   = new Date().getFullYear();
      const prefijo = `N${anio}`;

      const ultimo = await pool.query(
        `SELECT no_nota FROM nota_remision WHERE no_nota LIKE $1 ORDER BY idnota DESC LIMIT 1`,
        [`${prefijo}%`]
      );

      let consecutivo = 1;
      if (ultimo.rows.length > 0) {
        const noActual = ultimo.rows[0].no_nota as string;
        consecutivo    = parseInt(noActual.replace(prefijo, ""), 10) + 1;
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
      GROUP BY tpp.material_plastico_producto, cfg.medida
      ORDER BY tpp.material_plastico_producto
    `, [idenvio]);

    res.json({
      idnota,
      no_nota,
      created_at,
      envio: {
        idenvio:       Number(envio.idenvio),
        tipo:          envio.tipo,
        fecha_envio:   envio.fecha_envio,
        no_pedido:     envio.no_pedido,
        observaciones: envio.observaciones,
      },
      cliente: {
        nombre:    envio.impresion || envio.empresa || envio.razon_social || "",
        rfc:       envio.rfc       || "",
        direccion: [envio.calle_envio, envio.numero_envio, envio.colonia_envio, envio.poblacion_envio, envio.estado_envio]
                     .filter(Boolean).join(", "),
      },
      productos: productos.map((p: any) => ({
        nombre_producto: p.nombre_producto,
        medida:          p.medida,
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


