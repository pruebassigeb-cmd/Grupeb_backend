import * as cron from "node-cron";
import { pool }           from "../../config/db";
import { ejecutarBackup } from "./backup.controller";

// Tarea cron activa en memoria
let tareaActiva: cron.ScheduledTask | null = null;
const buildCronExpression = (
  frecuencia: string,
  hora: string,
  dia_semana: number
): string => {
  const [hh, mm] = hora.split(":");

  switch (frecuencia) {
    case "diario":         return `${mm} ${hh} * * *`;
    case "cada_2_dias":    return `${mm} ${hh} */2 * *`;
    case "cada_3_dias":    return `${mm} ${hh} */3 * *`;
    case "semanal":        return `${mm} ${hh} * * ${dia_semana}`;
    case "cada_2_semanas":
      // Cron no tiene "cada 2 semanas". Corremos el mismo día de la semana
      // y dentro del handler verificamos si han pasado ≥ 14 días.
      return `${mm} ${hh} * * ${dia_semana}`;
    case "mensual":        return `${mm} ${hh} 1 * *`;
    default:               return `${mm} ${hh} * * *`;
  }
};

/** Para "cada_2_semanas": verifica si han pasado ≥ 14 días desde el último backup */
const debeEjecutarCada2Semanas = async (): Promise<boolean> => {
  const result = await pool.query(
    "SELECT ultimo_backup FROM backup_schedule WHERE id = 1"
  );
  const ultimo: Date | null = result.rows[0]?.ultimo_backup ?? null;
  if (!ultimo) return true; // nunca se ha hecho → ejecutar

  const diasTranscurridos =
    (Date.now() - new Date(ultimo).getTime()) / (1000 * 60 * 60 * 24);
  return diasTranscurridos >= 14;
};

/** Inicia o reinicia el scheduler leyendo la config actual de la BD */
export const reiniciarScheduler = async (): Promise<void> => {
  // Detener tarea anterior si existe
  if (tareaActiva) {
    tareaActiva.stop();
    tareaActiva = null;
    console.log("🔄 Scheduler de backups detenido");
  }

  try {
    const result = await pool.query(
      "SELECT activo, frecuencia, hora, dia_semana FROM backup_schedule WHERE id = 1"
    );

    const config = result.rows[0];
    if (!config || !config.activo) {
      console.log("ℹ️  Scheduler de backups desactivado");
      return;
    }

    const expresion = buildCronExpression(
      config.frecuencia,
      config.hora,
      config.dia_semana ?? 0
    );

    if (!cron.validate(expresion)) {
      console.error("❌ Expresión cron inválida:", expresion);
      return;
    }

    tareaActiva = cron.schedule(expresion, async () => {
      console.log(`⏰ Ejecutando backup automático [${config.frecuencia}]...`);

      // Para "cada_2_semanas" verificamos antes de ejecutar
      if (config.frecuencia === "cada_2_semanas") {
        const debe = await debeEjecutarCada2Semanas();
        if (!debe) {
          console.log("⏭️  Backup cada_2_semanas: aún no han pasado 14 días, se omite");
          return;
        }
      }

      try {
        const filename = await ejecutarBackup(null);
        console.log(`✅ Backup automático completado: ${filename}`);
      } catch (err) {
        console.error("❌ Error en backup automático:", err);
      }
    });

    console.log(
      `✅ Scheduler iniciado | frecuencia: ${config.frecuencia} | hora: ${config.hora} | cron: "${expresion}"`
    );
  } catch (error) {
    console.error("❌ Error al iniciar scheduler de backups:", error);
  }
};

/** Llamar una vez al arrancar el servidor */
export const iniciarScheduler = reiniciarScheduler;