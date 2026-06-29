// scripts/generarPlantillaCargaMasiva.ts
//
// Genera la plantilla de carga masiva de productos de papel CON DROPDOWNS
// reales, leídos directo de tu base de datos.
//
// Uso:
//   npx ts-node scripts/generarPlantillaCargaMasiva.ts
//   (o agrega un script en package.json, ver abajo)
//
// Salida: ./plantilla_carga_masiva_papel_SIN_MACRO.xlsx (en la raíz del proyecto)
//
// IMPORTANTE: este script usa ExcelJS, que NO puede escribir ni preservar
// macros VBA — solo genera .xlsx puro. El nombre de salida lo deja explícito
// a propósito ("SIN_MACRO") para que no se confunda con el archivo final
// que sí tiene la macro. El paso de pegar la macro y guardar como .xlsm
// se hace A MANO en Excel, una vez, siguiendo scripts/macro_multiseleccion.vba.
// Después de eso, usa siempre el .xlsm resultante — no este .xlsx.
//
// Los dropdowns son SUGERENCIA, no candado: Excel permite escribir
// cualquier texto aunque no esté en la lista (por si necesitas un valor
// nuevo que el sistema creará automáticamente al cargar).

import ExcelJS from "exceljs";
import { pool } from "../src/config/db";

// ════════════════════════════════════════════════════════════════════════
// 1. Definición de qué catálogo alimenta cada columna del Excel
// ════════════════════════════════════════════════════════════════════════

interface FuenteCatalogo {
  // Hoja y columna del Excel donde va el dropdown
  hoja: "Productos" | "OpcionesPapel";
  columna: string; // nombre de la columna (debe existir en el header)
  // Query para traer los valores. Debe devolver una sola columna llamada `valor`.
  query: string;
  // Nombre de la lista en la hoja oculta (debe ser único)
  nombreLista: string;
}

