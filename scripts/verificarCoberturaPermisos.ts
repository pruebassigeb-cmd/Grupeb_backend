// scripts/verificarCoberturaPermisos.ts
//
// Escanea src/routes/**/*.routes.ts y reporta cualquier registro de ruta
// (router.get/post/put/patch/delete) que no tenga ningún guardián de
// autenticación (authMiddleware, checkPermiso, checkAnyPermiso, requireRole,
// requireAccessTotal, requireAdminOrSuperUser) — ni en la propia llamada, ni
// como router.use(...) previo en el mismo archivo.
//
// Es la prueba fail-closed de la fase 3 de roles y privilegios: sin esto, el
// siguiente endpoint que se agregue puede nacer abierto exactamente como
// nacieron los 9 que se cerraron en esa fase (ver
// GrupEB_Frontend/docs/roles-privilegios-plan.md §3.4).
//
// Es un análisis ESTÁTICO de texto, no un recorrido en vivo del árbol de
// Express: se intentó lo segundo primero (app._router), pero Express 5
// reescribió el router internamente con path-to-regexp v8 y closures sin
// propiedades introspectables (regexp queda capturado, no expuesto) — hacerlo
// en vivo requeriría depender de detalles internos no soportados que se
// rompen con cualquier actualización de Express. Analizar el código fuente es
// más simple, no depende de la versión, y de paso da archivo+línea, que es
// justo lo que hace falta para ir a corregir.
//
// No es una suite de pruebas formal (el repo no trae jest/vitest) — es un
// script de auditoría manual, igual que los demás en esta carpeta:
//
//   npx ts-node scripts/verificarCoberturaPermisos.ts
//
// Sale con código 1 si encuentra algo sin cubrir, para poder usarse también
// como paso de CI el día que este repo tenga uno.

import fs from "fs";
import path from "path";

const RAIZ_RUTAS = path.join(__dirname, "..", "src", "routes");

const GUARDAS = [
  "authMiddleware",
  "checkPermiso",
  "checkAnyPermiso",
  "requireRole",
  "requireAccessTotal",
  "requireAdminOrSuperUser",
];

const REGEX_GUARDA = new RegExp(`\\b(${GUARDAS.join("|")})\\b`);
const METODOS = ["get", "post", "put", "patch", "delete"];

// Excepciones: rutas conscientemente sin authMiddleware, con su propio
// mecanismo (ej. webhooks de terceros) o públicas por diseño. Formato:
// "archivo relativo a src/routes::patrón dentro de la llamada".
const EXCEPCIONES: { archivo: string; contiene: string; razon: string }[] = [
  { archivo: "auth/auth.routes.ts", contiene: '"/login"', razon: "login público por diseño" },
  { archivo: "auth/auth.routes.ts", contiene: '"/verificar-operador"', razon: "verificación propia (correo+código), no depende de sesión previa" },
  { archivo: "auth/auth.routes.ts", contiene: '"/logout"', razon: "debe poder limpiar la sesión incluso con un token vencido" },
  { archivo: "auth/auth.routes.ts", contiene: '"/verify"', razon: "es el propio endpoint que responde si hay sesión válida o no" },
  { archivo: "backup/backup.routes.ts", contiene: '"/automatico"', razon: "lo llama un cron externo — verificación propia por header x-cron-secret" },
  { archivo: "whatsapp/whatsapp.routes.ts", contiene: '"/webhook"', razon: "lo llama Meta, no un usuario — verificación propia por token de verify" },
];

// Quita comentarios // y /* */ sin tocar literales de cadena (para que un
// "router.get(...)" mencionado dentro de un comentario, como el que explica
// procesosPapel.routes.ts, no se cuente como un registro real). Conserva los
// saltos de línea que había dentro de comentarios de bloque para que los
// números de línea reportados sigan correspondiendo al archivo original.
function quitarComentarios(texto: string): string {
  return texto.replace(
    /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/.*|\/\*[\s\S]*?\*\//g,
    (m) => {
      if (m.startsWith("//")) return "";
      if (m.startsWith("/*")) return m.replace(/[^\n]/g, "");
      return m;
    }
  );
}

