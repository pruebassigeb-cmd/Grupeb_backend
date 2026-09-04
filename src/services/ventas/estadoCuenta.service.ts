// src/services/ventas/estadoCuenta.service.ts
//
// Toda la lógica que antes vivía en estadoCuentaController.getEstadoCuenta
// se muda aquí, con los 6 arreglos identificados en el plan
// (plan-estado-cuenta-cobranza-v2.md, sección "1. Lo que encontré en el
// código actual"):
//
//   B — bloquearSolicitudParaVenta + FOR UPDATE antes de leer/escribir la
//       venta (mismo patrón que obtenerVentaBloqueada en ventas.controller.ts)
//   C — cantidad/kilogramos/precio_total de solicitud_detalle se AGREGAN
//       (SUM) en vez de multiplicarse por cada detalle aprobado
//   D — solicitud_producto_papel.cargo_adicional_precio se vuelve a sumar
//       al subtotal, igual que calcularSubtotalSolicitud
//   E — el saldo se guarda con signo (sin Math.max): negativo = a favor
//       del cliente
//   F — getListaEstadoCuenta ya no cuenta procesos a mano: lee
//       estado_cuenta.vigente
//   G — la completitud de producción se mide por
//       orden_produccion.idestado_produccion_cat = 3, ignorando
//       es_parcialidad (que se marca en el primer avance, no en una
//       entrega parcial real)
//
// A diferencia del controller viejo, esto YA NO se llama desde un GET.
// Se llama desde generarEstadoCuentaSiPedidoCompleto(), enganchado en:
//   - procesosController.finalizarProceso (plástico)
//   - procesosPapel.finalizarProcesoPapel (papel)
//   - procesosController.editarProceso / procesosPapel.editarProcesoPapel
//     (regeneración automática tras corregir un proceso ya terminado)
//   - POST /api/estado-cuenta/:noPedido/generar (regeneración manual)
//
// El GET /api/estado-cuenta/:noPedido pasa a ser lectura pura del snapshot
// vigente — ver estadoCuentaController.ts. Esto por sí solo mata los
// defectos A (GET que muta) y B (sin lock): si el endpoint no escribe, no
// hay nada que pisar.

import {
  calcularTotalesVenta,
  calcularUmbralAnticipo,
  determinarEstadoVenta,
} from "./totalesVenta.service";
import { bloquearSolicitudParaVenta } from "./pagos.service";
// OJO: ruta a verificar contra la ubicación real de procesosPapel.controller.ts
// en tu proyecto -- se infirió del import inverso que YA existe en ese
// archivo ("../../services/ventas/estadoCuenta.service"), asumiendo la
// misma profundidad (services/ventas/ <-> controllers/producto_papel/).
// Import cruzado a propósito (procesosPapel.controller.ts ya importa de
// este archivo): es seguro porque ambas funciones solo se invocan en
// tiempo de request, nunca en el top-level del módulo, así que el ciclo
// ya está resuelto para cuando de verdad se llaman (Jose, 2026-09-04).
import { cantidadEntregadaFinalPapel } from "../../controllers/producto_papel/procesosPapel.controller";

const ESTADO_PROD_TERMINADO = 3; // mismo valor que ESTADO_PROD.TERMINADO en procesosController.ts / procesosPapel.controller.ts

export interface ProductoEstadoCuentaCalculado {
  idsolicitud_producto: number;
  // Los especiales guardan tipo_material="especial", no "papel" -- se
  // respeta el valor real en vez de colapsarlo (Jose, 2026-09-04).
  tipo_material: "plastico" | "papel" | "especial";
  no_produccion: string | null;
  nombre: string;
  medida: string | null;
  material: string | null;
  modo_cantidad: string;
  cantidad_original: number;
  precio_total_original: number;
  cantidad_real: number;
  precio_unitario_real: number;
  precio_total_real: number;
  // Solo aplica a plástico vendido por unidad (modo_cantidad='unidad'):
  // equivalente en kg de las piezas reales, usando cfg.por_kilo (piezas
  // por kilo). null para papel y para plástico vendido por kilo (ahí
  // cantidad_real YA está en kg, no hace falta convertir).
  peso_kg_real: number | null;
  diferencia_cantidad: number;
  diferencia_precio: number;
  herramental_descripcion: string | null;
  herramental_precio: number | null;
  herramental_aprobado: boolean | null;
  cargo_adicional_descripcion: string | null;
  cargo_adicional_precio: number | null;
}

