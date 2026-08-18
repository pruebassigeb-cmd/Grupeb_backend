import { Request, Response } from "express";
import { pool } from "../../config/db";
import { AuthRequest } from "../../middlewares/auth.middleware";
import {
  ESTADO_VENTA as ESTADO,
  calcularUmbralAnticipo,
  determinarEstadoVenta as determinarEstado,
} from "../../services/ventas/totalesVenta.service";
import {
  bloquearSolicitudParaVenta,
  ventaTieneCredito,
} from "../../services/ventas/pagos.service";
import { type Moneda, resolverMontoPago } from "../../utils/moneda.utils";
import { ErrorHttp, responderError } from "../../utils/errorHttp";
import { congelarMermaSiEsPapel } from "../../services/producto_papel/merma.service";

/*
 * Resuelve primero la solicitud, toma su advisory transaccional y finalmente
 * relee/bloquea la venta. AsÃ­ ninguna operaciÃ³n usa total/abono obsoletos
 * despuÃ©s de esperar a una ediciÃ³n de pedido o a otro pago.
 */
async function obtenerVentaBloqueada(client: any, ventaId: unknown): Promise<any | null> {
  const { rows: referenciaRows } = await client.query(
    `SELECT solicitud_idsolicitud FROM ventas WHERE idventas = $1`,
    [ventaId],
  );
  if (referenciaRows.length === 0) return null;

  const solicitudId = Number(referenciaRows[0].solicitud_idsolicitud);
  await bloquearSolicitudParaVenta(client, solicitudId);

  const { rows } = await client.query(
    `SELECT
       v.idventas,
       v.total,
       v.anticipo,
       v.saldo,
       v.abono,
       v.solicitud_idsolicitud,
       v.moneda
     FROM ventas v
     WHERE v.idventas = $1
     FOR UPDATE`,
    [ventaId],
  );
  return rows[0] ?? null;
}