const FUENTES: FuenteCatalogo[] = [
  { hoja: "Productos", columna: "tipo_producto", nombreLista: "TipoProducto",
    query: `SELECT nombre AS valor FROM cat_tipo_producto_papel WHERE activo = true ORDER BY nombre` },
  { hoja: "Productos", columna: "matrix", nombreLista: "Matrix",
    query: `SELECT medida_matrix AS valor FROM matrix WHERE activo = true ORDER BY medida_matrix` },
  { hoja: "Productos", columna: "tipo_pegado", nombreLista: "TipoPegado",
    query: `SELECT nombre AS valor FROM cat_tipo_pegado WHERE activo = true ORDER BY nombre` },
  { hoja: "Productos", columna: "pegamento", nombreLista: "Pegamento",
    query: `SELECT nombre AS valor FROM cat_pegamento WHERE activo = true ORDER BY nombre` },
  { hoja: "Productos", columna: "refuerzo_material", nombreLista: "RefuerzoMaterial",
    query: `SELECT nombre AS valor FROM cat_refuerzo_material WHERE activo = true ORDER BY nombre` },
  { hoja: "Productos", columna: "base_material", nombreLista: "RefuerzoMaterial", // mismo catálogo que refuerzo
    query: `SELECT nombre AS valor FROM cat_refuerzo_material WHERE activo = true ORDER BY nombre` },
  { hoja: "Productos", columna: "refuerzo_medida", nombreLista: "RefuerzoMedidas",
    query: `SELECT nombre AS valor FROM cat_refuerzo_medidas WHERE activo = true ORDER BY nombre` },
  { hoja: "Productos", columna: "empaque", nombreLista: "Empaque",
    query: `SELECT nombre AS valor FROM cat_empaque WHERE activo = true ORDER BY nombre` },

  // Multi-select (coma) — el dropdown ayuda a escribir UN valor a la vez;
  // si necesitan varios, lo siguen separando por coma manualmente.
  { hoja: "Productos", columna: "asas", nombreLista: "TipoAsa",
    query: `SELECT nombre AS valor FROM cat_tipo_asa WHERE activo = true ORDER BY nombre` },
  { hoja: "Productos", columna: "laminados", nombreLista: "Laminado",
    query: `SELECT nombre AS valor FROM cat_laminado WHERE activo = true ORDER BY nombre` },
  { hoja: "Productos", columna: "maq_hojeado_guillotina", nombreLista: "MaqHojeadoGuillotina",
    query: `SELECT nombre AS valor FROM cat_hojeado_guillotina WHERE activo = true ORDER BY nombre` },
  { hoja: "Productos", columna: "maq_impresora", nombreLista: "MaqImpresora",
    query: `SELECT nombre AS valor FROM cat_impresora WHERE activo = true ORDER BY nombre` },
  { hoja: "Productos", columna: "maq_hs_ar", nombreLista: "MaqHsAr",
    query: `SELECT nombre AS valor FROM cat_hs_ar WHERE activo = true ORDER BY nombre` },
  { hoja: "Productos", columna: "maq_suaje", nombreLista: "MaqSuaje",
    query: `SELECT nombre AS valor FROM cat_suaje_maquina WHERE activo = true ORDER BY nombre` },
  { hoja: "Productos", columna: "maq_uv", nombreLista: "MaqUv",
    query: `SELECT nombre AS valor FROM cat_uv WHERE activo = true ORDER BY nombre` },
  { hoja: "Productos", columna: "maq_empalme", nombreLista: "MaqEmpalme",
    query: `SELECT nombre AS valor FROM cat_empalme WHERE activo = true ORDER BY nombre` },
  { hoja: "Productos", columna: "maq_armado", nombreLista: "MaqArmado",
    query: `SELECT nombre AS valor FROM cat_armado WHERE activo = true ORDER BY nombre` },
  { hoja: "Productos", columna: "maq_asas_maquina", nombreLista: "MaqAsasMaquina",
    query: `SELECT nombre AS valor FROM cat_asas_maquina WHERE activo = true ORDER BY nombre` },
  { hoja: "Productos", columna: "maq_desbarbe", nombreLista: "MaqDesbarbe",
    query: `SELECT nombre AS valor FROM cat_desbarbe WHERE activo = true ORDER BY nombre` },
  // ── Agregadas: el frontend ahora tiene 12 categorías de maquinaria, no 10 ──
  { hoja: "Productos", columna: "maq_laminado_maquina", nombreLista: "MaqLaminadoMaquina",
    query: `SELECT nombre AS valor FROM cat_laminado_maquina WHERE activo = true ORDER BY nombre` },
  { hoja: "Productos", columna: "maq_texturizadora", nombreLista: "MaqTexturizadora",
    query: `SELECT nombre AS valor FROM cat_texturizadora WHERE activo = true ORDER BY nombre` },
  { hoja: "Productos", columna: "maq_empaque_maquina", nombreLista: "MaqEmpaqueMaquina",
    query: `SELECT nombre AS valor FROM cat_empaque_maquina WHERE activo = true ORDER BY nombre` },

  // Hoja OpcionesPapel
  { hoja: "OpcionesPapel", columna: "tipo_papel", nombreLista: "TipoPapel",
    query: `SELECT nombre AS valor FROM cat_tipo_papel WHERE activo = true ORDER BY nombre` },
];

// herramental_desbarbe es un caso especial: lista fija SI/NO, no viene de la BD
const LISTA_SI_NO = ["SI", "NO"];

// calibre_unidad: lista fija (pts/gms/ect) — son las 3 únicas unidades que
// se ven en cat_calibre.nombre (ej. "14pts", "180gms", "24ect"), no
// necesitan venir de la BD porque es un conjunto cerrado y estable.
const LISTA_UNIDAD_CALIBRE = ["pts", "gms", "ect"];

// ════════════════════════════════════════════════════════════════════════
// 2. Definición de columnas (igual que la plantilla original)
// ════════════════════════════════════════════════════════════════════════

const FILL_REQ   = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFCE4D6" } };
const FILL_OPT    = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFD9E1F2" } };
const FILL_KEY    = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFC6E0B4" } };
const FILL_MULTI  = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFF2CC" } };

