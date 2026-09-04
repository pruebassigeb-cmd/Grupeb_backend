import { Request, Response } from "express";
import { pool } from "../../config/db";
import { getPresignedUrl } from "../../config/multer";
// ── MERMA DE PAPEL: enganche de Fase 7 (ver merma-papel-contexto.md) ──
// Ajusta los pliegos estimados (aquí y en el PDF) para que incluyan la
// merma tolerada ya congelada en orden_produccion_merma, sin tocar la
// cantidad del pedido que se le muestra al cliente.
import { getMermaDeOrdenBatch } from "../../services/producto_papel/merma.service";
// ── NUEVO: lectura de la ruta real de procesos de una OP de papel, ya
// resuelta a tabla/nombre -- misma fuente de verdad que usa el motor de
// producción (procesosPapel.controller.ts) para decidir la cascada, tanto
// para papel normal (flags de solicitud_producto_papel) como para
// especiales (componente_papel_proceso). Evita reimplementar esa lógica
// aquí por separado, que es justo el tipo de duplicado que se desincroniza
// solo (Jose, 2026-09-02: "sigamos con lo que quedó pendiente para las
// órdenes de producción" -- ver contexto de productos especiales).
// AJUSTA ESTA RUTA si procesosPapel.controller.ts no vive en el mismo
// directorio que este archivo -- ambos importan "../../config/db" con la
// misma profundidad, así que se asume mismo directorio.
import { getProcesosDeOrdenPapelConTabla, unionEsperandoHermanasPapel, piezasFinalesHermanasPapel } from "../producto_papel/procesosPapel.controller";
// ── NUEVO: estado de cuenta / cuentas por cobrar (plan-estado-cuenta-cobranza-v2.md) ──
// Reutiliza el util que ya existe para el reporte semanal — mismo
// contarDiasHabiles, no se duplica.
import { contarDiasHabiles } from "../../utils/diasHabiles";

// Umbral de negocio, específico de este endpoint (no de contarDiasHabiles):
// a partir de cuántos días hábiles desde la generación del estado de cuenta
// un pedido con saldo pendiente entra a "Cuentas por cobrar". Decisión
// cerrada con Jose: 5 días hábiles (no 8, no calendario).
const DIAS_HABILES_VENCIMIENTO_ESTADO_CUENTA = 5;