async function generarNoProduccion(client: any): Promise<string> {
  const anio = new Date().getFullYear().toString().slice(-2);
  
  let intento = 0;
  while (intento < 10) {
    const { rows } = await client.query(
      `SELECT COUNT(*) AS total FROM orden_produccion WHERE no_produccion::text LIKE $1`,
      [`OP${anio}%`]
    );
    const siguiente = Number(rows[0].total) + 1 + intento;
    const candidato = `OP${anio}${String(siguiente).padStart(3, "0")}`;

    // Verificar que no exista
    const { rows: existe } = await client.query(
      `SELECT 1 FROM orden_produccion WHERE no_produccion = $1`,
      [candidato]
    );

    if (existe.length === 0) return candidato;
    intento++;
  }

  // Fallback: usar MAX + 1
  const { rows: maxRows } = await client.query(
    `SELECT MAX(CAST(SUBSTRING(no_produccion FROM 5) AS INTEGER)) AS max_num
     FROM orden_produccion 
     WHERE no_produccion ~ '^OP${anio}[0-9]+$'`
  );
  const maxNum = Number(maxRows[0].max_num ?? 0);
  return `OP${anio}${String(maxNum + 1).padStart(3, "0")}`;
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
    LEFT JOIN LATERAL (
      SELECT
        SUM(sd0.cantidad) AS cantidad,
        SUM(sd0.kilogramos) AS kilogramos,
        CASE
          WHEN COUNT(*) > 0
           AND BOOL_AND(COALESCE(sd0.modo_cantidad, 'unidad') = 'kilo')
          THEN 'kilo'
          ELSE 'unidad'
        END AS modo_cantidad
      FROM solicitud_detalle sd0
      WHERE sd0.solicitud_producto_id = sp.idsolicitud_producto
        AND sd0.aprobado = true
    ) sd ON true
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
  const rodillos = await buscarRepeticionRodillos(client, ext.repeticion_extrusion);

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

async function generarOrdenesPendientes(
  client: any,
  solicitudId: number,
  usuarioId?: number | null
): Promise<string[]> {
  const { rows: pendientes } = await client.query(`
    SELECT dp.solicitud_producto_idsolicitud_producto AS idsolicitud_producto
    FROM diseno d
    JOIN diseno_producto dp ON dp.diseno_iddiseno = d.iddiseno
    WHERE d.solicitud_idsolicitud = $1
      AND dp.estado_administrativo_cat_idestado_administrativo_cat = $2
      AND NOT EXISTS (
        SELECT 1 FROM orden_produccion op
        WHERE op.idsolicitud_producto = dp.solicitud_producto_idsolicitud_producto
      )
    ORDER BY dp.solicitud_producto_idsolicitud_producto
  `, [solicitudId, ESTADO.APROBADO]);

  const ordenesCreadas: string[] = [];

  for (const prod of pendientes) {
    const productoId = Number(prod.idsolicitud_producto);
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [productoId]);

    // La lista inicial puede quedar obsoleta mientras se espera el advisory
    // que tambiÃ©n usa DiseÃ±o. Se confirma de nuevo dentro del candado.
    const { rows: ordenExistenteRows } = await client.query(
      `SELECT no_produccion
       FROM orden_produccion
       WHERE idsolicitud_producto = $1
       LIMIT 1`,
      [productoId],
    );
    if (ordenExistenteRows.length > 0) continue;

    const noProduccion = await generarNoProduccion(client);
    const datosOrden   = await prepararDatosOrden(client, productoId);

    const { rows: nuevaOrdenRows } = await client.query(
      `INSERT INTO orden_produccion (
        estado_administrativo_cat_idestado_administrativo_cat,
        no_produccion, fecha, fecha_entrega,
        idsolicitud, idsolicitud_producto, idestado_produccion_cat,
        repeticion_extrusion, repeticion_metro, metros, metros_merma, ancho_bobina,
        kilos, kilos_merma, pzas, pzas_merma, repeticion_kidder, repeticion_sicosa
      ) VALUES ($1,$2,NOW(),NOW() + INTERVAL '35 days',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING idproduccion`,
      [
        ESTADO.PENDIENTE, noProduccion, solicitudId, productoId, ESTADO.PENDIENTE,
        datosOrden.repeticion_extrusion, datosOrden.repeticion_metro,
        datosOrden.metros, datosOrden.metros_merma, datosOrden.ancho_bobina,
        datosOrden.kilos, datosOrden.kilos_merma, datosOrden.pzas, datosOrden.pzas_merma,
        datosOrden.repeticion_kidder, datosOrden.repeticion_sicosa,
      ]
    );

    // ── MERMA DE PAPEL ── mismo punto de enganche que diseno.controller.ts
    // y ordenDiseno.controller.ts. congelarMermaSiEsPapel discrimina papel
    // vs plástico internamente, no hace falta chequearlo aquí.
    const idproduccionNueva = nuevaOrdenRows[0]?.idproduccion;
    if (idproduccionNueva) {
      const { aplico } = await congelarMermaSiEsPapel(client, Number(idproduccionNueva), usuarioId);
      if (aplico) {
        console.log(`📐 Merma de papel congelada para la orden ${noProduccion}`);
      }
    }

    ordenesCreadas.push(noProduccion);
    console.log(`✅ Orden ${noProduccion} creada`);
  }

  return ordenesCreadas;
}

const SUBQ_HERRAMENTAL = `
  COALESCE((
    SELECT SUM(h.herramental_precio)
    FROM solicitud_producto sp2
    JOIN herramental h ON h.idsolicitud_producto = sp2.idsolicitud_producto
    WHERE sp2.solicitud_idsolicitud = s.idsolicitud
      AND h.aprobado = true
  ), 0) AS herramental_total
`;

