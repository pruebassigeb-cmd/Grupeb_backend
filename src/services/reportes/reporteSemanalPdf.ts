// src/services/reportes/reporteSemanalPdf.ts
import PDFDocument from "pdfkit";
import type {
  OrdenHabilitadaNueva,
  OrdenSinAvance,
  CotizacionNueva,
  CotizacionSinAvance,
  PedidoNuevo,
  DisenoPendiente,
  AnticipoPendiente,
  TipoReporte,
} from "./reporteSemanal.queries";
import { fmtFecha, fmtFechaLarga } from "../../utils/fecha";

export interface DatasetsReporte {
  nuevasProd: OrdenHabilitadaNueva[];
  sinAvanceProd: OrdenSinAvance[];
  nuevasCot: CotizacionNueva[];
  sinAvanceCot: CotizacionSinAvance[];
  pedidos: PedidoNuevo[];
  diseno: DisenoPendiente[];
  anticipos: AnticipoPendiente[];
}

const MARGEN = 40;
const ANCHO_UTIL = 595.28 - MARGEN * 2; // A4 en puntos, menos márgenes
const ALTO_LIMITE = 780; // si el cursor Y pasa de aquí, se agrega página nueva

const TITULO_POR_REPORTE: Record<TipoReporte, string> = {
  produccion: "Producción",
  cotizaciones: "Cotizaciones",
  pedidos: "Pedidos",
  diseno: "Diseño",
  anticipos: "Anticipos",
};

function fmtMoneda(n: number | null | undefined): string {
  if (n == null) return "—";
  return Number(n).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}

// ── Helpers de dibujo ──────────────────────────────────────────────
function encabezadoDocumento(doc: PDFKit.PDFDocument) {
  doc.fontSize(16).fillColor("#0D0D0D").font("Helvetica-Bold").text("GRUPO EB");
  doc.fontSize(9).fillColor("#666").font("Helvetica").text("Reporte semanal — SIGEB");
  doc.moveDown(0.3);
  doc.fontSize(8).fillColor("#999").text(fmtFechaLarga(new Date()));
  doc.moveDown(1);
  doc.strokeColor("#e5e5e5").moveTo(MARGEN, doc.y).lineTo(MARGEN + ANCHO_UTIL, doc.y).stroke();
  doc.moveDown(0.8);
}

function tituloSeccion(doc: PDFKit.PDFDocument, texto: string) {
  if (doc.y > ALTO_LIMITE - 40) doc.addPage();
  doc.fontSize(13).fillColor("#0D0D0D").font("Helvetica-Bold").text(texto);
  doc.moveDown(0.2);
  doc.strokeColor("#C9922A").lineWidth(1.5)
    .moveTo(MARGEN, doc.y).lineTo(MARGEN + 30, doc.y).stroke();
  doc.moveDown(0.3);
}

function subtitulo(doc: PDFKit.PDFDocument, texto: string) {
  if (doc.y > ALTO_LIMITE - 30) doc.addPage();
  doc.fontSize(10).fillColor("#333").font("Helvetica-Bold").text(texto);
  doc.moveDown(0.2);
}

function tabla(
  doc: PDFKit.PDFDocument,
  headers: string[],
  filas: (string | { texto: string; color?: string })[][],
  anchos: number[],
) {
  if (filas.length === 0) {
    doc.fontSize(9).fillColor("#888").font("Helvetica-Oblique").text("Sin registros esta semana.");
    doc.moveDown(0.6);
    return;
  }

  const startX = MARGEN;
  const rowHeight = 18;

  const dibujarEncabezado = () => {
    const y = doc.y;
    let x = startX;
    doc.fontSize(8).font("Helvetica-Bold").fillColor("#555");
    headers.forEach((h, i) => {
      doc.text(h.toUpperCase(), x, y, { width: anchos[i], lineBreak: false });
      x += anchos[i];
    });
    doc.y = y + 12;
    doc.moveDown(0.3);
    doc.strokeColor("#ddd").moveTo(startX, doc.y - 2).lineTo(startX + ANCHO_UTIL, doc.y - 2).stroke();
  };

  dibujarEncabezado();

  doc.font("Helvetica").fontSize(8.5);
  for (const fila of filas) {
    if (doc.y > ALTO_LIMITE) {
      doc.addPage();
      dibujarEncabezado();
    }
    const y = doc.y;
    let x = startX;
    fila.forEach((celda, i) => {
      const esObjeto = typeof celda === "object";
      const texto = esObjeto ? celda.texto : celda;
      const color = esObjeto && celda.color ? celda.color : "#222";
      doc.fillColor(color).text(texto, x, y, { width: anchos[i], lineBreak: false });
      x += anchos[i];
    });
    doc.y = y + rowHeight;
  }
  doc.moveDown(0.6);
}