const COLS_PRODUCTOS: [string, any, number][] = [
  ["producto_id", FILL_KEY, 14], ["tipo_producto", FILL_REQ, 22], ["descripcion_papel", FILL_OPT, 26],
  ["ancho", FILL_OPT, 10], ["fuelle", FILL_OPT, 10], ["altura", FILL_OPT, 10], ["medida", FILL_OPT, 14],
  ["suaje_numero", FILL_OPT, 14], ["suaje_pzs", FILL_OPT, 10], ["suaje_tamano", FILL_OPT, 14],
  ["corte_numero", FILL_OPT, 14], ["corte_altura_mm", FILL_OPT, 14], ["corte_puntos", FILL_OPT, 12],
  ["doble_numero", FILL_OPT, 14], ["doble_altura_mm", FILL_OPT, 14], ["doble_puntos", FILL_OPT, 12],
  ["metros", FILL_OPT, 10], ["matrix", FILL_OPT, 14], ["tiempo_arreglo_min", FILL_OPT, 16],
  ["sacabocado_numero", FILL_OPT, 16], ["sacabocado_cantidad", FILL_OPT, 16],
  ["perforado_largo", FILL_OPT, 14], ["perforado_ancho", FILL_OPT, 14], ["perforado_cantidad", FILL_OPT, 16],
  ["herramental_desbarbe", FILL_OPT, 18], ["no_desbarbe", FILL_OPT, 14],
  ["tipo_pegado", FILL_OPT, 16], ["pegamento", FILL_OPT, 16],
  ["asas", FILL_MULTI, 26], ["laminados", FILL_MULTI, 26],
  ["refuerzo_material", FILL_OPT, 18], ["refuerzo_medida", FILL_OPT, 16],
  ["base_material", FILL_OPT, 16], ["base_medida", FILL_OPT, 14],
  ["empaque", FILL_OPT, 16], ["piezas_por_caja", FILL_OPT, 14],
  ["tintas_frente", FILL_OPT, 14], ["tintas_dentro", FILL_OPT, 14],
  ["maq_hojeado_guillotina", FILL_MULTI, 22], ["maq_impresora", FILL_MULTI, 18],
  ["maq_hs_ar", FILL_MULTI, 16], ["maq_suaje", FILL_MULTI, 16], ["maq_uv", FILL_MULTI, 14],
  ["maq_empalme", FILL_MULTI, 16], ["maq_armado", FILL_MULTI, 16],
  ["maq_asas_maquina", FILL_MULTI, 18], ["maq_desbarbe", FILL_MULTI, 16],
  ["maq_laminado_maquina", FILL_MULTI, 20], ["maq_texturizadora", FILL_MULTI, 20], ["maq_empaque_maquina", FILL_MULTI, 20],
];

const COLS_OPCIONES: [string, any, number][] = [
  ["producto_id", FILL_KEY, 14], ["orden_opcion", FILL_REQ, 12], ["orden_material", FILL_REQ, 14],
  ["precio_sugerido", FILL_OPT, 16],
  ["tipo_papel", FILL_REQ, 20], ["calibre_numero", FILL_OPT, 14], ["calibre_unidad", FILL_OPT, 14],
  ["pliego", FILL_OPT, 14],
  ["rendimiento", FILL_OPT, 14], ["corte_material", FILL_OPT, 14], ["hoj_bobina", FILL_OPT, 14],
  ["hoj_bobina_extra", FILL_OPT, 14],
  ["hoj_corte", FILL_OPT, 14], ["hoj_rendimiento", FILL_OPT, 16], ["hoj_guillotina", FILL_OPT, 14],
  ["hoj_hilo", FILL_OPT, 12],
];

function colLetra(col: number): string {
  let letra = "";
  while (col > 0) {
    const mod = (col - 1) % 26;
    letra = String.fromCharCode(65 + mod) + letra;
    col = Math.floor((col - mod) / 26);
  }
  return letra;
}

