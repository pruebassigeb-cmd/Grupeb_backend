import { Request, Response } from "express";
import { pool } from "../../config/db";

// ==========================
// OBTENER PEDIDOS DISPONIBLES PARA ENVÍO
// ==========================
export const getPedidosDisponibles = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT
        s.idsolicitud,
        s.no_pedido,
        s.fecha,
        cli.idclientes,
        cli.empresa,
        cli.razon_social,
        cli.impresion,
        cli.telefono,
        cli.celular,
        COALESCE(de.domicilio,     dom.domicilio)     AS calle,
        COALESCE(de.numero,        dom.numero)        AS numero,
        COALESCE(de.colonia,       dom.colonia)       AS colonia,
        COALESCE(de.codigo_postal, dom.codigo_postal) AS codigo_postal,
        COALESCE(de.poblacion,     dom.poblacion)     AS poblacion,
        COALESCE(de.estado,        dom.estado)        AS estado,
        de.referencia                                 AS referencia_envio,
        COUNT(DISTINCT b.idbulto)                     AS total_bultos,
        COUNT(DISTINCT eb.bultos_idbulto)             AS bultos_enviados,
        COUNT(DISTINCT b.idbulto) - COUNT(DISTINCT eb.bultos_idbulto) AS bultos_pendientes,
        MAX(e.fecha_envio)                            AS ultimo_envio
      FROM solicitud s
      JOIN clientes cli ON cli.idclientes = s.clientes_idclientes
      LEFT JOIN domicilio dom      ON dom.clientes_idclientes  = cli.idclientes
      LEFT JOIN direccion_envio de ON de.clientes_idclientes   = cli.idclientes
      JOIN ventas v ON v.solicitud_idsolicitud = s.idsolicitud
      JOIN solicitud_producto sp ON sp.solicitud_idsolicitud = s.idsolicitud
      JOIN orden_produccion op ON op.idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN bolseo bol ON bol.orden_produccion_idproduccion = op.idproduccion
      LEFT JOIN asa_flexible af ON af.orden_produccion_idproduccion = op.idproduccion
      LEFT JOIN bultos b ON (
        b.bolseo_idbolseo IN (SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = op.idproduccion)
        OR
        b.asa_flexible_idasa_flexible IN (SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = op.idproduccion)
      )
      LEFT JOIN envio_bulto eb ON eb.bultos_idbulto = b.idbulto
      LEFT JOIN envio e ON e.idenvio = eb.envio_idenvio
      WHERE
        s.estado = 'pedido'
        AND s.no_pedido IS NOT NULL
        AND (
          v.saldo <= 0.01
          OR v.estado_administrativo_cat_idestado_administrativo_cat IN (2, 6)
          OR bol.estado_produccion_cat_idestado_produccion_cat IN (2, 3)
          OR af.estado_produccion_cat_idestado_produccion_cat IN (2, 3)
        )
        AND b.idbulto IS NOT NULL
      GROUP BY
        s.idsolicitud, s.no_pedido, s.fecha,
        cli.idclientes, cli.empresa, cli.razon_social, cli.impresion,
        cli.telefono, cli.celular,
        de.domicilio, dom.domicilio,
        de.numero, dom.numero,
        de.colonia, dom.colonia,
        de.codigo_postal, dom.codigo_postal,
        de.poblacion, dom.poblacion,
        de.estado, dom.estado,
        de.referencia
      HAVING
        (COUNT(DISTINCT b.idbulto) - COUNT(DISTINCT eb.bultos_idbulto)) > 0
        OR (
          COUNT(DISTINCT b.idbulto) - COUNT(DISTINCT eb.bultos_idbulto) = 0
          AND MAX(e.fecha_envio) >= NOW() - INTERVAL '7 days'
        )
      ORDER BY s.no_pedido DESC
    `);

    const resultado = rows.map((row: any) => {
      const totalBultos      = Number(row.total_bultos);
      const bultosEnviados   = Number(row.bultos_enviados);
      const bultosPendientes = Number(row.bultos_pendientes);

      let estado_envio: "sin_iniciar" | "parcial" | "completo";
      if (bultosEnviados === 0)        estado_envio = "sin_iniciar";
      else if (bultosPendientes === 0) estado_envio = "completo";
      else                             estado_envio = "parcial";

      return {
        idsolicitud:              Number(row.idsolicitud),
        no_pedido:                row.no_pedido,
        fecha:                    row.fecha,
        idclientes:               Number(row.idclientes),
        empresa:                  row.empresa          || "",
        razon_social:             row.razon_social     || "",
        impresion:                row.impresion        || "",
        telefono:                 row.telefono         || "",
        celular:                  row.celular          || "",
        calle:                    row.calle            || "",
        numero:                   row.numero           || "",
        colonia:                  row.colonia          || "",
        codigo_postal:            row.codigo_postal    || "",
        poblacion:                row.poblacion        || "",
        estado:                   row.estado           || "",
        referencia_envio:         row.referencia_envio || null,
        total_bultos:             totalBultos,
        bultos_enviados:          bultosEnviados,
        bultos_pendientes:        bultosPendientes,
        estado_envio,
        completado_recientemente: bultosPendientes === 0 && bultosEnviados > 0,
      };
    });

    res.json(resultado);
  } catch (error: any) {
    console.error("❌ GET PEDIDOS DISPONIBLES ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener pedidos disponibles" });
  }
};

// ==========================
// OBTENER BULTOS DE UN PEDIDO
// ==========================
export const getBultosPedido = async (req: Request, res: Response) => {
  try {
    const { idsolicitud } = req.params;

    const { rows } = await pool.query(`
      SELECT
        b.idbulto,
        b.cantidad_unidades,
        b.peso_producto,
        b.peso,
        b.alto,
        b.largo,
        b.ancho,
        b.fecha_creacion,
        CASE
          WHEN b.asa_flexible_idasa_flexible IS NOT NULL THEN 'asa_flexible'
          ELSE 'bolseo'
        END AS proceso_origen,
        op.no_produccion,
        sp.idsolicitud_producto,
        tpp.material_plastico_producto AS nombre_producto,
        cfg.medida,
        CASE
          WHEN eb.bultos_idbulto IS NOT NULL THEN
            CASE
              WHEN e.estado = 'entregado' THEN 'entregado'
              WHEN e.estado = 'en_camino' THEN 'en_camino'
              ELSE 'preparando'
            END
          ELSE 'sin_enviar'
        END AS estado_bulto,
        e.idenvio,
        e.estado AS estado_envio
      FROM solicitud_producto sp
      JOIN orden_produccion op ON op.idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN bolseo bol ON bol.orden_produccion_idproduccion = op.idproduccion
      LEFT JOIN asa_flexible af ON af.orden_produccion_idproduccion = op.idproduccion
      LEFT JOIN bultos b ON (
        b.bolseo_idbolseo = bol.idbolseo
        OR b.asa_flexible_idasa_flexible = af.idasa_flexible
      )
      LEFT JOIN envio_bulto eb ON eb.bultos_idbulto = b.idbulto
      LEFT JOIN envio e ON e.idenvio = eb.envio_idenvio
      LEFT JOIN configuracion_plastico cfg
        ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN tipo_producto_plastico tpp
        ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      WHERE sp.solicitud_idsolicitud = $1
        AND b.idbulto IS NOT NULL
      ORDER BY b.idbulto ASC
    `, [idsolicitud]);

    res.json(rows.map((r: any) => ({
      idbulto:           Number(r.idbulto),
      cantidad_unidades: r.cantidad_unidades != null ? Number(r.cantidad_unidades) : null,
      peso_producto:     r.peso_producto     != null ? Number(r.peso_producto)     : null,
      peso:              r.peso              != null ? Number(r.peso)              : null,
      alto:              r.alto              != null ? Number(r.alto)              : null,
      largo:             r.largo             != null ? Number(r.largo)             : null,
      ancho:             r.ancho             != null ? Number(r.ancho)             : null,
      fecha_creacion:    r.fecha_creacion,
      proceso_origen:    r.proceso_origen,
      no_produccion:     r.no_produccion,
      nombre_producto:   r.nombre_producto   || "",
      medida:            r.medida            || "",
      estado_bulto:      r.estado_bulto,
      idenvio:           r.idenvio != null ? Number(r.idenvio) : null,
      estado_envio:      r.estado_envio      || null,
    })));
  } catch (error: any) {
    console.error("❌ GET BULTOS PEDIDO ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener bultos del pedido" });
  }
};

// ==========================
// CREAR ENVÍO
// ==========================
export const createEnvio = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const {
      idsolicitud,
      tipo,
      usuarios_idusuario,
      unidades_idunidad,
      paqueteria_idpaqueteria,
      numero_guia,
      costo_flete,
      fecha_entrega_estimada,
      observaciones,
      bultos_ids,
    } = req.body;

    if (!idsolicitud || !tipo || !bultos_ids || !Array.isArray(bultos_ids) || bultos_ids.length === 0)
      return res.status(400).json({ error: "Faltan datos requeridos" });

    if (!["local", "paqueteria"].includes(tipo))
      return res.status(400).json({ error: "Tipo de envío inválido" });

    if (tipo === "local" && (!usuarios_idusuario || !unidades_idunidad))
      return res.status(400).json({ error: "Para envío local se requiere chofer y unidad" });

    if (tipo === "paqueteria" && !paqueteria_idpaqueteria)
      return res.status(400).json({ error: "Para envío por paquetería se requiere seleccionar una paquetería" });

    await client.query("BEGIN");

    // Verificar bultos no asignados
    const { rows: bultosOcupados } = await client.query(
      `SELECT bultos_idbulto FROM envio_bulto WHERE bultos_idbulto = ANY($1)`,
      [bultos_ids]
    );
    if (bultosOcupados.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `Los siguientes bultos ya están asignados: ${bultosOcupados.map((b: any) => b.bultos_idbulto).join(", ")}`,
      });
    }

    // Verificar que los bultos pertenecen al pedido
    const { rows: bultosValidos } = await client.query(`
      SELECT b.idbulto
      FROM bultos b
      LEFT JOIN bolseo bol ON bol.idbolseo = b.bolseo_idbolseo
      LEFT JOIN asa_flexible af ON af.idasa_flexible = b.asa_flexible_idasa_flexible
      LEFT JOIN orden_produccion op ON (
        op.idproduccion = bol.orden_produccion_idproduccion
        OR op.idproduccion = af.orden_produccion_idproduccion
      )
      LEFT JOIN solicitud_producto sp ON sp.idsolicitud_producto = op.idsolicitud_producto
      WHERE b.idbulto = ANY($1)
        AND sp.solicitud_idsolicitud = $2
    `, [bultos_ids, idsolicitud]);

    if (bultosValidos.length !== bultos_ids.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Algunos bultos no pertenecen a este pedido" });
    }

    // ── Calcular es_parcialidad ──
    const { rows: totalRows } = await client.query(`
      SELECT COUNT(DISTINCT b.idbulto) AS total
      FROM solicitud_producto sp
      JOIN orden_produccion op ON op.idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN bolseo bol ON bol.orden_produccion_idproduccion = op.idproduccion
      LEFT JOIN asa_flexible af ON af.orden_produccion_idproduccion = op.idproduccion
      LEFT JOIN bultos b ON (
        b.bolseo_idbolseo = bol.idbolseo
        OR b.asa_flexible_idasa_flexible = af.idasa_flexible
      )
      WHERE sp.solicitud_idsolicitud = $1
        AND b.idbulto IS NOT NULL
    `, [idsolicitud]);

    const totalBultosPedido = Number(totalRows[0].total);

    const { rows: yaEnviadosRows } = await client.query(`
      SELECT COUNT(DISTINCT eb.bultos_idbulto) AS enviados
      FROM envio_bulto eb
      JOIN envio e ON e.idenvio = eb.envio_idenvio
      WHERE e.solicitud_idsolicitud = $1
    `, [idsolicitud]);

    const bultosYaEnviados        = Number(yaEnviadosRows[0].enviados);
    const totalDespuesDeEsteEnvio = bultosYaEnviados + bultos_ids.length;

    const { rows: produccionRows } = await client.query(`
      SELECT
        COUNT(*) AS total_procesos,
        SUM(CASE WHEN op.idestado_produccion_cat = 3 THEN 1 ELSE 0 END) AS terminados
      FROM solicitud_producto sp
      JOIN orden_produccion op ON op.idsolicitud_producto = sp.idsolicitud_producto
      WHERE sp.solicitud_idsolicitud = $1
    `, [idsolicitud]);

    const totalProcesos      = Number(produccionRows[0].total_procesos);
    const terminados         = Number(produccionRows[0].terminados);
    const produccionCompleta = totalProcesos > 0 && totalProcesos === terminados;

    const es_parcialidad =
      !produccionCompleta ||
      totalDespuesDeEsteEnvio < totalBultosPedido;

    // Crear envío
    const { rows: envioRows } = await client.query(
      `INSERT INTO envio (
        solicitud_idsolicitud, tipo,
        usuarios_idusuario, unidades_idunidad,
        paqueteria_idpaqueteria, numero_guia,
        costo_flete, fecha_entrega_estimada, observaciones,
        es_parcialidad
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING idenvio, estado, fecha_envio, es_parcialidad`,
      [
        idsolicitud, tipo,
        tipo === "local"      ? usuarios_idusuario     : null,
        tipo === "local"      ? unidades_idunidad       : null,
        tipo === "paqueteria" ? paqueteria_idpaqueteria : null,
        tipo === "paqueteria" ? (numero_guia || null)   : null,
        costo_flete            || null,
        fecha_entrega_estimada || null,
        observaciones          || null,
        es_parcialidad,
      ]
    );

    const idenvio = envioRows[0].idenvio;

    for (const idbulto of bultos_ids) {
      await client.query(
        `INSERT INTO envio_bulto (envio_idenvio, bultos_idbulto) VALUES ($1,$2)`,
        [idenvio, idbulto]
      );
    }

    if (tipo === "local") {
      await client.query(
        `INSERT INTO bitacora_reparto (envio_idenvio, unidades_idunidad, usuarios_idusuario)
         VALUES ($1,$2,$3)`,
        [idenvio, unidades_idunidad, usuarios_idusuario]
      );
    }

    await client.query("COMMIT");
    console.log(`✅ Envío creado: ${idenvio} | parcialidad: ${es_parcialidad}`);

    res.status(201).json({
      message: "Envío creado exitosamente",
      envio: {
        idenvio,
        estado:         envioRows[0].estado,
        fecha_envio:    envioRows[0].fecha_envio,
        es_parcialidad: envioRows[0].es_parcialidad,
      },
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ CREATE ENVIO ERROR:", error.message);
    res.status(500).json({ error: "Error al crear envío" });
  } finally {
    client.release();
  }
};

// ==========================
// OBTENER ENVÍOS DE UN PEDIDO
// ==========================
export const getEnviosPedido = async (req: Request, res: Response) => {
  try {
    const { idsolicitud } = req.params;

    const { rows } = await pool.query(`
      SELECT
        e.idenvio,
        e.tipo,
        e.estado,
        e.numero_guia,
        e.costo_flete,
        e.fecha_envio,
        e.fecha_entrega_estimada,
        e.observaciones,
        e.es_parcialidad,
        u.idusuario,
        u.nombre   AS chofer_nombre,
        u.apellido AS chofer_apellido,
        un.idunidad,
        un.marca   AS unidad_marca,
        un.modelo  AS unidad_modelo,
        un.placa   AS unidad_placa,
        p.idpaqueteria,
        p.nombre   AS paqueteria_nombre,
        COUNT(eb.idenvio_bulto) AS total_bultos
      FROM envio e
      LEFT JOIN usuarios u     ON u.idusuario     = e.usuarios_idusuario
      LEFT JOIN unidades un    ON un.idunidad      = e.unidades_idunidad
      LEFT JOIN paqueteria p   ON p.idpaqueteria   = e.paqueteria_idpaqueteria
      LEFT JOIN envio_bulto eb ON eb.envio_idenvio = e.idenvio
      WHERE e.solicitud_idsolicitud = $1
      GROUP BY
        e.idenvio, e.tipo, e.estado, e.numero_guia, e.costo_flete,
        e.fecha_envio, e.fecha_entrega_estimada, e.observaciones, e.es_parcialidad,
        u.idusuario, u.nombre, u.apellido,
        un.idunidad, un.marca, un.modelo, un.placa,
        p.idpaqueteria, p.nombre
      ORDER BY e.idenvio DESC
    `, [idsolicitud]);

    res.json(rows.map((r: any) => ({
      idenvio:                Number(r.idenvio),
      tipo:                   r.tipo,
      estado:                 r.estado,
      es_parcialidad:         r.es_parcialidad,
      numero_guia:            r.numero_guia            || null,
      costo_flete:            r.costo_flete != null ? Number(r.costo_flete) : null,
      fecha_envio:            r.fecha_envio,
      fecha_entrega_estimada: r.fecha_entrega_estimada || null,
      observaciones:          r.observaciones          || null,
      chofer: r.idusuario ? {
        idusuario: Number(r.idusuario),
        nombre:    `${r.chofer_nombre} ${r.chofer_apellido}`,
      } : null,
      unidad: r.idunidad ? {
        idunidad: Number(r.idunidad),
        nombre:   `${r.unidad_marca} ${r.unidad_modelo} — ${r.unidad_placa}`,
      } : null,
      paqueteria: r.idpaqueteria ? {
        idpaqueteria: Number(r.idpaqueteria),
        nombre:       r.paqueteria_nombre,
      } : null,
      total_bultos: Number(r.total_bultos),
    })));
  } catch (error: any) {
    console.error("❌ GET ENVIOS PEDIDO ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener envíos del pedido" });
  }
};

// ==========================
// ACTUALIZAR ESTADO DEL ENVÍO
// ==========================
export const updateEstadoEnvio = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { estado } = req.body;

    if (!["preparando", "en_camino", "entregado"].includes(estado))
      return res.status(400).json({ error: "Estado inválido" });

    const result = await pool.query(
      `UPDATE envio SET estado = $1 WHERE idenvio = $2 RETURNING idenvio, estado`,
      [estado, id]
    );

    if ((result.rowCount ?? 0) === 0)
      return res.status(404).json({ error: "Envío no encontrado" });

    console.log("✅ Estado envío actualizado:", id, "→", estado);
    res.json({ message: "Estado actualizado exitosamente", envio: result.rows[0] });
  } catch (error: any) {
    console.error("❌ UPDATE ESTADO ENVIO ERROR:", error.message);
    res.status(500).json({ error: "Error al actualizar estado del envío" });
  }
};

// ==========================
// ELIMINAR ENVÍO
// ==========================
export const deleteEnvio = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query("BEGIN");

    const envioActual = await client.query(
      "SELECT estado FROM envio WHERE idenvio = $1 LIMIT 1", [id]
    );
    if ((envioActual.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Envío no encontrado" });
    }
    if (envioActual.rows[0].estado !== "preparando") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Solo se pueden cancelar envíos en estado 'preparando'" });
    }

    await client.query("DELETE FROM nota_remision WHERE envio_idenvio = $1", [id]);
    await client.query("DELETE FROM bitacora_reparto WHERE envio_idenvio = $1", [id]);
    await client.query("DELETE FROM envio_bulto WHERE envio_idenvio = $1", [id]);
    await client.query("DELETE FROM envio WHERE idenvio = $1", [id]);

    await client.query("COMMIT");
    console.log("✅ Envío eliminado:", id);
    res.json({ message: "Envío cancelado exitosamente" });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ DELETE ENVIO ERROR:", error.message);
    res.status(500).json({ error: "Error al cancelar envío" });
  } finally {
    client.release();
  }
};

// ==========================
// HISTORIAL ENVÍOS PAQUETERÍA
// ==========================
export const getEnviosPaqueteria = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        e.idenvio,
        e.estado,
        e.numero_guia,
        e.costo_flete,
        e.fecha_envio,
        e.fecha_entrega_estimada,
        e.observaciones,
        e.es_parcialidad,
        s.no_pedido,
        cli.razon_social AS cliente,
        cli.empresa,
        cli.impresion,
        p.idpaqueteria,
        p.nombre         AS paqueteria_nombre,
        COUNT(eb.idenvio_bulto) AS total_bultos
      FROM envio e
      JOIN solicitud s       ON s.idsolicitud     = e.solicitud_idsolicitud
      JOIN clientes cli      ON cli.idclientes     = s.clientes_idclientes
      JOIN paqueteria p      ON p.idpaqueteria     = e.paqueteria_idpaqueteria
      LEFT JOIN envio_bulto eb ON eb.envio_idenvio = e.idenvio
      WHERE e.tipo = 'paqueteria'
      GROUP BY
        e.idenvio, e.estado, e.numero_guia, e.costo_flete,
        e.fecha_envio, e.fecha_entrega_estimada, e.observaciones, e.es_parcialidad,
        s.no_pedido, cli.razon_social, cli.empresa, cli.impresion,
        p.idpaqueteria, p.nombre
      ORDER BY e.fecha_envio DESC
    `);

    res.json(rows.map((r: any) => ({
      idenvio:                Number(r.idenvio),
      estado:                 r.estado,
      es_parcialidad:         r.es_parcialidad,
      numero_guia:            r.numero_guia            || null,
      costo_flete:            r.costo_flete != null ? Number(r.costo_flete) : null,
      fecha_envio:            r.fecha_envio,
      fecha_entrega_estimada: r.fecha_entrega_estimada || null,
      observaciones:          r.observaciones          || null,
      no_pedido:              r.no_pedido,
      cliente:                r.impresion || r.empresa || r.cliente || "",
      empresa:                r.empresa   || "",
      paqueteria: {
        idpaqueteria: Number(r.idpaqueteria),
        nombre:       r.paqueteria_nombre,
      },
      total_bultos: Number(r.total_bultos),
    })));
  } catch (error: any) {
    console.error("❌ GET ENVIOS PAQUETERIA ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener envios de paqueteria" });
  }
};

