import { Request, Response } from "express";
import { pool } from "../../config/db";

interface TarifaProduccion {
  idtarifas_produccion:    number;
  tintas_idtintas:         number;
  kilogramos_idkilogramos: number;
  caras_idcaras:           number;
  precio:                  number;
  merma_porcentaje:        number;
  kg:                      number;
  kg_min:                  number | null;
  kg_max:                  number | null;
}

const buscarTarifa = (
  tarifas:     TarifaProduccion[],
  tintasId:    number,
  carasId:     number,
  pesoTotalKg: number
): TarifaProduccion | null => {
  const pesoRedondeado = Math.round(pesoTotalKg * 100) / 100;

  console.log(`\n🔎 buscarTarifa → tintasId=${tintasId} | carasId=${carasId} | peso=${pesoRedondeado}`);

  const resultado = tarifas.find(
    t =>
      t.tintas_idtintas === tintasId &&
      t.caras_idcaras   === carasId  &&
      pesoRedondeado >= (t.kg_min ?? 0) &&
      (t.kg_max === null || pesoRedondeado <= t.kg_max)
  ) ?? null;

  if (!resultado) {
    const porTintas = tarifas.filter(t => t.tintas_idtintas === tintasId);
    const porCaras  = tarifas.filter(t => t.caras_idcaras   === carasId);
    console.log(`  ❌ Sin match. Por tintas=${tintasId}: ${porTintas.length} tarifa(s) | Por caras=${carasId}: ${porCaras.length} tarifa(s)`);
    if (porTintas.length > 0) {
      console.log(`  📋 Tarifas disponibles para tintas=${tintasId}:`, porTintas.map(t => ({
        caras_idcaras: t.caras_idcaras,
        kg_min: t.kg_min,
        kg_max: t.kg_max,
        precio: t.precio,
      })));
    }
  } else {
    console.log(`  ✅ Tarifa encontrada → precio=${resultado.precio} | kg_min=${resultado.kg_min} | kg_max=${resultado.kg_max}`);
  }

  return resultado;
};

const calcularPrecioReal = (
  cantidadReal: number,
  porKilo:      number,
  tintasId:     number,
  carasId:      number,
  tarifas:      TarifaProduccion[]
): { precio_unitario: number; costo_total: number; peso_kg: number } | null => {
  console.log(`\n💡 calcularPrecioReal → cantReal=${cantidadReal} | porKilo=${porKilo} | tintasId=${tintasId} | carasId=${carasId}`);

  if (cantidadReal <= 0 || porKilo <= 0 || !tarifas.length) {
    console.log(`  ⚠️ Guard falló → cantidadReal=${cantidadReal} porKilo=${porKilo} tarifas.length=${tarifas.length}`);
    return null;
  }

  const peso_kg = cantidadReal / porKilo;
  console.log(`  ⚖️ peso_kg = ${cantidadReal} / ${porKilo} = ${peso_kg}`);

  const tarifa = buscarTarifa(tarifas, tintasId, carasId, peso_kg);
  if (!tarifa) return null;

  const precio = Number(tarifa.precio);
  return {
    precio_unitario: precio,
    costo_total:     peso_kg * precio,
    peso_kg,
  };
};

