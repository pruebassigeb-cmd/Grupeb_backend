import { iniciarTx } from "../../middlewares/auditoria";
import { Request } from "express";
// src/services/ventas/cambioMoneda.service.ts
//
// Cambiar la moneda de una cotización o pedido YA CREADO. Convierte los
// precios que el vendedor ya capturó/ajustó (no vuelve a correr el motor de
// precios desde cero) usando el tipo de cambio vigente, y si ya existe una
// venta (pedido aprobado), también actualiza sus totales.
//
// Bloqueado si ya hay al menos un pago (venta_pago) registrado contra la
// venta — cambiar la moneda después de eso dejaría abonos históricos en una
// moneda que ya no cuadra con el nuevo total.

import { pool } from "../../config/db";
import { type Moneda } from "../../utils/moneda.utils";
import { obtenerTipoCambioActual } from "../tipoCambio/tipoCambio.service";
import { calcularTotalesVenta, calcularSubtotalSolicitud } from "./totalesVenta.service";

export interface ResultadoCambioMoneda {
  idsolicitud: number;
  moneda: Moneda;
  tipo_cambio: number | null;
  ventas_actualizada: boolean;
}

export async function cambiarMonedaSolicitud(
  req: Request,
  idsolicitud: number,
  monedaRaw: unknown,
): Promise<ResultadoCambioMoneda> {
  if (monedaRaw !== "MXN" && monedaRaw !== "USD") {
    throw new Error(`Moneda inválida: "${monedaRaw}". Debe ser "MXN" o "USD".`);
  }
  const nuevaMoneda = monedaRaw as Moneda;

  const client = await pool.connect();
  try {
    await iniciarTx(req, client);

    const { rows: solRows } = await client.query(
      `SELECT idsolicitud, moneda, sin_iva FROM solicitud WHERE idsolicitud = $1 FOR UPDATE`,
      [idsolicitud],
    );
    if (solRows.length === 0) {
      throw new Error("Cotización/pedido no encontrado");
    }
    const monedaActual: Moneda = solRows[0].moneda === "USD" ? "USD" : "MXN";
    const sinIva = solRows[0].sin_iva === true;

    const { rows: ventaRows } = await client.query(
      `SELECT idventas FROM ventas WHERE solicitud_idsolicitud = $1`,
      [idsolicitud],
    );
    const ventaId: number | null = ventaRows[0]?.idventas ?? null;

    if (ventaId) {
      const { rows: pagoRows } = await client.query(
        `SELECT 1 FROM venta_pago
          WHERE ventas_idventas = $1 AND eliminado_at IS NULL LIMIT 1`,
        [ventaId],
      );
      if (pagoRows.length > 0) {
        throw new Error(
          "No se puede cambiar la moneda: este pedido ya tiene pagos registrados.",
        );
      }
    }

    if (monedaActual === nuevaMoneda) {
      // Nada que convertir — solo confirma el estado actual.
      await client.query("COMMIT");
      return {
        idsolicitud,
        moneda: nuevaMoneda,
        tipo_cambio: solRows[0].moneda === "USD" ? Number(solRows[0].tipo_cambio) : null,
        ventas_actualizada: false,
      };
    }

    // Tipo de cambio siempre es el vigente (automático, sin captura manual —
    // ver módulo tipoCambio) tanto para convertir MXN→USD como USD→MXN.
    let tipoCambioActual: number | null = null;
    const actual = await obtenerTipoCambioActual();
    if (!actual) {
      throw new Error(
        "No hay tipo de cambio vigente disponible — intenta de nuevo más tarde.",
      );
    }
    tipoCambioActual = actual.valor;

    const factor =
      monedaActual === "MXN" ? 1 / tipoCambioActual : tipoCambioActual;

    await client.query(
      `UPDATE solicitud_detalle sd
       SET precio_unitario = ROUND((sd.precio_unitario * $1)::numeric, 2),
           precio_total    = ROUND((sd.precio_total    * $1)::numeric, 2)
       FROM solicitud_producto sp
       WHERE sd.solicitud_producto_id = sp.idsolicitud_producto
         AND sp.solicitud_idsolicitud = $2`,
      [factor, idsolicitud],
    );

    await client.query(
      `UPDATE herramental h
       SET herramental_precio = ROUND((h.herramental_precio * $1)::numeric, 2)
       FROM solicitud_producto sp
       WHERE h.idsolicitud_producto = sp.idsolicitud_producto
         AND sp.solicitud_idsolicitud = $2
         AND h.herramental_precio IS NOT NULL`,
      [factor, idsolicitud],
    );

    await client.query(
      `UPDATE solicitud_producto_papel spp
       SET cargo_adicional_precio = ROUND((spp.cargo_adicional_precio * $1)::numeric, 2)
       FROM solicitud_producto sp
       WHERE spp.idsolicitud_producto = sp.idsolicitud_producto
         AND sp.solicitud_idsolicitud = $2
         AND spp.cargo_adicional_precio IS NOT NULL`,
      [factor, idsolicitud],
    );

    const nuevoTipoCambioGuardado = nuevaMoneda === "USD" ? tipoCambioActual : null;

    await client.query(
      `UPDATE solicitud SET moneda = $1, tipo_cambio = $2 WHERE idsolicitud = $3`,
      [nuevaMoneda, nuevoTipoCambioGuardado, idsolicitud],
    );

    let ventasActualizada = false;
    if (ventaId) {
      const nuevoSubtotal = await calcularSubtotalSolicitud(client, idsolicitud);
      const { iva, total, anticipo } = calcularTotalesVenta({
        subtotal: nuevoSubtotal,
        sinIva,
      });

      // No hay pagos (ya se verificó arriba), así que abono=0 y saldo=total.
      await client.query(
        `UPDATE ventas
         SET moneda = $1, tipo_cambio = $2,
             subtotal = $3, iva = $4, total = $5, anticipo = $6, saldo = $5
         WHERE idventas = $7`,
        [nuevaMoneda, nuevoTipoCambioGuardado, nuevoSubtotal, iva, total, anticipo, ventaId],
      );
      ventasActualizada = true;
    }

    await client.query("COMMIT");

    return {
      idsolicitud,
      moneda: nuevaMoneda,
      tipo_cambio: nuevoTipoCambioGuardado,
      ventas_actualizada: ventasActualizada,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
