import { Request, Response } from "express";
import { pool } from "../../config/db";

const ESTADO = {
  PENDIENTE:  1,
  EN_PROCESO: 2,
  APROBADO:   3,
  RECHAZADO:  4,
} as const;

const IVA_PORCENTAJE      = 0.16;
const ANTICIPO_PORCENTAJE = 0.50; // lo que ve el cliente

type TipoDocumento = "cotizacion" | "pedido";

function normalizarNombreEstado(nombre: string): string {
  if (!nombre) return "Pendiente";
  const n = nombre.toLowerCase().trim();
  if (n === "aprobado" || n === "aprobada")   return "Aprobada";
  if (n === "rechazado" || n === "rechazada") return "Rechazada";
  return "Pendiente";
}

function generarFolioCotizacion(numero: number): string {
  const yy = new Date().getFullYear().toString().slice(-2);
  return `COT${yy}${String(numero).padStart(3, "0")}`;
}

function generarFolioPedido(numero: number): string {
  const yy = new Date().getFullYear().toString().slice(-2);
  return `P${yy}${String(numero).padStart(3, "0")}`;
}

async function obtenerSiguienteNumeroCotizacion(client: any): Promise<number> {
  const yy = new Date().getFullYear().toString().slice(-2);
  const { rows } = await client.query(`
    SELECT COALESCE(MAX(
      CAST(SUBSTRING(no_cotizacion FROM 'COT${yy}(\\d+)') AS INTEGER)
    ), 0) + 1 AS siguiente
    FROM solicitud
    WHERE no_cotizacion LIKE 'COT${yy}%'
  `);
  return rows[0].siguiente;
}

async function obtenerSiguienteNumeroPedido(client: any): Promise<number> {
  const yy = new Date().getFullYear().toString().slice(-2);
  const { rows } = await client.query(`
    SELECT COALESCE(MAX(
      CAST(SUBSTRING(no_pedido FROM 'P${yy}(\\d+)') AS INTEGER)
    ), 0) + 1 AS siguiente
    FROM solicitud
    WHERE no_pedido LIKE 'P${yy}%'
  `);
  return rows[0].siguiente;
}

async function obtenerSiguienteFolioCotizacion(client: any): Promise<string> {
  const numero = await obtenerSiguienteNumeroCotizacion(client);
  return generarFolioCotizacion(numero);
}

async function obtenerSiguienteFolioPedido(client: any): Promise<string> {
  const numero = await obtenerSiguienteNumeroPedido(client);
  return generarFolioPedido(numero);
}

async function generarFolioOrdenDiseno(client: any): Promise<string> {
  const yy = new Date().getFullYear().toString().slice(-2);
  const { rows } = await client.query(`
    SELECT COALESCE(MAX(
      CAST(SUBSTRING(no_orden_diseno FROM 'OD${yy}(\\d+)') AS INTEGER)
    ), 0) + 1 AS siguiente
    FROM orden_diseno
    WHERE no_orden_diseno LIKE 'OD${yy}%'
  `);
  return `OD${yy}${String(rows[0].siguiente).padStart(3, "0")}`;
}

