import { iniciarTx } from "../../middlewares/auditoria";
import { Request, Response } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { pool } from "../../config/db";
import {
  pedidoTieneProduccionCompleta,
  generarEstadoCuenta,
} from "../../services/ventas/estadoCuenta.service";

// ════════════════════════════════════════════════════════════════════════
// GET /api/estado-cuenta/:noPedido
//
// ANTES: este GET recalculaba todo desde cero y hacía UPDATE ventas +
// COMMIT en cada lectura (defectos A y B del plan — un GET que muta, sin
// ningún lock, así que un pago concurrente podía perderse). AHORA es
// lectura pura del snapshot vigente en `estado_cuenta` / `estado_cuenta_detalle`,
// generado por generarEstadoCuentaSiPedidoCompleto() cuando termina la
// producción (ver procesosController.finalizarProceso /
// procesosPapel.finalizarProcesoPapel) o por corrección/regeneración manual.
//
// abono/saldo/estado_id se leen EN VIVO de `ventas` (no del snapshot): los
// pagos siguen llegando después de que el estado de cuenta se generó — la
// razón de ser de "Cuentas por cobrar" es justo esperar esos pagos — así
// que congelar el saldo al momento de generación mostraría un saldo
// desactualizado. Lo que SÍ se congela en el snapshot son los importes que
// dependen de producción real (subtotal_real/iva_real/total_real y el
// detalle por producto), porque esos solo deben cambiar si se corrige un
// proceso ya terminado, no con cada pago.
// ════════════════════════════════════════════════════════════════════════
export const getEstadoCuenta = async (req: Request, res: Response) => {
  try {
    const { noPedido } = req.params;

    const { rows: pedidoRows } = await pool.query(`
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
        v.anticipo,
        v.abono,
        v.saldo,
        v.estado_administrativo_cat_idestado_administrativo_cat AS estado_id,
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
      return res.status(404).json({ error: "Pedido no encontrado" });
    }
    const pedido = pedidoRows[0];

    const { rows: ecRows } = await pool.query(
      `SELECT * FROM estado_cuenta WHERE ventas_idventas = $1 AND vigente = true`,
      [pedido.idventas],
    );

    if (ecRows.length === 0) {
      const produccion = await pedidoTieneProduccionCompleta(pool, Number(pedido.idsolicitud));
      return res.status(409).json({
        error: "Estado de cuenta no disponible",
        detalle: produccion.total === 0
          ? "Este pedido aún no tiene órdenes de producción."
          : `Faltan ${produccion.total - produccion.terminadas} de ${produccion.total} orden(es) por terminar.`,
        ordenes_totales: produccion.total,
        ordenes_terminadas: produccion.terminadas,
        ordenes_faltantes: produccion.faltantes,
      });
    }
    const ec = ecRows[0];

    const { rows: detalleRows } = await pool.query(
      `SELECT * FROM estado_cuenta_detalle
       WHERE estado_cuenta_idestado_cuenta = $1
       ORDER BY idestado_cuenta_detalle`,
      [ec.idestado_cuenta],
    );

    return res.json({
      no_pedido:     pedido.no_pedido,
      no_cotizacion: pedido.no_cotizacion,
      fecha:         pedido.fecha,
      cliente:       pedido.cliente,
      atencion:      pedido.atencion ?? null,
      empresa:       pedido.empresa,
      telefono:      pedido.telefono,
      correo:        pedido.correo,
      sin_iva:       pedido.sin_iva ?? false,
      moneda:        pedido.moneda ?? "MXN",
      tipo_cambio:   pedido.tipo_cambio ?? null,

      productos: detalleRows.map((d: any) => ({
        idsolicitud_producto:    d.solicitud_producto_idsolicitud_producto,
        tipo_material:           d.tipo_material,
        no_produccion:           d.no_produccion,
        produccion_pendiente:    false,
        nombre:                  d.nombre,
        medida:                  d.medida,
        material:                d.material,
        impresion:               pedido.impresion ?? null,
        modo_cantidad:           d.modo_cantidad,
        cantidad_original:       Number(d.cantidad_original),
        precio_total_original:   Number(d.precio_total_original),
        cantidad_real:           Number(d.cantidad_real),
        peso_kg_real:            d.peso_kg_real != null ? Number(d.peso_kg_real) : null,
        precio_unitario_real:    Number(d.precio_unitario_real),
        precio_total_real:       Number(d.precio_total_real),
        diferencia_piezas:       Number(d.diferencia_cantidad),
        diferencia_precio:       Number(d.diferencia_precio),
        herramental_descripcion: d.herramental_descripcion,
        herramental_precio:      d.herramental_precio != null ? Number(d.herramental_precio) : null,
        herramental_aprobado:    d.herramental_aprobado,
      })),

      // Compatibilidad con el frontend viejo — ya no aporta información
      // nueva porque producción incompleta corta arriba con 409. Ver
      // el comentario original en este mismo campo antes del refactor.
      tiene_productos_papel_pendientes: false,
      productos_papel_pendientes_count: 0,

      subtotal_original: Number(ec.subtotal_original),
      iva_original:      Number(ec.iva_original),
      total_original:    Number(ec.total_original),

      subtotal_real:     Number(ec.subtotal_real),
      iva_real:          Number(ec.iva_real),
      total_real:        Number(ec.total_real),
      herramental_total: Number(ec.herramental_total),
      cargo_adicional_papel_total: Number(ec.cargo_adicional_papel_total),

      anticipo:             Number(pedido.anticipo),
      primer_pago_anticipo: pedido.primer_pago_anticipo != null
        ? Number(pedido.primer_pago_anticipo)
        : null,
      // ── EN VIVO, no del snapshot — ver comentario arriba del handler ──
      abono:               Number(pedido.abono),
      saldo:               Number(pedido.saldo),
      es_credito_anticipo: pedido.es_credito_anticipo ?? false,

      diferencia_total: Number(ec.diferencia_total),
      estado_id:        pedido.estado_id,

      // ── NUEVO: metadatos del snapshot, para el badge "generado el X" y
      // el contador de días hábiles en Seguimiento/Cuentas por cobrar. ──
      version:           ec.version,
      motivo:            ec.motivo,
      fecha_generacion:  ec.fecha_generacion,
      fecha_liquidacion: ec.fecha_liquidacion,
    });

  } catch (error: any) {
    console.error("❌ ESTADO CUENTA ERROR:", error.message, error.stack);
    return res.status(500).json({ error: "Error al obtener estado de cuenta" });
  }
};

// ════════════════════════════════════════════════════════════════════════
// POST /api/estado-cuenta/:noPedido/generar
//
// NUEVO. Regeneración manual — pensado para cuando alguien corrige algo a
// mano y no quiere esperar a que otro proceso se finalice/edite para que
// se dispare el enganche automático. Requiere el mismo privilegio que ya
// protege la sección de anticipo/liquidación en el front
// (cobranza.anticipo_liquidacion.gestionar) — aplicar ese middleware en la
// ruta, igual que las demás rutas de cobranza.
// ════════════════════════════════════════════════════════════════════════
export const generarEstadoCuentaManual = async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const { noPedido } = req.params;
    await iniciarTx(req, client);

    const { rows } = await client.query(
      `SELECT idsolicitud FROM solicitud WHERE no_pedido = $1`,
      [noPedido],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Pedido no encontrado" });
    }
    const solicitudId = Number(rows[0].idsolicitud);

    const resultado = await generarEstadoCuenta(client, solicitudId, {
      usuarioId: req.user?.id ?? null,
      forzar: true,
    });

    if (resultado.motivo === "produccion_incompleta") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Producción incompleta",
        detalle: `Faltan ${resultado.faltantes?.length ?? 0} orden(es) por terminar.`,
        ordenes_faltantes: resultado.faltantes,
      });
    }

    await client.query("COMMIT");
    return res.json({
      message: resultado.generado
        ? "Estado de cuenta generado"
        : "El estado de cuenta ya estaba al día, no se generó una nueva versión",
      generado: resultado.generado,
      version:  resultado.version,
      motivo:   resultado.motivo,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ GENERAR ESTADO CUENTA MANUAL ERROR:", error.message);
    return res.status(500).json({ error: "Error al generar estado de cuenta" });
  } finally {
    client.release();
  }
};

// ════════════════════════════════════════════════════════════════════════
// GET /api/estado-cuenta — lista para EstadoCuenta.tsx
//
// Defecto F: produccion_completa ya NO se calcula contando a mano filas de
// asa_flexible/bolseo (lo que dejaba a papel siempre en false, porque
// nunca miraba empaque_papel). Ahora es, literalmente, "¿existe una fila
// vigente en estado_cuenta?" — y esa fila solo existe si
// pedidoTieneProduccionCompleta() dio true al generarla, para CUALQUIER
// material.
// ════════════════════════════════════════════════════════════════════════
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
        (ec.idestado_cuenta IS NOT NULL) AS produccion_completa,
        ec.fecha_generacion AS estado_cuenta_fecha,
        ec.version           AS estado_cuenta_version
      FROM solicitud s
      JOIN clientes cli ON cli.idclientes = s.clientes_idclientes
      JOIN ventas v     ON v.solicitud_idsolicitud = s.idsolicitud
      LEFT JOIN estado_cuenta ec
          ON ec.ventas_idventas = v.idventas AND ec.vigente = true
      WHERE s.estado = 'pedido'
        AND s.no_pedido IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM solicitud_producto sp
          JOIN orden_produccion op ON op.idsolicitud_producto = sp.idsolicitud_producto
          WHERE sp.solicitud_idsolicitud = s.idsolicitud
        )
      ORDER BY s.no_pedido DESC
    `);

    return res.json(rows);

  } catch (error: any) {
    console.error("❌ LISTA ESTADO CUENTA ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener lista de estado de cuenta" });
  }
};
