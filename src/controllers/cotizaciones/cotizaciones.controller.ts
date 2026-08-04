import { Request, Response } from "express";
import { pool } from "../../config/db";
import {
  construirProductoPapel,
  fijarMaquinariaPedidoPapel,
  clavesMaquinariaRequeridasPapel,
  insertarProductoPapel,
} from "./cotizacionPapel.helper";
import { calcularTotalesVenta } from "../../services/ventas/totalesVenta.service";
import { cambiarMonedaSolicitud } from "../../services/ventas/cambioMoneda.service";
import {
  type Moneda,
  validarMonedaYTipoCambio,
} from "../../utils/moneda.utils";

const ESTADO = {
  PENDIENTE: 1,
  EN_PROCESO: 2,
  APROBADO: 3,
  RECHAZADO: 4,
} as const;

type TipoDocumento = "cotizacion" | "pedido";

function esProductoPapel(producto: any): boolean {
  return (
    producto?.tipoCotizacion === "papel" ||
    producto?.tipo_material === "papel" ||
    producto?.idproducto_papel != null ||
    producto?.producto_papel_idproducto_papel != null
  );
}

function normalizarNombreEstado(nombre: string): string {
  if (!nombre) return "Pendiente";
  const n = nombre.toLowerCase().trim();
  if (n === "aprobado" || n === "aprobada") return "Aprobada";
  if (n === "rechazado" || n === "rechazada") return "Rechazada";
  return "Pendiente";
}