// ============================================================
// GET /estado-cuenta/:noPedido
// ============================================================
export const getEstadoCuenta = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { noPedido } = req.params;
    const IVA = 0.16;

    // Estados
    const ESTADO_PENDIENTE       = 1;
    const ESTADO_ANTICIPO_PAGADO = 2;
    const ESTADO_PAGADO          = 6;

    await client.query("BEGIN");

    // ── 1. Datos base — subtotal/iva/total NUNCA se tocan ─────
    const { rows: pedidoRows } = await client.query(`
      SELECT
        s.idsolicitud, s.no_pedido, s.no_cotizacion, s.fecha,
        cli.razon_social AS cliente, cli.empresa, cli.telefono, cli.correo,
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
        v.diferencia_total
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
    console.log(`   idsolicitud=${pedido.idsolicitud} | idventas=${pedido.idventas}`);
    console.log(`   total_original=${pedido.total_original} | abono=${pedido.abono}`);

    // ── 2. Productos con su configuración ─────────────────────
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
        ) AS tiene_asa_flexible
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
      WHERE sp.solicitud_idsolicitud = $1
    `, [pedido.idsolicitud]);

    console.log(`\n📦 Productos encontrados: ${prodRows.length}`);
    prodRows.forEach((p: any, i: number) => {
      console.log(`   [${i}] idsolicitud_producto=${p.idsolicitud_producto} | tintas_idtintas=${p.tintas_idtintas} | caras_idcaras=${p.caras_idcaras} | por_kilo=${p.por_kilo} | cantidad_original=${p.cantidad_original} | precio_total_original=${p.precio_total_original}`);
    });

    if (prodRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "No se encontraron productos para este pedido" });
    }

    // ── 3. Cantidad real de cada producto ─────────────────────
    const productosConReal = await Promise.all(prodRows.map(async (prod: any) => {
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
        const { rows: asaRows } = await client.query(`
          SELECT pzas_finales FROM asa_flexible
          WHERE orden_produccion_idproduccion = $1
          LIMIT 1
        `, [idproduccion]);

        const cantidad_real = asaRows[0]?.pzas_finales ?? null;
        return {
          ...prod, cantidad_real, no_produccion,
          motivo_null: cantidad_real === null ? "asa_incompleta" : null,
        };
      } else {
        const { rows: bolseoRows } = await client.query(`
          SELECT piezas_bolseadas FROM bolseo
          WHERE orden_produccion_idproduccion = $1
          LIMIT 1
        `, [idproduccion]);

        const cantidad_real = bolseoRows[0]?.piezas_bolseadas ?? null;
        return {
          ...prod, cantidad_real, no_produccion,
          motivo_null: cantidad_real === null ? "bolseo_incompleto" : null,
        };
      }
    }));

    console.log(`\n🏭 Cantidad real por producto:`);
    productosConReal.forEach((p: any, i: number) => {
      console.log(`   [${i}] idsolicitud_producto=${p.idsolicitud_producto} | cantidad_real=${p.cantidad_real} | no_produccion=${p.no_produccion} | motivo_null=${p.motivo_null}`);
    });

    // ── 4. Verificar que todos tengan cantidad real ────────────
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

    // ── 5. Cargar tarifas — parsear numerics explícitamente ───
    const { rows: tarifasRaw } = await client.query(`
      SELECT
        tp.idtarifas_produccion, tp.tintas_idtintas,
        tp.kilogramos_idkilogramos, tp.caras_idcaras,
        tp.precio, tp.merma_porcentaje,
        k.kg, k.kg_min, k.kg_max
      FROM tarifas_produccion tp
      JOIN kilogramos k ON k.idkilogramos = tp.kilogramos_idkilogramos
      ORDER BY k.kg_min ASC
    `);

    const tarifas: TarifaProduccion[] = tarifasRaw.map((t: any) => ({
      idtarifas_produccion:    Number(t.idtarifas_produccion),
      tintas_idtintas:         Number(t.tintas_idtintas),
      kilogramos_idkilogramos: Number(t.kilogramos_idkilogramos),
      caras_idcaras:           Number(t.caras_idcaras),
      precio:                  Number(t.precio),
      merma_porcentaje:        Number(t.merma_porcentaje),
      kg:                      Number(t.kg),
      kg_min:                  t.kg_min != null ? Number(t.kg_min) : null,
      kg_max:                  t.kg_max != null ? Number(t.kg_max) : null,
    }));

    console.log(`\n📊 Tarifas cargadas: ${tarifas.length}`);
    console.log(`   Muestra (primeras 5):`, tarifas.slice(0, 5).map(t => ({
      tintas_idtintas: t.tintas_idtintas,
      caras_idcaras:   t.caras_idcaras,
      kg_min:          t.kg_min,
      kg_max:          t.kg_max,
      precio:          t.precio,
    })));

    // ── 6. Recalcular precio por producto ──────────────────────
    let nuevoSubtotal = 0;

    const productos = productosConReal.map((prod: any) => {
      const porKilo    = Number(prod.por_kilo)        || 0;
      const tintasId   = Number(prod.tintas_idtintas);
      const carasId    = Number(prod.caras_idcaras);
      const cantReal   = Number(prod.cantidad_real);
      const cantOrig   = Number(prod.cantidad_original);
      const precioOrig = Number(prod.precio_total_original);

      console.log(`\n📦 Producto [${prod.idsolicitud_producto}]`);
      console.log(`   porKilo=${porKilo} | tintasId=${tintasId} | carasId=${carasId}`);
      console.log(`   cantReal=${cantReal} | cantOrig=${cantOrig} | precioOrig=${precioOrig}`);

      const calculo = calcularPrecioReal(cantReal, porKilo, tintasId, carasId, tarifas);

      const precio_total_real    = calculo ? Number(calculo.costo_total.toFixed(2))     : precioOrig;
      const precio_unitario_real = calculo ? Number(calculo.precio_unitario.toFixed(6)) : 0;
      const peso_kg_real         = calculo ? Number(calculo.peso_kg.toFixed(4))         : 0;

      console.log(`   calculo=${calculo ? "OK" : "NULL (usando precioOrig)"} | precio_total_real=${precio_total_real}`);

      nuevoSubtotal += precio_total_real;

      console.log(`📦 [${prod.idsolicitud_producto}] cantReal=${cantReal} | porKilo=${porKilo} | precio_total_real=${precio_total_real}`);

      return {
        idsolicitud_producto:  prod.idsolicitud_producto,
        no_produccion:         prod.no_produccion,
        nombre:                [prod.tipo_producto, prod.medida, prod.material].filter(Boolean).join(" "),
        // ── campos agregados para PDF simple ─────────────────
        medida:                prod.medida    ?? null,
        material:              prod.material  ?? null,
        impresion:             pedido.impresion ?? null,
        // ─────────────────────────────────────────────────────
        tintas:                prod.tintas_num,
        caras:                 prod.caras_num,
        modo_cantidad:         prod.modo_cantidad,
        cantidad_original:     cantOrig,
        precio_total_original: precioOrig,
        cantidad_real:         cantReal,
        peso_kg_real,
        precio_unitario_real,
        precio_total_real,
        diferencia_piezas:     cantReal - cantOrig,
        diferencia_precio:     Number((precio_total_real - precioOrig).toFixed(2)),
      };
    });

    // ── 7. Calcular totales reales ─────────────────────────────
    nuevoSubtotal    = Number(nuevoSubtotal.toFixed(2));
    const nuevoIva   = Number((nuevoSubtotal * IVA).toFixed(2));
    const nuevoTotal = Number((nuevoSubtotal + nuevoIva).toFixed(2));

    const abonoActual     = Number(pedido.abono);
    const nuevoSaldo      = Number(Math.max(nuevoTotal - abonoActual, 0).toFixed(2));
    const totalOriginal   = Number(pedido.total_original);
    const diferenciaTotal = Number((nuevoTotal - totalOriginal).toFixed(2));

    console.log(`\n💰 TOTALES FINALES pedido #${noPedido}`);
    console.log(`   nuevoSubtotal=${nuevoSubtotal} | nuevoIva=${nuevoIva} | nuevoTotal=${nuevoTotal}`);
    console.log(`   totalOriginal=${totalOriginal} | diferenciaTotal=${diferenciaTotal} | nuevoSaldo=${nuevoSaldo}`);

    // ── 8. Determinar nuevo estado ────────────────────────────
    let nuevoEstado: number;
    if (nuevoSaldo <= 0)                             nuevoEstado = ESTADO_PAGADO;
    else if (abonoActual >= Number(pedido.anticipo)) nuevoEstado = ESTADO_ANTICIPO_PAGADO;
    else                                             nuevoEstado = ESTADO_PENDIENTE;

    console.log(`\n🏷️  Nuevo estado → ${nuevoEstado} (saldo=${nuevoSaldo} | abono=${abonoActual} | anticipo=${pedido.anticipo})`);

    // ── 9. Guardar en BD — NUNCA toca subtotal/iva/total originales ──
    const updateResult = await client.query(`
      UPDATE ventas
      SET subtotal_real    = $1,
          iva_real         = $2,
          total_real       = $3,
          saldo            = $4,
          diferencia_total = $5,
          estado_administrativo_cat_idestado_administrativo_cat = $6
      WHERE idventas = $7
    `, [nuevoSubtotal, nuevoIva, nuevoTotal, nuevoSaldo, diferenciaTotal, nuevoEstado, pedido.idventas]);

    console.log(`\n💾 UPDATE ventas → rows afectadas: ${updateResult.rowCount} | idventas=${pedido.idventas}`);
    console.log(`   subtotal_real=${nuevoSubtotal} | iva_real=${nuevoIva} | total_real=${nuevoTotal} | diferencia_total=${diferenciaTotal} | estado=${nuevoEstado}`);

    await client.query("COMMIT");
    console.log(`✅ COMMIT exitoso — pedido #${noPedido}`);

    return res.json({
      no_pedido:     pedido.no_pedido,
      no_cotizacion: pedido.no_cotizacion,
      fecha:         pedido.fecha,
      cliente:       pedido.cliente,
      empresa:       pedido.empresa,
      telefono:      pedido.telefono,
      correo:        pedido.correo,

      productos,

      // ✅ Original — de ventas.subtotal/iva/total, NUNCA modificado
      subtotal_original: Number(pedido.subtotal_original),
      iva_original:      Number(pedido.iva_original),
      total_original:    totalOriginal,

      // ✅ Real — guardado en ventas.subtotal_real/iva_real/total_real
      subtotal_real: nuevoSubtotal,
      iva_real:      nuevoIva,
      total_real:    nuevoTotal,

      // Pagos
      anticipo: Number(pedido.anticipo),
      abono:    abonoActual,
      saldo:    nuevoSaldo,

      // ✅ Guardado en BD — total_real - total_original
      diferencia_total: diferenciaTotal,

      // ✅ Estado actualizado
      estado_id: nuevoEstado,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ ESTADO CUENTA ERROR:", error.message);
    console.error("❌ STACK:", error.stack);
    return res.status(500).json({ error: "Error al obtener estado de cuenta" });
  } finally {
    client.release();
  }
};

// ============================================================
// GET /estado-cuenta — lista pedidos con producción completa
// ============================================================
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
          WHEN af.pzas_finales IS NOT NULL THEN op.idproduccion
          WHEN b.piezas_bolseadas IS NOT NULL AND af_proc.idproduccion IS NULL THEN op.idproduccion
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
}; //hola