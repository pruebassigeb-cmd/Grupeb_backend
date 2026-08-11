// src/services/ventas/pagos.service.ts
//
// Helpers compartidos por registrarPago / eliminarPago / autorizarAnticipoCredito
// en ventas.controller.ts. Antes esta misma consulta vivía copiada de forma
// idéntica en los tres.

// Espacio de nombres propio para no colisionar con los advisory locks de un
// solo bigint que se usan por idsolicitud_producto al crear una OP.
const LOCK_NAMESPACE_SOLICITUD_VENTA = 74101;

/**
 * Serializa todas las operaciones financieras/estructurales de una solicitud.
 * Debe llamarse dentro de una transacción y antes de bloquear la fila de
 * `ventas` o los productos del pedido. Ese orden evita que un pago que habilita
 * una OP se cruce con la edición que recalcula subtotal, anticipo y saldo.
 */
export async function bloquearSolicitudParaVenta(
  client: any,
  solicitudId: number,
): Promise<void> {
  if (!Number.isInteger(solicitudId) || solicitudId <= 0) {
    throw new Error("idsolicitud inválido para bloqueo transaccional");
  }

  await client.query(
    `SELECT pg_advisory_xact_lock($1::integer, $2::integer)`,
    [LOCK_NAMESPACE_SOLICITUD_VENTA, solicitudId],
  );
}

export async function ventaTieneCredito(
  client: any,
  ventaId: number,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM venta_pago
     WHERE ventas_idventas = $1 AND es_credito_anticipo = true
       AND eliminado_at IS NULL
     LIMIT 1`,
    [ventaId],
  );
  return rows.length > 0;
}
