// src/services/producto_papel/merma.service.ts
// ═══════════════════════════════════════════════════════════════════════════
// MOTOR DE MERMA — PAPEL
// ═══════════════════════════════════════════════════════════════════════════
// Ver merma-papel-contexto.md para el diseño completo.
//
// Reglas implementadas aquí:
//   R1  La merma son PIEZAS absolutas, no porcentaje.
//       ⚠️ CORREGIDO (2026-08-21, fórmula validada por Jose en
//       "papel formula.xlsx"): la merma NO se suma sobre la cantidad pedida.
//       Se suma sobre los CORTES ya convertidos ("máquina" en la fórmula),
//       o sea DESPUÉS de dividir entre el rendimiento del suaje:
//
//           cortes           = cantidad_pedida / piezas_suaje
//           cortes_con_merma = cortes + merma_total
//           pliegos          = techo(cortes_con_merma / rendimiento)
//
//       El motivo es físico: la merma se mide en PLIEGOS que se echan a
//       perder calibrando cada máquina (100 hojas de arranque de prensa),
//       no en producto terminado. Sumarla a la cantidad pedida la hacía
//       pasar por la división del suaje y la encogía: con piezas_suaje=16,
//       110 pliegos de merma se convertían en 6.9 -- se pedía 24% menos
//       material del necesario. Con piezas_suaje=1 ambas fórmulas dan lo
//       mismo, por eso el error pasó desapercibido tanto tiempo.
//
//       `cantidad_a_producir` (pedido + merma) se sigue calculando y
//       guardando, pero SOLO como dato informativo: ya no es la base del
//       cálculo de pliegos. Ver getMermaDeOrdenBatch().
//   R2  merma_total = BASE (siempre) + Σ(columnas cuyo proceso aplique).
//       Suma simple, calculada UNA sola vez. No hay merma en cascada.
//   R3  Columnas con idproceso_cat NULL y siempre_aplica=false son INERTES:
//       se ignoran (caso Empalmadora, proceso que aún no existe).
//   R5  El resultado se congela al crear la orden de producción.
//
// Este archivo NO decide qué procesos lleva una orden: eso lo resuelve
// getProcesosDeOrdenPapel() en procesosPapel.controller.ts, que ya es la
// fuente de verdad. Duplicar esas reglas aquí sería un criadero de bugs.
// ═══════════════════════════════════════════════════════════════════════════

import { pool } from "../../config/db";
// ⚠️ REQUIERE: agregar `export` a `async function getProcesosDeOrdenPapel`
// en src/controllers/producto_papel/procesosPapel.controller.ts (línea ~229).
// Es la única modificación que necesita ese archivo.
import {
  getProcesosDeOrdenPapel,
  getTintasDeOrdenPapel,
} from "../../controllers/producto_papel/procesosPapel.controller";

export class ErrorMermaPapel extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "ErrorMermaPapel";
    this.statusCode = statusCode;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────────────────────────────────
export interface EscalaMerma {
  id: number;
  cantidad: number;
  activo: boolean;
  orden: number;
}

export interface EscalaResuelta {
  id: number;
  cantidad: number;
  /** true si la cantidad quedó fuera del rango y se usó el escalón extremo. */
  clamp: boolean;
}

export interface RenglonDesglose {
  clave: string;
  nombre: string;
  piezas: number;
  motivo: string;
}

export interface ColumnaIgnorada {
  clave: string;
  motivo: "proceso_no_existe" | "columna_inactiva" | "proceso_no_aplica";
}

export interface ResultadoMerma {
  cantidad_pedida: number;
  escala: EscalaResuelta | null;
  merma_total: number;
  cantidad_a_producir: number;
  desglose: RenglonDesglose[];
  ignorados: ColumnaIgnorada[];
  advertencias: string[];
  procesos_detectados: number[];
}

type Ejecutor = { query: (text: string, params?: any[]) => Promise<any> };

const db = (client?: Ejecutor): Ejecutor => client ?? pool;

