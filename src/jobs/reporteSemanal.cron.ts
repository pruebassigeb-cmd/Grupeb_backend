// src/jobs/reporteSemanal.cron.ts
import cron from "node-cron";
import { pool } from "../config/db";
import { enviarCorreo } from "../services/email/mailer";
import {
  obtenerOrdenesHabilitadasNuevas,
  obtenerOrdenesSinAvance,
  obtenerCotizacionesNuevas,
  obtenerCotizacionesSinAvance,
  obtenerPedidosNuevos,
  obtenerDisenoPendientes,
  obtenerAnticiposPendientes,
} from "../services/reportes/reporteSemanal.queries";
import {
  armarAsuntoReporte,
  armarHtmlReporteProduccion,
  armarHtmlReporteCotizaciones,
  armarHtmlReportePedidos,
  armarHtmlReporteDiseno,
  armarHtmlReporteAnticipos,
  TipoReporte,
} from "../services/email/templates/reporteSemanalEmail";

async function obtenerDestinatarios(reporte: TipoReporte): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT u.correo
     FROM preferencia_correo_reporte pcr
     JOIN usuarios u ON u.idusuario = pcr.usuarios_idusuario
     WHERE pcr.reporte = $1 AND u.activo = true`,
    [reporte],
  );
  return rows.map((r) => r.correo).filter(Boolean);
}

async function enviarSiHayDestinatarios(reporte: TipoReporte, html: string) {
  const destinatarios = await obtenerDestinatarios(reporte);
  if (destinatarios.length === 0) {
    console.log(`ℹ️ Reporte semanal "${reporte}": sin destinatarios configurados, se omite.`);
    return;
  }
  await enviarCorreo({ para: destinatarios, asunto: armarAsuntoReporte(reporte), html });
  console.log(`✅ Reporte semanal "${reporte}" enviado a ${destinatarios.length} destinatario(s).`);
}

export async function ejecutarReporteSemanal() {
  const hoy = new Date();
  console.log(`🗓️ Ejecutando reporte semanal (${hoy.toISOString()})...`);

  try {
    const [nuevasProd, sinAvanceProd] = await Promise.all([
      obtenerOrdenesHabilitadasNuevas(hoy),
      obtenerOrdenesSinAvance(hoy),
    ]);
    await enviarSiHayDestinatarios("produccion", armarHtmlReporteProduccion(nuevasProd, sinAvanceProd));
  } catch (e: any) {
    console.error("❌ Reporte semanal — Producción:", e.message);
  }

  try {
    const [nuevasCot, sinAvanceCot] = await Promise.all([
      obtenerCotizacionesNuevas(hoy),
      obtenerCotizacionesSinAvance(hoy),
    ]);
    await enviarSiHayDestinatarios("cotizaciones", armarHtmlReporteCotizaciones(nuevasCot, sinAvanceCot));
  } catch (e: any) {
    console.error("❌ Reporte semanal — Cotizaciones:", e.message);
  }

  try {
    const pedidos = await obtenerPedidosNuevos(hoy);
    await enviarSiHayDestinatarios("pedidos", armarHtmlReportePedidos(pedidos));
  } catch (e: any) {
    console.error("❌ Reporte semanal — Pedidos:", e.message);
  }

  try {
    const diseno = await obtenerDisenoPendientes(hoy);
    await enviarSiHayDestinatarios("diseno", armarHtmlReporteDiseno(diseno));
  } catch (e: any) {
    console.error("❌ Reporte semanal — Diseño:", e.message);
  }

  try {
    const anticipos = await obtenerAnticiposPendientes(hoy);
    await enviarSiHayDestinatarios("anticipos", armarHtmlReporteAnticipos(anticipos));
  } catch (e: any) {
    console.error("❌ Reporte semanal — Anticipos:", e.message);
  }

  console.log("🗓️ Reporte semanal terminado.");
}

const CRON_EXPRESION = "0 8 * * 1"; // Lunes 8:00 AM

export function iniciarCronReporteSemanal() {
  cron.schedule(CRON_EXPRESION, () => {
    ejecutarReporteSemanal().catch((e) => console.error("❌ Error inesperado en reporte semanal:", e));
  }, { timezone: "America/Mexico_City" });

  console.log(`⏰ Cron de reporte semanal registrado (expresión: "${CRON_EXPRESION}", America/Mexico_City).`);
}