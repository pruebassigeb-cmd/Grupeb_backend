import { iniciarTx } from "../../middlewares/auditoria";
import { Request, Response } from "express";
import { pool } from "../../config/db";
import {
  guardarMaquinariaSeleccionadaPapel,
  validarMaquinariaSeleccionadaPapel,
} from "../cotizaciones/cotizacionPapel.helper";
import {
  calcularTotalesVenta,
  calcularUmbralAnticipo,
  determinarEstadoVenta,
} from "../../services/ventas/totalesVenta.service";
import {
  bloquearSolicitudParaVenta,
  ventaTieneCredito,
} from "../../services/ventas/pagos.service";
import { cambiarMonedaSolicitud } from "../../services/ventas/cambioMoneda.service";
import { ErrorHttp, responderError } from "../../utils/errorHttp";
import { prepararDatosOrden } from "../diseno/diseno.controller";

/**
 * Borra el árbol de diseño colgado de unos productos de solicitud.
 *
 * Existe porque las dos rutas de borrado de pedido lo necesitan y porque el
 * orden importa: hay llaves foráneas SIN cascada que revientan el DELETE si
 * se van en el orden equivocado. El grafo real es:
 *
 *   ficha_detalle_ubicacion → ficha_detalle, ficha_imagen
 *   ficha_detalle / ficha_pantone / ficha_imagen / archivos → orden_diseno_ficha
 *   ficha_imagen → archivos
 *   orden_diseno_ficha → orden_diseno            (sin cascada: bloquea)
 *   mensaje_diseno / revision_diseno / orden_diseno_participante → orden_diseno
 *                                                (con ON DELETE CASCADE)
 *
 * Antes de esto, eliminar un pedido que tuviera ficha de diseño tronaba con
 * "viola la llave foránea orden_diseno_ficha_orden_fkey": las tablas ficha_*
 * son más nuevas que las rutas de borrado y nunca se agregaron a la secuencia.
 */
async function borrarArbolDiseno(client: any, productoIds: number[]): Promise<void> {
  if (productoIds.length === 0) return;

  const { rows: odRows } = await client.query(
    `SELECT idorden_diseno FROM orden_diseno WHERE solicitud_producto_id = ANY($1::int[])`,
    [productoIds]
  );
  const ordenIds: number[] = odRows.map((r: any) => r.idorden_diseno);
  if (ordenIds.length === 0) return;

  const { rows: fichaRows } = await client.query(
    `SELECT idficha FROM orden_diseno_ficha WHERE orden_diseno_id = ANY($1::int[])`,
    [ordenIds]
  );
  const fichaIds: number[] = fichaRows.map((r: any) => r.idficha);

  if (fichaIds.length > 0) {
    // Los archivos de las imágenes se apuntan desde ficha_imagen, así que hay
    // que quedarse con sus ids ANTES de borrar ficha_imagen o se pierden.
    const { rows: imgRows } = await client.query(
      `SELECT archivo_id FROM ficha_imagen WHERE ficha_id = ANY($1::int[])`,
      [fichaIds]
    );
    const archivoIds: number[] = imgRows
      .map((r: any) => r.archivo_id)
      .filter((x: number | null): x is number => x !== null);

    await client.query(
      `DELETE FROM ficha_detalle_ubicacion
        WHERE detalle_id IN (SELECT idficha_detalle FROM ficha_detalle WHERE ficha_id = ANY($1::int[]))
           OR imagen_id  IN (SELECT idficha_imagen  FROM ficha_imagen  WHERE ficha_id = ANY($1::int[]))`,
      [fichaIds]
    );
    await client.query(`DELETE FROM ficha_detalle WHERE ficha_id = ANY($1::int[])`, [fichaIds]);
    await client.query(`DELETE FROM ficha_pantone WHERE ficha_id = ANY($1::int[])`, [fichaIds]);
    await client.query(`DELETE FROM ficha_imagen  WHERE ficha_id = ANY($1::int[])`, [fichaIds]);

    await client.query(`DELETE FROM archivos WHERE ficha_id = ANY($1::int[])`, [fichaIds]);
    if (archivoIds.length > 0) {
      await client.query(`DELETE FROM archivos WHERE id_archivo = ANY($1::int[])`, [archivoIds]);
    }

    await client.query(`DELETE FROM orden_diseno_ficha WHERE idficha = ANY($1::int[])`, [fichaIds]);
  }

  // archivos.revision_diseno_id es ON DELETE SET NULL: no bloquea, pero
  // dejaría archivos huérfanos, y aquí lo que se pidió es que no quede nada.
  await client.query(
    `DELETE FROM archivos
      WHERE revision_diseno_id IN (
        SELECT idrevision FROM revision_diseno WHERE orden_diseno_id = ANY($1::int[]))`,
    [ordenIds]
  );

  await client.query(`DELETE FROM mensaje_diseno            WHERE orden_diseno_id = ANY($1::int[])`, [ordenIds]);
  await client.query(`DELETE FROM revision_diseno           WHERE orden_diseno_id = ANY($1::int[])`, [ordenIds]);
  await client.query(`DELETE FROM orden_diseno_participante WHERE orden_diseno_id = ANY($1::int[])`, [ordenIds]);
  await client.query(`DELETE FROM orden_diseno              WHERE idorden_diseno  = ANY($1::int[])`, [ordenIds]);
}

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

function esProductoPapel(prod: any): boolean {
  return prod?.tipoCotizacion === "papel" ||
    prod?.tipo_material === "papel" ||
    prod?.idproducto_papel != null ||
    prod?.producto_papel_idproducto_papel != null;
}

const normalizarId = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

type ModoCantidadPedido = "unidad" | "kilo";

interface DetallesPedidoValidados {
  detalles: any[];
  idsExistentes: number[];
  modo: ModoCantidadPedido;
}

/**
 * Valida una lista completa de cantidades de un producto antes de persistirla.
 * Todos los detalles de un mismo producto deben usar la misma unidad porque
 * producciÃ³n mantiene un solo objetivo/unidad canÃ³nica por OP.
 */
