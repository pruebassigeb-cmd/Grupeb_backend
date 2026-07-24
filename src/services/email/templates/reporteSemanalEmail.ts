// src/services/email/templates/reporteSemanalEmail.ts
import type {
  OrdenHabilitadaNueva,
  OrdenSinAvance,
  CotizacionNueva,
  CotizacionSinAvance,
  PedidoNuevo,
  DisenoPendiente,
  AnticipoPendiente,
} from "../../reportes/reporteSemanal.queries";

export type TipoReporte = "produccion" | "cotizaciones" | "pedidos" | "diseno" | "anticipos";

const FRONTEND_URL = process.env.FRONTEND_URL || "https://sigeb.grupoeb.com.mx";

const RUTA_POR_REPORTE: Record<TipoReporte, string> = {
  produccion: "/seguimiento",
  cotizaciones: "/cotizar",
  pedidos: "/pedido",
  diseno: "/diseno",
  anticipos: "/anticipolicacion",
};

const TITULO_POR_REPORTE: Record<TipoReporte, string> = {
  produccion: "Reporte semanal — Producción",
  cotizaciones: "Reporte semanal — Cotizaciones",
  pedidos: "Reporte semanal — Pedidos",
  diseno: "Reporte semanal — Diseño",
  anticipos: "Reporte semanal — Anticipos",
};

