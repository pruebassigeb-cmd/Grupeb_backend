import { iniciarTxUsuario } from "../../middlewares/auditoria";
// src/controllers/producto_papel/carga_masiva_papel.controller.ts
//
// POST /productos-papel/carga-masiva
// Recibe un .xlsx (multipart/form-data, campo "archivo"), lo procesa
// fila por fila DENTRO DE TRANSACCIONES INDEPENDIENTES POR PRODUCTO:
// si el producto X falla, no se cae toda la carga — se reporta el error
// de esa fila y se sigue con las demás.
//
// Devuelve un resumen: cuántos se crearon, lista de errores por fila,
// y catálogos nuevos creados durante el proceso.

import { Request, Response } from "express";
import { pool } from "../../config/db";
import type { MulterFile } from "../../config/multer";
import { leerExcelCargaMasiva, ProductoCrudo } from "./lecturaExcelCargaMasiva.helper";
import {
  nuevoReporte,
  resolverCatalogoSimple,
  resolverCatalogoMaquina,
  resolverCalibre,
  resolverPorMedida,
  resolverCorteDoble,
  resolverPuntos,
  resolverMatrix,
  resolverListaCatalogoSimple,
  reporteAFilas,
  ReporteCatalogos,
} from "./catalogoPapel.helper";

type RequestConArchivo = Request & { file?: MulterFile };

interface ResultadoFila {
  fila: number;
  producto_id: string;
  estado: "creado" | "error";
  idproducto_papel?: number;
  error?: string;
}

// Mapa de las 10 tablas de maquinaria — igual que MAQ_PIVOTS en tu controller original
const MAQ_TABLAS: Record<string, { tabla: string; pk: string; pivot: string; pivotCol: string }> = {
  maq_hojeado_guillotina: { tabla: "cat_hojeado_guillotina", pk: "idcat_hojeado_guillotina", pivot: "maquinaria_hojeado_guillotina", pivotCol: "idcat_hojeado_guillotina" },
  maq_impresora:          { tabla: "cat_impresora",          pk: "idcat_impresora",          pivot: "maquinaria_impresora",          pivotCol: "idcat_impresora" },
  maq_hs_ar:               { tabla: "cat_hs_ar",               pk: "idcat_hs_ar",               pivot: "maquinaria_hs_ar",               pivotCol: "idcat_hs_ar" },
  maq_suaje:               { tabla: "cat_suaje_maquina",       pk: "idcat_suaje_maquina",       pivot: "maquinaria_suaje_maquina",       pivotCol: "idcat_suaje_maquina" },
  maq_uv:                  { tabla: "cat_uv",                  pk: "idcat_uv",                  pivot: "maquinaria_uv",                  pivotCol: "idcat_uv" },
  maq_empalme:             { tabla: "cat_empalme",               pk: "idcat_empalme",             pivot: "maquinaria_empalme",             pivotCol: "idcat_empalme" },
  maq_armado:              { tabla: "cat_armado",                pk: "idcat_armado",              pivot: "maquinaria_armado",              pivotCol: "idcat_armado" },
  maq_asas_maquina:        { tabla: "cat_asas_maquina",          pk: "idcat_asas_maquina",        pivot: "maquinaria_asas_maquina",        pivotCol: "idcat_asas_maquina" },
  maq_desbarbe:            { tabla: "cat_desbarbe",              pk: "idcat_desbarbe",            pivot: "maquinaria_desbarbe",            pivotCol: "idcat_desbarbe" },
  // ── Agregadas: el frontend ahora tiene 12 categorías de maquinaria, no 10 ──
  maq_laminado_maquina:    { tabla: "cat_laminado_maquina",      pk: "idcat_laminado_maquina",    pivot: "maquinaria_laminado_maquina",    pivotCol: "idcat_laminado_maquina" },
  maq_texturizadora:       { tabla: "cat_texturizadora",         pk: "idcat_texturizadora",       pivot: "maquinaria_texturizadora",       pivotCol: "idcat_texturizadora" },
  maq_empaque_maquina:     { tabla: "cat_empaque_maquina",       pk: "idcat_empaque_maquina",     pivot: "maquinaria_empaque_maquina",     pivotCol: "idcat_empaque_maquina" },
};