// ── sin_iva: si es true el IVA es 0, el total = subtotal ─────────────────────
async function crearVentaYDiseno(
  client:      any,
  solicitudId: number,
  folioPedido: string,
  subtotal:    number,
  sinIva:      boolean = false
): Promise<void> {
  const iva      = sinIva ? 0 : Number((subtotal * IVA_PORCENTAJE).toFixed(2));
  const total    = Number((subtotal + iva).toFixed(2));
  const anticipo = Number((total * ANTICIPO_PORCENTAJE).toFixed(2));

  const { rows: ventaRows } = await client.query(
    `INSERT INTO ventas (
      solicitud_idsolicitud,
      estado_administrativo_cat_idestado_administrativo_cat,
      subtotal, iva, total, anticipo, saldo, abono,
      fecha_creacion
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    RETURNING idventas`,
    [solicitudId, ESTADO.PENDIENTE, subtotal, iva, total, anticipo, total, 0]
  );
  console.log(`✅ Venta creada: idventas=${ventaRows[0].idventas} | pedido=${folioPedido} | sinIva=${sinIva} | anticipo=${anticipo}`);

  const { rows: disenoRows } = await client.query(
    `INSERT INTO diseno (
      solicitud_idsolicitud,
      estado_administrativo_cat_idestado_administrativo_cat,
      fecha
    ) VALUES ($1, $2, NOW())
    RETURNING iddiseno`,
    [solicitudId, ESTADO.PENDIENTE]
  );
  const disenoId = disenoRows[0].iddiseno;

  const { rows: productos } = await client.query(
    `SELECT idsolicitud_producto FROM solicitud_producto
     WHERE solicitud_idsolicitud = $1`,
    [solicitudId]
  );

  for (const prod of productos) {
    await client.query(
      `INSERT INTO diseno_producto (
        diseno_iddiseno,
        solicitud_producto_idsolicitud_producto,
        estado_administrativo_cat_idestado_administrativo_cat,
        fecha
      ) VALUES ($1, $2, $3, NOW())`,
      [disenoId, prod.idsolicitud_producto, ESTADO.PENDIENTE]
    );

    const folioOD = await generarFolioOrdenDiseno(client);
    await client.query(
      `INSERT INTO orden_diseno
        (solicitud_producto_id, no_pedido, no_orden_diseno, estado, version_actual)
       VALUES ($1, $2, $3, 'en_revision', 1)`,
      [prod.idsolicitud_producto, folioPedido, folioOD]
    );
    console.log(`✅ Orden de diseño ${folioOD} creada para producto ${prod.idsolicitud_producto}`);
  }

  console.log(`✅ Diseño #${disenoId} creado con ${productos.length} producto(s) para pedido ${folioPedido}`);
}

