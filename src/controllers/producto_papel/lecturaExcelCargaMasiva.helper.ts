// src/controllers/producto_papel/lecturaExcelCargaMasiva.helper.ts
//
// Lee el .xlsx subido (hojas "Productos" y "OpcionesPapel") y lo convierte
// en una lista de "ProductoCrudo" — un objeto plano por producto, listo
// para pasar al resolver de catálogos + INSERTs.
//
// No toca la base de datos. Solo parsea el archivo.

import * as XLSX from "xlsx";

export interface OpcionPapelCruda {
  orden_opcion: number;    // varias filas con el mismo orden_opcion = mismo grupo_papel (misma "Opción")
  orden_material: number;  // distingue cada material DENTRO de esa misma opción
  precio_sugerido: number | null;
  tipo_papel: string;
  calibre: string | null; // ya viene armado ("14pts") a partir de calibre_numero + calibre_unidad
  pliego: string | null;
  rendimiento: string | null;
  corte_material: string | null;
  hoj_bobina: string | null;
  hoj_bobina_extra: string | null;
  hoj_corte: string | null;
  hoj_rendimiento: string | null;
  hoj_guillotina: string | null;
  hoj_hilo: string | null;
}

export interface ProductoCrudo {
  fila: number; // fila original en el Excel, para reportar errores
  producto_id: string;
  tipo_producto: string;
  descripcion_papel: string | null;
  ancho: number | null;
  fuelle: number | null;
  altura: number | null;
  medida: string | null;

  suaje_numero: string | null;
  suaje_pzs: number | null;
  suaje_tamano: string | null;
  corte: string | null;          // armado automáticamente como `${numero}"`
  corte_altura_mm: string | null;
  corte_puntos: string | null;
  doble: string | null;          // armado automáticamente como `${numero}"`
  doble_altura_mm: string | null;
  doble_puntos: string | null;
  metros: string | null;
  matrix: string | null;
  tiempo_arreglo_min: number | null;
  sacabocado_medida: string | null; // armado automáticamente como `${numero} mm`
  sacabocado_cantidad: number | null;
  perforado_medida: string | null;  // armado automáticamente como `${largo}x${ancho} mm`
  perforado_cantidad: number | null;
  herramental_desbarbe: boolean;
  no_desbarbe: string | null;

  tipo_pegado: string | null;
  pegamento: string | null;
  asas: string | null;          // texto crudo separado por coma
  laminados: string | null;     // texto crudo separado por coma

  refuerzo_material: string | null;
  refuerzo_medida: string | null;
  base_material: string | null;
  base_medida: string | null;

  empaque: string | null;
  piezas_por_caja: number | null;

  tintas_frente: number | null;
  tintas_dentro: number | null;

  maq_hojeado_guillotina: string | null;
  maq_impresora: string | null;
  maq_hs_ar: string | null;
  maq_suaje: string | null;
  maq_uv: string | null;
  maq_textura: string | null;
  maq_empalme: string | null;
  maq_armado: string | null;
  maq_asas_maquina: string | null;
  maq_desbarbe: string | null;

  opciones: OpcionPapelCruda[];
}

export interface ErrorLectura {
  hoja: string;
  fila: number;
  mensaje: string;
}