function archivosRoutes(dir: string): string[] {
  const resultado: string[] = [];
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entrada.name);
    if (entrada.isDirectory()) resultado.push(...archivosRoutes(full));
    else if (entrada.name.endsWith(".routes.ts")) resultado.push(full);
  }
  return resultado;
}

// Extrae llamadas router.<metodo>(...) completas, respetando paréntesis
// anidados (los argumentos suelen incluir arrow functions con sus propios
// paréntesis), para que una llamada multilínea no se corte a medias.
interface LlamadaRuta {
  metodo: string;
  textoCompleto: string;
  lineaInicio: number;
}

function extraerLlamadas(texto: string): LlamadaRuta[] {
  const llamadas: LlamadaRuta[] = [];
  const patronInicio = /router\.(get|post|put|patch|delete|use)\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = patronInicio.exec(texto))) {
    const metodo = m[1];
    let i = m.index + m[0].length;
    let profundidad = 1;
    const inicioArgs = i;
    while (i < texto.length && profundidad > 0) {
      if (texto[i] === "(") profundidad++;
      else if (texto[i] === ")") profundidad--;
      i++;
    }
    const textoCompleto = texto.slice(m.index, i);
    const lineaInicio = texto.slice(0, m.index).split("\n").length;
    llamadas.push({ metodo, textoCompleto, lineaInicio });
  }
  return llamadas;
}

interface RutaSinGuarda {
  archivo: string;
  linea: number;
  metodo: string;
  extracto: string;
}

const sinGuarda: RutaSinGuarda[] = [];
let totalRevisadas = 0;

for (const archivo of archivosRoutes(RAIZ_RUTAS)) {
  const relativo = path.relative(RAIZ_RUTAS, archivo).replace(/\\/g, "/");
  const texto = quitarComentarios(fs.readFileSync(archivo, "utf-8"));
  const llamadas = extraerLlamadas(texto);

  // router.use(authMiddleware) (u otra guarda) antes de cualquier ruta cubre
  // TODO lo que venga después en el archivo — patrón usado en proveedores.routes.ts.
  const usaGuardaGlobal = llamadas.some(
    (l) => l.metodo === "use" && REGEX_GUARDA.test(l.textoCompleto)
  );

  for (const llamada of llamadas) {
    if (!METODOS.includes(llamada.metodo)) continue;
    totalRevisadas++;

    const tieneGuardaPropia = REGEX_GUARDA.test(llamada.textoCompleto);
    if (tieneGuardaPropia || usaGuardaGlobal) continue;

    const esExcepcion = EXCEPCIONES.some(
      (e) => e.archivo === relativo && llamada.textoCompleto.includes(e.contiene)
    );
    if (esExcepcion) continue;

    sinGuarda.push({
      archivo: relativo,
      linea: llamada.lineaInicio,
      metodo: llamada.metodo.toUpperCase(),
      extracto: llamada.textoCompleto.split("\n")[0].slice(0, 80),
    });
  }
}

if (sinGuarda.length === 0) {
  console.log(`✅ ${totalRevisadas} registros de ruta revisados en ${RAIZ_RUTAS} — todos tienen un guardián de autenticación (o excepción declarada).`);
  process.exit(0);
} else {
  console.error(`🚫 ${sinGuarda.length} ruta(s) sin ningún guardián de autenticación:\n`);
  for (const r of sinGuarda) {
    console.error(`   ${r.archivo}:${r.linea}  [${r.metodo}]  ${r.extracto}...`);
  }
  console.error(
    "\nAgrega authMiddleware (mínimo) o checkPermiso/checkAnyPermiso a cada una, " +
    "o si es intencional, agrégala a EXCEPCIONES en este script con el motivo."
  );
  process.exit(1);
}