// ============================================================
// CREAR COTIZACIÓN O PEDIDO DIRECTO
// ============================================================
export const crearCotizacion = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const {
      clienteId, productos,
      tipo      = "cotizacion",
      prioridad = false,
      sin_iva   = false,       // ← NUEVO
    } = req.body;

    console.log("🔍 prioridad en controller:", prioridad, "| sin_iva:", sin_iva);

    const tipoDocumento: TipoDocumento = tipo === "pedido" ? "pedido" : "cotizacion";
    const sinIvaBool = sin_iva === true || sin_iva === "true";

    if (!clienteId) return res.status(400).json({ error: "Se requiere clienteId" });
    if (!productos || productos.length === 0) return res.status(400).json({ error: "Se requiere al menos un producto" });

    await client.query("BEGIN");

    let folioCotizacion: string | null = null;
    let folioPedido:     string | null = null;

    if (tipoDocumento === "cotizacion") {
      folioCotizacion = await obtenerSiguienteFolioCotizacion(client);
    } else {
      folioPedido = await obtenerSiguienteFolioPedido(client);
    }

    let solRows: any[];

    if (tipoDocumento === "cotizacion") {
      ({ rows: solRows } = await client.query(
        `INSERT INTO solicitud (
          clientes_idclientes,
          estado_administrativo_cat_idestado_administrativo_cat,
          estado, no_cotizacion, sin_iva
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING idsolicitud, no_cotizacion, no_pedido, estado`,
        [clienteId, ESTADO.PENDIENTE, tipoDocumento, folioCotizacion, sinIvaBool]
      ));
    } else {
      ({ rows: solRows } = await client.query(
        `INSERT INTO solicitud (
          clientes_idclientes,
          estado_administrativo_cat_idestado_administrativo_cat,
          estado, no_pedido, prioridad, sin_iva
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING idsolicitud, no_cotizacion, no_pedido, estado`,
        [clienteId, ESTADO.PENDIENTE, tipoDocumento, folioPedido, prioridad, sinIvaBool]
      ));
    }

    const solicitudId             = solRows[0].idsolicitud;
    const folioCotizacionGuardado = solRows[0].no_cotizacion;
    const folioPedidoGuardado     = solRows[0].no_pedido;

    let subtotalTotal = 0;

    for (const producto of productos) {
      const {
        productoId, tintasId, carasId, detalles,
        observacion = null, bk = null, foil = null,
        idsuaje = null, altoRel = null, laminado = null,
        uvBr = null, pigmentos = null, pantones = null,
        porKilo = null, colorAsaId = null, idMedidaTroquel = null,
        herramental_descripcion = null, herramental_precio = null,
      } = producto;

      if (!productoId) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Cada producto requiere productoId" });
      }

      const detallesValidos = (detalles ?? []).filter(
        (d: any) => d.cantidad > 0 && d.precio_total > 0
      );

      if (detallesValidos.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `El producto ID ${productoId} no tiene cantidades válidas` });
      }

      const pigmentosGuardar     = typeof pigmentos  === "string" && pigmentos.trim()  !== "" ? pigmentos.trim()  : null;
      const pantonesGuardar      = typeof pantones   === "string" && pantones.trim()   !== "" ? pantones.trim()   : null;
      const colorAsaGuardar      = colorAsaId      != null ? Number(colorAsaId)      : null;
      const medidaTroquelGuardar = idMedidaTroquel != null ? Number(idMedidaTroquel) : null;

      const { rows: prodRows } = await client.query(
        `INSERT INTO solicitud_producto (
          solicitud_idsolicitud,
          configuracion_plastico_idconfiguracion_plastico,
          tintas_idtintas, caras_idcaras,
          bk, foil, idsuaje, alto_rel, laminado, uv_br,
          pigmentos, pantones, observacion, id_color, id_medidatro
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        RETURNING idsolicitud_producto`,
        [solicitudId, productoId, tintasId, carasId,
         bk, foil, idsuaje, altoRel, laminado, uvBr,
         pigmentosGuardar, pantonesGuardar, observacion,
         colorAsaGuardar, medidaTroquelGuardar]
      );

      const solicitudProductoId = prodRows[0].idsolicitud_producto;

      const herramentalPrecioNum = herramental_precio != null ? Number(herramental_precio) : null;
      if (herramentalPrecioNum != null && herramentalPrecioNum > 0) {
        await client.query(
          `INSERT INTO herramental (idsolicitud_producto, herramental_descripcion, herramental_precio)
           VALUES ($1, $2, $3)`,
          [
            solicitudProductoId,
            typeof herramental_descripcion === "string" && herramental_descripcion.trim() !== ""
              ? herramental_descripcion.trim()
              : null,
            herramentalPrecioNum,
          ]
        );
        subtotalTotal += herramentalPrecioNum;
        console.log(`✅ Herramental $${herramentalPrecioNum} agregado al producto ${solicitudProductoId}`);
      }

      const porKiloNum    = porKilo ? Number(porKilo) : 0;
      const aprobadoValor = tipoDocumento === "pedido" ? true : null;

      for (const d of detallesValidos) {
        const modoDetalle = d.modo_cantidad === "kilo" ? "kilo" : "unidad";
        let kilogramos: number | null = null;
        if (porKiloNum > 0) {
          if (modoDetalle === "kilo" && d.kilogramos_ingresados) {
            kilogramos = Number(Number(d.kilogramos_ingresados).toFixed(4));
          } else {
            kilogramos = Number((d.cantidad / porKiloNum).toFixed(4));
          }
        }

        await client.query(
          `INSERT INTO solicitud_detalle (
            solicitud_producto_id, cantidad, precio_total, aprobado,
            kilogramos, modo_cantidad
          ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [solicitudProductoId, d.cantidad, d.precio_total, aprobadoValor, kilogramos, modoDetalle]
        );

        subtotalTotal += Number(d.precio_total);
      }
    }

    if (tipoDocumento === "pedido") {
      await crearVentaYDiseno(client, solicitudId, folioPedidoGuardado, subtotalTotal, sinIvaBool);
    }

    await client.query("COMMIT");

    if (tipoDocumento === "pedido") {
      return res.status(201).json({
        message:   "Pedido creado exitosamente",
        no_pedido: folioPedidoGuardado,
        tipo:      "pedido",
        sin_iva:   sinIvaBool,
      });
    }

    return res.status(201).json({
      message:       "Cotización creada exitosamente",
      no_cotizacion: folioCotizacionGuardado,
      tipo:          "cotizacion",
      sin_iva:       sinIvaBool,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ CREAR ERROR:", error.message);
    return res.status(500).json({ error: "Error al crear el documento" });
  } finally {
    client.release();
  }
};

// ============================================================
// OBTENER COTIZACIONES
// ============================================================
export const getCotizaciones = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
          s.idsolicitud,
          s.no_cotizacion,
          s.no_pedido,
          s.estado          AS tipo_documento,
          s.fecha,
          s.sin_iva,
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
          h.aprobado        AS herramental_aprobado

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

      WHERE s.no_cotizacion IS NOT NULL
        AND (
          s.estado = 'cotizacion'
          OR (
            s.estado = 'pedido'
            AND s.visible_hasta IS NOT NULL
            AND s.visible_hasta >= NOW()
          )
        )

      ORDER BY s.no_cotizacion DESC, sp.idsolicitud_producto, sd.idsolicitud_detalle
    `);

    const agrupadas: Record<string, any> = {};

    for (const row of rows) {
      const noCot: string = row.no_cotizacion;

      if (!agrupadas[noCot]) {
        agrupadas[noCot] = {
          no_cotizacion:  noCot,
          no_pedido:      row.no_pedido ?? null,
          tipo_documento: row.tipo_documento ?? "cotizacion",
          fecha:          row.fecha,
          sin_iva:        row.sin_iva ?? false,
          estado_id:      row.estado_administrativo_cat_idestado_administrativo_cat,
          estado:         normalizarNombreEstado(row.estado_nombre || ""),
          cliente_id:     row.clientes_idclientes,
          cliente:        row.cliente_nombre       || "",
          telefono:       row.cliente_telefono     || "",
          correo:         row.cliente_correo       || "",
          impresion:      row.cliente_impresion    || null,
          empresa:        row.cliente_empresa      || "",
          celular:        row.cliente_celular      || null,
          razon_social:   row.cliente_razon_social || null,
          rfc:            row.cliente_rfc          || null,
          domicilio:      row.cliente_domicilio    || null,
          numero:         row.cliente_numero       || null,
          colonia:        row.cliente_colonia      || null,
          codigo_postal:  row.cliente_codigo_postal || null,
          poblacion:      row.cliente_poblacion    || null,
          estado_cliente: row.cliente_estado       || null,
          productos:      [],
          total:          0,
        };
      }

      if (row.idsolicitud_producto) {
        let producto = agrupadas[noCot].productos.find(
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
            idsolicitud:              row.idsolicitud,
            idsolicitud_producto:     row.idsolicitud_producto,
            idcotizacion_producto:    row.idsolicitud_producto,
            producto_id:              row.configuracion_plastico_idconfiguracion_plastico,
            nombre:                   nombreCompleto,
            material:                 row.material_nombre || "",
            calibre:                  calibreResuelto,
            calibre_bopp:             row.calibre_bopp ? String(row.calibre_bopp) : null,
            medidasFormateadas:       row.cfg_medida    || "",
            medidas,
            tintas:                   row.tintas_cantidad ?? row.tintas_idtintas,
            caras:                    row.caras_cantidad  ?? row.caras_idcaras,
            bk:                       row.bk,
            foil:                     row.foil,
            idsuaje:                  row.idsuaje         ?? null,
            asa_suaje:                row.suaje_tipo       ?? null,
            alto_rel:                 row.alto_rel,
            laminado:                 row.laminado,
            uv_br:                    row.uv_br,
            pigmentos:                row.pigmentos || null,
            pantones:                 row.pantones
              ? row.pantones.split(",").map((p: string) => p.trim()).filter(Boolean)
              : null,
            observacion:              row.observacion,
            por_kilo:                 row.cfg_por_kilo ? String(row.cfg_por_kilo) : null,
            id_color:                 row.id_color         ?? null,
            color_asa_nombre:         row.color_asa_nombre  ?? null,
            id_medidatro:             row.id_medidatro     ?? null,
            medida_troquel:           row.medida_troquel   ?? null,
            herramental_descripcion:  row.herramental_descripcion ?? null,
            herramental_precio:       row.herramental_precio != null ? Number(row.herramental_precio) : null,
            herramental_aprobado:     row.herramental_aprobado ?? null,
            herramental_id:           row.id_herramental ?? null,
            detalles:                 [],
            subtotal:                 0,
          };
          agrupadas[noCot].productos.push(producto);
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

    for (const noCot in agrupadas) {
      agrupadas[noCot].total = agrupadas[noCot].productos.reduce(
        (sum: number, p: any) => sum + p.subtotal + (p.herramental_precio ?? 0), 0
      );
    }

    const resultado = Object.values(agrupadas);
    console.log(`✅ Cotizaciones obtenidas: ${resultado.length}`);
    return res.json(resultado);

  } catch (error: any) {
    console.error("❌ GET COTIZACIONES ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener cotizaciones" });
  }
};