// ============================================================
// OBTENER TODAS LAS VENTAS
// ============================================================
export const getVentas = async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const { rows } = await pool.query(`
      SELECT
        v.idventas, v.solicitud_idsolicitud,
        v.subtotal, v.iva, v.total, v.anticipo, v.saldo, v.abono,
        v.moneda, v.tipo_cambio,
        v.fecha_creacion, v.fecha_liquidacion,
        v.estado_administrativo_cat_idestado_administrativo_cat AS estado_id,
        est.nombre AS estado_nombre,
        s.no_pedido, s.no_cotizacion,
        s.fecha    AS fecha_pedido,
        cli.razon_social AS cliente, cli.empresa, cli.telefono, cli.correo,
        cli.impresion,
        EXISTS (
          SELECT 1 FROM venta_pago vp
          WHERE vp.ventas_idventas = v.idventas
            AND vp.es_credito_anticipo = true
            AND vp.eliminado_at IS NULL
        ) AS es_credito_anticipo,
        ${SUBQ_HERRAMENTAL}
      FROM ventas v
      JOIN solicitud s   ON s.idsolicitud = v.solicitud_idsolicitud
      JOIN clientes cli  ON cli.idclientes = s.clientes_idclientes
      JOIN estado_administrativo_cat est
          ON est.idestado_administrativo_cat = v.estado_administrativo_cat_idestado_administrativo_cat
      ORDER BY v.idventas DESC
    `);
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET VENTAS ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener ventas" });
  }
};

// ============================================================
// OBTENER UNA VENTA POR ID
// ============================================================
export const getVentaById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rows: ventaRows } = await pool.query(`
      SELECT
        v.idventas, v.solicitud_idsolicitud,
        v.subtotal, v.iva, v.total, v.anticipo, v.saldo, v.abono,
        v.moneda, v.tipo_cambio,
        v.fecha_creacion, v.fecha_liquidacion,
        v.estado_administrativo_cat_idestado_administrativo_cat AS estado_id,
        est.nombre AS estado_nombre,
        s.no_pedido, s.no_cotizacion, s.fecha AS fecha_pedido,
        cli.razon_social AS cliente, cli.empresa, cli.telefono, cli.correo,
        cli.impresion,
        EXISTS (
          SELECT 1 FROM venta_pago vp
          WHERE vp.ventas_idventas = v.idventas
            AND vp.es_credito_anticipo = true
            AND vp.eliminado_at IS NULL
        ) AS es_credito_anticipo,
        ${SUBQ_HERRAMENTAL}
      FROM ventas v
      JOIN solicitud s   ON s.idsolicitud = v.solicitud_idsolicitud
      JOIN clientes cli  ON cli.idclientes = s.clientes_idclientes
      JOIN estado_administrativo_cat est
          ON est.idestado_administrativo_cat = v.estado_administrativo_cat_idestado_administrativo_cat
      WHERE v.idventas = $1
    `, [id]);

    if (ventaRows.length === 0) return res.status(404).json({ error: "Venta no encontrada" });

    const { rows: pagos } = await pool.query(`
      SELECT vp.idventa_pago, vp.monto, vp.es_anticipo, vp.es_credito_anticipo,
             vp.observacion, vp.fecha,
             vp.moneda, vp.tipo_cambio_aplicado, vp.monto_moneda_venta,
             mp.tipo_pago AS metodo_pago, mp.idmetodo_pago
      FROM venta_pago vp
      JOIN metodo_pago mp ON mp.idmetodo_pago = vp.metodo_pago_idmetodo_pago
      WHERE vp.ventas_idventas = $1
        AND vp.eliminado_at IS NULL
      ORDER BY vp.fecha ASC
    `, [id]);

    return res.json({ ...ventaRows[0], pagos });
  } catch (error: any) {
    console.error("❌ GET VENTA BY ID ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener venta" });
  }
};