// ─────────────────────────────────────────────────────────────────────────
// RESOLUCIÓN DE ESCALÓN — función pura, el núcleo de todo
// ─────────────────────────────────────────────────────────────────────────
/**
 * Devuelve el escalón que le toca a una cantidad, con la regla del punto
 * medio: a partir de la mitad entre dos escalones, sube al siguiente.
 *
 *   749  -> 500      (el punto medio de 500-1000 es 750)
 *   750  -> 1000     (empate: sube)
 *   1499 -> 1000
 *   1500 -> 2000
 *
 * Fuera de rango hace clamp al escalón extremo y lo reporta con `clamp: true`
 * para que el llamador pueda levantar una advertencia.
 *
 * Es pura a propósito: se puede probar sin base de datos.
 */
export function resolverEscalaMerma(
  cantidad: number,
  escalas: EscalaMerma[]
): EscalaResuelta {
  const activas = escalas
    .filter((e) => e.activo)
    .sort((a, b) => a.cantidad - b.cantidad);

  if (activas.length === 0) {
    throw new ErrorMermaPapel(
      "No hay escalas de merma activas. Configura al menos una en Merma de Papel.",
      409
    );
  }

  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    throw new ErrorMermaPapel("La cantidad debe ser un número mayor que cero.");
  }

  const primera = activas[0];
  const ultima = activas[activas.length - 1];

  if (cantidad <= primera.cantidad) {
    return {
      id: primera.id,
      cantidad: primera.cantidad,
      clamp: cantidad < primera.cantidad,
    };
  }

  if (cantidad >= ultima.cantidad) {
    return {
      id: ultima.id,
      cantidad: ultima.cantidad,
      clamp: cantidad > ultima.cantidad,
    };
  }

  for (let i = 0; i < activas.length - 1; i++) {
    const bajo = activas[i];
    const alto = activas[i + 1];

    if (cantidad >= bajo.cantidad && cantidad <= alto.cantidad) {
      const puntoMedio = (bajo.cantidad + alto.cantidad) / 2;
      // Empate sube: 750 con escalones 500/1000 devuelve 1000.
      const elegido = cantidad >= puntoMedio ? alto : bajo;
      return { id: elegido.id, cantidad: elegido.cantidad, clamp: false };
    }
  }

  // Inalcanzable con escalas ordenadas, pero mejor fallar claro que devolver
  // un escalón equivocado en silencio.
  throw new ErrorMermaPapel(
    `No se pudo resolver el escalón de merma para la cantidad ${cantidad}.`,
    500
  );
}