// ── Descarga imagen desde S3 y la retorna como data URL base64 ──
async function publicIdToBase64(publicId: string): Promise<string | null> {
  try {
    const url = await getPresignedUrl(publicId);
    const response = await fetch(url);

    if (!response.ok) {
      console.warn(`⚠️ publicIdToBase64: fetch failed ${response.status} para ${publicId}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mime = response.headers.get("content-type") || "image/png";

    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch (e: any) {
    console.error("❌ publicIdToBase64 error:", e.message);
    return null;
  }
}

const toNumberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

const splitMedidaCm = (value: unknown): number[] => {
  if (value === null || value === undefined) return [];
  return String(value)
    .replace(/,/g, ".")
    .match(/\d+(?:\.\d+)?/g)
    ?.map((n) => Number(n))
    .filter((n) => Number.isFinite(n)) ?? [];
};

const primeraMedidaCm = (...values: unknown[]): number | null => {
  for (const value of values) {
    const medidas = splitMedidaCm(value);
    if (medidas.length > 0) return medidas[0];
  }
  return null;
};

const ultimaMedidaCm = (...values: unknown[]): number | null => {
  for (const value of values) {
    const medidas = splitMedidaCm(value);
    if (medidas.length > 0) return medidas[medidas.length - 1];
  }
  return null;
};

// CORREGIDO: la fórmula multiplicaba (cantidad x rendimiento) cuando en
// realidad rendimiento es "bolsas que rinde cada pliego", así que los
// pliegos que hacen falta son cantidad / rendimiento -- ej. cantidad=2000
// y rendimiento=0.5 (cada pliego rinde media bolsa, o sea hacen falta 2
// pliegos por bolsa) => 2000 / 0.5 = 4000 pliegos, no 1000. Comparte esta
// función con el cálculo del PDF (getOrdenProduccion), así que el mismo
// arreglo aplica ahí también.
// CORREGIDO (2026-08-21): los pliegos se redondean SIEMPRE hacia arriba.
// Un pliego es una hoja física — no existe medio pliego — y Jose confirmó
// que cualquier decimal sube al entero siguiente (1.1 pliegos son 2). Antes
// se dejaba el decimal (105.625) y se arrastraba a metros de laminación,
// rollos y bolsas armadas.
const calcularPliegosPorRendimiento = (cantidad: unknown, rendimiento: unknown): number | null => {
  const cantidadNum = toNumberOrNull(cantidad);
  const rendimientoNum = toNumberOrNull(rendimiento);
  if (cantidadNum === null || rendimientoNum === null || rendimientoNum <= 0) return null;
  return Math.ceil(cantidadNum / rendimientoNum);
};

// La merma se suma AQUÍ: sobre los cortes ya convertidos, no sobre la
// cantidad pedida. Ver la nota de R1 en merma.service.ts para el porqué.
const sumarMermaACortes = (cortes: unknown, mermaTotal: unknown): number | null => {
  const cortesNum = toNumberOrNull(cortes);
  if (cortesNum === null) return null;
  return round2(cortesNum + (toNumberOrNull(mermaTotal) ?? 0));
};

// Máquina real: una vez que los pliegos subieron a entero, lo que de verdad
// entra a la máquina es pliegos x rendimiento — no el valor con decimales
// de antes de redondear (bloque D10:N12 de "papel formula.xlsx": 106
// pliegos x rend 4 = 424, no 422.5).
const calcularMaquinaDesdePliegos = (pliegos: unknown, rendimiento: unknown): number | null => {
  const pliegosNum = toNumberOrNull(pliegos);
  const rendimientoNum = toNumberOrNull(rendimiento);
  if (pliegosNum === null || rendimientoNum === null || rendimientoNum <= 0) return null;
  return round2(pliegosNum * rendimientoNum);
};

// Paso intermedio confirmado por Jose (2026-08-13) con ejemplo numérico:
// cantidad con merma 3150, PZS de suaje 0.5 => 3150/0.5 = 6300 cortes.
// De ahí, cortes / REND. (fila principal de Tipo de Papel) = pliegos, y
// cortes / REND. (fila Hojeado) = cantidad hojeada. Antes de este cambio
// cantidad/rendimiento se calculaba directo, saltándose este paso -- por
// eso pliegos/hojeado salían mal para cualquier producto con PZS != 1.
const calcularCortes = (cantidad: unknown, piezasSuaje: unknown): number | null => {
  const cantidadNum = toNumberOrNull(cantidad);
  const piezasSuajeNum = toNumberOrNull(piezasSuaje);
  if (cantidadNum === null || piezasSuajeNum === null || piezasSuajeNum <= 0) return null;
  return round2(cantidadNum / piezasSuajeNum);
};

const calcularBolsasPorRendimiento = (pliegos: unknown, rendimiento: unknown): number | null => {
  const pliegosNum = toNumberOrNull(pliegos);
  const rendimientoNum = toNumberOrNull(rendimiento);
  if (pliegosNum === null || rendimientoNum === null || rendimientoNum <= 0) return null;
  return round2(pliegosNum / rendimientoNum);
};

const calcularDesarrolloMm = (...medidas: unknown[]): number | null => {
  const largoCm = ultimaMedidaCm(...medidas);
  return largoCm === null ? null : round2(largoCm * 10);
};

const calcularCtesMod = (...medidas: unknown[]): string | null => {
  const largoCm = ultimaMedidaCm(...medidas);
  if (largoCm === null) return null;
  return `${round2((largoCm - 0.5) * 0.3937)}"`;
};

// CORREGIDO (2026-08-24, confirmado por Jose): CTES/Mod se deriva del MISMO
// desarrollo que cobra el costo de laminado (acabados_papel.desarrollo_laminado),
// no del largo del pliego -- es la medida de la pieza que ve la película.
// Recibe el desarrollo ya resuelto en mm, así que hereda gratis la prioridad
// del valor capturado sobre el cálculo automático.
const calcularCtesModDesdeDesarrollo = (desarrolloMm: unknown): string | null => {
  const desarrolloNum = toNumberOrNull(desarrolloMm);
  if (desarrolloNum === null || desarrolloNum <= 0) return null;
  return `${round2((desarrolloNum / 10 - 0.5) * 0.3937)}"`;
};

const calcularMetrosLaminacion = (pliegos: unknown, desarrolloMm: unknown): number | null => {
  const pliegosNum = toNumberOrNull(pliegos);
  const desarrolloNum = toNumberOrNull(desarrolloMm);
  if (pliegosNum === null || desarrolloNum === null || desarrolloNum <= 0) return null;
  return round2((pliegosNum * desarrolloNum) / 1000);
};

// Un pedido puede tener varias cantidades vigentes para el mismo producto.
// Seguimiento necesita una sola fila canónica, por eso agrega únicamente los
// detalles aprobados en lugar de multiplicar el producto por cada detalle.
const JOIN_DETALLES_APROBADOS_AGREGADOS = `
  LEFT JOIN LATERAL (
    SELECT
      SUM(sd0.cantidad) AS cantidad,
      SUM(sd0.kilogramos) AS kilogramos,
      CASE
        WHEN COUNT(*) > 0
         AND BOOL_AND(COALESCE(sd0.modo_cantidad, 'unidad') = 'kilo')
        THEN 'kilo'
        ELSE 'unidad'
      END AS modo_cantidad
    FROM solicitud_detalle sd0
    WHERE sd0.solicitud_producto_id = sp.idsolicitud_producto
      AND sd0.aprobado = true
  ) sd ON true
`;

// ============================================================
// GET /api/seguimiento
// ============================================================
export const getSeguimiento = async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    // ── Query de PLÁSTICO (idéntico al original, sin cambios) ──────────
    const { rows: rowsPlastico } = await pool.query(`
      SELECT
        s.idsolicitud,
        sp.idsolicitud_producto,
        s.no_pedido,
        s.no_cotizacion,
        s.fecha,
        s.prioridad,
        cli.razon_social                              AS cliente,
        cli.impresion                                 AS impresion,
        pr.tipo_producto                              AS tipo_producto,
        v.anticipo                                    AS anticipo_requerido,
        v.abono                                       AS anticipo_pagado,
        CASE WHEN v.abono >= v.anticipo
              OR v.estado_administrativo_cat_idestado_administrativo_cat IN (2, 6)
             THEN true ELSE false END                 AS anticipo_cubierto,
        CASE WHEN v.saldo <= 0.01
             THEN true ELSE false END                 AS pago_completo,
        v.saldo                                       AS saldo_venta,

        dp.estado_administrativo_cat_idestado_administrativo_cat AS producto_diseno_estado_id,
        CASE WHEN dp.estado_administrativo_cat_idestado_administrativo_cat = 3
             THEN true ELSE false END                 AS producto_diseno_aprobado,

        op.no_produccion,
        op.idproduccion,
        op.fecha                                        AS fecha_habilitacion_orden,

        CASE WHEN (v.abono >= v.anticipo OR v.estado_administrativo_cat_idestado_administrativo_cat IN (2, 6))
              AND dp.estado_administrativo_cat_idestado_administrativo_cat = 3
              AND op.no_produccion IS NOT NULL
             THEN true ELSE false END                 AS puede_pdf,

        ext.estado_produccion_cat_idestado_produccion_cat  AS extrusion_estado_id,
        imp.estado_produccion_cat_idestado_produccion_cat  AS impresion_estado_id,
        bol.estado_produccion_cat_idestado_produccion_cat  AS bolseo_estado_id,
        asa.estado_produccion_cat_idestado_produccion_cat  AS asa_flexible_estado_id,

        CASE WHEN ext.fecha_fin IS NULL THEN ext.fecha_inicio ELSE NULL END AS extrusion_fecha_estado,
        CASE WHEN imp.fecha_fin IS NULL THEN imp.fecha_inicio ELSE NULL END AS impresion_fecha_estado,
        CASE WHEN bol.fecha_fin IS NULL THEN bol.fecha_inicio ELSE NULL END AS bolseo_fecha_estado,
        CASE WHEN asa.fecha_fin IS NULL THEN asa.fecha_inicio ELSE NULL END AS asa_flexible_fecha_estado,
        -- ✅ NUEVO: fecha real en que terminó cada proceso. Las columnas
        -- *_fecha_estado de arriba se ponen NULL justo al finalizar (solo
        -- miden "desde cuándo lleva sin cambio" mientras está pendiente/en
        -- proceso, igual que pago_fecha_estado), así que no servían para
        -- mostrar la fecha de término bajo el badge — este campo es el que
        -- sí, igual que ya hace papel con fecha_fin en su propio registro.
        ext.fecha_fin AS extrusion_fecha_fin,
        imp.fecha_fin AS impresion_fecha_fin,
        bol.fecha_fin AS bolseo_fecha_fin,
        asa.fecha_fin AS asa_flexible_fecha_fin,

        CASE WHEN v.abono < v.anticipo
              AND v.estado_administrativo_cat_idestado_administrativo_cat NOT IN (2, 6)
             THEN v.fecha_creacion ELSE NULL END                            AS anticipo_fecha_estado,
        CASE WHEN v.saldo > 0.01
             THEN v.fecha_creacion ELSE NULL END                            AS pago_fecha_estado,
        -- ✅ NUEVO: fecha real en que el saldo llegó a 0 (registrarPago pone
        -- fecha_liquidacion = NOW() justo cuando esto pasa — ver
        -- ventas.controller.ts). pago_fecha_estado de arriba se queda NULL
        -- una vez pagado (solo mide "desde cuándo lleva pendiente"), así que
        -- no servía para mostrar cuándo se liquidó — este campo es el que sí.
        v.fecha_liquidacion                                                 AS pago_fecha_liquidacion,
        CASE WHEN dp.estado_administrativo_cat_idestado_administrativo_cat != 3
             THEN d.fecha ELSE NULL END                                     AS diseno_fecha_estado,
        CASE WHEN od.estado != 'aprobado'
             THEN od.created_at ELSE NULL END                               AS od_fecha_estado,
        -- ✅ NUEVO: fecha real de aprobación de la orden de diseño (para
        -- mostrarla debajo del badge de OD, no solo usarla para colorear).
        od.autorizado_at                                                    AS od_fecha_aprobacion,
        -- ✅ NUEVO: fecha real en que el acumulado de pagos alcanzó el
        -- anticipo requerido — mismo valor que ya se usaba para calcular
        -- op_fecha_aprobacion, ahora expuesto también como su propio campo
        -- para pintarlo debajo del badge de ANTICIPO.
        fap.fecha                                                           AS anticipo_fecha_aprobacion,
        -- ✅ NUEVO: fecha real de aprobación del diseño DE ESTE PRODUCTO
        -- (diseno_producto.fecha_aprobacion), o si no la tiene, la fecha de
        -- aprobación general de la orden completa — para pintarla debajo
        -- del badge de DISEÑO.
        COALESCE(dp.fecha_aprobacion, d.fecha_aprobacion_general)          AS diseno_fecha_aprobacion,
        -- ✅ NUEVO: fecha en que quedó habilitado el PDF de orden de
        -- producción — el mayor entre (anticipo/pago cubierto) y (diseño
        -- aprobado), que son las dos condiciones de puede_pdf.
        CASE WHEN (v.abono >= v.anticipo OR v.estado_administrativo_cat_idestado_administrativo_cat IN (2, 6))
              AND dp.estado_administrativo_cat_idestado_administrativo_cat = 3
             THEN GREATEST(
               COALESCE(fap.fecha, v.fecha_creacion),
               COALESCE(dp.fecha_aprobacion, d.fecha_aprobacion_general)
             )
             ELSE NULL END                                                  AS op_fecha_aprobacion,

        -- ── Envío: calculado por orden de producción (op.idproduccion), no por solicitud ──
        -- (antes venía de un JOIN a nivel solicitud que duplicaba filas si
        -- había más de un envío por pedido; ahora son subqueries correlacionadas)
        (
          SELECT COUNT(DISTINCT b.idbulto)
          FROM bultos b
          WHERE op.idproduccion IS NOT NULL AND (
            b.bolseo_idbolseo IN (SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = op.idproduccion)
            OR
            b.asa_flexible_idasa_flexible IN (SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = op.idproduccion)
          )
        ) AS envio_total_bultos,
        (
          SELECT COUNT(DISTINCT eb.bultos_idbulto)
          FROM envio_bulto eb
          JOIN bultos b ON b.idbulto = eb.bultos_idbulto
          WHERE op.idproduccion IS NOT NULL AND (
            b.bolseo_idbolseo IN (SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = op.idproduccion)
            OR
            b.asa_flexible_idasa_flexible IN (SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = op.idproduccion)
          )
        ) AS envio_bultos_enviados,
        (
          SELECT MAX(e2.fecha_envio)
          FROM envio e2
          JOIN envio_bulto eb2 ON eb2.envio_idenvio = e2.idenvio
          JOIN bultos b2 ON b2.idbulto = eb2.bultos_idbulto
          WHERE op.idproduccion IS NOT NULL AND (
            b2.bolseo_idbolseo IN (SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = op.idproduccion)
            OR
            b2.asa_flexible_idasa_flexible IN (SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = op.idproduccion)
          )
        ) AS envio_fecha_estado,

        EXISTS (
          SELECT 1 FROM tipo_producto_plastico_proceso tppp2
          WHERE tppp2.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
          AND tppp2.idproceso_cat = 1
        ) AS lleva_extrusion,
        EXISTS (
          SELECT 1 FROM tipo_producto_plastico_proceso tppp2
          WHERE tppp2.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
          AND tppp2.idproceso_cat = 2
        ) AS lleva_impresion,
        EXISTS (
          SELECT 1 FROM tipo_producto_plastico_proceso tppp2
          WHERE tppp2.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
          AND tppp2.idproceso_cat = 5
        ) AS lleva_bolseo,
        EXISTS (
          SELECT 1 FROM tipo_producto_plastico_proceso tppp2
          WHERE tppp2.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
          AND tppp2.idproceso_cat = 3
        ) AS lleva_asa_flexible,

        cfg.medida,
        cfg.altura,
        cfg.ancho,
        cfg.fuelle_fondo,
        cfg.fuelle_latIz  AS fuelle_lat_iz,
        cfg.fuelle_latDe  AS fuelle_lat_de,
        cfg.refuerzo,
        cfg.por_kilo,
        tpp.material_plastico_producto  AS nombre_producto,
        mp.tipo_material                AS material,
        cal.calibre                     AS calibre_numero,
        cal.calibre_bopp                AS calibre_bopp,
        t.cantidad                      AS tintas,
        car.cantidad                    AS caras,
        sp.pigmentos,
        sp.pantones,
        sp.observacion,
        sp.perforacion,
        sp.descripcion,
        asz.tipo                        AS asa_suaje,

        sp.id_color,
        ca.color                        AS color_asa_nombre,

        sp.id_medidatro,
        mt.medida                       AS medida_troquel,

        sd.cantidad                     AS cantidad_orden,
        sd.kilogramos                   AS kilogramos_orden,
        sd.modo_cantidad,

        op.kilos,
        op.kilos_merma,
        op.pzas,
        op.pzas_merma,
        op.metros_merma,
        op.repeticion_extrusion,
        op.es_parcialidad,

        od.idorden_diseno,
        od.estado                       AS od_estado,
        -- ✅ NUEVO: ¿ya se subió al menos un archivo (render/master/feedback)
        -- a esta orden de diseño? Sirve para distinguir en el badge "OD"
        -- un aprobado administrativo real de uno aprobado sin que nadie
        -- haya subido todavía el diseño en sí (caso anómalo que Jose pidió
        -- marcar en naranja aunque el texto siga diciendo "Aprobado").
        EXISTS (
          SELECT 1
          FROM revision_diseno rd_chk
          JOIN archivos ar_chk ON ar_chk.revision_diseno_id = rd_chk.idrevision
          WHERE rd_chk.orden_diseno_id = od.idorden_diseno
        )                                AS od_tiene_archivos

      FROM solicitud s
      LEFT JOIN clientes cli
          ON cli.idclientes = s.clientes_idclientes
      LEFT JOIN solicitud_producto sp
          ON sp.solicitud_idsolicitud = s.idsolicitud
      LEFT JOIN configuracion_plastico cfg
          ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN tipo_producto_plastico tpp
          ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN productos pr
          ON pr.idproductos = tpp.productos_idproductos
      LEFT JOIN ventas v
          ON v.solicitud_idsolicitud = s.idsolicitud
      -- ✅ NUEVO: fecha en que el acumulado de venta_pago alcanzó el
      -- anticipo requerido (para mostrar debajo del PDF de orden de
      -- producción cuándo quedó "aprobado" el pago que la desbloqueó).
      LEFT JOIN LATERAL (
        -- LEAST ignora los NULL (solo da NULL si las dos partes lo son),
        -- así que sirve de COALESCE-por-fecha-más-temprana entre las dos
        -- formas de cubrir el anticipo:
        --   · pago acumulado alcanza el monto requerido
        --   · anticipo autorizado por crédito (venta_pago con monto=0 y
        --     es_credito_anticipo=true — nunca suma al acumulado de arriba,
        --     así que sin esto el anticipo por crédito quedaba sin fecha)
        SELECT LEAST(
          (SELECT MIN(x.fecha)
             FROM (
               SELECT vp.fecha,
                      SUM(vp.monto_moneda_venta) OVER (ORDER BY vp.fecha, vp.idventa_pago) AS acumulado
                 FROM venta_pago vp
                WHERE vp.ventas_idventas = v.idventas AND vp.eliminado_at IS NULL
             ) x
            WHERE x.acumulado >= v.anticipo),
          (SELECT MIN(vp2.fecha)
             FROM venta_pago vp2
            WHERE vp2.ventas_idventas = v.idventas
              AND vp2.es_credito_anticipo = true
              AND vp2.eliminado_at IS NULL)
        ) AS fecha
      ) fap ON true
      LEFT JOIN diseno d
          ON d.solicitud_idsolicitud = s.idsolicitud
      LEFT JOIN diseno_producto dp
          ON dp.diseno_iddiseno = d.iddiseno
          AND dp.solicitud_producto_idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN orden_produccion op
          ON op.idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN extrusion ext
          ON ext.orden_produccion_idproduccion = op.idproduccion
      LEFT JOIN impresion imp
          ON imp.orden_produccion_idproduccion = op.idproduccion
      LEFT JOIN bolseo bol
          ON bol.orden_produccion_idproduccion = op.idproduccion
      LEFT JOIN asa_flexible asa
          ON asa.orden_produccion_idproduccion = op.idproduccion
      LEFT JOIN material_plastico mp
          ON mp.idmaterial_plastico = cfg.material_plastico_plastico_idmaterial_plastico
      LEFT JOIN calibre cal
          ON cal.idcalibre = cfg.calibre_idcalibre
      LEFT JOIN tintas t
          ON t.idtintas = sp.tintas_idtintas
      LEFT JOIN caras car
          ON car.idcaras = sp.caras_idcaras
      LEFT JOIN asa_suaje asz
          ON asz.idsuaje = sp.idsuaje
      LEFT JOIN color_asa ca
          ON ca.id_color = sp.id_color
      LEFT JOIN medidas_troquel mt
          ON mt.id_medidatro = sp.id_medidatro
      ${JOIN_DETALLES_APROBADOS_AGREGADOS}
      LEFT JOIN orden_diseno od
          ON od.solicitud_producto_id = sp.idsolicitud_producto

      WHERE s.estado = 'pedido'
        AND s.no_pedido IS NOT NULL
        AND sp.tipo_material = 'plastico'

      ORDER BY s.no_pedido DESC, sp.idsolicitud_producto ASC
    `);

    // ── Query de PAPEL (nuevo, independiente) ───────────────────────────
    // Mismo nivel de detalle administrativo (anticipo, diseño, OD, envío)
    // que plástico, pero la ficha del producto se resuelve vía
    // grupo_papel -> producto_papel -> cat_tipo_producto_papel, y
    // grupo_papel -> detalle_material_papel -> cat_tipo_papel/cat_calibre.
    // El estado de producción NO se desglosa en columnas Ext/Imp/Bol/Asa
    // (no aplica a papel, que tiene hasta 11 procesos dinámicos) — en su
    // lugar se calcula un único estado_resumen_papel que el frontend usa
    // para pintar la columna "Producción" (ver mapEstadoResumenPapel).
    const { rows: rowsPapel } = await pool.query(`
      SELECT
        s.idsolicitud,
        sp.idsolicitud_producto,
        s.no_pedido,
        s.no_cotizacion,
        s.fecha,
        s.prioridad,
        cli.razon_social                              AS cliente,
        cli.empresa,
        cli.impresion                                 AS impresion,

        v.anticipo                                    AS anticipo_requerido,
        v.abono                                        AS anticipo_pagado,
        CASE WHEN v.abono >= v.anticipo
              OR v.estado_administrativo_cat_idestado_administrativo_cat IN (2, 6)
             THEN true ELSE false END                 AS anticipo_cubierto,
        CASE WHEN v.saldo <= 0.01
             THEN true ELSE false END                 AS pago_completo,
        v.saldo                                       AS saldo_venta,

        dp.estado_administrativo_cat_idestado_administrativo_cat AS producto_diseno_estado_id,
        CASE WHEN dp.estado_administrativo_cat_idestado_administrativo_cat = 3
             THEN true ELSE false END                 AS producto_diseno_aprobado,

        op.no_produccion,
        op.idproduccion,
        op.fecha                                        AS fecha_habilitacion_orden,

        -- ── Especiales: a qué componente pertenece ESTA OP ──────────────
        -- Igual que en getOrdenProduccion (ver la nota ahí): op.idcomponente_papel
        -- IS NULL para papel normal y para el modo "misma orden" de un
        -- especial de un solo componente; con varios componentes, el JOIN
        -- sin restringir a op (por idsolicitud_producto) ya regresaba una
        -- fila por cada OP real -- lo que faltaba era ESTO, para que
        -- Seguimiento.tsx pueda distinguir/agrupar esas filas en vez de
        -- verlas como "duplicados" del mismo producto y quedarse solo con
        -- una (ver el filtro de dedupe en el frontend).
        op.idcomponente_papel,
        cp.tipo        AS componente_tipo,
        cp.nombre      AS componente_nombre,
        cp.orden       AS componente_orden,
        pp.es_especial,

        CASE WHEN (v.abono >= v.anticipo OR v.estado_administrativo_cat_idestado_administrativo_cat IN (2, 6))
              AND dp.estado_administrativo_cat_idestado_administrativo_cat = 3
              AND op.no_produccion IS NOT NULL
             THEN true ELSE false END                 AS puede_pdf,

        CASE WHEN v.abono < v.anticipo
              AND v.estado_administrativo_cat_idestado_administrativo_cat NOT IN (2, 6)
             THEN v.fecha_creacion ELSE NULL END                            AS anticipo_fecha_estado,
        CASE WHEN v.saldo > 0.01
             THEN v.fecha_creacion ELSE NULL END                            AS pago_fecha_estado,
        -- ✅ NUEVO: fecha real en que el saldo llegó a 0 (registrarPago pone
        -- fecha_liquidacion = NOW() justo cuando esto pasa — ver
        -- ventas.controller.ts). pago_fecha_estado de arriba se queda NULL
        -- una vez pagado (solo mide "desde cuándo lleva pendiente"), así que
        -- no servía para mostrar cuándo se liquidó — este campo es el que sí.
        v.fecha_liquidacion                                                 AS pago_fecha_liquidacion,
        CASE WHEN dp.estado_administrativo_cat_idestado_administrativo_cat != 3
             THEN d.fecha ELSE NULL END                                     AS diseno_fecha_estado,
        CASE WHEN od.estado != 'aprobado'
             THEN od.created_at ELSE NULL END                               AS od_fecha_estado,
        -- ✅ NUEVO: fecha real de aprobación de la orden de diseño (para
        -- mostrarla debajo del badge de OD, no solo usarla para colorear).
        od.autorizado_at                                                    AS od_fecha_aprobacion,
        -- ✅ NUEVO: fecha real en que el acumulado de pagos alcanzó el
        -- anticipo requerido — mismo valor que ya se usaba para calcular
        -- op_fecha_aprobacion, ahora expuesto también como su propio campo
        -- para pintarlo debajo del badge de ANTICIPO.
        fap.fecha                                                           AS anticipo_fecha_aprobacion,
        -- ✅ NUEVO: fecha real de aprobación del diseño DE ESTE PRODUCTO
        -- (diseno_producto.fecha_aprobacion), o si no la tiene, la fecha de
        -- aprobación general de la orden completa — para pintarla debajo
        -- del badge de DISEÑO.
        COALESCE(dp.fecha_aprobacion, d.fecha_aprobacion_general)          AS diseno_fecha_aprobacion,
        -- ✅ NUEVO: fecha en que quedó habilitado el PDF de orden de
        -- producción — el mayor entre (anticipo/pago cubierto) y (diseño
        -- aprobado), que son las dos condiciones de puede_pdf.
        CASE WHEN (v.abono >= v.anticipo OR v.estado_administrativo_cat_idestado_administrativo_cat IN (2, 6))
              AND dp.estado_administrativo_cat_idestado_administrativo_cat = 3
             THEN GREATEST(
               COALESCE(fap.fecha, v.fecha_creacion),
               COALESCE(dp.fecha_aprobacion, d.fecha_aprobacion_general)
             )
             ELSE NULL END                                                  AS op_fecha_aprobacion,

        -- ── Envío: mismo criterio que plástico (subquery por orden). Ya
        -- incluye bultos.empaque_papel_idempaque_papel — esa columna (y su
        -- FK) ya existen en la BD con el comentario "exactamente uno de los
        -- tres debe estar lleno por fila" (bolseo / asa_flexible / empaque
        -- papel), pero esta query solo revisaba los dos primeros, así que
        -- para papel siempre daba 0 bultos aunque el proceso de Empaque ya
        -- estuviera generando "cajas" — ahora sí las cuenta.
        (
          SELECT COUNT(DISTINCT b.idbulto)
          FROM bultos b
          WHERE op.idproduccion IS NOT NULL AND (
            b.bolseo_idbolseo IN (SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = op.idproduccion)
            OR
            b.asa_flexible_idasa_flexible IN (SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = op.idproduccion)
            OR
            b.empaque_papel_idempaque_papel IN (SELECT idempaque_papel FROM empaque_papel WHERE orden_produccion_idproduccion = op.idproduccion)
          )
        ) AS envio_total_bultos,
        (
          SELECT COUNT(DISTINCT eb.bultos_idbulto)
          FROM envio_bulto eb
          JOIN bultos b ON b.idbulto = eb.bultos_idbulto
          WHERE op.idproduccion IS NOT NULL AND (
            b.bolseo_idbolseo IN (SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = op.idproduccion)
            OR
            b.asa_flexible_idasa_flexible IN (SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = op.idproduccion)
            OR
            b.empaque_papel_idempaque_papel IN (SELECT idempaque_papel FROM empaque_papel WHERE orden_produccion_idproduccion = op.idproduccion)
          )
        ) AS envio_bultos_enviados,
        (
          SELECT MAX(e2.fecha_envio)
          FROM envio e2
          JOIN envio_bulto eb2 ON eb2.envio_idenvio = e2.idenvio
          JOIN bultos b2 ON b2.idbulto = eb2.bultos_idbulto
          WHERE op.idproduccion IS NOT NULL AND (
            b2.bolseo_idbolseo IN (SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = op.idproduccion)
            OR
            b2.asa_flexible_idasa_flexible IN (SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = op.idproduccion)
            OR
            b2.empaque_papel_idempaque_papel IN (SELECT idempaque_papel FROM empaque_papel WHERE orden_produccion_idproduccion = op.idproduccion)
          )
        ) AS envio_fecha_estado,

        -- ── Ficha del producto de papel ──
        pp.idproducto_papel,
        ctpp.nombre                     AS nombre_producto,
        pp.medida,
        pp.ancho,
        pp.fuelle,
        pp.altura,
        dmp.idcat_tipo_papel,
        ctp.nombre                      AS material,
        dmp.idcat_calibre,
        cc.nombre                       AS calibre,
        dmp.pliego,
        dmp.rendimiento,
        dmp.corte,
        dmp.hoj_bobina,
        dmp.hoj_corte,
        dmp.hoj_rendimiento,
        suaje_seg.piezas_suaje,
        dmp.hoj_bobina_extra,
        dmp.hoj_guillotina,

        -- ── Specs de la solicitud (lo que el cliente eligió) ──
        t.cantidad                      AS tintas_frente,
        sp.pantones                     AS pantones_frente,
        tdentro.cantidad                AS tintas_dentro,
        spp.pantones_dentro,
        spp.metodo_hojeado,
        spp.lleva_armado,
        spp.uv,
        spp.alto_relieve,
        catlam.nombre                   AS laminado_acabado,
        CASE WHEN f.colorfoil IS NOT NULL
             THEN f.colorfoil || COALESCE(' ' || f.codigofoil, '')
             ELSE NULL END              AS foil_nombre,
        ctex.nombre                     AS textura_nombre,
        cta.nombre                      AS asa_tipo,
        sp.descripcion,
        sp.observacion,
        sp.perforacion,

        -- ── Acabados de la FICHA del producto (no de la solicitud) ──
        -- acabados_papel cuelga de idproducto_papel, no de
        -- idsolicitud_producto: son propiedades fijas del producto base,
        -- no algo que el cliente elige por pedido (a diferencia de
        -- laminado/UV/foil/textura, que sí viven en solicitud_producto_papel).
        ctpegado.nombre                 AS tipo_pegue,
        ctpega.nombre                   AS pegamento,
        ap.desarrollo_laminado,
        rl.medida_ancho                 AS rollo_lam_medida_ancho,
        ctrefm.nombre                   AS refuerzo_material,
        ctrefmed.nombre                 AS refuerzo_medida,
        -- base_material: SIN catálogo real -- acabados_papel.idcat_base_material
        -- apunta a una tabla cat_base_material que nunca se creó en el DDL.
        -- Se omite el JOIN; base_material queda fijo en null en el mapeo
        -- final hasta que decidan si de verdad necesitan ese catálogo.
        ap.base_medida,
        ctemp.nombre                    AS tipo_caja,
        ap.pzs_caja                     AS cantidad_por_caja,

        sd.cantidad                     AS cantidad_orden,
        sd.kilogramos                   AS kilogramos_orden,
        sd.modo_cantidad,

        od.idorden_diseno,
        od.estado                       AS od_estado,
        -- ✅ NUEVO: ¿ya se subió al menos un archivo (render/master/feedback)
        -- a esta orden de diseño? Sirve para distinguir en el badge "OD"
        -- un aprobado administrativo real de uno aprobado sin que nadie
        -- haya subido todavía el diseño en sí (caso anómalo que Jose pidió
        -- marcar en naranja aunque el texto siga diciendo "Aprobado").
        EXISTS (
          SELECT 1
          FROM revision_diseno rd_chk
          JOIN archivos ar_chk ON ar_chk.revision_diseno_id = rd_chk.idrevision
          WHERE rd_chk.orden_diseno_id = od.idorden_diseno
        )                                AS od_tiene_archivos

      FROM solicitud s
      LEFT JOIN clientes cli
          ON cli.idclientes = s.clientes_idclientes
      LEFT JOIN solicitud_producto sp
          ON sp.solicitud_idsolicitud = s.idsolicitud
      LEFT JOIN solicitud_producto_papel spp
          ON spp.idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN grupo_papel gp
          ON gp.idgrupo_papel = sp.grupo_papel_idgrupo_papel
      LEFT JOIN producto_papel pp
          ON pp.idproducto_papel = COALESCE(sp.producto_papel_idproducto_papel, gp.idproducto_papel)
      LEFT JOIN cat_tipo_producto_papel ctpp
          ON ctpp.idcat_tipo_producto_papel = pp.idcat_tipo_producto_papel
      -- op y cp se adelantan aquí (antes vivían más abajo, después de
      -- diseno_producto) porque los LATERAL de dmp/suaje_seg de abajo
      -- necesitan leer op.idcomponente_papel -- un LATERAL (y, en general,
      -- cualquier ON de este FROM) solo puede referenciar tablas que ya
      -- aparecieron ANTES en la cadena de JOINs, así que si op se unía
      -- después, esas subconsultas tronaban con "column op.idcomponente_papel
      -- does not exist" (500 real en /api/seguimiento).
      LEFT JOIN orden_produccion op
          ON op.idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN componente_papel cp
          ON cp.idcomponente_papel = op.idcomponente_papel
      -- Especiales: la ficha de material es POR COMPONENTE, no del producto
      -- completo (ver detalle_material_papel.idcomponente_papel en
      -- fase1_productos_especiales_up.sql). Mismo patrón CASE que ya usa
      -- getOrdenProduccion -- sin esto, cada OP de un especial mostraba en
      -- Seguimiento la ficha del producto entero en vez de la suya propia.
      LEFT JOIN LATERAL (
        SELECT dm.*
        FROM detalle_material_papel dm
        WHERE
          CASE
            WHEN op.idcomponente_papel IS NOT NULL THEN dm.idcomponente_papel = op.idcomponente_papel
            ELSE dm.idgrupo_papel = gp.idgrupo_papel
          END
        ORDER BY dm.iddetalle_material ASC
        LIMIT 1
      ) dmp ON true
      -- Piezas del suaje (PZS en el alta de producto) -- paso intermedio
      -- de la fórmula de cortes/hojeado/pliegos, ver calcularCortes().
      -- suaje_papel también es dual-scope (idproducto_papel XOR
      -- idcomponente_papel) desde Fase 1 -- mismo criterio que dmp arriba.
      LEFT JOIN LATERAL (
        SELECT s.pzs AS piezas_suaje
        FROM suaje_papel s
        WHERE
          CASE
            WHEN op.idcomponente_papel IS NOT NULL THEN s.idcomponente_papel = op.idcomponente_papel
            ELSE s.idproducto_papel = pp.idproducto_papel
          END
        LIMIT 1
      ) suaje_seg ON true
      LEFT JOIN cat_tipo_papel ctp
          ON ctp.idcat_tipo_papel = dmp.idcat_tipo_papel
      LEFT JOIN cat_calibre cc
          ON cc.idcat_calibre = dmp.idcat_calibre
      LEFT JOIN ventas v
          ON v.solicitud_idsolicitud = s.idsolicitud
      -- ✅ NUEVO: fecha en que el acumulado de venta_pago alcanzó el
      -- anticipo requerido (para mostrar debajo del PDF de orden de
      -- producción cuándo quedó "aprobado" el pago que la desbloqueó).
      LEFT JOIN LATERAL (
        -- LEAST ignora los NULL (solo da NULL si las dos partes lo son),
        -- así que sirve de COALESCE-por-fecha-más-temprana entre las dos
        -- formas de cubrir el anticipo:
        --   · pago acumulado alcanza el monto requerido
        --   · anticipo autorizado por crédito (venta_pago con monto=0 y
        --     es_credito_anticipo=true — nunca suma al acumulado de arriba,
        --     así que sin esto el anticipo por crédito quedaba sin fecha)
        SELECT LEAST(
          (SELECT MIN(x.fecha)
             FROM (
               SELECT vp.fecha,
                      SUM(vp.monto_moneda_venta) OVER (ORDER BY vp.fecha, vp.idventa_pago) AS acumulado
                 FROM venta_pago vp
                WHERE vp.ventas_idventas = v.idventas AND vp.eliminado_at IS NULL
             ) x
            WHERE x.acumulado >= v.anticipo),
          (SELECT MIN(vp2.fecha)
             FROM venta_pago vp2
            WHERE vp2.ventas_idventas = v.idventas
              AND vp2.es_credito_anticipo = true
              AND vp2.eliminado_at IS NULL)
        ) AS fecha
      ) fap ON true
      LEFT JOIN diseno d
          ON d.solicitud_idsolicitud = s.idsolicitud
      LEFT JOIN diseno_producto dp
          ON dp.diseno_iddiseno = d.iddiseno
          AND dp.solicitud_producto_idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN tintas t
          ON t.idtintas = sp.tintas_idtintas
      LEFT JOIN tintas tdentro
          ON tdentro.idtintas = spp.tintas_dentro_idtintas
      LEFT JOIN cat_laminado catlam
          ON catlam.idcat_laminado = spp.idcat_laminado
      LEFT JOIN foil f
          ON f.idfoil = spp.idfoil
      LEFT JOIN cat_textura ctex
          ON ctex.idcat_textura = spp.idcat_textura
      LEFT JOIN cat_tipo_asa cta
          ON cta.idcat_tipo_asa = spp.id_asa
      -- Especiales: acabados_papel también es dual-scope (idproducto_papel
      -- XOR idcomponente_papel) desde Fase 1 -- mismo criterio que dmp arriba.
      LEFT JOIN acabados_papel ap
          ON CASE
               WHEN op.idcomponente_papel IS NOT NULL THEN ap.idcomponente_papel = op.idcomponente_papel
               ELSE ap.idproducto_papel = pp.idproducto_papel
             END
      -- Bobina/desarrollo de laminado registrados en el alta (mismo dato
      -- que ya usa el PDF en getOrdenProduccion) -- se traen aquí también
      -- para que el modal de Seguimiento los muestre en Laminación.
      LEFT JOIN rollo_lam rl
          ON rl.idrollo_lam = ap.idrollo_lam
      LEFT JOIN cat_tipo_pegado ctpegado
          ON ctpegado.idcat_tipo_pegado = ap.idcat_tipo_pegado
      LEFT JOIN cat_pegamento ctpega
          ON ctpega.idcat_pegamento = ap.idcat_pegamento
      LEFT JOIN cat_refuerzo_material ctrefm
          ON ctrefm.idcat_refuerzo_material = ap.idcat_refuerzo_material
      LEFT JOIN cat_refuerzo_medidas ctrefmed
          ON ctrefmed.idcat_refuerzo_medidas = ap.idcat_refuerzo_medidas
      LEFT JOIN cat_empaque ctemp
          ON ctemp.idcat_empaque = ap.idcat_empaque
      ${JOIN_DETALLES_APROBADOS_AGREGADOS}
      LEFT JOIN orden_diseno od
          ON od.solicitud_producto_id = sp.idsolicitud_producto

      WHERE s.estado = 'pedido'
        AND s.no_pedido IS NOT NULL
        AND sp.tipo_material IN ('papel', 'especial')

      ORDER BY s.no_pedido DESC, sp.idsolicitud_producto ASC
    `);

    // ── Resumen de estado de producción de papel (1 valor, no 11 columnas) ──
    // Se calcula con un query adicional, por cada idproduccion de papel,
    // contando cuántos de los procesos que aplican están terminados.
    // Se hace en lote para no disparar N queries innecesarios.
    const idproduccionesPapel = rowsPapel
      .map((r: any) => r.idproduccion)
      .filter((id: any) => id != null);

    const resumenPorIdproduccion = new Map<number, { estado: string; fecha: string | null }>();

    // ── MERMA DE PAPEL (Fase 7) ──
    // Mismo criterio de "una sola consulta en lote" que el resumen de
    // estado de arriba. Ahora trae cantidad_pedida y merma_total por
    // separado: la merma se suma a los cortes, no a la cantidad (ver R1 en
    // merma.service.ts). Si una orden no aparece aquí (plástico, o papel
    // sin snapshot) el llamador cae a la cantidad del pedido y merma 0.
    const mermaPorIdproduccion = await getMermaDeOrdenBatch(idproduccionesPapel);

    if (idproduccionesPapel.length > 0) {
      // Estado por orden: si NO tiene ningún registro de proceso aún -> pendiente.
      // Si todos los que existen están terminados Y la orden ya no tiene
      // proceso_actual -> finalizado. Si hay al menos un registro con
      // fecha_inicio -> proceso. Se apoya en orden_produccion.idestado_produccion_cat
      // que el orquestador ya mantiene actualizado (ESTADO_PROD.TERMINADO
      // cuando proceso_actual queda NULL).
      const { rows: estadoRows } = await pool.query(`
        SELECT
          op.idproduccion,
          op.idestado_produccion_cat,
          op.proceso_actual,
          GREATEST(
            (SELECT MAX(fecha_inicio) FROM hojeado_papel WHERE orden_produccion_idproduccion = op.idproduccion),
            (SELECT MAX(fecha_inicio) FROM guillotina_papel WHERE orden_produccion_idproduccion = op.idproduccion),
            (SELECT MAX(fecha_inicio) FROM impresion_papel WHERE orden_produccion_idproduccion = op.idproduccion),
            (SELECT MAX(fecha_inicio) FROM laminacion_papel WHERE orden_produccion_idproduccion = op.idproduccion),
            (SELECT MAX(fecha_inicio) FROM barniz_uv_papel WHERE orden_produccion_idproduccion = op.idproduccion),
            (SELECT MAX(fecha_inicio) FROM hot_stamping_papel WHERE orden_produccion_idproduccion = op.idproduccion),
            (SELECT MAX(fecha_inicio) FROM texturizado_papel WHERE orden_produccion_idproduccion = op.idproduccion),
            (SELECT MAX(fecha_inicio) FROM alto_relieve_papel WHERE orden_produccion_idproduccion = op.idproduccion),
            (SELECT MAX(fecha_inicio) FROM suaje_produccion_papel WHERE orden_produccion_idproduccion = op.idproduccion),
            (SELECT MAX(fecha_inicio) FROM armado_papel WHERE orden_produccion_idproduccion = op.idproduccion),
            (SELECT MAX(fecha_inicio) FROM empaque_papel WHERE orden_produccion_idproduccion = op.idproduccion)
          ) AS ultima_fecha_inicio
        FROM orden_produccion op
        WHERE op.idproduccion = ANY($1)
      `, [idproduccionesPapel]);

      for (const r of estadoRows) {
        const estId = Number(r.idestado_produccion_cat);
        let estado = "pendiente";
        if (estId === 3) estado = "finalizado"; // ESTADO_PROD.TERMINADO
        else if (estId === 4) estado = "resagado"; // ESTADO_PROD.RESAGADO
        else if (r.proceso_actual != null && r.ultima_fecha_inicio != null) estado = "proceso";

        resumenPorIdproduccion.set(Number(r.idproduccion), {
          estado,
          fecha: r.ultima_fecha_inicio ?? null,
        });
      }
    }

    // ── Especiales: ¿esta OP de unión debe esperar a sus OP de inicio
    // hermanas? (ver unionEsperandoHermanasPapel en procesosPapel.controller.ts
    // -- solo bloquea cuando la unión lleva Litolaminado; el "caso caja de
    // regalo" de piezas que solo enganchan nunca espera). Se calcula en lote
    // aquí (no solo en getOrdenProduccion/getProcesosOrdenPapel) para que
    // Seguimiento.tsx pueda mostrar el candado en la fila de la unión sin
    // tener que abrir cada OP una por una.
    const esperaUnionPorIdproduccion = new Map<number, { espera: boolean; motivo?: string }>();
    const idproduccionesUnion = rowsPapel
      .filter((r: any) => r.idproduccion != null && r.componente_tipo === "union")
      .map((r: any) => Number(r.idproduccion));

    for (const idproduccion of idproduccionesUnion) {
      try {
        esperaUnionPorIdproduccion.set(idproduccion, await unionEsperandoHermanasPapel(pool, idproduccion));
      } catch (e) {
        console.warn(`No se pudo calcular espera_union para OP ${idproduccion}:`, e);
      }
    }

    // ── Mapeo a forma final ──────────────────────────────────────────────
    const mapEstadoProceso = (estadoId: number | null): string => {
      if (estadoId === null || estadoId === undefined) return "pendiente";
      switch (estadoId) {
        case 3: return "finalizado";
        case 2: return "proceso";
        case 4: return "resagado";
        case 5: return "no-aplica";
        default: return "pendiente";
      }
    };

    // Envío: mismo vocabulario que el resto de columnas (pendiente/proceso/
    // finalizado/no-aplica) para que el Badge/BadgeTexto ya existentes lo
    // pinten sin cambios. "no-aplica" cuando la orden aún no tiene bultos.
    const mapEstadoEnvio = (totalBultos: number, bultosEnviados: number): string => {
      if (totalBultos === 0) return "no-aplica";
      if (bultosEnviados === 0) return "pendiente";
      if (bultosEnviados < totalBultos) return "proceso";
      return "finalizado";
    };

    const resultadoPlastico = rowsPlastico.map((row: any) => {
      const mat = (row.material || "").toUpperCase();
      const esBopp = mat.includes("BOPP") || mat.includes("CELOFAN") || mat.includes("CELOFÁN");
      const calibre = esBopp
        ? (row.calibre_bopp ? String(row.calibre_bopp) : "")
        : (row.calibre_numero && Number(row.calibre_numero) !== 0 ? String(row.calibre_numero) : "");

      return {
        idsolicitud: Number(row.idsolicitud),
        idsolicitud_producto: Number(row.idsolicitud_producto),
        no_pedido: row.no_pedido,
        no_cotizacion: row.no_cotizacion ?? null,
        fecha: row.fecha,
        prioridad: Boolean(row.prioridad),
        cliente: row.cliente || "",
        tipo_producto: row.tipo_producto || "Plástico",
        impresion: row.impresion || "",
        anticipo_requerido: Number(row.anticipo_requerido ?? 0),
        anticipo_pagado: Number(row.anticipo_pagado ?? 0),
        anticipo_cubierto: Boolean(row.anticipo_cubierto),
        pago_completo: Boolean(row.pago_completo),
        saldo_venta: row.saldo_venta != null ? Number(row.saldo_venta) : null,
        diseno_estado_id: Number(row.producto_diseno_estado_id ?? 1),
        diseno_aprobado: Boolean(row.producto_diseno_aprobado),
        no_produccion: row.no_produccion ?? null,
        idproduccion: row.idproduccion ?? null,
        fecha_habilitacion_orden: row.fecha_habilitacion_orden ?? null,
        puede_pdf: Boolean(row.puede_pdf),
        extrusion_estado: row.lleva_extrusion ? mapEstadoProceso(row.extrusion_estado_id) : "no-aplica",
        impresion_estado: row.lleva_impresion ? mapEstadoProceso(row.impresion_estado_id) : "no-aplica",
        bolseo_estado: row.lleva_bolseo ? mapEstadoProceso(row.bolseo_estado_id) : "no-aplica",
        asa_flexible_estado: row.lleva_asa_flexible ? mapEstadoProceso(row.asa_flexible_estado_id) : "no-aplica",

        extrusion_fecha_estado: row.extrusion_fecha_estado ?? null,
        impresion_fecha_estado: row.impresion_fecha_estado ?? null,
        bolseo_fecha_estado: row.bolseo_fecha_estado ?? null,
        asa_flexible_fecha_estado: row.asa_flexible_fecha_estado ?? null,
        extrusion_fecha_fin: row.extrusion_fecha_fin ?? null,
        impresion_fecha_fin: row.impresion_fecha_fin ?? null,
        bolseo_fecha_fin: row.bolseo_fecha_fin ?? null,
        asa_flexible_fecha_fin: row.asa_flexible_fecha_fin ?? null,

        anticipo_fecha_estado: row.anticipo_fecha_estado ?? null,
        pago_fecha_estado: row.pago_fecha_estado ?? null,
        pago_fecha_liquidacion: row.pago_fecha_liquidacion ?? null,
        diseno_fecha_estado: row.diseno_fecha_estado ?? null,
        od_fecha_estado: row.od_fecha_estado ?? null,
        od_fecha_aprobacion: row.od_fecha_aprobacion ?? null,
        anticipo_fecha_aprobacion: row.anticipo_fecha_aprobacion ?? null,
        diseno_fecha_aprobacion: row.diseno_fecha_aprobacion ?? null,
        op_fecha_aprobacion: row.op_fecha_aprobacion ?? null,
        envio_fecha_estado: row.envio_fecha_estado ?? null,
        estado_envio: mapEstadoEnvio(
          Number(row.envio_total_bultos ?? 0),
          Number(row.envio_bultos_enviados ?? 0),
        ),

        nombre_producto: row.nombre_producto || "",
        medida: row.medida || "",
        altura: row.altura != null ? String(row.altura) : "",
        ancho: row.ancho != null ? String(row.ancho) : "",
        fuelle_fondo: row.fuelle_fondo != null ? String(row.fuelle_fondo) : "",
        fuelle_lat_iz: row.fuelle_lat_iz != null ? String(row.fuelle_lat_iz) : "",
        fuelle_lat_de: row.fuelle_lat_de != null ? String(row.fuelle_lat_de) : "",
        refuerzo: row.refuerzo != null ? String(row.refuerzo) : "",
        material: row.material || "",
        calibre,
        tintas: row.tintas != null ? Number(row.tintas) : null,
        caras: row.caras != null ? Number(row.caras) : null,
        pigmentos: row.pigmentos || null,
        pantones: row.pantones || null,
        observacion: row.observacion || null,
        descripcion: row.descripcion ?? null,
        perforacion: row.perforacion ?? false,
        asa_suaje: row.asa_suaje || null,
        id_color: row.id_color ?? null,
        color_asa_nombre: row.color_asa_nombre ?? null,
        id_medidatro: row.id_medidatro ?? null,
        medida_troquel: row.medida_troquel ?? null,
        cantidad_orden: row.cantidad_orden ? Number(row.cantidad_orden) : null,
        kilogramos_orden: row.kilogramos_orden ? Number(row.kilogramos_orden) : null,
        modo_cantidad: row.modo_cantidad || "unidad",
        kilos: row.kilos != null ? Number(row.kilos) : null,
        kilos_merma: row.kilos_merma != null ? Number(row.kilos_merma) : null,
        pzas: row.pzas != null ? Number(row.pzas) : null,
        pzas_merma: row.pzas_merma != null ? Number(row.pzas_merma) : null,
        metros_merma: row.metros_merma != null ? Number(row.metros_merma) : null,

        idorden_diseno: row.idorden_diseno ?? null,
        od_estado: row.od_estado ?? null,
        od_tiene_archivos: Boolean(row.od_tiene_archivos),

        es_parcialidad: Boolean(row.es_parcialidad ?? false),
      };
    });

    const resultadoPapel = rowsPapel.map((row: any) => {
      // Pliegos estimados (informativo, cantidad x rendimiento) -- mismo
      // cálculo que ya se usaba solo para el PDF (calcularPliegosPorRendimiento),
      // ahora también disponible aquí para mostrarlo en el modal de
      // Hojeado/Guillotina ANTES de que existan avances reales. Cada uno
      // usa su propio rendimiento -- no son intercambiables.
      // Merma: la cantidad NO se infla. Se parte de la cantidad pedida y la
      // merma se suma después, ya en cortes (ver R1 en merma.service.ts).
      const mermaOrden = row.idproduccion != null
        ? mermaPorIdproduccion.get(Number(row.idproduccion))
        : undefined;
      const cantidadPedida = mermaOrden?.cantidad_pedida ?? row.cantidad_orden;
      const mermaTotal = mermaOrden?.merma_total ?? 0;
      const cantidadProduccion = mermaOrden?.cantidad_a_producir ?? row.cantidad_orden;

      const cortes = calcularCortes(cantidadPedida, row.piezas_suaje);
      const cortesConMerma = sumarMermaACortes(cortes, mermaTotal);
      // Hojeado y Guillotina tienen rendimientos distintos a propósito (lo
      // confirmó Jose): son dos datos separados aunque a veces coincidan.
      const pliegosHojeadoCalculado = calcularPliegosPorRendimiento(cortesConMerma, row.hoj_rendimiento);
      const pliegosGuillotinaCalculado = calcularPliegosPorRendimiento(cortesConMerma, row.rendimiento);
      const maquinaHojeado = calcularMaquinaDesdePliegos(pliegosHojeadoCalculado, row.hoj_rendimiento);
      const maquinaGuillotina = calcularMaquinaDesdePliegos(pliegosGuillotinaCalculado, row.rendimiento);

      // Laminación: mismo cálculo que ya usaba solo el PDF
      // (getOrdenProduccion) -- ahora también aquí para que el modal de
      // Seguimiento muestre Bobina/Rollos/Desarrollo/CTES-mod en vez de
      // dejarlos en blanco (eran campos de captura manual sin ninguna
      // referencia calculada).
      const rolloLamRegistradoCm = row.rollo_lam_medida_ancho != null ? Number(row.rollo_lam_medida_ancho) : null;
      const desarrolloLaminadoRegistradoCm = row.desarrollo_laminado != null ? Number(row.desarrollo_laminado) : null;
      const bobinaLaminacionCm = rolloLamRegistradoCm ?? primeraMedidaCm(row.hoj_corte, row.pliego, row.medida);
      const desarrolloLaminacionMm = desarrolloLaminadoRegistradoCm != null
        ? round2(desarrolloLaminadoRegistradoCm * 10)
        : calcularDesarrolloMm(row.hoj_corte, row.pliego, row.medida);
      const ctesModLaminacion =
        calcularCtesModDesdeDesarrollo(desarrolloLaminacionMm) ??
        calcularCtesMod(row.hoj_corte, row.pliego, row.medida);
      // CORREGIDO (2026-08-24): se multiplicaba por los PLIEGOS, dejando los
      // metros divididos entre el rendimiento. El desarrollo es el avance de
      // una pieza de guillotina, no del pliego completo, así que el conteo
      // tiene que ser de piezas: maquinaGuillotina (pliegos enteros x rend).
      const metrosLaminacionEstimados = calcularMetrosLaminacion(maquinaGuillotina, desarrolloLaminacionMm);
      const rollosLaminacionEstimados = metrosLaminacionEstimados === null ? null : round2(metrosLaminacionEstimados / 3000);
      // Referencia sin merma (cortes de la cantidad pedida, sin el redondeo
      // del pliego): es lo que da el cálculo a mano del cliente. Informativo.
      const metrosLaminacionSinMerma = calcularMetrosLaminacion(cortes, desarrolloLaminacionMm);
      const rollosLaminacionSinMerma = metrosLaminacionSinMerma === null ? null : round2(metrosLaminacionSinMerma / 3000);

      const resumen = row.idproduccion != null
        ? resumenPorIdproduccion.get(Number(row.idproduccion))
        : undefined;
      const esperaUnion = row.idproduccion != null
        ? esperaUnionPorIdproduccion.get(Number(row.idproduccion))
        : undefined;

      return {
        // ── Especiales: a qué componente pertenece ESTA fila (null en
        // papel normal). Seguimiento.tsx los agrupa por idsolicitud_producto
        // y muestra una fila expandible con una sub-fila por componente
        // cuando hay más de una OP real para el mismo producto.
        es_especial: row.es_especial === true,
        idcomponente_papel: row.idcomponente_papel ?? null,
        componente_tipo: row.componente_tipo ?? null,
        componente_nombre: row.componente_nombre ?? null,
        componente_orden: row.componente_orden ?? null,
        espera_union: esperaUnion?.espera ?? false,
        espera_union_motivo: esperaUnion?.motivo ?? null,
        idsolicitud: Number(row.idsolicitud),
        idsolicitud_producto: Number(row.idsolicitud_producto),
        no_pedido: row.no_pedido,
        no_cotizacion: row.no_cotizacion ?? null,
        fecha: row.fecha,
        prioridad: Boolean(row.prioridad),
        cliente: row.cliente || "",
        empresa: row.empresa || "",
        tipo_producto: "papel",
        impresion: row.impresion || "",
        anticipo_requerido: Number(row.anticipo_requerido ?? 0),
        anticipo_pagado: Number(row.anticipo_pagado ?? 0),
        anticipo_cubierto: Boolean(row.anticipo_cubierto),
        pago_completo: Boolean(row.pago_completo),
        saldo_venta: row.saldo_venta != null ? Number(row.saldo_venta) : null,
        diseno_estado_id: Number(row.producto_diseno_estado_id ?? 1),
        diseno_aprobado: Boolean(row.producto_diseno_aprobado),
        no_produccion: row.no_produccion ?? null,
        idproduccion: row.idproduccion ?? null,
        fecha_habilitacion_orden: row.fecha_habilitacion_orden ?? null,
        puede_pdf: Boolean(row.puede_pdf),

        // Columnas de plástico (Ext/Imp/Bol/Asa) siempre no-aplica para
        // papel — el frontend ya está hecho para tratarlas así y mostrar
        // en su lugar la columna "Producción" vía estado_resumen_papel.
        extrusion_estado: "no-aplica",
        impresion_estado: "no-aplica",
        bolseo_estado: "no-aplica",
        asa_flexible_estado: "no-aplica",
        extrusion_fecha_estado: null,
        impresion_fecha_estado: null,
        bolseo_fecha_estado: null,
        asa_flexible_fecha_estado: null,
        extrusion_fecha_fin: null,
        impresion_fecha_fin: null,
        bolseo_fecha_fin: null,
        asa_flexible_fecha_fin: null,

        // Estado resumido de producción de papel (consume el modal
        // selector de procesos, no columnas individuales).
        estado_resumen_papel: resumen?.estado ?? "pendiente",
        estado_resumen_papel_fecha: resumen?.fecha ?? null,

        anticipo_fecha_estado: row.anticipo_fecha_estado ?? null,
        pago_fecha_estado: row.pago_fecha_estado ?? null,
        pago_fecha_liquidacion: row.pago_fecha_liquidacion ?? null,
        diseno_fecha_estado: row.diseno_fecha_estado ?? null,
        od_fecha_estado: row.od_fecha_estado ?? null,
        od_fecha_aprobacion: row.od_fecha_aprobacion ?? null,
        anticipo_fecha_aprobacion: row.anticipo_fecha_aprobacion ?? null,
        diseno_fecha_aprobacion: row.diseno_fecha_aprobacion ?? null,
        op_fecha_aprobacion: row.op_fecha_aprobacion ?? null,
        envio_fecha_estado: row.envio_fecha_estado ?? null,
        estado_envio: mapEstadoEnvio(
          Number(row.envio_total_bultos ?? 0),
          Number(row.envio_bultos_enviados ?? 0),
        ),

        nombre_producto: row.nombre_producto || "",
        descripcion: row.descripcion ?? null,
        material: row.material || null,
        calibre: row.calibre || null,
        medida: row.medida || null,
        ancho: row.ancho != null ? String(row.ancho) : null,
        fuelle: row.fuelle != null ? String(row.fuelle) : null,
        altura: row.altura != null ? String(row.altura) : null,
        asa_tipo: row.asa_tipo || null,
        asa_color: null, // sin campo estructurado en el DDL -- texto libre en observaciones si aplica
        asa_medida: null, // idem
        pegamento: row.pegamento || null,
        tipo_pegue: row.tipo_pegue || null,
        suaje: null, // referencia visual del PDF -- el folio real vive en suaje_papel, no en la ficha
        rendimiento: row.rendimiento || null,
        corte: row.corte || null,

        hoj_bobina: row.hoj_bobina || null,
        hoj_bobina_extra: row.hoj_bobina_extra || null,
        hoj_corte: row.hoj_corte || null,
        hoj_rendimiento: row.hoj_rendimiento || null,
        hoj_guillotina: row.hoj_guillotina || null,
        pliego: row.pliego || null,

        tintas_frente: row.tintas_frente != null ? Number(row.tintas_frente) : null,
        pantones_frente: row.pantones_frente
          ? row.pantones_frente.split(",").map((p: string) => p.trim()).filter(Boolean)
          : null,
        tintas_dentro: row.tintas_dentro != null ? Number(row.tintas_dentro) : null,
        pantones_dentro: row.pantones_dentro
          ? row.pantones_dentro.split(",").map((p: string) => p.trim()).filter(Boolean)
          : null,

        laminado_acabado: row.laminado_acabado || null,
        foil_nombre: row.foil_nombre || null,
        textura_nombre: row.textura_nombre || null,

        refuerzo_material: row.refuerzo_material || null,
        refuerzo_medida: row.refuerzo_medida || null,
        base_material: null, // pendiente: cat_base_material no existe en el DDL todavía (ver nota arriba)
        base_medida: row.base_medida || null,

        tipo_caja: row.tipo_caja || null,
        cantidad_por_caja: row.cantidad_por_caja != null ? Number(row.cantidad_por_caja) : null,

        cantidad_orden: row.cantidad_orden ? Number(row.cantidad_orden) : null,
        // Meta real a producir (pedido + merma). NULL si la orden no tiene
        // snapshot de merma (plástico no aplica; papel viejo sin sistema).
        cantidad_produccion: cantidadProduccion != null ? Number(cantidadProduccion) : null,
        kilogramos_orden: row.kilogramos_orden ? Number(row.kilogramos_orden) : null,
        modo_cantidad: row.modo_cantidad || "unidad",
        fecha_entrega: null,

        // Informativos, NO son un límite real (ese es limite_avance, que
        // sale de avances/registro ya capturados) -- son la estimación de
        // cuántos pliegos hacen falta según cantidad_orden x rendimiento,
        // útil como referencia mientras el proceso todavía no arranca.
        pliegos_hojeado_calculado: pliegosHojeadoCalculado,
        pliegos_guillotina_calculado: pliegosGuillotinaCalculado,
        cortes_calculados: cortes,
        // Cortes ya con la merma sumada, y la máquina real que resulta tras
        // subir los pliegos a entero (pliegos x rendimiento).
        cortes_con_merma: cortesConMerma,
        merma_total: mermaTotal,
        maquina_hojeado_calculada: maquinaHojeado,
        maquina_guillotina_calculada: maquinaGuillotina,

        bobina_laminacion_cm: bobinaLaminacionCm,
        desarrollo_laminacion_mm: desarrolloLaminacionMm,
        ctes_mod_laminacion: ctesModLaminacion,
        metros_laminacion_estimados: metrosLaminacionEstimados,
        rollos_laminacion_estimados: rollosLaminacionEstimados,
        metros_laminacion_sin_merma: metrosLaminacionSinMerma,
        rollos_laminacion_sin_merma: rollosLaminacionSinMerma,

        idorden_diseno: row.idorden_diseno ?? null,
        od_estado: row.od_estado ?? null,
        od_tiene_archivos: Boolean(row.od_tiene_archivos),
      };
    });

    const resultado = [...resultadoPlastico, ...resultadoPapel];

    // ── NUEVO: fecha de generación del estado de cuenta vigente, por
    // pedido (plan-estado-cuenta-cobranza-v2.md, Fase 3/4). Query aparte
    // en vez de meterla a los dos SELECTs de arriba, para no arriesgar los
    // JOINs ya afinados de plástico/papel. Un pedido puede tener más de
    // una venta histórica, por eso se filtra por vigente = true.
    const nosPedido = resultado.map((r: any) => r.no_pedido).filter(Boolean);
    if (nosPedido.length > 0) {
      const { rows: ecRows } = await pool.query(`
        SELECT s.no_pedido, ec.fecha_generacion
        FROM estado_cuenta ec
        JOIN ventas v    ON v.idventas = ec.ventas_idventas
        JOIN solicitud s ON s.idsolicitud = v.solicitud_idsolicitud
        WHERE ec.vigente = true AND s.no_pedido = ANY($1::text[])
      `, [nosPedido]);
      const fechaPorPedido = new Map(ecRows.map((r: any) => [r.no_pedido, r.fecha_generacion]));
      for (const row of resultado as any[]) {
        row.estado_cuenta_fecha = fechaPorPedido.get(row.no_pedido) ?? null;
        row.estado_cuenta_generado = fechaPorPedido.has(row.no_pedido);
      }
    }

    return res.json(resultado);

  } catch (error: any) {
    console.error("❌ GET SEGUIMIENTO ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener seguimiento" });
  }
};