// ==========================
// ACTUALIZAR GUÍA
// ==========================
export const updateGuiaEnvio = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { numero_guia } = req.body;

    const result = await pool.query(
      `UPDATE envio SET numero_guia = $1 WHERE idenvio = $2 RETURNING idenvio, numero_guia`,
      [numero_guia || null, id]
    );

    if ((result.rowCount ?? 0) === 0)
      return res.status(404).json({ error: "Envío no encontrado" });

    res.json({ message: "Guía actualizada", envio: result.rows[0] });
  } catch (error: any) {
    console.error("❌ UPDATE GUIA ERROR:", error.message);
    res.status(500).json({ error: "Error al actualizar guía" });
  }
};

// ==========================
// CATÁLOGO PRODUCTOS SAT
// ==========================
export const getProductosSat = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT idproducto_sat, clave, pdft AS descripcion
      FROM producto_sat
      ORDER BY idproducto_sat ASC
    `);

    res.json(rows.map((r: any) => ({
      idproducto_sat: Number(r.idproducto_sat),
      clave:          r.clave,
      descripcion:    r.descripcion,
    })));
  } catch (error: any) {
    console.error("❌ GET PRODUCTOS SAT ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener catálogo de productos SAT" });
  }
};

// ==========================
// GUÍA GENERAL PAQUETERÍA
// ==========================
export const getGuiaGeneral = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // ── Datos del envío + cliente + paquetería ──
    const { rows: envioRows } = await pool.query(`
      SELECT
        e.idenvio,
        e.observaciones,
        e.fecha_envio,
        s.no_pedido,
        p.nombre              AS paqueteria_nombre,
        cli.empresa,
        cli.razon_social,
        cli.impresion,
        cli.telefono          AS cli_telefono,
        cli.celular           AS cli_celular,
        df.rfc                AS cli_rfc,
        COALESCE(de.domicilio,     dom.domicilio)     AS cli_domicilio,
        COALESCE(de.numero,        dom.numero)        AS cli_numero,
        COALESCE(de.colonia,       dom.colonia)       AS cli_colonia,
        COALESCE(de.codigo_postal, dom.codigo_postal) AS cli_cp,
        COALESCE(de.poblacion,     dom.poblacion)     AS cli_ciudad,
        COALESCE(de.estado,        dom.estado)        AS cli_estado
      FROM envio e
      JOIN solicitud s            ON s.idsolicitud          = e.solicitud_idsolicitud
      JOIN clientes cli           ON cli.idclientes         = s.clientes_idclientes
      JOIN paqueteria p           ON p.idpaqueteria         = e.paqueteria_idpaqueteria
      LEFT JOIN datos_facturacion df ON df.clientes_idclientes = cli.idclientes
      LEFT JOIN domicilio dom     ON dom.clientes_idclientes = cli.idclientes
      LEFT JOIN direccion_envio de ON de.clientes_idclientes = cli.idclientes
      WHERE e.idenvio = $1
      LIMIT 1
    `, [id]);

    if (envioRows.length === 0)
      return res.status(404).json({ error: "Envío no encontrado" });

    const envio = envioRows[0];

    // ── Datos remitente (empresa) ──
    const { rows: empresaRows } = await pool.query(`
      SELECT
        e.nombre_empresa,
        e.razon_social,
        e.rfc,
        d.domicilio,
        d.numero,
        d.colonia,
        d.codigo_postal,
        d.poblacion,
        d.estado,
        STRING_AGG(DISTINCT t.numero, ' / ' ORDER BY t.numero) AS telefonos
      FROM empresa_empresa e
      LEFT JOIN direccion_empresa d ON d.id_empresa = e.id_empresa
      LEFT JOIN telefono_empresa  t ON t.id_empresa = e.id_empresa
      WHERE e.id_empresa = 1
      GROUP BY
        e.nombre_empresa, e.razon_social, e.rfc,
        d.domicilio, d.numero, d.colonia, d.codigo_postal, d.poblacion, d.estado
      LIMIT 1
    `);

    if (empresaRows.length === 0)
      return res.status(500).json({ error: "No se encontraron datos de la empresa" });

    const empresa = empresaRows[0];

    // ── Bultos del envío (incluye claves SAT guardadas) ──
    const { rows: bultosRows } = await pool.query(`
      SELECT
        b.idbulto,
        b.alto,
        b.largo,
        b.ancho,
        b.peso,
        b.cantidad_unidades,
        b.clave_producto_sat,
        b.clave_unidad_sat,
        tpp.material_plastico_producto AS nombre_producto,
        cfg.medida
      FROM envio_bulto eb
      JOIN bultos b ON b.idbulto = eb.bultos_idbulto
      LEFT JOIN bolseo bol ON bol.idbolseo = b.bolseo_idbolseo
      LEFT JOIN asa_flexible af ON af.idasa_flexible = b.asa_flexible_idasa_flexible
      LEFT JOIN orden_produccion op
        ON op.idproduccion = COALESCE(bol.orden_produccion_idproduccion, af.orden_produccion_idproduccion)
      LEFT JOIN solicitud_producto sp
        ON sp.idsolicitud_producto = op.idsolicitud_producto
      LEFT JOIN configuracion_plastico cfg
        ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN tipo_producto_plastico tpp
        ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      WHERE eb.envio_idenvio = $1
      ORDER BY b.idbulto ASC
    `, [id]);

    // ── Construir respuesta ──
    const dirRemitente = [
      empresa.domicilio,
      empresa.numero ? `#${empresa.numero}` : null,
    ].filter(Boolean).join(" ");

    const dirDest = [
      envio.cli_domicilio,
      envio.cli_numero ? `#${envio.cli_numero}` : null,
    ].filter(Boolean).join(" ");

    const telDest = [envio.cli_telefono, envio.cli_celular].filter(Boolean).join(" / ");

    res.json({
      idenvio:      Number(id),
      no_pedido:    envio.no_pedido,
      fecha_envio:  envio.fecha_envio,
      total_bultos: bultosRows.length,
      paqueteria:   envio.paqueteria_nombre,
      observaciones: envio.observaciones || null,
      remitente: {
        nombre_empresa: empresa.nombre_empresa || "",
        razon_social:   empresa.razon_social   || "",
        rfc:            empresa.rfc            || "",
        telefonos:      empresa.telefonos      || "",
        domicilio:      dirRemitente,
        colonia:        empresa.colonia        || "",
        ciudad:         empresa.poblacion      || "",
        estado:         empresa.estado         || "",
        codigo_postal:  empresa.codigo_postal  || "",
      },
      destinatario: {
        nombre:        envio.razon_social || envio.empresa || "",
        impresion:     envio.impresion    || envio.empresa || "",
        rfc:           envio.cli_rfc      || "",
        telefonos:     telDest,
        domicilio:     dirDest,
        colonia:       envio.cli_colonia  || "",
        ciudad:        envio.cli_ciudad   || "",
        estado:        envio.cli_estado   || "",
        codigo_postal: envio.cli_cp       || "",
        correo:        "",
      },
      bultos: bultosRows.map((b: any) => ({
        idbulto:            Number(b.idbulto),
        nombre_producto:    b.nombre_producto   || "",
        medida:             b.medida            || "",
        cantidad_unidades:  b.cantidad_unidades != null ? Number(b.cantidad_unidades) : null,
        peso:               b.peso   != null ? Number(b.peso)   : null,
        alto:               b.alto   != null ? Number(b.alto)   : null,
        largo:              b.largo  != null ? Number(b.largo)  : null,
        ancho:              b.ancho  != null ? Number(b.ancho)  : null,
        clave_producto_sat: b.clave_producto_sat || "",
        clave_unidad_sat:   b.clave_unidad_sat   || "",
      })),
    });
  } catch (error: any) {
    console.error("❌ GET GUIA GENERAL ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener guía general" });
  }
};