// ============================================================
// ACTUALIZAR ESTADO — convierte a pedido si se aprueba
// ============================================================
export const actualizarEstadoCotizacion = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id }       = req.params;
    const { estadoId } = req.body;
    if (!estadoId) return res.status(400).json({ error: "Se requiere estadoId" });

    await client.query("BEGIN");

    const { rows: docRows } = await client.query(
      `SELECT idsolicitud, estado, no_pedido, sin_iva
       FROM solicitud
       WHERE no_cotizacion = $1`,
      [id]
    );

    if (docRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Cotización no encontrada" });
    }

    const doc = docRows[0];
    const sinIva = doc.sin_iva ?? false;
    let folioPedidoAsignado: string | null = doc.no_pedido;
    let seConvirtioAPedido = false;

    if (Number(estadoId) === ESTADO.APROBADO && doc.estado === "cotizacion" && !doc.no_pedido) {
      folioPedidoAsignado = await obtenerSiguienteFolioPedido(client);
      seConvirtioAPedido  = true;

      await client.query(
        `DELETE FROM solicitud_detalle
         WHERE solicitud_producto_id IN (
           SELECT idsolicitud_producto
           FROM solicitud_producto
           WHERE solicitud_idsolicitud = $1
         )
         AND (aprobado IS NULL OR aprobado = false)`,
        [doc.idsolicitud]
      );

      await client.query(
        `UPDATE solicitud
         SET estado_administrativo_cat_idestado_administrativo_cat = $1,
             estado = 'pedido',
             no_pedido = $2,
             fecha_aprobacion = NOW(),
             visible_hasta = NOW() + INTERVAL '5 days'
         WHERE no_cotizacion = $3`,
        [estadoId, folioPedidoAsignado, id]
      );

      const { rows: subtotalRows } = await client.query(
        `SELECT
           COALESCE(SUM(sd.precio_total), 0) AS subtotal_detalles,
           COALESCE(SUM(CASE WHEN h.aprobado = true THEN h.herramental_precio ELSE 0 END), 0) AS subtotal_herramental
         FROM solicitud_producto sp
         LEFT JOIN solicitud_detalle sd
           ON sd.solicitud_producto_id = sp.idsolicitud_producto
         LEFT JOIN herramental h
           ON h.idsolicitud_producto = sp.idsolicitud_producto
         WHERE sp.solicitud_idsolicitud = $1`,
        [doc.idsolicitud]
      );

      const subtotalTotal =
        Number(subtotalRows[0].subtotal_detalles) +
        Number(subtotalRows[0].subtotal_herramental);

      // Pasar sinIva al crear la venta desde la cotización aprobada
      await crearVentaYDiseno(
        client,
        doc.idsolicitud,
        folioPedidoAsignado,
        subtotalTotal,
        sinIva
      );

    } else {
      await client.query(
        `UPDATE solicitud
         SET estado_administrativo_cat_idestado_administrativo_cat = $1
         WHERE no_cotizacion = $2`,
        [estadoId, id]
      );
    }

    await client.query("COMMIT");

    return res.json({
      message: seConvirtioAPedido
        ? "Cotización aprobada y convertida a pedido exitosamente"
        : "Estado actualizado exitosamente",
      convertida_a_pedido: seConvirtioAPedido,
      no_pedido: folioPedidoAsignado,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ ACTUALIZAR ESTADO ERROR:", error.message);
    return res.status(500).json({ error: "Error al actualizar estado" });
  } finally {
    client.release();
  }
};