async function main() {
  console.log("📡 Conectando a la base de datos...");

  const wb = new ExcelJS.Workbook();

  // ── Hoja Instrucciones ──────────────────────────────────────────────
  const wsInfo = wb.addWorksheet("Instrucciones");
  wsInfo.getColumn(1).width = 6;
  wsInfo.getColumn(2).width = 95;
  wsInfo.getCell("A1").value = "📦 PLANTILLA DE CARGA MASIVA — PRODUCTOS DE PAPEL (con catálogos en vivo)";
  wsInfo.getCell("A1").font = { bold: true, size: 14 };
  const filasInfo: [string, string][] = [
    ["", ""],
    ["CÓMO FUNCIONA", ""],
    ["1.", "Llena la hoja 'Productos' — una fila por cada producto de papel."],
    ["2.", "producto_id es OBLIGATORIO y ÚNICO (ej: PROD-001, PROD-002...)."],
    ["3.", "Llena 'OpcionesPapel' para las opciones de TIPO DE PAPEL — un producto_id puede repetirse en varias filas."],
    ["", "   orden_opcion: número de la Opción (1, 2, 3...) — varias opciones = varios precios sugeridos posibles."],
    ["", "   orden_material: si UNA misma opción lleva más de un material (ej. Kraft + Cartulina juntos en la"],
    ["", "   Opción 1), repite el mismo orden_opcion y usa orden_material 1, 2, 3... para cada material."],
    ["4.", "Las columnas amarillas y azules con flechita (▼) tienen una lista de valores ya registrados — haz clic"],
    ["", "   y elige uno, o si necesitas un valor nuevo, simplemente escríbelo (no es obligatorio elegir de la lista)."],
    ["5.", "Para Asa, Laminado y Maquinaria: si necesitas más de un valor, sepáralos por coma (o usa el dropdown"],
    ["", "   con la macro de selección múltiple instalada, que los agrega automáticamente)."],
    ["6.", "Medidas con unidad fija (sacabocado, perforado, corte, doble) — solo escribe el NÚMERO, el sistema"],
    ["", "   agrega la unidad sola: sacabocado_numero=3 → \"3 mm\" | corte_numero=0.937 → 0.937\" | etc."],
    ["7.", "Calibre es la única medida con unidad VARIABLE: escribe el número en calibre_numero y elige"],
    ["", "   la unidad (pts/gms/ect) en calibre_unidad — el sistema los junta como \"14pts\"."],
    ["8.", "Esta plantilla se generó conectada a tu base de datos el día indicado abajo — los catálogos pueden"],
    ["", "   haber cambiado desde entonces. Si necesitas la lista más actualizada, vuelve a correr el script."],
    ["", ""],
    [`Generado: ${new Date().toLocaleString("es-MX")}`, ""],
  ];
  let r = 2;
  for (const [a, b] of filasInfo) {
    wsInfo.getCell(`A${r}`).value = a;
    wsInfo.getCell(`B${r}`).value = b;
    if (a.toUpperCase() === a && b === "" && a !== "") {
      wsInfo.getCell(`A${r}`).font = { bold: true, size: 11, color: { argb: "FF1F4E78" } };
    }
    r++;
  }

  // ── Hoja Productos ──────────────────────────────────────────────────
  const wsProd = wb.addWorksheet("Productos");
  COLS_PRODUCTOS.forEach(([name, fill, width], i) => {
    const cell = wsProd.getCell(1, i + 1);
    cell.value = name;
    cell.font = { bold: true, size: 10 };
    cell.fill = fill;
    cell.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
    wsProd.getColumn(i + 1).width = width;
  });
  wsProd.getRow(1).height = 32;
  wsProd.views = [{ state: "frozen", ySplit: 1, xSplit: 1 }];

  // ── Hoja OpcionesPapel ───────────────────────────────────────────────
  const wsOp = wb.addWorksheet("OpcionesPapel");
  COLS_OPCIONES.forEach(([name, fill, width], i) => {
    const cell = wsOp.getCell(1, i + 1);
    cell.value = name;
    cell.font = { bold: true, size: 10 };
    cell.fill = fill;
    cell.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
    wsOp.getColumn(i + 1).width = width;
  });
  wsOp.getRow(1).height = 32;
  wsOp.views = [{ state: "frozen", ySplit: 1, xSplit: 1 }];

  // ── Hoja oculta de listas (named ranges) ─────────────────────────────
  const wsListas = wb.addWorksheet("ListasCatalogos");
  wsListas.state = "veryHidden"; // oculta incluso desde "Mostrar hojas ocultas"

  let colListas = 1;
  const rangosPorLista: Record<string, string> = {};

  console.log("📥 Leyendo catálogos...");
  for (const fuente of FUENTES) {
    // evitar volver a consultar/escribir la misma lista 2 veces (ej. base_material == refuerzo_material)
    if (rangosPorLista[fuente.nombreLista]) continue;

    const { rows } = await pool.query(fuente.query);
    const valores: string[] = rows.map((r: any) => r.valor).filter((v: any) => v != null && v !== "");

    if (valores.length === 0) {
      console.log(`   ⚠️  ${fuente.nombreLista}: sin valores registrados (se omite dropdown)`);
      continue;
    }

    const letra = colLetra(colListas);
    wsListas.getCell(`${letra}1`).value = fuente.nombreLista;
    valores.forEach((v, idx) => {
      wsListas.getCell(`${letra}${idx + 2}`).value = v;
    });

    const rango = `ListasCatalogos!$${letra}$2:$${letra}$${valores.length + 1}`;
    rangosPorLista[fuente.nombreLista] = rango;
    console.log(`   ✓ ${fuente.nombreLista}: ${valores.length} valores`);
    colListas++;
  }

  // Lista fija SI/NO para herramental_desbarbe
  {
    const letra = colLetra(colListas);
    wsListas.getCell(`${letra}1`).value = "SiNo";
    LISTA_SI_NO.forEach((v, idx) => wsListas.getCell(`${letra}${idx + 2}`).value = v);
    rangosPorLista["SiNo"] = `ListasCatalogos!$${letra}$2:$${letra}$${LISTA_SI_NO.length + 1}`;
    colListas++;
  }

  // Lista fija pts/gms/ect para calibre_unidad
  {
    const letra = colLetra(colListas);
    wsListas.getCell(`${letra}1`).value = "UnidadCalibre";
    LISTA_UNIDAD_CALIBRE.forEach((v, idx) => wsListas.getCell(`${letra}${idx + 2}`).value = v);
    rangosPorLista["UnidadCalibre"] = `ListasCatalogos!$${letra}$2:$${letra}$${LISTA_UNIDAD_CALIBRE.length + 1}`;
    colListas++;
  }

  // ── Aplicar Data Validation en las hojas reales ──────────────────────
  const MAX_FILAS = 500; // filas con dropdown disponible (ajusta si necesitas más)

  function aplicarValidacion(hoja: ExcelJS.Worksheet, columnas: [string, any, number][], columnaNombre: string, rango: string) {
    const idx = columnas.findIndex(c => c[0] === columnaNombre);
    if (idx === -1) return;
    const letra = colLetra(idx + 1);
    for (let fila = 2; fila <= MAX_FILAS + 1; fila++) {
      hoja.getCell(`${letra}${fila}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [rango],
        showErrorMessage: false, // NO bloquea — permite escribir cualquier valor
      };
    }
  }

  for (const fuente of FUENTES) {
    const rango = rangosPorLista[fuente.nombreLista];
    if (!rango) continue;
    const hoja = fuente.hoja === "Productos" ? wsProd : wsOp;
    const cols = fuente.hoja === "Productos" ? COLS_PRODUCTOS : COLS_OPCIONES;
    aplicarValidacion(hoja, cols, fuente.columna, rango);
  }
  aplicarValidacion(wsProd, COLS_PRODUCTOS, "herramental_desbarbe", rangosPorLista["SiNo"]);
  aplicarValidacion(wsOp, COLS_OPCIONES, "calibre_unidad", rangosPorLista["UnidadCalibre"]);

  const outPath = "./plantilla_carga_masiva_papel_SIN_MACRO.xlsx";
  await wb.xlsx.writeFile(outPath);
  console.log(`\n✅ Plantilla generada: ${outPath}`);
  console.log(`   ⚠️  Este archivo NO tiene la macro de selección múltiple todavía.`);
  console.log(`   Sigue las instrucciones de scripts/macro_multiseleccion.vba para`);
  console.log(`   pegarla y guardar como .xlsm — solo se hace una vez por archivo.`);

  await pool.end();
}

main().catch(err => {
  console.error("❌ Error generando la plantilla:", err);
  process.exit(1);
});