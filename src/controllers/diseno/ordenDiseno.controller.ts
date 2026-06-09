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

const ESTADO = {
  PENDIENTE:  1,
  EN_PROCESO: 2,
  APROBADO:   3,
} as const;

// ============================================================
// HELPERS DE PRODUCCIÓN
// ============================================================

async function generarNoProduccion(client: any): Promise<string> {
  const anio = new Date().getFullYear().toString().slice(-2);
  const prefijo = `OP${anio}`;

  const { rows } = await client.query(
    `SELECT MAX(CAST(SUBSTRING(no_produccion FROM 5) AS INTEGER)) AS ultimo
     FROM orden_produccion
     WHERE no_produccion LIKE $1`,
    [`${prefijo}%`]
  );

  const siguiente = (rows[0].ultimo ?? 0) + 1;
  return `${prefijo}${String(siguiente).padStart(3, "0")}`;
}

async function anticipoPagado(client: any, solicitudId: number): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT anticipo, abono, estado_administrativo_cat_idestado_administrativo_cat AS estado_id
     FROM ventas WHERE solicitud_idsolicitud = $1`,
    [solicitudId]
  );
  if (rows.length === 0) return false;
  const abono    = Number(rows[0].abono);
  const anticipo = Number(rows[0].anticipo);
  const estadoId = Number(rows[0].estado_id);
  return abono >= anticipo || estadoId === 2 || estadoId === 6;
}

async function obtenerMerma(client: any, kilos: number, tintasId: number): Promise<number> {
  if (!kilos || kilos <= 0) return 0;
  try {
    const { rows } = await client.query(`
      SELECT tp.merma_porcentaje
      FROM tarifas_produccion tp
      INNER JOIN kilogramos k ON k.idkilogramos = tp.kilogramos_idkilogramos
      WHERE tp.tintas_idtintas = $1
        AND $2 >= k.kg_min
        AND ($2 <= k.kg_max OR k.kg_max IS NULL)
      LIMIT 1
    `, [tintasId, kilos]);
    if (rows.length === 0) return 0;
    return Number(rows[0].merma_porcentaje);
  } catch (err: any) {
    console.warn("⚠️ obtenerMerma error:", err.message);
    return 0;
  }
}

function calcularDatosExtrusion(p: {
  alto: number; ancho: number;
  fuelle_fondo: number; fuelle_lat_iz: number; fuelle_lat_de: number;
  refuerzo: number; cantidad: number;
}): { repeticion_extrusion: number; repeticion_metro: number; metros: number; ancho_bobina: number } {
  let repeticion_extrusion: number;
  let ancho_bobina: number;

  if (p.fuelle_fondo > 0) {
    repeticion_extrusion = p.ancho;
    ancho_bobina         = p.alto + p.fuelle_fondo + p.refuerzo;
  } else {
    repeticion_extrusion = p.alto;
    ancho_bobina         = p.ancho + p.fuelle_lat_iz + p.fuelle_lat_de + p.refuerzo;
  }

  const repeticion_metro = repeticion_extrusion > 0
    ? parseFloat((100 / repeticion_extrusion).toFixed(4)) : 0;
  const metros = parseFloat((p.cantidad * (repeticion_extrusion / 100)).toFixed(1));

  return {
    repeticion_extrusion: parseFloat(repeticion_extrusion.toFixed(2)),
    repeticion_metro,
    metros,
    ancho_bobina: parseFloat(ancho_bobina.toFixed(2)),
  };
}

async function buscarRepeticionRodillos(
  client: any, valor: number
): Promise<{ kidder: string | null; sicosa: string | null }> {
  if (!valor || valor <= 0) return { kidder: null, sicosa: null };
  try {
    const { rows: kidderRows } = await client.query(`
      SELECT sin_grabado, con_grabado_1rep, con_grabado_2rep, con_grabado_3rep,
        LEAST(ABS(con_grabado_1rep-$1),ABS(con_grabado_2rep-$1),ABS(con_grabado_3rep-$1)) AS distancia_min
      FROM rodillos_kidder ORDER BY distancia_min ASC LIMIT 1
    `, [valor]);

    const { rows: sicosaRows } = await client.query(`
      SELECT sin_grabado, con_grabado_1rep, con_grabado_2rep, con_grabado_3rep,
             con_grabado_4rep, con_grabado_5rep,
        LEAST(ABS(con_grabado_1rep-$1),ABS(con_grabado_2rep-$1),ABS(con_grabado_3rep-$1),
              ABS(con_grabado_4rep-$1),ABS(con_grabado_5rep-$1)) AS distancia_min
      FROM rodillos_sicosa ORDER BY distancia_min ASC LIMIT 1
    `, [valor]);

    const formatearRodillo = (row: any, reps: { label: string; col: string }[]): string | null => {
      if (!row) return null;
      const candidatos = reps
        .map(r => ({ label: r.label, valor: parseFloat(row[r.col]) || 0 }))
        .filter(r => r.valor > 0);
      if (candidatos.length === 0) return null;
      const mejor = candidatos.reduce((prev, curr) =>
        Math.abs(curr.valor - valor) < Math.abs(prev.valor - valor) ? curr : prev
      );
      const sinGrab  = parseFloat(row.sin_grabado).toFixed(2);
      const esExacto = Math.abs(mejor.valor - valor) < 0.001;
      return `SG=${sinGrab} | ${esExacto ? "" : "~"}${mejor.valor.toFixed(2)} (${mejor.label})`;
    };

    const kidder = formatearRodillo(kidderRows[0], [
      { label: "1 rep", col: "con_grabado_1rep" },
      { label: "2 rep", col: "con_grabado_2rep" },
      { label: "3 rep", col: "con_grabado_3rep" },
    ]);
    const sicosa = formatearRodillo(sicosaRows[0], [
      { label: "1 rep", col: "con_grabado_1rep" },
      { label: "2 rep", col: "con_grabado_2rep" },
      { label: "3 rep", col: "con_grabado_3rep" },
      { label: "4 rep", col: "con_grabado_4rep" },
      { label: "5 rep", col: "con_grabado_5rep" },
    ]);
    return { kidder, sicosa };
  } catch (err: any) {
    console.warn("⚠️ buscarRepeticionRodillos error:", err.message);
    return { kidder: null, sicosa: null };
  }
}

async function getMedidasParaOrden(client: any, idsolicitudProducto: number) {
  const { rows } = await client.query(`
    SELECT
      COALESCE(cfg.altura,       0) AS alto,
      COALESCE(cfg.ancho,        0) AS ancho,
      COALESCE(cfg.fuelle_fondo, 0) AS fuelle_fondo,
      COALESCE(cfg.fuelle_latIz, 0) AS fuelle_lat_iz,
      COALESCE(cfg.fuelle_latDe, 0) AS fuelle_lat_de,
      COALESCE(cfg.refuerzo,     0) AS refuerzo,
      COALESCE(sd.cantidad,      0) AS cantidad,
      sd.kilogramos,
      sd.modo_cantidad,
      sp.tintas_idtintas
    FROM solicitud_producto sp
    JOIN configuracion_plastico cfg
        ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
    LEFT JOIN solicitud_detalle sd
        ON sd.solicitud_producto_id = sp.idsolicitud_producto
        AND sd.aprobado = true
    WHERE sp.idsolicitud_producto = $1
    LIMIT 1
  `, [idsolicitudProducto]);
  return rows[0] ?? null;
}

async function prepararDatosOrden(client: any, idsolicitudProducto: number) {
  const medidas = await getMedidasParaOrden(client, idsolicitudProducto);

  if (!medidas) {
    return {
      repeticion_extrusion: null, repeticion_metro: null,
      metros: null, metros_merma: null, ancho_bobina: null,
      kilos: null, kilos_merma: null, pzas: null, pzas_merma: null,
      repeticion_kidder: null, repeticion_sicosa: null,
    };
  }

  const cantidad = Number(medidas.cantidad);
  const kilos    = medidas.kilogramos ? parseFloat(Number(medidas.kilogramos).toFixed(4)) : null;
  const tintasId = Number(medidas.tintas_idtintas) || 1;

  const mermaPct    = kilos ? await obtenerMerma(client, kilos, tintasId) : 0;
  const factorMerma = 1 + mermaPct / 100;

  const kilos_merma = kilos ? parseFloat((kilos * factorMerma).toFixed(2)) : null;
  const pzas        = cantidad > 0 ? cantidad : null;
  const pzas_merma  = pzas ? Math.round(pzas * factorMerma) : null;

  if (cantidad <= 0) {
    return {
      repeticion_extrusion: null, repeticion_metro: null,
      metros: null, metros_merma: null, ancho_bobina: null,
      kilos, kilos_merma, pzas, pzas_merma,
      repeticion_kidder: null, repeticion_sicosa: null,
    };
  }

  const ext = calcularDatosExtrusion({
    alto:          Number(medidas.alto),
    ancho:         Number(medidas.ancho),
    fuelle_fondo:  Number(medidas.fuelle_fondo),
    fuelle_lat_iz: Number(medidas.fuelle_lat_iz),
    fuelle_lat_de: Number(medidas.fuelle_lat_de),
    refuerzo:      Number(medidas.refuerzo),
    cantidad,
  });

  const metros_merma = parseFloat((ext.metros * factorMerma).toFixed(1));
  const rodillos     = await buscarRepeticionRodillos(client, ext.repeticion_extrusion);

  return {
    repeticion_extrusion: ext.repeticion_extrusion,
    repeticion_metro:     ext.repeticion_metro,
    metros:               ext.metros,
    metros_merma,
    ancho_bobina:         ext.ancho_bobina,
    kilos, kilos_merma, pzas, pzas_merma,
    repeticion_kidder:    rodillos.kidder,
    repeticion_sicosa:    rodillos.sicosa,
  };
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
    `UPDATE archivos SET revision_diseno_id = $1, categoria = $2 WHERE id_archivo = $3`,
    [revisionId, archivo.categoria ?? "otro", archivo.id_archivo]
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
      `SELECT estado, no_pedido, solicitud_producto_id FROM orden_diseno WHERE idorden_diseno = $1`,
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

    const noPedido            = ordenRows[0].no_pedido;
    const solicitudProductoId = ordenRows[0].solicitud_producto_id;

    // 1. Aprobar la orden_diseno
    await client.query(
      `UPDATE orden_diseno
       SET estado = 'aprobado', autorizado_at = NOW()
       WHERE idorden_diseno = $1`,
      [id]
    );

    // 2. Aprobar el diseno_producto correspondiente
    const { rows: dpRows } = await client.query(
      `SELECT dp.iddiseno_producto, dp.diseno_iddiseno, d.solicitud_idsolicitud
       FROM diseno_producto dp
       JOIN diseno d ON d.iddiseno = dp.diseno_iddiseno
       WHERE dp.solicitud_producto_idsolicitud_producto = $1
       LIMIT 1`,
      [solicitudProductoId]
    );

    let ordenGenerada    = false;
    let noProduccion: string | null = null;

    if (dpRows.length > 0) {
      const dp          = dpRows[0];
      const disenoId    = dp.diseno_iddiseno;
      const solicitudId = dp.solicitud_idsolicitud;

      await client.query(
        `UPDATE diseno_producto
         SET estado_administrativo_cat_idestado_administrativo_cat = $1,
             fecha_aprobacion = NOW(),
             fecha = NOW()
         WHERE iddiseno_producto = $2`,
        [ESTADO.APROBADO, dp.iddiseno_producto]
      );

      const { rows: todosProductos } = await client.query(
        `SELECT estado_administrativo_cat_idestado_administrativo_cat AS estado_id
         FROM diseno_producto WHERE diseno_iddiseno = $1`,
        [disenoId]
      );

      const estadosPadre = todosProductos.map((p: any) => Number(p.estado_id));
      const nuevoEstadoPadre =
        estadosPadre.every(e => e === ESTADO.APROBADO)                            ? ESTADO.APROBADO   :
        estadosPadre.some(e  => e === ESTADO.EN_PROCESO || e === ESTADO.APROBADO) ? ESTADO.EN_PROCESO :
                                                                                     ESTADO.PENDIENTE;

      await client.query(
        `UPDATE diseno SET estado_administrativo_cat_idestado_administrativo_cat = $1 WHERE iddiseno = $2`,
        [nuevoEstadoPadre, disenoId]
      );

      if (nuevoEstadoPadre === ESTADO.APROBADO) {
        await client.query(
          `UPDATE diseno SET fecha_aprobacion_general = NOW() WHERE iddiseno = $1`,
          [disenoId]
        );
      }

      // 3. Generar orden de producción si anticipo cubierto
      const cubierto = await anticipoPagado(client, solicitudId);
      if (cubierto) {
        // Advisory lock por producto — evita race condition con actualizarEstadoProducto
        await client.query(
          `SELECT pg_advisory_xact_lock($1)`,
          [solicitudProductoId]
        );

        const { rows: ordenExistente } = await client.query(
          `SELECT idproduccion FROM orden_produccion WHERE idsolicitud_producto = $1`,
          [solicitudProductoId]
        );

        if (ordenExistente.length === 0) {
          noProduccion     = await generarNoProduccion(client);
          const datosOrden = await prepararDatosOrden(client, solicitudProductoId);

          await client.query(
            `INSERT INTO orden_produccion (
              estado_administrativo_cat_idestado_administrativo_cat,
              no_produccion, fecha, fecha_entrega, idsolicitud, idsolicitud_producto,
              idestado_produccion_cat, repeticion_extrusion, repeticion_metro, metros,
              metros_merma, ancho_bobina, kilos, kilos_merma, pzas, pzas_merma,
              repeticion_kidder, repeticion_sicosa
            ) VALUES ($1,$2,NOW(),NOW() + INTERVAL '35 days',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
            ON CONFLICT (no_produccion) DO NOTHING`,
            [
              ESTADO.PENDIENTE, noProduccion, solicitudId, solicitudProductoId,
              ESTADO.PENDIENTE,
              datosOrden.repeticion_extrusion, datosOrden.repeticion_metro,
              datosOrden.metros,               datosOrden.metros_merma,
              datosOrden.ancho_bobina,
              datosOrden.kilos,                datosOrden.kilos_merma,
              datosOrden.pzas,                 datosOrden.pzas_merma,
              datosOrden.repeticion_kidder,    datosOrden.repeticion_sicosa,
            ]
          );
          ordenGenerada = true;
          console.log(`✅ Orden ${noProduccion} creada desde aprobación de orden de diseño`);
        } else {
          ordenGenerada = true;
        }
      }
    }

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
      message:        "Orden de diseño aprobada exitosamente",
      idorden_diseno: Number(id),
      estado:         "aprobado",
      autorizado_at:  new Date(),
      orden_generada: ordenGenerada,
      no_produccion:  noProduccion,
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
      ordenes_procesadas:     ordenes.length,
      mensajes_eliminados:    totalMensajes,
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

// ============================================================
// GET /orden-diseno/:id/observacion-producto
// ============================================================
export const getObservacionProducto = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(`
      SELECT
        sp.observacion,
        sp.descripcion,
        sp.pigmentos,
        sp.pantones,
        sp.perforacion,
        tpp.material_plastico_producto AS nombre_producto,
        cfg.medida
      FROM orden_diseno od
      JOIN solicitud_producto sp
          ON sp.idsolicitud_producto = od.solicitud_producto_id
      LEFT JOIN configuracion_plastico cfg
          ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN tipo_producto_plastico tpp
          ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      WHERE od.idorden_diseno = $1
    `, [id]);

    if (rows.length === 0)
      return res.status(404).json({ error: "Orden no encontrada" });

    return res.json(rows[0]);
  } catch (error: any) {
    console.error("❌ GET OBSERVACION PRODUCTO ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener observación" });
  }
};