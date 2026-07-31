// src/services/tipoCambio/tipoCambio.service.ts
import { pool } from "../../config/db";

// Tipo de cambio FIX (pesos por dólar), serie oficial de Banxico.
const BANXICO_SERIE_FIX = "SF43718";
const BANXICO_URL = `https://www.banxico.org.mx/SieAPIRest/service/v1/series/${BANXICO_SERIE_FIX}/datos/oportuno`;

export interface TipoCambioActual {
  idtipo_cambio: number;
  fecha: string;
  valor: number;
  origen: "banxico" | "manual";
  capturado_por: number | null;
  created_at: string;
}

function parseFechaBanxico(fecha: string): string {
  // Banxico entrega "DD/MM/YYYY" → lo normalizamos a "YYYY-MM-DD" para la
  // columna `date` de tipo_cambio.
  const [dd, mm, yyyy] = fecha.split("/");
  return `${yyyy}-${mm}-${dd}`;
}

// Consulta el dato "oportuno" (el más reciente publicado) de Banxico y lo
// guarda en tipo_cambio. No lanza si Banxico falla, no hay token, o el dato
// no está disponible (fines de semana/feriados) — solo lo reporta, para que
// quien la llame (cron o endpoint) pueda seguir usando el último valor
// guardado sin caerse.
export async function sincronizarTipoCambioBanxico(): Promise<TipoCambioActual | null> {
  const token = process.env.BANXICO_TOKEN;
  if (!token) {
    console.warn(
      "⚠️ BANXICO_TOKEN no configurado — se omite sincronización de tipo de cambio.",
    );
    return null;
  }

  try {
    const resp = await fetch(BANXICO_URL, {
      headers: { "Bmx-Token": token, Accept: "application/json" },
    });

    if (!resp.ok) {
      console.error(
        `❌ Banxico respondió ${resp.status} al consultar tipo de cambio`,
      );
      return null;
    }

    const body: any = await resp.json();
    const dato = body?.bmx?.series?.[0]?.datos?.[0];

    if (!dato || dato.dato === "N/E") {
      console.warn("⚠️ Banxico no tiene un dato de tipo de cambio disponible todavía.");
      return null;
    }

    const fecha = parseFechaBanxico(dato.fecha);
    const valor = Number(dato.dato);

    if (!valor || valor <= 0) {
      console.error(`❌ Valor de tipo de cambio inválido recibido de Banxico: ${dato.dato}`);
      return null;
    }

    // Si ya existe una captura MANUAL para esa fecha, se respeta y no se
    // sobreescribe (la condición en el WHERE hace que el UPDATE se salte
    // para esa fila; ON CONFLICT ... DO NOTHING no permitiría distinguir
    // ambos casos con un solo RETURNING).
    const { rows } = await pool.query(
      `INSERT INTO tipo_cambio (fecha, valor, origen)
       VALUES ($1, $2, 'banxico')
       ON CONFLICT (fecha) DO UPDATE
         SET valor = EXCLUDED.valor
         WHERE tipo_cambio.origen = 'banxico'
       RETURNING idtipo_cambio, fecha, valor, origen, capturado_por, created_at`,
      [fecha, valor],
    );

    if (rows.length === 0) {
      console.log(`ℹ️ Tipo de cambio ${fecha} ya tiene una captura manual, no se sobreescribe.`);
      return obtenerTipoCambioActual();
    }

    console.log(`✅ Tipo de cambio Banxico sincronizado: ${fecha} = ${valor}`);
    return rows[0];
  } catch (err: any) {
    console.error("❌ Error al sincronizar tipo de cambio Banxico:", err.message);
    return null;
  }
}

// El valor "actual" es siempre la fila más reciente en tipo_cambio, sin
// importar si vino de Banxico o de una captura manual.
export async function obtenerTipoCambioActual(): Promise<TipoCambioActual | null> {
  const { rows } = await pool.query(
    `SELECT idtipo_cambio, fecha, valor, origen, capturado_por, created_at
     FROM tipo_cambio
     ORDER BY fecha DESC
     LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function obtenerHistorialTipoCambio(
  limite = 30,
): Promise<TipoCambioActual[]> {
  const { rows } = await pool.query(
    `SELECT idtipo_cambio, fecha, valor, origen, capturado_por, created_at
     FROM tipo_cambio
     ORDER BY fecha DESC
     LIMIT $1`,
    [limite],
  );
  return rows;
}

export async function registrarTipoCambioManual(
  valor: number,
  usuarioId: number,
): Promise<TipoCambioActual> {
  if (!valor || valor <= 0) {
    throw new Error("El valor del tipo de cambio debe ser mayor a 0");
  }

  const hoy = new Date().toISOString().slice(0, 10);

  const { rows } = await pool.query(
    `INSERT INTO tipo_cambio (fecha, valor, origen, capturado_por)
     VALUES ($1, $2, 'manual', $3)
     ON CONFLICT (fecha) DO UPDATE
       SET valor = EXCLUDED.valor, origen = 'manual', capturado_por = EXCLUDED.capturado_por
     RETURNING idtipo_cambio, fecha, valor, origen, capturado_por, created_at`,
    [hoy, valor, usuarioId],
  );

  return rows[0];
}
