import { Request, Response } from "express";
import { pool } from "../../config/db";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { getPresignedUrl } from "../../config/multer";

// ============================================================
// HELPERS
// ============================================================

async function crearMensajeSistema(
  client: any,
  ordenId: number,
  contenido: string,
  revisionId?: number
) {
  await client.query(
    `INSERT INTO mensaje_diseno (orden_diseno_id, usuario_id, contenido, tipo, revision_id)
     VALUES ($1, NULL, $2, 'sistema', $3)`,
    [ordenId, contenido, revisionId ?? null]
  );
}

async function notificarParticipantes(
  client: any,
  ordenId: number,
  remitenteId: number,
  modulo: string,
  tipo: string,
  mensaje: string
) {
  const { rows: participantes } = await client.query(
    `SELECT usuario_id FROM orden_diseno_participante
     WHERE orden_diseno_id = $1 AND usuario_id != $2`,
    [ordenId, remitenteId]
  );

  for (const p of participantes) {
    await client.query(
      `INSERT INTO notificaciones (usuario_id, modulo, tipo, entidad_id, mensaje)
       VALUES ($1, $2, $3, $4, $5)`,
      [p.usuario_id, modulo, tipo, ordenId, mensaje]
    );
  }
}

// ============================================================
// CREAR ORDEN DE DISEÑO
// ============================================================
export const crearOrdenDiseno = async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const { idsolicitud, no_pedido, participantes } = req.body;
    const usuarioId = req.user!.id;

    if (!idsolicitud || !no_pedido) {
      return res.status(400).json({ error: "idsolicitud y no_pedido son requeridos" });
    }

    await client.query("BEGIN");

    const { rows: existente } = await client.query(
      `SELECT idorden_diseno FROM orden_diseno
       WHERE solicitud_producto_id = $1 AND estado != 'rechazado'`,
      [idsolicitud]
    );

    if (existente.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Ya existe una orden de diseño activa para este pedido",
        idorden_diseno: existente[0].idorden_diseno,
      });
    }

    const { rows } = await client.query(
      `INSERT INTO orden_diseno (solicitud_producto_id, no_pedido, estado, version_actual)
       VALUES ($1, $2, 'en_revision', 1)
       RETURNING idorden_diseno`,
      [idsolicitud, no_pedido]
    );

    const ordenId = rows[0].idorden_diseno;

    await client.query(
      `INSERT INTO orden_diseno_participante (orden_diseno_id, usuario_id, rol_en_orden)
       VALUES ($1, $2, 'ventas')`,
      [ordenId, usuarioId]
    );

    if (participantes && Array.isArray(participantes)) {
      for (const p of participantes) {
        if (p.usuario_id === usuarioId) continue;
        await client.query(
          `INSERT INTO orden_diseno_participante (orden_diseno_id, usuario_id, rol_en_orden)
           VALUES ($1, $2, $3)
           ON CONFLICT (orden_diseno_id, usuario_id) DO NOTHING`,
          [ordenId, p.usuario_id, p.rol_en_orden ?? "otro"]
        );
      }
    }

    await crearMensajeSistema(
      client,
      ordenId,
      `Orden de diseño creada para el pedido #${no_pedido}.`
    );

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Orden de diseño creada exitosamente",
      idorden_diseno: ordenId,
      no_pedido,
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ CREAR ORDEN DISEÑO ERROR:", error.message);
    return res.status(500).json({ error: "Error al crear orden de diseño" });
  } finally {
    client.release();
  }
};