async function insertarUnProducto(
  p: ProductoCrudo,
  idusuario: number | null,
  reporte: ReporteCatalogos
): Promise<number> {
  const client = await pool.connect();
  try {
    await iniciarTxUsuario(client, idusuario);

    // ── 1. Tipo de producto (catálogo) ────────────────────────────────
    const idcat_tipo_producto_papel = await resolverCatalogoSimple(client, reporte, {
      tabla: "cat_tipo_producto_papel",
      pk: "idcat_tipo_producto_papel",
      catalogoKey: "tipo_producto",
      nombreCrudo: p.tipo_producto,
      creadoPor: idusuario,
    });
    if (!idcat_tipo_producto_papel) throw new Error("No se pudo resolver tipo_producto");

    // ── 2. Producto padre ──────────────────────────────────────────────
    const { rows: prodRows } = await client.query(
      `INSERT INTO producto_papel (
         idproductos, idcat_tipo_producto_papel,
         descripcion_papel, ancho, fuelle, altura, medida,
         creado_por, actualizado_por
       ) VALUES (2, $1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING idproducto_papel`,
      [idcat_tipo_producto_papel, p.descripcion_papel, p.ancho, p.fuelle, p.altura, p.medida, idusuario]
    );
    const idproducto_papel = prodRows[0].idproducto_papel;

    // ── 3. Grupos y materiales (hoja OpcionesPapel) ────────────────────
    // Varias filas con el mismo orden_opcion = mismo grupo_papel (misma
    // "Opción" del formulario), cada una con un material distinto dentro.
    const gruposMap = new Map<number, typeof p.opciones>();
    for (const op of p.opciones) {
      const key = op.orden_opcion;
      if (!gruposMap.has(key)) gruposMap.set(key, []);
      gruposMap.get(key)!.push(op);
    }

    // Orden estable: por orden_opcion ascendente
    const ordenesOpcion = Array.from(gruposMap.keys()).sort((a, b) => a - b);

    for (let gi = 0; gi < ordenesOpcion.length; gi++) {
      const ordenOpcion = ordenesOpcion[gi];
      const materialesDelGrupo = gruposMap.get(ordenOpcion)!
        .sort((a, b) => a.orden_material - b.orden_material);

      // El precio_sugerido del grupo se toma de la primera fila que lo tenga
      const precioGrupo = materialesDelGrupo.find(m => m.precio_sugerido != null)?.precio_sugerido ?? null;

      const { rows: grupoRows } = await client.query(
        `INSERT INTO grupo_papel (idproducto_papel, precio_sugerido, orden, creado_por, actualizado_por)
         VALUES ($1, $2, $3, $4, $4)
         RETURNING idgrupo_papel`,
        [idproducto_papel, precioGrupo, gi + 1, idusuario]
      );
      const idgrupo_papel = grupoRows[0].idgrupo_papel;

      for (let mi = 0; mi < materialesDelGrupo.length; mi++) {
        const op = materialesDelGrupo[mi];

        const idcat_tipo_papel = await resolverCatalogoSimple(client, reporte, {
          tabla: "cat_tipo_papel",
          pk: "idcat_tipo_papel",
          catalogoKey: "tipo_papel",
          nombreCrudo: op.tipo_papel,
          creadoPor: idusuario,
        });
        const idcat_calibre = await resolverCalibre(client, reporte, op.calibre);

        await client.query(
          `INSERT INTO detalle_material_papel (
             idgrupo_papel, idcat_tipo_papel, idcat_calibre,
             pliego, rendimiento, corte,
             hoj_bobina, hoj_corte, hoj_rendimiento, hoj_guillotina, hoj_hilo, hoj_bobina_extra,
             orden, creado_por, actualizado_por
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
          [
            idgrupo_papel, idcat_tipo_papel, idcat_calibre,
            op.pliego, op.rendimiento, op.corte_material,
            op.hoj_bobina, op.hoj_corte, op.hoj_rendimiento, op.hoj_guillotina, op.hoj_hilo, op.hoj_bobina_extra,
            op.orden_material ?? mi + 1, idusuario,
          ]
        );
      }
    }

    // ── 4. Suaje ────────────────────────────────────────────────────────
    const hayDatosSuaje =
      p.suaje_numero || p.suaje_pzs || p.suaje_tamano || p.corte || p.doble ||
      p.metros || p.matrix || p.tiempo_arreglo_min || p.sacabocado_medida ||
      p.perforado_medida || p.herramental_desbarbe || p.no_desbarbe;

    if (hayDatosSuaje) {
      const idcat_punto_corte = await resolverPuntos(client, reporte, p.corte_puntos);
      const idcat_punto_doble = await resolverPuntos(client, reporte, p.doble_puntos);

      const idcat_corte = await resolverCorteDoble(client, reporte, {
        tabla: "cat_cortes", pk: "idcat_corte", campo: "corte", catalogoKey: "cortes",
        valorCrudo: p.corte, alturaMmCrudo: p.corte_altura_mm, idcatPunto: idcat_punto_corte,
      });
      const idcat_doble = await resolverCorteDoble(client, reporte, {
        tabla: "cat_dobles", pk: "idcat_doble", campo: "doble", catalogoKey: "dobles",
        valorCrudo: p.doble, alturaMmCrudo: p.doble_altura_mm, idcatPunto: idcat_punto_doble,
      });
      const idcat_matrix = await resolverMatrix(client, reporte, p.matrix);
      const idcat_sacabocados = await resolverPorMedida(client, reporte, {
        tabla: "cat_sacabocados", pk: "idcat_sacabocados", catalogoKey: "sacabocados",
        nombreFijo: "Sacabocado", medidaCrudo: p.sacabocado_medida,
      });
      const idcat_perforado = await resolverPorMedida(client, reporte, {
        tabla: "cat_perforado", pk: "idcat_perforado", catalogoKey: "perforado",
        nombreFijo: "Perforación", medidaCrudo: p.perforado_medida,
      });

      // Compatibilidad: se llenan AMBOS sistemas (texto libre + catálogo),
      // tal como se confirmó que usa el sistema en producción.
      await client.query(
        `INSERT INTO suaje_papel (
           idproducto_papel, numero, pzs, tamano,
           corte1_tipo, corte1_medida, idcat_corte, idcat_punto_corte,
           dobles1_tipo, dobles1_medida, idcat_doble, idcat_punto_doble,
           metros, matrix, idcat_matrix, tiempo_arreglo,
           idcat_sacabocados, cantidad_sacabocado,
           idcat_perforado, cantidad_perforado,
           herramental_desbarbe, no_desbarbe
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          idproducto_papel,
          p.suaje_numero, p.suaje_pzs, p.suaje_tamano,
          p.corte ? "Corte" : null, p.corte ?? null, idcat_corte, idcat_punto_corte,
          p.doble ? "Doble" : null, p.doble ?? null, idcat_doble, idcat_punto_doble,
          p.metros, p.matrix, idcat_matrix, p.tiempo_arreglo_min,
          idcat_sacabocados, p.sacabocado_cantidad,
          idcat_perforado, p.perforado_cantidad,
          p.herramental_desbarbe === true, p.no_desbarbe,
        ]
      );
    }

    // ── 5. Acabados (pegado, asas, laminado, refuerzo, base, empaque) ──
    const hayAcabados =
      p.tipo_pegado || p.pegamento || p.asas || p.laminados ||
      p.refuerzo_material || p.refuerzo_medida || p.base_material ||
      p.base_medida || p.empaque || p.piezas_por_caja;

    if (hayAcabados) {
      const idcat_tipo_pegado = await resolverCatalogoSimple(client, reporte, {
        tabla: "cat_tipo_pegado", pk: "idcat_tipo_pegado", catalogoKey: "tipo_pegado",
        nombreCrudo: p.tipo_pegado, creadoPor: idusuario,
      });
      const idcat_pegamento = await resolverCatalogoSimple(client, reporte, {
        tabla: "cat_pegamento", pk: "idcat_pegamento", catalogoKey: "pegamento",
        nombreCrudo: p.pegamento, creadoPor: idusuario,
      });
      const idcat_refuerzo_material = await resolverCatalogoSimple(client, reporte, {
        tabla: "cat_refuerzo_material", pk: "idcat_refuerzo_material", catalogoKey: "refuerzo_material",
        nombreCrudo: p.refuerzo_material, creadoPor: idusuario,
      });
      const idcat_refuerzo_medidas = await resolverCatalogoSimple(client, reporte, {
        tabla: "cat_refuerzo_medidas", pk: "idcat_refuerzo_medidas", catalogoKey: "refuerzo_medidas",
        nombreCrudo: p.refuerzo_medida, creadoPor: idusuario,
      });
      // base_material usa el MISMO catálogo que refuerzo_material (visto en el controller original: idcat_base_material -> cat_refuerzo_material)
      const idcat_base_material = await resolverCatalogoSimple(client, reporte, {
        tabla: "cat_refuerzo_material", pk: "idcat_refuerzo_material", catalogoKey: "refuerzo_material",
        nombreCrudo: p.base_material, creadoPor: idusuario,
      });
      const idcat_empaque = await resolverCatalogoSimple(client, reporte, {
        tabla: "cat_empaque", pk: "idcat_empaque", catalogoKey: "empaque",
        nombreCrudo: p.empaque, creadoPor: idusuario,
      });

      const { rows: acabadosRows } = await client.query(
        `INSERT INTO acabados_papel (
           idproducto_papel, idcat_tipo_pegado, idcat_pegamento,
           idcat_refuerzo_material, idcat_refuerzo_medidas,
           idcat_base_material, base_medida,
           idcat_empaque, pzs_caja
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING idacabados_papel`,
        [
          idproducto_papel, idcat_tipo_pegado, idcat_pegamento,
          idcat_refuerzo_material, idcat_refuerzo_medidas,
          idcat_base_material, p.base_medida,
          idcat_empaque, p.piezas_por_caja,
        ]
      );
      const idacabados_papel = acabadosRows[0].idacabados_papel;

      const idsAsas = await resolverListaCatalogoSimple(client, reporte, {
        tabla: "cat_tipo_asa", pk: "idcat_tipo_asa", catalogoKey: "tipo_asa", textoComas: p.asas,
      });
      for (const idcat_tipo_asa of idsAsas) {
        await client.query(
          `INSERT INTO acabados_asas (idacabados_papel, idcat_tipo_asa) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [idacabados_papel, idcat_tipo_asa]
        );
      }

      const idsLaminados = await resolverListaCatalogoSimple(client, reporte, {
        tabla: "cat_laminado", pk: "idcat_laminado", catalogoKey: "laminado", textoComas: p.laminados,
      });
      for (const idcat_laminado of idsLaminados) {
        await client.query(
          `INSERT INTO acabados_laminado (idacabados_papel, idcat_laminado) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [idacabados_papel, idcat_laminado]
        );
      }
    }

    // ── 6. Tintas (frente / dentro) ─────────────────────────────────────
    // tintas.idtintas se identifica por CANTIDAD (no por nombre) — tabla tintas(idtintas, cantidad)
    async function resolverIdTintasPorCantidad(cantidad: number | null): Promise<number | null> {
      if (cantidad === null || cantidad === undefined) return null;
      const { rows } = await client.query(`SELECT idtintas FROM tintas WHERE cantidad = $1 LIMIT 1`, [cantidad]);
      if (rows.length > 0) return rows[0].idtintas;
      const { rows: creado } = await client.query(
        `INSERT INTO tintas (cantidad) VALUES ($1) RETURNING idtintas`, [cantidad]
      );
      return creado[0].idtintas;
    }

    if (p.tintas_frente != null) {
      const idtintas = await resolverIdTintasPorCantidad(p.tintas_frente);
      if (idtintas) {
        await client.query(
          `INSERT INTO producto_papel_tintas (idproducto_papel, idtintas, cara) VALUES ($1, $2, 'frente')`,
          [idproducto_papel, idtintas]
        );
      }
    }
    if (p.tintas_dentro != null) {
      const idtintas = await resolverIdTintasPorCantidad(p.tintas_dentro);
      if (idtintas) {
        await client.query(
          `INSERT INTO producto_papel_tintas (idproducto_papel, idtintas, cara) VALUES ($1, $2, 'interior')`,
          [idproducto_papel, idtintas]
        );
      }
    }

    // ── 7. Maquinaria (10 tablas multi-select) ──────────────────────────
    for (const [campoExcel, cfg] of Object.entries(MAQ_TABLAS)) {
      const textoComas = (p as any)[campoExcel] as string | null;
      const ids = await resolverListaCatalogoSimple(client, reporte, {
        tabla: cfg.tabla, pk: cfg.pk, catalogoKey: campoExcel.replace("maq_", ""), textoComas,
      });
      for (const id of ids) {
        await client.query(
          `INSERT INTO ${cfg.pivot} (idproducto_papel, ${cfg.pivotCol}) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [idproducto_papel, id]
        );
      }
    }

    await client.query("COMMIT");
    return idproducto_papel;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export const cargaMasivaProductosPapel = async (req: RequestConArchivo, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "No se recibió ningún archivo. Sube un .xlsx o .xlsm en el campo 'archivo'." });
    }

    // El multer global (config/multer.ts) acepta cualquier tipo de archivo,
    // así que la validación de que sea realmente un Excel se hace aquí.
    // Se acepta TANTO .xlsx como .xlsm — la plantilla oficial que se entrega
    // al usuario es .xlsm (incluye la macro de selección múltiple), así que
    // rechazar esa extensión bloquearía el uso normal de la plantilla.
    const nombreLower = file.originalname.toLowerCase();
    const esExcelValido =
      file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel.sheet.macroEnabled.12" ||
      nombreLower.endsWith(".xlsx") ||
      nombreLower.endsWith(".xlsm");
    if (!esExcelValido) {
      return res.status(400).json({ error: "El archivo debe ser un .xlsx o .xlsm válido." });
    }

    const idusuario = (req as any).user?.id ?? null;
    const { productos, errores: erroresLectura } = leerExcelCargaMasiva(file.buffer);

    if (productos.length === 0) {
      return res.status(400).json({
        error: "No se encontraron productos válidos en el archivo.",
        errores: erroresLectura,
      });
    }

    const reporte = nuevoReporte();
    const resultados: ResultadoFila[] = [];

    // Reportamos también los errores de lectura (filas omitidas antes de tocar la BD)
    for (const e of erroresLectura) {
      resultados.push({ fila: e.fila, producto_id: "(sin id)", estado: "error", error: e.mensaje });
    }

    // Cada producto en su PROPIA transacción — un error no tira a los demás
    for (const p of productos) {
      try {
        const idproducto_papel = await insertarUnProducto(p, idusuario, reporte);
        resultados.push({ fila: p.fila, producto_id: p.producto_id, estado: "creado", idproducto_papel });
        console.log(`✅ Carga masiva — producto creado: ${p.producto_id} → id=${idproducto_papel}`);
      } catch (err: any) {
        console.error(`❌ Carga masiva — error en fila ${p.fila} (${p.producto_id}):`, err.message);
        resultados.push({ fila: p.fila, producto_id: p.producto_id, estado: "error", error: err.message });
      }
    }

    const creados = resultados.filter(r => r.estado === "creado").length;
    const conError = resultados.filter(r => r.estado === "error").length;

    return res.status(200).json({
      message: `Carga finalizada: ${creados} producto(s) creado(s), ${conError} con error.`,
      resumen: { total: productos.length, creados, conError },
      resultados,
      catalogosNuevos: reporteAFilas(reporte),
    });

  } catch (error: any) {
    console.error("❌ CARGA MASIVA PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al procesar la carga masiva", detalle: error.message });
  }
};