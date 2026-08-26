/* ──────────────────────────────────────────────────────────────────────
 * Formato de fechas del backend — para correos, PDFs y mensajes.
 *
 * Este proceso corre en UTC (en Render siempre; en local se fuerza con
 * TZ=UTC). Por eso `toLocaleString("es-MX")` a secas imprime hora UTC y
 * todo sale 6 horas adelantado. Toda fecha que vaya a leer un humano
 * tiene que pasar por aquí.
 *
 * Para lo que se manda al frontend NO se usa esto: ahí viaja el instante
 * crudo en UTC y el cliente lo formatea con src/utils/fecha.ts.
 * ────────────────────────────────────────────────────────────────────── */

export const ZONA_MX = "America/Mexico_City";
const LOCALE = "es-MX";

export type EntradaFecha = string | number | Date | null | undefined;

const RE_SOLO_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_SIN_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;

type Resuelto = { fecha: Date; zona: string };

function resolver(valor: EntradaFecha): Resuelto | null {
  if (valor === null || valor === undefined || valor === "") return null;

  if (valor instanceof Date) {
    return Number.isNaN(valor.getTime()) ? null : { fecha: valor, zona: ZONA_MX };
  }

  if (typeof valor === "number") {
    const fecha = new Date(valor);
    return Number.isNaN(fecha.getTime()) ? null : { fecha, zona: ZONA_MX };
  }

  const texto = valor.trim();

  // Fecha sin hora (columna `date`): no es un instante. Se ancla y se
  // formatea en UTC para que el día no se recorra.
  const partes = RE_SOLO_FECHA.exec(texto);
  if (partes) {
    const [, anio, mes, dia] = partes;
    return { fecha: new Date(Date.UTC(+anio, +mes - 1, +dia)), zona: "UTC" };
  }

  // Fecha-hora sin offset: por contrato de la base viene en UTC.
  const iso = RE_SIN_OFFSET.test(texto) ? `${texto.replace(" ", "T")}Z` : texto;

  const fecha = new Date(iso);
  return Number.isNaN(fecha.getTime()) ? null : { fecha, zona: ZONA_MX };
}

const cacheFormato = new Map<string, Intl.DateTimeFormat>();

function conOpciones(opciones: Intl.DateTimeFormatOptions) {
  return (valor: EntradaFecha, alterno = "—"): string => {
    const resuelto = resolver(valor);
    if (!resuelto) return alterno;

    const llave = `${resuelto.zona}|${JSON.stringify(opciones)}`;
    let formato = cacheFormato.get(llave);
    if (!formato) {
      formato = new Intl.DateTimeFormat(LOCALE, {
        timeZone: resuelto.zona,
        ...opciones,
      });
      cacheFormato.set(llave, formato);
    }
    return formato.format(resuelto.fecha);
  };
}

/** 25 ago 2026 */
export const fmtFecha = conOpciones({
  day: "2-digit",
  month: "short",
  year: "numeric",
});

/** 25 de agosto de 2026 */
export const fmtFechaLarga = conOpciones({
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** 25 ago 2026, 02:00 p.m. */
export const fmtFechaHora = conOpciones({
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** 02:00 p.m. */
export const fmtHora = conOpciones({ hour: "2-digit", minute: "2-digit" });

/**
 * "2026-08-25" en hora de México.
 *
 * Úsalo en vez de `new Date().toISOString().slice(0, 10)`: con el proceso
 * en UTC, ese slice cambia de día a las 18:00 hora de México.
 */
export function hoyMX(fecha: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONA_MX,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(fecha);
}

/** Sello para nombres de archivo: "2026-08-25_14-05" en hora de México. */
export function selloArchivoMX(fecha: Date = new Date()): string {
  const hora = new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONA_MX,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(fecha);
  return `${hoyMX(fecha)}_${hora.replace(":", "-")}`;
}
