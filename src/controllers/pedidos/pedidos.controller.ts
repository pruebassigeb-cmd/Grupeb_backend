import { Request, Response } from "express";
import { pool } from "../../config/db";

function normalizarNombreEstado(nombre: string): string {
  if (!nombre) return "Pendiente";
  const n = nombre.toLowerCase().trim();
  if (n === "aprobado" || n === "aprobada")   return "Aprobada";
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
// GET /pedidos
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
          sp.bk, sp.foil, sp.idsuaje, sp.alto_rel,
          sp.laminado, sp.uv_br, sp.pigmentos, sp.pantones,
          sp.observacion,
          sp.id_color,
          sp.id_medidatro,

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
          no_pedido:        noPedido,
          no_cotizacion:    row.no_cotizacion ?? null,
          es_directo:       row.no_cotizacion === null,
          fecha:            row.fecha,
          prioridad:        row.prioridad ?? false,
          estado_id:        row.estado_administrativo_cat_idestado_administrativo_cat,
          estado:           normalizarNombreEstado(row.estado_nombre || ""),
          diseno_estado_id: row.diseno_estado_id ?? 1,
          cliente_id:       row.clientes_idclientes,
          cliente:          row.cliente_nombre        || "",
          telefono:         row.cliente_telefono      || "",
          correo:           row.cliente_correo        || "",
          impresion:        row.cliente_impresion     || null,
          empresa:          row.cliente_empresa       || "",
          celular:          row.cliente_celular       || null,
          razon_social:     row.cliente_razon_social  || null,
          rfc:              row.cliente_rfc           || null,
          domicilio:        row.cliente_domicilio     || null,
          numero:           row.cliente_numero        || null,
          colonia:          row.cliente_colonia       || null,
          codigo_postal:    row.cliente_codigo_postal || null,
          poblacion:        row.cliente_poblacion     || null,
          estado_cliente:   row.cliente_estado        || null,
          productos:        [],
          total:            0,
        };
      }

      if (row.idsolicitud_producto) {
        let producto = agrupados[noPedido].productos.find(
          (p: any) => p.idsolicitud_producto === row.idsolicitud_producto
        );

        if (!producto) {
          const tipoNombre     = row.tipo_producto_nombre || "";
          const medida         = row.cfg_medida           || "";
          const material       = (row.material_nombre     || "").toLowerCase();
          const nombreCompleto =
            [tipoNombre, medida, material].filter(Boolean).join(" ") ||
            `Producto #${row.configuracion_plastico_idconfiguracion_plastico}`;

          const medidas = {
            altura:         row.cfg_altura        ? String(row.cfg_altura)        : "",
            ancho:          row.cfg_ancho         ? String(row.cfg_ancho)         : "",
            fuelleFondo:    row.cfg_fuelle_fondo  ? String(row.cfg_fuelle_fondo)  : "",
            fuelleLateral1: row.cfg_fuelle_lat_iz ? String(row.cfg_fuelle_lat_iz) : "",
            fuelleLateral2: row.cfg_fuelle_lat_de ? String(row.cfg_fuelle_lat_de) : "",
            refuerzo:       row.cfg_refuerzo      ? String(row.cfg_refuerzo)      : "",
            solapa:         "",
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
            idsolicitud:             row.idsolicitud,
            idsolicitud_producto:    row.idsolicitud_producto,
            idcotizacion_producto:   row.idsolicitud_producto,
            producto_id:             row.configuracion_plastico_idconfiguracion_plastico,
            nombre:                  nombreCompleto,
            material:                row.material_nombre || "",
            calibre:                 calibreResuelto,
            calibre_bopp:            row.calibre_bopp ? String(row.calibre_bopp) : null,
            medidasFormateadas:      row.cfg_medida    || "",
            medidas,
            tintas:                  row.tintas_cantidad ?? row.tintas_idtintas,
            caras:                   row.caras_cantidad  ?? row.caras_idcaras,
            bk:                      row.bk,
            foil:                    row.foil,
            idsuaje:                 row.idsuaje        ?? null,
            asa_suaje:               row.suaje_tipo      ?? null,
            alto_rel:                row.alto_rel,
            laminado:                row.laminado,
            uv_br:                   row.uv_br,
            pigmentos:               row.pigmentos || null,
            pantones:                row.pantones
              ? row.pantones.split(",").map((p: string) => p.trim()).filter(Boolean)
              : null,
            observacion:             row.observacion,
            por_kilo:                row.cfg_por_kilo ? String(row.cfg_por_kilo) : null,
            id_color:                row.id_color        ?? null,
            color_asa_nombre:        row.color_asa_nombre ?? null,
            id_medidatro:            row.id_medidatro    ?? null,
            medida_troquel:          row.medida_troquel  ?? null,
            herramental_descripcion: row.herramental_descripcion ?? null,
            herramental_precio:      row.herramental_precio != null ? Number(row.herramental_precio) : null,
            herramental_aprobado:    row.herramental_aprobado ?? null,
            herramental_id:          row.id_herramental ?? null,
            detalles:                [],
            subtotal:                0,
          };
          agrupados[noPedido].productos.push(producto);
        }

        if (row.idsolicitud_detalle) {
          producto.detalles.push({
            iddetalle:     row.idsolicitud_detalle,
            cantidad:      Number(row.cantidad),
            precio_total:  Number(row.precio_total),
            aprobado:      row.aprobado,
            kilogramos:    row.kilogramos != null ? Number(row.kilogramos) : null,
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
// PUT /pedidos/:id  — solo toca productos, herramental y detalles
// ═══════════════════════════════════════════════════════════════════════════════
export const actualizarPedido = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id }      = req.params; // no_pedido
    const { productos } = req.body;

    // ── Verificar que el pedido existe ────────────────────────────────────────
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
        tintas,
        caras,
        pantones,
        pigmentos,
        observacion,
        herramental_descripcion,
        herramental_precio,
        detalles,
      } = prod;

      // ── Eliminar producto completo ──────────────────────────────────────────
      if (eliminado) {
        await client.query(
          `DELETE FROM herramental WHERE idsolicitud_producto = $1`,
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

      // ── Resolver IDs de tintas/caras ────────────────────────────────────────
      const tintasId = await resolverIdTintas(client, tintas);
      const carasId  = await resolverIdCaras(client, caras);

      // ── Actualizar solicitud_producto ───────────────────────────────────────
      await client.query(
        `UPDATE solicitud_producto SET
           tintas_idtintas = COALESCE($1, tintas_idtintas),
           caras_idcaras   = COALESCE($2, caras_idcaras),
           pantones        = $3,
           pigmentos       = $4,
           observacion     = $5
         WHERE idsolicitud_producto = $6`,
        [tintasId, carasId, pantones, pigmentos, observacion, idsolicitud_producto]
      );

      // ── Herramental (upsert / delete) ───────────────────────────────────────
      const { rows: herrRows } = await client.query(
        `SELECT id_herramental FROM herramental WHERE idsolicitud_producto = $1`,
        [idsolicitud_producto]
      );
      const tieneHerramental = herramental_descripcion || herramental_precio != null;

      if (herrRows.length > 0) {
        if (tieneHerramental) {
          await client.query(
            `UPDATE herramental SET
               herramental_descripcion = $1,
               herramental_precio      = $2
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
        await client.query(
          `INSERT INTO herramental
             (idsolicitud_producto, herramental_descripcion, herramental_precio, aprobado)
           VALUES ($1, $2, $3, false)`,
          [idsolicitud_producto, herramental_descripcion, herramental_precio]
        );
      }

      // ── Detalles (update existentes / insert nuevos) ────────────────────────
      for (const det of (detalles as any[])) {
        const { iddetalle, cantidad, precio_total, kilogramos, modo_cantidad } = det;

        if (iddetalle) {
          await client.query(
            `UPDATE solicitud_detalle SET
               cantidad      = $1,
               precio_total  = $2,
               kilogramos    = $3,
               modo_cantidad = $4
             WHERE idsolicitud_detalle = $5`,
            [cantidad, precio_total, kilogramos, modo_cantidad, iddetalle]
          );
        } else {
          await client.query(
            `INSERT INTO solicitud_detalle
               (solicitud_producto_id, cantidad, precio_total, kilogramos, modo_cantidad, aprobado)
             VALUES ($1, $2, $3, $4, $5, false)`,
            [idsolicitud_producto, cantidad, precio_total, kilogramos, modo_cantidad]
          );
        }
      }
    }

    // ── Recalcular totales en ventas ──────────────────────────────────────────
    const { rows: ventaRows } = await client.query(
      `SELECT idventas FROM ventas WHERE solicitud_idsolicitud = $1`,
      [solicitudId]
    );
    if (ventaRows.length > 0) {
      const ventaId = ventaRows[0].idventas;

      const { rows: sumRows } = await client.query(
        `SELECT
           COALESCE(SUM(sd.precio_total), 0)      AS subtotal_prods,
           COALESCE(SUM(h.herramental_precio), 0) AS subtotal_herr
         FROM solicitud_producto sp
         LEFT JOIN solicitud_detalle sd ON sd.solicitud_producto_id = sp.idsolicitud_producto
         LEFT JOIN herramental h        ON h.idsolicitud_producto   = sp.idsolicitud_producto
         WHERE sp.solicitud_idsolicitud = $1`,
        [solicitudId]
      );

      const subtotalNuevo = Number(sumRows[0].subtotal_prods) + Number(sumRows[0].subtotal_herr);
      const ivaNuevo      = Math.round(subtotalNuevo * 0.16 * 100) / 100;
      const totalNuevo    = Math.round((subtotalNuevo + ivaNuevo) * 100) / 100;

      await client.query(
        `UPDATE ventas SET
           subtotal_real = $1,
           iva_real      = $2,
           total_real    = $3
         WHERE idventas = $4`,
        [subtotalNuevo, ivaNuevo, totalNuevo, ventaId]
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

    const solicitudId: number       = pedRows[0].idsolicitud;
    const noCotizacion: number|null = pedRows[0].no_cotizacion;

    const { rows: pagosRows } = await client.query(
      `SELECT COUNT(*) AS total FROM venta_pago vp
       INNER JOIN ventas v ON v.idventas = vp.ventas_idventas
       WHERE v.solicitud_idsolicitud = $1`, [solicitudId]
    );
    if (Number(pagosRows[0].total) > 0) {
      return res.status(409).json({
        error:   "No se puede eliminar este pedido porque tiene pagos registrados.",
        motivo:  "pagos",
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
        error:   "No se puede eliminar este pedido porque tiene productos aprobados en diseño.",
        motivo:  "diseno",
        detalle: `El pedido #${id} tiene ${disenoRows[0].total} producto(s) aprobado(s) en diseño. ` +
                 "Restablece los productos en el módulo de Diseño antes de cancelar el pedido.",
      });
    }

    await client.query("BEGIN");

    const { rows: prodRows } = await client.query(
      `SELECT idsolicitud_producto FROM solicitud_producto WHERE solicitud_idsolicitud = $1`, [solicitudId]
    );
    const productoIds: number[] = prodRows.map((r: any) => r.idsolicitud_producto);

    if (productoIds.length > 0) {
      await client.query(
        `DELETE FROM herramental WHERE idsolicitud_producto = ANY($1::int[])`, [productoIds]
      );
      await client.query(
        `DELETE FROM diseno_producto WHERE solicitud_producto_idsolicitud_producto = ANY($1::int[])`, [productoIds]
      );
      await client.query(
        `DELETE FROM solicitud_detalle WHERE solicitud_producto_id = ANY($1::int[])`, [productoIds]
      );
    }

    await client.query(`DELETE FROM diseno WHERE solicitud_idsolicitud = $1`, [solicitudId]);
    await client.query(`DELETE FROM solicitud_producto WHERE solicitud_idsolicitud = $1`, [solicitudId]);

    const { rows: ventaRows } = await client.query(
      `SELECT idventas FROM ventas WHERE solicitud_idsolicitud = $1`, [solicitudId]
    );
    if (ventaRows.length > 0) {
      const ventaId = ventaRows[0].idventas;
      await client.query(`DELETE FROM venta_pago WHERE ventas_idventas = $1`, [ventaId]);
      await client.query(`DELETE FROM ventas WHERE idventas = $1`, [ventaId]);
    }

    await client.query(`DELETE FROM solicitud WHERE idsolicitud = $1`, [solicitudId]);
    await client.query("COMMIT");

    return res.json({
      message:          "Pedido cancelado y eliminado exitosamente",
      no_pedido:        id,
      no_cotizacion:    noCotizacion,
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