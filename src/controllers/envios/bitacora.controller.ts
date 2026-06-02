import { Request, Response } from "express";
import { pool } from "../../config/db";
import { uploadToS3, MulterFile, CARPETAS } from "../../config/multer";

type RequestConArchivo = Request & { file?: MulterFile };

// Helper: convierte Date o string a ISO string seguro
const toIso = (v: any): string | null => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return null;
};

// ==========================
// OBTENER BITÁCORA COMPLETA (solo reparto local)
// ==========================
export const getBitacora = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        br.idbitacora,
        br.fecha,
        br.hora_salida,
        br.hora_llegada,
        br.observacion,
        br.observacion_extra,
        br.firma,
        br.created_at,
        br.updated_at,
        e.idenvio,
        e.tipo,
        e.estado,
        e.es_parcialidad,
        e.numero_guia,
        e.fecha_entrega_estimada,
        e.observaciones AS envio_observaciones,
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
        un.placa   AS unidad_placa
      FROM bitacora_reparto br
      JOIN envio e        ON e.idenvio               = br.envio_idenvio
      JOIN solicitud s    ON s.idsolicitud            = e.solicitud_idsolicitud
      JOIN clientes cli   ON cli.idclientes           = s.clientes_idclientes
      LEFT JOIN usuarios u     ON u.idusuario         = br.usuarios_idusuario
      LEFT JOIN unidades un    ON un.idunidad         = br.unidades_idunidad
      WHERE e.tipo = 'local'
        AND NOT EXISTS (
          SELECT 1 FROM nota_remision_envio nre
          JOIN nota_remision nr ON nr.idnota = nre.nota_remision_idnota
          WHERE nre.envio_idenvio = e.idenvio
            AND nr.es_multi = TRUE
        )
      ORDER BY br.fecha DESC, br.idbitacora DESC
    `);

    res.json(
      rows.map((r: any) => ({
        idbitacora: Number(r.idbitacora),
        fecha: r.fecha,
        hora_salida: toIso(r.hora_salida),
        hora_llegada: toIso(r.hora_llegada),
        observacion: r.observacion || null,
        observacion_extra: r.observacion_extra || null,
        firma: r.firma || null,
        created_at: r.created_at,
        updated_at: r.updated_at,
        fecha_entrega_estimada: r.fecha_entrega_estimada || null,
        observaciones_envio: r.envio_observaciones || null,
        envio: {
          idenvio: Number(r.idenvio),
          tipo: r.tipo,
          estado: r.estado,
          numero_guia: r.numero_guia || null,
          es_parcialidad: Boolean(r.es_parcialidad),
        },
        no_pedido: r.no_pedido,
        cliente: r.impresion || r.empresa || "",
        chofer: r.idusuario
          ? {
              idusuario: Number(r.idusuario),
              nombre: `${r.chofer_nombre} ${r.chofer_apellido}`,
            }
          : null,
        unidad: r.idunidad
          ? {
              idunidad: Number(r.idunidad),
              tipo: r.unidad_tipo,
              nombre: `${r.unidad_marca} ${r.unidad_modelo} — ${r.unidad_placa}`,
            }
          : null,
      })),
    );
  } catch (error: any) {
    console.error("❌ GET BITACORA ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener bitácora" });
  }
};


// ==========================
// OBTENER PAQUETERÍA PARA BITÁCORA
// ==========================
export const getPaqueteriaBitacora = async (req: Request, res: Response) => {
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
        p.nombre AS paqueteria_nombre,
        COUNT(eb.idenvio_bulto) AS total_bultos,
        br.idbitacora,
        br.hora_salida,
        br.hora_llegada,
        br.observacion,
        br.observacion_extra,
        br.firma
      FROM envio e
      JOIN solicitud s          ON s.idsolicitud      = e.solicitud_idsolicitud
      JOIN clientes cli         ON cli.idclientes     = s.clientes_idclientes
      JOIN paqueteria p         ON p.idpaqueteria     = e.paqueteria_idpaqueteria
      LEFT JOIN envio_bulto eb  ON eb.envio_idenvio   = e.idenvio
      LEFT JOIN bitacora_reparto br ON br.envio_idenvio = e.idenvio
      WHERE e.tipo = 'paqueteria'
      GROUP BY
        e.idenvio, e.estado, e.numero_guia, e.costo_flete,
        e.fecha_envio, e.fecha_entrega_estimada, e.observaciones, e.es_parcialidad,
        s.no_pedido, cli.razon_social, cli.empresa, cli.impresion,
        p.idpaqueteria, p.nombre,
        br.idbitacora, br.hora_salida, br.hora_llegada,
        br.observacion, br.observacion_extra, br.firma
      ORDER BY e.fecha_envio DESC, e.idenvio DESC
    `);

    res.json(
      rows.map((r: any) => ({
        idenvio: Number(r.idenvio),
        estado: r.estado,
        es_parcialidad: Boolean(r.es_parcialidad),
        numero_guia: r.numero_guia || null,
        costo_flete: r.costo_flete != null ? Number(r.costo_flete) : null,
        fecha_envio: r.fecha_envio,
        fecha_entrega_estimada: r.fecha_entrega_estimada || null,
        observaciones: r.observaciones || null,
        no_pedido: r.no_pedido,
        cliente: r.impresion || r.empresa || r.cliente || "",
        empresa: r.empresa || "",
        paqueteria: {
          idpaqueteria: Number(r.idpaqueteria),
          nombre: r.paqueteria_nombre,
        },
        total_bultos: Number(r.total_bultos),
        idbitacora: r.idbitacora ? Number(r.idbitacora) : null,
        hora_salida:       toIso(r.hora_salida),
        hora_llegada:      toIso(r.hora_llegada),
        observacion:       r.observacion       || null,
        observacion_extra: r.observacion_extra || null,
        firma:             r.firma             || null,
      })),
    );
  } catch (error: any) {
    console.error("❌ GET PAQUETERIA BITACORA ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener bitácora de paquetería" });
  }
};

