// src/services/ventas/pagos.service.ts
//
// Helpers compartidos por registrarPago / eliminarPago / autorizarAnticipoCredito
// en ventas.controller.ts. Antes esta misma consulta vivía copiada de forma
// idéntica en los tres.

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