// ============================================================
// ELIMINAR COTIZACIÓN
// ============================================================
export const eliminarCotizacion = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query("BEGIN");

    const { rows: solRows } = await client.query(
      `SELECT idsolicitud FROM solicitud WHERE no_cotizacion = $1`, [id]
    );
    if (solRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Cotización no encontrada" });
    }

    const solicitudIds: number[] = solRows.map((r: any) => r.idsolicitud);
    const { rows: prodRows } = await client.query(
      `SELECT idsolicitud_producto FROM solicitud_producto
       WHERE solicitud_idsolicitud = ANY($1::int[])`,
      [solicitudIds]
    );
    const productoIds: number[] = prodRows.map((r: any) => r.idsolicitud_producto);

    if (productoIds.length > 0) {
      await client.query(
        `DELETE FROM herramental WHERE idsolicitud_producto = ANY($1::int[])`,
        [productoIds]
      );
      await client.query(
        `DELETE FROM solicitud_detalle WHERE solicitud_producto_id = ANY($1::int[])`,
        [productoIds]
      );
    }

    await client.query(
      `DELETE FROM solicitud_producto WHERE solicitud_idsolicitud = ANY($1::int[])`,
      [solicitudIds]
    );
    await client.query(`DELETE FROM solicitud WHERE no_cotizacion = $1`, [id]);

    await client.query("COMMIT");
    return res.json({ message: "Cotización eliminada exitosamente" });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ ELIMINAR COTIZACIÓN ERROR:", error.message);
    return res.status(500).json({ error: "Error al eliminar cotización" });
  } finally {
    client.release();
  }
};

