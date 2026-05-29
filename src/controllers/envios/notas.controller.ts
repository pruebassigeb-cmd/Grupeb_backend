import { Request, Response } from "express";
import { pool } from "../../config/db";

// ==========================
// GENERAR O RECUPERAR NOTA
// ==========================
export const getOrCreateNota = async (req: Request, res: Response) => {
  try {
    const { idenvio } = req.params;

    // Verificar si ya existe nota para este envío
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
      // Generar número correlativo N + año + 001
      const anio = new Date().getFullYear();
      const prefijo = `N${anio}`;

      const ultimo = await pool.query(
        `SELECT no_nota FROM nota_remision
         WHERE no_nota LIKE $1
         ORDER BY idnota DESC LIMIT 1`,
        [`${prefijo}%`]
      );

      let consecutivo = 1;
      if (ultimo.rows.length > 0) {
        const noActual = ultimo.rows[0].no_nota as string;
        const numStr = noActual.replace(prefijo, "");
        consecutivo = parseInt(numStr, 10) + 1;
      }

      no_nota = `${prefijo}${String(consecutivo).padStart(3, "0")}`;

      const nueva = await pool.query(
        `INSERT INTO nota_remision (no_nota, envio_idenvio)
         VALUES ($1, $2)
         RETURNING idnota, no_nota, created_at`,
        [no_nota, idenvio]
      );
      idnota     = nueva.rows[0].idnota;
      created_at = nueva.rows[0].created_at;
    }

    // Obtener datos completos del envío
const { rows } = await pool.query(`
  SELECT
    e.idenvio,
    e.tipo,
    e.fecha_envio,
    e.observaciones,
    s.no_pedido,
    cli.empresa,
    cli.impresion,
    cli.razon_social,
    df.rfc,
    COALESCE(de.domicilio, d.domicilio)         AS calle_envio,
    COALESCE(de.numero,    d.numero)             AS numero_envio,
    COALESCE(de.colonia,   d.colonia)            AS colonia_envio,
    COALESCE(de.codigo_postal, d.codigo_postal)  AS cp_envio,
    COALESCE(de.poblacion, d.poblacion)          AS poblacion_envio,
    COALESCE(de.estado,    d.estado)             AS estado_envio
  FROM envio e
  JOIN solicitud s              ON s.idsolicitud              = e.solicitud_idsolicitud
  JOIN clientes cli             ON cli.idclientes             = s.clientes_idclientes
  LEFT JOIN domicilio d         ON d.clientes_idclientes      = cli.idclientes
  LEFT JOIN datos_facturacion df ON df.clientes_idclientes    = cli.idclientes
  LEFT JOIN direccion_envio de  ON de.clientes_idclientes     = cli.idclientes
  WHERE e.idenvio = $1
  LIMIT 1
`, [idenvio]);

    if (rows.length === 0)
      return res.status(404).json({ error: "Envio no encontrado" });

    const envio = rows[0];

    // Obtener productos agrupados del envío
    const { rows: productos } = await pool.query(`
  SELECT
    tpp.material_plastico_producto AS nombre_producto,
    cfg.medida,
    sp.descripcion,
    COUNT(b.idbulto)               AS total_bultos,
    SUM(CASE WHEN b.cantidad_unidades IS NOT NULL THEN b.cantidad_unidades ELSE 0 END) AS total_unidades,
    SUM(CASE WHEN b.peso_producto    IS NOT NULL THEN b.peso_producto    ELSE 0 END)   AS total_kg,
    MIN(b.cantidad_unidades) AS modo_unidad,
    MIN(b.peso_producto)     AS modo_kg
  FROM envio_bulto eb
  JOIN bultos b ON b.idbulto = eb.bultos_idbulto

  -- Obtener la orden de producción desde bolseo o asa_flexible
  LEFT JOIN bolseo bol
    ON bol.idbolseo = b.bolseo_idbolseo
  LEFT JOIN asa_flexible af
    ON af.idasa_flexible = b.asa_flexible_idasa_flexible

  -- Orden de producción (de cualquiera de los dos procesos)
  LEFT JOIN orden_produccion op
    ON op.idproduccion = COALESCE(bol.orden_produccion_idproduccion, af.orden_produccion_idproduccion)

  -- Producto
  LEFT JOIN solicitud_producto sp
    ON sp.idsolicitud_producto = op.idsolicitud_producto
  LEFT JOIN configuracion_plastico cfg
    ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
  LEFT JOIN tipo_producto_plastico tpp
    ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico

  WHERE eb.envio_idenvio = $1
  GROUP BY tpp.material_plastico_producto, cfg.medida, sp.descripcion
  ORDER BY tpp.material_plastico_producto
`, [idenvio]);

    res.json({
      idnota,
      no_nota,
      created_at,
      envio: {
        idenvio:     Number(envio.idenvio),
        tipo:        envio.tipo,
        fecha_envio: envio.fecha_envio,
        no_pedido:   envio.no_pedido,
        observaciones: envio.observaciones,
      },
      cliente: {
        nombre:      envio.impresion || envio.empresa || envio.razon_social || "",
        rfc:         envio.rfc       || "",
        direccion:   [envio.calle_envio, envio.numero_envio, envio.colonia_envio, envio.poblacion_envio, envio.estado_envio]
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