function generarFolioCotizacion(numero: number): string {
  const yy = new Date().getFullYear().toString().slice(-2);
  return `COT${yy}${String(numero).padStart(3, "0")}`;
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
export async function obtenerSiguienteFolioCotizacion(client: any): Promise<string> {
  const numero = await obtenerSiguienteNumeroCotizacion(client);
  return generarFolioCotizacion(numero);
}

// Antes esta función calculaba MAX(no_pedido)+1 por su cuenta — un mecanismo
// totalmente separado del que usa el módulo Expo (que sí usa una secuencia
// real de Postgres con pg_advisory_xact_lock, ver generar_folio_pedido() en
// la base de datos). Como los dos módulos escriben en la misma columna
// no_pedido pero cada uno llevaba su propio contador, la secuencia de Expo
// se quedaba atrás cada vez que se aprobaba un pedido desde este módulo —
// hasta que Expo intentaba aprobar y chocaba con un folio "P26XXX" que el
// otro mecanismo ya había asignado (violación de ux_solicitud_no_pedido).
// Unificado para que ambos módulos compartan el mismo contador atómico.
export async function obtenerSiguienteFolioPedido(client: any): Promise<string> {
  const { rows } = await client.query(`SELECT public.generar_folio_pedido() AS folio`);
  return String(rows[0].folio);
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

export async function crearVentaYDiseno(
  client: any,
  solicitudId: number,
  folioPedido: string,
  subtotal: number,
  sinIva: boolean = false,
  moneda: Moneda = "MXN",
  tipoCambio: number | null = null,
): Promise<void> {
  const { iva, total, anticipo } = calcularTotalesVenta({ subtotal, sinIva });
  
  const { rows: ventaRows } = await client.query(
    `INSERT INTO ventas (
      solicitud_idsolicitud,
      estado_administrativo_cat_idestado_administrativo_cat,
      subtotal, iva, total, anticipo, saldo, abono,
      moneda, tipo_cambio,
      fecha_creacion
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
    RETURNING idventas`,
    [
      solicitudId, ESTADO.PENDIENTE, subtotal, iva, total, anticipo, total, 0,
      moneda, tipoCambio,
    ],
  );
  console.log(
    `✅ Venta creada: idventas=${ventaRows[0].idventas} | pedido=${folioPedido} | sinIva=${sinIva} | anticipo=${anticipo}`,
  );

  const { rows: disenoRows } = await client.query(
    `INSERT INTO diseno (
      solicitud_idsolicitud,
      estado_administrativo_cat_idestado_administrativo_cat,
      fecha
    ) VALUES ($1, $2, NOW())
    RETURNING iddiseno`,
    [solicitudId, ESTADO.PENDIENTE],
  );
  const disenoId = disenoRows[0].iddiseno;

  const { rows: productos } = await client.query(
    `SELECT DISTINCT sp.idsolicitud_producto
     FROM solicitud_producto sp
     WHERE sp.solicitud_idsolicitud = $1
       AND EXISTS (
         SELECT 1
         FROM solicitud_detalle sd
         WHERE sd.solicitud_producto_id = sp.idsolicitud_producto
           AND sd.aprobado = true
       )
     ORDER BY sp.idsolicitud_producto`,
    [solicitudId],
  );

  for (const prod of productos) {
    await client.query(
      `INSERT INTO diseno_producto (
        diseno_iddiseno,
        solicitud_producto_idsolicitud_producto,
        estado_administrativo_cat_idestado_administrativo_cat,
        fecha
      ) VALUES ($1, $2, $3, NOW())`,
      [disenoId, prod.idsolicitud_producto, ESTADO.PENDIENTE],
    );

    const folioOD = await generarFolioOrdenDiseno(client);
    await client.query(
      `INSERT INTO orden_diseno
        (solicitud_producto_id, no_pedido, no_orden_diseno, estado, version_actual)
       VALUES ($1, $2, $3, 'en_revision', 1)`,
      [prod.idsolicitud_producto, folioPedido, folioOD],
    );
    console.log(
      `✅ Orden de diseño ${folioOD} creada para producto ${prod.idsolicitud_producto}`,
    );
  }

  console.log(
    `✅ Diseño #${disenoId} creado con ${productos.length} producto(s) para pedido ${folioPedido}`,
  );
}

// ============================================================
// CREAR COTIZACIÓN O PEDIDO DIRECTO
// ============================================================
export const crearCotizacion = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const {
      clienteId,
      productos,
      tipo = "cotizacion",
      prioridad = false,
      sin_iva = false,
      moneda: monedaRaw,
      tipoCambio: tipoCambioRaw,
    } = req.body;

    console.log(
      "🔍 prioridad en controller:",
      prioridad,
      "| sin_iva:",
      sin_iva,
    );

    const tipoDocumento: TipoDocumento =
      tipo === "pedido" ? "pedido" : "cotizacion";
    const sinIvaBool = sin_iva === true || sin_iva === "true";

    let moneda: Moneda;
    let tipoCambio: number | null;
    try {
      ({ moneda, tipoCambio } = validarMonedaYTipoCambio(
        monedaRaw,
        tipoCambioRaw,
      ));
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }

    if (!clienteId)
      return res.status(400).json({ error: "Se requiere clienteId" });
    if (!productos || productos.length === 0)
      return res
        .status(400)
        .json({ error: "Se requiere al menos un producto" });

    await client.query("BEGIN");

    let folioCotizacion: string | null = null;
    let folioPedido: string | null = null;

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
          estado, no_cotizacion, sin_iva, moneda, tipo_cambio
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING idsolicitud, no_cotizacion, no_pedido, estado`,
        [
          clienteId,
          ESTADO.PENDIENTE,
          tipoDocumento,
          folioCotizacion,
          sinIvaBool,
          moneda,
          tipoCambio,
        ],
      ));
    } else {
      ({ rows: solRows } = await client.query(
        `INSERT INTO solicitud (
          clientes_idclientes,
          estado_administrativo_cat_idestado_administrativo_cat,
          estado, no_pedido, prioridad, sin_iva, moneda, tipo_cambio
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING idsolicitud, no_cotizacion, no_pedido, estado`,
        [
          clienteId,
          ESTADO.PENDIENTE,
          tipoDocumento,
          folioPedido,
          prioridad,
          sinIvaBool,
          moneda,
          tipoCambio,
        ],
      ));
    }

    const solicitudId = solRows[0].idsolicitud;
    const folioCotizacionGuardado = solRows[0].no_cotizacion;
    const folioPedidoGuardado = solRows[0].no_pedido;

    let subtotalTotal = 0;

    for (const producto of productos) {
      // ── PAPEL ──
      console.log("🧵 PAPEL RECIBIDO:", {
  nombre: producto.nombre,
  id_asa: producto.id_asa,
  tamano_asa: producto.tamano_asa,
  id_color: producto.id_color,
  color_asa_nombre: producto.color_asa_nombre,
});
      if (esProductoPapel(producto)) {
        subtotalTotal += await insertarProductoPapel(
          client,
          solicitudId,
          producto,
          tipoDocumento,
        );
        continue;
      }

      // ── PLÁSTICO ──
      const {
        productoId,
        tintasId,
        carasId,
        detalles,
        observacion = null,
        descripcion = null,
        perforacion = false,
        idsuaje = null,
        pigmentos = null,
        pantones = null,
        porKilo = null,
        colorAsaId = null,
        idMedidaTroquel = null,
        herramental_descripcion = null,
        herramental_precio = null,
      } = producto;

      if (!productoId) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "Cada producto requiere productoId" });
      }

      const detallesValidos = (detalles ?? []).filter(
        (d: any) => d.cantidad > 0 && d.precio_total > 0,
      );

      if (detallesValidos.length === 0) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({
            error: `El producto ID ${productoId} no tiene cantidades válidas`,
          });
      }

      const pigmentosGuardar =
        typeof pigmentos === "string" && pigmentos.trim() !== ""
          ? pigmentos.trim()
          : null;
      const pantonesGuardar =
        typeof pantones === "string" && pantones.trim() !== ""
          ? pantones.trim()
          : null;
      const colorAsaGuardar = colorAsaId != null ? Number(colorAsaId) : null;
      const medidaTroquelGuardar =
        idMedidaTroquel != null ? Number(idMedidaTroquel) : null;
      const descripcionGuardar =
        typeof descripcion === "string" && descripcion.trim() !== ""
          ? descripcion.trim()
          : null;
      const perforacionGuardar = perforacion === true;

      const { rows: prodRows } = await client.query(
        `INSERT INTO solicitud_producto (
          solicitud_idsolicitud,
          configuracion_plastico_idconfiguracion_plastico,
          tintas_idtintas, caras_idcaras,
          idsuaje,
          pigmentos, pantones, observacion, descripcion,
          perforacion,
          id_color, id_medidatro,
          tipo_material
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'plastico')
        RETURNING idsolicitud_producto`,
        [
          solicitudId,
          productoId,
          tintasId,
          carasId,
          idsuaje,
          pigmentosGuardar,
          pantonesGuardar,
          observacion,
          descripcionGuardar,
          perforacionGuardar,
          colorAsaGuardar,
          medidaTroquelGuardar,
        ],
      );

      const solicitudProductoId = prodRows[0].idsolicitud_producto;

      const herramentalPrecioNum =
        herramental_precio != null ? Number(herramental_precio) : null;
      if (herramentalPrecioNum != null && herramentalPrecioNum > 0) {
        await client.query(
          `INSERT INTO herramental (idsolicitud_producto, herramental_descripcion, herramental_precio)
           VALUES ($1, $2, $3)`,
          [
            solicitudProductoId,
            typeof herramental_descripcion === "string" &&
            herramental_descripcion.trim() !== ""
              ? herramental_descripcion.trim()
              : null,
            herramentalPrecioNum,
          ],
        );
        subtotalTotal += herramentalPrecioNum;
        console.log(
          `✅ Herramental $${herramentalPrecioNum} agregado al producto ${solicitudProductoId}`,
        );
      }

      const porKiloNum = porKilo ? Number(porKilo) : 0;
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
          [
            solicitudProductoId,
            d.cantidad,
            d.precio_total,
            aprobadoValor,
            kilogramos,
            modoDetalle,
          ],
        );

        subtotalTotal += Number(d.precio_total);
      }
    }

    if (tipoDocumento === "pedido") {
      await crearVentaYDiseno(
        client,
        solicitudId,
        folioPedidoGuardado,
        subtotalTotal,
        sinIvaBool,
        moneda,
        tipoCambio,
      );
    }

    await client.query("COMMIT");

    if (tipoDocumento === "pedido") {
      return res.status(201).json({
        message: "Pedido creado exitosamente",
        no_pedido: folioPedidoGuardado,
        tipo: "pedido",
        sin_iva: sinIvaBool,
      });
    }

    return res.status(201).json({
      message: "Cotización creada exitosamente",
      no_cotizacion: folioCotizacionGuardado,
      tipo: "cotizacion",
      sin_iva: sinIvaBool,
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
          s.moneda,
          s.tipo_cambio,
          s.origen_expo,
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

          sp.idsolicitud_producto,
          sp.configuracion_plastico_idconfiguracion_plastico,
          sp.tintas_idtintas,
          sp.caras_idcaras,
          sp.idsuaje,
          sp.pigmentos,
          sp.pantones,
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
          spp.tamano_asa,
          spp.idcat_laminado,      lam2.nombre   AS laminado_nombre,
          spp.idfoil,              fo2.colorfoil AS foil_color, fo2.codigofoil AS foil_codigo,
          spp.idcat_textura,       tx2.nombre    AS textura_nombre,
          spp.uv,                  spp.alto_relieve,
          spp.metodo_hojeado,      spp.lleva_armado,
          COALESCE((
            SELECT jsonb_object_agg(
              spm.proceso,
              jsonb_build_object('id', spm.idmaquina, 'nombre', spm.nombre_maquina)
            )
            FROM solicitud_producto_papel_maquinaria spm
            WHERE spm.idsolicitud_producto_papel = spp.idsolicitud_producto_papel
          ), '{}'::jsonb) AS maquinaria_seleccionada,
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
          h.aprobado        AS herramental_aprobado,

          -- ── Datos de catálogo expo (productos aún no convertidos al sistema) ──
          ce_exp.medida        AS expo_medida,
          ce_exp.material      AS expo_material,
          ce_exp.calibre       AS expo_calibre,
          ce_exp.tipo_producto AS expo_tipo_producto

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

      -- ── Datos del catálogo expo para productos tipo_material='expo' ──
      -- (plásticos del catálogo expo o del tablero que aún no se convierten
      --  a configuracion_plastico; el match es por nombre, igual que la
      --  conversión al aprobar)
      LEFT JOIN LATERAL (
        SELECT ce.medida, ce.material, ce.calibre, ce.tipo_producto
        FROM catalogo_expo ce
        WHERE sp.tipo_material = 'expo'
          AND ce.activo = true
          AND LOWER(ce.nombre) = LOWER(sp.descripcion)
        ORDER BY ce.idcatalogo_expo DESC
        LIMIT 1
      ) ce_exp ON true

      LEFT JOIN solicitud_detalle sd
          ON sd.solicitud_producto_id = sp.idsolicitud_producto
      LEFT JOIN herramental h
          ON h.idsolicitud_producto = sp.idsolicitud_producto

      WHERE s.no_cotizacion IS NOT NULL
        AND (
          s.estado = 'cotizacion'
          OR s.estado = 'pedido'
        )

      ORDER BY s.no_cotizacion DESC, sp.idsolicitud_producto, sd.idsolicitud_detalle
    `);

    const agrupadas: Record<string, any> = {};

    for (const row of rows) {
      const noCot: string = row.no_cotizacion;

      if (!agrupadas[noCot]) {
        agrupadas[noCot] = {
          no_cotizacion: noCot,
          no_pedido: row.no_pedido ?? null,
          tipo_documento: row.tipo_documento ?? "cotizacion",
          fecha: row.fecha,
          sin_iva: row.sin_iva ?? false,
          moneda: row.moneda ?? "MXN",
          tipo_cambio: row.tipo_cambio != null ? Number(row.tipo_cambio) : null,
          origen_expo: row.origen_expo === true,
          estado_id: row.estado_administrativo_cat_idestado_administrativo_cat,
          estado: normalizarNombreEstado(row.estado_nombre || ""),
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
        let producto = agrupadas[noCot].productos.find(
          (p: any) => p.idsolicitud_producto === row.idsolicitud_producto,
        );

        if (!producto) {
          if (row.tipo_material === "papel") {
            // ── Producto de PAPEL ──
            producto = construirProductoPapel(row);
          } else if (row.tipo_material === "expo") {
            // ── Producto EXPO (no convertido al sistema) ──
            // Medida, material, calibre y tipo se resuelven desde catalogo_expo
            // vía el LATERAL ce_exp (match por nombre en sp.descripcion).
            producto = {
              idsolicitud: row.idsolicitud,
              idsolicitud_producto: row.idsolicitud_producto,
              idcotizacion_producto: row.idsolicitud_producto,
              tipoCotizacion: "expo",
              tipo_material: "expo",
              nombre: row.descripcion || "Producto expo",
              tipo_producto: row.expo_tipo_producto ?? null,
              medida: row.expo_medida ?? null,
              material: row.expo_material || "",
              calibre: row.expo_calibre || "",
              medidasFormateadas: row.expo_medida || "",
              medidas: {},
              tintas: row.tintas_cantidad ?? null,
              caras: null,
              idsuaje: row.idsuaje ?? null,
              asa_suaje: row.suaje_tipo ?? null,
              pigmentos: row.pigmentos || null,
              pantones: row.pantones
                ? row.pantones
                    .split(",")
                    .map((p: string) => p.trim())
                    .filter(Boolean)
                : null,
              observacion: row.observacion ?? null,
              descripcion: row.descripcion ?? null,
              perforacion: false,
              por_kilo: null,
              id_color: row.id_color ?? null,
              color_asa_nombre: row.color_asa_nombre ?? null,
              id_medidatro: null,
              medida_troquel: null,
              herramental_descripcion: null,
              herramental_precio: null,
              herramental_aprobado: null,
              herramental_id: null,
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
              fuelleFondo: row.cfg_fuelle_fondo
                ? String(row.cfg_fuelle_fondo)
                : "",
              fuelleLateral1: row.cfg_fuelle_lat_iz
                ? String(row.cfg_fuelle_lat_iz)
                : "",
              fuelleLateral2: row.cfg_fuelle_lat_de
                ? String(row.cfg_fuelle_lat_de)
                : "",
              refuerzo: row.cfg_refuerzo ? String(row.cfg_refuerzo) : "",
            };

            const materialUpper = (row.material_nombre || "").toUpperCase();
            const esBopp =
              materialUpper.includes("BOPP") ||
              materialUpper.includes("CELOFAN") ||
              materialUpper.includes("CELOFÁN");

            const calibreResuelto = (() => {
              if (esBopp) {
                const cb = row.calibre_bopp;
                if (cb !== null && cb !== undefined && String(cb).trim() !== "")
                  return String(cb);
                return "";
              }
              const c = row.calibre_numero;
              if (c !== null && c !== undefined && Number(c) !== 0)
                return String(c);
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
              caras: row.caras_cantidad ?? row.caras_idcaras,
              idsuaje: row.idsuaje ?? null,
              asa_suaje: row.suaje_tipo ?? null,
              pigmentos: row.pigmentos || null,
              pantones: row.pantones
                ? row.pantones
                    .split(",")
                    .map((p: string) => p.trim())
                    .filter(Boolean)
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
              herramental_precio:
                row.herramental_precio != null
                  ? Number(row.herramental_precio)
                  : null,
              herramental_aprobado: row.herramental_aprobado ?? null,
              herramental_id: row.id_herramental ?? null,
              detalles: [],
              subtotal: 0,
            };
          }

          agrupadas[noCot].productos.push(producto);
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

    for (const noCot in agrupadas) {
      agrupadas[noCot].total = agrupadas[noCot].productos.reduce(
        (sum: number, p: any) =>
          sum +
          p.subtotal +
          (p.herramental_precio ?? 0) +
          (p.cargo_adicional_precio ?? 0),
        0,
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
export const actualizarEstadoCotizacion = async (
  req: Request,
  res: Response,
) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { estadoId } = req.body;
    if (!estadoId)
      return res.status(400).json({ error: "Se requiere estadoId" });

    await client.query("BEGIN");

    const { rows: docRows } = await client.query(
      `SELECT idsolicitud, estado, no_pedido, sin_iva, moneda, tipo_cambio
       FROM solicitud
       WHERE no_cotizacion = $1`,
      [id],
    );

    if (docRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Cotización no encontrada" });
    }

    const doc = docRows[0];
    const sinIva = doc.sin_iva ?? false;
    let folioPedidoAsignado: string | null = doc.no_pedido;
    let seConvirtioAPedido = false;

    if (
      Number(estadoId) === ESTADO.APROBADO &&
      doc.estado === "cotizacion" &&
      !doc.no_pedido
    ) {
      const { rows: productosPapel } = await client.query(
        `SELECT
           sp.idsolicitud_producto,
           sp.producto_papel_idproducto_papel,
           spp.idsolicitud_producto_papel,
           spp.idcat_laminado,
           spp.idfoil,
           spp.idcat_textura,
           spp.uv,
           spp.alto_relieve,
           spp.lleva_armado
         FROM solicitud_producto sp
         JOIN solicitud_producto_papel spp
           ON spp.idsolicitud_producto = sp.idsolicitud_producto
         WHERE sp.solicitud_idsolicitud = $1
           AND (
             sp.tipo_material = 'papel'
             OR sp.producto_papel_idproducto_papel IS NOT NULL
           )
           AND EXISTS (
             SELECT 1
             FROM solicitud_detalle sd
             WHERE sd.solicitud_producto_id = sp.idsolicitud_producto
               AND sd.aprobado = true
           )`,
        [doc.idsolicitud],
      );

      // NUEVO: ya no se recibe "maquinariaPapel" del frontend ni se pide
      // Hojeado/Guillotina — la maquinaria de cada proceso se lee directo
      // del producto (registrada desde su alta) y se fija aquí mismo, al
      // convertir a pedido.
      for (const producto of productosPapel) {
        const llevaArmado = producto.lleva_armado === true;

        await fijarMaquinariaPedidoPapel(
          client,
          Number(producto.producto_papel_idproducto_papel),
          Number(producto.idsolicitud_producto_papel),
          clavesMaquinariaRequeridasPapel(producto, llevaArmado),
          `Producto #${producto.idsolicitud_producto}`,
        );
      }

      folioPedidoAsignado = await obtenerSiguienteFolioPedido(client);
      seConvirtioAPedido = true;

      await client.query(
        `DELETE FROM solicitud_detalle
         WHERE solicitud_producto_id IN (
           SELECT idsolicitud_producto
           FROM solicitud_producto
           WHERE solicitud_idsolicitud = $1
         )
         AND (aprobado IS NULL OR aprobado = false)`,
        [doc.idsolicitud],
      );

      await client.query(
        `UPDATE solicitud
         SET estado_administrativo_cat_idestado_administrativo_cat = $1,
             estado = 'pedido',
             no_pedido = $2,
             fecha_aprobacion = NOW(),
             -- NOTA: visible_hasta ya NO se usa para filtrar getCotizaciones
             -- (antes hacía que la cotización aprobada desapareciera del todo,
             -- incluso del buscador, pasados 5 días). Se deja el campo por si
             -- algo más lo consulta, pero el ocultamiento ahora es solo en el
             -- frontend (Cotizar.tsx) y siempre es encontrable con el buscador.
             visible_hasta = NOW() + INTERVAL '5 days'
         WHERE no_cotizacion = $3`,
        [estadoId, folioPedidoAsignado, id],
      );

      const { rows: subtotalRows } = await client.query(
        `SELECT
           (
             SELECT COALESCE(SUM(sd.precio_total), 0)
             FROM solicitud_detalle sd
             JOIN solicitud_producto sp ON sp.idsolicitud_producto = sd.solicitud_producto_id
             WHERE sp.solicitud_idsolicitud = $1
           ) AS subtotal_detalles,
           (
             SELECT COALESCE(SUM(h.herramental_precio), 0)
             FROM herramental h
             JOIN solicitud_producto sp ON sp.idsolicitud_producto = h.idsolicitud_producto
             WHERE sp.solicitud_idsolicitud = $1
               AND h.aprobado = true
               AND EXISTS (
                 SELECT 1
                 FROM solicitud_detalle sd
                 WHERE sd.solicitud_producto_id = sp.idsolicitud_producto
                   AND sd.aprobado = true
               )
           ) AS subtotal_herramental,
           (
             SELECT COALESCE(SUM(spp.cargo_adicional_precio), 0)
             FROM solicitud_producto_papel spp
             JOIN solicitud_producto sp ON sp.idsolicitud_producto = spp.idsolicitud_producto
             WHERE sp.solicitud_idsolicitud = $1
               AND EXISTS (
                 SELECT 1
                 FROM solicitud_detalle sd
                 WHERE sd.solicitud_producto_id = sp.idsolicitud_producto
                   AND sd.aprobado = true
               )
           ) AS subtotal_cargo_adicional
         FROM solicitud_producto sp
         WHERE sp.solicitud_idsolicitud = $1
         LIMIT 1`,
        [doc.idsolicitud],
      );

      const subtotalTotal =
        Number(subtotalRows[0].subtotal_detalles) +
        Number(subtotalRows[0].subtotal_herramental) +
        Number(subtotalRows[0].subtotal_cargo_adicional);

      await crearVentaYDiseno(
        client,
        doc.idsolicitud,
        folioPedidoAsignado,
        subtotalTotal,
        sinIva,
        doc.moneda ?? "MXN",
        doc.tipo_cambio ?? null,
      );
    } else {
      await client.query(
        `UPDATE solicitud
         SET estado_administrativo_cat_idestado_administrativo_cat = $1
         WHERE no_cotizacion = $2`,
        [estadoId, id],
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
    const esErrorMaquinaria = /maquinaria|máquina|maquina|proceso/i.test(
      error.message ?? "",
    );
    return res.status(esErrorMaquinaria ? 400 : 500).json({
      error: esErrorMaquinaria ? error.message : "Error al actualizar estado",
    });
  } finally {
    client.release();
  }
};

// ============================================================
// CAMBIAR MONEDA (cotización, aún sin pagos si ya es pedido)
// ============================================================
export const cambiarMonedaCotizacion = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { moneda } = req.body;

    const { rows: solRows } = await pool.query(
      `SELECT idsolicitud FROM solicitud WHERE no_cotizacion = $1`,
      [id],
    );
    if (solRows.length === 0) {
      return res.status(404).json({ error: "Cotización no encontrada" });
    }

    const resultado = await cambiarMonedaSolicitud(solRows[0].idsolicitud, moneda);
    return res.json(resultado);
  } catch (error: any) {
    console.error("❌ CAMBIAR MONEDA COTIZACIÓN ERROR:", error.message);
    return res.status(400).json({ error: error.message || "Error al cambiar la moneda" });
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
      `SELECT idsolicitud FROM solicitud WHERE no_cotizacion = $1`,
      [id],
    );
    if (solRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Cotización no encontrada" });
    }

    const solicitudIds: number[] = solRows.map((r: any) => r.idsolicitud);
    const { rows: prodRows } = await client.query(
      `SELECT idsolicitud_producto FROM solicitud_producto
       WHERE solicitud_idsolicitud = ANY($1::int[])`,
      [solicitudIds],
    );
    const productoIds: number[] = prodRows.map(
      (r: any) => r.idsolicitud_producto,
    );

    if (productoIds.length > 0) {
      await client.query(
        `DELETE FROM herramental WHERE idsolicitud_producto = ANY($1::int[])`,
        [productoIds],
      );
      await client.query(
        `DELETE FROM solicitud_producto_papel WHERE idsolicitud_producto = ANY($1::int[])`,
        [productoIds],
      );
      await client.query(
        `DELETE FROM solicitud_detalle WHERE solicitud_producto_id = ANY($1::int[])`,
        [productoIds],
      );
    }

    await client.query(
      `DELETE FROM solicitud_producto WHERE solicitud_idsolicitud = ANY($1::int[])`,
      [solicitudIds],
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
    const { aprobado } = req.body;

    if (typeof aprobado !== "boolean")
      return res
        .status(400)
        .json({ error: "El campo aprobado debe ser true o false" });

    const { rowCount } = await pool.query(
      `UPDATE solicitud_detalle SET aprobado = $1 WHERE idsolicitud_detalle = $2`,
      [aprobado, idDetalle],
    );

    if (rowCount === 0)
      return res.status(404).json({ error: "Detalle no encontrado" });
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
    const { idP } = req.params;
    const { observacion } = req.body;

    const { rowCount } = await pool.query(
      `UPDATE solicitud_producto SET observacion = $1 WHERE idsolicitud_producto = $2`,
      [observacion || null, idP],
    );

    if (rowCount === 0)
      return res.status(404).json({ error: "Producto no encontrado" });
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
    const { idH } = req.params;
    const { aprobado } = req.body;

    if (typeof aprobado !== "boolean")
      return res
        .status(400)
        .json({ error: "El campo aprobado debe ser true o false" });

    const { rowCount } = await pool.query(
      `UPDATE herramental SET aprobado = $1 WHERE id_herramental = $2`,
      [aprobado, idH],
    );

    if (rowCount === 0)
      return res.status(404).json({ error: "Herramental no encontrado" });
    return res.json({ message: aprobado ? "Aprobado" : "Rechazado", aprobado });
  } catch (error: any) {
    console.error("❌ Error al aprobar/rechazar herramental:", error.message);
    return res
      .status(500)
      .json({ error: "Error al actualizar aprobación de herramental" });
  }
};

// ============================================================
// ACTUALIZAR PRODUCTOS DE UNA COTIZACIÓN (solo mientras no se
// haya convertido a pedido — no toca ventas/diseño/maquinaria,
// porque esas tablas no existen todavía en este punto del flujo)
// ============================================================
export const actualizarCotizacionProductos = async (
  req: Request,
  res: Response,
) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { productos, productos_nuevos = [], sin_iva } = req.body;

    const { rows: docRows } = await client.query(
      `SELECT idsolicitud, estado, no_pedido
       FROM solicitud
       WHERE no_cotizacion = $1`,
      [id],
    );
    if (docRows.length === 0) {
      return res.status(404).json({ error: "Cotización no encontrada" });
    }
    const doc = docRows[0];
    if (doc.estado !== "cotizacion" || doc.no_pedido) {
      return res.status(409).json({
        error:
          "Esta cotización ya fue convertida a pedido y no puede editarse desde aquí.",
      });
    }
    const solicitudId: number = doc.idsolicitud;

    await client.query("BEGIN");

    // sin_iva es una bandera de cabecera; sólo se actualiza si el front la
    // envía explícitamente como booleano, para no pisar el valor guardado.
    if (typeof sin_iva === "boolean") {
      await client.query(
        `UPDATE solicitud SET sin_iva = $1 WHERE idsolicitud = $2`,
        [sin_iva, solicitudId],
      );
    }

    for (const prod of productos as any[]) {
      // ── PAPEL ──────────────────────────────────────────────────────────
      if (esProductoPapel(prod)) {
        if (prod.eliminado) {
          await client.query(
            `DELETE FROM herramental WHERE idsolicitud_producto = $1`,
            [prod.idsolicitud_producto],
          );
          await client.query(
            `DELETE FROM solicitud_detalle WHERE solicitud_producto_id = $1`,
            [prod.idsolicitud_producto],
          );
          await client.query(
            `DELETE FROM solicitud_producto_papel WHERE idsolicitud_producto = $1`,
            [prod.idsolicitud_producto],
          );
          await client.query(
            `DELETE FROM solicitud_producto WHERE idsolicitud_producto = $1`,
            [prod.idsolicitud_producto],
          );
          continue;
        }

        if (!prod.tintasId) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `El producto de papel "${prod.nombre ?? prod.idsolicitud_producto}" requiere tintas porque Impresión es obligatoria`,
          });
        }

        const idColorParaGuardar = prod.id_asa
          ? (Number(prod.id_color) > 0 ? Number(prod.id_color) : null)
          : null;

        await client.query(
          `UPDATE solicitud_producto SET
             producto_papel_idproducto_papel = $1,
             grupo_papel_idgrupo_papel       = $2,
             grupo_papel_descripcion         = $3,
             tintas_idtintas                 = $4,
             caras_idcaras                   = $5,
             pantones                        = $6,
             observacion                     = $7,
             descripcion                     = $8,
             id_color                        = $9
           WHERE idsolicitud_producto = $10`,
          [
            prod.idproducto_papel,
            prod.idgrupo_papel ?? null,
            prod.grupo_descripcion ?? null,
            prod.tintasId ?? null,
            prod.carasId ?? null,
            prod.pantones || null,
            prod.observacion || null,
            prod.descripcion || null,
            idColorParaGuardar,
            prod.idsolicitud_producto,
          ],
        );

        const { rows: sppCheck } = await client.query(
          `SELECT idsolicitud_producto_papel FROM solicitud_producto_papel WHERE idsolicitud_producto = $1`,
          [prod.idsolicitud_producto],
        );

        const tamanoAsa =
          prod.id_asa && typeof prod.tamano_asa === "string" && prod.tamano_asa.trim()
            ? prod.tamano_asa.trim()
            : null;
        const cargoAdicionalPrecio =
          prod.cargo_adicional_precio != null && Number(prod.cargo_adicional_precio) > 0
            ? Number(prod.cargo_adicional_precio)
            : null;

        if (sppCheck.length > 0) {
          await client.query(
            `UPDATE solicitud_producto_papel SET
               id_asa                       = $1,
               tamano_asa                   = $2,
               idcat_laminado               = $3,
               idfoil                       = $4,
               idcat_textura                = $5,
               uv                           = $6,
               alto_relieve                 = $7,
               tintas_dentro_idtintas       = $8,
               pantones_dentro              = $9,
               cargo_adicional_descripcion  = $10,
               cargo_adicional_precio       = $11
             WHERE idsolicitud_producto = $12`,
            [
              prod.id_asa ?? null,
              tamanoAsa,
              prod.idcat_laminado ?? null,
              prod.idfoil ?? null,
              prod.idcat_textura ?? null,
              prod.uv === true,
              prod.alto_relieve === true,
              prod.tintasDentroId ?? null,
              prod.pantonesDentro || null,
              prod.cargo_adicional_descripcion || null,
              cargoAdicionalPrecio,
              prod.idsolicitud_producto,
            ],
          );
        } else {
          await client.query(
            `INSERT INTO solicitud_producto_papel
               (idsolicitud_producto, id_asa, tamano_asa, idcat_laminado, idfoil, idcat_textura,
                uv, alto_relieve, tintas_dentro_idtintas, pantones_dentro,
                cargo_adicional_descripcion, cargo_adicional_precio)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              prod.idsolicitud_producto,
              prod.id_asa ?? null,
              tamanoAsa,
              prod.idcat_laminado ?? null,
              prod.idfoil ?? null,
              prod.idcat_textura ?? null,
              prod.uv === true,
              prod.alto_relieve === true,
              prod.tintasDentroId ?? null,
              prod.pantonesDentro || null,
              prod.cargo_adicional_descripcion || null,
              cargoAdicionalPrecio,
            ],
          );
        }

        // ── Herramental (upsert / delete) ──
        const { rows: herrRows } = await client.query(
          `SELECT id_herramental FROM herramental WHERE idsolicitud_producto = $1`,
          [prod.idsolicitud_producto],
        );
        const tieneHerramental =
          prod.herramental_descripcion || prod.herramental_precio != null;
        if (herrRows.length > 0) {
          if (tieneHerramental) {
            await client.query(
              `UPDATE herramental SET herramental_descripcion = $1, herramental_precio = $2
               WHERE idsolicitud_producto = $3`,
              [prod.herramental_descripcion, prod.herramental_precio, prod.idsolicitud_producto],
            );
          } else {
            await client.query(
              `DELETE FROM herramental WHERE idsolicitud_producto = $1`,
              [prod.idsolicitud_producto],
            );
          }
        } else if (tieneHerramental) {
          await client.query(
            `INSERT INTO herramental (idsolicitud_producto, herramental_descripcion, herramental_precio)
             VALUES ($1, $2, $3)`,
            [prod.idsolicitud_producto, prod.herramental_descripcion, prod.herramental_precio],
          );
        }

        // ── Detalles (hasta 3 opciones, sin aprobar todavía) ──
        const idsEnviados: number[] = (prod.detalles as any[])
          .map((d) => d.iddetalle)
          .filter((v) => v != null);
        if (idsEnviados.length > 0) {
          await client.query(
            `DELETE FROM solicitud_detalle
             WHERE solicitud_producto_id = $1 AND idsolicitud_detalle != ALL($2::int[])`,
            [prod.idsolicitud_producto, idsEnviados],
          );
        } else {
          await client.query(
            `DELETE FROM solicitud_detalle WHERE solicitud_producto_id = $1`,
            [prod.idsolicitud_producto],
          );
        }
        for (const det of prod.detalles as any[]) {
          if (Number(det.cantidad) <= 0 || Number(det.precio_total) <= 0) continue;
          if (det.iddetalle) {
            await client.query(
              `UPDATE solicitud_detalle SET
                 cantidad = $1, precio_total = $2, precio_unitario = $3, modo_cantidad = 'unidad'
               WHERE idsolicitud_detalle = $4`,
              [det.cantidad, det.precio_total, det.precio_unitario ?? null, det.iddetalle],
            );
          } else {
            await client.query(
              `INSERT INTO solicitud_detalle
                 (solicitud_producto_id, cantidad, precio_total, precio_unitario, aprobado, kilogramos, modo_cantidad)
               VALUES ($1,$2,$3,$4,NULL,NULL,'unidad')`,
              [prod.idsolicitud_producto, det.cantidad, det.precio_total, det.precio_unitario ?? null],
            );
          }
        }
        continue;
      }

      // ── PLÁSTICO ─────────────────────────────────────────────────────
      if (prod.eliminado) {
        await client.query(
          `DELETE FROM herramental WHERE idsolicitud_producto = $1`,
          [prod.idsolicitud_producto],
        );
        await client.query(
          `DELETE FROM solicitud_detalle WHERE solicitud_producto_id = $1`,
          [prod.idsolicitud_producto],
        );
        await client.query(
          `DELETE FROM solicitud_producto WHERE idsolicitud_producto = $1`,
          [prod.idsolicitud_producto],
        );
        continue;
      }

      const tintasId = await resolverIdTintasCotizacion(client, prod.tintas);
      const carasId = await resolverIdCarasCotizacion(client, prod.caras);

      const pantonesLimpios = (() => {
        if (!prod.pantones) return null;
        const arr = prod.pantones.split(",").map((s: string) => s.trim()).filter(Boolean);
        const truncados = arr.slice(0, prod.tintas);
        return truncados.length > 0 ? truncados.join(", ") : null;
      })();

      if (prod.nuevo_configuracion_id) {
        await client.query(
          `UPDATE solicitud_producto SET
             configuracion_plastico_idconfiguracion_plastico = $1,
             tintas_idtintas = $2, caras_idcaras = $3,
             pantones = $4, pigmentos = $5, observacion = $6, descripcion = $7,
             perforacion = $8, idsuaje = $9, id_color = $10, id_medidatro = $11
           WHERE idsolicitud_producto = $12`,
          [
            prod.nuevo_configuracion_id, tintasId, carasId, pantonesLimpios,
            prod.pigmentos || null, prod.observacion || null, prod.descripcion || null,
            prod.perforacion === true, prod.idsuaje ?? null, prod.id_color ?? null,
            prod.id_medidatro ?? null, prod.idsolicitud_producto,
          ],
        );
      } else {
        await client.query(
          `UPDATE solicitud_producto SET
             tintas_idtintas = $1, caras_idcaras = $2, pantones = $3, pigmentos = $4,
             observacion = $5, descripcion = $6, perforacion = $7,
             idsuaje = $8, id_color = $9, id_medidatro = $10
           WHERE idsolicitud_producto = $11`,
          [
            tintasId, carasId, pantonesLimpios, prod.pigmentos || null,
            prod.observacion || null, prod.descripcion || null, prod.perforacion === true,
            prod.idsuaje ?? null, prod.id_color ?? null, prod.id_medidatro ?? null,
            prod.idsolicitud_producto,
          ],
        );
      }

      const { rows: herrRows } = await client.query(
        `SELECT id_herramental FROM herramental WHERE idsolicitud_producto = $1`,
        [prod.idsolicitud_producto],
      );
      const tieneHerramental = prod.herramental_descripcion || prod.herramental_precio != null;
      if (herrRows.length > 0) {
        if (tieneHerramental) {
          await client.query(
            `UPDATE herramental SET herramental_descripcion = $1, herramental_precio = $2
             WHERE idsolicitud_producto = $3`,
            [prod.herramental_descripcion, prod.herramental_precio, prod.idsolicitud_producto],
          );
        } else {
          await client.query(
            `DELETE FROM herramental WHERE idsolicitud_producto = $1`,
            [prod.idsolicitud_producto],
          );
        }
      } else if (tieneHerramental) {
        await client.query(
          `INSERT INTO herramental (idsolicitud_producto, herramental_descripcion, herramental_precio)
           VALUES ($1, $2, $3)`,
          [prod.idsolicitud_producto, prod.herramental_descripcion, prod.herramental_precio],
        );
      }

      const idsEnviados: number[] = (prod.detalles as any[])
        .map((d) => d.iddetalle)
        .filter((v) => v != null);
      if (idsEnviados.length > 0) {
        await client.query(
          `DELETE FROM solicitud_detalle
           WHERE solicitud_producto_id = $1 AND idsolicitud_detalle != ALL($2::int[])`,
          [prod.idsolicitud_producto, idsEnviados],
        );
      } else {
        await client.query(
          `DELETE FROM solicitud_detalle WHERE solicitud_producto_id = $1`,
          [prod.idsolicitud_producto],
        );
      }
      for (const det of prod.detalles as any[]) {
        if (Number(det.cantidad) <= 0 || Number(det.precio_total) <= 0) continue;
        if (det.iddetalle) {
          await client.query(
            `UPDATE solicitud_detalle SET
               cantidad = $1, precio_total = $2, kilogramos = $3, modo_cantidad = $4
             WHERE idsolicitud_detalle = $5`,
            [det.cantidad, det.precio_total, det.kilogramos ?? null, det.modo_cantidad || "unidad", det.iddetalle],
          );
        } else {
          await client.query(
            `INSERT INTO solicitud_detalle
               (solicitud_producto_id, cantidad, precio_total, aprobado, kilogramos, modo_cantidad)
             VALUES ($1,$2,$3,NULL,$4,$5)`,
            [prod.idsolicitud_producto, det.cantidad, det.precio_total, det.kilogramos ?? null, det.modo_cantidad || "unidad"],
          );
        }
      }
    }

    // ── Productos nuevos ────────────────────────────────────────────────
    for (const prod of productos_nuevos as any[]) {
      if (esProductoPapel(prod)) {
        if (!prod.tintasId) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `El producto de papel nuevo "${prod.nombre ?? prod.idproducto_papel}" requiere tintas porque Impresión es obligatoria`,
          });
        }
        const idColorNuevo = prod.id_asa
          ? (Number(prod.id_color) > 0 ? Number(prod.id_color) : null)
          : null;

        const { rows: spPapelRows } = await client.query(
          `INSERT INTO solicitud_producto (
             solicitud_idsolicitud, tipo_material, producto_papel_idproducto_papel,
             grupo_papel_idgrupo_papel, grupo_papel_descripcion,
             tintas_idtintas, caras_idcaras, pantones, observacion, descripcion, id_color
           ) VALUES ($1,'papel',$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING idsolicitud_producto`,
          [
            solicitudId, prod.idproducto_papel, prod.idgrupo_papel ?? null,
            prod.grupo_descripcion ?? null, prod.tintasId ?? null, prod.carasId ?? null,
            prod.pantones || null, prod.observacion || null, prod.descripcion || null,
            idColorNuevo,
          ],
        );
        const nuevoSpPapelId: number = spPapelRows[0].idsolicitud_producto;

        const tamanoAsaNuevo =
          prod.id_asa && typeof prod.tamano_asa === "string" && prod.tamano_asa.trim()
            ? prod.tamano_asa.trim()
            : null;

        await client.query(
          `INSERT INTO solicitud_producto_papel
             (idsolicitud_producto, id_asa, tamano_asa, idcat_laminado, idfoil, idcat_textura,
              uv, alto_relieve, tintas_dentro_idtintas, pantones_dentro,
              cargo_adicional_descripcion, cargo_adicional_precio)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            nuevoSpPapelId, prod.id_asa ?? null, tamanoAsaNuevo,
            prod.idcat_laminado ?? null, prod.idfoil ?? null, prod.idcat_textura ?? null,
            prod.uv === true, prod.alto_relieve === true, prod.tintasDentroId ?? null,
            prod.pantonesDentro || null, prod.cargo_adicional_descripcion || null,
            prod.cargo_adicional_precio != null && Number(prod.cargo_adicional_precio) > 0
              ? Number(prod.cargo_adicional_precio) : null,
          ],
        );

        if (prod.herramental_descripcion || prod.herramental_precio != null) {
          await client.query(
            `INSERT INTO herramental (idsolicitud_producto, herramental_descripcion, herramental_precio)
             VALUES ($1, $2, $3)`,
            [nuevoSpPapelId, prod.herramental_descripcion, prod.herramental_precio],
          );
        }

        for (const det of prod.detalles as any[]) {
          if (Number(det.cantidad) <= 0 || Number(det.precio_total) <= 0) continue;
          await client.query(
            `INSERT INTO solicitud_detalle
               (solicitud_producto_id, cantidad, precio_total, precio_unitario, aprobado, kilogramos, modo_cantidad)
             VALUES ($1,$2,$3,$4,NULL,NULL,'unidad')`,
            [nuevoSpPapelId, det.cantidad, det.precio_total, det.precio_unitario ?? null],
          );
        }
        continue;
      }

      const tintasIdNuevo = await resolverIdTintasCotizacion(client, prod.tintas);
      const carasIdNuevo = await resolverIdCarasCotizacion(client, prod.caras);
      const pantonesLimpiosNuevo = (() => {
        if (!prod.pantones) return null;
        const arr = prod.pantones.split(",").map((s: string) => s.trim()).filter(Boolean);
        return arr.slice(0, prod.tintas).join(", ") || null;
      })();

      const { rows: spRows } = await client.query(
        `INSERT INTO solicitud_producto (
           solicitud_idsolicitud, configuracion_plastico_idconfiguracion_plastico,
           tintas_idtintas, caras_idcaras, pantones, pigmentos, observacion, descripcion,
           perforacion, idsuaje, id_color, id_medidatro
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING idsolicitud_producto`,
        [
          solicitudId, prod.configuracion_plastico_id, tintasIdNuevo, carasIdNuevo,
          pantonesLimpiosNuevo, prod.pigmentos || null, prod.observacion || null,
          prod.descripcion || null, prod.perforacion === true, prod.idsuaje ?? null,
          prod.id_color ?? null, prod.id_medidatro ?? null,
        ],
      );
      const nuevoSpId: number = spRows[0].idsolicitud_producto;

      if (prod.herramental_descripcion || prod.herramental_precio != null) {
        await client.query(
          `INSERT INTO herramental (idsolicitud_producto, herramental_descripcion, herramental_precio)
           VALUES ($1, $2, $3)`,
          [nuevoSpId, prod.herramental_descripcion, prod.herramental_precio],
        );
      }

      for (const det of prod.detalles as any[]) {
        if (Number(det.cantidad) <= 0 || Number(det.precio_total) <= 0) continue;
        await client.query(
          `INSERT INTO solicitud_detalle
             (solicitud_producto_id, cantidad, precio_total, aprobado, kilogramos, modo_cantidad)
           VALUES ($1,$2,$3,NULL,$4,$5)`,
          [nuevoSpId, det.cantidad, det.precio_total, det.kilogramos ?? null, det.modo_cantidad || "unidad"],
        );
      }
    }

    await client.query("COMMIT");
    return res.json({ message: `Cotización ${id} actualizada correctamente` });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ ACTUALIZAR COTIZACIÓN ERROR:", error.message);
    return res.status(500).json({ error: "Error al actualizar cotización", detalle: error.message });
  } finally {
    client.release();
  }
};

// Helpers locales (mismo criterio que resolverIdTintas/Caras en pedidos.controller.ts)
async function resolverIdTintasCotizacion(client: any, cantidad: number): Promise<number | null> {
  const { rows } = await client.query(`SELECT idtintas FROM tintas WHERE cantidad = $1 LIMIT 1`, [cantidad]);
  return rows[0]?.idtintas ?? null;
}
async function resolverIdCarasCotizacion(client: any, cantidad: number): Promise<number | null> {
  const { rows } = await client.query(`SELECT idcaras FROM caras WHERE cantidad = $1 LIMIT 1`, [cantidad]);
  return rows[0]?.idcaras ?? null;
}