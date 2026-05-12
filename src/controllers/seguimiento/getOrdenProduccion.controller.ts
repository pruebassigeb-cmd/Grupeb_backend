import { Request, Response } from "express";
import { pool } from "../../config/db";
import { getPresignedUrl } from "../../config/multer";

// ── Descarga imagen desde S3 y la retorna como data URL base64 ──
async function publicIdToBase64(publicId: string): Promise<string | null> {
  try {
    const url      = await getPresignedUrl(publicId);
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`⚠️ publicIdToBase64: fetch failed ${response.status} para ${publicId}`);
      return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer      = Buffer.from(arrayBuffer);
    const mime        = response.headers.get("content-type") || "image/png";
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch (e: any) {
    console.error("❌ publicIdToBase64 error:", e.message);
    return null;
  }
}

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
        cli.impresion
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

        -- Orden de producción
        op.idproduccion,
        op.no_produccion,
        op.fecha            AS fecha_produccion,

        -- Producto
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

        -- Características
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

        -- Asa/Suaje
        asz.tipo AS asa_suaje,

        -- Color del Asa
        sp.id_color,
        ca.color AS color_asa_nombre,

        -- Medida del Troquel
        sp.id_medidatro,
        mt.medida AS medida_troquel,

        -- Cantidad aprobada por el cliente
        sd.cantidad,
        sd.kilogramos,
        sd.modo_cantidad,

        -- Fecha aprobación diseño
        dp.fecha_aprobacion AS fecha_aprobacion_diseno,
        dp.observaciones    AS observaciones_diseno,

        -- Datos de extrusión calculados al crear la orden
        op.repeticion_extrusion,
        op.repeticion_metro,
        op.metros,
        op.ancho_bobina,
        op.repeticion_kidder,
        op.repeticion_sicosa,
        op.fecha_entrega,

        -- Campos de merma
        op.kilos,
        op.kilos_merma,
        op.pzas,
        op.pzas_merma,

        -- Progreso real de extrusión
        ext.kilos_extruir,
        ext.metros_extruir,

        -- Render: archivo con categoria='render' de la revisión marcada como versión final
        ar.public_id AS render_public_id,

        -- Master: archivo con categoria='master' de cualquier revisión de la misma orden
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

      -- Orden de diseño ligada al producto
      LEFT JOIN orden_diseno od
          ON od.solicitud_producto_id = sp.idsolicitud_producto

      -- Revisión marcada como versión final
      LEFT JOIN revision_diseno rd_final
          ON rd_final.orden_diseno_id = od.idorden_diseno
          AND rd_final.es_version_final = true

      -- Render: categoria='render' de la revisión final
      LEFT JOIN archivos ar
          ON ar.revision_diseno_id = rd_final.idrevision
          AND ar.categoria = 'render'

      -- Master: categoria='master' de cualquier revisión de la misma orden
      LEFT JOIN archivos am
          ON am.revision_diseno_id IN (
            SELECT idrevision FROM revision_diseno
            WHERE orden_diseno_id = od.idorden_diseno
          )
          AND am.categoria = 'master'

      WHERE sp.solicitud_idsolicitud = $1
      ORDER BY sp.idsolicitud_producto
    `, [pedido.idsolicitud]);

    // Convertir imágenes a base64 en el backend para evitar CORS en el frontend
    const productosFormateados = await Promise.all(productos.map(async (r: any) => {
      const materialUpper = (r.material || "").toUpperCase();
      const esBopp = materialUpper.includes("BOPP") ||
                     materialUpper.includes("CELOFAN") ||
                     materialUpper.includes("CELOFÁN");

      const calibre = esBopp
        ? (r.calibre_bopp ? String(r.calibre_bopp) : "")
        : (r.calibre_numero && Number(r.calibre_numero) !== 0 ? String(r.calibre_numero) : "");

      const altura      = r.altura        != null ? String(r.altura)        : "";
      const ancho       = r.ancho         != null ? String(r.ancho)         : "";
      const fuelleFondo = r.fuelle_fondo  != null ? String(r.fuelle_fondo)  : "";
      const fuelleLat   = r.fuelle_lat_iz != null ? String(r.fuelle_lat_iz) : "";
      const refuerzo    = r.refuerzo      != null ? String(r.refuerzo)      : "";

      // Descargar imágenes en el backend y mandar como base64
      const [url_render, url_master] = await Promise.all([
        r.render_public_id ? publicIdToBase64(r.render_public_id) : Promise.resolve(null),
        r.master_public_id ? publicIdToBase64(r.master_public_id) : Promise.resolve(null),
      ]);

      console.log(`📦 [${r.idsolicitud_producto}] render base64:`, url_render ? `OK (${url_render.length} chars)` : "null");
      console.log(`📦 [${r.idsolicitud_producto}] master base64:`, url_master ? `OK (${url_master.length} chars)` : "null");

      return {
        idsolicitud_producto:    r.idsolicitud_producto,
        no_produccion:           r.no_produccion           ?? null,
        idproduccion:            r.idproduccion            ?? null,
        fecha_produccion:        r.fecha_produccion        ?? null,
        fecha_aprobacion_diseno: r.fecha_aprobacion_diseno ?? null,
        observaciones_diseno:    r.observaciones_diseno    || null,
        tiene_orden:             !!r.no_produccion,
        nombre_producto:         r.nombre_producto || "",
        categoria:               r.categoria       || "",
        material:                r.material        || "",
        calibre,
        medida:                  r.medida          || "",
        altura,
        ancho,
        fuelle_fondo:            fuelleFondo,
        fuelle_lat_iz:           fuelleLat,
        fuelle_lat_de:           r.fuelle_lat_de != null ? String(r.fuelle_lat_de) : "",
        refuerzo,
        por_kilo:                r.por_kilo ? String(r.por_kilo) : null,
        medidas: {
          altura,
          ancho,
          fuelleFondo,
          fuelleLateral1: fuelleLat,
          fuelleLateral2: fuelleLat,
          refuerzo,
        },
        tintas:      r.tintas   ?? null,
        caras:       r.caras    ?? null,
        bk:          r.bk       ?? null,
        foil:        r.foil     ?? null,
        alto_rel:    r.alto_rel ?? null,
        laminado:    r.laminado ?? null,
        uv_br:       r.uv_br    ?? null,
        pigmentos:   r.pigmentos || null,
        pantones:    r.pantones
          ? r.pantones.split(",").map((p: string) => p.trim()).filter(Boolean)
          : null,
        asa_suaje:        r.asa_suaje        || null,
        id_color:         r.id_color         ?? null,
        color_asa_nombre: r.color_asa_nombre ?? null,
        id_medidatro:     r.id_medidatro     ?? null,
        medida_troquel:   r.medida_troquel   ?? null,
        observacion:      r.observacion      || null,
        cantidad:    r.cantidad   ? Number(r.cantidad)   : null,
        kilogramos:  r.kilogramos ? Number(r.kilogramos) : null,
        modo_cantidad: r.modo_cantidad || "unidad",
        repeticion_extrusion: r.repeticion_extrusion ? Number(r.repeticion_extrusion) : null,
        repeticion_metro:     r.repeticion_metro     ? Number(r.repeticion_metro)     : null,
        metros:               r.metros               ? Number(r.metros)               : null,
        ancho_bobina:         r.ancho_bobina         ? Number(r.ancho_bobina)         : null,
        repeticion_kidder:    r.repeticion_kidder    ?? null,
        repeticion_sicosa:    r.repeticion_sicosa    ?? null,
        fecha_entrega:        r.fecha_entrega        ?? null,
        kilos:       r.kilos       != null ? Number(r.kilos)       : null,
        kilos_merma: r.kilos_merma != null ? Number(r.kilos_merma) : null,
        pzas:        r.pzas        != null ? Number(r.pzas)        : null,
        pzas_merma:  r.pzas_merma  != null ? Number(r.pzas_merma)  : null,
        kilos_extruir:  r.kilos_extruir  ? Number(r.kilos_extruir)  : null,
        metros_extruir: r.metros_extruir ? Number(r.metros_extruir) : null,
        // ── Base64 de render y master (listos para jsPDF, sin CORS) ──
        url_render,
        url_master,
      };
    }));

    return res.json({
      no_pedido:       pedido.no_pedido ?? "",
      no_cotizacion:   pedido.no_cotizacion ?? null,
      fecha:           pedido.fecha,
      prioridad:       Boolean(pedido.prioridad),
      cliente:         pedido.cliente   || "",
      empresa:         pedido.empresa   || "",
      telefono:        pedido.telefono  || "",
      correo:          pedido.correo    || "",
      impresion:       pedido.impresion ?? null,
      productos:       productosFormateados,
      total_productos: productosFormateados.length,
      con_orden:       productosFormateados.filter((p: any) => p.tiene_orden).length,
    });

  } catch (error: any) {
    console.error("❌ GET ORDEN PRODUCCION ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener orden de producción" });
  }
};