function validarDetallesPedido(
  detallesRaw: unknown,
  referenciaProducto: string,
  permitirIdsExistentes: boolean,
): DetallesPedidoValidados {
  if (!Array.isArray(detallesRaw) || detallesRaw.length === 0) {
    throw new ErrorHttp(
      400,
      `El producto ${referenciaProducto} debe conservar al menos un detalle`,
    );
  }

  const idsExistentes: number[] = [];
  const modos = new Set<ModoCantidadPedido>();

  for (const det of detallesRaw) {
    if (!det || typeof det !== "object") {
      throw new ErrorHttp(400, `Detalle invÃ¡lido para el producto ${referenciaProducto}`);
    }

    const idRecibido = (det as any).iddetalle;
    if (idRecibido !== null && idRecibido !== undefined && idRecibido !== "") {
      if (!permitirIdsExistentes) {
        throw new ErrorHttp(
          400,
          `Un detalle nuevo del producto ${referenciaProducto} no puede incluir iddetalle`,
        );
      }
      const detalleId = normalizarId(idRecibido);
      if (detalleId === null) {
        throw new ErrorHttp(400, "iddetalle invÃ¡lido");
      }
      idsExistentes.push(detalleId);
    }

    const cantidad = Number((det as any).cantidad);
    const precioTotal = Number((det as any).precio_total);
    const modo = (det as any).modo_cantidad;

    if (
      !Number.isFinite(cantidad) ||
      cantidad <= 0 ||
      !Number.isFinite(precioTotal) ||
      precioTotal <= 0 ||
      (modo !== "unidad" && modo !== "kilo")
    ) {
      throw new ErrorHttp(400, `Detalle invÃ¡lido para el producto ${referenciaProducto}`);
    }

    const kilogramosRaw = (det as any).kilogramos;
    const tieneKilogramos =
      kilogramosRaw !== null && kilogramosRaw !== undefined && kilogramosRaw !== "";
    const kilogramos = tieneKilogramos ? Number(kilogramosRaw) : null;

    if (
      (modo === "kilo" && (!tieneKilogramos || !Number.isFinite(kilogramos) || Number(kilogramos) <= 0)) ||
      (tieneKilogramos && (!Number.isFinite(kilogramos) || Number(kilogramos) <= 0))
    ) {
      throw new ErrorHttp(
        400,
        `Los kilogramos del producto ${referenciaProducto} deben ser mayores a cero`,
      );
    }

    modos.add(modo);
  }

  if (new Set(idsExistentes).size !== idsExistentes.length) {
    throw new ErrorHttp(400, `Hay detalles duplicados en el producto ${referenciaProducto}`);
  }

  if (modos.size !== 1) {
    throw new ErrorHttp(
      400,
      `Todos los detalles del producto ${referenciaProducto} deben usar el mismo modo de cantidad`,
    );
  }

  return {
    detalles: detallesRaw,
    idsExistentes,
    modo: modos.values().next().value as ModoCantidadPedido,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISEÑO — enganchar un producto nuevo al diseño existente del pedido
// ═══════════════════════════════════════════════════════════════════════════════
// Cuando se agrega un producto durante la EDICIÓN de un pedido (no en su
// creación original), ese producto también debe quedar disponible para
// revisión de diseño, igual que los productos con los que se creó el pedido.
// Replica exactamente lo que hace crearVentaYDiseno en cotizaciones.controller.ts
// para cada producto al crear un pedido:
//   1) diseno_producto (enganchado a la fila `diseno` — cabecera — ya
//      existente para la solicitud) en estado PENDIENTE.
//   2) orden_diseno con folio propio (OD{yy}{###}) en estado 'en_revision'.
const DISENO_ESTADO = { PENDIENTE: 1, EN_PROCESO: 2, APROBADO: 3 } as const;

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

async function registrarProductoNuevoEnDiseno(
  client: any,
  solicitudId: number,
  idsolicitudProducto: number,
  noPedido: string
): Promise<void> {
  const { rows: disenoRows } = await client.query(
    `SELECT iddiseno FROM diseno WHERE solicitud_idsolicitud = $1 LIMIT 1`,
    [solicitudId]
  );

  if (disenoRows.length === 0) {
    console.warn(
      `⚠️ No existe registro de diseño (tabla diseno) para solicitud=${solicitudId}; ` +
      `el producto ${idsolicitudProducto} no quedó enganchado a revisión de diseño.`
    );
    return;
  }

  const disenoId = disenoRows[0].iddiseno;

  await client.query(
    `INSERT INTO diseno_producto (
       diseno_iddiseno,
       solicitud_producto_idsolicitud_producto,
       estado_administrativo_cat_idestado_administrativo_cat,
       fecha
     ) VALUES ($1, $2, $3, NOW())`,
    [disenoId, idsolicitudProducto, DISENO_ESTADO.PENDIENTE]
  );

  // Igual que en crearVentaYDiseno: cada producto recibe también su propia
  // orden_diseno con folio, en 'en_revision'.
  const folioOD = await generarFolioOrdenDiseno(client);
  await client.query(
    `INSERT INTO orden_diseno
       (solicitud_producto_id, no_pedido, no_orden_diseno, estado, version_actual)
     VALUES ($1, $2, $3, 'en_revision', 1)`,
    [idsolicitudProducto, noPedido, folioOD]
  );

  // El producto nuevo siempre entra PENDIENTE, así que la cabecera de diseño
  // ya no puede seguir marcada como APROBADO. Recalculamos el estado padre
  // con el mismo criterio que actualizarEstadoProducto en diseno.controller.ts.
  const { rows: todosProductos } = await client.query(
    `SELECT estado_administrativo_cat_idestado_administrativo_cat AS estado_id
     FROM diseno_producto WHERE diseno_iddiseno = $1`,
    [disenoId]
  );
  const estados: number[] = todosProductos.map((p: any) => Number(p.estado_id));
  const nuevoEstadoPadre =
    estados.every((e: number) => e === DISENO_ESTADO.APROBADO) ? DISENO_ESTADO.APROBADO :
    estados.some((e: number) => e === DISENO_ESTADO.EN_PROCESO || e === DISENO_ESTADO.APROBADO) ? DISENO_ESTADO.EN_PROCESO :
    DISENO_ESTADO.PENDIENTE;

  await client.query(
    `UPDATE diseno SET
       estado_administrativo_cat_idestado_administrativo_cat = $1,
       fecha_aprobacion_general = CASE WHEN $2 = $3 THEN fecha_aprobacion_general ELSE NULL END
     WHERE iddiseno = $4`,
    [nuevoEstadoPadre, nuevoEstadoPadre, DISENO_ESTADO.APROBADO, disenoId]
  );

  console.log(
    `✅ Producto ${idsolicitudProducto} registrado en diseño #${disenoId} y orden de diseño ${folioOD} ` +
    `(estado cabecera → ${nuevoEstadoPadre})`
  );
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
          s.sin_iva,
          s.moneda,
          s.tipo_cambio,
          s.origen_cotizador_libre,
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
          spp.cargo_adicional_descripcion,
          spp.cargo_adicional_precio,

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
          h.aprobado         AS herramental_aprobado,

          -- ── Orden de producción + envío (mismo criterio que seguimiento_controller.ts) ──
          -- Se agrega para poder saber, por cada producto del pedido, si ya
          -- se envió por completo (sin parcialidades). Un pedido con varios
          -- productos solo se puede considerar "enviado" cuando TODOS los
          -- suyos lo estén.
          op.idproduccion,
          op.no_produccion,
          op.es_parcialidad,
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
          ) AS envio_bultos_enviados

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
      LEFT JOIN orden_produccion op
          ON op.idsolicitud_producto = sp.idsolicitud_producto

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
          origen_cotizador_libre: row.origen_cotizador_libre === true,
          fecha: row.fecha,
          prioridad: row.prioridad ?? false,
          sin_iva: row.sin_iva ?? false,
          moneda: row.moneda ?? "MXN",
          tipo_cambio: row.tipo_cambio != null ? Number(row.tipo_cambio) : null,
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
              tamano_asa: row.tamano_asa ?? null,
              id_color: row.id_color ?? null,
              color_asa_nombre: row.color_asa_nombre ?? null,
              idcat_laminado: row.idcat_laminado ?? null,
              laminado_nombre: row.laminado_nombre ?? null,
              idfoil: row.idfoil ?? null,
              foil_nombre: foilNombre,
              idcat_textura: row.idcat_textura ?? null,
              textura_nombre: row.textura_nombre ?? null,
              uv: row.uv ?? false,
              alto_relieve: row.alto_relieve ?? false,
              metodo_hojeado: row.metodo_hojeado ?? null,
              lleva_armado: row.lleva_armado ?? true,
              maquinaria_seleccionada: row.maquinaria_seleccionada ?? {},

              observacion: row.observacion ?? null,
              descripcion: row.descripcion ?? null,
              herramental_descripcion: row.herramental_descripcion ?? null,
              herramental_precio: row.herramental_precio != null ? Number(row.herramental_precio) : null,
              herramental_aprobado: row.herramental_aprobado ?? null,
              herramental_id: row.id_herramental ?? null,
              cargo_adicional_descripcion: row.cargo_adicional_descripcion ?? null,
              cargo_adicional_precio: row.cargo_adicional_precio != null ? Number(row.cargo_adicional_precio) : null,

              detalles: [],
              subtotal: 0,
            };
          } else {
            // ── Producto de PLÁSTICO ──
            const tipoNombre = row.tipo_producto_nombre || "";
            const medida = row.cfg_medida || "";
            const material = (row.material_nombre || "").toLowerCase();
const nombreCompleto =
  (row.tipo_material === "expo" && row.descripcion)
    ? row.descripcion
    : [tipoNombre, medida, material].filter(Boolean).join(" ") ||
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

          // ── Orden de producción / envío — común a papel y plástico ──
          producto.idproduccion = row.idproduccion ?? null;
          producto.no_produccion = row.no_produccion ?? null;
          producto.es_parcialidad = Boolean(row.es_parcialidad ?? false);
          producto.envio_total_bultos = Number(row.envio_total_bultos ?? 0);
          producto.envio_bultos_enviados = Number(row.envio_bultos_enviados ?? 0);

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
        (sum: number, p: any) =>
          sum + p.subtotal + (p.herramental_precio ?? 0) + (p.cargo_adicional_precio ?? 0),
        0
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
    // req.params.id puede tipar como string | string[] según la config del
    // proyecto; lo normalizamos una sola vez para poder pasarlo a funciones
    // que exigen `string` estricto (registrarProductoNuevoEnDiseno).
    const noPedidoParam: string = Array.isArray(id) ? id[0] : id;
    const { productos, prioridad, sin_iva } = req.body;
    const productosNuevos = req.body.productos_nuevos ?? [];

    if (!Array.isArray(productos)) {
      throw new ErrorHttp(400, "El campo productos debe ser un arreglo");
    }
    if (!Array.isArray(productosNuevos)) {
      throw new ErrorHttp(400, "El campo productos_nuevos debe ser un arreglo");
    }

    await iniciarTx(req, client);

    // Primero se resuelve el id sin retener row locks; después se toma el
    // advisory por solicitud que comparten edición y pagos. Desde aquí el
    // orden es siempre: solicitud lógica -> venta -> productos/OP.
    const { rows: pedidoReferenciaRows } = await client.query(
      `SELECT idsolicitud FROM solicitud
       WHERE no_pedido = $1 AND estado = 'pedido'`,
      [noPedidoParam]
    );
    if (pedidoReferenciaRows.length === 0) {
      throw new ErrorHttp(404, "Pedido no encontrado");
    }

    const solicitudId = Number(pedidoReferenciaRows[0].idsolicitud);
    await bloquearSolicitudParaVenta(client, solicitudId);

    const { rows: pedRows } = await client.query(
      `SELECT idsolicitud FROM solicitud
       WHERE no_pedido = $1 AND estado = 'pedido'
       FOR NO KEY UPDATE`,
      [noPedidoParam]
    );
    if (pedRows.length === 0) {
      throw new ErrorHttp(404, "Pedido no encontrado");
    }
    // Urgente (prioridad) y sin_iva son banderas de cabecera de la
    // solicitud; sólo se actualizan si el front las envía explícitamente
    // como booleano, para no pisar el valor guardado si no vienen en el payload.
    if (typeof prioridad === "boolean" || typeof sin_iva === "boolean") {
      await client.query(
        `UPDATE solicitud SET
           prioridad = COALESCE($1, prioridad),
           sin_iva   = COALESCE($2, sin_iva)
         WHERE idsolicitud = $3`,
        [
          typeof prioridad === "boolean" ? prioridad : null,
          typeof sin_iva === "boolean" ? sin_iva : null,
          solicitudId,
        ]
      );
    }

    // La fila financiera se bloquea antes que productos/OP. Los flujos de
    // pago toman el mismo advisory y este mismo row lock, por lo que el abono
    // usado al recalcular el saldo nunca queda obsoleto.
    const { rows: ventaRows } = await client.query(
      `SELECT v.idventas, v.abono, s.sin_iva
       FROM ventas v
       JOIN solicitud s ON s.idsolicitud = v.solicitud_idsolicitud
       WHERE v.solicitud_idsolicitud = $1
       FOR UPDATE OF v`,
      [solicitudId]
    );

    // PolÃ­tica de integridad: cuando cualquier OP del pedido ya iniciÃ³, se
    // congela la estructura completa (productos, configuraciones y detalles).
    // Una operaciÃ³n exclusivamente de cabecera puede usar ambos arreglos vacÃ­os.
    const hayCambiosEstructurales = productos.length > 0 || productosNuevos.length > 0;
    const productosPersistidos = new Map<number, { tipo_material: string }>();
    const ordenesPorProducto = new Map<number, any[]>();

    if (hayCambiosEstructurales) {
      // NO KEY UPDATE serializa ediciones y es compatible con el KEY SHARE
      // que solicitan las FKs al crear una OP. Los advisory por producto se
      // toman en orden estable para evitar inversiones entre dos ediciones.
      const { rows: productosPedidoRows } = await client.query(
        `SELECT idsolicitud_producto, tipo_material
         FROM solicitud_producto
         WHERE solicitud_idsolicitud = $1
         ORDER BY idsolicitud_producto
         FOR NO KEY UPDATE`,
        [solicitudId]
      );

      for (const row of productosPedidoRows) {
        const productoId = Number(row.idsolicitud_producto);
        productosPersistidos.set(productoId, { tipo_material: row.tipo_material });
        await client.query(`SELECT pg_advisory_xact_lock($1)`, [productoId]);
      }

      const { rows: ordenesPedidoRows } = await client.query(
        `SELECT
           op.idproduccion,
           op.idsolicitud_producto,
           op.no_produccion,
           (
             COALESCE(op.idestado_produccion_cat, 1) <> 1
             OR op.proceso_actual IS NOT NULL
             OR EXISTS (SELECT 1 FROM extrusion e WHERE e.orden_produccion_idproduccion = op.idproduccion)
             OR EXISTS (SELECT 1 FROM impresion i WHERE i.orden_produccion_idproduccion = op.idproduccion)
             OR EXISTS (SELECT 1 FROM bolseo b WHERE b.orden_produccion_idproduccion = op.idproduccion)
             OR EXISTS (SELECT 1 FROM asa_flexible a WHERE a.orden_produccion_idproduccion = op.idproduccion)
           ) AS produccion_iniciada
         FROM orden_produccion op
         JOIN solicitud_producto sp
           ON sp.idsolicitud_producto = op.idsolicitud_producto
         WHERE sp.solicitud_idsolicitud = $1
         ORDER BY op.idproduccion
         FOR UPDATE OF op`,
        [solicitudId]
      );

      for (const orden of ordenesPedidoRows) {
        const productoId = Number(orden.idsolicitud_producto);
        const ordenes = ordenesPorProducto.get(productoId) ?? [];
        ordenes.push(orden);
        ordenesPorProducto.set(productoId, ordenes);
      }

      const ordenIniciada = ordenesPedidoRows.find(
        (orden: any) => orden.produccion_iniciada === true
      );
      if (ordenIniciada) {
        throw new ErrorHttp(
          409,
          `No se puede modificar la estructura del pedido ${noPedidoParam}: la orden de producción ${ordenIniciada.no_produccion} ya inició`
        );
      }
    }

    const idsProductosRecibidos = new Set<number>();
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

      const productoId = normalizarId(idsolicitud_producto);
      if (productoId === null) {
        throw new ErrorHttp(400, "Producto existente sin idsolicitud_producto válido");
      }
      if (idsProductosRecibidos.has(productoId)) {
        throw new ErrorHttp(400, `El producto ${productoId} está duplicado en la solicitud`);
      }
      idsProductosRecibidos.add(productoId);

      const productoPersistido = productosPersistidos.get(productoId);
      if (!productoPersistido) {
        throw new ErrorHttp(
          404,
          `El producto ${productoId} no pertenece al pedido ${noPedidoParam}`
        );
      }

      const ordenRows = ordenesPorProducto.get(productoId) ?? [];

      if (productoPersistido.tipo_material === "papel") {
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

        if (!prod.tintasId) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `El producto de papel "${prod.nombre ?? prod.idsolicitud_producto}" requiere tintas porque Impresión es obligatoria`,
          });
        }

        const maquinariaSeleccionada =
          await validarMaquinariaSeleccionadaPapel(
            client,
            Number(prod.idproducto_papel),
            prod.maquinaria_seleccionada
          );

        const idColorParaGuardar = prod.id_asa
          ? normalizarId(prod.id_color)
          : null;

        console.log(
          `🎨 actualizarPedido papel sp=${prod.idsolicitud_producto} | id_asa=${prod.id_asa} | id_color recibido=${prod.id_color} | id_color a guardar=${idColorParaGuardar}`
        );

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
          ]
        );

        const { rows: sppCheck } = await client.query(
          `SELECT idsolicitud_producto_papel FROM solicitud_producto_papel WHERE idsolicitud_producto = $1`,
          [prod.idsolicitud_producto]
        );

        let idsolicitudProductoPapel: number;
        if (sppCheck.length > 0) {
          idsolicitudProductoPapel =
            Number(sppCheck[0].idsolicitud_producto_papel);
          await client.query(
            `UPDATE solicitud_producto_papel SET
         id_asa                 = $1,
         tamano_asa             = $2,
         idcat_laminado         = $3,
         idfoil                 = $4,
         idcat_textura          = $5,
         uv                     = $6,
         alto_relieve           = $7,
         tintas_dentro_idtintas = $8,
         pantones_dentro        = $9,
         cargo_adicional_descripcion = $10,
         cargo_adicional_precio      = $11,
         metodo_hojeado              = $12,
         lleva_armado                = $13
       WHERE idsolicitud_producto = $14`,
            [
              prod.id_asa ?? null,
              prod.id_asa && typeof prod.tamano_asa === "string" && prod.tamano_asa.trim()
                ? prod.tamano_asa.trim()
                : null,
              prod.idcat_laminado ?? null,
              prod.idfoil ?? null,
              prod.idcat_textura ?? null,
              prod.uv === true,
              prod.alto_relieve === true,
              prod.tintasDentroId ?? null,
              prod.pantonesDentro || null,
              prod.cargo_adicional_descripcion || null,
              prod.cargo_adicional_precio != null && Number(prod.cargo_adicional_precio) > 0
                ? Number(prod.cargo_adicional_precio)
                : null,
              prod.metodo_hojeado,
              prod.lleva_armado === true,
              prod.idsolicitud_producto,
            ]
          );
        } else {
          const { rows: sppInsert } = await client.query(
            `INSERT INTO solicitud_producto_papel
         (idsolicitud_producto, id_asa, tamano_asa, idcat_laminado, idfoil, idcat_textura,
          uv, alto_relieve, tintas_dentro_idtintas, pantones_dentro,
          cargo_adicional_descripcion, cargo_adicional_precio,
          metodo_hojeado, lleva_armado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING idsolicitud_producto_papel`,
            [
              prod.idsolicitud_producto,
              prod.id_asa ?? null,
              prod.id_asa && typeof prod.tamano_asa === "string" && prod.tamano_asa.trim()
                ? prod.tamano_asa.trim()
                : null,
              prod.idcat_laminado ?? null,
              prod.idfoil ?? null,
              prod.idcat_textura ?? null,
              prod.uv === true,
              prod.alto_relieve === true,
              prod.tintasDentroId ?? null,
              prod.pantonesDentro || null,
              prod.cargo_adicional_descripcion || null,
              prod.cargo_adicional_precio != null && Number(prod.cargo_adicional_precio) > 0
                ? Number(prod.cargo_adicional_precio)
                : null,
              prod.metodo_hojeado,
              prod.lleva_armado === true,
            ]
          );
          idsolicitudProductoPapel =
            Number(sppInsert[0].idsolicitud_producto_papel);
        }

        await guardarMaquinariaSeleccionadaPapel(
          client,
          idsolicitudProductoPapel,
          maquinariaSeleccionada
        );

        const {
          detalles: detallesPapel,
          idsExistentes: idsDetallesPapel,
        } = validarDetallesPedido(prod.detalles, String(productoId), true);

        await client.query(
          `DELETE FROM solicitud_detalle
           WHERE solicitud_producto_id = $1
             AND NOT (idsolicitud_detalle = ANY($2::int[]))`,
          [productoId, idsDetallesPapel]
        );

        for (const det of detallesPapel) {
          const { iddetalle, cantidad, precio_total, precio_unitario, kilogramos, modo_cantidad } = det;
          if (iddetalle) {
            const resultadoDetalle = await client.query(
              `UPDATE solicitud_detalle SET
                 cantidad        = $1,
                 precio_total    = $2,
                 precio_unitario = $3,
                 kilogramos      = $4,
                 modo_cantidad   = $5,
                 aprobado        = true
               WHERE idsolicitud_detalle = $6
                 AND solicitud_producto_id = $7
               RETURNING idsolicitud_detalle`,
              [
                cantidad,
                precio_total,
                precio_unitario ?? null,
                kilogramos ?? null,
                modo_cantidad,
                iddetalle,
                productoId,
              ]
            );

            if (resultadoDetalle.rowCount !== 1) {
              throw new ErrorHttp(
                400,
                `El detalle ${iddetalle} no pertenece al producto ${productoId}`
              );
            }
          } else {
            await client.query(
              `INSERT INTO solicitud_detalle
                 (solicitud_producto_id, cantidad, precio_total, precio_unitario, kilogramos, modo_cantidad, aprobado)
               VALUES ($1,$2,$3,$4,$5,$6,true)`,
              [productoId, cantidad, precio_total, precio_unitario ?? null, kilogramos ?? null, modo_cantidad]
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
      const {
        detalles: detallesPlasticos,
        idsExistentes: idsDetallesRecibidos,
      } = validarDetallesPedido(detalles, String(productoId), true);

      await client.query(
        `DELETE FROM solicitud_detalle
         WHERE solicitud_producto_id = $1
           AND NOT (idsolicitud_detalle = ANY($2::int[]))`,
        [productoId, idsDetallesRecibidos]
      );

      for (const det of detallesPlasticos) {
        const { iddetalle, cantidad, precio_total, precio_unitario, kilogramos, modo_cantidad } = det;

        if (iddetalle) {
          const resultadoDetalle = await client.query(
            `UPDATE solicitud_detalle SET
               cantidad        = $1,
               precio_total    = $2,
               precio_unitario = $3,
               kilogramos      = $4,
               modo_cantidad   = $5,
               aprobado        = true
             WHERE idsolicitud_detalle = $6
               AND solicitud_producto_id = $7
             RETURNING idsolicitud_detalle`,
            [
              cantidad,
              precio_total,
              precio_unitario ?? null,
              kilogramos ?? null,
              modo_cantidad,
              iddetalle,
              productoId,
            ]
          );

          if (resultadoDetalle.rowCount !== 1) {
            throw new ErrorHttp(
              400,
              `El detalle ${iddetalle} no pertenece al producto ${productoId}`
            );
          }
        } else {
          await client.query(
            `INSERT INTO solicitud_detalle
               (solicitud_producto_id, cantidad, precio_total, precio_unitario, kilogramos, modo_cantidad, aprobado)
             VALUES ($1, $2, $3, $4, $5, $6, true)`,
            [productoId, cantidad, precio_total, precio_unitario ?? null, kilogramos ?? null, modo_cantidad]
          );
        }
      }

      // Si la OP existe pero aún no inició, conserva el folio y actualiza sus
      // metas con la configuración/cantidades que acaban de persistirse.
      if (ordenRows.length > 0) {
        const datosOrden = await prepararDatosOrden(client, productoId);
        await client.query(
          `UPDATE orden_produccion SET
             repeticion_extrusion = $1,
             repeticion_metro     = $2,
             metros               = $3,
             metros_merma         = $4,
             ancho_bobina         = $5,
             kilos                = $6,
             kilos_merma          = $7,
             pzas                 = $8,
             pzas_merma           = $9,
             repeticion_kidder    = $10,
             repeticion_sicosa    = $11
           WHERE idproduccion = $12`,
          [
            datosOrden.repeticion_extrusion,
            datosOrden.repeticion_metro,
            datosOrden.metros,
            datosOrden.metros_merma,
            datosOrden.ancho_bobina,
            datosOrden.kilos,
            datosOrden.kilos_merma,
            datosOrden.pzas,
            datosOrden.pzas_merma,
            datosOrden.repeticion_kidder,
            datosOrden.repeticion_sicosa,
            ordenRows[0].idproduccion,
          ]
        );
      }
    }

    for (const prod of (productosNuevos as any[])) {
      const referenciaProductoNuevo = String(
        prod?.nombre ??
        prod?.idproducto_papel ??
        prod?.configuracion_plastico_id ??
        "nuevo",
      );
      const { detalles: detallesNuevos } = validarDetallesPedido(
        prod?.detalles,
        referenciaProductoNuevo,
        false,
      );

      // ── Producto de PAPEL nuevo ─────────────────────────────────────────────
      if (esProductoPapel(prod)) {
        if (!prod.tintasId) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `El producto de papel nuevo "${prod.nombre ?? prod.idproducto_papel}" requiere tintas porque Impresión es obligatoria`,
          });
        }

        const maquinariaSeleccionadaNuevo =
          await validarMaquinariaSeleccionadaPapel(
            client,
            Number(prod.idproducto_papel),
            prod.maquinaria_seleccionada
          );

        const idColorParaGuardarNuevo = prod.id_asa
          ? normalizarId(prod.id_color)
          : null;

        const { rows: spPapelRows } = await client.query(
          `INSERT INTO solicitud_producto (
             solicitud_idsolicitud,
             tipo_material,
             producto_papel_idproducto_papel,
             grupo_papel_idgrupo_papel,
             grupo_papel_descripcion,
             tintas_idtintas,
             caras_idcaras,
             pantones,
             observacion,
             descripcion,
             id_color
           ) VALUES ($1,'papel',$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING idsolicitud_producto`,
          [
            solicitudId,
            prod.idproducto_papel,
            prod.idgrupo_papel ?? null,
            prod.grupo_descripcion ?? null,
            prod.tintasId ?? null,
            prod.carasId ?? null,
            prod.pantones || null,
            prod.observacion || null,
            prod.descripcion || null,
            idColorParaGuardarNuevo,
          ]
        );
        const nuevoSpPapelId: number = spPapelRows[0].idsolicitud_producto;

        await registrarProductoNuevoEnDiseno(client, solicitudId, nuevoSpPapelId, noPedidoParam);

        const { rows: sppInsertNuevo } = await client.query(
          `INSERT INTO solicitud_producto_papel
             (idsolicitud_producto, id_asa, tamano_asa, idcat_laminado, idfoil, idcat_textura,
              uv, alto_relieve, tintas_dentro_idtintas, pantones_dentro,
              cargo_adicional_descripcion, cargo_adicional_precio,
              metodo_hojeado, lleva_armado)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING idsolicitud_producto_papel`,
          [
            nuevoSpPapelId,
            prod.id_asa ?? null,
            prod.id_asa && typeof prod.tamano_asa === "string" && prod.tamano_asa.trim()
              ? prod.tamano_asa.trim()
              : null,
            prod.idcat_laminado ?? null,
            prod.idfoil ?? null,
            prod.idcat_textura ?? null,
            prod.uv === true,
            prod.alto_relieve === true,
            prod.tintasDentroId ?? null,
            prod.pantonesDentro || null,
            prod.cargo_adicional_descripcion || null,
            prod.cargo_adicional_precio != null && Number(prod.cargo_adicional_precio) > 0
              ? Number(prod.cargo_adicional_precio)
              : null,
            prod.metodo_hojeado,
            prod.lleva_armado === true,
          ]
        );
        const idsolicitudProductoPapelNuevo =
          Number(sppInsertNuevo[0].idsolicitud_producto_papel);

        await guardarMaquinariaSeleccionadaPapel(
          client,
          idsolicitudProductoPapelNuevo,
          maquinariaSeleccionadaNuevo
        );

        // Herramental — si viene con datos lo insertamos como aprobado
        if (prod.herramental_descripcion || prod.herramental_precio != null) {
          await client.query(
            `INSERT INTO herramental
               (idsolicitud_producto, herramental_descripcion, herramental_precio, aprobado)
             VALUES ($1, $2, $3, true)`,
            [nuevoSpPapelId, prod.herramental_descripcion, prod.herramental_precio]
          );
        }

        for (const det of detallesNuevos) {
          const { cantidad, precio_total, precio_unitario, kilogramos, modo_cantidad } = det;
          await client.query(
            `INSERT INTO solicitud_detalle
               (solicitud_producto_id, cantidad, precio_total, precio_unitario, kilogramos, modo_cantidad, aprobado)
             VALUES ($1,$2,$3,$4,$5,$6,true)`,
            [nuevoSpPapelId, cantidad, precio_total, precio_unitario ?? null, kilogramos ?? null, modo_cantidad]
          );
        }

        console.log(`✅ Producto de papel nuevo insertado: sp_id=${nuevoSpPapelId} producto_papel=${prod.idproducto_papel}`);
        continue;
      }

      // ── Producto de PLÁSTICO nuevo ──────────────────────────────────────────
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

      await registrarProductoNuevoEnDiseno(client, solicitudId, nuevoSpId, noPedidoParam);

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
      for (const det of detallesNuevos) {
        const { cantidad, precio_total, precio_unitario, kilogramos, modo_cantidad } = det;
        await client.query(
          `INSERT INTO solicitud_detalle
         (solicitud_producto_id, cantidad, precio_total,
          precio_unitario, kilogramos, modo_cantidad, aprobado)
       VALUES ($1,$2,$3,$4,$5,$6,true)`,
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

    // ── Recalcular totales en la fila de ventas bloqueada ─────────────────────
    if (ventaRows.length > 0) {
      const ventaId = ventaRows[0].idventas;
      const abono = Number(ventaRows[0].abono ?? 0);
      const sinIva = ventaRows[0].sin_iva === true;

      const { rows: sumRows } = await client.query(
        `SELECT
           (
             SELECT COALESCE(SUM(sd.precio_total), 0)
             FROM solicitud_detalle sd
             JOIN solicitud_producto sp ON sp.idsolicitud_producto = sd.solicitud_producto_id
             WHERE sp.solicitud_idsolicitud = $1
           ) AS subtotal_prods,
           (
             SELECT COALESCE(SUM(h.herramental_precio), 0)
             FROM herramental h
             JOIN solicitud_producto sp ON sp.idsolicitud_producto = h.idsolicitud_producto
             WHERE sp.solicitud_idsolicitud = $1 AND h.aprobado = true
           ) AS subtotal_herr,
           (
             SELECT COALESCE(SUM(spp.cargo_adicional_precio), 0)
             FROM solicitud_producto_papel spp
             JOIN solicitud_producto sp ON sp.idsolicitud_producto = spp.idsolicitud_producto
             WHERE sp.solicitud_idsolicitud = $1
           ) AS subtotal_cargo_adicional
         FROM solicitud_producto sp
         WHERE sp.solicitud_idsolicitud = $1
         LIMIT 1`,
        [solicitudId]
      );

      const subtotalNuevo =
        Number(sumRows[0].subtotal_prods) +
        Number(sumRows[0].subtotal_herr) +
        Number(sumRows[0].subtotal_cargo_adicional);
      const { iva: ivaNuevo, total: totalNuevo, anticipo: anticipoNuevo } =
        calcularTotalesVenta({ subtotal: subtotalNuevo, sinIva });
      // saldo = lo que falta pagar (nunca negativo)
      const saldoNuevo = Math.max(Number((totalNuevo - abono).toFixed(2)), 0);

      // Recalcular estado según nuevo total y abono actual
      const umbral = calcularUmbralAnticipo(totalNuevo);
      const tieneCredito = await ventaTieneCredito(client, ventaId);
      const nuevoEstado = determinarEstadoVenta(abono, saldoNuevo, umbral, tieneCredito);

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

    const { rows: pedidoActualizadoRows } = await client.query(
      `SELECT
         s.idsolicitud,
         s.no_pedido,
         s.prioridad,
         s.sin_iva,
         v.subtotal,
         v.iva,
         v.total,
         v.anticipo,
         v.abono,
         v.saldo
       FROM solicitud s
       LEFT JOIN ventas v ON v.solicitud_idsolicitud = s.idsolicitud
       WHERE s.idsolicitud = $1`,
      [solicitudId]
    );

    await client.query("COMMIT");
    console.log(`✅ Pedido ${id} actualizado`);
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      message: `Pedido ${id} actualizado correctamente`,
      pedido: pedidoActualizadoRows[0] ?? null,
    });

  } catch (error: unknown) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // La transacción pudo no haber iniciado o ya estar cerrada.
    }
    return responderError(res, error, "Error al actualizar pedido");
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /pedidos/:id
// ═══════════════════════════════════════════════════════════════════════════════
// ============================================================
// CAMBIAR MONEDA (bloqueado si el pedido ya tiene pagos registrados)
// ============================================================
export const cambiarMonedaPedido = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { moneda } = req.body;

    const { rows: pedRows } = await pool.query(
      `SELECT idsolicitud FROM solicitud WHERE no_pedido = $1`, [id]
    );
    if (pedRows.length === 0) {
      return res.status(404).json({ error: "Pedido no encontrado" });
    }

    const resultado = await cambiarMonedaSolicitud(req, pedRows[0].idsolicitud, moneda);
    return res.json(resultado);
  } catch (error: any) {
    console.error("❌ CAMBIAR MONEDA PEDIDO ERROR:", error.message);
    return res.status(400).json({ error: error.message || "Error al cambiar la moneda" });
  }
};