// ==========================
// OBTENER REGISTRO POR ID
// ==========================
export const getBitacoraById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      `
      SELECT
        br.idbitacora, br.fecha, br.hora_salida, br.hora_llegada,
        br.observacion, br.observacion_extra, br.firma,
        br.created_at, br.updated_at,
        e.idenvio, e.tipo, e.estado, e.numero_guia,
        e.fecha_entrega_estimada,
        e.observaciones AS envio_observaciones, e.es_parcialidad,
        s.no_pedido, cli.empresa, cli.impresion,
        u.idusuario, u.nombre AS chofer_nombre, u.apellido AS chofer_apellido,
        un.idunidad, un.tipo AS unidad_tipo, un.marca AS unidad_marca,
        un.modelo AS unidad_modelo, un.placa AS unidad_placa
      FROM bitacora_reparto br
      JOIN envio e      ON e.idenvio     = br.envio_idenvio
      JOIN solicitud s  ON s.idsolicitud = e.solicitud_idsolicitud
      JOIN clientes cli ON cli.idclientes = s.clientes_idclientes
      LEFT JOIN usuarios u   ON u.idusuario  = br.usuarios_idusuario
      LEFT JOIN unidades un  ON un.idunidad  = br.unidades_idunidad
      WHERE br.idbitacora = $1
      LIMIT 1
    `,
      [id],
    );

    if (!rows.length)
      return res.status(404).json({ error: "Registro no encontrado" });

    const r = rows[0];
    res.json({
      idbitacora: Number(r.idbitacora),
      fecha: r.fecha,
      hora_salida:       toIso(r.hora_salida),
      hora_llegada:      toIso(r.hora_llegada),
      observacion:       r.observacion       || null,
      observacion_extra: r.observacion_extra || null,
      firma:             r.firma             || null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      fecha_entrega_estimada: r.fecha_entrega_estimada || null,
      observaciones_envio: r.envio_observaciones || null,
      envio: {
        idenvio: Number(r.idenvio),
        tipo: r.tipo,
        estado: r.estado,
        numero_guia: r.numero_guia || null,
        es_parcialidad: Boolean(r.es_parcialidad),
      },
      no_pedido: r.no_pedido,
      cliente: r.impresion || r.empresa || "",
      chofer: r.idusuario
        ? {
            idusuario: Number(r.idusuario),
            nombre: `${r.chofer_nombre} ${r.chofer_apellido}`,
          }
        : null,
      unidad: r.idunidad
        ? {
            idunidad: Number(r.idunidad),
            tipo: r.unidad_tipo,
            nombre: `${r.unidad_marca} ${r.unidad_modelo} — ${r.unidad_placa}`,
          }
        : null,
    });
  } catch (error: any) {
    console.error("❌ GET BITACORA BY ID ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener registro" });
  }
};