// ============================================================
// OBTENER TODAS LAS ÓRDENES DE DISEÑO
// ============================================================
export const getOrdenesDiseno = async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        od.idorden_diseno,
        od.solicitud_producto_id,
        od.no_pedido,
        od.estado,
        od.version_actual,
        od.created_at,
        od.autorizado_at,
        od.no_orden_diseno,
        s.no_cotizacion,
        c.impresion    AS cliente_impresion,
        c.empresa      AS cliente_empresa,
        c.idclientes,
        s.estado       AS solicitud_estado,
        (SELECT COUNT(*) FROM orden_diseno_participante odp
         WHERE odp.orden_diseno_id = od.idorden_diseno) AS total_participantes,
        (SELECT created_at FROM mensaje_diseno md
         WHERE md.orden_diseno_id = od.idorden_diseno
         ORDER BY created_at DESC LIMIT 1) AS ultima_actividad,
        (SELECT contenido FROM mensaje_diseno md
         WHERE md.orden_diseno_id = od.idorden_diseno
         ORDER BY created_at DESC LIMIT 1) AS ultimo_mensaje
      FROM orden_diseno od
      JOIN solicitud_producto sp ON sp.idsolicitud_producto = od.solicitud_producto_id
      JOIN solicitud s           ON s.idsolicitud           = sp.solicitud_idsolicitud
      JOIN clientes c            ON c.idclientes            = s.clientes_idclientes
      WHERE
        od.estado = 'en_revision'
        OR (od.estado = 'aprobado'  AND od.autorizado_at > NOW() - INTERVAL '7 days')
        OR (od.estado = 'rechazado' AND od.created_at   > NOW() - INTERVAL '7 days')
      ORDER BY
        CASE od.estado WHEN 'en_revision' THEN 0 ELSE 1 END,
        od.created_at DESC
    `);

    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET ORDENES DISEÑO ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener órdenes de diseño" });
  }
};

// ============================================================
// OBTENER UNA ORDEN DE DISEÑO POR ID — con URLs firmadas S3
// ============================================================
export const getOrdenDisenoById = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { rows: ordenRows } = await pool.query(`
      SELECT
        od.idorden_diseno,
        od.solicitud_producto_id,
        od.no_pedido,
        od.estado,
        od.version_actual,
        od.created_at,
        od.autorizado_at,
        od.no_orden_diseno,
        s.no_cotizacion,
        c.impresion  AS cliente_impresion,
        c.empresa    AS cliente_empresa,
        c.idclientes
      FROM orden_diseno od
      JOIN solicitud_producto sp ON sp.idsolicitud_producto = od.solicitud_producto_id
      JOIN solicitud s           ON s.idsolicitud           = sp.solicitud_idsolicitud
      JOIN clientes c            ON c.idclientes            = s.clientes_idclientes
      WHERE od.idorden_diseno = $1
    `, [id]);

    if (ordenRows.length === 0) {
      return res.status(404).json({ error: "Orden de diseño no encontrada" });
    }

    const orden = ordenRows[0];

    // Participantes
    const { rows: participantes } = await pool.query(`
      SELECT DISTINCT ON (u.idusuario)
        COALESCE(odp.idparticipante, -u.idusuario)          AS idparticipante,
        u.idusuario                                          AS usuario_id,
        COALESCE(odp.rol_en_orden, 'otro')                   AS rol_en_orden,
        COALESCE(odp.agregado_at, md.primera_actividad)      AS agregado_at,
        u.nombre,
        u.apellido,
        r.nombre AS rol_sistema
      FROM usuarios u
      JOIN roles r ON r.idroles = u.roles_idroles
      LEFT JOIN orden_diseno_participante odp
        ON odp.usuario_id       = u.idusuario
        AND odp.orden_diseno_id = $1
      LEFT JOIN (
        SELECT usuario_id, MIN(created_at) AS primera_actividad
        FROM mensaje_diseno
        WHERE orden_diseno_id = $1 AND usuario_id IS NOT NULL
        GROUP BY usuario_id
      ) md ON md.usuario_id = u.idusuario
      WHERE odp.idparticipante IS NOT NULL
         OR md.usuario_id IS NOT NULL
      ORDER BY u.idusuario, odp.agregado_at ASC NULLS LAST
    `, [id]);

    // Revisiones con archivos — incluye categoria
    const { rows: revisiones } = await pool.query(`
      SELECT
        rd.idrevision,
        rd.numero_version,
        rd.tipo,
        rd.observaciones,
        rd.created_at,
        rd.subido_por_id,
        rd.es_version_final,
        u.nombre    AS subido_por_nombre,
        u.apellido  AS subido_por_apellido,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id_archivo',    a.id_archivo,
              'nombre',        a.nombre,
              'public_id',     a.public_id,
              'tipo',          a.tipo,
              'mime_type',     a.mime_type,
              'resource_type', a.resource_type,
              'categoria',     a.categoria
            )
          ) FILTER (WHERE a.id_archivo IS NOT NULL),
          '[]'
        ) AS archivos
      FROM revision_diseno rd
      JOIN usuarios u ON u.idusuario = rd.subido_por_id
      LEFT JOIN archivos a ON a.revision_diseno_id = rd.idrevision
      WHERE rd.orden_diseno_id = $1
      GROUP BY rd.idrevision, u.nombre, u.apellido
      ORDER BY rd.numero_version ASC, rd.created_at ASC
    `, [id]);

    // Generar URLs firmadas S3
    const revisionesConUrls = await Promise.all(
      revisiones.map(async (rev) => ({
        ...rev,
        archivos: await Promise.all(
          (rev.archivos || []).map(async (archivo: any) => ({
            ...archivo,
            url: archivo.public_id
              ? await getPresignedUrl(archivo.public_id)
              : null,
          }))
        ),
      }))
    );

    const { rows: mensajes } = await pool.query(`
      SELECT
        md.idmensaje,
        md.contenido,
        md.tipo,
        md.revision_id,
        md.created_at,
        md.usuario_id,
        u.nombre   AS usuario_nombre,
        u.apellido AS usuario_apellido
      FROM mensaje_diseno md
      LEFT JOIN usuarios u ON u.idusuario = md.usuario_id
      WHERE md.orden_diseno_id = $1
      ORDER BY md.created_at ASC
    `, [id]);

    return res.json({
      ...orden,
      participantes,
      revisiones: revisionesConUrls,
      mensajes,
    });
  } catch (error: any) {
    console.error("❌ GET ORDEN DISEÑO BY ID ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener orden de diseño" });
  }
};

// ============================================================
// OBTENER MENSAJES (polling)
// ============================================================
export const getMensajesOrden = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { desde } = req.query;

    let query = `
      SELECT
        md.idmensaje,
        md.contenido,
        md.tipo,
        md.revision_id,
        md.created_at,
        md.usuario_id,
        u.nombre   AS usuario_nombre,
        u.apellido AS usuario_apellido
      FROM mensaje_diseno md
      LEFT JOIN usuarios u ON u.idusuario = md.usuario_id
      WHERE md.orden_diseno_id = $1
    `;
    const params: any[] = [id];

    if (desde) {
      query += ` AND md.created_at > $2::timestamptz`;
      params.push(desde);
    }

    query += ` ORDER BY md.created_at ASC`;

    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET MENSAJES ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener mensajes" });
  }
};

// ============================================================
// ENVIAR MENSAJE DE TEXTO
// ============================================================
export const enviarMensaje = async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { contenido } = req.body;
    const usuarioId = req.user!.id;

    if (!contenido || contenido.trim() === "") {
      return res.status(400).json({ error: "El contenido del mensaje es requerido" });
    }

    await client.query("BEGIN");

    const { rows: ordenRows } = await client.query(
      `SELECT estado FROM orden_diseno WHERE idorden_diseno = $1`,
      [id]
    );

    if (ordenRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    if (ordenRows[0].estado === "aprobado") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No se puede enviar mensajes a una orden aprobada" });
    }

    const { rows: usuarioRows } = await client.query(
      `SELECT p.privilegio
       FROM usuarios u
       JOIN roles r              ON r.idroles               = u.roles_idroles
       JOIN roles_privilegios rp ON rp.roles_idroles        = r.idroles
       JOIN privilegios p        ON p.idprivilegios         = rp.privilegios_idprivilegios
       WHERE u.idusuario = $1
         AND p.idprivilegios IN (8, 22)
       LIMIT 1`,
      [usuarioId]
    );

    const privilegio = usuarioRows[0]?.privilegio ?? "";
    const rolEnOrden = privilegio === "Editar Diseño"
      ? "diseno"
      : privilegio === "Orden de Diseño"
      ? "ventas"
      : "otro";

    await client.query(
      `INSERT INTO orden_diseno_participante (orden_diseno_id, usuario_id, rol_en_orden)
       VALUES ($1, $2, $3)
       ON CONFLICT (orden_diseno_id, usuario_id) DO NOTHING`,
      [id, usuarioId, rolEnOrden]
    );

    const { rows } = await client.query(
      `INSERT INTO mensaje_diseno (orden_diseno_id, usuario_id, contenido, tipo)
       VALUES ($1, $2, $3, 'texto')
       RETURNING idmensaje, contenido, tipo, created_at, usuario_id`,
      [id, usuarioId, contenido.trim()]
    );

    await notificarParticipantes(
      client, Number(id), usuarioId,
      "orden_diseno", "nuevo_mensaje",
      `Nuevo mensaje en orden de diseño #${id}`
    );

    await client.query("COMMIT");
    return res.status(201).json(rows[0]);
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ ENVIAR MENSAJE ERROR:", error.message);
    return res.status(500).json({ error: "Error al enviar mensaje" });
  } finally {
    client.release();
  }
};