// ── Secciones ───────────────────────────────────────────────────────
function seccionProduccion(doc: PDFKit.PDFDocument, nuevas: OrdenHabilitadaNueva[], sinAvance: OrdenSinAvance[]) {
  tituloSeccion(doc, TITULO_POR_REPORTE.produccion);

  subtitulo(doc, `Órdenes habilitadas nuevas (${nuevas.length})`);
  tabla(
    doc,
    ["N° Orden", "N° Pedido", "Cliente", "Impresión", "Fecha habilitación"],
    nuevas.map((o) => [o.no_produccion, o.no_pedido, o.cliente || "—", o.impresion || "—", fmtFecha(o.fecha_habilitacion)]),
    [80, 80, 140, 90, 125],
  );

  subtitulo(doc, `Con más de 5 días hábiles sin avance (${sinAvance.length})`);
  tabla(
    doc,
    ["N° Orden", "N° Pedido", "Cliente", "Impresión", "Días", "Último avance"],
    sinAvance.map((o) => [
      o.no_produccion,
      o.no_pedido,
      o.cliente || "—",
      o.impresion || "—",
      { texto: String(o.dias_habiles_sin_avance), color: o.dias_habiles_sin_avance > 15 ? "#c0392b" : "#b8860b" },
      o.ultimo_avance ? fmtFecha(o.ultimo_avance) : "Nunca",
    ]),
    [70, 70, 120, 80, 45, 130],
  );
}

function seccionCotizaciones(doc: PDFKit.PDFDocument, nuevas: CotizacionNueva[], sinAvance: CotizacionSinAvance[]) {
  tituloSeccion(doc, TITULO_POR_REPORTE.cotizaciones);

  subtitulo(doc, `Cotizaciones nuevas (${nuevas.length})`);
  tabla(
    doc,
    ["N° Cotización", "Cliente", "Impresión", "Fecha"],
    nuevas.map((c) => [c.no_cotizacion, c.cliente || "—", c.impresion || "—", fmtFecha(c.fecha)]),
    [120, 180, 90, 125],
  );

  subtitulo(doc, `Con más de 5 días hábiles sin aprobación (${sinAvance.length})`);
  tabla(
    doc,
    ["N° Cotización", "Cliente", "Impresión", "Días", "Fecha creación"],
    sinAvance.map((c) => [
      c.no_cotizacion,
      c.cliente || "—",
      c.impresion || "—",
      { texto: String(c.dias_habiles_sin_avance), color: c.dias_habiles_sin_avance > 15 ? "#c0392b" : "#b8860b" },
      fmtFecha(c.fecha),
    ]),
    [100, 170, 80, 40, 125],
  );
}

function seccionPedidos(doc: PDFKit.PDFDocument, nuevos: PedidoNuevo[]) {
  tituloSeccion(doc, TITULO_POR_REPORTE.pedidos);
  subtitulo(doc, `Pedidos nuevos (${nuevos.length})`);
  tabla(
    doc,
    ["N° Pedido", "N° Cotización", "Cliente", "Impresión", "Fecha aprobación"],
    nuevos.map((p) => [p.no_pedido, p.no_cotizacion || "—", p.cliente || "—", p.impresion || "—", fmtFecha(p.fecha_aprobacion)]),
    [90, 100, 140, 80, 105],
  );
}

function seccionDiseno(doc: PDFKit.PDFDocument, pendientes: DisenoPendiente[]) {
  tituloSeccion(doc, TITULO_POR_REPORTE.diseno);
  subtitulo(doc, `Pendientes de aprobación — pedidos nuevos (${pendientes.length})`);
  tabla(
    doc,
    ["N° Pedido", "Cliente", "Impresión", "Estado", "Fecha pedido"],
    pendientes.map((d) => [d.no_pedido, d.cliente || "—", d.impresion || "—", d.estado_diseno || "Pendiente", fmtFecha(d.fecha_aprobacion_pedido)]),
    [90, 160, 80, 90, 95],
  );
}

function seccionAnticipos(doc: PDFKit.PDFDocument, pendientes: AnticipoPendiente[]) {
  tituloSeccion(doc, TITULO_POR_REPORTE.anticipos);
  subtitulo(doc, `Pendientes de aprobación — pedidos nuevos (${pendientes.length})`);
  tabla(
    doc,
    ["N° Pedido", "Cliente", "Impresión", "Anticipo", "Abono", "Saldo", "Fecha"],
    pendientes.map((a) => [
      a.no_pedido,
      a.cliente || "—",
      a.impresion || "—",
      fmtMoneda(a.anticipo),
      fmtMoneda(a.abono),
      fmtMoneda(a.saldo),
      fmtFecha(a.fecha_aprobacion_pedido),
    ]),
    [70, 120, 70, 60, 60, 60, 75],
  );
}

// ============================================================
// Genera el PDF combinado — solo con las secciones que el usuario
// tiene activadas, mismo orden que el correo.
// ============================================================
export function generarPdfReporteCombinado(
  datasets: DatasetsReporte,
  tiposActivos: TipoReporte[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: MARGEN, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    encabezadoDocumento(doc);

    tiposActivos.forEach((tipo, i) => {
      if (i > 0) doc.moveDown(0.8);

      switch (tipo) {
        case "produccion":
          seccionProduccion(doc, datasets.nuevasProd, datasets.sinAvanceProd);
          break;
        case "cotizaciones":
          seccionCotizaciones(doc, datasets.nuevasCot, datasets.sinAvanceCot);
          break;
        case "pedidos":
          seccionPedidos(doc, datasets.pedidos);
          break;
        case "diseno":
          seccionDiseno(doc, datasets.diseno);
          break;
        case "anticipos":
          seccionAnticipos(doc, datasets.anticipos);
          break;
      }
    });

    doc.end();
  });
}