// ─────────────────────────────────────────────────────────────────────────
// LECTURAS DE CATÁLOGO
// ─────────────────────────────────────────────────────────────────────────
export async function getEscalasMerma(client?: Ejecutor): Promise<EscalaMerma[]> {
  const { rows } = await db(client).query(`
    SELECT idcat_escala_merma AS id, cantidad, activo, orden
    FROM cat_escala_merma
    ORDER BY orden, cantidad
  `);

  return rows.map((r: any) => ({
    id: Number(r.id),
    cantidad: Number(r.cantidad),
    activo: r.activo,
    orden: Number(r.orden),
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// CÁLCULO
// ─────────────────────────────────────────────────────────────────────────
/**
 * Calcula la merma a partir de una cantidad y una lista de idproceso_cat que
 * aplican. No lee la orden ni escribe nada: se puede usar para simular.
 *
 * R9: en papel se imprime hasta con 4 tintas de frente + 4 de reverso/dentro
 * (8 en total). Cada tinta es un ajuste de registro más en la máquina, así
 * que la columna IMPRESION de la matriz se multiplica por el total de
 * tintas del producto -- las demás columnas NO se multiplican, solo esa.
 * `tintasTotal` es opcional (default 0 = sin multiplicar) para no romper a
 * quien llame calcularMerma() sin conocer las tintas, como el simulador de
 * "verificar qué escalón le toca a una cantidad" sin orden asociada.
 */
export async function calcularMerma(
  cantidad: number,
  procesosAplicables: number[],
  client?: Ejecutor,
  tintasTotal = 0
): Promise<ResultadoMerma> {
  const ejecutor = db(client);
  const advertencias: string[] = [];
  const cantidadEntera = Math.ceil(cantidad);

  const escalas = await getEscalasMerma(ejecutor);
  const escala = resolverEscalaMerma(cantidadEntera, escalas);

  if (escala.clamp) {
    advertencias.push(
      `La cantidad ${cantidadEntera} está fuera del rango de escalas configuradas; ` +
        `se aplicó el escalón de ${escala.cantidad}.`
    );
  }

  // Se traen TODAS las columnas (incluso inactivas) para poder reportar por
  // qué se ignoró cada una. LEFT JOIN porque una celda puede no existir.
  const { rows } = await ejecutor.query(
    `
    SELECT
      cpm.idcat_proceso_merma AS id,
      cpm.clave,
      cpm.nombre,
      cpm.idproceso_cat,
      cpm.siempre_aplica,
      cpm.activo,
      cpm.orden,
      mc.piezas,
      mc.activo AS celda_activa
    FROM cat_proceso_merma cpm
    LEFT JOIN merma_config mc
      ON mc.idcat_proceso_merma = cpm.idcat_proceso_merma
     AND mc.idcat_escala_merma  = $1
    ORDER BY cpm.orden, cpm.idcat_proceso_merma
    `,
    [escala.id]
  );

  const desglose: RenglonDesglose[] = [];
  const ignorados: ColumnaIgnorada[] = [];
  const setProcesos = new Set(procesosAplicables);

  for (const col of rows) {
    if (!col.activo) {
      ignorados.push({ clave: col.clave, motivo: "columna_inactiva" });
      continue;
    }

    let aplica = false;
    let motivo = "";

    if (col.siempre_aplica) {
      // R2: la base entra en toda orden de papel, sin excepción.
      aplica = true;
      motivo = "siempre_aplica";
    } else if (col.idproceso_cat == null) {
      // R3: columna inerte. Existe y se puede capturar, pero no hay proceso
      // al cual amarrarla todavía. Caso Empalmadora.
      ignorados.push({ clave: col.clave, motivo: "proceso_no_existe" });
      continue;
    } else if (setProcesos.has(Number(col.idproceso_cat))) {
      aplica = true;
      motivo = `proceso_cat=${col.idproceso_cat}`;
    } else {
      ignorados.push({ clave: col.clave, motivo: "proceso_no_aplica" });
      continue;
    }

    if (!aplica) continue;

    // celda_activa NULL significa que la fila de merma_config no existe.
    if (col.celda_activa === false) {
      ignorados.push({ clave: col.clave, motivo: "columna_inactiva" });
      continue;
    }

    // NULL = celda nunca capturada. Se trata como 0 pero se avisa: en la BASE
    // casi siempre es un olvido de configuración, no una decisión.
    const piezasBase = col.piezas == null ? 0 : Number(col.piezas);

    if (col.piezas == null) {
      advertencias.push(
        `La celda "${col.nombre}" no tiene valor capturado para el escalón de ` +
          `${escala.cantidad}; se tomó como 0.`
      );
    }

    // R9: solo IMPRESION se multiplica por tintas; el resto de columnas usa
    // la pieza tal cual capturada en la matriz.
    const esImpresion = col.clave === "IMPRESION";
    const piezas = esImpresion && tintasTotal > 0 ? piezasBase * tintasTotal : piezasBase;
    const motivoFinal =
      esImpresion && tintasTotal > 0 ? `${motivo} · ×${tintasTotal} tintas` : motivo;

    desglose.push({
      clave: col.clave,
      nombre: col.nombre,
      piezas,
      motivo: motivoFinal,
    });
  }

  const merma_total = desglose.reduce((sum, d) => sum + d.piezas, 0);

  if (merma_total === 0) {
    advertencias.push(
      "La merma calculada es 0. Verifica que la matriz de merma esté capturada."
    );
  }

  return {
    cantidad_pedida: cantidadEntera,
    escala,
    merma_total,
    cantidad_a_producir: cantidadEntera + merma_total,
    desglose,
    ignorados,
    advertencias,
    procesos_detectados: procesosAplicables,
  };
}

/**
 * Igual que calcularMerma pero resolviendo cantidad y procesos desde la orden.
 * Sigue sin escribir nada — sirve para previsualizar antes de congelar.
 */
export async function calcularMermaDeOrden(
  client: Ejecutor,
  idproduccion: number
): Promise<ResultadoMerma> {
  const { rows } = await client.query(
    `
    SELECT
      op.idproduccion,
      op.es_parcialidad,
      op.pzas,
      sp.tipo_material,
      sd.cantidad AS cantidad_pedida
    FROM orden_produccion op
    JOIN solicitud_producto sp ON sp.idsolicitud_producto = op.idsolicitud_producto
    LEFT JOIN solicitud_detalle sd
      ON sd.solicitud_producto_id = sp.idsolicitud_producto
     AND sd.eliminado_at IS NULL
    WHERE op.idproduccion = $1
    LIMIT 1
    `,
    [idproduccion]
  );

  if (rows.length === 0) {
    throw new ErrorMermaPapel("Orden de producción no encontrada.", 404);
  }

  const orden = rows[0];

  // Los especiales guardan tipo_material="especial" (no "papel"), pero la
  // merma por escalones aplica igual -- de hecho la mayor parte del fix de
  // merma de esta sesión fue justo para especiales (Jose, 2026-09-03).
  if (orden.tipo_material !== "papel" && orden.tipo_material !== "especial") {
    throw new ErrorMermaPapel(
      "La merma por escalones solo aplica a órdenes de papel.",
      400
    );
  }

  const advertenciasPrevias: string[] = [];

  // R7: la merma SIEMPRE se calcula sobre la cantidad total del producto del
  // pedido, nunca sobre op.pzas de una parcialidad. La merma es el setup de
  // cada proceso: se paga una vez, no una por entrega parcial.
  const cantidad = Number(orden.cantidad_pedida ?? 0);

  if (orden.es_parcialidad === true) {
    advertenciasPrevias.push(
      `Orden marcada como parcialidad: la merma se calculó sobre la cantidad total ` +
        `del pedido (${cantidad} piezas), no sobre las piezas de esta parcialidad.`
    );
  }

  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    throw new ErrorMermaPapel(
      "La orden no tiene una cantidad válida en solicitud_detalle.",
      409
    );
  }

  const procesos = await getProcesosDeOrdenPapel(client, idproduccion);

  if (procesos.length === 0) {
    throw new ErrorMermaPapel(
      "No se pudieron determinar los procesos de esta orden de papel.",
      409
    );
  }

  // R9: total de tintas (frente + dentro) para multiplicar la columna de
  // Impresión — ver calcularMerma().
  const { tintasFrente, tintasDentro } = await getTintasDeOrdenPapel(client, idproduccion);
  const tintasTotal = tintasFrente + tintasDentro;

  const resultado = await calcularMerma(cantidad, procesos, client, tintasTotal);
  resultado.advertencias = [...advertenciasPrevias, ...resultado.advertencias];
  return resultado;
}

// ─────────────────────────────────────────────────────────────────────────
// RESOLUCIÓN DE USUARIO
// ─────────────────────────────────────────────────────────────────────────
/**
 * Devuelve el usuario a usar como creado_por/actualizado_por.
 *
 * Si se pasa `usuarioId` explícito, se usa tal cual (caso: el controller ya
 * lo tiene a la mano, p.ej. aprobarOrdenDiseno con req.user.id).
 *
 * Si no, se intenta leer `app.usuario_id` de la sesión de Postgres —la misma
 * variable que, según el comentario en ventas.controller.ts, declara
 * `req.tx`/`iniciarTx` para los triggers de auditoría. Como esto corre en el
 * mismo `client` de la transacción, si el middleware ya la fijó, aquí
 * aparece sola.
 *
 * ⚠️ SUPUESTO A VERIFICAR: el nombre exacto de la variable de sesión
 * (`app.usuario_id`) se infirió del comentario en ventas_controller.ts, no
 * se confirmó contra middlewares/auditoria.ts (no se compartió ese archivo).
 * Si el nombre real es otro, ajusta la constante NOMBRE_VARIABLE_SESION de
 * abajo — es el único lugar que hay que tocar.
 */
const NOMBRE_VARIABLE_SESION = "app.usuario_id";

async function resolverUsuarioActual(
  client: Ejecutor,
  usuarioId?: number | null
): Promise<number | null> {
  if (usuarioId) return usuarioId;

  try {
    const { rows } = await client.query(
      `SELECT NULLIF(current_setting($1, true), '')::int AS id`,
      [NOMBRE_VARIABLE_SESION]
    );
    const id = rows[0]?.id;
    return Number.isInteger(id) ? id : null;
  } catch {
    // current_setting con 'true' no debería lanzar, pero por si acaso: sin
    // usuario resuelto no se bloquea el congelado de merma, solo queda
    // creado_por en NULL.
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PUNTO DE ENGANCHE ÚNICO PARA LOS 3 LUGARES QUE CREAN orden_produccion
// ─────────────────────────────────────────────────────────────────────────
/**
 * Congela la merma SOLO si la orden es de papel; no hace nada si es plástico
 * (R8). Pensada para llamarse justo después del INSERT en orden_produccion,
 * dentro de la MISMA transacción, en cualquiera de los 3 controladores que
 * crean órdenes (ventas.controller / diseno.controller / ordenDiseno.controller).
 *
 * Así, los 3 call sites no necesitan importar ni duplicar el discriminador
 * papel/plástico para efectos de merma — ya lo resuelve esta función leyendo
 * directo de la orden recién creada.
 */
export async function congelarMermaSiEsPapel(
  client: Ejecutor,
  idproduccion: number,
  usuarioId?: number | null
): Promise<{ aplico: boolean; resultado?: ResultadoMerma }> {
  const { rows } = await client.query(
    `
    SELECT sp.tipo_material
    FROM orden_produccion op
    JOIN solicitud_producto sp ON sp.idsolicitud_producto = op.idsolicitud_producto
    WHERE op.idproduccion = $1
    `,
    [idproduccion]
  );

  // CRÍTICO (Jose, 2026-09-03): los especiales ahora guardan tipo_material=
  // "especial" (no "papel"). Si esta función se queda solo con "papel", las
  // órdenes de especiales nuevas dejarían de congelar merma por completo al
  // crearse -- exactamente el flujo que se corrigió esta misma sesión.
  const tm = rows[0]?.tipo_material;
  if (tm !== "papel" && tm !== "especial") {
    return { aplico: false };
  }

  const usuario = await resolverUsuarioActual(client, usuarioId);
  const { resultado } = await congelarMermaOrden(client, idproduccion, usuario);
  return { aplico: true, resultado };
}


/**
 * Calcula y GUARDA la merma de la orden. Debe llamarse dentro de la misma
 * transacción que crea la orden de producción — si el cálculo falla, la orden
 * no debe nacer a medias.
 *
 * Idempotente: si ya existe snapshot, lo devuelve sin recalcular. Así, si el
 * flujo de creación se reintenta, no se pisa el número original.
 */
export async function congelarMermaOrden(
  client: Ejecutor,
  idproduccion: number,
  usuarioId?: number | null
): Promise<{ resultado: ResultadoMerma; yaExistia: boolean; snapshot: any }> {
  const { rows: existentes } = await client.query(
    `SELECT * FROM orden_produccion_merma WHERE orden_produccion_idproduccion = $1`,
    [idproduccion]
  );

  if (existentes.length > 0) {
    const fila = existentes[0];
    return {
      yaExistia: true,
      snapshot: fila,
      resultado: {
        cantidad_pedida: Number(fila.cantidad_pedida),
        escala: fila.idcat_escala_merma
          ? {
              id: Number(fila.idcat_escala_merma),
              cantidad: Number(fila.escala_cantidad),
              clamp: fila.merma_snapshot?.escala?.clamp ?? false,
            }
          : null,
        merma_total: Number(fila.merma_total),
        cantidad_a_producir: Number(fila.cantidad_a_producir),
        desglose: fila.merma_snapshot?.desglose ?? [],
        ignorados: fila.merma_snapshot?.ignorados ?? [],
        advertencias: fila.merma_snapshot?.advertencias ?? [],
        procesos_detectados: fila.merma_snapshot?.procesos_detectados ?? [],
      },
    };
  }

  // Resuelto aquí, no antes: si el snapshot ya existía, el camino de arriba
  // regresa sin necesitar usuario y nos ahorramos esta consulta.
  const usuario = await resolverUsuarioActual(client, usuarioId);
  const resultado = await calcularMermaDeOrden(client, idproduccion);

  // ── R7: parcialidades ──────────────────────────────────────────────────
  // Confirmado por el usuario: la merma define UNA meta fija por producto
  // (ej. 5000 pedidas + 500 merma = 5500 como meta total), sin importar en
  // cuántas parcialidades se reparta la producción. No se recalcula ni se
  // reparte proporcionalmente entre ellas.
  //
  // Si otra orden del mismo idsolicitud_producto ya absorbió esa meta, esta
  // hereda la referencia con merma_total = 0 -- ya no hay nada mas que sumar,
  // el 5500 quedó fijado una sola vez. Sin esto, 3 parcialidades del mismo
  // producto producirían 3 veces la merma completa.
  //
  // ⚠️ CORREGIDO (Jose, 2026-09-02): esta herencia sólo debe aplicar entre
  // parcialidades del MISMO componente (mismo idcomponente_papel, o ambos
  // NULL en papel normal). Un producto ESPECIAL también comparte un único
  // idsolicitud_producto entre TODAS sus OP (inicio-1, inicio-2, unión...),
  // pero cada componente es una pieza físicamente distinta -- con su propia
  // ruta y sus propias columnas de merma -- así que cada una necesita su
  // propio cálculo. Sin el filtro por idcomponente_papel, la primera OP de
  // inicio creada "absorbía" la merma y todas las demás OP del especial
  // (las otras inicio y la unión) se congelaban con merma_total = 0.
  const { rows: contexto } = await client.query(
    `SELECT idsolicitud_producto, idcomponente_papel FROM orden_produccion WHERE idproduccion = $1`,
    [idproduccion]
  );
  const idsolicitudProducto = contexto[0]?.idsolicitud_producto ?? null;
  const idcomponentePapel = contexto[0]?.idcomponente_papel ?? null;

  let heredadaDe: number | null = null;

  if (idsolicitudProducto != null) {
    const { rows: previas } = await client.query(
      `
      SELECT opm.orden_produccion_idproduccion, opm.merma_total
      FROM orden_produccion_merma opm
      JOIN orden_produccion op ON op.idproduccion = opm.orden_produccion_idproduccion
      WHERE op.idsolicitud_producto = $1
        AND opm.heredada_de_idproduccion IS NULL
        AND opm.orden_produccion_idproduccion <> $2
        AND (
          (op.idcomponente_papel IS NULL AND $3::int IS NULL)
          OR op.idcomponente_papel = $3
        )
      ORDER BY opm.orden_produccion_idproduccion ASC
      LIMIT 1
      `,
      [idsolicitudProducto, idproduccion, idcomponentePapel]
    );

    if (previas.length > 0) {
      heredadaDe = Number(previas[0].orden_produccion_idproduccion);
      resultado.merma_total = 0;
      resultado.cantidad_a_producir = resultado.cantidad_pedida;
      resultado.advertencias.push(
        `La merma de este producto ya fue absorbida por la orden ${heredadaDe}. ` +
          `Esta orden no suma merma adicional.`
      );
    }
  }

  const snapshot = { ...construirSnapshot(resultado), heredada_de: heredadaDe };

  const { rows } = await client.query(
    `
    INSERT INTO orden_produccion_merma (
      orden_produccion_idproduccion,
      idsolicitud_producto,
      heredada_de_idproduccion,
      cantidad_pedida,
      idcat_escala_merma,
      escala_cantidad,
      merma_total,
      cantidad_a_producir,
      merma_snapshot,
      version_calculo,
      creado_por
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10)
    RETURNING *
    `,
    [
      idproduccion,
      idsolicitudProducto,
      heredadaDe,
      resultado.cantidad_pedida,
      resultado.escala?.id ?? null,
      resultado.escala?.cantidad ?? null,
      resultado.merma_total,
      resultado.cantidad_a_producir,
      JSON.stringify(snapshot),
      usuario,
    ]
  );

  return { resultado, yaExistia: false, snapshot: rows[0] };
}

/**
 * Recálculo manual (R6). El controller es quien valida acceso_total ANTES de
 * llegar aquí; este servicio asume que el permiso ya se verificó.
 *
 * Guarda los valores anteriores dentro del snapshot nuevo, junto con el motivo
 * obligatorio, y sube version_calculo. El rastro en bitacora_cambios lo genera
 * solo el middleware de auditoría si el UPDATE corre por iniciarTx.
 */
export async function recalcularMermaOrden(
  client: Ejecutor,
  idproduccion: number,
  usuarioId: number,
  motivo: string
): Promise<{ resultado: ResultadoMerma; anterior: any | null; snapshot: any }> {
  const motivoLimpio = String(motivo ?? "").trim();

  if (motivoLimpio.length < 10) {
    throw new ErrorMermaPapel(
      "Debes capturar un motivo de al menos 10 caracteres para recalcular la merma.",
      400
    );
  }

  const { rows: previas } = await client.query(
    `SELECT * FROM orden_produccion_merma WHERE orden_produccion_idproduccion = $1`,
    [idproduccion]
  );

  // Órdenes anteriores al sistema no tienen snapshot (ver P14). En vez de
  // fallar, se genera aquí: es un backfill uno-por-uno, deliberado, auditado y
  // con motivo. Preferible a un backfill masivo que reescribiría en silencio
  // la cantidad objetivo de órdenes ya producidas.
  if (previas.length === 0) {
    const { resultado, snapshot } = await congelarMermaOrden(client, idproduccion, usuarioId);

    const { rows: actualizada } = await client.query(
      `
      UPDATE orden_produccion_merma
      SET merma_snapshot = merma_snapshot || $1::jsonb,
          actualizado_por = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE orden_produccion_idproduccion = $3
      RETURNING *
      `,
      [
        JSON.stringify({
          generado_por_backfill: {
            motivo: motivoLimpio,
            generado_por: usuarioId,
            generado_en: new Date().toISOString(),
            nota: "Orden anterior al sistema de merma; no tenia snapshot previo.",
          },
        }),
        usuarioId,
        idproduccion,
      ]
    );

    // Se devuelve la fila YA actualizada (con generado_por_backfill incluido),
    // no la que regresó congelarMermaOrden antes del UPDATE de arriba.
    return { resultado, anterior: null, snapshot: actualizada[0] ?? snapshot };
  }

  const anterior = previas[0];
  const resultado = await calcularMermaDeOrden(client, idproduccion);

  const snapshot = {
    ...construirSnapshot(resultado),
    // Lo que permite entender, meses después, por qué esta orden cambió de
    // cantidad objetivo a media producción.
    reemplazo: {
      version_anterior: Number(anterior.version_calculo),
      cantidad_pedida_anterior: Number(anterior.cantidad_pedida),
      escala_cantidad_anterior: anterior.escala_cantidad != null ? Number(anterior.escala_cantidad) : null,
      merma_total_anterior: Number(anterior.merma_total),
      cantidad_a_producir_anterior: Number(anterior.cantidad_a_producir),
      motivo: motivoLimpio,
      recalculado_por: usuarioId,
      recalculado_en: new Date().toISOString(),
    },
  };

  const { rows } = await client.query(
    `
    UPDATE orden_produccion_merma
    SET cantidad_pedida     = $1,
        idcat_escala_merma  = $2,
        escala_cantidad     = $3,
        merma_total         = $4,
        cantidad_a_producir = $5,
        merma_snapshot      = $6,
        version_calculo     = version_calculo + 1,
        actualizado_por     = $7,
        updated_at          = CURRENT_TIMESTAMP
    WHERE orden_produccion_idproduccion = $8
    RETURNING *
    `,
    [
      resultado.cantidad_pedida,
      resultado.escala?.id ?? null,
      resultado.escala?.cantidad ?? null,
      resultado.merma_total,
      resultado.cantidad_a_producir,
      JSON.stringify(snapshot),
      usuarioId,
      idproduccion,
    ]
  );

  return { resultado, anterior, snapshot: rows[0] };
}

/**
 * Lee el snapshot congelado. Esto es lo que deben consumir el PDF de orden de
 * producción y el Estado de Cuenta — NUNCA merma_config directamente, o
 * reimprimir un PDF viejo daría un número distinto al que se produjo.
 */
export async function getMermaOrden(
  idproduccion: number,
  client?: Ejecutor
): Promise<any | null> {
  const { rows } = await db(client).query(
    `
    SELECT
      opm.*,
      op.no_produccion
    FROM orden_produccion_merma opm
    JOIN orden_produccion op ON op.idproduccion = opm.orden_produccion_idproduccion
    WHERE opm.orden_produccion_idproduccion = $1
    `,
    [idproduccion]
  );

  if (rows.length === 0) return null;

  const fila = rows[0];
  return {
    ...fila,
    cantidad_pedida: Number(fila.cantidad_pedida),
    merma_total: Number(fila.merma_total),
    cantidad_a_producir: Number(fila.cantidad_a_producir),
    escala_cantidad: fila.escala_cantidad != null ? Number(fila.escala_cantidad) : null,
    version_calculo: Number(fila.version_calculo),
  };
}

/**
 * Lee `cantidad_a_producir` de varias órdenes a la vez, en una sola consulta.
 * Pensado para listas/dashboards (getSeguimiento, getOrdenProduccion en
 * seguimiento.controller.ts) donde iterar con una consulta por fila
 * dispararía N queries innecesarios — mismo criterio que ya usa ese archivo
 * para el resumen de estado de producción (`WHERE idproduccion = ANY($1)`).
 *
 * Silenciosa a propósito: una orden sin fila en `orden_produccion_merma`
 * (plástico, o papel creado antes de este sistema) simplemente no aparece
 * en el Map — el llamador decide el fallback (normalmente `?? cantidadPedida`).
 */
export interface MermaOrdenResumen {
  cantidad_pedida: number;
  merma_total: number;
  /** pedido + merma. Solo informativo: NO es la base del cálculo de pliegos. */
  cantidad_a_producir: number;
}

export async function getMermaDeOrdenBatch(
  idproducciones: number[],
  client?: Ejecutor
): Promise<Map<number, MermaOrdenResumen>> {
  const mapa = new Map<number, MermaOrdenResumen>();
  if (!idproducciones.length) return mapa;

  const { rows } = await db(client).query(
    `
    SELECT
      orden_produccion_idproduccion AS idproduccion,
      cantidad_pedida,
      merma_total,
      cantidad_a_producir
    FROM orden_produccion_merma
    WHERE orden_produccion_idproduccion = ANY($1)
    `,
    [idproducciones]
  );

  for (const r of rows) {
    mapa.set(Number(r.idproduccion), {
      cantidad_pedida: Number(r.cantidad_pedida),
      merma_total: Number(r.merma_total),
      cantidad_a_producir: Number(r.cantidad_a_producir),
    });
  }

  return mapa;
}

// ─────────────────────────────────────────────────────────────────────────
// PERMISOS (R6)
// ─────────────────────────────────────────────────────────────────────────
/**
 * acceso_total NO vive en usuarios: vive en roles. Hay que hacer el join.
 * Esta validación es de backend a propósito — ocultar el botón en el frontend
 * es cosmético, cualquiera puede llamar el endpoint directo.
 */
export async function usuarioTieneAccesoTotal(
  idusuario: number | null | undefined,
  client?: Ejecutor
): Promise<boolean> {
  if (!idusuario) return false;

  const { rows } = await db(client).query(
    `
    SELECT r.acceso_total
    FROM usuarios u
    JOIN roles r ON r.idroles = u.roles_idroles
    WHERE u.idusuario = $1
      AND u.activo = true
      AND u.eliminado_at IS NULL
    `,
    [idusuario]
  );

  return rows[0]?.acceso_total === true;
}

// ─────────────────────────────────────────────────────────────────────────
// INTERNOS
// ─────────────────────────────────────────────────────────────────────────
function construirSnapshot(resultado: ResultadoMerma) {
  return {
    escala: resultado.escala
      ? {
          id: resultado.escala.id,
          cantidad: resultado.escala.cantidad,
          regla: "punto_medio",
          clamp: resultado.escala.clamp,
        }
      : null,
    procesos_detectados: resultado.procesos_detectados,
    desglose: resultado.desglose,
    ignorados: resultado.ignorados,
    advertencias: resultado.advertencias,
  };
}