// ==========================
// REGISTRAR HORA DE SALIDA
// ==========================
export const registrarHoraSalida = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const ahora = new Date();

    const result = await pool.query(
      `UPDATE bitacora_reparto SET hora_salida = $1, updated_at = NOW()
       WHERE idbitacora = $2 RETURNING idbitacora, hora_salida`,
      [ahora, id],
    );

    if (!result.rowCount)
      return res.status(404).json({ error: "Registro no encontrado" });

    await pool.query(
      `UPDATE envio SET estado = 'en_camino'
       WHERE idenvio = (SELECT envio_idenvio FROM bitacora_reparto WHERE idbitacora = $1)`,
      [id],
    );

    res.json({
      message: "Hora de salida registrada",
      idbitacora: Number(result.rows[0].idbitacora),
      hora_salida: toIso(result.rows[0].hora_salida),
    });
  } catch (error: any) {
    console.error("❌ HORA SALIDA ERROR:", error.message);
    res.status(500).json({ error: "Error al registrar hora de salida" });
  }
};

// ==========================
// REGISTRAR HORA DE LLEGADA
// ==========================
export const registrarHoraLlegada = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const ahora = new Date();

    const result = await pool.query(
      `UPDATE bitacora_reparto SET hora_llegada = $1, updated_at = NOW()
       WHERE idbitacora = $2 RETURNING idbitacora, hora_llegada`,
      [ahora, id],
    );

    if (!result.rowCount)
      return res.status(404).json({ error: "Registro no encontrado" });

    await pool.query(
      `UPDATE envio SET estado = 'entregado'
       WHERE idenvio = (SELECT envio_idenvio FROM bitacora_reparto WHERE idbitacora = $1)`,
      [id],
    );

    res.json({
      message: "Hora de llegada registrada",
      idbitacora: Number(result.rows[0].idbitacora),
      hora_llegada: toIso(result.rows[0].hora_llegada),
    });
  } catch (error: any) {
    console.error("❌ HORA LLEGADA ERROR:", error.message);
    res.status(500).json({ error: "Error al registrar hora de llegada" });
  }
};

// ==========================
// ACTUALIZAR REGISTRO BITÁCORA
// ==========================
export const updateBitacora = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      hora_salida,
      hora_llegada,
      observacion,
      observacion_extra,
      firma,
      numero_guia,
    } = req.body;

    const observacionesValidas = ["E", "RA", "RD", "PD"];
    if (observacion && !observacionesValidas.includes(observacion))
      return res
        .status(400)
        .json({ error: "Observación inválida. Valores: E, RA, RD, PD" });

    if (numero_guia !== undefined) {
      await pool.query(
        `UPDATE envio SET numero_guia = $1
         WHERE idenvio = (SELECT envio_idenvio FROM bitacora_reparto WHERE idbitacora = $2)`,
        [numero_guia || null, id],
      );
    }

    const result = await pool.query(
      `UPDATE bitacora_reparto
       SET hora_salida       = COALESCE($1, hora_salida),
           hora_llegada      = COALESCE($2, hora_llegada),
           observacion       = COALESCE($3, observacion),
           observacion_extra = COALESCE($4, observacion_extra),
           firma             = COALESCE($5, firma),
           updated_at        = NOW()
       WHERE idbitacora = $6
       RETURNING idbitacora, hora_salida, hora_llegada, observacion, observacion_extra, firma, updated_at`,
      [
        hora_salida || null,
        hora_llegada || null,
        observacion || null,
        observacion_extra || null,
        firma || null,
        id,
      ],
    );

    if (!result.rowCount)
      return res.status(404).json({ error: "Registro no encontrado" });

    res.json({
      message: "Registro actualizado exitosamente",
      bitacora: result.rows[0],
    });
  } catch (error: any) {
    console.error("❌ UPDATE BITACORA ERROR:", error.message);
    res.status(500).json({ error: "Error al actualizar registro" });
  }
};

