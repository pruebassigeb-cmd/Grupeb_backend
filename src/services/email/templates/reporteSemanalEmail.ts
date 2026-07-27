// src/services/email/templates/reporteSemanalEmail.ts
import type {
  OrdenHabilitadaNueva,
  OrdenSinAvance,
  CotizacionNueva,
  CotizacionSinAvance,
  PedidoNuevo,
  DisenoPendiente,
  AnticipoPendiente,
  TipoReporte,
} from "../../reportes/reporteSemanal.queries";

const FRONTEND_URL = (process.env.FRONTEND_URL || "https://sigeb.grupoeb.com.mx").replace(/\/+$/, "");

const RUTA_POR_REPORTE: Record<TipoReporte, string> = {
  produccion: "/seguimiento",
  cotizaciones: "/cotizar",
  pedidos: "/pedido",
  diseno: "/diseno",
  anticipos: "/anticipolicacion",
};

const TITULO_POR_REPORTE: Record<TipoReporte, string> = {
  produccion: "Producción",
  cotizaciones: "Cotizaciones",
  pedidos: "Pedidos",
  diseno: "Diseño",
  anticipos: "Anticipos",
};

const ICONO_POR_REPORTE: Record<TipoReporte, string> = {
  produccion: "📊",
  cotizaciones: "📋",
  pedidos: "🛒",
  diseno: "🎨",
  anticipos: "💰",
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
    <div style="margin: 14px 0 4px;">
      <a href="${url}" target="sigeb-app"
         style="background:#0D0D0D; color:#C9922A; text-decoration:none; padding: 9px 18px;
                border-radius: 6px; font-weight: bold; font-size: 13px; display: inline-block;">
        Ver en SIGEB →
      </a>
    </div>`;
}

function tabla(headers: string[], filas: string[][]): string {
  if (filas.length === 0) {
    return `<p style="color:#666; font-style: italic; margin: 4px 0 8px;">Sin registros esta semana. 🎉</p>`;
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
  return `<table style="width:100%; border-collapse:collapse; font-size:13px; margin-bottom:6px;"><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`;
}

function seccionTitulo(icono: string, texto: string): string {
  return `<h4 style="margin: 18px 0 6px; font-size: 13.5px; color:#333;">${icono} ${texto}</h4>`;
}

function wrapper(contenido: string): string {
  return `
  <div style="font-family: Arial, sans-serif; color: #1a1a1a; max-width: 700px; margin: 0 auto;">
    <div style="background:#0D0D0D; padding: 20px 24px; border-radius: 8px 8px 0 0;">
      <span style="color:#C9922A; font-size: 20px; font-weight: bold; font-family: Georgia, serif;">GRUPO EB</span>
      <div style="color:#fff; font-size: 13px; margin-top: 4px;">Reporte semanal — SIGEB</div>
    </div>
    <div style="border: 1px solid #e5e5e5; border-top: none; padding: 24px; border-radius: 0 0 8px 8px; font-size: 13.5px; line-height: 1.55;">
      ${contenido}
      <p style="font-size: 12px; color: #999; margin-top: 24px;">
        Reporte automático semanal — SIGEB, Grupo EB.
      </p>
    </div>
  </div>`;
}

export function armarAsuntoReporteCombinado(): string {
  const hoy = new Date().toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" });
  return `Reporte semanal SIGEB — ${hoy}`;
}

// ============================================================
// Constructores de CONTENIDO por sección (sin wrapper) — se usan
// para armar el correo combinado, con solo las secciones que cada
// usuario tenga activadas.
// ============================================================

export function contenidoProduccion(nuevas: OrdenHabilitadaNueva[], sinAvance: OrdenSinAvance[]): string {
  return `
    <h3 style="margin: 0 0 4px; font-size:16px;">${ICONO_POR_REPORTE.produccion} ${TITULO_POR_REPORTE.produccion}</h3>
    ${seccionTitulo("🆕", `Órdenes habilitadas nuevas (${nuevas.length})`)}
    ${tabla(
      ["N° Orden", "N° Pedido", "Cliente", "Impresión", "Fecha habilitación"],
      nuevas.map((o) => [o.no_produccion, o.no_pedido, o.cliente || "—", o.impresion || "—", fmtFecha(o.fecha_habilitacion)]),
    )}
    ${seccionTitulo("⏱️", `Con más de 5 días hábiles sin avance (${sinAvance.length})`)}
    ${tabla(
      ["N° Orden", "N° Pedido", "Cliente", "Impresión", "Días sin avance", "Último avance"],
      sinAvance.map((o) => [
        o.no_produccion,
        o.no_pedido,
        o.cliente || "—",
        o.impresion || "—",
        `<strong style="color:${o.dias_habiles_sin_avance > 15 ? "#c0392b" : "#b8860b"}">${o.dias_habiles_sin_avance}</strong>`,
        o.ultimo_avance ? fmtFecha(o.ultimo_avance) : "Nunca (desde habilitación)",
      ]),
    )}
    ${botonDeepLink("produccion")}
  `;
}

export function contenidoCotizaciones(nuevas: CotizacionNueva[], sinAvance: CotizacionSinAvance[]): string {
  return `
    <h3 style="margin: 0 0 4px; font-size:16px;">${ICONO_POR_REPORTE.cotizaciones} ${TITULO_POR_REPORTE.cotizaciones}</h3>
    ${seccionTitulo("🆕", `Cotizaciones nuevas (${nuevas.length})`)}
    ${tabla(
      ["N° Cotización", "Cliente", "Impresión", "Fecha"],
      nuevas.map((c) => [c.no_cotizacion, c.cliente || "—", c.impresion || "—", fmtFecha(c.fecha)]),
    )}
    ${seccionTitulo("⏱️", `Con más de 5 días hábiles sin aprobación (${sinAvance.length})`)}
    ${tabla(
      ["N° Cotización", "Cliente", "Impresión", "Días sin avance", "Fecha creación"],
      sinAvance.map((c) => [
        c.no_cotizacion,
        c.cliente || "—",
        c.impresion || "—",
        `<strong style="color:${c.dias_habiles_sin_avance > 15 ? "#c0392b" : "#b8860b"}">${c.dias_habiles_sin_avance}</strong>`,
        fmtFecha(c.fecha),
      ]),
    )}
    ${botonDeepLink("cotizaciones")}
  `;
}

export function contenidoPedidos(nuevos: PedidoNuevo[]): string {
  return `
    <h3 style="margin: 0 0 4px; font-size:16px;">${ICONO_POR_REPORTE.pedidos} ${TITULO_POR_REPORTE.pedidos}</h3>
    ${seccionTitulo("🆕", `Pedidos nuevos (${nuevos.length})`)}
    ${tabla(
      ["N° Pedido", "N° Cotización", "Cliente", "Impresión", "Fecha aprobación"],
      nuevos.map((p) => [p.no_pedido, p.no_cotizacion || "—", p.cliente || "—", p.impresion || "—", fmtFecha(p.fecha_aprobacion)]),
    )}
    ${botonDeepLink("pedidos")}
  `;
}

export function contenidoDiseno(pendientes: DisenoPendiente[]): string {
  return `
    <h3 style="margin: 0 0 4px; font-size:16px;">${ICONO_POR_REPORTE.diseno} ${TITULO_POR_REPORTE.diseno}</h3>
    ${seccionTitulo("🎨", `Pendientes de aprobación — pedidos nuevos (${pendientes.length})`)}
    ${tabla(
      ["N° Pedido", "Cliente", "Impresión", "Estado diseño", "Fecha pedido"],
      pendientes.map((d) => [d.no_pedido, d.cliente || "—", d.impresion || "—", d.estado_diseno || "Pendiente", fmtFecha(d.fecha_aprobacion_pedido)]),
    )}
    ${botonDeepLink("diseno")}
  `;
}

export function contenidoAnticipos(pendientes: AnticipoPendiente[]): string {
  return `
    <h3 style="margin: 0 0 4px; font-size:16px;">${ICONO_POR_REPORTE.anticipos} ${TITULO_POR_REPORTE.anticipos}</h3>
    ${seccionTitulo("💰", `Pendientes de aprobación — pedidos nuevos (${pendientes.length})`)}
    ${tabla(
      ["N° Pedido", "Cliente", "Impresión", "Anticipo", "Abono", "Saldo", "Estado", "Fecha pedido"],
      pendientes.map((a) => [
        a.no_pedido,
        a.cliente || "—",
        a.impresion || "—",
        fmtMoneda(a.anticipo),
        fmtMoneda(a.abono),
        fmtMoneda(a.saldo),
        a.estado_anticipo || "Pendiente",
        fmtFecha(a.fecha_aprobacion_pedido),
      ]),
    )}
    ${botonDeepLink("anticipos")}
  `;
}

// ============================================================
// Arma el correo combinado final: recibe solo las secciones que
// ese usuario tiene activadas, en un orden fijo, separadas por una
// línea divisoria.
// ============================================================
export function armarHtmlReporteCombinado(secciones: { tipo: TipoReporte; contenidoHtml: string }[]): string {
  const bloques = secciones
    .map((s, i) => {
      const divisor = i > 0 ? `<hr style="border:none; border-top:1px solid #e5e5e5; margin: 22px 0;"/>` : "";
      return `${divisor}${s.contenidoHtml}`;
    })
    .join("");

  return wrapper(bloques);
}