// ============================================================
// APROBAR / RECHAZAR DETALLE
// ============================================================
export const aprobarDetalle = async (req: Request, res: Response) => {
  try {
    const { idDetalle } = req.params;
    const { aprobado }  = req.body;

    if (typeof aprobado !== "boolean")
      return res.status(400).json({ error: "El campo aprobado debe ser true o false" });

    const { rowCount } = await pool.query(
      `UPDATE solicitud_detalle SET aprobado = $1 WHERE idsolicitud_detalle = $2`,
      [aprobado, idDetalle]
    );

    if (rowCount === 0) return res.status(404).json({ error: "Detalle no encontrado" });
    return res.json({ message: aprobado ? "Aprobado" : "Rechazado", aprobado });

  } catch (error: any) {
    console.error("❌ Error al aprobar/rechazar detalle:", error.message);
    return res.status(500).json({ error: "Error al actualizar aprobación" });
  }
};

// ============================================================
// ACTUALIZAR OBSERVACIÓN
// ============================================================
export const actualizarObservacion = async (req: Request, res: Response) => {
  try {
    const { idP }         = req.params;
    const { observacion } = req.body;

    const { rowCount } = await pool.query(
      `UPDATE solicitud_producto SET observacion = $1 WHERE idsolicitud_producto = $2`,
      [observacion || null, idP]
    );

    if (rowCount === 0) return res.status(404).json({ error: "Producto no encontrado" });
    return res.json({ message: "Observación actualizada", observacion });

  } catch (error: any) {
    console.error("❌ Error al actualizar observación:", error.message);
    return res.status(500).json({ error: "Error al actualizar observación" });
  }
};

// ============================================================
// APROBAR / RECHAZAR HERRAMENTAL
// ============================================================
export const aprobarHerramental = async (req: Request, res: Response) => {
  try {
    const { idH }      = req.params;
    const { aprobado } = req.body;

    if (typeof aprobado !== "boolean")
      return res.status(400).json({ error: "El campo aprobado debe ser true o false" });

    const { rowCount } = await pool.query(
      `UPDATE herramental SET aprobado = $1 WHERE id_herramental = $2`,
      [aprobado, idH]
    );

    if (rowCount === 0) return res.status(404).json({ error: "Herramental no encontrado" });
    return res.json({ message: aprobado ? "Aprobado" : "Rechazado", aprobado });

  } catch (error: any) {
    console.error("❌ Error al aprobar/rechazar herramental:", error.message);
    return res.status(500).json({ error: "Error al actualizar aprobación de herramental" });
  }
};