function str(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function bool(v: any): boolean {
  if (v === null || v === undefined) return false;
  const s = String(v).trim().toUpperCase();
  return s === "SI" || s === "SÍ" || s === "TRUE" || s === "1" || s === "X";
}

// ── Armado automático de campos con unidad ──────────────────────────────
// El Excel solo pide el número (y, para calibre, la unidad vía dropdown);
// aquí se construye el string final exactamente en el formato que ya
// usan los dropdowns del formulario original (ej. "14pts", "3 mm", "0.937\"").

function armarCalibre(numero: any, unidad: any): string | null {
  const n = str(numero);
  const u = str(unidad);
  if (!n) return null;
  return `${n}${u ?? "pts"}`; // si no eligieron unidad, pts como default razonable
}

function armarConSufijoFijo(numero: any, sufijo: string): string | null {
  const n = str(numero);
  if (!n) return null;
  return `${n}${sufijo}`;
}

function armarPerforado(largo: any, ancho: any): string | null {
  const l = str(largo);
  const a = str(ancho);
  if (!l && !a) return null;
  if (l && a) return `${l}x${a} mm`;
  return `${l ?? a} mm`; // si solo viene uno, lo usamos igual para ambos lados implícitamente
}

export function leerExcelCargaMasiva(buffer: Buffer): {
  productos: ProductoCrudo[];
  errores: ErrorLectura[];
} {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const errores: ErrorLectura[] = [];

  const hojaProductos = wb.Sheets["Productos"];
  const hojaOpciones = wb.Sheets["OpcionesPapel"];

  if (!hojaProductos) {
    errores.push({ hoja: "Productos", fila: 0, mensaje: "No se encontró la hoja 'Productos' en el archivo." });
    return { productos: [], errores };
  }

  const filasProductos: any[] = XLSX.utils.sheet_to_json(hojaProductos, { defval: null });
  const filasOpciones: any[] = hojaOpciones
    ? XLSX.utils.sheet_to_json(hojaOpciones, { defval: null })
    : [];

  // Agrupar opciones por producto_id
  const opcionesPorProducto: Record<string, OpcionPapelCruda[]> = {};
  filasOpciones.forEach((row, idx) => {
    const pid = str(row.producto_id);
    if (!pid) {
      errores.push({ hoja: "OpcionesPapel", fila: idx + 2, mensaje: "producto_id vacío — esta fila no se relacionará con ningún producto." });
      return;
    }
    if (!str(row.tipo_papel)) {
      errores.push({ hoja: "OpcionesPapel", fila: idx + 2, mensaje: `producto_id "${pid}": tipo_papel es obligatorio, fila omitida.` });
      return;
    }
    if (!opcionesPorProducto[pid]) opcionesPorProducto[pid] = [];
    opcionesPorProducto[pid].push({
      orden_opcion: num(row.orden_opcion) ?? 1,
      orden_material: num(row.orden_material) ?? 1,
      precio_sugerido: num(row.precio_sugerido),
      tipo_papel: str(row.tipo_papel)!,
      calibre: armarCalibre(row.calibre_numero, row.calibre_unidad),
      pliego: str(row.pliego),
      rendimiento: str(row.rendimiento),
      corte_material: str(row.corte_material),
      hoj_bobina: str(row.hoj_bobina),
      hoj_bobina_extra: str(row.hoj_bobina_extra),
      hoj_corte: str(row.hoj_corte),
      hoj_rendimiento: str(row.hoj_rendimiento),
      hoj_guillotina: str(row.hoj_guillotina),
      hoj_hilo: str(row.hoj_hilo),
    });
  });

  const idsVistos = new Set<string>();
  const productos: ProductoCrudo[] = [];

  filasProductos.forEach((row, idx) => {
    const filaExcel = idx + 2; // +1 por header, +1 porque sheet_to_json es 0-indexed
    const producto_id = str(row.producto_id);

    if (!producto_id) {
      errores.push({ hoja: "Productos", fila: filaExcel, mensaje: "producto_id vacío — fila omitida." });
      return;
    }
    if (idsVistos.has(producto_id)) {
      errores.push({ hoja: "Productos", fila: filaExcel, mensaje: `producto_id "${producto_id}" duplicado — fila omitida.` });
      return;
    }
    idsVistos.add(producto_id);

    if (!str(row.tipo_producto)) {
      errores.push({ hoja: "Productos", fila: filaExcel, mensaje: `producto_id "${producto_id}": tipo_producto es obligatorio — fila omitida.` });
      return;
    }

    productos.push({
      fila: filaExcel,
      producto_id,
      tipo_producto: str(row.tipo_producto)!,
      descripcion_papel: str(row.descripcion_papel),
      ancho: num(row.ancho),
      fuelle: num(row.fuelle),
      altura: num(row.altura),
      medida: str(row.medida),

      suaje_numero: str(row.suaje_numero),
      suaje_pzs: num(row.suaje_pzs),
      suaje_tamano: str(row.suaje_tamano),
      corte: armarConSufijoFijo(row.corte_numero, '"'),
      corte_altura_mm: str(row.corte_altura_mm),
      corte_puntos: str(row.corte_puntos),
      doble: armarConSufijoFijo(row.doble_numero, '"'),
      doble_altura_mm: str(row.doble_altura_mm),
      doble_puntos: str(row.doble_puntos),
      metros: str(row.metros),
      matrix: str(row.matrix),
      tiempo_arreglo_min: num(row.tiempo_arreglo_min),
      sacabocado_medida: armarConSufijoFijo(row.sacabocado_numero, " mm"),
      sacabocado_cantidad: num(row.sacabocado_cantidad),
      perforado_medida: armarPerforado(row.perforado_largo, row.perforado_ancho),
      perforado_cantidad: num(row.perforado_cantidad),
      herramental_desbarbe: bool(row.herramental_desbarbe),
      no_desbarbe: str(row.no_desbarbe),

      tipo_pegado: str(row.tipo_pegado),
      pegamento: str(row.pegamento),
      asas: str(row.asas),
      laminados: str(row.laminados),

      refuerzo_material: str(row.refuerzo_material),
      refuerzo_medida: str(row.refuerzo_medida),
      base_material: str(row.base_material),
      base_medida: str(row.base_medida),

      empaque: str(row.empaque),
      piezas_por_caja: num(row.piezas_por_caja),

      tintas_frente: num(row.tintas_frente),
      tintas_dentro: num(row.tintas_dentro),

      maq_hojeado_guillotina: str(row.maq_hojeado_guillotina),
      maq_impresora: str(row.maq_impresora),
      maq_hs_ar: str(row.maq_hs_ar),
      maq_suaje: str(row.maq_suaje),
      maq_uv: str(row.maq_uv),
      maq_textura: str(row.maq_textura),
      maq_empalme: str(row.maq_empalme),
      maq_armado: str(row.maq_armado),
      maq_asas_maquina: str(row.maq_asas_maquina),
      maq_desbarbe: str(row.maq_desbarbe),

      opciones: opcionesPorProducto[producto_id] ?? [],
    });
  });

  return { productos, errores };
}