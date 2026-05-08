import { Request, Response } from "express";
import { pool } from "../../config/db";

export const getEstadoCuenta = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { noPedido } = req.params;
    const IVA = 0.16;

    const ESTADO_PENDIENTE       = 1;
    const ESTADO_ANTICIPO_PAGADO = 2;
    const ESTADO_PAGADO          = 6;

    await client.query("BEGIN");

    const { rows: pedidoRows } = await client.query(`
      SELECT
        s.idsolicitud, s.no_pedido, s.no_cotizacion, s.fecha,
        COALESCE(cli.razon_social, cli.empresa) AS cliente,
        cli.atencion,
        cli.empresa, cli.telefono, cli.correo,
        cli.impresion,
        v.idventas,
        v.subtotal  AS subtotal_original,
        v.iva       AS iva_original,
        v.total     AS total_original,
        v.anticipo,
        v.abono,
        v.saldo,
        v.subtotal_real,
        v.iva_real,
        v.total_real,
        v.diferencia_total,
        EXISTS (
          SELECT 1 FROM venta_pago vp
          WHERE vp.ventas_idventas = v.idventas
            AND vp.es_credito_anticipo = true
        ) AS es_credito_anticipo,
        (
          SELECT vp.monto
          FROM venta_pago vp
          WHERE vp.ventas_idventas = v.idventas
            AND vp.es_anticipo = true
            AND vp.es_credito_anticipo = false
          ORDER BY vp.fecha ASC
          LIMIT 1
        ) AS primer_pago_anticipo
      FROM solicitud s
      JOIN clientes cli ON cli.idclientes = s.clientes_idclientes
      JOIN ventas v     ON v.solicitud_idsolicitud = s.idsolicitud
      WHERE s.no_pedido = $1
    `, [noPedido]);

    if (pedidoRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Pedido no encontrado" });
    }

    const pedido = pedidoRows[0];
    console.log(`\n🧾 ===== ESTADO CUENTA — PEDIDO #${noPedido} =====`);

    const { rows: prodRows } = await client.query(`
      SELECT
        sp.idsolicitud_producto,
        sp.tintas_idtintas,
        sp.caras_idcaras,
        cfg.por_kilo,
        cfg.medida,
        tpp.material_plastico_producto AS tipo_producto,
        mp.tipo_material               AS material,
        sd.cantidad                    AS cantidad_original,
        sd.kilogramos                  AS kilogramos_original,
        sd.precio_total                AS precio_total_original,
        sd.modo_cantidad,
        t.cantidad   AS tintas_num,
        car.cantidad AS caras_num,
        EXISTS (
          SELECT 1
          FROM tipo_producto_plastico_proceso tppp
          WHERE tppp.idtipo_producto_plastico =
            cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
            AND tppp.idproceso_cat = 3
        ) AS tiene_asa_flexible,
        h.id_herramental,
        h.herramental_descripcion,
        h.herramental_precio,
        h.aprobado AS herramental_aprobado
      FROM solicitud_producto sp
      JOIN configuracion_plastico cfg
          ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      JOIN tipo_producto_plastico tpp
          ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      JOIN material_plastico mp
          ON mp.idmaterial_plastico = cfg.material_plastico_plastico_idmaterial_plastico
      LEFT JOIN solicitud_detalle sd
          ON sd.solicitud_producto_id = sp.idsolicitud_producto
          AND sd.aprobado = true
      LEFT JOIN tintas t   ON t.idtintas  = sp.tintas_idtintas
      LEFT JOIN caras car  ON car.idcaras = sp.caras_idcaras
      LEFT JOIN herramental h ON h.idsolicitud_producto = sp.idsolicitud_producto
      WHERE sp.solicitud_idsolicitud = $1
    `, [pedido.idsolicitud]);

    if (prodRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "No se encontraron productos para este pedido" });
    }

    const productosConReal = await Promise.all(prodRows.map(async (prod: any) => {
      const modoKilo = prod.modo_cantidad === "kilo";

      const { rows: opRows } = await client.query(`
        SELECT op.idproduccion, op.no_produccion
        FROM orden_produccion op
        WHERE op.idsolicitud_producto = $1
        LIMIT 1
      `, [prod.idsolicitud_producto]);

      if (opRows.length === 0) {
        return { ...prod, cantidad_real: null, no_produccion: null, motivo_null: "sin_orden" };
      }

      const { idproduccion, no_produccion } = opRows[0];

      if (prod.tiene_asa_flexible) {
        const campoCantidad = modoKilo ? "kilos_finales" : "pzas_finales";
        const { rows: asaRows } = await client.query(`
          SELECT ${campoCantidad} AS cantidad_real
          FROM asa_flexible
          WHERE orden_produccion_idproduccion = $1
          LIMIT 1
        `, [idproduccion]);

        const cantidad_real = asaRows[0]?.cantidad_real ?? null;
        return {
          ...prod, cantidad_real, no_produccion,
          motivo_null: cantidad_real === null ? "asa_incompleta" : null,
        };
      } else {
        const campoCantidad = modoKilo ? "kilos_bolseados" : "piezas_bolseadas";
        const { rows: bolseoRows } = await client.query(`
          SELECT ${campoCantidad} AS cantidad_real
          FROM bolseo
          WHERE orden_produccion_idproduccion = $1
          LIMIT 1
        `, [idproduccion]);

        const cantidad_real = bolseoRows[0]?.cantidad_real ?? null;
        return {
          ...prod, cantidad_real, no_produccion,
          motivo_null: cantidad_real === null ? "bolseo_incompleto" : null,
        };
      }
    }));

    const incompletos = productosConReal.filter(p => p.cantidad_real === null);
    if (incompletos.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Producción incompleta",
        detalle: `${incompletos.length} producto(s) aún no tienen cantidad final de producción.`,
        productos_incompletos: incompletos.map(p => ({
          idsolicitud_producto: p.idsolicitud_producto,
          no_produccion:        p.no_produccion,
          motivo:               p.motivo_null,
        })),
      });
    }

    let nuevoSubtotal    = 0;
    let herramentalTotal = 0;

    const productos = productosConReal.map((prod: any) => {
      const porKilo    = Number(prod.por_kilo) || 0;
      const cantReal   = Number(prod.cantidad_real);
      const precioOrig = Number(prod.precio_total_original);
      const modoKilo   = prod.modo_cantidad === "kilo";

      const baseOriginal = modoKilo
        ? Number(prod.kilogramos_original)
        : Number(prod.cantidad_original);

      const precio_unitario_original = baseOriginal > 0
        ? precioOrig / baseOriginal
        : 0;

      const precio_total_real = Number((precio_unitario_original * cantReal).toFixed(2));

      const peso_kg_real = modoKilo
        ? cantReal
        : (porKilo > 0 ? Number((cantReal / porKilo).toFixed(4)) : 0);

      nuevoSubtotal += precio_total_real;

      const herrPrecio = prod.herramental_aprobado === true && prod.herramental_precio != null
        ? Number(prod.herramental_precio)
        : null;
      if (herrPrecio != null) {
        nuevoSubtotal    += herrPrecio;
        herramentalTotal += herrPrecio;
      }

      console.log(
        `📦 [${prod.idsolicitud_producto}] modo=${prod.modo_cantidad} | ` +
        `baseOrig=${baseOriginal} | precioOrig=${precioOrig} | ` +
        `precioUnit=${precio_unitario_original.toFixed(4)} | ` +
        `cantReal=${cantReal} | precio_total_real=${precio_total_real} | ` +
        `herramental=${herrPrecio ?? 0}`
      );

      return {
        idsolicitud_producto:    prod.idsolicitud_producto,
        no_produccion:           prod.no_produccion,
        nombre:                  [prod.tipo_producto, prod.medida, prod.material].filter(Boolean).join(" "),
        medida:                  prod.medida   ?? null,
        material:                prod.material ?? null,
        impresion:               pedido.impresion ?? null,
        tintas:                  prod.tintas_num,
        caras:                   prod.caras_num,
        modo_cantidad:           prod.modo_cantidad,
        cantidad_original:       modoKilo ? Number(prod.kilogramos_original) : Number(prod.cantidad_original),
        precio_total_original:   precioOrig,
        cantidad_real:           cantReal,
        peso_kg_real,
        precio_unitario_real:    Number(precio_unitario_original.toFixed(6)),
        precio_total_real,
        diferencia_piezas:       cantReal - (modoKilo ? Number(prod.kilogramos_original) : Number(prod.cantidad_original)),
        diferencia_precio:       Number((precio_total_real - precioOrig).toFixed(2)),
        herramental_descripcion: prod.herramental_descripcion ?? null,
        herramental_precio:      prod.herramental_precio != null ? Number(prod.herramental_precio) : null,
        herramental_aprobado:    prod.herramental_aprobado ?? null,
      };
    });

    nuevoSubtotal    = Number(nuevoSubtotal.toFixed(2));
    const nuevoIva   = Number((nuevoSubtotal * IVA).toFixed(2));
    const nuevoTotal = Number((nuevoSubtotal + nuevoIva).toFixed(2));

    const abonoActual     = Number(pedido.abono);
    const nuevoSaldo      = Number(Math.max(nuevoTotal - abonoActual, 0).toFixed(2));
    const totalOriginal   = Number(pedido.total_original);
    const diferenciaTotal = Number((nuevoTotal - totalOriginal).toFixed(2));

    console.log(`\n💰 TOTALES pedido #${noPedido}: subtotal=${nuevoSubtotal} | herramental=${herramentalTotal} | iva=${nuevoIva} | total=${nuevoTotal} | saldo=${nuevoSaldo}`);

    let nuevoEstado: number;
    if (nuevoSaldo <= 0)                             nuevoEstado = ESTADO_PAGADO;
    else if (abonoActual >= Number(pedido.anticipo)) nuevoEstado = ESTADO_ANTICIPO_PAGADO;
    else                                             nuevoEstado = ESTADO_PENDIENTE;

    await client.query(`
      UPDATE ventas
      SET subtotal_real    = $1,
          iva_real         = $2,
          total_real       = $3,
          saldo            = $4,
          diferencia_total = $5,
          estado_administrativo_cat_idestado_administrativo_cat = $6
      WHERE idventas = $7
    `, [nuevoSubtotal, nuevoIva, nuevoTotal, nuevoSaldo, diferenciaTotal, nuevoEstado, pedido.idventas]);

    await client.query("COMMIT");

    return res.json({
      no_pedido:     pedido.no_pedido,
      no_cotizacion: pedido.no_cotizacion,
      fecha:         pedido.fecha,
      cliente:       pedido.cliente,
      atencion:      pedido.atencion ?? null,
      empresa:       pedido.empresa,
      telefono:      pedido.telefono,
      correo:        pedido.correo,

      productos,

      subtotal_original: Number(pedido.subtotal_original),
      iva_original:      Number(pedido.iva_original),
      total_original:    totalOriginal,

      subtotal_real:     nuevoSubtotal,
      iva_real:          nuevoIva,
      total_real:        nuevoTotal,
      herramental_total: Number(herramentalTotal.toFixed(2)),

      anticipo:             Number(pedido.anticipo),
      primer_pago_anticipo: pedido.primer_pago_anticipo != null
        ? Number(pedido.primer_pago_anticipo)
        : null,
      abono:               abonoActual,
      saldo:               nuevoSaldo,
      es_credito_anticipo: pedido.es_credito_anticipo ?? false,

      diferencia_total: diferenciaTotal,
      estado_id:        nuevoEstado,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ ESTADO CUENTA ERROR:", error.message, error.stack);
    return res.status(500).json({ error: "Error al obtener estado de cuenta" });
  } finally {
    client.release();
  }
};

