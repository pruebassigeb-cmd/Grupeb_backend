// src/utils/moneda.utils.ts
//
// Convención fija en todo el backend: tipoCambio = pesos MXN por 1 USD
// (ej. 18.50). USD = MXN / tipoCambio. MXN = USD * tipoCambio.

export type Moneda = "MXN" | "USD";
export type DireccionConversion = "MXN_A_USD" | "USD_A_MXN";

export function esMonedaValida(valor: unknown): valor is Moneda {
  return valor === "MXN" || valor === "USD";
}

export function convertirMonto(
  monto: number,
  tipoCambio: number,
  direccion: DireccionConversion,
): number {
  if (!tipoCambio || tipoCambio <= 0) {
    throw new Error("tipoCambio debe ser un número mayor a 0 para convertir");
  }
  const resultado =
    direccion === "MXN_A_USD" ? monto / tipoCambio : monto * tipoCambio;
  return Number(resultado.toFixed(2));
}

// Convierte `monto` de la moneda `desde` a la moneda `hacia`. Si son la
// misma moneda regresa el monto sin tocar (no exige tipoCambio en ese caso).
export function convertirEntreMonedas(
  monto: number,
  desde: Moneda,
  hacia: Moneda,
  tipoCambio: number | null | undefined,
): number {
  if (desde === hacia) return Number(monto.toFixed(2));
  if (!tipoCambio || tipoCambio <= 0) {
    throw new Error(
      `Se requiere un tipoCambio válido para convertir ${desde} → ${hacia}`,
    );
  }
  return convertirMonto(
    monto,
    tipoCambio,
    desde === "MXN" ? "MXN_A_USD" : "USD_A_MXN",
  );
}

export interface MonedaYTipoCambio {
  moneda: Moneda;
  tipoCambio: number | null;
}

// Valida y normaliza moneda/tipoCambio recibidos del body de una petición
// (crear cotización / crear cotización expo). Lanza si moneda es inválida,
// o si es USD sin un tipoCambio > 0. Para MXN, tipoCambio siempre regresa
// null (no aplica).
export function validarMonedaYTipoCambio(
  monedaRaw: unknown,
  tipoCambioRaw: unknown,
): MonedaYTipoCambio {
  if (monedaRaw != null && monedaRaw !== "MXN" && monedaRaw !== "USD") {
    throw new Error(`Moneda inválida: "${monedaRaw}". Debe ser "MXN" o "USD".`);
  }

  const moneda: Moneda = monedaRaw === "USD" ? "USD" : "MXN";

  if (moneda === "MXN") {
    return { moneda, tipoCambio: null };
  }

  const tipoCambio = Number(tipoCambioRaw);
  if (!tipoCambio || tipoCambio <= 0) {
    throw new Error(
      "Se requiere un tipoCambio válido (mayor a 0) para cotizar en USD",
    );
  }

  return { moneda, tipoCambio: Number(tipoCambio.toFixed(4)) };
}

export interface ResolverMontoPagoResultado {
  moneda: Moneda; // moneda en la que efectivamente se recibió el pago
  tipoCambioAplicado: number | null; // null si moneda === monedaVenta
  montoMonedaVenta: number; // monto ya convertido a la moneda de la venta
}

// Resuelve un pago (venta_pago) que puede venir en la misma moneda de la
// venta o en la contraria. Si es la misma, no exige tipo de cambio. Si es
// distinta, exige un tipoCambioAplicado > 0 y convierte el monto a la
// moneda de la venta — ese valor convertido es el que alimenta abono/saldo.
export function resolverMontoPago(
  monto: number,
  monedaPagoRaw: unknown,
  monedaVenta: Moneda,
  tipoCambioAplicadoRaw: unknown,
): ResolverMontoPagoResultado {
  if (monedaPagoRaw != null && monedaPagoRaw !== "MXN" && monedaPagoRaw !== "USD") {
    throw new Error(`Moneda de pago inválida: "${monedaPagoRaw}". Debe ser "MXN" o "USD".`);
  }

  const moneda: Moneda =
    monedaPagoRaw === "USD" || monedaPagoRaw === "MXN" ? monedaPagoRaw : monedaVenta;

  if (moneda === monedaVenta) {
    return {
      moneda,
      tipoCambioAplicado: null,
      montoMonedaVenta: Number(monto.toFixed(2)),
    };
  }

  const tipoCambioAplicado = Number(tipoCambioAplicadoRaw);
  if (!tipoCambioAplicado || tipoCambioAplicado <= 0) {
    throw new Error(
      `Se requiere un tipoCambioAplicado válido (mayor a 0) para registrar un pago en ${moneda} contra una venta en ${monedaVenta}`,
    );
  }

  const montoMonedaVenta = convertirEntreMonedas(monto, moneda, monedaVenta, tipoCambioAplicado);

  return {
    moneda,
    tipoCambioAplicado: Number(tipoCambioAplicado.toFixed(4)),
    montoMonedaVenta,
  };
}
