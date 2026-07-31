// src/services/ventas/totalesVenta.service.ts
//
// Única fuente de verdad para la aritmética subtotal → IVA → total →
// anticipo, y para la regla que decide el estado administrativo de una
// venta según abono/saldo. Antes esto vivía duplicado (con las mismas
// constantes reescritas a mano en cada archivo) en:
//   - cotizaciones.controller.ts (crearVentaYDiseno)
//   - expo.controller.ts (su propio crearVentaYDiseno)
//   - pedidos.controller.ts (actualizarPedido, recálculo tras editar líneas)
//   - ventas.controller.ts (determinarEstado)
//   - estadoCuentaController.ts (recálculo de IVA/total)
//
// Consolidar esto es un prerrequisito para agregar moneda: si la aritmética
// sigue copiada en 4-5 lugares, agregar la dimensión de moneda en cada copia
// garantiza que alguna quede mal. Este módulo no conoce moneda todavía — los
// montos que recibe deben venir ya en la moneda del documento (MXN, o
// convertidos a USD por quien llama); eso se agrega en la Fase 1/2 del plan
// de precios en USD/MXN.

export const IVA_PORCENTAJE = 0.16;
export const ANTICIPO_PORCENTAJE = 0.5; // anticipo "documental" al crear/aprobar
export const ANTICIPO_VALIDACION_MIN = 0.4; // umbral real para considerar el anticipo cubierto

export const ESTADO_VENTA = {
  PENDIENTE: 1,
  ANTICIPO_PAGADO: 2,
  APROBADO: 3,
  RECHAZADO: 4,
  PAGADO: 6,
} as const;

export interface TotalesVenta {
  subtotal: number;
  iva: number;
  total: number;
  anticipo: number;
}

export interface CalcularTotalesVentaInput {
  subtotal: number;
  sinIva?: boolean;
  porcentajeAnticipo?: number;
}

export function calcularTotalesVenta(
  input: CalcularTotalesVentaInput,
): TotalesVenta {
  const {
    subtotal,
    sinIva = false,
    porcentajeAnticipo = ANTICIPO_PORCENTAJE,
  } = input;

  const iva = sinIva ? 0 : Number((subtotal * IVA_PORCENTAJE).toFixed(2));
  const total = Number((subtotal + iva).toFixed(2));
  const anticipo = Number((total * porcentajeAnticipo).toFixed(2));

  return { subtotal: Number(subtotal.toFixed(2)), iva, total, anticipo };
}

export function calcularUmbralAnticipo(total: number): number {
  return Number((total * ANTICIPO_VALIDACION_MIN).toFixed(2));
}

// Misma regla que ya usaba ventas.controller.ts (determinarEstado): decide
// el estado administrativo de una venta según abono/saldo actuales.
export function determinarEstadoVenta(
  nuevoAbono: number,
  nuevoSaldo: number,
  umbralActivacion: number,
  esCreditoAnticipo: boolean,
): number {
  if (nuevoSaldo <= 0) return ESTADO_VENTA.PAGADO;
  if (nuevoAbono >= umbralActivacion) return ESTADO_VENTA.ANTICIPO_PAGADO;
  if (esCreditoAnticipo) return ESTADO_VENTA.ANTICIPO_PAGADO;
  return ESTADO_VENTA.PENDIENTE;
}
