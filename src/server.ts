import "dotenv/config";

import app from "./app";
import cron from "node-cron";
import { pool } from "./config/db";
import { iniciarCronReporteSemanal } from "./jobs/reporteSemanal.cron";
import { iniciarCronTipoCambio } from "./jobs/tipoCambio.cron";

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🔥 Backend corriendo en http://localhost:${PORT}`);

  /*console.log("WHATSAPP_ACCESS_TOKEN cargado:", !!process.env.WHATSAPP_ACCESS_TOKEN);
  console.log("WHATSAPP_PHONE_NUMBER_ID cargado:", !!process.env.WHATSAPP_PHONE_NUMBER_ID);
  console.log("WHATSAPP_VERIFY_TOKEN cargado:", !!process.env.WHATSAPP_VERIFY_TOKEN);*/
});

// ============================================================
// CRON JOB — Reporte semanal por correo (producción, cotizaciones,
// pedidos, diseño, anticipos)
// Corre todos los lunes a las 8:00 AM
// ============================================================
iniciarCronReporteSemanal();

// ============================================================
// CRON JOB — Sincronización diaria del tipo de cambio (Banxico)
// Corre todos los días a las 2:00 PM, más una sincronización al arrancar
// ============================================================
iniciarCronTipoCambio();

// ============================================================
// CRON JOB — Limpieza de chats aprobados hace más de 30 días
// Corre todos los días a las 2:00 AM
// Conserva mensajes y archivos de la versión final marcada
// ============================================================
cron.schedule("0 2 * * *", async () => {
  console.log("🧹 Iniciando limpieza de chats antiguos...");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Órdenes aprobadas hace más de 30 días
    const { rows: ordenes } = await client.query(`
      SELECT idorden_diseno FROM orden_diseno
      WHERE estado = 'aprobado'
        AND autorizado_at < NOW() - INTERVAL '30 days'
    `);

    let totalMensajes = 0;
    let totalArchivos = 0;

    for (const orden of ordenes) {
      const ordenId = orden.idorden_diseno;

      // Buscar versión final marcada de esta orden
      const { rows: finalRows } = await client.query(
        `SELECT idrevision FROM revision_diseno
         WHERE orden_diseno_id = $1 AND es_version_final = true
         LIMIT 1`,
        [ordenId]
      );

      const revisionFinalId = finalRows[0]?.idrevision ?? null;

      // Desvincular archivos de revisiones que NO son la versión final
      const { rowCount: archivosDesvinculados } = await client.query(
        revisionFinalId
          ? `UPDATE archivos SET revision_diseno_id = NULL
             WHERE revision_diseno_id IN (
               SELECT idrevision FROM revision_diseno
               WHERE orden_diseno_id = $1 AND idrevision != $2
             )`
          : `UPDATE archivos SET revision_diseno_id = NULL
             WHERE revision_diseno_id IN (
               SELECT idrevision FROM revision_diseno
               WHERE orden_diseno_id = $1
             )`,
        revisionFinalId ? [ordenId, revisionFinalId] : [ordenId]
      );

      // Eliminar mensajes del chat excepto el de sistema de la versión final
      const { rowCount: mensajesEliminados } = await client.query(
        revisionFinalId
          ? `DELETE FROM mensaje_diseno
             WHERE orden_diseno_id = $1
               AND NOT (tipo = 'sistema' AND revision_id = $2)`
          : `DELETE FROM mensaje_diseno WHERE orden_diseno_id = $1`,
        revisionFinalId ? [ordenId, revisionFinalId] : [ordenId]
      );

      totalArchivos += archivosDesvinculados ?? 0;
      totalMensajes += mensajesEliminados ?? 0;

      console.log(
        `   ✓ Orden ${ordenId} — ${mensajesEliminados} mensajes, ${archivosDesvinculados} archivos`
      );
    }

    await client.query("COMMIT");

    console.log(
      `✅ Limpieza completada — ${ordenes.length} órdenes procesadas, ${totalMensajes} mensajes eliminados, ${totalArchivos} archivos desvinculados`
    );
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ Error en limpieza de chats:", error.message);
  } finally {
    client.release();
  }
}, {
  timezone: "America/Mexico_City",
});