// ==========================
// GET RECOLECCIONES
// ==========================
export const getRecolecciones = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        e.idenvio,
        e.estado,
        e.es_parcialidad,
        e.fecha_envio,
        e.fecha_entrega_estimada,
        e.observaciones,
        s.no_pedido,
        cli.empresa,
        cli.impresion,
        cli.razon_social,
        COUNT(eb.idenvio_bulto)                  AS total_bultos,
        br.idbitacora,
        br.recoleccion_nombre_quien_recogio,
        br.recoleccion_empresa,
        br.recoleccion_unidad_marca,
        br.recoleccion_unidad_modelo,
        br.recoleccion_unidad_placas,
        br.recoleccion_foto_url,
        br.hora_llegada,
        br.observacion_extra
      FROM envio e
      JOIN solicitud s         ON s.idsolicitud      = e.solicitud_idsolicitud
      JOIN clientes cli        ON cli.idclientes      = s.clientes_idclientes
      LEFT JOIN envio_bulto eb ON eb.envio_idenvio    = e.idenvio
      LEFT JOIN bitacora_reparto br ON br.envio_idenvio = e.idenvio
      WHERE e.tipo = 'recoleccion'
        AND NOT EXISTS (
          SELECT 1 FROM nota_remision_envio nre
          JOIN nota_remision nr ON nr.idnota = nre.nota_remision_idnota
          WHERE nre.envio_idenvio = e.idenvio
            AND nr.es_multi = TRUE
        )
      GROUP BY
        e.idenvio, e.estado, e.es_parcialidad,
        e.fecha_envio, e.fecha_entrega_estimada, e.observaciones,
        s.no_pedido, cli.empresa, cli.impresion, cli.razon_social,
        br.idbitacora, br.recoleccion_nombre_quien_recogio, br.recoleccion_empresa,
        br.recoleccion_unidad_marca, br.recoleccion_unidad_modelo, br.recoleccion_unidad_placas,
        br.recoleccion_foto_url, br.hora_llegada, br.observacion_extra
      ORDER BY e.fecha_envio DESC
    `);

    res.json(
      rows.map((r: any) => ({
        idenvio: Number(r.idenvio),
        estado: r.estado,
        es_parcialidad: r.es_parcialidad,
        fecha_envio: r.fecha_envio,
        fecha_entrega_estimada: r.fecha_entrega_estimada || null,
        observaciones: r.observaciones || null,
        no_pedido: r.no_pedido,
        cliente: r.impresion || r.empresa || r.razon_social || "",
        empresa: r.empresa || "",
        total_bultos: Number(r.total_bultos),
        idbitacora: r.idbitacora ? Number(r.idbitacora) : null,
        recoleccion_datos: r.recoleccion_nombre_quien_recogio
          ? {
              nombre_quien_recogio: r.recoleccion_nombre_quien_recogio,
              empresa:        r.recoleccion_empresa       || null,
              unidad_marca:   r.recoleccion_unidad_marca  || null,
              unidad_modelo:  r.recoleccion_unidad_modelo || null,
              unidad_placas:  r.recoleccion_unidad_placas || null,
              tiene_foto:     !!r.recoleccion_foto_url,
              foto_url:       r.recoleccion_foto_url      || null,
              fecha_recogido: toIso(r.hora_llegada),
              observacion_extra: r.observacion_extra || null,
            }
          : null,
      })),
    );
  } catch (error: any) {
    console.error("❌ GET RECOLECCIONES ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener recolecciones" });
  }
};

// ==========================
// MARCAR RECOLECCIÓN COMO ENTREGADA
// PATCH /bitacora/recoleccion/:idenvio/marcar-recogido
// ==========================
export const marcarRecolectado = async (
  req: RequestConArchivo,
  res: Response,
) => {
  try {
    const { idenvio } = req.params;
    const {
      nombre_quien_recogio,
      empresa,
      unidad_marca,
      unidad_modelo,
      unidad_placas,
      observacion_extra,
    } = req.body;

    if (!nombre_quien_recogio?.trim())
      return res
        .status(400)
        .json({ error: "El nombre de quien recogió es requerido" });

    let foto_url: string | null = null;
    if (req.file) {
      const resultado = await uploadToS3(req.file, CARPETAS.fotos_envios);
      foto_url = resultado.public_id;
    }

    const { rows: brRows } = await pool.query(
      `SELECT idbitacora FROM bitacora_reparto WHERE envio_idenvio = $1 LIMIT 1`,
      [idenvio],
    );

    if (!brRows.length)
      return res
        .status(404)
        .json({ error: "Registro de bitácora no encontrado para este envío" });

    const idbitacora = brRows[0].idbitacora;

    await pool.query(
      `UPDATE bitacora_reparto
       SET recoleccion_nombre_quien_recogio = $1,
           recoleccion_empresa              = $2,
           recoleccion_unidad_marca         = $3,
           recoleccion_unidad_modelo        = $4,
           recoleccion_unidad_placas        = $5,
           recoleccion_foto_url             = COALESCE($6, recoleccion_foto_url),
           observacion_extra                = COALESCE($7::text, observacion_extra),
           hora_llegada                     = COALESCE(hora_llegada, NOW()),
           updated_at                       = NOW()
       WHERE idbitacora = $8`,
      [
        nombre_quien_recogio.trim(),
        empresa?.trim()       || null,
        unidad_marca?.trim()  || null,
        unidad_modelo?.trim() || null,
        unidad_placas?.trim() || null,
        foto_url,
        observacion_extra?.trim() || null,
        idbitacora,
      ],
    );

    await pool.query(
      `UPDATE envio SET estado = 'entregado' WHERE idenvio = $1`,
      [idenvio],
    );

    res.json({
      message: "Recolección registrada correctamente",
      idbitacora,
      foto_subida: foto_url !== null,
    });
  } catch (error: any) {
    console.error("❌ MARCAR RECOLECTADO ERROR:", error.message);
    res.status(500).json({ error: "Error al registrar recolección" });
  }
};

// ==========================
// GET URL FIRMADA DE FOTO
// GET /bitacora/recoleccion/:idenvio/foto
// ==========================
export const getFotoRecoleccion = async (req: Request, res: Response) => {
  try {
    const { idenvio } = req.params;
    const { getPresignedUrl } = await import("../../config/multer");

    const { rows } = await pool.query(
      `SELECT recoleccion_foto_url
       FROM bitacora_reparto
       WHERE envio_idenvio = $1 AND recoleccion_foto_url IS NOT NULL
       LIMIT 1`,
      [idenvio],
    );

    if (!rows.length || !rows[0].recoleccion_foto_url)
      return res
        .status(404)
        .json({ error: "No hay foto registrada para esta recolección" });

    const url = await getPresignedUrl(rows[0].recoleccion_foto_url);
    res.json({ url });
  } catch (error: any) {
    console.error("❌ GET FOTO RECOLECCION ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener foto" });
  }
};

// ==========================
// MARCAR SALIDA DE ENVÍO LOCAL / PAQUETERÍA
// PATCH /bitacora/envio/:idenvio/marcar-salida
// ==========================
export const marcarSalidaEnvio = async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const { idenvio } = req.params;

    await client.query("BEGIN");

    const envio = await client.query(
      `SELECT idenvio, tipo, usuarios_idusuario, unidades_idunidad
       FROM envio WHERE idenvio = $1 LIMIT 1`,
      [idenvio],
    );

    if (!envio.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Envío no encontrado" });
    }

    const datosEnvio = envio.rows[0];

    const bitacoraExistente = await client.query(
      `SELECT idbitacora FROM bitacora_reparto WHERE envio_idenvio = $1 LIMIT 1`,
      [idenvio],
    );

    let idbitacora: number;

    if (bitacoraExistente.rowCount) {
      idbitacora = Number(bitacoraExistente.rows[0].idbitacora);
      await client.query(
        `UPDATE bitacora_reparto
         SET hora_salida = COALESCE(hora_salida, NOW()), updated_at = NOW()
         WHERE idbitacora = $1`,
        [idbitacora],
      );
    } else {
      const nuevaBitacora = await client.query(
        `INSERT INTO bitacora_reparto (envio_idenvio, usuarios_idusuario, unidades_idunidad, fecha, hora_salida)
         VALUES ($1, $2, $3, CURRENT_DATE, NOW()) RETURNING idbitacora`,
        [idenvio, datosEnvio.usuarios_idusuario || null, datosEnvio.unidades_idunidad || null],
      );
      idbitacora = Number(nuevaBitacora.rows[0].idbitacora);
    }

    await client.query(`UPDATE envio SET estado = 'en_camino' WHERE idenvio = $1`, [idenvio]);
    await client.query("COMMIT");

    res.json({ message: "Salida registrada correctamente", idenvio: Number(idenvio), idbitacora });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ MARCAR SALIDA ENVIO ERROR:", error.message);
    res.status(500).json({ error: "Error al registrar salida del envío" });
  } finally {
    client.release();
  }
};

// ==========================
// MARCAR ENTREGA DE ENVÍO
// PATCH /bitacora/envio/:idenvio/marcar-entregado
// ==========================
export const marcarEntregaEnvio = async (req: RequestConArchivo, res: Response) => {
  const client = await pool.connect();

  try {
    const { idenvio } = req.params;
    const { hora_salida, hora_llegada, observacion, observacion_extra, firma, numero_guia } = req.body;

    const observacionesValidas = ["E", "RA", "RD", "PD"];
    if (observacion && !observacionesValidas.includes(observacion)) {
      return res.status(400).json({ error: "Observación inválida. Valores: E, RA, RD, PD" });
    }

    await client.query("BEGIN");

    const envio = await client.query(
      `SELECT idenvio, tipo FROM envio WHERE idenvio = $1 LIMIT 1`,
      [idenvio],
    );

    if (!envio.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Envío no encontrado" });
    }

    if (numero_guia !== undefined) {
      await client.query(`UPDATE envio SET numero_guia = $1 WHERE idenvio = $2`, [numero_guia || null, idenvio]);
    }

    const bitacoraExistente = await client.query(
      `SELECT idbitacora FROM bitacora_reparto WHERE envio_idenvio = $1 LIMIT 1`,
      [idenvio],
    );

    const horaLlegadaFinal = hora_llegada || null;
    let idbitacora: number;

    if (bitacoraExistente.rowCount) {
      idbitacora = Number(bitacoraExistente.rows[0].idbitacora);
      await client.query(
        `UPDATE bitacora_reparto
         SET hora_salida       = COALESCE($1::timestamp, hora_salida),
             hora_llegada      = COALESCE($2::timestamp, NOW()),
             observacion       = COALESCE($3::text, observacion),
             observacion_extra = COALESCE($4::text, observacion_extra),
             firma             = COALESCE($5::text, firma),
             updated_at        = NOW()
         WHERE idbitacora = $6`,
        [hora_salida || null, horaLlegadaFinal, observacion || null, observacion_extra || null, firma || null, idbitacora],
      );
    } else {
      const nuevaBitacora = await client.query(
        `INSERT INTO bitacora_reparto (envio_idenvio, fecha, hora_salida, hora_llegada, observacion, observacion_extra, firma)
         VALUES ($1, CURRENT_DATE, $2::timestamp, COALESCE($3::timestamp, NOW()), $4, $5, $6)
         RETURNING idbitacora`,
        [idenvio, hora_salida || null, horaLlegadaFinal, observacion || null, observacion_extra || null, firma || null],
      );
      idbitacora = Number(nuevaBitacora.rows[0].idbitacora);
    }

    await client.query(`UPDATE envio SET estado = 'entregado' WHERE idenvio = $1`, [idenvio]);
    await client.query("COMMIT");

    res.json({ message: "Entrega registrada correctamente", idenvio: Number(idenvio), idbitacora });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ MARCAR ENTREGA ENVIO ERROR:", error.message);
    res.status(500).json({ error: "Error al registrar entrega del envío" });
  } finally {
    client.release();
  }
};