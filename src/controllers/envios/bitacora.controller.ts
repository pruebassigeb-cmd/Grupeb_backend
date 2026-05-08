import { Request, Response } from "express";
import { pool } from "../../config/db";

// ==========================
// OBTENER BITÁCORA COMPLETA
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
        e.numero_guia,
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
      JOIN usuarios u     ON u.idusuario              = br.usuarios_idusuario
      JOIN unidades un    ON un.idunidad              = br.unidades_idunidad
      ORDER BY br.fecha DESC, br.idbitacora DESC
    `);

    res.json(rows.map((r: any) => ({
      idbitacora:        Number(r.idbitacora),
      fecha:             r.fecha,
      hora_salida:       r.hora_salida     || null,
      hora_llegada:      r.hora_llegada    || null,
      observacion:       r.observacion     || null,
      observacion_extra: r.observacion_extra || null,
      firma:             r.firma           || null,
      created_at:        r.created_at,
      updated_at:        r.updated_at,
      envio: {
        idenvio:     Number(r.idenvio),
        tipo:        r.tipo,
        estado:      r.estado,
        numero_guia: r.numero_guia || null,
      },
      no_pedido:  r.no_pedido,
      cliente:    r.impresion || r.empresa || "",
      chofer: {
        idusuario: Number(r.idusuario),
        nombre:    `${r.chofer_nombre} ${r.chofer_apellido}`,
      },
      unidad: {
        idunidad: Number(r.idunidad),
        tipo:     r.unidad_tipo,
        nombre:   `${r.unidad_marca} ${r.unidad_modelo} — ${r.unidad_placa}`,
      },
    })));
  } catch (error: any) {
    console.error("❌ GET BITACORA ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener bitácora" });
  }
};

// ==========================
// OBTENER REGISTRO POR ID
// ==========================
export const getBitacoraById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

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
        e.numero_guia,
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
      JOIN envio e      ON e.idenvio     = br.envio_idenvio
      JOIN solicitud s  ON s.idsolicitud = e.solicitud_idsolicitud
      JOIN clientes cli ON cli.idclientes = s.clientes_idclientes
      JOIN usuarios u   ON u.idusuario   = br.usuarios_idusuario
      JOIN unidades un  ON un.idunidad   = br.unidades_idunidad
      WHERE br.idbitacora = $1
      LIMIT 1
    `, [id]);

    if ((rows.length ?? 0) === 0)
      return res.status(404).json({ error: "Registro no encontrado" });

    const r = rows[0];
    res.json({
      idbitacora:        Number(r.idbitacora),
      fecha:             r.fecha,
      hora_salida:       r.hora_salida       || null,
      hora_llegada:      r.hora_llegada      || null,
      observacion:       r.observacion       || null,
      observacion_extra: r.observacion_extra || null,
      firma:             r.firma             || null,
      created_at:        r.created_at,
      updated_at:        r.updated_at,
      envio: {
        idenvio:     Number(r.idenvio),
        tipo:        r.tipo,
        estado:      r.estado,
        numero_guia: r.numero_guia || null,
      },
      no_pedido: r.no_pedido,
      cliente:   r.impresion || r.empresa || "",
      chofer: {
        idusuario: Number(r.idusuario),
        nombre:    `${r.chofer_nombre} ${r.chofer_apellido}`,
      },
      unidad: {
        idunidad: Number(r.idunidad),
        tipo:     r.unidad_tipo,
        nombre:   `${r.unidad_marca} ${r.unidad_modelo} — ${r.unidad_placa}`,
      },
    });
  } catch (error: any) {
    console.error("❌ GET BITACORA BY ID ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener registro" });
  }
};

// ==========================
// REGISTRAR HORA DE SALIDA
// (timestamp completo: fecha + hora)
// ==========================
export const registrarHoraSalida = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const ahora = new Date();

    const result = await pool.query(
      `UPDATE bitacora_reparto
       SET hora_salida = $1, updated_at = NOW()
       WHERE idbitacora = $2
       RETURNING idbitacora, hora_salida`,
      [ahora, id]
    );

    if ((result.rowCount ?? 0) === 0)
      return res.status(404).json({ error: "Registro no encontrado" });

    // Actualizar estado del envío a en_camino
    await pool.query(
      `UPDATE envio SET estado = 'en_camino'
       WHERE idenvio = (
         SELECT envio_idenvio FROM bitacora_reparto WHERE idbitacora = $1
       )`,
      [id]
    );

    console.log("✅ Hora salida registrada:", ahora);
    res.json({
      message:    "Hora de salida registrada",
      idbitacora: Number(result.rows[0].idbitacora),
      hora_salida: result.rows[0].hora_salida,
    });
  } catch (error: any) {
    console.error("❌ HORA SALIDA ERROR:", error.message);
    res.status(500).json({ error: "Error al registrar hora de salida" });
  }
};

// ==========================
// REGISTRAR HORA DE LLEGADA
// (timestamp completo: fecha + hora)
// ==========================
export const registrarHoraLlegada = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const ahora = new Date();

    const result = await pool.query(
      `UPDATE bitacora_reparto
       SET hora_llegada = $1, updated_at = NOW()
       WHERE idbitacora = $2
       RETURNING idbitacora, hora_llegada`,
      [ahora, id]
    );

    if ((result.rowCount ?? 0) === 0)
      return res.status(404).json({ error: "Registro no encontrado" });

    console.log("✅ Hora llegada registrada:", ahora);
    res.json({
      message:     "Hora de llegada registrada",
      idbitacora:  Number(result.rows[0].idbitacora),
      hora_llegada: result.rows[0].hora_llegada,
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
      return res.status(400).json({ error: "Observación inválida. Valores: E, RA, RD, PD" });

    // Actualizar número de guía en la tabla envio si viene
    if (numero_guia !== undefined) {
      await pool.query(
        `UPDATE envio SET numero_guia = $1
         WHERE idenvio = (
           SELECT envio_idenvio FROM bitacora_reparto WHERE idbitacora = $2
         )`,
        [numero_guia || null, id]
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
        hora_salida       || null,
        hora_llegada      || null,
        observacion       || null,
        observacion_extra || null,
        firma             || null,
        id,
      ]
    );

    if ((result.rowCount ?? 0) === 0)
      return res.status(404).json({ error: "Registro no encontrado" });

    console.log("✅ Bitácora actualizada:", id);
    res.json({ message: "Registro actualizado exitosamente", bitacora: result.rows[0] });
  } catch (error: any) {
    console.error("❌ UPDATE BITACORA ERROR:", error.message);
    res.status(500).json({ error: "Error al actualizar registro" });
  }
};