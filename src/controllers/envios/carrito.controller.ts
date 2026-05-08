import { Request, Response } from "express";
import { pool } from "../../config/db";

// ==========================
// GET CARRITO
// ==========================
export const getCarrito = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        ce.idcarrito,
        ce.bultos_idbulto,
        ce.idsolicitud,
        ce.agregado_por,
        ce.paqueteria_idpaqueteria,
        ce.created_at,
        s.no_pedido,
        cli.empresa,
        cli.impresion,
        b.cantidad_unidades,
        b.peso_producto,
        b.peso,
        b.alto,
        b.largo,
        b.ancho,
        CASE
          WHEN b.asa_flexible_idasa_flexible IS NOT NULL THEN 'asa_flexible'
          ELSE 'bolseo'
        END AS proceso_origen,
        tpp.material_plastico_producto AS nombre_producto,
        cfg.medida,
        u.nombre  AS agregado_por_nombre,
        p.nombre  AS paqueteria_nombre
      FROM carrito_envio ce
      JOIN bultos b         ON b.idbulto            = ce.bultos_idbulto
      JOIN solicitud s      ON s.idsolicitud         = ce.idsolicitud
      JOIN clientes cli     ON cli.idclientes        = s.clientes_idclientes
      LEFT JOIN bolseo bol  ON bol.idbolseo          = b.bolseo_idbolseo
      LEFT JOIN asa_flexible af ON af.idasa_flexible = b.asa_flexible_idasa_flexible
      LEFT JOIN orden_produccion op
        ON op.idproduccion = COALESCE(bol.orden_produccion_idproduccion, af.orden_produccion_idproduccion)
      LEFT JOIN solicitud_producto sp
        ON sp.idsolicitud_producto = op.idsolicitud_producto
      LEFT JOIN configuracion_plastico cfg
        ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN tipo_producto_plastico tpp
        ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN usuarios u  ON u.idusuario           = ce.agregado_por
      LEFT JOIN paqueteria p ON p.idpaqueteria       = ce.paqueteria_idpaqueteria
      ORDER BY ce.idsolicitud, ce.idcarrito
    `);

    const pedidosMap = new Map<number, any>();
    rows.forEach((r: any) => {
      if (!pedidosMap.has(r.idsolicitud)) {
        pedidosMap.set(r.idsolicitud, {
          idsolicitud: r.idsolicitud,
          no_pedido:   r.no_pedido,
          cliente:     r.impresion || r.empresa || "",
          bultos:      [],
        });
      }
      pedidosMap.get(r.idsolicitud).bultos.push({
        idcarrito:              r.idcarrito,
        idbulto:                r.bultos_idbulto,
        nombre_producto:        r.nombre_producto        || "",
        medida:                 r.medida                 || "",
        cantidad_unidades:      r.cantidad_unidades != null ? Number(r.cantidad_unidades) : null,
        peso_producto:          r.peso_producto    != null ? Number(r.peso_producto)    : null,
        peso:                   r.peso             != null ? Number(r.peso)             : null,
        alto:                   r.alto             != null ? Number(r.alto)             : null,
        largo:                  r.largo            != null ? Number(r.largo)            : null,
        ancho:                  r.ancho            != null ? Number(r.ancho)            : null,
        proceso_origen:         r.proceso_origen,
        agregado_por:           r.agregado_por_nombre    || "",
        paqueteria_idpaqueteria: r.paqueteria_idpaqueteria != null ? Number(r.paqueteria_idpaqueteria) : null,
        paqueteria_nombre:      r.paqueteria_nombre      || null,
      });
    });

    res.json(Array.from(pedidosMap.values()));
  } catch (error: any) {
    console.error("❌ GET CARRITO ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener carrito" });
  }
};

// ==========================
// AGREGAR AL CARRITO
// ==========================
export const agregarAlCarrito = async (req: Request, res: Response) => {
  try {
    const { bultos_ids, idsolicitud } = req.body;
    const idusuario = (req as any).user?.id;

    if (!bultos_ids?.length || !idsolicitud)
      return res.status(400).json({ error: "bultos_ids e idsolicitud son requeridos" });

    // Verificar que los bultos estén sin enviar
    const { rows: bultosCheck } = await pool.query(
      `SELECT b.idbulto
       FROM bultos b
       LEFT JOIN envio_bulto eb ON eb.bultos_idbulto = b.idbulto
       WHERE b.idbulto = ANY($1::int[])
         AND eb.bultos_idbulto IS NULL`,
      [bultos_ids]
    );

    if (bultosCheck.length !== bultos_ids.length)
      return res.status(400).json({ error: "Algunos bultos ya tienen un envío asignado" });

    const values = bultos_ids.map((_: any, i: number) =>
      `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`
    ).join(", ");

    const params = bultos_ids.flatMap((id: number) => [id, idsolicitud, idusuario]);

    await pool.query(
      `INSERT INTO carrito_envio (bultos_idbulto, idsolicitud, agregado_por)
       VALUES ${values}
       ON CONFLICT (bultos_idbulto) DO NOTHING`,
      params
    );

    res.json({ message: "Bultos agregados al carrito" });
  } catch (error: any) {
    console.error("❌ AGREGAR CARRITO ERROR:", error.message);
    res.status(500).json({ error: "Error al agregar al carrito" });
  }
};

// ==========================
// ASIGNAR PAQUETERÍA A UN BULTO DEL CARRITO
// null = envío local
// ==========================
export const asignarPaqueteriaCarrito = async (req: Request, res: Response) => {
  try {
    const { idcarrito } = req.params;
    const { paqueteria_idpaqueteria } = req.body; // null = local

    const result = await pool.query(
      `UPDATE carrito_envio
       SET paqueteria_idpaqueteria = $1
       WHERE idcarrito = $2
       RETURNING idcarrito, paqueteria_idpaqueteria`,
      [paqueteria_idpaqueteria || null, idcarrito]
    );

    if ((result.rowCount ?? 0) === 0)
      return res.status(404).json({ error: "Entrada de carrito no encontrada" });

    res.json({ message: "Paquetería asignada", carrito: result.rows[0] });
  } catch (error: any) {
    console.error("❌ ASIGNAR PAQUETERIA CARRITO ERROR:", error.message);
    res.status(500).json({ error: "Error al asignar paquetería" });
  }
};

// ==========================
// QUITAR DEL CARRITO
// ==========================
export const quitarDelCarrito = async (req: Request, res: Response) => {
  try {
    const { idbulto } = req.params;

    await pool.query(
      `DELETE FROM carrito_envio WHERE bultos_idbulto = $1`,
      [idbulto]
    );

    res.json({ message: "Bulto removido del carrito" });
  } catch (error: any) {
    console.error("❌ QUITAR CARRITO ERROR:", error.message);
    res.status(500).json({ error: "Error al quitar del carrito" });
  }
};

// ==========================
// VACIAR CARRITO
// ==========================
export const vaciarCarrito = async (req: Request, res: Response) => {
  try {
    await pool.query(`DELETE FROM carrito_envio`);
    res.json({ message: "Carrito vaciado" });
  } catch (error: any) {
    console.error("❌ VACIAR CARRITO ERROR:", error.message);
    res.status(500).json({ error: "Error al vaciar carrito" });
  }
};

// ==========================
// PROCESAR CARRITO
// Agrupa bultos por paquetería y crea un envío por cada grupo
// null paquetería = envío local
// ==========================
export const procesarCarrito = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
 
    const {
      usuarios_idusuario,
      unidades_idunidad,
      costo_flete,
      fecha_entrega_estimada,
      observaciones,
      pedidos, // [{ idsolicitud, bultos: [{ idbulto, paqueteria_idpaqueteria }] }]
    } = req.body;
 
    if (!pedidos?.length)
      return res.status(400).json({ error: "pedidos es requerido" });
 
    // ── CAMBIO: ahora guardamos tipo + nombre de paquetería por envío ──
    const enviosCreados: {
      idenvio:                number;
      tipo:                   "local" | "paqueteria";
      paqueteria_idpaqueteria: number | null;
      paqueteria_nombre:      string | null;
    }[] = [];
 
    for (const pedido of pedidos) {
      const { idsolicitud, bultos } = pedido;
      if (!bultos?.length) continue;
 
      // Agrupar bultos por paquetería (null = local)
      const grupos = new Map<string, { paqueteria_idpaqueteria: number | null; bultos_ids: number[] }>();
 
      for (const b of bultos) {
        const key = b.paqueteria_idpaqueteria != null
          ? `paq_${b.paqueteria_idpaqueteria}`
          : "local";
 
        if (!grupos.has(key)) {
          grupos.set(key, {
            paqueteria_idpaqueteria: b.paqueteria_idpaqueteria ?? null,
            bultos_ids: [],
          });
        }
        grupos.get(key)!.bultos_ids.push(b.idbulto);
      }
 
      // Calcular totales para es_parcialidad
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
 
      const bultosYaEnviados = Number(yaEnviadosRows[0].enviados);
      const totalEnEsteEnvio = bultos.length;
      const totalDespues     = bultosYaEnviados + totalEnEsteEnvio;
 
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
        totalDespues < totalBultosPedido;
 
      // Crear un envío por cada grupo de paquetería
      for (const [, grupo] of grupos) {
        const esLocal = grupo.paqueteria_idpaqueteria === null;
        const tipo    = esLocal ? "local" : "paqueteria";
 
        if (esLocal && (!usuarios_idusuario || !unidades_idunidad)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Para envío local se requiere chofer y unidad" });
        }
 
        // ── CAMBIO: obtener nombre de paquetería si aplica ──
        let paqueteria_nombre: string | null = null;
        if (!esLocal && grupo.paqueteria_idpaqueteria) {
          const { rows: paqRows } = await client.query(
            `SELECT nombre FROM paqueteria WHERE idpaqueteria = $1`,
            [grupo.paqueteria_idpaqueteria]
          );
          paqueteria_nombre = paqRows[0]?.nombre ?? null;
        }
 
        const { rows: envioRows } = await client.query(
          `INSERT INTO envio (
            solicitud_idsolicitud, tipo,
            usuarios_idusuario, unidades_idunidad,
            paqueteria_idpaqueteria,
            costo_flete, fecha_entrega_estimada, observaciones,
            estado, fecha_envio, es_parcialidad
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'preparando',NOW(),$9)
          RETURNING idenvio`,
          [
            idsolicitud,
            tipo,
            esLocal ? usuarios_idusuario             : null,
            esLocal ? unidades_idunidad              : null,
            esLocal ? null : grupo.paqueteria_idpaqueteria,
            costo_flete            || null,
            fecha_entrega_estimada || null,
            observaciones          || null,
            es_parcialidad,
          ]
        );
 
        const idenvio = envioRows[0].idenvio;
 
        // ── CAMBIO: push con objeto enriquecido ──
        enviosCreados.push({
          idenvio,
          tipo,
          paqueteria_idpaqueteria: grupo.paqueteria_idpaqueteria,
          paqueteria_nombre,
        });
 
        for (const idbulto of grupo.bultos_ids) {
          await client.query(
            `INSERT INTO envio_bulto (envio_idenvio, bultos_idbulto)
             VALUES ($1,$2)
             ON CONFLICT (bultos_idbulto) DO NOTHING`,
            [idenvio, idbulto]
          );
        }
 
        if (esLocal) {
          await client.query(
            `INSERT INTO bitacora_reparto (
              envio_idenvio, usuarios_idusuario, unidades_idunidad, fecha
            ) VALUES ($1,$2,$3,CURRENT_DATE)`,
            [idenvio, usuarios_idusuario, unidades_idunidad]
          );
        }
      }
 
      // Limpiar carrito del pedido
      const todosLosIdbultos = bultos.map((b: any) => b.idbulto);
      await client.query(
        `DELETE FROM carrito_envio WHERE bultos_idbulto = ANY($1::int[])`,
        [todosLosIdbultos]
      );
    }
 
    await client.query("COMMIT");
 
    res.json({
      message:        "Carrito procesado exitosamente",
      envios_creados: enviosCreados, // ← ahora es array de objetos
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ PROCESAR CARRITO ERROR:", error.message);
    res.status(500).json({ error: "Error al procesar carrito" });
  } finally {
    client.release();
  }
};
 