// ============================================================
// SUBIR RENDER O FEEDBACK
// ============================================================
export const subirRevision = async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { tipo, observaciones, archivos } = req.body;
    const usuarioId = req.user!.id;

    if (!tipo || !["render", "feedback"].includes(tipo)) {
      return res.status(400).json({ error: "tipo debe ser 'render' o 'feedback'" });
    }

    if (!archivos || !Array.isArray(archivos) || archivos.length === 0) {
      return res.status(400).json({ error: "Se requiere al menos un archivo" });
    }

    await client.query("BEGIN");

    const { rows: ordenRows } = await client.query(
      `SELECT version_actual, estado, no_pedido FROM orden_diseno WHERE idorden_diseno = $1`,
      [id]
    );

    if (ordenRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    if (ordenRows[0].estado === "aprobado") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "La orden ya fue aprobada" });
    }

    const versionActual = ordenRows[0].version_actual;
    const noPedido      = ordenRows[0].no_pedido;
    const nuevaVersion  = tipo === "render" ? versionActual + 1 : versionActual;

    const { rows: revRows } = await client.query(
      `INSERT INTO revision_diseno (orden_diseno_id, numero_version, tipo, subido_por_id, observaciones)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING idrevision`,
      [id, nuevaVersion, tipo, usuarioId, observaciones ?? null]
    );

    const revisionId = revRows[0].idrevision;

    for (const archivo of archivos) {
      await client.query(
        `UPDATE archivos SET revision_diseno_id = $1 WHERE id_archivo = $2`,
        [revisionId, archivo.id_archivo]
      );
    }

    if (tipo === "render") {
      await client.query(
        `UPDATE orden_diseno SET version_actual = $1 WHERE idorden_diseno = $2`,
        [nuevaVersion, id]
      );
    }

    const labelTipo = tipo === "render" ? `Render v${nuevaVersion}` : "Feedback del cliente";
    await crearMensajeSistema(
      client, Number(id),
      `${labelTipo} subido para el pedido #${noPedido}.`,
      revisionId
    );

    await notificarParticipantes(
      client, Number(id), usuarioId,
      "orden_diseno",
      tipo === "render" ? "nuevo_render" : "nuevo_feedback",
      tipo === "render"
        ? `Nuevo render v${nuevaVersion} subido — pedido #${noPedido}`
        : `Nuevo feedback del cliente — pedido #${noPedido}`
    );

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Revisión registrada exitosamente",
      idrevision: revisionId,
      numero_version: nuevaVersion,
      tipo,
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ SUBIR REVISIÓN ERROR:", error.message);
    return res.status(500).json({ error: "Error al registrar revisión" });
  } finally {
    client.release();
  }
};