export const eliminarPedido = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Borrado FÍSICO a propósito: el cliente pidió poder desaparecer por
    // completo un pedido. La trazabilidad no se pierde porque el trigger
    // trg_bitacora_* guarda cada renglón borrado en bitacora_cambios
    // (datos_antes trae la fila entera), y req.tx deja registrado quién lo
    // hizo y desde qué endpoint. Sin req.tx todo esto quedaría con
    // usuario_id = NULL, que es lo peor posible en la operación más
    // destructiva del sistema.
    const resultado = await req.tx(async (client) => {
      const { rows: pedRows } = await client.query(
        `SELECT idsolicitud, no_cotizacion FROM solicitud WHERE no_pedido = $1`, [id]
      );
      if (pedRows.length === 0) {
        throw new ErrorHttp(404, "Pedido no encontrado");
      }

      const solicitudId: number = pedRows[0].idsolicitud;
      const noCotizacion: number | null = pedRows[0].no_cotizacion;

      const { rows: pagosRows } = await client.query(
        `SELECT COUNT(*) AS total FROM venta_pago vp
         INNER JOIN ventas v ON v.idventas = vp.ventas_idventas
         WHERE v.solicitud_idsolicitud = $1
           AND vp.eliminado_at IS NULL`, [solicitudId]
      );
      if (Number(pagosRows[0].total) > 0) {
        throw new ErrorHttp(
          409,
          `No se puede eliminar este pedido porque tiene ${pagosRows[0].total} pago(s) registrado(s). ` +
            "Elimina los pagos desde el módulo de Anticipo y Liquidación antes de cancelar el pedido."
        );
      }

      const { rows: disenoRows } = await client.query(
        `SELECT COUNT(*) AS total FROM diseno_producto dp
         INNER JOIN diseno d ON d.iddiseno = dp.diseno_iddiseno
         WHERE d.solicitud_idsolicitud = $1
           AND dp.estado_administrativo_cat_idestado_administrativo_cat = 3`, [solicitudId]
      );
      if (Number(disenoRows[0].total) > 0) {
        throw new ErrorHttp(
          409,
          `No se puede eliminar este pedido porque tiene ${disenoRows[0].total} producto(s) aprobado(s) en diseño. ` +
            "Restablece los productos en el módulo de Diseño antes de cancelar el pedido."
        );
      }

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

        // Antes esto borraba a mano participantes, archivos y orden_diseno —
        // y filtraba archivos por revision_diseno_id usando ids de
        // orden_diseno, que son espacios de ids distintos, así que nunca
        // borraba lo que creía. Además ignoraba las tablas ficha_*.
        await borrarArbolDiseno(client, productoIds);

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

      return {
        message: "Pedido cancelado y eliminado exitosamente",
        no_pedido: id,
        no_cotizacion: noCotizacion,
        tenia_cotizacion: noCotizacion !== null,
      };
    });

    return res.json(resultado);
  } catch (error) {
    return responderError(res, error, "Error al cancelar pedido");
  }
};

