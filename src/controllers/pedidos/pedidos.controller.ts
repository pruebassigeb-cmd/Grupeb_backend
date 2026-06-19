import { Request, Response } from "express";
import { pool } from "../../config/db";

function normalizarNombreEstado(nombre: string): string {
  if (!nombre) return "Pendiente";
  const n = nombre.toLowerCase().trim();
  if (n === "aprobado" || n === "aprobada") return "Aprobada";
  if (n === "rechazado" || n === "rechazada") return "Rechazada";
  return "Pendiente";
}

async function resolverIdTintas(client: any, cantidad: number): Promise<number | null> {
  const { rows } = await client.query(
    `SELECT idtintas FROM tintas WHERE cantidad = $1 LIMIT 1`, [cantidad]
  );
  return rows[0]?.idtintas ?? null;
}

async function resolverIdCaras(client: any, cantidad: number): Promise<number | null> {
  const { rows } = await client.query(
    `SELECT idcaras FROM caras WHERE cantidad = $1 LIMIT 1`, [cantidad]
  );
  return rows[0]?.idcaras ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /pedidos — con JOINs de papel igual que getCotizaciones
// ═══════════════════════════════════════════════════════════════════════════════
export const getPedidos = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
          s.idsolicitud,
          s.no_cotizacion,
          s.no_pedido,
          s.estado          AS tipo_documento,
          s.fecha,
          s.prioridad,
          s.clientes_idclientes,
          s.estado_administrativo_cat_idestado_administrativo_cat,

          cli.atencion      AS cliente_nombre,
          cli.empresa       AS cliente_empresa,
          cli.telefono      AS cliente_telefono,
          cli.celular       AS cliente_celular,
          cli.correo        AS cliente_correo,
          cli.impresion     AS cliente_impresion,
          cli.razon_social  AS cliente_razon_social,
          cli.identificar   AS cliente_identificar,

          est.nombre        AS estado_nombre,

          df.rfc            AS cliente_rfc,

          dom.domicilio     AS cliente_domicilio,
          dom.numero        AS cliente_numero,
          dom.colonia       AS cliente_colonia,
          dom.codigo_postal AS cliente_codigo_postal,
          dom.poblacion     AS cliente_poblacion,
          dom.estado        AS cliente_estado,

          (
            SELECT d.estado_administrativo_cat_idestado_administrativo_cat
            FROM diseno d
            WHERE d.solicitud_idsolicitud = s.idsolicitud
            ORDER BY d.iddiseno DESC
            LIMIT 1
          ) AS diseno_estado_id,

          sp.idsolicitud_producto,
          sp.configuracion_plastico_idconfiguracion_plastico,
          sp.tintas_idtintas,
          sp.caras_idcaras,
          sp.pigmentos, sp.pantones,
          sp.observacion,
          sp.descripcion,
          sp.perforacion,
          sp.id_color,
          sp.id_medidatro,

          -- ── Discriminador + refs de PAPEL ──
          sp.tipo_material,
          sp.producto_papel_idproducto_papel,
          sp.grupo_papel_idgrupo_papel,
          sp.grupo_papel_descripcion,
          tpp2.nombre              AS papel_tipo_producto,
          pp2.descripcion_papel    AS papel_descripcion_papel,
          pp2.medida               AS papel_medida,
          gp2.precio_sugerido      AS papel_precio_sugerido,
          spp.id_asa,              asa2.nombre   AS asa_nombre,
          spp.idcat_laminado,      lam2.nombre   AS laminado_nombre,
          spp.idfoil,              fo2.colorfoil AS foil_color, fo2.codigofoil AS foil_codigo,
          spp.idcat_textura,       tx2.nombre    AS textura_nombre,
          spp.uv,                  spp.alto_relieve,
          spp.tintas_dentro_idtintas, spp.pantones_dentro, t2.cantidad AS tintas_dentro_cantidad,

          asz.tipo          AS suaje_tipo,

          ca.color          AS color_asa_nombre,
          mt.medida         AS medida_troquel,

          cfg.medida        AS cfg_medida,
          cfg.altura        AS cfg_altura,
          cfg.ancho         AS cfg_ancho,
          cfg.fuelle_fondo  AS cfg_fuelle_fondo,
          cfg.fuelle_latIz  AS cfg_fuelle_lat_iz,
          cfg.fuelle_latDe  AS cfg_fuelle_lat_de,
          cfg.refuerzo      AS cfg_refuerzo,
          cfg.por_kilo      AS cfg_por_kilo,

          tpp.material_plastico_producto AS tipo_producto_nombre,
          mp.tipo_material               AS material_nombre,
          cal.calibre                    AS calibre_numero,
          cal.calibre_bopp               AS calibre_bopp,

          t.cantidad        AS tintas_cantidad,
          car.cantidad      AS caras_cantidad,

          sd.idsolicitud_detalle,
          sd.cantidad,
          sd.precio_total,
          sd.precio_unitario,
          sd.aprobado,
          sd.kilogramos,
          sd.modo_cantidad,

          h.id_herramental,
          h.herramental_descripcion,
          h.herramental_precio,
          h.aprobado         AS herramental_aprobado

      FROM solicitud s
      LEFT JOIN clientes cli
          ON cli.idclientes = s.clientes_idclientes
      LEFT JOIN estado_administrativo_cat est
          ON est.idestado_administrativo_cat = s.estado_administrativo_cat_idestado_administrativo_cat
      LEFT JOIN datos_facturacion df
          ON df.clientes_idclientes = cli.idclientes
      LEFT JOIN domicilio dom
          ON dom.clientes_idclientes = cli.idclientes
      LEFT JOIN solicitud_producto sp
          ON sp.solicitud_idsolicitud = s.idsolicitud
      LEFT JOIN asa_suaje asz
          ON asz.idsuaje = sp.idsuaje
      LEFT JOIN color_asa ca
          ON ca.id_color = sp.id_color
      LEFT JOIN medidas_troquel mt
          ON mt.id_medidatro = sp.id_medidatro
      LEFT JOIN configuracion_plastico cfg
          ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN tipo_producto_plastico tpp
          ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN material_plastico mp
          ON mp.idmaterial_plastico = cfg.material_plastico_plastico_idmaterial_plastico
      LEFT JOIN calibre cal
          ON cal.idcalibre = cfg.calibre_idcalibre
      LEFT JOIN tintas t
          ON t.idtintas = sp.tintas_idtintas
      LEFT JOIN caras car
          ON car.idcaras = sp.caras_idcaras

      -- ── JOINs de PAPEL ──
      LEFT JOIN solicitud_producto_papel spp
          ON spp.idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN producto_papel pp2
          ON pp2.idproducto_papel = sp.producto_papel_idproducto_papel
      LEFT JOIN cat_tipo_producto_papel tpp2
          ON tpp2.idcat_tipo_producto_papel = pp2.idcat_tipo_producto_papel
      LEFT JOIN grupo_papel gp2
          ON gp2.idgrupo_papel = sp.grupo_papel_idgrupo_papel
      LEFT JOIN cat_tipo_asa asa2
          ON asa2.idcat_tipo_asa = spp.id_asa
      LEFT JOIN cat_laminado lam2
          ON lam2.idcat_laminado = spp.idcat_laminado
      LEFT JOIN foil fo2
          ON fo2.idfoil = spp.idfoil
      LEFT JOIN cat_textura tx2
          ON tx2.idcat_textura = spp.idcat_textura
      LEFT JOIN tintas t2
          ON t2.idtintas = spp.tintas_dentro_idtintas

      LEFT JOIN solicitud_detalle sd
          ON sd.solicitud_producto_id = sp.idsolicitud_producto
      LEFT JOIN herramental h
          ON h.idsolicitud_producto = sp.idsolicitud_producto

      WHERE s.estado = 'pedido'
        AND s.no_pedido IS NOT NULL

      ORDER BY s.no_pedido DESC, sp.idsolicitud_producto, sd.idsolicitud_detalle
    `);

    const agrupados: Record<string, any> = {};

    for (const row of rows) {
      const noPedido: string = row.no_pedido;

      if (!agrupados[noPedido]) {
        agrupados[noPedido] = {
          no_pedido: noPedido,
          no_cotizacion: row.no_cotizacion ?? null,
          es_directo: row.no_cotizacion === null,
          fecha: row.fecha,
          prioridad: row.prioridad ?? false,
          estado_id: row.estado_administrativo_cat_idestado_administrativo_cat,
          estado: normalizarNombreEstado(row.estado_nombre || ""),
          diseno_estado_id: row.diseno_estado_id ?? 1,
          cliente_id: row.clientes_idclientes,
          identificar: row.cliente_identificar || null,
          cliente: row.cliente_nombre || "",
          telefono: row.cliente_telefono || "",
          correo: row.cliente_correo || "",
          impresion: row.cliente_impresion || null,
          empresa: row.cliente_empresa || "",
          celular: row.cliente_celular || null,
          razon_social: row.cliente_razon_social || null,
          rfc: row.cliente_rfc || null,
          domicilio: row.cliente_domicilio || null,
          numero: row.cliente_numero || null,
          colonia: row.cliente_colonia || null,
          codigo_postal: row.cliente_codigo_postal || null,
          poblacion: row.cliente_poblacion || null,
          estado_cliente: row.cliente_estado || null,
          productos: [],
          total: 0,
        };
      }

      if (row.idsolicitud_producto) {
        let producto = agrupados[noPedido].productos.find(
          (p: any) => p.idsolicitud_producto === row.idsolicitud_producto
        );

        if (!producto) {
          if (row.tipo_material === "papel") {
            // ── Producto de PAPEL ──
            const foilNombre = row.foil_color
              ? `${row.foil_color}${row.foil_codigo ? " " + row.foil_codigo : ""}`
              : null;

            producto = {
              idsolicitud: row.idsolicitud,
              idsolicitud_producto: row.idsolicitud_producto,
              idcotizacion_producto: row.idsolicitud_producto,
              tipoCotizacion: "papel",
              tipo_material: "papel",

              idproducto_papel: row.producto_papel_idproducto_papel,
              nombre: row.papel_tipo_producto || `Papel #${row.producto_papel_idproducto_papel}`,
              descripcion_papel: row.papel_descripcion_papel ?? null,
              medida: row.papel_medida ?? null,

              idgrupo_papel: row.grupo_papel_idgrupo_papel ?? null,
              grupo_descripcion: row.grupo_papel_descripcion ?? null,
              precio_sugerido: row.papel_precio_sugerido != null ? Number(row.papel_precio_sugerido) : null,

              // Tintas exteriores
              tintas: row.tintas_cantidad ?? null,
              tintasId: row.tintas_idtintas ?? null,
              pantones: row.pantones || null,

              // Tintas interiores
              tintasDentroId: row.tintas_dentro_idtintas ?? null,
              tintasDentro: row.tintas_dentro_cantidad ?? 0,
              pantonesDentro: row.pantones_dentro || "",

              caras: row.caras_cantidad ?? null,
              carasId: row.caras_idcaras ?? null,

              id_asa: row.id_asa ?? null,
              asa_nombre: row.asa_nombre ?? null,
              idcat_laminado: row.idcat_laminado ?? null,
              laminado_nombre: row.laminado_nombre ?? null,
              idfoil: row.idfoil ?? null,
              foil_nombre: foilNombre,
              idcat_textura: row.idcat_textura ?? null,
              textura_nombre: row.textura_nombre ?? null,
              uv: row.uv ?? false,
              alto_relieve: row.alto_relieve ?? false,

              observacion: row.observacion ?? null,
              descripcion: row.descripcion ?? null,

              detalles: [],
              subtotal: 0,
            };
          } else {
            // ── Producto de PLÁSTICO ──
            const tipoNombre = row.tipo_producto_nombre || "";
            const medida = row.cfg_medida || "";
            const material = (row.material_nombre || "").toLowerCase();
            const nombreCompleto =
              [tipoNombre, medida, material].filter(Boolean).join(" ") ||
              `Producto #${row.configuracion_plastico_idconfiguracion_plastico}`;

            const medidas = {
              altura: row.cfg_altura ? String(row.cfg_altura) : "",
              ancho: row.cfg_ancho ? String(row.cfg_ancho) : "",
              fuelleFondo: row.cfg_fuelle_fondo ? String(row.cfg_fuelle_fondo) : "",
              fuelleLateral1: row.cfg_fuelle_lat_iz ? String(row.cfg_fuelle_lat_iz) : "",
              fuelleLateral2: row.cfg_fuelle_lat_de ? String(row.cfg_fuelle_lat_de) : "",
              refuerzo: row.cfg_refuerzo ? String(row.cfg_refuerzo) : "",
            };

            const materialUpper = (row.material_nombre || "").toUpperCase();
            const esBopp = materialUpper.includes("BOPP") ||
              materialUpper.includes("CELOFAN") ||
              materialUpper.includes("CELOFÁN");

            const calibreResuelto = (() => {
              if (esBopp) {
                const cb = row.calibre_bopp;
                if (cb !== null && cb !== undefined && String(cb).trim() !== "") return String(cb);
                return "";
              }
              const c = row.calibre_numero;
              if (c !== null && c !== undefined && Number(c) !== 0) return String(c);
              return "";
            })();

            producto = {
              idsolicitud: row.idsolicitud,
              idsolicitud_producto: row.idsolicitud_producto,
              idcotizacion_producto: row.idsolicitud_producto,
              producto_id: row.configuracion_plastico_idconfiguracion_plastico,
              nombre: nombreCompleto,
              material: row.material_nombre || "",
              calibre: calibreResuelto,
              calibre_bopp: row.calibre_bopp ? String(row.calibre_bopp) : null,
              medidasFormateadas: row.cfg_medida || "",
              medidas,
              tintas: row.tintas_cantidad ?? row.tintas_idtintas,
              tintas_idtintas: row.tintas_idtintas,
              caras: row.caras_cantidad ?? row.caras_idcaras,
              pigmentos: row.pigmentos || null,
              pantones: row.pantones
                ? row.pantones.split(",").map((p: string) => p.trim()).filter(Boolean)
                : null,
              observacion: row.observacion,
              descripcion: row.descripcion ?? null,
              perforacion: row.perforacion ?? false,
              por_kilo: row.cfg_por_kilo ? String(row.cfg_por_kilo) : null,
              id_color: row.id_color ?? null,
              color_asa_nombre: row.color_asa_nombre ?? null,
              id_medidatro: row.id_medidatro ?? null,
              medida_troquel: row.medida_troquel ?? null,
              herramental_descripcion: row.herramental_descripcion ?? null,
              herramental_precio: row.herramental_precio != null ? Number(row.herramental_precio) : null,
              herramental_aprobado: row.herramental_aprobado ?? null,
              herramental_id: row.id_herramental ?? null,
              detalles: [],
              subtotal: 0,
            };
          }

          agrupados[noPedido].productos.push(producto);
        }

        if (row.idsolicitud_detalle) {
          producto.detalles.push({
            iddetalle: row.idsolicitud_detalle,
            cantidad: Number(row.cantidad),
            precio_total: Number(row.precio_total),
            precio_unitario: row.precio_unitario != null ? Number(row.precio_unitario) : null,
            aprobado: row.aprobado,
            kilogramos: row.kilogramos != null ? Number(row.kilogramos) : null,
            modo_cantidad: row.modo_cantidad || "unidad",
          });
          producto.subtotal += Number(row.precio_total);
        }
      }
    }

    for (const noPedido in agrupados) {
      agrupados[noPedido].total = agrupados[noPedido].productos.reduce(
        (sum: number, p: any) => sum + p.subtotal + (p.herramental_precio ?? 0), 0
      );
    }

    const resultado = Object.values(agrupados);
    console.log(`✅ Pedidos obtenidos: ${resultado.length}`);
    return res.json(resultado);

  } catch (error: any) {
    console.error("❌ GET PEDIDOS ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener pedidos" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// PUT /pedidos/:id
// ═══════════════════════════════════════════════════════════════════════════════
export const actualizarPedido = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { productos } = req.body;

    const { rows: pedRows } = await client.query(
      `SELECT idsolicitud FROM solicitud
       WHERE no_pedido = $1 AND estado = 'pedido'`,
      [id]
    );
    if (pedRows.length === 0)
      return res.status(404).json({ error: "Pedido no encontrado" });

    const solicitudId: number = pedRows[0].idsolicitud;

    await client.query("BEGIN");

    for (const prod of (productos as any[])) {
      const {
        idsolicitud_producto,
        eliminado,
        nuevo_configuracion_id,   // ← nuevo campo opcional
        tintas,
        caras,
        pantones,
        pigmentos,
        observacion,
        descripcion,
        perforacion,
        herramental_descripcion,
        herramental_precio,
        detalles,
      } = prod;

      // ── Pegar esto al inicio del loop for (const prod of productos), ANTES del if (eliminado) ──

      if (prod.tipo_material === "papel") {
        if (prod.eliminado) {
          await client.query(
            `DELETE FROM herramental WHERE idsolicitud_producto = $1`,
            [prod.idsolicitud_producto]
          );

          const { rows: odRows } = await client.query(
            `SELECT idorden_diseno FROM orden_diseno WHERE solicitud_producto_id = $1`,
            [prod.idsolicitud_producto]
          );
          const ordenIds: number[] = odRows.map((r: any) => r.idorden_diseno);
          if (ordenIds.length > 0) {
            await client.query(
              `DELETE FROM orden_diseno_participante WHERE orden_diseno_id = ANY($1::int[])`,
              [ordenIds]
            );
            await client.query(
              `DELETE FROM archivos WHERE revision_diseno_id = ANY($1::int[])`,
              [ordenIds]
            );
            await client.query(
              `DELETE FROM orden_diseno WHERE idorden_diseno = ANY($1::int[])`,
              [ordenIds]
            );
          }

          await client.query(
            `DELETE FROM diseno_producto WHERE solicitud_producto_idsolicitud_producto = $1`,
            [prod.idsolicitud_producto]
          );
          await client.query(
            `DELETE FROM orden_produccion WHERE idsolicitud_producto = $1`,
            [prod.idsolicitud_producto]
          );
          await client.query(
            `DELETE FROM solicitud_detalle WHERE solicitud_producto_id = $1`,
            [prod.idsolicitud_producto]
          );
          await client.query(
            `DELETE FROM solicitud_producto_papel WHERE idsolicitud_producto = $1`,
            [prod.idsolicitud_producto]
          );
          await client.query(
            `DELETE FROM solicitud_producto WHERE idsolicitud_producto = $1`,
            [prod.idsolicitud_producto]
          );
          continue;
        }

        await client.query(
          `UPDATE solicitud_producto SET
       producto_papel_idproducto_papel = $1,
       grupo_papel_idgrupo_papel       = $2,
       grupo_papel_descripcion         = $3,
       tintas_idtintas                 = $4,
       caras_idcaras                   = $5,
       pantones                        = $6,
       observacion                     = $7,
       descripcion                     = $8
     WHERE idsolicitud_producto = $9`,
          [
            prod.idproducto_papel,
            prod.idgrupo_papel ?? null,
            prod.grupo_descripcion ?? null,
            prod.tintasId ?? null,
            prod.carasId ?? null,
            prod.pantones || null,
            prod.observacion || null,
            prod.descripcion || null,
            prod.idsolicitud_producto,
          ]
        );

        const { rows: sppCheck } = await client.query(
          `SELECT idsolicitud_producto_papel FROM solicitud_producto_papel WHERE idsolicitud_producto = $1`,
          [prod.idsolicitud_producto]
        );

        if (sppCheck.length > 0) {
          await client.query(
            `UPDATE solicitud_producto_papel SET
         id_asa                 = $1,
         idcat_laminado         = $2,
         idfoil                 = $3,
         idcat_textura          = $4,
         uv                     = $5,
         alto_relieve           = $6,
         tintas_dentro_idtintas = $7,
         pantones_dentro        = $8
       WHERE idsolicitud_producto = $9`,
            [
              prod.id_asa ?? null,
              prod.idcat_laminado ?? null,
              prod.idfoil ?? null,
              prod.idcat_textura ?? null,
              prod.uv === true,
              prod.alto_relieve === true,
              prod.tintasDentroId ?? null,
              prod.pantonesDentro || null,
              prod.idsolicitud_producto,
            ]
          );
        } else {
          await client.query(
            `INSERT INTO solicitud_producto_papel
         (idsolicitud_producto, id_asa, idcat_laminado, idfoil, idcat_textura,
          uv, alto_relieve, tintas_dentro_idtintas, pantones_dentro)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              prod.idsolicitud_producto,
              prod.id_asa ?? null,
              prod.idcat_laminado ?? null,
              prod.idfoil ?? null,
              prod.idcat_textura ?? null,
              prod.uv === true,
              prod.alto_relieve === true,
              prod.tintasDentroId ?? null,
              prod.pantonesDentro || null,
            ]
          );
        }

        for (const det of (prod.detalles as any[])) {
          const { iddetalle, cantidad, precio_total, precio_unitario, kilogramos, modo_cantidad } = det;
          if (iddetalle) {
            await client.query(
              `UPDATE solicitud_detalle SET
           cantidad        = $1,
           precio_total    = $2,
           precio_unitario = $3,
           kilogramos      = $4,
           modo_cantidad   = $5
         WHERE idsolicitud_detalle = $6`,
              [cantidad, precio_total, precio_unitario ?? null, kilogramos ?? null, modo_cantidad, iddetalle]
            );
          } else {
            await client.query(
              `INSERT INTO solicitud_detalle
           (solicitud_producto_id, cantidad, precio_total, precio_unitario, kilogramos, modo_cantidad, aprobado)
         VALUES ($1,$2,$3,$4,$5,$6,true)`,
              [prod.idsolicitud_producto, cantidad, precio_total, precio_unitario ?? null, kilogramos ?? null, modo_cantidad]
            );
          }
        }

        continue;
      }

      // ── Eliminar producto completo ──────────────────────────────────────────
      if (eliminado) {
        await client.query(
          `DELETE FROM herramental WHERE idsolicitud_producto = $1`,
          [idsolicitud_producto]
        );

        const { rows: odRows } = await client.query(
          `SELECT idorden_diseno FROM orden_diseno WHERE solicitud_producto_id = $1`,
          [idsolicitud_producto]
        );
        const ordenDisenoIds: number[] = odRows.map((r: any) => r.idorden_diseno);
        if (ordenDisenoIds.length > 0) {
          await client.query(
            `DELETE FROM orden_diseno_participante WHERE orden_diseno_id = ANY($1::int[])`,
            [ordenDisenoIds]
          );
          await client.query(
            `DELETE FROM archivos WHERE revision_diseno_id = ANY($1::int[])`,
            [ordenDisenoIds]
          );
          await client.query(
            `DELETE FROM orden_diseno WHERE idorden_diseno = ANY($1::int[])`,
            [ordenDisenoIds]
          );
        }

        await client.query(
          `DELETE FROM diseno_producto WHERE solicitud_producto_idsolicitud_producto = $1`,
          [idsolicitud_producto]
        );
        await client.query(
          `DELETE FROM orden_produccion WHERE idsolicitud_producto = $1`,
          [idsolicitud_producto]
        );
        await client.query(
          `DELETE FROM solicitud_detalle WHERE solicitud_producto_id = $1`,
          [idsolicitud_producto]
        );
        await client.query(
          `DELETE FROM solicitud_producto WHERE idsolicitud_producto = $1`,
          [idsolicitud_producto]
        );
        continue;
      }

      const tintasId = await resolverIdTintas(client, tintas);
      const carasId = await resolverIdCaras(client, caras);

      const pantonesLimpios = (() => {
        if (!pantones) return null;
        const arr = pantones.split(",").map((s: string) => s.trim()).filter(Boolean);
        const truncados = arr.slice(0, tintas);
        return truncados.length > 0 ? truncados.join(", ") : null;
      })();
      if (nuevo_configuracion_id) {
        await client.query(
          `UPDATE solicitud_producto SET
             configuracion_plastico_idconfiguracion_plastico = $1,
             tintas_idtintas = $2,
             caras_idcaras   = $3,
             pantones        = $4,
             pigmentos       = $5,
             observacion     = $6,
             descripcion     = $7,
             perforacion     = $8,
             idsuaje         = $9,
             id_color        = $10,
             id_medidatro    = $11
           WHERE idsolicitud_producto = $12`,
          [
            nuevo_configuracion_id,
            tintasId,
            carasId,
            pantonesLimpios,
            pigmentos || null,
            observacion || null,
            descripcion || null,
            perforacion === true,
            prod.idsuaje ?? null,
            prod.id_color ?? null,
            prod.id_medidatro ?? null,
            idsolicitud_producto,
          ]
        );
      } else {
        // UPDATE normal sin cambio de configuración
        await client.query(
          `UPDATE solicitud_producto SET
             tintas_idtintas = $1,
             caras_idcaras   = $2,
             pantones        = $3,
             pigmentos       = $4,
             observacion     = $5,
             descripcion     = $6,
             perforacion     = $7,
             idsuaje         = $8,
             id_color        = $9,
             id_medidatro    = $10
           WHERE idsolicitud_producto = $11`,
          [
            tintasId,
            carasId,
            pantonesLimpios,
            pigmentos || null,
            observacion || null,
            descripcion || null,
            perforacion === true,
            prod.idsuaje ?? null,
            prod.id_color ?? null,
            prod.id_medidatro ?? null,
            idsolicitud_producto,
          ]
        );
      }


      // ── Herramental (upsert / delete) ───────────────────────────────────────
      const { rows: herrRows } = await client.query(
        `SELECT id_herramental FROM herramental WHERE idsolicitud_producto = $1`,
        [idsolicitud_producto]
      );
      const tieneHerramental = herramental_descripcion || herramental_precio != null;

      if (herrRows.length > 0) {
        if (tieneHerramental) {
          // UPDATE: set aprobado=true automatically — editing an existing herramental
          // means it's been reviewed and confirmed. The approval is implicit on save.
          await client.query(
            `UPDATE herramental SET
               herramental_descripcion = $1,
               herramental_precio      = $2,
               aprobado                = true
             WHERE idsolicitud_producto = $3`,
            [herramental_descripcion, herramental_precio, idsolicitud_producto]
          );
        } else {
          await client.query(
            `DELETE FROM herramental WHERE idsolicitud_producto = $1`,
            [idsolicitud_producto]
          );
        }
      } else if (tieneHerramental) {
        // INSERT: new herramental starts as aprobado=true when created via edit pedido
        // (the user is explicitly adding it during an edit, so it's intentional).
        await client.query(
          `INSERT INTO herramental
             (idsolicitud_producto, herramental_descripcion, herramental_precio, aprobado)
           VALUES ($1, $2, $3, true)`,
          [idsolicitud_producto, herramental_descripcion, herramental_precio]
        );
      }

      // ── Detalles ────────────────────────────────────────────────────────────
      for (const det of (detalles as any[])) {
        const { iddetalle, cantidad, precio_total, precio_unitario, kilogramos, modo_cantidad } = det;

        if (iddetalle) {
          await client.query(
            `UPDATE solicitud_detalle SET
               cantidad        = $1,
               precio_total    = $2,
               precio_unitario = $3,
               kilogramos      = $4,
               modo_cantidad   = $5
             WHERE idsolicitud_detalle = $6`,
            [cantidad, precio_total, precio_unitario ?? null, kilogramos, modo_cantidad, iddetalle]
          );
        } else {
          await client.query(
            `INSERT INTO solicitud_detalle
               (solicitud_producto_id, cantidad, precio_total, precio_unitario, kilogramos, modo_cantidad, aprobado)
             VALUES ($1, $2, $3, $4, $5, $6, false)`,
            [idsolicitud_producto, cantidad, precio_total, precio_unitario ?? null, kilogramos, modo_cantidad]
          );
        }
      }
    }

    const { productos_nuevos = [] } = req.body;

    for (const prod of (productos_nuevos as any[])) {
      const {
        configuracion_plastico_id,
        tintas,
        caras,
        pantones,
        pigmentos,
        observacion,
        descripcion,
        perforacion,
        herramental_descripcion,
        herramental_precio,
        idsuaje,
        id_color,
        id_medidatro,
        detalles,
      } = prod;

      // Resolver IDs de tintas y caras desde sus cantidades
      const tintasId = await resolverIdTintas(client, tintas);
      const carasId = await resolverIdCaras(client, caras);

      // Limpiar pantones igual que en los productos existentes
      const pantonesLimpios = (() => {
        if (!pantones) return null;
        const arr = pantones.split(",").map((s: string) => s.trim()).filter(Boolean);
        return arr.slice(0, tintas).join(", ") || null;
      })();

      // Insertar el nuevo solicitud_producto
      const { rows: spRows } = await client.query(
        `INSERT INTO solicitud_producto (
       solicitud_idsolicitud,
       configuracion_plastico_idconfiguracion_plastico,
       tintas_idtintas,
       caras_idcaras,
       pantones,
       pigmentos,
       observacion,
       descripcion,
       perforacion,
       idsuaje,
       id_color,
       id_medidatro
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING idsolicitud_producto`,
        [
          solicitudId,
          configuracion_plastico_id,
          tintasId,
          carasId,
          pantonesLimpios,
          pigmentos || null,
          observacion || null,
          descripcion || null,
          perforacion === true,
          idsuaje ?? null,
          id_color ?? null,
          id_medidatro ?? null,
        ]
      );
      const nuevoSpId: number = spRows[0].idsolicitud_producto;

      // Herramental — si viene con datos lo insertamos como aprobado
      if (herramental_descripcion || herramental_precio != null) {
        await client.query(
          `INSERT INTO herramental
         (idsolicitud_producto, herramental_descripcion, herramental_precio, aprobado)
       VALUES ($1, $2, $3, true)`,
          [nuevoSpId, herramental_descripcion, herramental_precio]
        );
      }

      // Detalles del nuevo producto
      for (const det of (detalles as any[])) {
        const { cantidad, precio_total, precio_unitario, kilogramos, modo_cantidad } = det;
        await client.query(
          `INSERT INTO solicitud_detalle
         (solicitud_producto_id, cantidad, precio_total,
          precio_unitario, kilogramos, modo_cantidad, aprobado)
       VALUES ($1,$2,$3,$4,$5,$6,false)`,
          [
            nuevoSpId,
            cantidad,
            precio_total,
            precio_unitario ?? null,
            kilogramos ?? null,
            modo_cantidad,
          ]
        );
      }

      console.log(`✅ Producto nuevo insertado: sp_id=${nuevoSpId} cfg=${configuracion_plastico_id}`);
    }

    // ── Recalcular totales en ventas ──────────────────────────────────────────
    const { rows: ventaRows } = await client.query(
      `SELECT v.idventas, v.abono, s.sin_iva
       FROM ventas v
       JOIN solicitud s ON s.idsolicitud = v.solicitud_idsolicitud
       WHERE v.solicitud_idsolicitud = $1`,
      [solicitudId]
    );
    if (ventaRows.length > 0) {
      const ventaId = ventaRows[0].idventas;
      const abono = Number(ventaRows[0].abono ?? 0);
      const sinIva = ventaRows[0].sin_iva === true;

      const { rows: sumRows } = await client.query(
        `SELECT
           COALESCE(SUM(sd.precio_total), 0)                          AS subtotal_prods,
           COALESCE(SUM(CASE WHEN h.aprobado = true THEN h.herramental_precio ELSE 0 END), 0)
                                                                       AS subtotal_herr
         FROM solicitud_producto sp
         LEFT JOIN solicitud_detalle sd ON sd.solicitud_producto_id = sp.idsolicitud_producto
         LEFT JOIN herramental h        ON h.idsolicitud_producto   = sp.idsolicitud_producto
         WHERE sp.solicitud_idsolicitud = $1`,
        [solicitudId]
      );

      const subtotalNuevo = Number(sumRows[0].subtotal_prods) + Number(sumRows[0].subtotal_herr);
      const ivaNuevo = sinIva ? 0 : Math.round(subtotalNuevo * 0.16 * 100) / 100;
      const totalNuevo = Math.round((subtotalNuevo + ivaNuevo) * 100) / 100;

      // anticipo documental = 50% del nuevo total
      const anticipoNuevo = Math.round(totalNuevo * 0.50 * 100) / 100;
      // saldo = lo que falta pagar (nunca negativo)
      const saldoNuevo = Math.max(Math.round((totalNuevo - abono) * 100) / 100, 0);

      // Recalcular estado según nuevo total y abono actual
      const ANTICIPO_VALIDACION_MIN = 0.40;
      const umbral = Math.round(totalNuevo * ANTICIPO_VALIDACION_MIN * 100) / 100;

      const { rows: creditoRows } = await client.query(
        `SELECT 1 FROM venta_pago
         WHERE ventas_idventas = $1 AND es_credito_anticipo = true LIMIT 1`,
        [ventaId]
      );
      const tieneCredito = creditoRows.length > 0;
      const anticipoCubierto = abono >= umbral || tieneCredito;

      let nuevoEstado: number;
      if (saldoNuevo <= 0) nuevoEstado = 6; // PAGADO
      else if (anticipoCubierto) nuevoEstado = 2; // ANTICIPO_PAGADO / EN_PROCESO
      else nuevoEstado = 1; // PENDIENTE

      await client.query(
        `UPDATE ventas SET
           subtotal         = $1,
           iva              = $2,
           total            = $3,
           anticipo         = $4,
           saldo            = $5,
           subtotal_real    = $1,
           iva_real         = $2,
           total_real       = $3,
           estado_administrativo_cat_idestado_administrativo_cat = $6
         WHERE idventas = $7`,
        [subtotalNuevo, ivaNuevo, totalNuevo, anticipoNuevo, saldoNuevo, nuevoEstado, ventaId]
      );

      console.log(
        `💰 Ventas recalculadas: subtotal=${subtotalNuevo} | iva=${ivaNuevo} | ` +
        `total=${totalNuevo} | anticipo=${anticipoNuevo} | saldo=${saldoNuevo} | ` +
        `estado=${nuevoEstado} | sinIva=${sinIva}`
      );
    }

    await client.query("COMMIT");
    console.log(`✅ Pedido ${id} actualizado`);
    return res.json({ message: `Pedido ${id} actualizado correctamente` });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ ACTUALIZAR PEDIDO ERROR:", error.message);
    return res.status(500).json({ error: "Error al actualizar pedido", detalle: error.message });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /pedidos/:id
// ═══════════════════════════════════════════════════════════════════════════════
export const eliminarPedido = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    const { rows: pedRows } = await client.query(
      `SELECT idsolicitud, no_cotizacion FROM solicitud WHERE no_pedido = $1`, [id]
    );
    if (pedRows.length === 0)
      return res.status(404).json({ error: "Pedido no encontrado" });

    const solicitudId: number = pedRows[0].idsolicitud;
    const noCotizacion: number | null = pedRows[0].no_cotizacion;

    const { rows: pagosRows } = await client.query(
      `SELECT COUNT(*) AS total FROM venta_pago vp
       INNER JOIN ventas v ON v.idventas = vp.ventas_idventas
       WHERE v.solicitud_idsolicitud = $1`, [solicitudId]
    );
    if (Number(pagosRows[0].total) > 0) {
      return res.status(409).json({
        error: "No se puede eliminar este pedido porque tiene pagos registrados.",
        motivo: "pagos",
        detalle: `El pedido #${id} tiene ${pagosRows[0].total} pago(s) registrado(s). ` +
          "Elimina los pagos desde el módulo de Anticipo y Liquidación antes de cancelar el pedido.",
      });
    }

    const { rows: disenoRows } = await client.query(
      `SELECT COUNT(*) AS total FROM diseno_producto dp
       INNER JOIN diseno d ON d.iddiseno = dp.diseno_iddiseno
       WHERE d.solicitud_idsolicitud = $1
         AND dp.estado_administrativo_cat_idestado_administrativo_cat = 3`, [solicitudId]
    );
    if (Number(disenoRows[0].total) > 0) {
      return res.status(409).json({
        error: "No se puede eliminar este pedido porque tiene productos aprobados en diseño.",
        motivo: "diseno",
        detalle: `El pedido #${id} tiene ${disenoRows[0].total} producto(s) aprobado(s) en diseño. ` +
          "Restablece los productos en el módulo de Diseño antes de cancelar el pedido.",
      });
    }

    await client.query("BEGIN");

    const { rows: prodRows } = await client.query(
      `SELECT idsolicitud_producto FROM solicitud_producto WHERE solicitud_idsolicitud = $1`,
      [solicitudId]
    );
    const productoIds: number[] = prodRows.map((r: any) => r.idsolicitud_producto);

    if (productoIds.length > 0) {
      await client.query(
        `DELETE FROM herramental WHERE idsolicitud_producto = ANY($1::int[])`,
        [productoIds]
      );

      const { rows: odRows } = await client.query(
        `SELECT idorden_diseno FROM orden_diseno WHERE solicitud_producto_id = ANY($1::int[])`,
        [productoIds]
      );
      const ordenDisenoIds: number[] = odRows.map((r: any) => r.idorden_diseno);

      if (ordenDisenoIds.length > 0) {
        await client.query(
          `DELETE FROM orden_diseno_participante WHERE orden_diseno_id = ANY($1::int[])`,
          [ordenDisenoIds]
        );
        await client.query(
          `DELETE FROM archivos WHERE revision_diseno_id = ANY($1::int[])`,
          [ordenDisenoIds]
        );
        await client.query(
          `DELETE FROM orden_diseno WHERE idorden_diseno = ANY($1::int[])`,
          [ordenDisenoIds]
        );
      }

      await client.query(
        `DELETE FROM diseno_producto WHERE solicitud_producto_idsolicitud_producto = ANY($1::int[])`,
        [productoIds]
      );
      await client.query(
        `DELETE FROM orden_produccion WHERE idsolicitud_producto = ANY($1::int[])`,
        [productoIds]
      );
      await client.query(
        `DELETE FROM solicitud_detalle WHERE solicitud_producto_id = ANY($1::int[])`,
        [productoIds]
      );
    }

    await client.query(`DELETE FROM diseno WHERE solicitud_idsolicitud = $1`, [solicitudId]);
    await client.query(`DELETE FROM solicitud_producto WHERE solicitud_idsolicitud = $1`, [solicitudId]);

    const { rows: ventaRows } = await client.query(
      `SELECT idventas FROM ventas WHERE solicitud_idsolicitud = $1`,
      [solicitudId]
    );
    if (ventaRows.length > 0) {
      const ventaId = ventaRows[0].idventas;
      await client.query(`DELETE FROM venta_pago WHERE ventas_idventas = $1`, [ventaId]);
      await client.query(`DELETE FROM ventas WHERE idventas = $1`, [ventaId]);
    }

    await client.query(`DELETE FROM solicitud WHERE idsolicitud = $1`, [solicitudId]);

    await client.query("COMMIT");

    return res.json({
      message: "Pedido cancelado y eliminado exitosamente",
      no_pedido: id,
      no_cotizacion: noCotizacion,
      tenia_cotizacion: noCotizacion !== null,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ CANCELAR PEDIDO ERROR:", error.message);
    return res.status(500).json({ error: "Error al cancelar pedido", detalle: error.message });
  } finally {
    client.release();
  }
};

export const eliminarPedidoCompleto = async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const { noPedido } = req.params;

    await client.query("BEGIN");

    const pedido = await client.query(
      `
      SELECT idsolicitud
      FROM solicitud
      WHERE no_pedido = $1
      `,
      [noPedido]
    );

    if (pedido.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Pedido no encontrado" });
    }

    const idsolicitud = pedido.rows[0].idsolicitud;

    const params = [idsolicitud];

    await client.query(`
      DELETE FROM envio_bulto
      WHERE bultos_idbulto IN (
        SELECT b.idbulto
        FROM bultos b
        WHERE b.bolseo_idbolseo IN (
          SELECT idbolseo FROM bolseo
          WHERE orden_produccion_idproduccion IN (
            SELECT idproduccion FROM orden_produccion
            WHERE idsolicitud_producto IN (
              SELECT idsolicitud_producto FROM solicitud_producto
              WHERE solicitud_idsolicitud = $1
            )
          )
        )
        OR b.asa_flexible_idasa_flexible IN (
          SELECT idasa_flexible FROM asa_flexible
          WHERE orden_produccion_idproduccion IN (
            SELECT idproduccion FROM orden_produccion
            WHERE idsolicitud_producto IN (
              SELECT idsolicitud_producto FROM solicitud_producto
              WHERE solicitud_idsolicitud = $1
            )
          )
        )
      )
    `, params);

    await client.query(`
      DELETE FROM bultos
      WHERE bolseo_idbolseo IN (
        SELECT idbolseo FROM bolseo
        WHERE orden_produccion_idproduccion IN (
          SELECT idproduccion FROM orden_produccion
          WHERE idsolicitud_producto IN (
            SELECT idsolicitud_producto FROM solicitud_producto
            WHERE solicitud_idsolicitud = $1
          )
        )
      )
      OR asa_flexible_idasa_flexible IN (
        SELECT idasa_flexible FROM asa_flexible
        WHERE orden_produccion_idproduccion IN (
          SELECT idproduccion FROM orden_produccion
          WHERE idsolicitud_producto IN (
            SELECT idsolicitud_producto FROM solicitud_producto
            WHERE solicitud_idsolicitud = $1
          )
        )
      )
    `, params);

    await client.query(`
      DELETE FROM avance_proceso
      WHERE orden_produccion_idproduccion IN (
        SELECT idproduccion FROM orden_produccion
        WHERE idsolicitud_producto IN (
          SELECT idsolicitud_producto FROM solicitud_producto
          WHERE solicitud_idsolicitud = $1
        )
      )
    `, params);

    for (const tabla of ["extrusion", "impresion", "bolseo", "asa_flexible"]) {
      await client.query(`
        DELETE FROM ${tabla}
        WHERE orden_produccion_idproduccion IN (
          SELECT idproduccion FROM orden_produccion
          WHERE idsolicitud_producto IN (
            SELECT idsolicitud_producto FROM solicitud_producto
            WHERE solicitud_idsolicitud = $1
          )
        )
      `, params);
    }

    await client.query(`
      DELETE FROM orden_produccion
      WHERE idsolicitud_producto IN (
        SELECT idsolicitud_producto FROM solicitud_producto
        WHERE solicitud_idsolicitud = $1
      )
    `, params);

    await client.query(`
      DELETE FROM mensaje_diseno
      WHERE orden_diseno_id IN (
        SELECT idorden_diseno FROM orden_diseno
        WHERE solicitud_producto_id IN (
          SELECT idsolicitud_producto FROM solicitud_producto
          WHERE solicitud_idsolicitud = $1
        )
      )
    `, params);

    await client.query(`
      DELETE FROM revision_diseno
      WHERE orden_diseno_id IN (
        SELECT idorden_diseno FROM orden_diseno
        WHERE solicitud_producto_id IN (
          SELECT idsolicitud_producto FROM solicitud_producto
          WHERE solicitud_idsolicitud = $1
        )
      )
    `, params);

    await client.query(`
      DELETE FROM orden_diseno_participante
      WHERE orden_diseno_id IN (
        SELECT idorden_diseno FROM orden_diseno
        WHERE solicitud_producto_id IN (
          SELECT idsolicitud_producto FROM solicitud_producto
          WHERE solicitud_idsolicitud = $1
        )
      )
    `, params);

    await client.query(`
      DELETE FROM orden_diseno
      WHERE solicitud_producto_id IN (
        SELECT idsolicitud_producto FROM solicitud_producto
        WHERE solicitud_idsolicitud = $1
      )
    `, params);

    await client.query(`
      DELETE FROM diseno_producto
      WHERE solicitud_producto_idsolicitud_producto IN (
        SELECT idsolicitud_producto FROM solicitud_producto
        WHERE solicitud_idsolicitud = $1
      )
    `, params);

    await client.query(`DELETE FROM diseno WHERE solicitud_idsolicitud = $1`, params);

    await client.query(`
      DELETE FROM venta_pago
      WHERE ventas_idventas IN (
        SELECT idventas FROM ventas
        WHERE solicitud_idsolicitud = $1
      )
    `, params);

    await client.query(`DELETE FROM ventas WHERE solicitud_idsolicitud = $1`, params);


    await client.query(`
  DELETE FROM bitacora_reparto
  WHERE envio_idenvio IN (
    SELECT idenvio FROM envio
    WHERE solicitud_idsolicitud = $1
  )
`, params);

    await client.query(`
  DELETE FROM nota_remision_envio
  WHERE envio_idenvio IN (
    SELECT idenvio FROM envio
    WHERE solicitud_idsolicitud = $1
  )
`, params);

    await client.query(`
  DELETE FROM nota_remision
  WHERE envio_idenvio IN (
    SELECT idenvio FROM envio
    WHERE solicitud_idsolicitud = $1
  )
`, params);

    await client.query(`
  DELETE FROM envio_bulto
  WHERE envio_idenvio IN (
    SELECT idenvio FROM envio
    WHERE solicitud_idsolicitud = $1
  )
`, params);

    await client.query(`
  DELETE FROM archivos
  WHERE envio_id IN (
    SELECT idenvio FROM envio
    WHERE solicitud_idsolicitud = $1
  )
`, params);

    await client.query(`DELETE FROM envio WHERE solicitud_idsolicitud = $1`, params);

    await client.query(`
      DELETE FROM solicitud_detalle
      WHERE solicitud_producto_id IN (
        SELECT idsolicitud_producto FROM solicitud_producto
        WHERE solicitud_idsolicitud = $1
      )
    `, params);

    await client.query(`
      DELETE FROM herramental
      WHERE idsolicitud_producto IN (
        SELECT idsolicitud_producto FROM solicitud_producto
        WHERE solicitud_idsolicitud = $1
      )
    `, params);

    await client.query(`DELETE FROM solicitud_producto WHERE solicitud_idsolicitud = $1`, params);

    await client.query(`DELETE FROM solicitud WHERE idsolicitud = $1`, params);

    await client.query("COMMIT");

    return res.json({
      message: `Pedido ${noPedido} eliminado completamente`,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ ELIMINAR PEDIDO COMPLETO ERROR:", error.message);

    return res.status(500).json({
      error: "Error al eliminar completamente el pedido",
      detalle: error.message,
    });

  } finally {
    client.release();
  }
};

// En pedidos.controller.ts — agregar al final

export const getHistorialPedidosPorCliente = async (req: Request, res: Response) => {
  try {
    const { clienteId } = req.params;

    const { rows } = await pool.query(`
      SELECT
          s.idsolicitud,
          s.clientes_idclientes,
          s.no_cotizacion,
          s.no_pedido,
          s.fecha,
          s.prioridad,

          cli.atencion      AS cliente_nombre,
          cli.empresa       AS cliente_empresa,
          cli.telefono      AS cliente_telefono,
          cli.correo        AS cliente_correo,
          cli.impresion     AS cliente_impresion,
          cli.celular       AS cliente_celular,
          cli.razon_social  AS cliente_razon_social,
          cli.identificar   AS cliente_identificar,

          df.rfc            AS cliente_rfc,
          dom.domicilio     AS cliente_domicilio,
          dom.numero        AS cliente_numero,
          dom.colonia       AS cliente_colonia,
          dom.codigo_postal AS cliente_codigo_postal,
          dom.poblacion     AS cliente_poblacion,
          dom.estado        AS cliente_estado,

          sp.idsolicitud_producto,
          sp.configuracion_plastico_idconfiguracion_plastico,
          sp.tintas_idtintas,
          sp.caras_idcaras,
          sp.pigmentos, sp.pantones,
          sp.observacion, sp.descripcion, sp.perforacion,
          sp.id_color, sp.id_medidatro,

          -- ── Discriminador + refs de PAPEL ──
          sp.tipo_material,
          sp.producto_papel_idproducto_papel,
          sp.grupo_papel_idgrupo_papel,
          sp.grupo_papel_descripcion,
          tpp2.nombre              AS papel_tipo_producto,
          pp2.descripcion_papel    AS papel_descripcion_papel,
          pp2.medida               AS papel_medida,
          gp2.precio_sugerido      AS papel_precio_sugerido,
          spp.id_asa,              asa2.nombre   AS asa_nombre,
          spp.idcat_laminado,      lam2.nombre   AS laminado_nombre,
          spp.idfoil,              fo2.colorfoil AS foil_color, fo2.codigofoil AS foil_codigo,
          spp.idcat_textura,       tx2.nombre    AS textura_nombre,
          spp.uv,                  spp.alto_relieve,
          spp.tintas_dentro_idtintas, spp.pantones_dentro, t2.cantidad AS tintas_dentro_cantidad,

          asz.tipo          AS suaje_tipo,
          ca.color          AS color_asa_nombre,
          mt.medida         AS medida_troquel,

          cfg.medida        AS cfg_medida,
          cfg.altura        AS cfg_altura,
          cfg.ancho         AS cfg_ancho,
          cfg.fuelle_fondo  AS cfg_fuelle_fondo,
          cfg.fuelle_latIz  AS cfg_fuelle_lat_iz,
          cfg.fuelle_latDe  AS cfg_fuelle_lat_de,
          cfg.refuerzo      AS cfg_refuerzo,
          cfg.por_kilo      AS cfg_por_kilo,

          tpp.material_plastico_producto AS tipo_producto_nombre,
          mp.tipo_material               AS material_nombre,
          cal.calibre                    AS calibre_numero,
          cal.calibre_bopp               AS calibre_bopp,

          t.cantidad        AS tintas_cantidad,
          car.cantidad      AS caras_cantidad,

          sd.idsolicitud_detalle,
          sd.cantidad,
          sd.precio_total,
          sd.precio_unitario,
          sd.kilogramos,
          sd.modo_cantidad,

          h.herramental_descripcion,
          h.herramental_precio,
          h.aprobado AS herramental_aprobado

      FROM solicitud s
      LEFT JOIN clientes cli         ON cli.idclientes = s.clientes_idclientes
      LEFT JOIN datos_facturacion df ON df.clientes_idclientes = cli.idclientes
      LEFT JOIN domicilio dom         ON dom.clientes_idclientes = cli.idclientes
      LEFT JOIN solicitud_producto sp ON sp.solicitud_idsolicitud = s.idsolicitud
      LEFT JOIN asa_suaje asz         ON asz.idsuaje = sp.idsuaje
      LEFT JOIN color_asa ca          ON ca.id_color = sp.id_color
      LEFT JOIN medidas_troquel mt    ON mt.id_medidatro = sp.id_medidatro
      LEFT JOIN configuracion_plastico cfg
          ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN tipo_producto_plastico tpp
          ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN material_plastico mp
          ON mp.idmaterial_plastico = cfg.material_plastico_plastico_idmaterial_plastico
      LEFT JOIN calibre cal           ON cal.idcalibre = cfg.calibre_idcalibre
      LEFT JOIN tintas t              ON t.idtintas = sp.tintas_idtintas
      LEFT JOIN caras car             ON car.idcaras = sp.caras_idcaras

      -- ── JOINs de PAPEL ──
      LEFT JOIN solicitud_producto_papel spp
          ON spp.idsolicitud_producto = sp.idsolicitud_producto
      LEFT JOIN producto_papel pp2
          ON pp2.idproducto_papel = sp.producto_papel_idproducto_papel
      LEFT JOIN cat_tipo_producto_papel tpp2
          ON tpp2.idcat_tipo_producto_papel = pp2.idcat_tipo_producto_papel
      LEFT JOIN grupo_papel gp2
          ON gp2.idgrupo_papel = sp.grupo_papel_idgrupo_papel
      LEFT JOIN cat_tipo_asa asa2
          ON asa2.idcat_tipo_asa = spp.id_asa
      LEFT JOIN cat_laminado lam2
          ON lam2.idcat_laminado = spp.idcat_laminado
      LEFT JOIN foil fo2
          ON fo2.idfoil = spp.idfoil
      LEFT JOIN cat_textura tx2
          ON tx2.idcat_textura = spp.idcat_textura
      LEFT JOIN tintas t2
          ON t2.idtintas = spp.tintas_dentro_idtintas

      LEFT JOIN solicitud_detalle sd  ON sd.solicitud_producto_id = sp.idsolicitud_producto
      LEFT JOIN herramental h         ON h.idsolicitud_producto = sp.idsolicitud_producto

      WHERE s.estado = 'pedido'
        AND s.no_pedido IS NOT NULL
        AND s.clientes_idclientes = $1

      ORDER BY s.fecha DESC, sp.idsolicitud_producto, sd.idsolicitud_detalle
    `, [clienteId]);

    const agrupados: Record<string, any> = {};

    for (const row of rows) {
      const noPedido: string = row.no_pedido;

      if (!agrupados[noPedido]) {
        agrupados[noPedido] = {
          no_pedido: noPedido,
          no_cotizacion: row.no_cotizacion ?? null,
          es_directo: row.no_cotizacion === null,
          fecha: row.fecha,
          prioridad: row.prioridad ?? false,
          cliente_id: row.clientes_idclientes,
          identificar: row.cliente_identificar || null,
          cliente: row.cliente_nombre || "",
          telefono: row.cliente_telefono || "",
          correo: row.cliente_correo || "",
          impresion: row.cliente_impresion || null,
          empresa: row.cliente_empresa || "",
          celular: row.cliente_celular || null,
          razon_social: row.cliente_razon_social || null,
          rfc: row.cliente_rfc || null,
          domicilio: row.cliente_domicilio || null,
          numero: row.cliente_numero || null,
          colonia: row.cliente_colonia || null,
          codigo_postal: row.cliente_codigo_postal || null,
          poblacion: row.cliente_poblacion || null,
          estado_cliente: row.cliente_estado || null,
          productos: [],
          total: 0,
        };
      }

      if (row.idsolicitud_producto) {
        let producto = agrupados[noPedido].productos.find(
          (p: any) => p.idsolicitud_producto === row.idsolicitud_producto
        );

        if (!producto) {
          if (row.tipo_material === "papel") {
            // ── Producto de PAPEL ──
            const foilNombre = row.foil_color
              ? `${row.foil_color}${row.foil_codigo ? " " + row.foil_codigo : ""}`
              : null;

            producto = {
              idsolicitud: row.idsolicitud,
              idsolicitud_producto: row.idsolicitud_producto,
              idcotizacion_producto: row.idsolicitud_producto,
              tipoCotizacion: "papel",
              tipo_material: "papel",

              idproducto_papel: row.producto_papel_idproducto_papel,
              nombre: row.papel_tipo_producto || `Papel #${row.producto_papel_idproducto_papel}`,
              descripcion_papel: row.papel_descripcion_papel ?? null,
              medida: row.papel_medida ?? null,

              idgrupo_papel: row.grupo_papel_idgrupo_papel ?? null,
              grupo_descripcion: row.grupo_papel_descripcion ?? null,
              precio_sugerido: row.papel_precio_sugerido != null ? Number(row.papel_precio_sugerido) : null,

              // Tintas exteriores
              tintas: row.tintas_cantidad ?? null,
              tintasId: row.tintas_idtintas ?? null,
              pantones: row.pantones || null,

              // Tintas interiores
              tintasDentroId: row.tintas_dentro_idtintas ?? null,
              tintasDentro: row.tintas_dentro_cantidad ?? 0,
              pantonesDentro: row.pantones_dentro || "",

              caras: row.caras_cantidad ?? null,
              carasId: row.caras_idcaras ?? null,

              id_asa: row.id_asa ?? null,
              asa_nombre: row.asa_nombre ?? null,
              idcat_laminado: row.idcat_laminado ?? null,
              laminado_nombre: row.laminado_nombre ?? null,
              idfoil: row.idfoil ?? null,
              foil_nombre: foilNombre,
              idcat_textura: row.idcat_textura ?? null,
              textura_nombre: row.textura_nombre ?? null,
              uv: row.uv ?? false,
              alto_relieve: row.alto_relieve ?? false,

              observacion: row.observacion ?? null,
              descripcion: row.descripcion ?? null,

              detalles: [],
              subtotal: 0,
            };
          } else {
            // ── Producto de PLÁSTICO ──
            const tipoNombre = row.tipo_producto_nombre || "";
            const medida = row.cfg_medida || "";
            const material = (row.material_nombre || "").toLowerCase();
            const nombre = [tipoNombre, medida, material].filter(Boolean).join(" ")
              || `Producto #${row.configuracion_plastico_idconfiguracion_plastico}`;

            const materialUpper = (row.material_nombre || "").toUpperCase();
            const esBopp = materialUpper.includes("BOPP") ||
              materialUpper.includes("CELOFAN") ||
              materialUpper.includes("CELOFÁN");
            const calibre = esBopp
              ? (row.calibre_bopp ? String(row.calibre_bopp) : "")
              : (row.calibre_numero && Number(row.calibre_numero) !== 0
                ? String(row.calibre_numero) : "");

            producto = {
              idsolicitud: row.idsolicitud,
              idsolicitud_producto: row.idsolicitud_producto,
              idcotizacion_producto: row.idsolicitud_producto,
              producto_id: row.configuracion_plastico_idconfiguracion_plastico,
              nombre,
              material: row.material_nombre || "",
              calibre,
              calibre_bopp: row.calibre_bopp ? String(row.calibre_bopp) : null,
              medidasFormateadas: row.cfg_medida || "",
              medidas: {
                altura: row.cfg_altura ? String(row.cfg_altura) : "",
                ancho: row.cfg_ancho ? String(row.cfg_ancho) : "",
                fuelleFondo: row.cfg_fuelle_fondo ? String(row.cfg_fuelle_fondo) : "",
                fuelleLateral1: row.cfg_fuelle_lat_iz ? String(row.cfg_fuelle_lat_iz) : "",
                fuelleLateral2: row.cfg_fuelle_lat_de ? String(row.cfg_fuelle_lat_de) : "",
                refuerzo: row.cfg_refuerzo ? String(row.cfg_refuerzo) : "",
              },
              tintas: row.tintas_cantidad ?? row.tintas_idtintas,
              tintas_idtintas: row.tintas_idtintas,
              caras: row.caras_cantidad ?? row.caras_idcaras,
              caras_idcaras: row.caras_idcaras,
              por_kilo: row.cfg_por_kilo ? String(row.cfg_por_kilo) : null,
              pigmentos: row.pigmentos || null,
              pantones: row.pantones
                ? row.pantones.split(",").map((p: string) => p.trim()).filter(Boolean)
                : null,
              observacion: row.observacion,
              descripcion: row.descripcion ?? null,
              perforacion: row.perforacion ?? false,
              id_color: row.id_color ?? null,
              color_asa_nombre: row.color_asa_nombre ?? null,
              id_medidatro: row.id_medidatro ?? null,
              medida_troquel: row.medida_troquel ?? null,
              herramental_descripcion: row.herramental_descripcion ?? null,
              herramental_precio: row.herramental_precio != null ? Number(row.herramental_precio) : null,
              herramental_aprobado: row.herramental_aprobado ?? null,
              detalles: [],
              subtotal: 0,
            };
          }

          agrupados[noPedido].productos.push(producto);
        }

        if (row.idsolicitud_detalle) {
          producto.detalles.push({
            iddetalle: row.idsolicitud_detalle,
            cantidad: Number(row.cantidad),
            precio_total: Number(row.precio_total),
            precio_unitario: row.precio_unitario != null ? Number(row.precio_unitario) : null,
            kilogramos: row.kilogramos != null ? Number(row.kilogramos) : null,
            modo_cantidad: row.modo_cantidad || "unidad",
          });
          producto.subtotal += Number(row.precio_total);
        }
      }
    }

    for (const noPedido in agrupados) {
      agrupados[noPedido].total = agrupados[noPedido].productos.reduce(
        (sum: number, p: any) => sum + p.subtotal + (p.herramental_precio ?? 0), 0
      );
    }

    return res.json(Object.values(agrupados));

  } catch (error: any) {
    console.error("❌ GET HISTORIAL PEDIDOS ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener historial de pedidos" });
  }
};