import { Request, Response } from "express";
import { pool } from "../../config/db";

// ============================================================
// GET /api/seguimiento
// ============================================================
export const getSeguimiento = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
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
        en.fecha_envio                                                      AS envio_fecha_estado,

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
        sp.descripcion,
        sp.perforacion,
        sp.bk,
        sp.foil,
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
      LEFT JOIN envio en
          ON en.solicitud_idsolicitud = s.idsolicitud

      WHERE s.estado = 'pedido'
        AND s.no_pedido IS NOT NULL

      ORDER BY s.no_pedido DESC, sp.idsolicitud_producto ASC
    `);

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

    const resultado = rows.map((row: any) => {
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
        bk: row.bk != null ? Boolean(row.bk) : null,
        foil: row.foil != null ? Boolean(row.foil) : null,
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

    return res.json(resultado);

  } catch (error: any) {
    console.error("❌ GET SEGUIMIENTO ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener seguimiento" });
  }
};

// ============================================================
// GET /api/seguimiento/:noPedido/orden-produccion
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
        sp.bk,
        sp.foil,
        sp.alto_rel,
        sp.laminado,
        sp.uv_br,
        sp.pigmentos,
        sp.pantones,
        sp.observacion,
        sp.perforacion,

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
        ext.metros_extruir

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
      WHERE sp.solicitud_idsolicitud = $1
      ORDER BY sp.idsolicitud_producto
    `, [pedido.idsolicitud]);

    const productosFormateados = productos.map((r: any) => {
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
        bk: r.bk ?? null,
        foil: r.foil ?? null,
        alto_rel: r.alto_rel ?? null,
        laminado: r.laminado ?? null,
        uv_br: r.uv_br ?? null,
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
      };
    });

    return res.json({
      no_pedido: pedido.no_pedido ?? "",
      no_cotizacion: pedido.no_cotizacion ?? null,
      fecha: pedido.fecha,
      prioridad: Boolean(pedido.prioridad),
      cliente: pedido.cliente || "",
      empresa: pedido.empresa || "",
      telefono: pedido.telefono || "",
      correo: pedido.correo || "",
      impresion: pedido.cliente_impresion ?? null,
      productos: productosFormateados,
      total_productos: productosFormateados.length,
      con_orden: productosFormateados.filter((p: any) => p.tiene_orden).length,
    });

  } catch (error: any) {
    console.error("❌ GET ORDEN PRODUCCION ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener orden de producción" });
  }
};

// ============================================================
// GET /api/seguimiento/:idproduccion/bultos/etiqueta
// ── Prioriza direccion_envio, si no hay cae a domicilio ──
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