export interface EstadoCuentaCalculado {
  solicitudId: number;
  idventas: number;
  sinIva: boolean;
  productos: ProductoEstadoCuentaCalculado[];
  subtotalOriginal: number;
  ivaOriginal: number;
  totalOriginal: number;
  subtotalReal: number;
  ivaReal: number;
  totalReal: number;
  herramentalTotal: number;
  cargoAdicionalPapelTotal: number;
  diferenciaTotal: number;
  abonoActual: number;
  saldoNuevo: number;
  estadoResultante: number;
}

export interface ProduccionCompleta {
  completa: boolean;
  total: number;
  terminadas: number;
  faltantes: string[];
}

// ════════════════════════════════════════════════════════════════════════
// Defecto G: completitud por idestado_produccion_cat = 3 en TODAS las
// órdenes del pedido, sin mirar es_parcialidad.
// ════════════════════════════════════════════════════════════════════════
export async function pedidoTieneProduccionCompleta(
  client: any,
  solicitudId: number,
): Promise<ProduccionCompleta> {
  const { rows } = await client.query(
    `SELECT op.idproduccion, op.no_produccion, op.idestado_produccion_cat
     FROM solicitud_producto sp
     JOIN orden_produccion op ON op.idsolicitud_producto = sp.idsolicitud_producto
     WHERE sp.solicitud_idsolicitud = $1`,
    [solicitudId],
  );

  const total = rows.length;
  const terminadas = rows.filter(
    (r: any) => Number(r.idestado_produccion_cat) === ESTADO_PROD_TERMINADO,
  ).length;
  const faltantes = rows
    .filter((r: any) => Number(r.idestado_produccion_cat) !== ESTADO_PROD_TERMINADO)
    .map((r: any) => r.no_produccion ?? `orden ${r.idproduccion}`);

  return { completa: total > 0 && terminadas === total, total, terminadas, faltantes };
}

