// src/jobs/reporteSemanal.cron.ts
import cron from "node-cron";
import { enviarCorreo } from "../services/email/mailer";
import {
  obtenerOrdenesHabilitadasNuevas,
  obtenerOrdenesSinAvance,
  obtenerCotizacionesNuevas,
  obtenerCotizacionesSinAvance,
  obtenerPedidosNuevos,
  obtenerDisenoPendientes,
  obtenerAnticiposPendientes,
  obtenerUsuariosConReportesActivos,
  TipoReporte,
} from "../services/reportes/reporteSemanal.queries";
import {
  armarAsuntoReporteCombinado,
  armarHtmlReporteCombinado,
  contenidoProduccion,
  contenidoCotizaciones,
  contenidoPedidos,
  contenidoDiseno,
  contenidoAnticipos,
} from "../services/email/templates/reporteSemanalEmail";
import { generarPdfReporteCombinado, type DatasetsReporte } from "../services/reportes/reporteSemanalPdf";

// Orden fijo en el que aparecen las secciones dentro del correo combinado,
// independientemente del orden en que la BD regrese las preferencias.
const ORDEN_SECCIONES: TipoReporte[] = ["produccion", "cotizaciones", "pedidos", "diseno", "anticipos"];

export async function ejecutarReporteSemanal() {
  const hoy = new Date();
  console.log(`🗓️ Ejecutando reporte semanal combinado (${hoy.toISOString()})...`);

  try {
    // 1. Se jala la información UNA sola vez (no por usuario) — todos los
    //    usuarios que compartan una sección ven exactamente los mismos datos.
    const [
      nuevasProd, sinAvanceProd,
      nuevasCot, sinAvanceCot,
      pedidos,
      diseno,
      anticipos,
    ] = await Promise.all([
      obtenerOrdenesHabilitadasNuevas(hoy),
      obtenerOrdenesSinAvance(hoy),
      obtenerCotizacionesNuevas(hoy),
      obtenerCotizacionesSinAvance(hoy),
      obtenerPedidosNuevos(hoy),
      obtenerDisenoPendientes(hoy),
      obtenerAnticiposPendientes(hoy),
    ]);

    const contenidoPorSeccion: Record<TipoReporte, string> = {
      produccion: contenidoProduccion(nuevasProd, sinAvanceProd),
      cotizaciones: contenidoCotizaciones(nuevasCot, sinAvanceCot),
      pedidos: contenidoPedidos(pedidos),
      diseno: contenidoDiseno(diseno),
      anticipos: contenidoAnticipos(anticipos),
    };

    const datasets: DatasetsReporte = {
      nuevasProd, sinAvanceProd, nuevasCot, sinAvanceCot, pedidos, diseno, anticipos,
    };

    // 2. Quién recibe qué — un registro por usuario con su set de reportes
    const usuarios = await obtenerUsuariosConReportesActivos();

    if (usuarios.length === 0) {
      console.log("ℹ️ Reporte semanal: nadie tiene ningún reporte activado, no se manda nada.");
      return;
    }

    const asunto = armarAsuntoReporteCombinado();
    const fechaArchivo = hoy.toISOString().slice(0, 10); // YYYY-MM-DD

    // 3. Un correo por usuario, con solo sus secciones activas — HTML +
    //    el mismo contenido en PDF adjunto, por si lo quieren compartir.
    for (const usuario of usuarios) {
      const tiposActivos = ORDEN_SECCIONES.filter((tipo) => usuario.reportes.includes(tipo));
      if (tiposActivos.length === 0) continue;

      const secciones = tiposActivos.map((tipo) => ({ tipo, contenidoHtml: contenidoPorSeccion[tipo] }));

      try {
        const html = armarHtmlReporteCombinado(secciones);
        const pdfBuffer = await generarPdfReporteCombinado(datasets, tiposActivos);

        await enviarCorreo({
          para: usuario.correo,
          asunto,
          html,
          adjuntos: [
            {
              filename: `Reporte_Semanal_SIGEB_${fechaArchivo}.pdf`,
              content: pdfBuffer,
              contentType: "application/pdf",
            },
          ],
        });
        console.log(`✅ Reporte semanal enviado a ${usuario.correo} (${tiposActivos.join(", ")}), con PDF adjunto.`);
      } catch (e: any) {
        console.error(`❌ Reporte semanal — error al enviar a ${usuario.correo}:`, e.message);
      }
    }

    console.log(`🗓️ Reporte semanal terminado — ${usuarios.length} destinatario(s) procesado(s).`);
  } catch (e: any) {
    console.error("❌ Reporte semanal — error general:", e.message);
  }
}

// ⚠️ TEMPORAL — PRUEBA: lunes 10:45am, en vez del horario real.
// Cuando termines de probar, regresa esta línea a: "0 8 * * 1"  (lunes 8:00am)
const CRON_EXPRESION = "37 14 * * 1"; // lunes 10:45am

export function iniciarCronReporteSemanal() {
  cron.schedule(CRON_EXPRESION, () => {
    ejecutarReporteSemanal().catch((e) => console.error("❌ Error inesperado en reporte semanal:", e));
  }, { timezone: "America/Mexico_City" });

  console.log(`⏰ Cron de reporte semanal registrado (expresión: "${CRON_EXPRESION}", America/Mexico_City).`);
}