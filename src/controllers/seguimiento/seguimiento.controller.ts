import { Request, Response } from "express";
import { pool } from "../../config/db";
import { getPresignedUrl } from "../../config/multer";

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

const calcularPliegosPorRendimiento = (cantidad: unknown, rendimiento: unknown): number | null => {
  const cantidadNum = toNumberOrNull(cantidad);
  const rendimientoNum = toNumberOrNull(rendimiento);
  if (cantidadNum === null || rendimientoNum === null || rendimientoNum <= 0) return null;
  return round2(cantidadNum * rendimientoNum);
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

const calcularMetrosLaminacion = (pliegos: unknown, desarrolloMm: unknown): number | null => {
  const pliegosNum = toNumberOrNull(pliegos);
  const desarrolloNum = toNumberOrNull(desarrolloMm);
  if (pliegosNum === null || desarrolloNum === null || desarrolloNum <= 0) return null;
  return round2((pliegosNum * desarrolloNum) / 1000);
};

// ============================================================
// GET /api/seguimiento
// ============================================================
export const getSeguimiento = async (req: Request, res: Response) => {
  try {
    // ── Query de PLÁSTICO (idéntico al original, sin cambios) ──────────
    const { rows: rowsPlastico } = await pool.query(`
      SELECT
        s.idsolicitud,
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

        CASE WHEN v.abono < v.anticipo
              AND v.estado_administrativo_cat_idestado_administrativo_cat NOT IN (2, 6)
             THEN v.fecha_creacion ELSE NULL END                            AS anticipo_fecha_estado,
        CASE WHEN v.saldo > 0.01
             THEN v.fecha_creacion ELSE NULL END                            AS pago_fecha_estado,
        CASE WHEN dp.estado_administrativo_cat_idestado_administrativo_cat != 3
             THEN d.fecha ELSE NULL END                                     AS diseno_fecha_estado,
        CASE WHEN od.estado != 'aprobado'
             THEN od.created_at ELSE NULL END                               AS od_fecha_estado,

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
        od.estado                       AS od_estado

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
      LEFT JOIN solicitud_detalle sd
          ON sd.solicitud_producto_id = sp.idsolicitud_producto
          AND sd.aprobado = true
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

        CASE WHEN (v.abono >= v.anticipo OR v.estado_administrativo_cat_idestado_administrativo_cat IN (2, 6))
              AND dp.estado_administrativo_cat_idestado_administrativo_cat = 3
              AND op.no_produccion IS NOT NULL
             THEN true ELSE false END                 AS puede_pdf,

        CASE WHEN v.abono < v.anticipo
              AND v.estado_administrativo_cat_idestado_administrativo_cat NOT IN (2, 6)
             THEN v.fecha_creacion ELSE NULL END                            AS anticipo_fecha_estado,
        CASE WHEN v.saldo > 0.01
             THEN v.fecha_creacion ELSE NULL END                            AS pago_fecha_estado,
        CASE WHEN dp.estado_administrativo_cat_idestado_administrativo_cat != 3
             THEN d.fecha ELSE NULL END                                     AS diseno_fecha_estado,
        CASE WHEN od.estado != 'aprobado'
             THEN od.created_at ELSE NULL END                               AS od_fecha_estado,

        -- ── Envío: mismo criterio que plástico (subquery por orden). Para
        -- papel hoy siempre da 0 bultos porque los bultos aún no se ligan
        -- a procesos de papel (pendiente adaptar cuando se implemente) —
        -- eso cae naturalmente en "no-aplica" en el mapeo de abajo.
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
        dmp.hoj_bobina_extra,

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
        od.estado                       AS od_estado

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
      LEFT JOIN detalle_material_papel dmp
          ON dmp.idgrupo_papel = gp.idgrupo_papel
      LEFT JOIN cat_tipo_papel ctp
          ON ctp.idcat_tipo_papel = dmp.idcat_tipo_papel
      LEFT JOIN cat_calibre cc
          ON cc.idcat_calibre = dmp.idcat_calibre
      LEFT JOIN ventas v
          ON v.solicitud_idsolicitud = s.idsolicitud
      LEFT JOIN diseno d
          ON d.solicitud_idsolicitud = s.idsolicitud
      LEFT JOIN diseno_producto dp
          ON dp.diseno_iddiseno = d.iddiseno
          AND dp.solicitud_producto_idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN orden_produccion op
          ON op.idsolicitud_producto = sp.idsolicitud_producto
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
      LEFT JOIN acabados_papel ap
          ON ap.idproducto_papel = pp.idproducto_papel
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
      LEFT JOIN solicitud_detalle sd
          ON sd.solicitud_producto_id = sp.idsolicitud_producto
          AND sd.aprobado = true
      LEFT JOIN orden_diseno od
          ON od.solicitud_producto_id = sp.idsolicitud_producto

      WHERE s.estado = 'pedido'
        AND s.no_pedido IS NOT NULL
        AND sp.tipo_material = 'papel'

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

        anticipo_fecha_estado: row.anticipo_fecha_estado ?? null,
        pago_fecha_estado: row.pago_fecha_estado ?? null,
        diseno_fecha_estado: row.diseno_fecha_estado ?? null,
        od_fecha_estado: row.od_fecha_estado ?? null,
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

        es_parcialidad: Boolean(row.es_parcialidad ?? false),
      };
    });

    const resultadoPapel = rowsPapel.map((row: any) => {
      const resumen = row.idproduccion != null
        ? resumenPorIdproduccion.get(Number(row.idproduccion))
        : undefined;

      return {
        idsolicitud: Number(row.idsolicitud),
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

        // Estado resumido de producción de papel (consume el modal
        // selector de procesos, no columnas individuales).
        estado_resumen_papel: resumen?.estado ?? "pendiente",
        estado_resumen_papel_fecha: resumen?.fecha ?? null,

        anticipo_fecha_estado: row.anticipo_fecha_estado ?? null,
        pago_fecha_estado: row.pago_fecha_estado ?? null,
        diseno_fecha_estado: row.diseno_fecha_estado ?? null,
        od_fecha_estado: row.od_fecha_estado ?? null,
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

        hoj_bobina: row.hoj_bobina || null,
        hoj_bobina_extra: row.hoj_bobina_extra || null,
        hoj_corte: row.hoj_corte || null,
        hoj_rendimiento: row.hoj_rendimiento || null,
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
        kilogramos_orden: row.kilogramos_orden ? Number(row.kilogramos_orden) : null,
        modo_cantidad: row.modo_cantidad || "unidad",
        fecha_entrega: null,

        idorden_diseno: row.idorden_diseno ?? null,
        od_estado: row.od_estado ?? null,
      };
    });

    return res.json([...resultadoPlastico, ...resultadoPapel]);

  } catch (error: any) {
    console.error("❌ GET SEGUIMIENTO ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener seguimiento" });
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

    // ── PLÁSTICO (sin cambios, filtra tipo_material <> 'papel') ──────────
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
      LEFT JOIN solicitud_detalle sd
          ON sd.solicitud_producto_id = sp.idsolicitud_producto
          AND sd.aprobado = true
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
        AND sp.tipo_material <> 'papel'
      ORDER BY sp.idsolicitud_producto
    `, [pedido.idsolicitud]);

    // ── PAPEL (ficha completa + registros_procesos runtime) ──────────────
    const { rows: productosPapel } = await pool.query(`
      SELECT
        sp.idsolicitud_producto,
        op.idproduccion,
        op.no_produccion,
        op.fecha AS fecha_produccion,
        op.fecha_entrega,
        op.es_parcialidad,
        dp.fecha_aprobacion AS fecha_aprobacion_diseno,
        dp.observaciones AS observaciones_diseno,

        ctpp.nombre AS nombre_producto,
        pp.descripcion_papel,
        pp.medida,
        pp.ancho,
        pp.fuelle,
        pp.altura,
        pp.tamano_asa_default,
        sp.grupo_papel_descripcion AS grupo_descripcion,
        ctp.nombre AS material,
        cc.nombre AS calibre,
        dmp.pliego,
        dmp.rendimiento,
        dmp.corte,
        dmp.hoj_bobina,
        dmp.hoj_corte,
        dmp.hoj_rendimiento,
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
          )
        )) AS registros_procesos

      FROM solicitud_producto sp
      JOIN solicitud_producto_papel spp
        ON spp.idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN orden_produccion op
        ON op.idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN diseno_producto dp
        ON dp.solicitud_producto_idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN grupo_papel gp
        ON gp.idgrupo_papel = sp.grupo_papel_idgrupo_papel
      LEFT JOIN producto_papel pp
        ON pp.idproducto_papel = COALESCE(sp.producto_papel_idproducto_papel, gp.idproducto_papel)
      LEFT JOIN cat_tipo_producto_papel ctpp
        ON ctpp.idcat_tipo_producto_papel = pp.idcat_tipo_producto_papel
      LEFT JOIN detalle_material_papel dmp
        ON dmp.idgrupo_papel = gp.idgrupo_papel
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
      LEFT JOIN acabados_papel ap
        ON ap.idproducto_papel = pp.idproducto_papel
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
      LEFT JOIN solicitud_detalle sd
        ON sd.solicitud_producto_id = sp.idsolicitud_producto
        AND sd.aprobado = true
      LEFT JOIN LATERAL (
  SELECT
    spj.idsuaje_papel,
    spj.numero,
    spj.tamano,
    mx.medida_matrix AS matrix
  FROM suaje_papel spj
  LEFT JOIN matrix mx ON mx.idmatrix = spj.idcat_matrix
  WHERE spj.idproducto_papel = pp.idproducto_papel
  ORDER BY spj.idsuaje_papel DESC
  LIMIT 1
) suj ON true
      WHERE sp.solicitud_idsolicitud = $1
        AND sp.tipo_material = 'papel'
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

    const productosPapelFormateados = productosPapel.map((r: any) => {
      const pliegosCalculados = calcularPliegosPorRendimiento(r.cantidad, r.rendimiento);
      const pliegoHojeado = r.hoj_corte || r.pliego || r.medida || null;
      const bobinaCm = primeraMedidaCm(r.hoj_corte, r.pliego, r.medida);
      const desarrolloMm = calcularDesarrolloMm(r.hoj_corte, r.pliego, r.medida);
      const ctesMod = calcularCtesMod(r.hoj_corte, r.pliego, r.medida);
      const metrosLaminacion = calcularMetrosLaminacion(pliegosCalculados, desarrolloMm);
      const rollosLaminacion = metrosLaminacion === null ? null : round2(metrosLaminacion / 3000);
      const bolsasArmadas = calcularBolsasPorRendimiento(pliegosCalculados, r.rendimiento);
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
      const procesosAplican = [
        "hojeado_papel",
        "guillotina_papel",
        "impresion_papel",
        r.laminado_nombre ? "laminacion_papel" : null,
        r.uv === true ? "barniz_uv_papel" : null,
        r.foil_nombre ? "hot_stamping_papel" : null,
        r.textura_nombre ? "texturizado_papel" : null,
        r.alto_relieve === true ? "alto_relieve_papel" : null,
        "suaje_produccion_papel",
        r.lleva_armado === true ? "armado_papel" : null,
        "empaque_papel",
      ].filter(Boolean);

      return {
        idsolicitud_producto: r.idsolicitud_producto,
        tipo_material: "papel",
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
        cantidad: r.cantidad != null ? Number(r.cantidad) : null,
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
        material_impresion: [r.material, r.calibre, pliegoHojeado]
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
      };
    });

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
      LEFT JOIN solicitud_detalle sd
          ON sd.solicitud_producto_id = sp.idsolicitud_producto
          AND sd.aprobado = true
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