// ════════════════════════════════════════════════════════════════════════
// GET /api/seguimiento/cuentas-por-cobrar
//
// NUEVO. Alimenta el modal "💰 Cuentas por cobrar" de Seguimiento.tsx:
// pedidos con estado de cuenta vigente, saldo > 0.01, y cuya fecha de
// generación quedó a 5 días hábiles o más de hoy. contarDiasHabiles viene
// del mismo utils/diasHabiles.ts que ya usa el reporte semanal, así que
// este filtro, el badge del front y el correo semanal nunca se desalinean.
// ════════════════════════════════════════════════════════════════════════
export const getCuentasPorCobrar = async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const { rows } = await pool.query(`
      SELECT
        s.no_pedido, s.no_cotizacion, s.fecha,
        cli.razon_social AS cliente, cli.empresa, cli.telefono, cli.correo,
        v.idventas, v.moneda,
        v.total, v.total_real, v.abono, v.saldo,
        ec.fecha_generacion, ec.version, ec.motivo
      FROM estado_cuenta ec
      JOIN ventas v     ON v.idventas = ec.ventas_idventas
      JOIN solicitud s  ON s.idsolicitud = v.solicitud_idsolicitud
      JOIN clientes cli ON cli.idclientes = s.clientes_idclientes
      WHERE ec.vigente = true
        AND v.saldo > 0.01
      ORDER BY ec.fecha_generacion ASC
    `);

    const hoy = new Date();
    const conDias = rows.map((r: any) => ({
      ...r,
      dias_habiles_desde_generacion: contarDiasHabiles(new Date(r.fecha_generacion), hoy),
    }));

    const vencidos = conDias.filter(
      (r: any) => r.dias_habiles_desde_generacion >= DIAS_HABILES_VENCIMIENTO_ESTADO_CUENTA,
    );

    return res.json(vencidos);

  } catch (error: any) {
    console.error("❌ GET CUENTAS POR COBRAR ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener cuentas por cobrar" });
  }
};