// ============================================================
// OBTENER VENTA POR no_pedido
// ============================================================
export const getVentaByPedido = async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const { noPedido } = req.params;
    const { rows: ventaRows } = await pool.query(`
      SELECT
        v.idventas, v.solicitud_idsolicitud,
        v.subtotal, v.iva, v.total, v.anticipo, v.saldo, v.abono,
        v.moneda, v.tipo_cambio,
        v.fecha_creacion, v.fecha_liquidacion,
        v.estado_administrativo_cat_idestado_administrativo_cat AS estado_id,
        est.nombre AS estado_nombre,
        s.no_pedido, s.no_cotizacion, s.fecha AS fecha_pedido,
        cli.razon_social AS cliente, cli.empresa, cli.telefono, cli.correo,
        cli.impresion,
        EXISTS (
          SELECT 1 FROM venta_pago vp
          WHERE vp.ventas_idventas = v.idventas
            AND vp.es_credito_anticipo = true
            AND vp.eliminado_at IS NULL
        ) AS es_credito_anticipo,
        ${SUBQ_HERRAMENTAL}
      FROM ventas v
      JOIN solicitud s   ON s.idsolicitud = v.solicitud_idsolicitud
      JOIN clientes cli  ON cli.idclientes = s.clientes_idclientes
      JOIN estado_administrativo_cat est
          ON est.idestado_administrativo_cat = v.estado_administrativo_cat_idestado_administrativo_cat
      WHERE s.no_pedido = $1
    `, [noPedido]);

    if (ventaRows.length === 0) return res.status(404).json({ error: "Venta no encontrada para este pedido" });

    const { rows: pagos } = await pool.query(`
      SELECT vp.idventa_pago, vp.monto, vp.es_anticipo, vp.es_credito_anticipo,
             vp.observacion, vp.fecha,
             vp.moneda, vp.tipo_cambio_aplicado, vp.monto_moneda_venta,
             mp.tipo_pago AS metodo_pago, mp.idmetodo_pago
      FROM venta_pago vp
      JOIN metodo_pago mp ON mp.idmetodo_pago = vp.metodo_pago_idmetodo_pago
      WHERE vp.ventas_idventas = $1
        AND vp.eliminado_at IS NULL
      ORDER BY vp.fecha ASC
    `, [ventaRows[0].idventas]);

    return res.json({ ...ventaRows[0], pagos });
  } catch (error: any) {
    console.error("❌ GET VENTA BY PEDIDO ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener venta" });
  }
};

