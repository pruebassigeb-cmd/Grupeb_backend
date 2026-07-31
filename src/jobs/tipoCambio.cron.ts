// src/jobs/tipoCambio.cron.ts
import cron from "node-cron";
import { sincronizarTipoCambioBanxico } from "../services/tipoCambio/tipoCambio.service";

// Banxico publica el dato FIX del día hábil alrededor de las 13:00 hrs
// (CDMX). Se corre a las 14:00 para darle margen, todos los días — si no
// hay dato nuevo (fin de semana/feriado) simplemente no inserta nada y el
// tipo de cambio "actual" sigue siendo el del último día hábil registrado.
const CRON_EXPRESION = "0 14 * * *";

export function iniciarCronTipoCambio() {
  cron.schedule(
    CRON_EXPRESION,
    () => {
      sincronizarTipoCambioBanxico().catch((e) =>
        console.error("❌ Error inesperado al sincronizar tipo de cambio:", e),
      );
    },
    { timezone: "America/Mexico_City" },
  );

  console.log(
    `⏰ Cron de tipo de cambio registrado (expresión: "${CRON_EXPRESION}", America/Mexico_City).`,
  );

  // Sincroniza una vez al arrancar el server, para no depender de esperar
  // hasta la próxima corrida programada (ej. tras un redeploy a media tarde).
  sincronizarTipoCambioBanxico().catch((e) =>
    console.error("❌ Error inesperado al sincronizar tipo de cambio al iniciar:", e),
  );
}