// ============================================================
// APROBAR ORDEN DE DISEÑO
// ============================================================
export const aprobarOrdenDiseno = async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const usuarioId = req.user!.id;

    await client.query("BEGIN");

    const { rows: ordenRows } = await client.query(
      `SELECT estado, no_pedido FROM orden_diseno WHERE idorden_diseno = $1`,
      [id]
    );

    if (ordenRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    if (ordenRows[0].estado === "aprobado") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "La orden ya fue aprobada" });
    }

    const noPedido = ordenRows[0].no_pedido;

    await client.query(
      `UPDATE orden_diseno
       SET estado = 'aprobado', autorizado_at = NOW()
       WHERE idorden_diseno = $1`,
      [id]
    );

    await crearMensajeSistema(
      client, Number(id),
      `✅ Diseño aprobado por el cliente — pedido #${noPedido}.`
    );

    await notificarParticipantes(
      client, Number(id), usuarioId,
      "orden_diseno", "aprobado",
      `Diseño aprobado — pedido #${noPedido}`
    );

    await client.query("COMMIT");

    return res.json({
      message: "Orden de diseño aprobada exitosamente",
      idorden_diseno: Number(id),
      estado: "aprobado",
      autorizado_at: new Date(),
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ APROBAR ORDEN DISEÑO ERROR:", error.message);
    return res.status(500).json({ error: "Error al aprobar orden de diseño" });
  } finally {
    client.release();
  }
};