// ============================================================
// REGISTRAR PAGO / ABONO
// ============================================================
export const registrarPago = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const {
      metodoPagoId, monto, observacion = null, fecha = null,
      moneda: monedaPagoRaw, tipoCambioAplicado: tipoCambioAplicadoRaw,
    } = req.body;

    if (!metodoPagoId) return res.status(400).json({ error: "Se requiere metodoPagoId" });
    if (!monto || Number(monto) <= 0) return res.status(400).json({ error: "El monto debe ser mayor a 0" });

    let fechaPago: Date | null = null;
    if (fecha) {
      const parsed = new Date(fecha);
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ error: "La fecha proporcionada no es válida" });
      }
      if (parsed > new Date()) {
        return res.status(400).json({ error: "No se puede registrar un pago con fecha futura" });
      }
      fechaPago = parsed;
    }

    // req.tx abre la transacción, declara app.usuario_id para los triggers de
    // auditoría y hace COMMIT/ROLLBACK. Cortar el flujo a media transacción se
    // hace lanzando ErrorHttp, no con un return.
    const resultado = await req.tx(async (client) => {
      const venta = await obtenerVentaBloqueada(client, id);
      if (!venta) {
        throw new ErrorHttp(404, "Venta no encontrada");
      }

      const solicitudId = venta.solicitud_idsolicitud;
      const montoNum    = Number(monto);
      const monedaVenta: Moneda = venta.moneda ?? "MXN";

      let resuelto;
      try {
        resuelto = resolverMontoPago(montoNum, monedaPagoRaw, monedaVenta, tipoCambioAplicadoRaw);
      } catch (e: any) {
        throw new ErrorHttp(400, e.message);
      }
      const { moneda: monedaPago, tipoCambioAplicado, montoMonedaVenta } = resuelto;

      const abonoAntes  = Number(venta.abono);
      const nuevoAbono  = Number((abonoAntes + montoMonedaVenta).toFixed(2));
      const totalVenta  = Number(venta.total);
      const nuevoSaldo  = Number((totalVenta - nuevoAbono).toFixed(2));

      const umbralActivacion = calcularUmbralAnticipo(totalVenta);

      const anticipoAntesNoCubierto = abonoAntes  < umbralActivacion;
      const anticipoAhoraCubierto   = nuevoAbono >= umbralActivacion;
      const esAnticipoReal          = anticipoAntesNoCubierto && anticipoAhoraCubierto;
      const esLiquidacion           = nuevoSaldo <= 0;

      // FIX: verificar crédito antes de asignar estado
      const esCreditoAnticipo = await ventaTieneCredito(client, Number(id));
      const nuevoEstado       = determinarEstado(nuevoAbono, nuevoSaldo, umbralActivacion, esCreditoAnticipo);

      console.log(`💳 Pago: abono=${nuevoAbono} | umbral=${umbralActivacion} | credito=${esCreditoAnticipo} | estado=${nuevoEstado} | moneda=${monedaPago}${tipoCambioAplicado ? ` (tc=${tipoCambioAplicado} → ${montoMonedaVenta} ${monedaVenta})` : ""}`);

      await client.query(
        `INSERT INTO venta_pago (
          ventas_idventas, metodo_pago_idmetodo_pago,
          monto, es_anticipo, es_credito_anticipo, observacion, fecha,
          moneda, tipo_cambio_aplicado, monto_moneda_venta
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id, metodoPagoId, montoNum, esAnticipoReal, false, observacion, fechaPago ?? new Date(),
          monedaPago, tipoCambioAplicado, montoMonedaVenta,
        ]
      );

      await client.query(
        `UPDATE ventas
         SET abono  = $1,
             saldo  = $2,
             estado_administrativo_cat_idestado_administrativo_cat = $3
             ${esLiquidacion ? ", fecha_liquidacion = NOW()" : ""}
         WHERE idventas = $4`,
        [nuevoAbono, nuevoSaldo, nuevoEstado, id]
      );

      let ordenesGeneradas: string[] = [];
      if (anticipoAhoraCubierto) {
        ordenesGeneradas = await generarOrdenesPendientes(client, solicitudId, req.user?.id ?? null);
      }

      return {
        message:           "Pago registrado exitosamente",
        abono_total:       nuevoAbono,
        saldo:             nuevoSaldo,
        estado_id:         nuevoEstado,
        pagado:            nuevoSaldo <= 0,
        anticipo_cubierto: anticipoAhoraCubierto,
        es_anticipo:       esAnticipoReal,
        liquidado:         esLiquidacion,
        ordenes_generadas: ordenesGeneradas,
        moneda:              monedaPago,
        tipo_cambio_aplicado: tipoCambioAplicado,
        monto_moneda_venta:   montoMonedaVenta,
      };
    });

    return res.json(resultado);
  } catch (error) {
    return responderError(res, error, "Error al registrar pago");
  }
};

// ============================================================
// ELIMINAR PAGO
// ============================================================
export const eliminarPago = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const resultado = await req.tx(async (client) => {
      const { rows: pagoReferenciaRows } = await client.query(
        `SELECT ventas_idventas FROM venta_pago
         WHERE idventa_pago = $1 AND eliminado_at IS NULL`,
        [id]
      );
      if (pagoReferenciaRows.length === 0) {
        throw new ErrorHttp(404, "Pago no encontrado");
      }

      const ventaId = Number(pagoReferenciaRows[0].ventas_idventas);
      const venta = await obtenerVentaBloqueada(client, ventaId);
      if (!venta) {
        throw new ErrorHttp(404, "Venta no encontrada");
      }

      // Se confirma de nuevo después de esperar el advisory por solicitud;
      // otro proceso pudo haber eliminado este pago mientras tanto.
      const { rows: pagoRows } = await client.query(
        `SELECT idventa_pago, ventas_idventas, monto
         FROM venta_pago
         WHERE idventa_pago = $1 AND eliminado_at IS NULL
         FOR UPDATE`,
        [id]
      );
      if (pagoRows.length === 0) {
        throw new ErrorHttp(404, "Pago no encontrado");
      }

      // Borrado lógico, no DELETE: si el renglón desaparece, la bitácora
      // apunta a algo que ya no existe y se pierde justo lo que se quería
      // conservar — quién cobró qué y quién lo dio de baja después.
      // eliminado_por lo llena el trigger fn_tocar_autoria.
      await client.query(
        `UPDATE venta_pago SET eliminado_at = now() WHERE idventa_pago = $1`,
        [id]
      );

      const { rows: sumaRows } = await client.query(
        `SELECT COALESCE(SUM(monto_moneda_venta), 0) AS total_abonado
           FROM venta_pago
          WHERE ventas_idventas = $1 AND eliminado_at IS NULL`,
        [ventaId]
      );
      const nuevoAbono = Number(sumaRows[0].total_abonado);

      const total         = Number(venta.total);
      const nuevoSaldo    = Number((total - nuevoAbono).toFixed(2));
      const estaLiquidado = nuevoSaldo <= 0;

      const umbralActivacion = calcularUmbralAnticipo(total);

      // FIX: verificar si aún queda algún registro de crédito DESPUÉS de eliminar
      // (la baja lógica ya ocurrió y ventaTieneCredito filtra eliminado_at,
      //  así que si el pago dado de baja era el de crédito, ya no cuenta)
      const esCreditoAnticipo = await ventaTieneCredito(client, ventaId);
      const nuevoEstado       = determinarEstado(nuevoAbono, nuevoSaldo, umbralActivacion, esCreditoAnticipo);

      console.log(`🗑️ Eliminar pago: abono=${nuevoAbono} | umbral=${umbralActivacion} | credito=${esCreditoAnticipo} | estado=${nuevoEstado}`);

      await client.query(
        `UPDATE ventas
         SET abono = $1, saldo = $2,
             estado_administrativo_cat_idestado_administrativo_cat = $3,
             fecha_liquidacion = $4
         WHERE idventas = $5`,
        [nuevoAbono, nuevoSaldo, nuevoEstado, estaLiquidado ? new Date() : null, ventaId]
      );

      return {
        message:     "Pago eliminado y saldo recalculado",
        abono_total: nuevoAbono,
        saldo:       nuevoSaldo,
        estado_id:   nuevoEstado,
        liquidado:   estaLiquidado,
      };
    });

    return res.json(resultado);
  } catch (error) {
    return responderError(res, error, "Error al eliminar pago");
  }
};

// ============================================================
// AUTORIZAR ANTICIPO POR CRÉDITO
// ============================================================
export const autorizarAnticipoCredito = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const resultado = await req.tx(async (client) => {
      const venta = await obtenerVentaBloqueada(client, id);
      if (!venta) {
        throw new ErrorHttp(404, "Venta no encontrada");
      }

      const total = Number(venta.total);
      const abono = Number(venta.abono);
      const monedaVenta: Moneda = venta.moneda ?? "MXN";

      const umbralActivacion = calcularUmbralAnticipo(total);

      if (abono >= umbralActivacion) {
        throw new ErrorHttp(400, "El anticipo mínimo requerido ya está cubierto");
      }

      await client.query(
        `UPDATE ventas
         SET estado_administrativo_cat_idestado_administrativo_cat = $1
         WHERE idventas = $2`,
        [ESTADO.ANTICIPO_PAGADO, id]
      );

      await client.query(
        `INSERT INTO venta_pago (
          ventas_idventas, metodo_pago_idmetodo_pago,
          monto, es_anticipo, es_credito_anticipo, observacion, fecha,
          moneda, tipo_cambio_aplicado, monto_moneda_venta
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8, $9)`,
        [id, 1, 0, true, true, "Anticipo autorizado por crédito", monedaVenta, null, 0]
      );

      const ordenesGeneradas = await generarOrdenesPendientes(client, venta.solicitud_idsolicitud, req.user?.id ?? null);

      return {
        message:             "Anticipo autorizado por crédito",
        abono_total:         abono,
        saldo:               Number(venta.saldo),
        estado_id:           ESTADO.ANTICIPO_PAGADO,
        anticipo_cubierto:   true,
        es_credito_anticipo: true,
        ordenes_generadas:   ordenesGeneradas,
      };
    });

    return res.json(resultado);
  } catch (error) {
    return responderError(res, error, "Error al autorizar anticipo por crédito");
  }
};

// ============================================================
// OBTENER MÉTODOS DE PAGO
// ============================================================
export const getMetodosPago = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT idmetodo_pago, codigo, tipo_pago FROM metodo_pago ORDER BY idmetodo_pago`
    );
    return res.json(rows);
  } catch (error: any) {
    console.error("❌ GET MÉTODOS DE PAGO ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener métodos de pago" });
  }
};