// ==========================
// GUARDAR CLAVES SAT DE BULTOS
// ==========================
export const updateClavesSatBultos = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { bultos } = req.body as {
      bultos: { idbulto: number; clave_producto_sat: string; clave_unidad_sat: string }[];
    };

    if (!Array.isArray(bultos) || bultos.length === 0)
      return res.status(400).json({ error: "Se requiere al menos un bulto" });

    await client.query("BEGIN");

    for (const b of bultos) {
      await client.query(
        `UPDATE bultos
         SET clave_producto_sat = $1,
             clave_unidad_sat   = $2
         WHERE idbulto = $3`,
        [b.clave_producto_sat || null, b.clave_unidad_sat || null, b.idbulto]
      );
    }

    await client.query("COMMIT");
    console.log(`✅ Claves SAT actualizadas para ${bultos.length} bulto(s) del envío ${id}`);
    res.json({ message: "Claves SAT guardadas correctamente" });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ UPDATE CLAVES SAT ERROR:", error.message);
    res.status(500).json({ error: "Error al guardar claves SAT" });
  } finally {
    client.release();
  }
};

// ==========================
// BULTOS POR ORDEN DE PRODUCCIÓN
// Reemplaza únicamente esta función al final de envios.controller.ts
// ==========================
export const getBultosPorProduccion = async (req: Request, res: Response) => {
  try {
    const idsolicitud  = Number(req.params.idsolicitud);
    const idproduccion = Number(req.params.idproduccion);

    // ── Verificar que la orden pertenece a esa solicitud ──────────────────────
    const { rows: ordenRows } = await pool.query(
      `SELECT op.idproduccion, op.no_produccion
       FROM orden_produccion op
       JOIN solicitud_producto sp ON sp.idsolicitud_producto = op.idsolicitud_producto
       WHERE op.idproduccion = $1
         AND sp.solicitud_idsolicitud = $2`,
      [idproduccion, idsolicitud]
    );
    if (ordenRows.length === 0)
      return res.status(404).json({ error: "Orden no encontrada para este pedido" });

    // ── Obtener todos los bultos de esta orden con su estado de envío ─────────
    const { rows: bultosRows } = await pool.query(
      `SELECT
         b.idbulto,
         b.cantidad_unidades,
         b.peso_producto,
         b.peso,
         b.alto,
         b.largo,
         b.ancho,
         b.fecha_creacion,
         CASE
           WHEN b.bolseo_idbolseo             IS NOT NULL THEN 'bolseo'
           WHEN b.asa_flexible_idasa_flexible IS NOT NULL THEN 'asa_flexible'
         END AS proceso_origen,
         tpp.material_plastico_producto AS nombre_producto,
         cfg.medida,
         CASE
           WHEN e.estado = 'entregado'  THEN 'entregado'
           WHEN e.estado = 'en_camino'  THEN 'en_camino'
           WHEN e.estado = 'preparando' THEN 'preparando'
           ELSE 'sin_enviar'
         END AS estado_bulto,
         e.idenvio,
         e.estado AS estado_envio
       FROM bultos b
       JOIN (
         SELECT idbolseo AS id_proceso, 'bolseo' AS tipo_proceso, orden_produccion_idproduccion
         FROM bolseo WHERE orden_produccion_idproduccion = $1
         UNION ALL
         SELECT idasa_flexible AS id_proceso, 'asa_flexible' AS tipo_proceso, orden_produccion_idproduccion
         FROM asa_flexible WHERE orden_produccion_idproduccion = $1
       ) proc ON (
         (proc.tipo_proceso = 'bolseo'       AND b.bolseo_idbolseo             = proc.id_proceso)
         OR
         (proc.tipo_proceso = 'asa_flexible' AND b.asa_flexible_idasa_flexible = proc.id_proceso)
       )
       JOIN orden_produccion op ON op.idproduccion = $1
       JOIN solicitud_producto sp ON sp.idsolicitud_producto = op.idsolicitud_producto
       JOIN configuracion_plastico cfg
           ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
       JOIN tipo_producto_plastico tpp
           ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
       -- Envío activo más reciente para este bulto
       LEFT JOIN (
         SELECT DISTINCT ON (eb_inner.bultos_idbulto)
           eb_inner.bultos_idbulto,
           e_inner.idenvio,
           e_inner.estado
         FROM envio_bulto eb_inner
         JOIN envio e_inner ON e_inner.idenvio = eb_inner.envio_idenvio
         ORDER BY eb_inner.bultos_idbulto, e_inner.idenvio DESC
       ) e ON e.bultos_idbulto = b.idbulto
       ORDER BY b.idbulto ASC`,
      [idproduccion]
    );

    // ── Obtener todos los envíos que contienen al menos un bulto de esta orden ─
    const { rows: enviosRows } = await pool.query(
      `SELECT DISTINCT
         e.idenvio,
         e.tipo,
         e.estado,
         e.es_parcialidad,
         e.numero_guia,
         e.costo_flete,
         e.fecha_envio,
         e.fecha_entrega_estimada,
         e.observaciones,
         u.idusuario,
         u.nombre      AS chofer_nombre,
         un.idunidad,
         un.marca,
         un.modelo,
         un.placa,
         p.idpaqueteria,
         p.nombre      AS paqueteria_nombre,
         COUNT(eb2.bultos_idbulto) AS total_bultos
       FROM envio e
       JOIN envio_bulto eb ON eb.envio_idenvio = e.idenvio
       JOIN bultos b        ON b.idbulto        = eb.bultos_idbulto
       JOIN (
         SELECT idbulto FROM bultos b2
         WHERE
           b2.bolseo_idbolseo IN (
             SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = $1
           )
           OR
           b2.asa_flexible_idasa_flexible IN (
             SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = $1
           )
       ) bultos_orden ON bultos_orden.idbulto = b.idbulto
       LEFT JOIN usuarios   u  ON u.idusuario   = e.usuarios_idusuario
       LEFT JOIN unidades   un ON un.idunidad    = e.unidades_idunidad
       LEFT JOIN paqueteria p  ON p.idpaqueteria = e.paqueteria_idpaqueteria
       JOIN envio_bulto eb2 ON eb2.envio_idenvio = e.idenvio
       WHERE e.estado != 'cancelado'
       GROUP BY
         e.idenvio, e.tipo, e.estado, e.es_parcialidad,
         e.numero_guia, e.costo_flete, e.fecha_envio,
         e.fecha_entrega_estimada, e.observaciones,
         u.idusuario, u.nombre,
         un.idunidad, un.marca, un.modelo, un.placa,
         p.idpaqueteria, p.nombre
       ORDER BY e.idenvio DESC`,
      [idproduccion]
    );

    return res.json({
      bultos: bultosRows.map((r: any) => ({
        idbulto:           Number(r.idbulto),
        cantidad_unidades: r.cantidad_unidades != null ? Number(r.cantidad_unidades) : null,
        peso_producto:     r.peso_producto     != null ? Number(r.peso_producto)     : null,
        peso:              r.peso              != null ? Number(r.peso)              : null,
        alto:              r.alto              != null ? Number(r.alto)              : null,
        largo:             r.largo             != null ? Number(r.largo)             : null,
        ancho:             r.ancho             != null ? Number(r.ancho)             : null,
        fecha_creacion:    r.fecha_creacion,
        proceso_origen:    r.proceso_origen    as "bolseo" | "asa_flexible",
        nombre_producto:   r.nombre_producto   || "",
        medida:            r.medida            || "",
        estado_bulto:      r.estado_bulto      as "sin_enviar" | "preparando" | "en_camino" | "entregado",
        idenvio:           r.idenvio           != null ? Number(r.idenvio) : null,
        estado_envio:      r.estado_envio      || null,
      })),
      envios: enviosRows.map((e: any) => ({
        idenvio:                Number(e.idenvio),
        tipo:                   e.tipo          as "local" | "paqueteria",
        estado:                 e.estado        as "preparando" | "en_camino" | "entregado",
        es_parcialidad:         Boolean(e.es_parcialidad),
        numero_guia:            e.numero_guia            || null,
        costo_flete:            e.costo_flete   != null ? Number(e.costo_flete) : null,
        fecha_envio:            e.fecha_envio,
        fecha_entrega_estimada: e.fecha_entrega_estimada || null,
        observaciones:          e.observaciones          || null,
        total_bultos:           Number(e.total_bultos),
        chofer: e.idusuario ? {
          idusuario: Number(e.idusuario),
          nombre:    e.chofer_nombre,
        } : null,
        unidad: e.idunidad ? {
          idunidad: Number(e.idunidad),
          nombre:   `${e.marca} ${e.modelo} - ${e.placa}`,
        } : null,
        paqueteria: e.idpaqueteria ? {
          idpaqueteria: Number(e.idpaqueteria),
          nombre:       e.paqueteria_nombre,
        } : null,
      })),
    });

  } catch (error: any) {
    console.error("❌ GET BULTOS POR PRODUCCION ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener bultos por producción" });
  }
};
 