// ============================================================
// GET /api/seguimiento/:noPedido/orden-produccion
//
// SIN CAMBIOS -- igual que el original. Pendiente: adaptar para papel
// en una próxima vuelta (no se tocó en esta conversación).
// ============================================================
// ============================================================
// GET /api/seguimiento/:noPedido/orden-produccion
//
// REEMPLAZA SOLO esta función en seguimiento.controller.ts.
// Tu getSeguimiento (y todos sus comentarios) queda intacta.
//
// Cambios respecto a tu versión:
//   1. El SELECT de productosPapel ahora trae un subquery
//      `registros_procesos` con los registros runtime de los 11
//      procesos de papel (hojeado/guillotina resuelven 'maquina'
//      vía cat_hojeado_guillotina porque guardan maquinaria_idmaquinaria).
//   2. El .map de productosPapelFormateados agrega
//      `registros_procesos: r.registros_procesos ?? {}`.
//
// Los helpers de módulo (toNumberOrNull, round2, primeraMedidaCm,
// ultimaMedidaCm, calcularPliegosPorRendimiento, calcularBolsasPorRendimiento,
// calcularDesarrolloMm, calcularCtesMod, calcularMetrosLaminacion) ya viven
// en tu archivo arriba de getSeguimiento — NO los redeclares.
// ============================================================
export const getOrdenProduccion = async (req: Request, res: Response) => {
  try {
    const { noPedido } = req.params;

    const { rows: pedidoRows } = await pool.query(`
      SELECT
        s.idsolicitud,
        s.no_pedido,
        s.no_cotizacion,
        s.fecha,
        s.prioridad,
        cli.razon_social AS cliente,
        cli.empresa,
        cli.telefono,
        cli.correo,
        cli.impresion AS cliente_impresion
      FROM solicitud s
      LEFT JOIN clientes cli ON cli.idclientes = s.clientes_idclientes
      WHERE s.no_pedido = $1 AND s.estado = 'pedido'
    `, [noPedido]);

    if (pedidoRows.length === 0)
      return res.status(404).json({ error: "Pedido no encontrado" });

    const pedido = pedidoRows[0];

    // ── PLÁSTICO (filtra tipo_material NOT IN ('papel','especial'), para
    // que los especiales -- que ahora tienen su propio tipo_material -- no
    // se cuelen aquí como si fueran plástico, Jose 2026-09-03) ───────────
    const { rows: productos } = await pool.query(`
      SELECT
        sp.idsolicitud_producto,

        op.idproduccion,
        op.no_produccion,
        op.fecha            AS fecha_produccion,

        tpp.material_plastico_producto  AS nombre_producto,
        pr.tipo_producto                AS categoria,
        mp.tipo_material                AS material,
        cal.calibre                     AS calibre_numero,
        cal.calibre_bopp,
        cfg.medida,
        cfg.altura,
        cfg.ancho,
        cfg.fuelle_fondo,
        cfg.fuelle_latIz                AS fuelle_lat_iz,
        cfg.fuelle_latDe                AS fuelle_lat_de,
        cfg.refuerzo,
        cfg.por_kilo,

        t.cantidad   AS tintas,
        car.cantidad AS caras,
        sp.pigmentos,
        sp.pantones,
        sp.observacion,
        sp.perforacion,
        sp.descripcion,

        asz.tipo AS asa_suaje,

        sp.id_color,
        ca.color AS color_asa_nombre,

        sp.id_medidatro,
        mt.medida AS medida_troquel,

        sd.cantidad,
        sd.kilogramos,
        sd.modo_cantidad,

        dp.fecha_aprobacion AS fecha_aprobacion_diseno,
        dp.observaciones    AS observaciones_diseno,

        op.repeticion_extrusion,
        op.repeticion_metro,
        op.metros,
        op.ancho_bobina,
        op.repeticion_kidder,
        op.repeticion_sicosa,
        op.fecha_entrega,
        op.es_parcialidad,

        op.kilos,
        op.kilos_merma,
        op.pzas,
        op.pzas_merma,

        ext.kilos_extruir,
        ext.metros_extruir,

        -- Render/Master de la revisión final para plástico (base64 para PDF/jsPDF sin CORS)
        ar.public_id AS render_public_id,
        am.public_id AS master_public_id

      FROM solicitud_producto sp
      LEFT JOIN orden_produccion op
          ON op.idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN diseno_producto dp
          ON dp.solicitud_producto_idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN configuracion_plastico cfg
          ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN tipo_producto_plastico tpp
          ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN productos pr
          ON pr.idproductos = tpp.productos_idproductos
      LEFT JOIN material_plastico mp
          ON mp.idmaterial_plastico = cfg.material_plastico_plastico_idmaterial_plastico
      LEFT JOIN calibre cal
          ON cal.idcalibre = cfg.calibre_idcalibre
      LEFT JOIN tintas t
          ON t.idtintas = sp.tintas_idtintas
      LEFT JOIN caras car
          ON car.idcaras = sp.caras_idcaras
      LEFT JOIN asa_suaje asz
          ON asz.idsuaje = sp.idsuaje
      LEFT JOIN color_asa ca
          ON ca.id_color = sp.id_color
      LEFT JOIN medidas_troquel mt
          ON mt.id_medidatro = sp.id_medidatro
      ${JOIN_DETALLES_APROBADOS_AGREGADOS}
      LEFT JOIN extrusion ext
          ON ext.orden_produccion_idproduccion = op.idproduccion
      LEFT JOIN orden_diseno od_img
          ON od_img.solicitud_producto_id = sp.idsolicitud_producto
      LEFT JOIN revision_diseno rd_final
          ON rd_final.orden_diseno_id = od_img.idorden_diseno
          AND rd_final.es_version_final = true
      LEFT JOIN archivos ar
          ON ar.revision_diseno_id = rd_final.idrevision
          AND ar.categoria = 'render'
      LEFT JOIN archivos am
          ON am.revision_diseno_id = rd_final.idrevision
          AND am.categoria = 'master'
      WHERE sp.solicitud_idsolicitud = $1
        AND sp.tipo_material NOT IN ('papel', 'especial')
      ORDER BY sp.idsolicitud_producto
    `, [pedido.idsolicitud]);

    // ── PAPEL (ficha completa + registros_procesos runtime) ──────────────
    const { rows: productosPapel } = await pool.query(`
      SELECT
        sp.idsolicitud_producto,
        sp.tipo_material,
        op.idproduccion,
        op.no_produccion,
        op.fecha AS fecha_produccion,
        op.fecha_entrega,
        op.es_parcialidad,
        dp.fecha_aprobacion AS fecha_aprobacion_diseno,
        dp.observaciones AS observaciones_diseno,

        -- ── Especiales: de qué componente (OP planeada) es esta orden real.
        -- NULL en papel normal -- así es como se distingue una orden. Con la
        -- JOIN de op sin restricción (más abajo), un producto especial con
        -- N componentes ya devuelve N renglones en este SELECT (uno por OP
        -- real), cada uno con su propio idcomponente_papel -- lo que falta
        -- es que el resto de columnas (material, acabados, suaje) lean el
        -- dato de ESE componente en vez del producto completo (ver joins
        -- de dmp/ap/suj más abajo).
        op.idcomponente_papel,
        cp.tipo        AS componente_tipo,
        cp.nombre      AS componente_nombre,
        cp.orden       AS componente_orden,
        pp.es_especial,

        ctpp.nombre AS nombre_producto,
        pp.descripcion_papel,
        pp.medida,
        pp.ancho,
        pp.fuelle,
        pp.altura,
        pp.tamano_asa_default,
        -- Materiales de ESTA orden: en papel normal, igual que siempre
        -- (sp.grupo_papel_descripcion, snapshot armado al cotizar). En un
        -- especial, un componente puede tener MÁS de un material asignado
        -- (ej. una unión que fusiona dos materiales por litolaminado) -- el
        -- dmp de abajo solo toma el primero (para pliego/rendimiento/etc,
        -- que son datos de UN material), así que aquí se arma la lista
        -- completa de materiales de ESTE componente, no de todo el
        -- producto -- antes cada OP mostraba en el PDF los materiales del
        -- producto entero, sin importar cuál era su propio material.
        COALESCE(materiales_componente.descripcion, sp.grupo_papel_descripcion) AS grupo_descripcion,
        ctp.nombre AS material,
        cc.nombre AS calibre,
        dmp.pliego,
        dmp.rendimiento,
        dmp.corte,
        dmp.hoj_bobina,
        dmp.hoj_corte,
        dmp.hoj_rendimiento,
        suaje_op.piezas_suaje,
        dmp.hoj_guillotina,
        dmp.hoj_hilo,
        dmp.hoj_bobina_extra,

        t.cantidad AS tintas,
        td.cantidad AS tintas_dentro,
        sp.pantones,
        spp.pantones_dentro,
        sp.observacion,
        sp.descripcion,
        sd.cantidad,
        sd.kilogramos,
        sd.modo_cantidad,

        spp.metodo_hojeado,
        spp.lleva_armado,
        COALESCE((
          SELECT jsonb_object_agg(
            spm.proceso,
            jsonb_build_object('id', spm.idmaquina, 'nombre', spm.nombre_maquina)
          )
          FROM solicitud_producto_papel_maquinaria spm
          WHERE spm.idsolicitud_producto_papel = spp.idsolicitud_producto_papel
        ), '{}'::jsonb) AS maquinaria_seleccionada,
        spp.uv,
        spp.alto_relieve,
        cl.nombre AS laminado_nombre,
        CASE
          WHEN f.colorfoil IS NULL THEN NULL
          ELSE f.colorfoil || COALESCE(' ' || f.codigofoil, '')
        END AS foil_nombre,
        ctx.nombre AS textura_nombre,
        cta.nombre AS asa_nombre,
        sp.id_color,
        ca.color AS color_asa_nombre,
        COALESCE(spp.tamano_asa, pp.tamano_asa_default) AS asa_medida,

        ctpgo.nombre AS tipo_pegue,
        cpeg.nombre AS pegamento,
        crmat.nombre AS refuerzo_material,
        crmed.nombre AS refuerzo_medida,
        ap.base_medida,
        cemp.nombre AS tipo_caja,
        ap.pzs_caja,
        -- Rollo y desarrollo de laminado registrados al dar de alta el
        -- producto (acabados_papel): si el producto los tiene capturados,
        -- suplantan el cálculo automático desde las medidas del pliego.
        ap.desarrollo_laminado,
        rl.medida_ancho AS rollo_lam_medida_ancho,

        suj.numero AS suaje,
        suj.tamano AS suaje_tamano,
        suj.matrix AS matrix,

        -- ── Registros runtime de los 11 procesos de papel ──
        -- jsonb_strip_nulls deja fuera los procesos sin registro todavía.
        -- hojeado/guillotina guardan maquinaria_idmaquinaria (id), así que
        -- se resuelve el nombre vía cat_hojeado_guillotina y se inyecta como
        -- 'maquina' para que el PDF lo lea igual que las otras 9 tablas
        -- (que ya guardan 'maquina' como texto).
        jsonb_strip_nulls(jsonb_build_object(
          'hojeado_papel', (
            SELECT to_jsonb(h) || jsonb_build_object('maquina', chg.nombre)
            FROM hojeado_papel h
            LEFT JOIN cat_hojeado_guillotina chg
              ON chg.idcat_hojeado_guillotina = h.maquinaria_idmaquinaria
            WHERE h.orden_produccion_idproduccion = op.idproduccion
          ),
          'guillotina_papel', (
            SELECT to_jsonb(g) || jsonb_build_object('maquina', chg.nombre)
            FROM guillotina_papel g
            LEFT JOIN cat_hojeado_guillotina chg
              ON chg.idcat_hojeado_guillotina = g.maquinaria_idmaquinaria
            WHERE g.orden_produccion_idproduccion = op.idproduccion
          ),
          'impresion_papel', (
            SELECT to_jsonb(i) FROM impresion_papel i
            WHERE i.orden_produccion_idproduccion = op.idproduccion
          ),
          'laminacion_papel', (
            SELECT to_jsonb(l) FROM laminacion_papel l
            WHERE l.orden_produccion_idproduccion = op.idproduccion
          ),
          'barniz_uv_papel', (
            SELECT to_jsonb(u) FROM barniz_uv_papel u
            WHERE u.orden_produccion_idproduccion = op.idproduccion
          ),
          'hot_stamping_papel', (
            SELECT to_jsonb(hs) FROM hot_stamping_papel hs
            WHERE hs.orden_produccion_idproduccion = op.idproduccion
          ),
          'texturizado_papel', (
            SELECT to_jsonb(tx) FROM texturizado_papel tx
            WHERE tx.orden_produccion_idproduccion = op.idproduccion
          ),
          'alto_relieve_papel', (
            SELECT to_jsonb(ar) FROM alto_relieve_papel ar
            WHERE ar.orden_produccion_idproduccion = op.idproduccion
          ),
          'suaje_produccion_papel', (
            SELECT to_jsonb(su) FROM suaje_produccion_papel su
            WHERE su.orden_produccion_idproduccion = op.idproduccion
          ),
          'armado_papel', (
            SELECT to_jsonb(am) FROM armado_papel am
            WHERE am.orden_produccion_idproduccion = op.idproduccion
          ),
          'empaque_papel', (
            SELECT to_jsonb(em) FROM empaque_papel em
            WHERE em.orden_produccion_idproduccion = op.idproduccion
          ),
          -- NUEVO (Fase 2, 2026-09-02): los 4 procesos agregados después de
          -- los 11 originales -- faltaban aquí por completo, así que el PDF
          -- nunca mostraba nada de Litolaminado/Desbarbe/Pegado/Especial
          -- aunque el proceso ya hubiera corrido en planta.
          'litolaminado_papel', (
            SELECT to_jsonb(lt) FROM litolaminado_papel lt
            WHERE lt.orden_produccion_idproduccion = op.idproduccion
          ),
          'desbarbe_papel', (
            SELECT to_jsonb(db) FROM desbarbe_papel db
            WHERE db.orden_produccion_idproduccion = op.idproduccion
          ),
          'pegado_papel', (
            SELECT to_jsonb(pg) FROM pegado_papel pg
            WHERE pg.orden_produccion_idproduccion = op.idproduccion
          ),
          'especial_papel', (
            SELECT to_jsonb(es) FROM especial_papel es
            WHERE es.orden_produccion_idproduccion = op.idproduccion
          )
        )) AS registros_procesos

      FROM solicitud_producto sp
      JOIN solicitud_producto_papel spp
        ON spp.idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN orden_produccion op
        ON op.idsolicitud_producto = sp.idsolicitud_producto
      -- Especiales: a qué componente (OP planeada) pertenece esta orden
      -- real -- NULL en papel normal. Ver comentario junto a
      -- op.idcomponente_papel arriba en el SELECT.
      LEFT JOIN componente_papel cp
        ON cp.idcomponente_papel = op.idcomponente_papel
      LEFT JOIN diseno_producto dp
        ON dp.solicitud_producto_idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN grupo_papel gp
        ON gp.idgrupo_papel = sp.grupo_papel_idgrupo_papel
      LEFT JOIN producto_papel pp
        ON pp.idproducto_papel = COALESCE(sp.producto_papel_idproducto_papel, gp.idproducto_papel)
      LEFT JOIN cat_tipo_producto_papel ctpp
        ON ctpp.idcat_tipo_producto_papel = pp.idcat_tipo_producto_papel
      -- Material de ESTA orden: en papel normal sigue siendo el único
      -- renglón de detalle_material_papel del grupo (como siempre); en un
      -- especial, cada OP es de un componente con su propio material, así
      -- que se resuelve por idcomponente_papel en vez de por grupo. LATERAL
      -- + LIMIT 1 porque un componente "unión"/"misma orden" puede tener
      -- más de un material asignado -- se toma el primero (mismo criterio
      -- que ya usa RutaProcesos.tsx cuando el componente tiene un solo
      -- material: la ficha de un solo material sigue funcionando igual;
      -- mostrar los varios materiales de una unión queda para cuando se
      -- actualice el generador de PDF).
      LEFT JOIN LATERAL (
        SELECT dm.*
        FROM detalle_material_papel dm
        WHERE
          CASE
            WHEN op.idcomponente_papel IS NOT NULL THEN dm.idcomponente_papel = op.idcomponente_papel
            ELSE dm.idgrupo_papel = gp.idgrupo_papel
          END
        ORDER BY dm.iddetalle_material ASC
        LIMIT 1
      ) dmp ON true
      -- Lista COMPLETA de materiales de ESTE componente (no solo el primero
      -- que ya toma dmp arriba) -- solo aplica a especiales
      -- (op.idcomponente_papel IS NOT NULL); en papel normal se queda NULL
      -- y el SELECT de arriba cae al sp.grupo_papel_descripcion de siempre.
      LEFT JOIN LATERAL (
        SELECT string_agg(
          TRIM(BOTH ' ' FROM COALESCE(ctp2.nombre, '') || ' ' || COALESCE(cc2.nombre, '')),
          ' + ' ORDER BY dm2.iddetalle_material
        ) AS descripcion
        FROM detalle_material_papel dm2
        LEFT JOIN cat_tipo_papel ctp2 ON ctp2.idcat_tipo_papel = dm2.idcat_tipo_papel
        LEFT JOIN cat_calibre cc2 ON cc2.idcat_calibre = dm2.idcat_calibre
        WHERE op.idcomponente_papel IS NOT NULL
          AND dm2.idcomponente_papel = op.idcomponente_papel
      ) materiales_componente ON true
      -- Piezas del suaje (PZS en el alta de producto) -- paso intermedio
      -- de la fórmula de cortes/hojeado/pliegos, ver calcularCortes().
      -- Igual que dmp: por componente en especiales, por producto en normal
      -- (suaje_papel es de doble alcance desde Fase 1 -- idproducto_papel
      -- XOR idcomponente_papel).
      LEFT JOIN LATERAL (
        SELECT s.pzs AS piezas_suaje
        FROM suaje_papel s
        WHERE
          CASE
            WHEN op.idcomponente_papel IS NOT NULL THEN s.idcomponente_papel = op.idcomponente_papel
            ELSE s.idproducto_papel = pp.idproducto_papel
          END
        LIMIT 1
      ) suaje_op ON true
      LEFT JOIN cat_tipo_papel ctp
        ON ctp.idcat_tipo_papel = dmp.idcat_tipo_papel
      LEFT JOIN cat_calibre cc
        ON cc.idcat_calibre = dmp.idcat_calibre
      LEFT JOIN tintas t
        ON t.idtintas = sp.tintas_idtintas
      LEFT JOIN tintas td
        ON td.idtintas = spp.tintas_dentro_idtintas
      LEFT JOIN cat_laminado cl
        ON cl.idcat_laminado = spp.idcat_laminado
      LEFT JOIN foil f
        ON f.idfoil = spp.idfoil
      LEFT JOIN cat_textura ctx
        ON ctx.idcat_textura = spp.idcat_textura
      LEFT JOIN cat_tipo_asa cta
        ON cta.idcat_tipo_asa = spp.id_asa
      LEFT JOIN color_asa ca
        ON ca.id_color = sp.id_color
      -- acabados_papel: doble alcance desde Fase 1 (idproducto_papel XOR
      -- idcomponente_papel) -- mismo criterio que dmp/suaje_op arriba.
      LEFT JOIN acabados_papel ap
        ON CASE
             WHEN op.idcomponente_papel IS NOT NULL THEN ap.idcomponente_papel = op.idcomponente_papel
             ELSE ap.idproducto_papel = pp.idproducto_papel
           END
      LEFT JOIN rollo_lam rl
        ON rl.idrollo_lam = ap.idrollo_lam
      LEFT JOIN cat_tipo_pegado ctpgo
        ON ctpgo.idcat_tipo_pegado = ap.idcat_tipo_pegado
      LEFT JOIN cat_pegamento cpeg
        ON cpeg.idcat_pegamento = ap.idcat_pegamento
      LEFT JOIN cat_refuerzo_material crmat
        ON crmat.idcat_refuerzo_material = ap.idcat_refuerzo_material
      LEFT JOIN cat_refuerzo_medidas crmed
        ON crmed.idcat_refuerzo_medidas = ap.idcat_refuerzo_medidas
      LEFT JOIN cat_empaque cemp
        ON cemp.idcat_empaque = ap.idcat_empaque
      ${JOIN_DETALLES_APROBADOS_AGREGADOS}
      LEFT JOIN LATERAL (
  SELECT
    spj.idsuaje_papel,
    spj.numero,
    spj.tamano,
    mx.medida_matrix AS matrix
  FROM suaje_papel spj
  LEFT JOIN matrix mx ON mx.idmatrix = spj.idcat_matrix
  WHERE
    CASE
      WHEN op.idcomponente_papel IS NOT NULL THEN spj.idcomponente_papel = op.idcomponente_papel
      ELSE spj.idproducto_papel = pp.idproducto_papel
    END
  ORDER BY spj.idsuaje_papel DESC
  LIMIT 1
) suj ON true
      WHERE sp.solicitud_idsolicitud = $1
        AND sp.tipo_material IN ('papel', 'especial')
      ORDER BY sp.idsolicitud_producto
    `, [pedido.idsolicitud]);

    const productosPlasticoFormateados = await Promise.all(productos.map(async (r: any) => {
      const materialUpper = (r.material || "").toUpperCase();
      const esBopp = materialUpper.includes("BOPP") ||
        materialUpper.includes("CELOFAN") ||
        materialUpper.includes("CELOFÁN");

      const calibre = esBopp
        ? (r.calibre_bopp ? String(r.calibre_bopp) : "")
        : (r.calibre_numero && Number(r.calibre_numero) !== 0 ? String(r.calibre_numero) : "");

      const altura = r.altura != null ? String(r.altura) : "";
      const ancho = r.ancho != null ? String(r.ancho) : "";
      const fuelleFondo = r.fuelle_fondo != null ? String(r.fuelle_fondo) : "";
      const fuelleLat = r.fuelle_lat_iz != null ? String(r.fuelle_lat_iz) : "";
      const refuerzo = r.refuerzo != null ? String(r.refuerzo) : "";

      const [url_render, url_master] = await Promise.all([
        r.render_public_id ? publicIdToBase64(r.render_public_id) : Promise.resolve(null),
        r.master_public_id ? publicIdToBase64(r.master_public_id) : Promise.resolve(null),
      ]);

      return {
        idsolicitud_producto: r.idsolicitud_producto,
        no_produccion: r.no_produccion ?? null,
        idproduccion: r.idproduccion ?? null,
        fecha_produccion: r.fecha_produccion ?? null,
        fecha_aprobacion_diseno: r.fecha_aprobacion_diseno ?? null,
        observaciones_diseno: r.observaciones_diseno || null,
        tiene_orden: !!r.no_produccion,
        nombre_producto: r.nombre_producto || "",
        categoria: r.categoria || "",
        material: r.material || "",
        calibre,
        medida: r.medida || "",
        altura,
        ancho,
        fuelle_fondo: fuelleFondo,
        fuelle_lat_iz: fuelleLat,
        fuelle_lat_de: r.fuelle_lat_de != null ? String(r.fuelle_lat_de) : "",
        refuerzo,
        por_kilo: r.por_kilo ? String(r.por_kilo) : null,
        descripcion: r.descripcion ?? null,
        medidas: {
          altura,
          ancho,
          fuelleFondo,
          fuelleLateral1: fuelleLat,
          fuelleLateral2: fuelleLat,
          refuerzo,
        },
        tintas: r.tintas ?? null,
        caras: r.caras ?? null,
        pigmentos: r.pigmentos || null,
        pantones: r.pantones
          ? r.pantones.split(",").map((p: string) => p.trim()).filter(Boolean)
          : null,
        asa_suaje: r.asa_suaje || null,
        id_color: r.id_color ?? null,
        color_asa_nombre: r.color_asa_nombre ?? null,
        id_medidatro: r.id_medidatro ?? null,
        medida_troquel: r.medida_troquel ?? null,
        observacion: r.observacion || null,
        perforacion: r.perforacion ?? false,
        cantidad: r.cantidad ? Number(r.cantidad) : null,
        kilogramos: r.kilogramos ? Number(r.kilogramos) : null,
        modo_cantidad: r.modo_cantidad || "unidad",
        repeticion_extrusion: r.repeticion_extrusion ? Number(r.repeticion_extrusion) : null,
        repeticion_metro: r.repeticion_metro ? Number(r.repeticion_metro) : null,
        metros: r.metros ? Number(r.metros) : null,
        ancho_bobina: r.ancho_bobina ? Number(r.ancho_bobina) : null,
        repeticion_kidder: r.repeticion_kidder ?? null,
        repeticion_sicosa: r.repeticion_sicosa ?? null,
        fecha_entrega: r.fecha_entrega ?? null,
        kilos: r.kilos != null ? Number(r.kilos) : null,
        kilos_merma: r.kilos_merma != null ? Number(r.kilos_merma) : null,
        pzas: r.pzas != null ? Number(r.pzas) : null,
        pzas_merma: r.pzas_merma != null ? Number(r.pzas_merma) : null,
        kilos_extruir: r.kilos_extruir ? Number(r.kilos_extruir) : null,
        metros_extruir: r.metros_extruir ? Number(r.metros_extruir) : null,
        es_parcialidad: Boolean(r.es_parcialidad ?? false),
        url_render,
        url_master,
        tipo_material: "plastico",
      };
    }));

    // ── MERMA DE PAPEL (Fase 7) ──
    // Mismo patrón en lote que en getSeguimiento: una sola consulta para
    // todos los productos de papel de este pedido.
    const idproduccionesPapelPdf = productosPapel
      .map((r: any) => r.idproduccion)
      .filter((id: any) => id != null);
    const mermaPorIdproduccionPdf = await getMermaDeOrdenBatch(idproduccionesPapelPdf);

    const productosPapelFormateados = await Promise.all(productosPapel.map(async (r: any) => {
      // Merma: se parte de la cantidad pedida y la merma se suma después,
      // ya en cortes (ver R1 en merma.service.ts). cantidad_a_producir se
      // sigue exponiendo pero solo como dato informativo.
      const mermaOrdenPdf = r.idproduccion != null
        ? mermaPorIdproduccionPdf.get(Number(r.idproduccion))
        : undefined;
      const cantidadPedida = mermaOrdenPdf?.cantidad_pedida ?? r.cantidad;
      const mermaTotal = mermaOrdenPdf?.merma_total ?? 0;
      const cantidadProduccion = mermaOrdenPdf?.cantidad_a_producir ?? r.cantidad;

      // Pliegos/bolsas se calculan con el rendimiento de HOJEADO (cómo se
      // tiene que cortar el material), no con el rendimiento general del
      // material — son dos campos distintos capturados en el alta.
      const cortes = calcularCortes(cantidadPedida, r.piezas_suaje);
      const cortesConMerma = sumarMermaACortes(cortes, mermaTotal);
      const pliegosCalculados = calcularPliegosPorRendimiento(cortesConMerma, r.hoj_rendimiento);
      const pliegosGuillotinaCalculados = calcularPliegosPorRendimiento(cortesConMerma, r.rendimiento);
      const maquinaHojeado = calcularMaquinaDesdePliegos(pliegosCalculados, r.hoj_rendimiento);
      const maquinaGuillotina = calcularMaquinaDesdePliegos(pliegosGuillotinaCalculados, r.rendimiento);
      const pliegoHojeado = r.hoj_corte || r.pliego || r.medida || null;

      // Rollo y desarrollo de laminado: si el producto los tiene registrados
      // desde su alta (acabados_papel.idrollo_lam / desarrollo_laminado),
      // esos valores fijos suplantan el cálculo automático desde las medidas
      // del pliego — y con ellos, todo lo que se deriva del desarrollo
      // (metros y rollos de laminación estimados).
      const rolloLamRegistradoCm = r.rollo_lam_medida_ancho != null ? Number(r.rollo_lam_medida_ancho) : null;
      const desarrolloLaminadoRegistradoCm = r.desarrollo_laminado != null ? Number(r.desarrollo_laminado) : null;

      const bobinaCm = rolloLamRegistradoCm ?? primeraMedidaCm(r.hoj_corte, r.pliego, r.medida);
      const desarrolloMm = desarrolloLaminadoRegistradoCm != null
        ? round2(desarrolloLaminadoRegistradoCm * 10)
        : calcularDesarrolloMm(r.hoj_corte, r.pliego, r.medida);
      const ctesMod =
        calcularCtesModDesdeDesarrollo(desarrolloMm) ??
        calcularCtesMod(r.hoj_corte, r.pliego, r.medida);
      // CORREGIDO (2026-08-24): ver la nota en getSeguimiento -- el conteo que
      // multiplica al desarrollo es de piezas de guillotina, no de pliegos.
      const metrosLaminacion = calcularMetrosLaminacion(maquinaGuillotina, desarrolloMm);
      const rollosLaminacion = metrosLaminacion === null ? null : round2(metrosLaminacion / 3000);
      const metrosLaminacionSinMerma = calcularMetrosLaminacion(cortes, desarrolloMm);
      const rollosLaminacionSinMerma = metrosLaminacionSinMerma === null ? null : round2(metrosLaminacionSinMerma / 3000);
      const bolsasArmadas = calcularBolsasPorRendimiento(pliegosCalculados, r.hoj_rendimiento);
      const refuerzoTexto = [r.refuerzo_material, r.refuerzo_medida]
        .filter(Boolean)
        .join(" ");
      const asaTexto = [
        r.asa_nombre,
        r.color_asa_nombre,
        r.asa_medida,
      ].filter(Boolean).join(" ");

      // NUEVO: Hojeado y Guillotina ya no dependen de metodo_hojeado (que
      // ahora siempre es NULL — esto se decide físicamente en producción,
      // no en el sistema). Ambos procesos aplican siempre para un producto
      // de papel, igual que en procesosOrdenPapelPdf.ts en el frontend.
      // Impresión, en cambio, sí depende de si el producto lleva tintas:
      // se puede cotizar "Sin tintas" (frente) y sin tintas por dentro, y
      // en ese caso no hay nada que imprimir.
      const tieneTintas = (Number(r.tintas) || 0) > 0 || (Number(r.tintas_dentro) || 0) > 0;

      // Fuente de la ruta real: si la OP ya existe, se le pregunta al MISMO
      // motor que usa producción (getProcesosDeOrdenPapelConTabla) en vez de
      // reconstruir la lógica de flags aquí aparte -- eso es lo que antes
      // dejaba a los especiales mostrando la ruta de un producto normal (la
      // de r.uv/r.laminado_nombre/etc., que son columnas de
      // solicitud_producto_papel/producto_papel, no de la ruta fija del
      // componente). Para especiales esto ya resuelve por
      // componente_papel_proceso (ver getProcesosDeOrdenPapel); para papel
      // normal resuelve por los mismos flags de siempre, sin cambios de
      // comportamiento.
      // Si todavía no existe idproduccion (producto aún no emitido a
      // producción), no hay de dónde leer la ruta real todavía -- se usa
      // esta lista como vista previa basada en los flags ya capturados,
      // igual que se hacía antes.
      const procesosAplican = r.idproduccion != null
        ? (await getProcesosDeOrdenPapelConTabla(pool, Number(r.idproduccion))).map((p: { tabla: string }) => p.tabla)
        : [
            "hojeado_papel",
            "guillotina_papel",
            tieneTintas ? "impresion_papel" : null,
            r.laminado_nombre ? "laminacion_papel" : null,
            r.uv === true ? "barniz_uv_papel" : null,
            r.foil_nombre ? "hot_stamping_papel" : null,
            r.textura_nombre ? "texturizado_papel" : null,
            r.alto_relieve === true ? "alto_relieve_papel" : null,
            "suaje_produccion_papel",
            r.lleva_armado === true ? "armado_papel" : null,
            "empaque_papel",
          ].filter(Boolean);

      // Especiales, sólo UNIÓN: piezas finales de cada OP de inicio hermana
      // (ver piezasFinalesHermanasPapel en procesosPapel.controller.ts) --
      // sólo tiene sentido calcularlo cuando ya existe idproduccion (si el
      // especial todavía no se emitió a producción no hay hermanas con
      // procesos que consultar) y cuando este componente es de tipo unión.
      const esUnionParaPiezas = r.idproduccion != null && r.componente_tipo === "union";
      const piezasFinalesHermanas = esUnionParaPiezas
        ? await piezasFinalesHermanasPapel(pool, Number(r.idproduccion))
        : [];
      // CORREGIDO (Jose, 2026-09-03): "si una OPIn tiene 4000 y la otra
      // 4150, no van a tener 8150, van a poder entregar 4000, porque
      // tienen que ir juntas, mas no sumadas" -- las OP de inicio hermanas
      // no se suman, se EMPAREJAN 1 a 1 (ej. cuerpo + asa de una misma
      // bolsa). Lo que la unión puede entregar está limitado por la
      // hermana que menos lleva entregado, no por la suma de todas.
      const piezasFinalesTotal = piezasFinalesHermanas.length > 0
        ? Math.min(
            ...piezasFinalesHermanas.map(
              (h: { cantidad_entregada: number | null }) => h.cantidad_entregada ?? 0
            )
          )
        : null;

      return {
        idsolicitud_producto: r.idsolicitud_producto,
        // Se respeta el valor real ("papel" o "especial") en vez de forzar
        // "papel" -- ver sp.tipo_material agregado al SELECT de arriba
        // (Jose, 2026-09-03).
        tipo_material: r.tipo_material ?? "papel",
        no_produccion: r.no_produccion ?? null,
        idproduccion: r.idproduccion ?? null,
        fecha_produccion: r.fecha_produccion ?? null,
        fecha_aprobacion_diseno: r.fecha_aprobacion_diseno ?? null,
        observaciones_diseno: r.observaciones_diseno || null,
        tiene_orden: !!r.no_produccion,
        nombre_producto: r.nombre_producto || "",
        descripcion: r.descripcion ?? r.descripcion_papel ?? null,
        categoria: "Papel",
        material: r.material || "",
        calibre: r.calibre || "",
        medida: r.medida || "",
        altura: r.altura != null ? String(r.altura) : "",
        ancho: r.ancho != null ? String(r.ancho) : "",
        fuelle_fondo: r.fuelle != null ? String(r.fuelle) : "",
        fuelle_lat_iz: "",
        fuelle_lat_de: "",
        refuerzo: refuerzoTexto || null,
        medidas: {
          altura: r.altura != null ? String(r.altura) : "",
          ancho: r.ancho != null ? String(r.ancho) : "",
          fuelleFondo: r.fuelle != null ? String(r.fuelle) : "",
          fuelleLateral1: "",
          fuelleLateral2: "",
          refuerzo: [r.refuerzo_material, r.refuerzo_medida]
            .filter(Boolean)
            .join(" "),
        },
        tintas: r.tintas != null ? Number(r.tintas) : null,
        tintas_dentro: r.tintas_dentro != null ? Number(r.tintas_dentro) : null,
        pantones: r.pantones
          ? String(r.pantones).split(",").map((p: string) => p.trim()).filter(Boolean)
          : null,
        pantones_dentro: r.pantones_dentro || null,
        observacion: r.observacion || null,
        // cantidad = lo que pidió el cliente, se muestra tal cual en el PDF.
        cantidad: r.cantidad != null ? Number(r.cantidad) : null,
        // cantidad_produccion = pedido + merma. La lee
        // ordenProduccionPapelPdf_helpers.ts::getValoresCalculadosPapel()
        // para calcular pliegos SIN inflar la cantidad mostrada al cliente.
        cantidad_produccion: cantidadProduccion != null ? Number(cantidadProduccion) : null,
        kilogramos: r.kilogramos != null ? Number(r.kilogramos) : null,
        modo_cantidad: r.modo_cantidad || "unidad",
        fecha_entrega: r.fecha_entrega ?? null,
        es_parcialidad: Boolean(r.es_parcialidad ?? false),

        metodo_hojeado: r.metodo_hojeado,
        lleva_armado: r.lleva_armado === true,
        procesos_aplican: procesosAplican,
        maquinaria_seleccionada: r.maquinaria_seleccionada ?? {},
        laminado_nombre: r.laminado_nombre || null,
        laminado: r.laminado_nombre || null,
        laminado_acabado: r.laminado_nombre || null,
        uv: r.uv === true,
        foil_nombre: r.foil_nombre || null,
        foil: r.foil_nombre || null,
        textura_nombre: r.textura_nombre || null,
        textura: r.textura_nombre || null,
        alto_relieve: r.alto_relieve === true,
        asa_nombre: r.asa_nombre || null,
        asa_tipo: r.asa_nombre || null,
        asa: r.asa_nombre || null,
        id_color: r.id_color ?? null,
        color_asa_nombre: r.color_asa_nombre || null,
        asa_color: r.color_asa_nombre || null,
        asa_medida: r.asa_medida || null,
        medida_asa: r.asa_medida || null,
        tamano_asa: r.asa_medida || null,
        asa_descripcion: asaTexto || null,
        grupo_descripcion: r.grupo_descripcion || null,
        pliego: r.pliego || null,
        pliego_hojeado: pliegoHojeado,
        rendimiento: r.rendimiento != null ? Number(r.rendimiento) : null,
        corte: r.corte || null,
        hoj_bobina: r.hoj_bobina || null,
        hoj_bobina_extra: r.hoj_bobina_extra || null,
        hoj_corte: r.hoj_corte || null,
        hoj_rendimiento:
          r.hoj_rendimiento != null ? Number(r.hoj_rendimiento) : null,
        hoj_guillotina: r.hoj_guillotina || null,
        hoj_hilo: r.hoj_hilo || null,

        // Valores listos para el PDF de procesos.
        // Impresión: cantidad de hojas/pliegos calculada desde piezas x rendimiento.
        cantidad_hojeada_calculada: pliegosCalculados,
        pliegos_impresion_estimados: pliegosCalculados,
        pliegos_guillotina: pliegosGuillotinaCalculados,
        cortes_calculados: cortes,
        // La merma va aparte para que el PDF pueda rehacer la cuenta igual
        // que el backend (cortes + merma -> techo -> pliegos -> máquina).
        cortes_con_merma: cortesConMerma,
        merma_total: mermaTotal,
        maquina_hojeado_calculada: maquinaHojeado,
        maquina_guillotina_calculada: maquinaGuillotina,
        piezas_suaje: r.piezas_suaje != null ? Number(r.piezas_suaje) : null,
        // CORREGIDO (2026-08-21): la ficha de material de IMPRESIÓN lleva el
        // CORTE del producto dado de alta (`corte`), no el pliego hojeado —
        // son dos datos distintos y se estaba mandando el equivocado.
        material_impresion: [r.material, r.calibre, r.corte]
          .filter(Boolean)
          .join(" "),
        tintas_frente: r.tintas != null ? Number(r.tintas) : null,
        tintas_reverso: r.tintas_dentro != null ? Number(r.tintas_dentro) : null,
        pantones_frente: r.pantones
          ? String(r.pantones).split(",").map((p: string) => p.trim()).filter(Boolean)
          : null,
        pantones_reverso: r.pantones_dentro
          ? String(r.pantones_dentro).split(",").map((p: string) => p.trim()).filter(Boolean)
          : null,

        // Laminación: desarrollo en mm, bobina y CTES/mod se derivan del pliego hojeado.
        bobina_cm: bobinaCm,
        bobina_laminacion_cm: bobinaCm,
        desarrollo_mm: desarrolloMm,
        desarrollo_laminacion_mm: desarrolloMm,
        ctes_mod: ctesMod,
        ctes_mod_laminacion: ctesMod,
        metros_laminacion_estimados: metrosLaminacion,
        // Temporal: 3000 m por rollo, porque el ejemplo usa 2700 m = 0.9 rollos.
        rollos_laminacion_estimados: rollosLaminacion,
        metros_laminacion_sin_merma: metrosLaminacionSinMerma,
        rollos_laminacion_sin_merma: rollosLaminacionSinMerma,

        tipo_pegue: r.tipo_pegue || null,
        tipo_pegado: r.tipo_pegue || null,
        pegamento: r.pegamento || null,
        suaje: r.suaje || null,
        suaje_nombre: r.suaje || null,
        numero_suaje: r.suaje || null,
        suaje_tamano: r.suaje_tamano || null,
        matrix: r.matrix || null,
        base_medida: r.base_medida || null,
        base: r.base_medida || null,
        refuerzo_material: r.refuerzo_material || null,
        refuerzo_medida: r.refuerzo_medida || null,
        maquina_armado_pdf: "Manual",
        bolsas_armadas_calculadas: bolsasArmadas,
        tipo_caja: r.tipo_caja || null,
        empaque: r.tipo_caja || null,
        cantidad_por_caja:
          r.pzs_caja != null ? Number(r.pzs_caja) : null,
        pzs_caja: r.pzs_caja != null ? Number(r.pzs_caja) : null,

        // ── Registros runtime de los procesos (merma, entregadas, máquina…) ──
        registros_procesos: r.registros_procesos ?? {},

        // ── Especiales: a qué componente pertenece esta OP (null en papel normal) ──
        es_especial: r.es_especial === true,
        idcomponente_papel: r.idcomponente_papel ?? null,
        componente: r.idcomponente_papel != null
          ? {
              id: r.idcomponente_papel,
              tipo: r.componente_tipo ?? null,
              nombre: r.componente_nombre ?? null,
              orden: r.componente_orden ?? null,
            }
          : null,

        // ── Especiales, sólo UNIÓN: piezas finales de cada OP de inicio
        // hermana (último proceso de cada una), para saber cuántas piezas
        // debe recibir/tener a la mano la unión antes de arrancar. El
        // MÍNIMO entre todas (piezas_finales_total) alimenta el PDF: es la
        // "entrada" del primer proceso de la unión, que de otra forma
        // quedaría en blanco porque no hay ningún proceso "anterior" dentro
        // de la propia ruta de la unión (Jose, 2026-09-02) -- NO es la suma:
        // las hermanas se emparejan 1 a 1, así que lo entregable está
        // limitado por la que menos lleva (Jose, 2026-09-03).
        piezas_finales_hermanas: piezasFinalesHermanas,
        piezas_finales_total: piezasFinalesTotal,
      };
    }));

    const productosFormateados = [
      ...productosPlasticoFormateados,
      ...productosPapelFormateados,
    ];

    return res.json({
      no_pedido: pedido.no_pedido ?? "",
      no_cotizacion: pedido.no_cotizacion ?? null,
      fecha: pedido.fecha,
      prioridad: Boolean(pedido.prioridad),
      cliente: pedido.cliente ?? "",
      empresa: pedido.empresa ?? "",
      telefono: pedido.telefono ?? "",
      correo: pedido.correo ?? "",
      impresion: pedido.cliente_impresion ?? null,
      total_productos: productosFormateados.length,
      con_orden: productosFormateados.filter((p: any) => p.tiene_orden).length,
      productos: productosFormateados,
    });

  } catch (error: any) {
    console.error("❌ GET ORDEN PRODUCCION ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener la orden de producción" });
  }
};

