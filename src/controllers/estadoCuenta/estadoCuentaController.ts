import { iniciarTx } from "../../middlewares/auditoria";
import { Request, Response } from "express";
import { pool } from "../../config/db";
import {
  calcularTotalesVenta,
  calcularUmbralAnticipo,
  determinarEstadoVenta,
} from "../../services/ventas/totalesVenta.service";

export const getEstadoCuenta = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { noPedido } = req.params;

    await iniciarTx(req, client);

    const { rows: pedidoRows } = await client.query(`
      SELECT
        s.idsolicitud, s.no_pedido, s.no_cotizacion, s.fecha,
        s.sin_iva,
        COALESCE(cli.razon_social, cli.empresa) AS cliente,
        cli.atencion,
        cli.empresa, cli.telefono, cli.correo,
        cli.impresion,
        v.idventas,
        v.moneda,
        v.tipo_cambio,
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
            AND vp.eliminado_at IS NULL
        ) AS es_credito_anticipo,
        (
          SELECT vp.monto
          FROM venta_pago vp
          WHERE vp.ventas_idventas = v.idventas
            AND vp.es_anticipo = true
            AND vp.es_credito_anticipo = false
            AND vp.eliminado_at IS NULL
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

    const pedido  = pedidoRows[0];
    const sinIva  = pedido.sin_iva ?? false;

    console.log(`\n🧾 ===== ESTADO CUENTA — PEDIDO #${noPedido} | sinIva=${sinIva} =====`);
    console.log(`   es_credito_anticipo: ${pedido.es_credito_anticipo}`);
    console.log(`   abono_actual: ${pedido.abono} | total_original: ${pedido.total_original}`);

    // ════════════════════════════════════════════════════════════════════
    // QUERY DE PRODUCTOS — AHORA INCLUYE PAPEL
    // ════════════════════════════════════════════════════════════════════
    // Antes: los JOINs con configuracion_plastico / tipo_producto_plastico /
    // material_plastico eran INNER JOIN, así que cualquier producto de
    // papel desaparecía silenciosamente de este reporte (y de los cálculos
    // de subtotal_real / saldo). Ahora son LEFT JOIN, y se agregan las
    // columnas de papel (también con LEFT JOIN) para poder armar el nombre
    // y los datos del producto sin importar el tipo de material.
    // ════════════════════════════════════════════════════════════════════
    const { rows: prodRows } = await client.query(`
      SELECT
        sp.idsolicitud_producto,
        sp.tipo_material,
        sp.tintas_idtintas,
        sp.caras_idcaras,
        sd.cantidad                    AS cantidad_original,
        sd.kilogramos                  AS kilogramos_original,
        sd.precio_total                AS precio_total_original,
        sd.modo_cantidad,
        t.cantidad   AS tintas_num,
        car.cantidad AS caras_num,

        -- ── Plástico ──
        cfg.por_kilo,
        cfg.medida                     AS medida_plastico,
        tpp.material_plastico_producto AS tipo_producto_plastico,
        mp.tipo_material               AS material_plastico,
        EXISTS (
          SELECT 1
          FROM tipo_producto_plastico_proceso tppp
          WHERE tppp.idtipo_producto_plastico =
            cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
            AND tppp.idproceso_cat = 3
        ) AS tiene_asa_flexible,

        -- ── Papel ──
        sp.grupo_papel_descripcion     AS papel_grupo_descripcion,
        tpp2.nombre                    AS papel_tipo_producto,
        pp2.medida                     AS papel_medida,

        h.id_herramental,
        h.herramental_descripcion,
        h.herramental_precio,
        h.aprobado AS herramental_aprobado
      FROM solicitud_producto sp

      -- ── Plástico (LEFT JOIN: no existe la fila si el producto es de papel) ──
      LEFT JOIN configuracion_plastico cfg
          ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN tipo_producto_plastico tpp
          ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN material_plastico mp
          ON mp.idmaterial_plastico = cfg.material_plastico_plastico_idmaterial_plastico

      -- ── Papel (LEFT JOIN: no existe la fila si el producto es de plástico) ──
      LEFT JOIN producto_papel pp2
          ON pp2.idproducto_papel = sp.producto_papel_idproducto_papel
      LEFT JOIN cat_tipo_producto_papel tpp2
          ON tpp2.idcat_tipo_producto_papel = pp2.idcat_tipo_producto_papel

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

    // ════════════════════════════════════════════════════════════════════
    // RESOLVER "cantidad_real" — bifurca por tipo_material
    // ════════════════════════════════════════════════════════════════════
    // Papel YA tiene proceso de producción propio (Fase 6-7 del sistema de
    // merma): cada orden de papel corre su cascada de procesos y termina en
    // empaque_papel.bolsas_entregadas_final, la salida real de la orden —
    // mismo rol que bolseo/asa_flexible cumplen para plástico.
    //
    // La comparación de cobro es SIEMPRE contra lo que pidió el cliente
    // (cantidad_original), nunca contra cantidad_a_producir (que ya incluye
    // merma) — la merma es el margen de piezas de más que se manda a
    // producir para poder cumplir el pedido, no una base de cobro. Si
    // salieron piezas de más se cobra la diferencia; si salieron de menos,
    // se descuenta; si salieron las correctas, no hay ajuste. Ver R11 en
    // merma-papel-contexto.md.
    // ════════════════════════════════════════════════════════════════════
    const productosConReal = await Promise.all(prodRows.map(async (prod: any) => {
      const esPapel  = prod.tipo_material === "papel";
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

      if (esPapel) {
        // Papel siempre se cuenta por piezas (ver más abajo, en el cálculo
        // de precio, el mismo criterio ya establecido en este archivo).
        const { rows: empaqueRows } = await client.query(`
          SELECT bolsas_entregadas_final AS cantidad_real
          FROM empaque_papel
          WHERE orden_produccion_idproduccion = $1
          LIMIT 1
        `, [idproduccion]);

        const cantidad_real = empaqueRows[0]?.cantidad_real ?? null;
        return {
          ...prod, cantidad_real, no_produccion,
          motivo_null: cantidad_real === null ? "empaque_incompleto" : null,
        };
      }

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

    // ── Producción incompleta bloquea el estado de cuenta, sin importar
    // el material — antes papel quedaba fuera de este filtro a propósito
    // porque no tenía de dónde sacar cantidad_real; ahora sí lo tiene. ──
    const incompletos = productosConReal.filter(p => p.cantidad_real === null);
    const pendientesPapel = incompletos.filter(p => p.tipo_material === "papel");

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
      const esPapel    = prod.tipo_material === "papel";
      const porKilo    = Number(prod.por_kilo) || 0;
      const precioOrig = Number(prod.precio_total_original);
      const modoKilo   = prod.modo_cantidad === "kilo";

      const nombre = esPapel
        ? ([prod.papel_tipo_producto, prod.papel_medida].filter(Boolean).join(" ") ||
           `Papel #${prod.idsolicitud_producto}`)
        : ([prod.tipo_producto_plastico, prod.medida_plastico, prod.material_plastico]
            .filter(Boolean).join(" "));

      const herrPrecio = prod.herramental_aprobado === true && prod.herramental_precio != null
        ? Number(prod.herramental_precio)
        : null;

      // ── PAPEL: mismo cálculo que plástico (R11 en merma-papel-contexto.md).
      // La comparación es SIEMPRE contra lo pedido (cantidad_original), no
      // contra lo que se mandó a producir con merma incluida — la merma es
      // el margen que se produce de más para poder cumplir, no una base de
      // cobro. Si sale de más se cobra, si sale de menos se descuenta, si
      // sale igual no hay ajuste.
      //
      // IMPORTANTE: papel SIEMPRE se cuenta por piezas/unidades, nunca por
      // kilogramos — a diferencia de plástico, aquí no hay bifurcación por
      // modo_cantidad/kilogramos, se ignora deliberadamente y se fuerza a
      // "unidad". Por eso baseOriginal no necesita el ternario que sí
      // necesita plástico más abajo. ──
      if (esPapel) {
        const baseOriginal = Number(prod.cantidad_original);
        const cantReal     = Number(prod.cantidad_real);

        const precio_unitario_original = baseOriginal > 0
          ? precioOrig / baseOriginal
          : 0;

        const precio_total_real = Number((precio_unitario_original * cantReal).toFixed(2));

        nuevoSubtotal += precio_total_real;
        if (herrPrecio != null) {
          nuevoSubtotal    += herrPrecio;
          herramentalTotal += herrPrecio;
        }

        console.log(
          `📦 [papel ${prod.idsolicitud_producto}] baseOrig=${baseOriginal} | ` +
          `precioOrig=${precioOrig} | precioUnit=${precio_unitario_original.toFixed(4)} | ` +
          `cantReal=${cantReal} | precio_total_real=${precio_total_real} | ` +
          `herramental=${herrPrecio ?? 0}`
        );

        return {
          idsolicitud_producto:    prod.idsolicitud_producto,
          tipo_material:           "papel",
          no_produccion:           prod.no_produccion,
          produccion_pendiente:    false, // si seguía pendiente, ya se bloqueó arriba
          nombre,
          medida:                  prod.papel_medida ?? null,
          material:                prod.papel_grupo_descripcion ?? null,
          impresion:               pedido.impresion ?? null,
          tintas:                  prod.tintas_num,
          caras:                   prod.caras_num,
          modo_cantidad:           "unidad", // ← forzado: papel nunca es por kilo
          cantidad_original:       baseOriginal,
          precio_total_original:   precioOrig,
          cantidad_real:           cantReal,
          peso_kg_real:            null, // ← papel no maneja peso, solo piezas
          precio_unitario_real:    Number(precio_unitario_original.toFixed(6)),
          precio_total_real,
          diferencia_piezas:       cantReal - baseOriginal,
          diferencia_precio:       Number((precio_total_real - precioOrig).toFixed(2)),
          herramental_descripcion: prod.herramental_descripcion ?? null,
          herramental_precio:      prod.herramental_precio != null ? Number(prod.herramental_precio) : null,
          herramental_aprobado:    prod.herramental_aprobado ?? null,
        };
      }

      // ── PLÁSTICO: lógica original sin cambios ──
      const cantReal = Number(prod.cantidad_real);
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
        tipo_material:           "plastico",
        no_produccion:           prod.no_produccion,
        produccion_pendiente:    false,
        nombre,
        medida:                  prod.medida_plastico ?? null,
        material:                prod.material_plastico ?? null,
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

    nuevoSubtotal = Number(nuevoSubtotal.toFixed(2));

    // ── FIX: si el pedido es sin IVA, el IVA real también es 0 ───────────────
    const { iva: nuevoIva, total: nuevoTotal } = calcularTotalesVenta({
      subtotal: nuevoSubtotal,
      sinIva,
    });

    const abonoActual     = Number(pedido.abono);
    const nuevoSaldo      = Number(Math.max(nuevoTotal - abonoActual, 0).toFixed(2));
    const totalOriginal   = Number(pedido.total_original);
    const diferenciaTotal = Number((nuevoTotal - totalOriginal).toFixed(2));

    // ─────────────────────────────────────────────────────────────────────────
    // REGLA DE ESTADO
    // ─────────────────────────────────────────────────────────────────────────
    const umbralActivacion  = calcularUmbralAnticipo(totalOriginal);
    const anticipoYaCubierto =
      abonoActual >= umbralActivacion ||
      pedido.es_credito_anticipo === true;

    const nuevoEstado = determinarEstadoVenta(
      abonoActual,
      nuevoSaldo,
      umbralActivacion,
      pedido.es_credito_anticipo === true,
    );

    console.log(
      `   sinIva=${sinIva} | umbral40%=${umbralActivacion} | abono=${abonoActual} | anticipoYaCubierto=${anticipoYaCubierto}` +
      ` | credito=${pedido.es_credito_anticipo} | nuevoSaldo=${nuevoSaldo} | estado=${nuevoEstado}` +
      ` | productos_papel_pendientes=${pendientesPapel.length}`
    );

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
      sin_iva:       sinIva,
      moneda:        pedido.moneda ?? "MXN",
      tipo_cambio:   pedido.tipo_cambio ?? null,

      productos,

      // ── Bandera a nivel pedido, heredada del diseño anterior.
      // ⚠️ Con el sistema de merma (Fase 8), papel ya NO se reporta como
      // "pendiente pero con estimado": si su producción está incompleta,
      // el endpoint entero responde 400 más arriba (mismo criterio que
      // plástico) y nunca llega hasta aquí. Por eso estos dos campos
      // SIEMPRE llegan en false/0 desde ahora — quedan vigentes solo por
      // compatibilidad con el frontend, que puede seguir leyéndolos sin
      // romperse, pero ya no aportan información nueva. Si el frontend
      // tenía una rama de UI para "papel pendiente, mostrando estimado",
      // esa rama ya no se activa nunca y se puede retirar. ──
      tiene_productos_papel_pendientes: pendientesPapel.length > 0,
      productos_papel_pendientes_count: pendientesPapel.length,

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
        s.sin_iva,
        cli.razon_social AS cliente, cli.empresa,
        v.moneda,
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
      GROUP BY s.no_pedido, s.no_cotizacion, s.fecha, s.sin_iva,
               cli.razon_social, cli.empresa, v.moneda,
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