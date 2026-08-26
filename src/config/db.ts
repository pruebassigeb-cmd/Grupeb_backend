import { Pool, types } from "pg";
import dotenv from "dotenv";

dotenv.config();

/* ──────────────────────────────────────────────────────────────────────
 * Zona horaria — regla de la casa
 *
 * Todo viaja en UTC entre Postgres y Node. La conversión a hora de
 * México ocurre en un solo lugar: al momento de mostrar el dato
 * (fmtFechaHora en el front, utils/fecha.ts en el back).
 *
 * Antes esto no estaba fijado en ningún lado, así que el resultado
 * dependía del entorno: en local Postgres y Node corrían en
 * America/Mexico_City, y en Render los dos en UTC. Las mismas filas se
 * leían con 6 horas de diferencia según dónde estuviera corriendo el
 * servidor, y por eso el desfase solo aparecía en producción.
 * ────────────────────────────────────────────────────────────────────── */

// OID 1114 = "timestamp without time zone".
// El parser de fábrica arma el Date con el TZ del proceso Node, o sea que
// el mismo string daba instantes distintos en local y en Render. Como la
// sesión de Postgres queda clavada en UTC (ver `options` abajo), lo que se
// guarda ES hora UTC — la leemos como tal, sin depender del TZ del proceso.
const parseTimestampNaive = types.getTypeParser(types.builtins.TIMESTAMP);
types.setTypeParser(types.builtins.TIMESTAMP, (valor: string) => {
  const fecha = new Date(valor.replace(" ", "T") + "Z");
  // 'infinity', '-infinity' y fechas BC no son ISO: que las resuelva pg.
  return Number.isNaN(fecha.getTime()) ? parseTimestampNaive(valor) : fecha;
});

// OID 1082 = "date".
// Una fecha sin hora no es un instante. pg la convertía a un Date a
// medianoche local que, al serializarse a JSON, le llegaba al navegador
// como el día ANTERIOR. Se queda como texto plano "YYYY-MM-DD".
types.setTypeParser(types.builtins.DATE, (valor: string) => valor);

// OID 1184 = "timestamptz": el parser de fábrica ya devuelve el instante
// correcto porque el string trae offset. No se toca.

export const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT),

  // Va en el paquete de arranque de la conexión: aplica desde el primer
  // query, sin ventana de carrera.
  options: "-c client_encoding=UTF8 -c timezone=UTC",
});

pool.on("connect", (client) => {
  // Red de seguridad: si algún pooler intermedio ignora `options`, esto
  // se encola antes que cualquier query de la aplicación.
  client.query("SET client_encoding TO 'UTF8'; SET TIME ZONE 'UTC';");
});