// ============================================================
// AGREGAR PARTICIPANTE
// ============================================================
export const agregarParticipante = async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { usuario_id, rol_en_orden } = req.body;

    if (!usuario_id) {
      return res.status(400).json({ error: "usuario_id es requerido" });
    }

    await client.query("BEGIN");

    await client.query(
      `INSERT INTO orden_diseno_participante (orden_diseno_id, usuario_id, rol_en_orden)
       VALUES ($1, $2, $3)
       ON CONFLICT (orden_diseno_id, usuario_id) DO UPDATE SET rol_en_orden = $3`,
      [id, usuario_id, rol_en_orden ?? "otro"]
    );

    await client.query(
      `INSERT INTO notificaciones (usuario_id, modulo, tipo, entidad_id, mensaje)
       VALUES ($1, 'orden_diseno', 'agregado_como_participante', $2, $3)`,
      [usuario_id, id, `Fuiste agregado a la orden de diseño #${id}`]
    );

    await client.query("COMMIT");
    return res.json({ message: "Participante agregado exitosamente" });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ AGREGAR PARTICIPANTE ERROR:", error.message);
    return res.status(500).json({ error: "Error al agregar participante" });
  } finally {
    client.release();
  }
};

// ============================================================
// OBTENER NOTIFICACIONES
// ============================================================
export const getNotificaciones = async (req: AuthRequest, res: Response) => {
  try {
    const usuarioId = req.user!.id;

    const { rows } = await pool.query(`
      SELECT idnotificacion, modulo, tipo, entidad_id, mensaje, leido, created_at
      FROM notificaciones
      WHERE usuario_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [usuarioId]);

    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET NOTIFICACIONES ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener notificaciones" });
  }
};

// ============================================================
// MARCAR NOTIFICACIONES COMO LEÍDAS
// ============================================================
export const marcarNotificacionesLeidas = async (req: AuthRequest, res: Response) => {
  try {
    const usuarioId = req.user!.id;
    const { ids } = req.body;

    if (ids && Array.isArray(ids) && ids.length > 0) {
      await pool.query(
        `UPDATE notificaciones SET leido = true
         WHERE usuario_id = $1 AND idnotificacion = ANY($2)`,
        [usuarioId, ids]
      );
    } else {
      await pool.query(
        `UPDATE notificaciones SET leido = true WHERE usuario_id = $1`,
        [usuarioId]
      );
    }

    return res.json({ message: "Notificaciones marcadas como leídas" });
  } catch (error: any) {
    console.error("❌ MARCAR NOTIFICACIONES ERROR:", error.message);
    return res.status(500).json({ error: "Error al marcar notificaciones" });
  }
};

// ============================================================
// MARCAR REVISIÓN COMO VERSIÓN FINAL
// ============================================================
export const marcarVersionFinal = async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const { id, revId } = req.params;

    await client.query("BEGIN");

    const { rows: revRows } = await client.query(
      `SELECT rd.idrevision, rd.tipo, rd.orden_diseno_id
       FROM revision_diseno rd
       WHERE rd.idrevision = $1 AND rd.orden_diseno_id = $2`,
      [revId, id]
    );

    if (revRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Revisión no encontrada" });
    }

    if (revRows[0].tipo !== "render") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Solo se pueden marcar renders como versión final" });
    }

    await client.query(
      `UPDATE revision_diseno SET es_version_final = false
       WHERE orden_diseno_id = $1 AND es_version_final = true`,
      [id]
    );

    await client.query(
      `UPDATE revision_diseno SET es_version_final = true WHERE idrevision = $1`,
      [revId]
    );

    await client.query("COMMIT");

    return res.json({
      message: "Versión final marcada exitosamente",
      idrevision: Number(revId),
      es_version_final: true,
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ MARCAR VERSION FINAL ERROR:", error.message);
    return res.status(500).json({ error: "Error al marcar versión final" });
  } finally {
    client.release();
  }
};

// ============================================================
// LIMPIEZA AUTOMÁTICA
// ============================================================
export const limpiarChatsAntiguos = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: ordenes } = await client.query(`
      SELECT idorden_diseno FROM orden_diseno
      WHERE estado = 'aprobado'
        AND autorizado_at < NOW() - INTERVAL '30 days'
    `);

    let totalMensajes = 0;
    let totalArchivos = 0;

    for (const orden of ordenes) {
      const ordenId = orden.idorden_diseno;

      const { rows: finalRows } = await client.query(
        `SELECT idrevision FROM revision_diseno
         WHERE orden_diseno_id = $1 AND es_version_final = true
         LIMIT 1`,
        [ordenId]
      );
      const revisionFinalId = finalRows[0]?.idrevision ?? null;

      const { rowCount: archivosEliminados } = await client.query(
        revisionFinalId
          ? `UPDATE archivos SET revision_diseno_id = NULL
             WHERE revision_diseno_id IN (
               SELECT idrevision FROM revision_diseno
               WHERE orden_diseno_id = $1 AND idrevision != $2
             )`
          : `UPDATE archivos SET revision_diseno_id = NULL
             WHERE revision_diseno_id IN (
               SELECT idrevision FROM revision_diseno
               WHERE orden_diseno_id = $1
             )`,
        revisionFinalId ? [ordenId, revisionFinalId] : [ordenId]
      );

      const { rowCount: mensajesEliminados } = await client.query(
        revisionFinalId
          ? `DELETE FROM mensaje_diseno
             WHERE orden_diseno_id = $1
               AND NOT (tipo = 'sistema' AND revision_id = $2)`
          : `DELETE FROM mensaje_diseno WHERE orden_diseno_id = $1`,
        revisionFinalId ? [ordenId, revisionFinalId] : [ordenId]
      );

      totalArchivos += archivosEliminados ?? 0;
      totalMensajes += mensajesEliminados ?? 0;
    }

    await client.query("COMMIT");

    return res.json({
      message: "Limpieza completada",
      ordenes_procesadas: ordenes.length,
      mensajes_eliminados: totalMensajes,
      archivos_desvinculados: totalArchivos,
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ LIMPIEZA ERROR:", error.message);
    return res.status(500).json({ error: "Error en la limpieza" });
  } finally {
    client.release();
  }
};