function fmtFecha(f: Date | string | null): string {
  if (!f) return "—";
  return new Date(f).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtMoneda(n: number | null | undefined): string {
  if (n == null) return "—";
  return Number(n).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}

function botonDeepLink(tipo: TipoReporte): string {
  const url = `${FRONTEND_URL}${RUTA_POR_REPORTE[tipo]}`;
  return `
    <div style="margin: 20px 0;">
      <a href="${url}"
         style="background:#0D0D0D; color:#C9922A; text-decoration:none; padding: 10px 20px;
                border-radius: 6px; font-weight: bold; font-size: 13.5px; display: inline-block;">
        Ver en SIGEB →
      </a>
    </div>`;
}

function wrapper(titulo: string, contenido: string): string {
  return `
  <div style="font-family: Arial, sans-serif; color: #1a1a1a; max-width: 680px; margin: 0 auto;">
    <div style="background:#0D0D0D; padding: 20px 24px; border-radius: 8px 8px 0 0;">
      <span style="color:#C9922A; font-size: 20px; font-weight: bold; font-family: Georgia, serif;">GRUPO EB</span>
      <div style="color:#fff; font-size: 13px; margin-top: 4px;">${titulo}</div>
    </div>
    <div style="border: 1px solid #e5e5e5; border-top: none; padding: 24px; border-radius: 0 0 8px 8px; font-size: 13.5px; line-height: 1.6;">
      ${contenido}
      <p style="font-size: 12px; color: #999; margin-top: 24px;">
        Reporte automático semanal — SIGEB, Grupo EB.
      </p>
    </div>
  </div>`;
}

function tabla(headers: string[], filas: string[][]): string {
  if (filas.length === 0) {
    return `<p style="color:#666; font-style: italic;">Sin registros esta semana. 🎉</p>`;
  }
  const th = headers
    .map((h) => `<th style="text-align:left; padding:8px 10px; background:#f5f5f5; border-bottom:2px solid #e0e0e0; font-size:12px; text-transform:uppercase; color:#555;">${h}</th>`)
    .join("");
  const rows = filas
    .map(
      (fila) =>
        `<tr>${fila.map((c) => `<td style="padding:8px 10px; border-bottom:1px solid #eee;">${c}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<table style="width:100%; border-collapse:collapse; font-size:13px;"><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`;
}

export function armarAsuntoReporte(tipo: TipoReporte): string {
  const hoy = new Date().toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" });
  return `${TITULO_POR_REPORTE[tipo]} — ${hoy}`;
}

// ── 1 y 2: Producción ──────────────────────────────────────────────
export function armarHtmlReporteProduccion(nuevas: OrdenHabilitadaNueva[], sinAvance: OrdenSinAvance[]): string {
  const contenido = `
    <h3 style="margin-top:0;">🆕 Órdenes habilitadas nuevas (${nuevas.length})</h3>
    ${tabla(
      ["N° Orden", "N° Pedido", "Cliente", "Fecha habilitación"],
      nuevas.map((o) => [o.no_produccion, o.no_pedido, o.cliente || "—", fmtFecha(o.fecha_habilitacion)]),
    )}
    <h3>⏱️ Órdenes con más de 5 días hábiles sin avance (${sinAvance.length})</h3>
    ${tabla(
      ["N° Orden", "N° Pedido", "Cliente", "Días sin avance", "Último avance"],
      sinAvance.map((o) => [
        o.no_produccion,
        o.no_pedido,
        o.cliente || "—",
        `<strong style="color:${o.dias_habiles_sin_avance > 15 ? "#c0392b" : "#b8860b"}">${o.dias_habiles_sin_avance}</strong>`,
        o.ultimo_avance ? fmtFecha(o.ultimo_avance) : "Nunca (desde habilitación)",
      ]),
    )}
    ${botonDeepLink("produccion")}
  `;
  return wrapper(TITULO_POR_REPORTE.produccion, contenido);
}

// ── 3 y 4: Cotizaciones ─────────────────────────────────────────────
export function armarHtmlReporteCotizaciones(nuevas: CotizacionNueva[], sinAvance: CotizacionSinAvance[]): string {
  const contenido = `
    <h3 style="margin-top:0;">🆕 Cotizaciones nuevas (${nuevas.length})</h3>
    ${tabla(
      ["N° Cotización", "Cliente", "Fecha"],
      nuevas.map((c) => [c.no_cotizacion, c.cliente || "—", fmtFecha(c.fecha)]),
    )}
    <h3>⏱️ Cotizaciones con más de 5 días hábiles sin aprobación (${sinAvance.length})</h3>
    ${tabla(
      ["N° Cotización", "Cliente", "Días sin avance", "Fecha creación"],
      sinAvance.map((c) => [
        c.no_cotizacion,
        c.cliente || "—",
        `<strong style="color:${c.dias_habiles_sin_avance > 15 ? "#c0392b" : "#b8860b"}">${c.dias_habiles_sin_avance}</strong>`,
        fmtFecha(c.fecha),
      ]),
    )}
    ${botonDeepLink("cotizaciones")}
  `;
  return wrapper(TITULO_POR_REPORTE.cotizaciones, contenido);
}

// ── 5: Pedidos ──────────────────────────────────────────────────────
export function armarHtmlReportePedidos(nuevos: PedidoNuevo[]): string {
  const contenido = `
    <h3 style="margin-top:0;">🆕 Pedidos nuevos (${nuevos.length})</h3>
    ${tabla(
      ["N° Pedido", "N° Cotización", "Cliente", "Fecha aprobación"],
      nuevos.map((p) => [p.no_pedido, p.no_cotizacion || "—", p.cliente || "—", fmtFecha(p.fecha_aprobacion)]),
    )}
    ${botonDeepLink("pedidos")}
  `;
  return wrapper(TITULO_POR_REPORTE.pedidos, contenido);
}

// ── 6: Diseño ───────────────────────────────────────────────────────
export function armarHtmlReporteDiseno(pendientes: DisenoPendiente[]): string {
  const contenido = `
    <h3 style="margin-top:0;">🎨 Diseño pendiente de aprobación — pedidos nuevos (${pendientes.length})</h3>
    ${tabla(
      ["N° Pedido", "Cliente", "Estado diseño", "Fecha pedido"],
      pendientes.map((d) => [d.no_pedido, d.cliente || "—", d.estado_diseno || "Pendiente", fmtFecha(d.fecha_aprobacion_pedido)]),
    )}
    ${botonDeepLink("diseno")}
  `;
  return wrapper(TITULO_POR_REPORTE.diseno, contenido);
}

// ── 7: Anticipos ────────────────────────────────────────────────────
export function armarHtmlReporteAnticipos(pendientes: AnticipoPendiente[]): string {
  const contenido = `
    <h3 style="margin-top:0;">💰 Anticipos pendientes de aprobación — pedidos nuevos (${pendientes.length})</h3>
    ${tabla(
      ["N° Pedido", "Cliente", "Anticipo", "Abono", "Saldo", "Estado", "Fecha pedido"],
      pendientes.map((a) => [
        a.no_pedido,
        a.cliente || "—",
        fmtMoneda(a.anticipo),
        fmtMoneda(a.abono),
        fmtMoneda(a.saldo),
        a.estado_anticipo || "Pendiente",
        fmtFecha(a.fecha_aprobacion_pedido),
      ]),
    )}
    ${botonDeepLink("anticipos")}
  `;
  return wrapper(TITULO_POR_REPORTE.anticipos, contenido);
}