// ============================================================
// GET /api/seguimiento/:idproduccion/bultos/etiqueta
// ── Prioriza direccion_envio, si no hay cae a domicilio ──
//
// SIN CAMBIOS -- igual que el original. Pendiente: adaptar para
// reconocer bultos de papel (empaque_papel_idempaque_papel) en una
// próxima vuelta (no se tocó en esta conversación).
// ============================================================
export const getBultosEtiqueta = async (req: Request, res: Response) => {
  try {
    const { idproduccion } = req.params;

    const { rows: pedidoRows } = await pool.query(`
      SELECT
        s.no_pedido,
        s.fecha,
        op.no_produccion,
        op.idproduccion,
        op.fecha_entrega,
        op.bultos_finalizado,
        op.es_parcialidad,
        cli.razon_social  AS cliente,
        cli.atencion,
        cli.empresa,
        cli.telefono,
        cli.celular,
        cli.correo,
        cli.impresion     AS cliente_impresion,

        COALESCE(de.domicilio,     dom.domicilio)     AS calle,
        COALESCE(de.numero,        dom.numero)        AS numero,
        COALESCE(de.colonia,       dom.colonia)       AS colonia,
        COALESCE(de.codigo_postal, dom.codigo_postal) AS codigo_postal,
        COALESCE(de.poblacion,     dom.poblacion)     AS poblacion,
        COALESCE(de.estado,        dom.estado)        AS estado,
        de.referencia                                 AS referencia_envio,

        tpp.material_plastico_producto AS nombre_producto,
        cfg.medida,
        sp.descripcion,
        mp.tipo_material               AS material,
        sd.cantidad,
        sd.kilogramos,
        sd.modo_cantidad,
        COALESCE(af.pzas_finales, bol.piezas_bolseadas) AS cantidad_real
      FROM orden_produccion op
      JOIN solicitud_producto sp
          ON sp.idsolicitud_producto = op.idsolicitud_producto
      JOIN solicitud s
          ON s.idsolicitud = sp.solicitud_idsolicitud
      JOIN clientes cli
          ON cli.idclientes = s.clientes_idclientes
      LEFT JOIN domicilio dom
          ON dom.clientes_idclientes = cli.idclientes
      LEFT JOIN direccion_envio de
          ON de.clientes_idclientes = cli.idclientes
      LEFT JOIN configuracion_plastico cfg
          ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN tipo_producto_plastico tpp
          ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN material_plastico mp
          ON mp.idmaterial_plastico = cfg.material_plastico_plastico_idmaterial_plastico
      ${JOIN_DETALLES_APROBADOS_AGREGADOS}
      LEFT JOIN asa_flexible af
          ON af.orden_produccion_idproduccion = op.idproduccion
      LEFT JOIN bolseo bol
          ON bol.orden_produccion_idproduccion = op.idproduccion
      WHERE op.idproduccion = $1
      LIMIT 1
    `, [idproduccion]);

    if (pedidoRows.length === 0)
      return res.status(404).json({ error: "Orden no encontrada" });

    const pedido = pedidoRows[0];

    // ── Validación: permitir si bultos finalizados O si es parcialidad ───────
    const esParcialidad = Boolean(pedido.es_parcialidad);

    if (!pedido.bultos_finalizado && !esParcialidad)
      return res.status(403).json({ error: "Los bultos aún no están finalizados" });

    const { rows: bultosRows } = await pool.query(`
      SELECT
        b.idbulto,
        b.cantidad_unidades,
        b.fecha_creacion,
        b.peso_producto,
        b.peso,
        b.alto,
        b.largo,
        b.ancho,
        CASE
          WHEN b.asa_flexible_idasa_flexible IS NOT NULL THEN 'asa_flexible'
          ELSE 'bolseo'
        END AS proceso_origen
      FROM bultos b
      WHERE
        b.bolseo_idbolseo IN (
          SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = $1
        )
        OR
        b.asa_flexible_idasa_flexible IN (
          SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = $1
        )
      ORDER BY b.idbulto ASC
    `, [idproduccion]);

    // ── Número de envío parcial: envíos ya procesados + 1 (el actual) ───────
    let numeroEnvioParcial: number | null = null;
    if (esParcialidad) {
      const { rows: countRows } = await pool.query(`
        SELECT COUNT(DISTINCT e.idenvio) AS total
        FROM envio e
        JOIN envio_bulto eb ON eb.envio_idenvio = e.idenvio
        JOIN bultos b ON b.idbulto = eb.bultos_idbulto
        WHERE e.es_parcialidad = true
          AND (
            b.bolseo_idbolseo IN (
              SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = $1
            )
            OR
            b.asa_flexible_idasa_flexible IN (
              SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = $1
            )
          )
      `, [idproduccion]);
      numeroEnvioParcial = Number(countRows[0].total) + 1;
    }

    return res.json({
      no_pedido: pedido.no_pedido,
      no_produccion: pedido.no_produccion,
      fecha: pedido.fecha,
      fecha_entrega: pedido.fecha_entrega ?? null,
      cliente: pedido.cliente || "",
      atencion: pedido.atencion || null,
      empresa: pedido.empresa || "",
      telefono: pedido.telefono || "",
      celular: pedido.celular || "",
      correo: pedido.correo || "",
      cliente_impresion: pedido.cliente_impresion || "",
      calle: pedido.calle || "",
      numero: pedido.numero || "",
      colonia: pedido.colonia || "",
      codigo_postal: pedido.codigo_postal || "",
      poblacion: pedido.poblacion || "",
      estado: pedido.estado || "",
      referencia_envio: pedido.referencia_envio || null,
      nombre_producto: pedido.nombre_producto || "",
      descripcion: pedido.descripcion || null,
      medida: pedido.medida || "",
      material: pedido.material || "",
      cantidad_total: pedido.cantidad_real != null
        ? Number(pedido.cantidad_real)
        : pedido.cantidad ? Number(pedido.cantidad) : null,
      kilogramos: pedido.kilogramos ? Number(pedido.kilogramos) : null,
      modo_cantidad: pedido.modo_cantidad || "unidad",
      total_bultos: bultosRows.length,
      total_kg: bultosRows.reduce((sum: number, b: any) =>
        sum + (b.peso_producto != null ? Number(b.peso_producto) : 0), 0),
      bultos: bultosRows.map((b: any) => ({
        idbulto: b.idbulto,
        cantidad_unidades: Number(b.cantidad_unidades),
        fecha_creacion: b.fecha_creacion,
        proceso_origen: b.proceso_origen,
        peso_producto: b.peso_producto != null ? Number(b.peso_producto) : null,
        peso: b.peso != null ? Number(b.peso) : null,
        alto: b.alto != null ? Number(b.alto) : null,
        largo: b.largo != null ? Number(b.largo) : null,
        ancho: b.ancho != null ? Number(b.ancho) : null,
      })),
      es_parcialidad: esParcialidad,
      numero_envio_parcial: numeroEnvioParcial,
    });

  } catch (error: any) {
    console.error("❌ GET BULTOS ETIQUETA ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener datos de etiqueta" });
  }
};