// ════════════════════════════════════════════════════════════════════════
// Calcula el estado de cuenta SIN escribir nada. Usado tanto por
// generarEstadoCuenta (que sí escribe) como, potencialmente, por un
// "preview" en el front antes de confirmar una regeneración manual.
//
// Asume que quien llama ya validó pedidoTieneProduccionCompleta() y ya
// tomó el lock (bloquearSolicitudParaVenta) si va a escribir después.
// ════════════════════════════════════════════════════════════════════════
export async function calcularEstadoCuenta(
  client: any,
  solicitudId: number,
): Promise<EstadoCuentaCalculado> {
  const { rows: pedidoRows } = await client.query(
    `SELECT s.sin_iva, v.idventas, v.subtotal, v.iva, v.total, v.abono
     FROM solicitud s
     JOIN ventas v ON v.solicitud_idsolicitud = s.idsolicitud
     WHERE s.idsolicitud = $1`,
    [solicitudId],
  );
  if (pedidoRows.length === 0) {
    throw new Error(`No existe venta para la solicitud ${solicitudId}`);
  }
  const pedido = pedidoRows[0];
  const sinIva = pedido.sin_iva ?? false;

  // ── Query única de productos + cantidad_real ──────────────────────────
  // Defecto C: sd es un LEFT JOIN LATERAL que agrega (SUM) los detalles
  // aprobados en vez de traer una fila por cada uno — así un producto con
  // dos solicitud_detalle aprobados no se cuenta doble. Lo mismo con
  // herramental (SUM ... WHERE aprobado = true).
  //
  // cantidad_real se resuelve en la misma query (antes eran N+1 queries,
  // una por producto, dentro de un Promise.all) bifurcando por tipo de
  // material: papel usa empaque_papel.bolsas_entregadas_final, plástico
  // usa asa_flexible o bolseo según tenga_asa_flexible.
  const { rows: prodRows } = await client.query(
    `SELECT
       sp.idsolicitud_producto,
       sp.tipo_material,
       sp.tintas_idtintas,
       sp.caras_idcaras,
       sd.cantidad                    AS cantidad_original,
       sd.kilogramos                  AS kilogramos_original,
       sd.precio_total                AS precio_total_original,
       sd.modo_cantidad,

       cfg.por_kilo,
       cfg.medida                     AS medida_plastico,
       tpp.material_plastico_producto AS tipo_producto_plastico,
       mp.tipo_material                AS material_plastico,
       EXISTS (
         SELECT 1 FROM tipo_producto_plastico_proceso tppp
         WHERE tppp.idtipo_producto_plastico =
           cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
           AND tppp.idproceso_cat = 3
       ) AS tiene_asa_flexible,

       sp.grupo_papel_descripcion     AS papel_grupo_descripcion,
       tpp2.nombre                    AS papel_tipo_producto,
       pp2.medida                     AS papel_medida,

       herr.herramental_precio,
       herr.herramental_descripcion,
       herr.herramental_aprobado,

       spp.cargo_adicional_precio,
       spp.cargo_adicional_descripcion,

       op.idproduccion,
       op.no_produccion,

       CASE
         -- Papel/especial YA NO se resuelve aquí -- se calculaba fijo
         -- contra empaque_papel, pero un componente de un especial puede
         -- terminar su ruta en cualquier proceso (Litolaminado y de ahí a
         -- almacén, por ejemplo), no necesariamente en Empaque (Jose,
         -- 2026-09-04). Se deja en NULL aquí y se resuelve después en JS
         -- con cantidadEntregadaFinalPapel (mismo cálculo cascada-abajo
         -- que ya usa piezasFinalesHermanasPapel), que sí sabe cuál es el
         -- último proceso REAL de cada orden en particular.
         WHEN sp.tipo_material IN ('papel', 'especial') THEN NULL
         WHEN EXISTS (
           SELECT 1 FROM tipo_producto_plastico_proceso tppp2
           WHERE tppp2.idtipo_producto_plastico =
             cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
             AND tppp2.idproceso_cat = 3
         ) THEN (
           SELECT CASE WHEN sd.modo_cantidad = 'kilo' THEN af.kilos_finales ELSE af.pzas_finales END
           FROM asa_flexible af WHERE af.orden_produccion_idproduccion = op.idproduccion LIMIT 1
         )
         ELSE (
           SELECT CASE WHEN sd.modo_cantidad = 'kilo' THEN b.kilos_bolseados ELSE b.piezas_bolseadas END
           FROM bolseo b WHERE b.orden_produccion_idproduccion = op.idproduccion LIMIT 1
         )
       END AS cantidad_real
     FROM solicitud_producto sp
     LEFT JOIN LATERAL (
       SELECT
         SUM(sd0.cantidad)   AS cantidad,
         SUM(sd0.kilogramos) AS kilogramos,
         SUM(sd0.precio_total) AS precio_total,
         CASE WHEN COUNT(*) > 0 AND BOOL_AND(COALESCE(sd0.modo_cantidad, 'unidad') = 'kilo')
              THEN 'kilo' ELSE 'unidad' END AS modo_cantidad
       FROM solicitud_detalle sd0
       WHERE sd0.solicitud_producto_id = sp.idsolicitud_producto AND sd0.aprobado = true
     ) sd ON true
     LEFT JOIN LATERAL (
       SELECT
         SUM(h.herramental_precio) FILTER (WHERE h.aprobado = true) AS herramental_precio,
         BOOL_OR(h.aprobado)                                        AS herramental_aprobado,
         STRING_AGG(h.herramental_descripcion, '; ') FILTER (WHERE h.aprobado = true) AS herramental_descripcion
       FROM herramental h
       WHERE h.idsolicitud_producto = sp.idsolicitud_producto
     ) herr ON true
     -- CORREGIDO (Jose, 2026-09-04): un producto especial en modo "OP de
     -- inicio + OP de unión" tiene VARIAS filas de orden_produccion para el
     -- mismo idsolicitud_producto (una por componente_papel: N de tipo
     -- 'inicio' + 1 de tipo 'union') -- "ORDER BY idproduccion LIMIT 1" a
     -- secas se quedaba con la más chica (casi siempre una OP de inicio),
     -- que nunca tiene su propio empaque_papel/bolsas_entregadas_final
     -- (solo la unión llega a Empaque), así que cantidad_real siempre
     -- salía NULL para esos productos. Ahora se prefiere explícitamente la
     -- OP de tipo 'union' cuando existe; para papel/plástico normal
     -- (idcomponente_papel es NULL, una sola fila) el criterio no cambia
     -- nada.
     LEFT JOIN LATERAL (
       SELECT op1.idproduccion, op1.no_produccion
       FROM orden_produccion op1
       LEFT JOIN componente_papel cp1 ON cp1.idcomponente_papel = op1.idcomponente_papel
       WHERE op1.idsolicitud_producto = sp.idsolicitud_producto
       ORDER BY CASE WHEN cp1.tipo = 'union' THEN 0 ELSE 1 END, op1.idproduccion
       LIMIT 1
     ) op ON true
     LEFT JOIN configuracion_plastico cfg
         ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
     LEFT JOIN tipo_producto_plastico tpp
         ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
     LEFT JOIN material_plastico mp
         ON mp.idmaterial_plastico = cfg.material_plastico_plastico_idmaterial_plastico
     LEFT JOIN producto_papel pp2
         ON pp2.idproducto_papel = sp.producto_papel_idproducto_papel
     LEFT JOIN cat_tipo_producto_papel tpp2
         ON tpp2.idcat_tipo_producto_papel = pp2.idcat_tipo_producto_papel
     LEFT JOIN solicitud_producto_papel spp
         ON spp.idsolicitud_producto = sp.idsolicitud_producto
     WHERE sp.solicitud_idsolicitud = $1`,
    [solicitudId],
  );

  if (prodRows.length === 0) {
    throw new Error(`El pedido de la solicitud ${solicitudId} no tiene productos`);
  }

  // Papel/especial: cantidad_real se resuelve dinámicamente contra el
  // ÚLTIMO proceso real de CADA orden (ver comentario en el CASE de arriba
  // y cantidadEntregadaFinalPapel) -- null si ese último proceso todavía
  // no está terminado.
  for (const prod of prodRows as any[]) {
    if ((prod.tipo_material === "papel" || prod.tipo_material === "especial") && prod.idproduccion != null) {
      const final = await cantidadEntregadaFinalPapel(client, Number(prod.idproduccion));
      prod.cantidad_real = final.terminado ? final.cantidad_entregada : null;
    }
  }

  const incompletos = prodRows.filter((p: any) => p.cantidad_real === null || p.idproduccion == null);
  if (incompletos.length > 0) {
    throw new Error(
      `Producción incompleta: ${incompletos.length} producto(s) sin cantidad final ` +
      `(${incompletos.map((p: any) => p.no_produccion ?? p.idsolicitud_producto).join(", ")})`,
    );
  }

  let nuevoSubtotal = 0;
  let herramentalTotal = 0;
  let cargoAdicionalPapelTotal = 0;

  const productos: ProductoEstadoCuentaCalculado[] = prodRows.map((prod: any) => {
    // Especiales entran por la misma rama que papel (mismos campos de
    // ficha, mismo Empaque) -- solo la clasificación final que se guarda
    // (tipo_material más abajo) respeta el valor real (Jose, 2026-09-04).
    const esPapel = prod.tipo_material === "papel" || prod.tipo_material === "especial";
    const modoKilo = prod.modo_cantidad === "kilo";
    const precioOrig = Number(prod.precio_total_original ?? 0);
    const cantReal = Number(prod.cantidad_real);

    // Papel siempre por piezas (nunca por kilo) — mismo criterio ya
    // establecido en el controller viejo (R11, merma-papel-contexto.md).
    const baseOriginal = esPapel
      ? Number(prod.cantidad_original ?? 0)
      : (modoKilo ? Number(prod.kilogramos_original ?? 0) : Number(prod.cantidad_original ?? 0));

    const precioUnitarioOriginal = baseOriginal > 0 ? precioOrig / baseOriginal : 0;
    const precioTotalReal = Number((precioUnitarioOriginal * cantReal).toFixed(2));

    const herrPrecio = prod.herramental_aprobado === true && prod.herramental_precio != null
      ? Number(prod.herramental_precio)
      : null;

    // Defecto D: cargo adicional de papel se suma al subtotal, igual que
    // calcularSubtotalSolicitud — antes el estado de cuenta lo perdía por
    // completo en el recálculo.
    const cargoAdicional = esPapel && prod.cargo_adicional_precio != null
      ? Number(prod.cargo_adicional_precio)
      : null;

    nuevoSubtotal += precioTotalReal;
    if (herrPrecio != null) { nuevoSubtotal += herrPrecio; herramentalTotal += herrPrecio; }
    if (cargoAdicional != null) { nuevoSubtotal += cargoAdicional; cargoAdicionalPapelTotal += cargoAdicional; }

    const nombre = esPapel
      ? ([prod.papel_tipo_producto, prod.papel_medida].filter(Boolean).join(" ") || `Papel #${prod.idsolicitud_producto}`)
      : ([prod.tipo_producto_plastico, prod.medida_plastico, prod.material_plastico].filter(Boolean).join(" "));

    // Plástico vendido por unidad: estimado en kg usando cfg.por_kilo
    // (piezas por kilo) — mismo cálculo que tenía el controller viejo.
    // Por kilo ya está en kg (cantReal), papel no maneja peso.
    const porKilo = Number(prod.por_kilo) || 0;
    const pesoKgReal = esPapel
      ? null
      : (modoKilo ? cantReal : (porKilo > 0 ? Number((cantReal / porKilo).toFixed(4)) : 0));

    return {
      idsolicitud_producto: prod.idsolicitud_producto,
      // Se respeta "especial" tal cual en vez de colapsarlo a "papel"
      // (Jose, 2026-09-04) -- ver tipo_material en ProductoEstadoCuentaCalculado.
      tipo_material: prod.tipo_material === "especial" ? "especial" : (esPapel ? "papel" : "plastico"),
      no_produccion: prod.no_produccion,
      nombre,
      medida: esPapel ? (prod.papel_medida ?? null) : (prod.medida_plastico ?? null),
      material: esPapel ? (prod.papel_grupo_descripcion ?? null) : (prod.material_plastico ?? null),
      modo_cantidad: esPapel ? "unidad" : prod.modo_cantidad,
      cantidad_original: baseOriginal,
      precio_total_original: precioOrig,
      cantidad_real: cantReal,
      peso_kg_real: pesoKgReal,
      precio_unitario_real: Number(precioUnitarioOriginal.toFixed(6)),
      precio_total_real: precioTotalReal,
      diferencia_cantidad: Number((cantReal - baseOriginal).toFixed(2)),
      diferencia_precio: Number((precioTotalReal - precioOrig).toFixed(2)),
      herramental_descripcion: prod.herramental_descripcion ?? null,
      herramental_precio: prod.herramental_precio != null ? Number(prod.herramental_precio) : null,
      herramental_aprobado: prod.herramental_aprobado ?? null,
      cargo_adicional_descripcion: esPapel ? (prod.cargo_adicional_descripcion ?? null) : null,
      cargo_adicional_precio: cargoAdicional,
    };
  });

  nuevoSubtotal = Number(nuevoSubtotal.toFixed(2));
  const { iva: nuevoIva, total: nuevoTotal } = calcularTotalesVenta({ subtotal: nuevoSubtotal, sinIva });

  const abonoActual = Number(pedido.abono ?? 0);
  // Defecto E: sin Math.max — un negativo es saldo a favor del cliente.
  // determinarEstadoVenta ya trata saldo <= 0 como PAGADO.
  const nuevoSaldo = Number((nuevoTotal - abonoActual).toFixed(2));
  const totalOriginal = Number(pedido.total);
  const diferenciaTotal = Number((nuevoTotal - totalOriginal).toFixed(2));

  const { rows: creditoRows } = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM venta_pago vp
       WHERE vp.ventas_idventas = $1 AND vp.es_credito_anticipo = true AND vp.eliminado_at IS NULL
     ) AS es_credito_anticipo`,
    [pedido.idventas],
  );
  const esCreditoAnticipo = creditoRows[0]?.es_credito_anticipo === true;

  const umbralActivacion = calcularUmbralAnticipo(totalOriginal);
  const estadoResultante = determinarEstadoVenta(abonoActual, nuevoSaldo, umbralActivacion, esCreditoAnticipo);

  return {
    solicitudId,
    idventas: pedido.idventas,
    sinIva,
    productos,
    subtotalOriginal: Number(pedido.subtotal),
    ivaOriginal: Number(pedido.iva),
    totalOriginal,
    subtotalReal: nuevoSubtotal,
    ivaReal: nuevoIva,
    totalReal: nuevoTotal,
    herramentalTotal: Number(herramentalTotal.toFixed(2)),
    cargoAdicionalPapelTotal: Number(cargoAdicionalPapelTotal.toFixed(2)),
    diferenciaTotal,
    abonoActual,
    saldoNuevo: nuevoSaldo,
    estadoResultante,
  };
}

export interface GenerarEstadoCuentaOpts {
  usuarioId?: number | null;
  forzar?: boolean; // true = viene de POST /generar manual
}

export interface GenerarEstadoCuentaResultado {
  generado: boolean;
  motivo: "produccion_completa" | "correccion_produccion" | "manual" | "sin_cambios" | "produccion_incompleta";
  idestadoCuenta?: number;
  version?: number;
  faltantes?: string[];
  calculo?: EstadoCuentaCalculado;
}

const CENTAVO = 0.01;
const igualACentavo = (a: number, b: number) => Math.abs(a - b) < CENTAVO;

// ════════════════════════════════════════════════════════════════════════
// generarEstadoCuenta — calcula, versiona y escribe. Idempotente: si la
// versión vigente ya tiene los mismos números (subtotal/iva/total/saldo),
// no crea una nueva.
//
// Quien llama debe estar dentro de una transacción (client = cliente de
// esa transacción, no pool). Toma el advisory lock de la solicitud y
// relee `ventas ... FOR UPDATE` — mismo orden de locks que
// obtenerVentaBloqueada en ventas.controller.ts, así que no hay deadlock
// posible entre registrar un pago y generar un estado de cuenta.
// ════════════════════════════════════════════════════════════════════════
export async function generarEstadoCuenta(
  client: any,
  solicitudId: number,
  opts: GenerarEstadoCuentaOpts = {},
): Promise<GenerarEstadoCuentaResultado> {
  await bloquearSolicitudParaVenta(client, solicitudId);

  const produccion = await pedidoTieneProduccionCompleta(client, solicitudId);
  if (!produccion.completa) {
    return { generado: false, motivo: "produccion_incompleta", faltantes: produccion.faltantes };
  }

  // Releer la venta con FOR UPDATE ya con el advisory tomado — evita la
  // carrera del defecto B (leer abono, calcular, escribir muchas líneas
  // después con un abono ya obsoleto).
  const { rows: lockRows } = await client.query(
    `SELECT idventas FROM ventas WHERE solicitud_idsolicitud = $1 FOR UPDATE`,
    [solicitudId],
  );
  if (lockRows.length === 0) {
    throw new Error(`No existe venta para la solicitud ${solicitudId}`);
  }
  const idventas = lockRows[0].idventas;

  const calculo = await calcularEstadoCuenta(client, solicitudId);

  const { rows: vigenteRows } = await client.query(
    `SELECT idestado_cuenta, version, subtotal_real, iva_real, total_real, saldo_al_generar
     FROM estado_cuenta WHERE ventas_idventas = $1 AND vigente = true`,
    [idventas],
  );
  const vigente = vigenteRows[0] ?? null;

  if (vigente) {
    // OJO: la comparación es solo contra lo que depende de PRODUCCIÓN
    // (subtotal/iva/total real) — a propósito NO se compara saldo_al_generar
    // aquí. saldo_al_generar se mueve con cada pago, independientemente de
    // si la producción cambió, y este helper también se llama desde
    // editarProceso/editarProcesoPapel (corrección de un proceso ya
    // terminado). Si se comparara el saldo, cualquier pago recibido entre
    // dos correcciones haría que una edición que NO cambió nada de
    // producción se etiquetara como 'correccion_produccion' — motivo
    // engañoso para algo que en realidad fue solo un abono. abono/saldo
    // siempre están al día de todos modos vía el mirror en `ventas` (ver
    // más abajo), no necesitan una versión nueva de estado_cuenta.
    const sinCambios =
      igualACentavo(Number(vigente.subtotal_real), calculo.subtotalReal) &&
      igualACentavo(Number(vigente.iva_real), calculo.ivaReal) &&
      igualACentavo(Number(vigente.total_real), calculo.totalReal);

    if (sinCambios && !opts.forzar) {
      return { generado: false, motivo: "sin_cambios", idestadoCuenta: vigente.idestado_cuenta, version: vigente.version, calculo };
    }
  }

  const motivo = !vigente ? "produccion_completa" : (opts.forzar ? "manual" : "correccion_produccion");
  const nuevaVersion = vigente ? Number(vigente.version) + 1 : 1;

  if (vigente) {
    await client.query(`UPDATE estado_cuenta SET vigente = false WHERE idestado_cuenta = $1`, [vigente.idestado_cuenta]);
  }

  const { rows: insertRows } = await client.query(
    `INSERT INTO estado_cuenta (
       ventas_idventas, version, vigente, motivo, fecha_generacion,
       subtotal_original, iva_original, total_original,
       subtotal_real, iva_real, total_real,
       herramental_total, cargo_adicional_papel_total, diferencia_total,
       abono_al_generar, saldo_al_generar,
       estado_administrativo_resultante,
       creado_por
     ) VALUES (
       $1, $2, true, $3, NOW(),
       $4, $5, $6,
       $7, $8, $9,
       $10, $11, $12,
       $13, $14,
       $15,
       $16
     ) RETURNING idestado_cuenta`,
    [
      idventas, nuevaVersion, motivo,
      calculo.subtotalOriginal, calculo.ivaOriginal, calculo.totalOriginal,
      calculo.subtotalReal, calculo.ivaReal, calculo.totalReal,
      calculo.herramentalTotal, calculo.cargoAdicionalPapelTotal, calculo.diferenciaTotal,
      calculo.abonoActual, calculo.saldoNuevo,
      calculo.estadoResultante,
      opts.usuarioId ?? null,
    ],
  );
  const idestadoCuenta = insertRows[0].idestado_cuenta;

  for (const p of calculo.productos) {
    await client.query(
      `INSERT INTO estado_cuenta_detalle (
         estado_cuenta_idestado_cuenta, solicitud_producto_idsolicitud_producto,
         tipo_material, no_produccion, nombre, medida, material,
         modo_cantidad, cantidad_original, precio_total_original,
         cantidad_real, peso_kg_real, precio_unitario_real, precio_total_real,
         diferencia_cantidad, diferencia_precio,
         herramental_descripcion, herramental_precio, herramental_aprobado
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        idestadoCuenta, p.idsolicitud_producto,
        p.tipo_material, p.no_produccion, p.nombre, p.medida, p.material,
        p.modo_cantidad, p.cantidad_original, p.precio_total_original,
        p.cantidad_real, p.peso_kg_real, p.precio_unitario_real, p.precio_total_real,
        p.diferencia_cantidad, p.diferencia_precio,
        p.herramental_descripcion, p.herramental_precio, p.herramental_aprobado,
      ],
    );
  }

  // Mirror en ventas: sigue siendo útil para getVentas/getVentaById/
  // AnticipoLiquidacion (que muestran total_real/saldo sin tener que unirse
  // con estado_cuenta) y para el fix de Fase 6 (COALESCE(total_real, total)
  // en registrarPago/eliminarPago/autorizarAnticipoCredito). La diferencia
  // con el bug original es QUIÉN escribe esto y CUÁNDO: antes lo hacía
  // cualquier GET, sin lock, en cada lectura; ahora lo hace solo esta
  // función, con el advisory + FOR UPDATE ya tomados arriba.
  const liquidado = calculo.saldoNuevo <= 0.01;
  await client.query(
    `UPDATE ventas
     SET subtotal_real = $1, iva_real = $2, total_real = $3,
         saldo = $4, diferencia_total = $5,
         estado_administrativo_cat_idestado_administrativo_cat = $6
         ${liquidado ? ", fecha_liquidacion = COALESCE(fecha_liquidacion, NOW())" : ""}
     WHERE idventas = $7`,
    [
      calculo.subtotalReal, calculo.ivaReal, calculo.totalReal,
      calculo.saldoNuevo, calculo.diferenciaTotal, calculo.estadoResultante,
      idventas,
    ],
  );

  if (liquidado) {
    await client.query(
      `UPDATE estado_cuenta SET fecha_liquidacion = NOW() WHERE idestado_cuenta = $1`,
      [idestadoCuenta],
    );
  }

  return { generado: true, motivo, idestadoCuenta, version: nuevaVersion, calculo };
}

