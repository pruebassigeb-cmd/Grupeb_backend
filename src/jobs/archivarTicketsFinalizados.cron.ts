// src/jobs/archivarTicketsFinalizados.cron.ts
//
// Archiva (archivado = true) los tickets Finalizado O Cancelado que ya
// llevan más de 5 días hábiles cerrados. Un ticket archivado deja de
// aparecer en el tablero normal — solo se ve marcando "Ver archivo
// histórico" en Mesa de Tickets. Nunca se borra nada, solo se esconde.
//
// Usa el MISMO criterio de "horas hábiles" (L-V, 8am-6pm, 10h/día) que ya
// usa el resto de Mesa de Tickets para fecha de compromiso y tiempo real —
// 5 días hábiles = 50 horas hábiles — para que "5 días" signifique lo
// mismo en todo el módulo, no una cuenta de calendario aparte.
import cron from "node-cron";
import { pool } from "../config/db";
import { horasHabilesEntre, HORAS_POR_DIA } from "../controllers/tickets/tickets.controller";

const DIAS_HABILES_PARA_ARCHIVAR = 5;
const HORAS_PARA_ARCHIVAR = DIAS_HABILES_PARA_ARCHIVAR * HORAS_POR_DIA; // 50

export function iniciarCronArchivarTickets() {
  // Cada hora en punto — archivar unas horas tarde no le afecta a nadie,
  // no hace falta correrlo más seguido que eso.
  cron.schedule(
    "0 * * * *",
    async () => {
      try {
        const { rows } = await pool.query(
          `SELECT idticket, fecha_cierre
             FROM ticket
            WHERE estado IN ('Finalizado', 'Cancelado')
              AND archivado = false
              AND fecha_cierre IS NOT NULL`
        );

        if (rows.length === 0) return;

        const ahora = new Date();
        const idsParaArchivar = rows
          .filter((t: any) => horasHabilesEntre(new Date(t.fecha_cierre), ahora) >= HORAS_PARA_ARCHIVAR)
          .map((t: any) => t.idticket);

        if (idsParaArchivar.length === 0) return;

        await pool.query(
          `UPDATE ticket SET archivado = true, archivado_en = now() WHERE idticket = ANY($1::int[])`,
          [idsParaArchivar]
        );

        console.log(`🗄️ Mesa de Tickets: ${idsParaArchivar.length} ticket(s) archivado(s) tras 5 días hábiles cerrados`);
      } catch (error: any) {
        console.error("❌ Error archivando tickets cerrados:", error.message);
      }
    },
    { timezone: "America/Mexico_City" }
  );
}