export const eliminarPedidoCompleto = async (req: Request, res: Response) => {
  try {
    const { noPedido } = req.params;

    // Borrado FÍSICO de todo el árbol del pedido —incluidos envíos, notas de
    // remisión y bitácora de reparto— porque así lo pidió el cliente: que no
    // quede nada. Lo que sí queda es el rastro: cada DELETE dispara
    // trg_bitacora_* y guarda la fila completa en bitacora_cambios.datos_antes,
    // con el usuario que lo ejecutó gracias a req.tx.
    const resultado = await req.tx(async (client) => {
      const pedido = await client.query(
        `
        SELECT idsolicitud
        FROM solicitud
        WHERE no_pedido = $1
        `,
        [noPedido]
      );

      if (pedido.rows.length === 0) {
        throw new ErrorHttp(404, "Pedido no encontrado");
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

      // Ficha, imágenes, pantones, revisiones, mensajes, participantes y la
      // orden misma, en el orden que exigen las llaves foráneas. Antes esto
      // no borraba orden_diseno_ficha y el DELETE de orden_diseno tronaba en
      // cualquier pedido que tuviera ficha de diseño.
      const { rows: spRows } = await client.query(
        `SELECT idsolicitud_producto FROM solicitud_producto WHERE solicitud_idsolicitud = $1`,
        params
      );
      await borrarArbolDiseno(client, spRows.map((r: any) => r.idsolicitud_producto));

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

      return { message: `Pedido ${noPedido} eliminado completamente` };
    });

    return res.json(resultado);
  } catch (error) {
    return responderError(res, error, "Error al eliminar completamente el pedido");
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
          s.sin_iva,

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
          spp.cargo_adicional_descripcion,
          spp.cargo_adicional_precio,

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
          origen_cotizador_libre: row.origen_cotizador_libre === true,
          fecha: row.fecha,
          prioridad: row.prioridad ?? false,
          sin_iva: row.sin_iva ?? false,
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
              tamano_asa: row.tamano_asa ?? null,
              id_color: row.id_color ?? null,
              color_asa_nombre: row.color_asa_nombre ?? null,
              idcat_laminado: row.idcat_laminado ?? null,
              laminado_nombre: row.laminado_nombre ?? null,
              idfoil: row.idfoil ?? null,
              foil_nombre: foilNombre,
              idcat_textura: row.idcat_textura ?? null,
              textura_nombre: row.textura_nombre ?? null,
              uv: row.uv ?? false,
              alto_relieve: row.alto_relieve ?? false,
              metodo_hojeado: row.metodo_hojeado ?? null,
              lleva_armado: row.lleva_armado ?? true,
              maquinaria_seleccionada: row.maquinaria_seleccionada ?? {},

              observacion: row.observacion ?? null,
              descripcion: row.descripcion ?? null,
              herramental_descripcion: row.herramental_descripcion ?? null,
              herramental_precio: row.herramental_precio != null ? Number(row.herramental_precio) : null,
              herramental_aprobado: row.herramental_aprobado ?? null,
              cargo_adicional_descripcion: row.cargo_adicional_descripcion ?? null,
              cargo_adicional_precio: row.cargo_adicional_precio != null ? Number(row.cargo_adicional_precio) : null,

              detalles: [],
              subtotal: 0,
            };
          } else {
            // ── Producto de PLÁSTICO ──
            const tipoNombre = row.tipo_producto_nombre || "";
            const medida = row.cfg_medida || "";
            const material = (row.material_nombre || "").toLowerCase();
const nombre =
  (row.tipo_material === "expo" && row.descripcion)
    ? row.descripcion
    : [tipoNombre, medida, material].filter(Boolean).join(" ") ||
      `Producto #${row.configuracion_plastico_idconfiguracion_plastico}`;
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
        (sum: number, p: any) =>
          sum + p.subtotal + (p.herramental_precio ?? 0) + (p.cargo_adicional_precio ?? 0),
        0
      );
    }

    return res.json(Object.values(agrupados));

  } catch (error: any) {
    console.error("❌  GET HISTORIAL PEDIDOS ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener historial de pedidos" });
  }
};