export const getListaEstadoCuenta = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        s.no_pedido, s.no_cotizacion, s.fecha,
        cli.razon_social AS cliente, cli.empresa,
        v.total, v.abono, v.saldo, v.anticipo,
        v.total_real, v.diferencia_total,
        COUNT(DISTINCT op.idproduccion) AS total_ordenes,
        COUNT(DISTINCT CASE
          WHEN af.pzas_finales IS NOT NULL OR af.kilos_finales IS NOT NULL THEN op.idproduccion
          WHEN (b.piezas_bolseadas IS NOT NULL OR b.kilos_bolseados IS NOT NULL)
               AND af_proc.idproduccion IS NULL THEN op.idproduccion
        END) AS ordenes_completas
      FROM solicitud s
      JOIN clientes cli ON cli.idclientes = s.clientes_idclientes
      JOIN ventas v     ON v.solicitud_idsolicitud = s.idsolicitud
      JOIN solicitud_producto sp ON sp.solicitud_idsolicitud = s.idsolicitud
      JOIN orden_produccion op   ON op.idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN asa_flexible af  ON af.orden_produccion_idproduccion = op.idproduccion
      LEFT JOIN bolseo b         ON b.orden_produccion_idproduccion = op.idproduccion
      LEFT JOIN (
        SELECT DISTINCT op2.idproduccion
        FROM orden_produccion op2
        JOIN asa_flexible af2 ON af2.orden_produccion_idproduccion = op2.idproduccion
      ) af_proc ON af_proc.idproduccion = op.idproduccion
      WHERE s.estado = 'pedido'
        AND s.no_pedido IS NOT NULL
      GROUP BY s.no_pedido, s.no_cotizacion, s.fecha,
               cli.razon_social, cli.empresa,
               v.total, v.abono, v.saldo, v.anticipo,
               v.total_real, v.diferencia_total
      HAVING COUNT(DISTINCT op.idproduccion) > 0
      ORDER BY s.no_pedido DESC
    `);

    return res.json(rows.map(r => ({
      ...r,
      produccion_completa: Number(r.total_ordenes) === Number(r.ordenes_completas),
    })));

  } catch (error: any) {
    console.error("❌ LISTA ESTADO CUENTA ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener lista de estado de cuenta" });
  }
};