// ════════════════════════════════════════════════════════════════════════
// Helper de enganche — llamado desde los 4 puntos de la Fase 2/10:
//   - procesosController.finalizarProceso (rama else, siguienteProceso === null)
//   - procesosPapel.finalizarProcesoPapel (rama else, siguienteProceso === null)
//   - procesosController.editarProceso (regeneración tras corrección)
//   - procesosPapel.editarProcesoPapel (regeneración tras corrección)
//
// Resuelve idproduccion → solicitudId, verifica completitud y delega. Si
// el pedido tiene más de una orden y esta no es la última en terminar, no
// genera nada (pedidoTieneProduccionCompleta regresa completa=false) — no
// hace falta que el caller distinga "cerré el producto 1 de 3" de "cerré
// el último producto", el helper ya lo resuelve.
//
// forzar=false SIEMPRE aquí: el helper nunca fuerza motivo='manual', deja
// que generarEstadoCuenta decida entre 'produccion_completa' (primera vez)
// y 'correccion_produccion' (ya había una versión vigente y los números
// cambiaron) según corresponda.
// ════════════════════════════════════════════════════════════════════════
export async function generarEstadoCuentaSiPedidoCompleto(
  client: any,
  idproduccion: number,
  usuarioId?: number | null,
): Promise<GenerarEstadoCuentaResultado | null> {
  const { rows } = await client.query(
    `SELECT idsolicitud FROM orden_produccion WHERE idproduccion = $1`,
    [idproduccion],
  );
  const solicitudId = rows[0]?.idsolicitud;
  if (!solicitudId) return null;

  return generarEstadoCuenta(client, Number(solicitudId), { usuarioId });
}