// ============================================================================
// Helper de PRODUCTOS DE PAPEL dentro de cotizaciones / pedidos.
//
// Toda la lógica nueva de papel vive aquí para no inflar cotizacion.controller.ts.
// Se engancha al flujo existente (mismo solicitud / solicitud_detalle / pipeline
// de venta-diseño), así que los pedidos MIXTOS (plástico + papel) funcionan.
//
// Tablas que toca:
//   - solicitud_producto         (tipo_material = 'papel' + refs de papel)
//   - solicitud_producto_papel    (satélite 1:1: asa/laminado/foil/textura/uv/alto_relieve
//                                   + tintas interiores)
//   - solicitud_detalle           (cantidades/precios en PIEZAS; modo 'unidad', kilogramos NULL)
// ============================================================================

type TipoDocumento = "cotizacion" | "pedido";

// Forma del producto de papel tal como lo manda el formulario.
export interface ProductoPapelPayload {
  tipoCotizacion: "papel";
  idproducto_papel: number;
  nombre: string;

  idgrupo_papel: number | null;
  grupo_descripcion: string | null;   // snapshot de la opción: "Couché 300pts + Kraft 200gms"

  // Tintas exteriores
  tintasId: number | null;
  pantones: string | null;

  // Tintas interiores ("por dentro")
  tintasDentroId: number | null;
  pantonesDentro: string | null;

  carasId: number | null;

  id_asa: number | null;
  idcat_laminado: number | null;
  idfoil: number | null;
  idcat_textura: number | null;
  uv: boolean;
  alto_relieve: boolean;

  observacion: string | null;
  descripcion: string | null;

  cantidades: [number, number, number];
  precios: [number, number, number];  // precio UNITARIO por pieza
}

const limpiar = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

// ──────────────────────────────────────────────────────────────────────────
// INSERT — devuelve el subtotal aportado por esta línea (para sumarlo al total)
// ──────────────────────────────────────────────────────────────────────────
export async function insertarProductoPapel(
  client: any,
  solicitudId: number,
  prod: ProductoPapelPayload,
  tipoDocumento: TipoDocumento
): Promise<number> {
  if (!prod.idproducto_papel) {
    throw new Error("Cada producto de papel requiere idproducto_papel");
  }

  // Validar que tenga al menos una cantidad/precio válidos
  const indices = tipoDocumento === "pedido" ? [0] : [0, 1, 2];
  const tieneValido = indices.some(
    (i) => Number(prod.cantidades?.[i] ?? 0) > 0 && Number(prod.precios?.[i] ?? 0) > 0
  );
  if (!tieneValido) {
    throw new Error(`El producto de papel "${prod.nombre}" no tiene cantidades o precios válidos`);
  }

  // 1. Línea en solicitud_producto (discriminada como papel)
  const { rows: spRows } = await client.query(
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
       descripcion
     ) VALUES ($1, 'papel', $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING idsolicitud_producto`,
    [
      solicitudId,
      prod.idproducto_papel,
      prod.idgrupo_papel ?? null,
      limpiar(prod.grupo_descripcion),
      prod.tintasId ?? null,
      prod.carasId ?? null,
      limpiar(prod.pantones),
      limpiar(prod.observacion),
      limpiar(prod.descripcion),
    ]
  );

  const solicitudProductoId = spRows[0].idsolicitud_producto;

  // 2. Satélite con acabados de papel + tintas interiores
  await client.query(
    `INSERT INTO solicitud_producto_papel (
       idsolicitud_producto, id_asa, idcat_laminado, idfoil, idcat_textura,
       uv, alto_relieve, tintas_dentro_idtintas, pantones_dentro
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      solicitudProductoId,
      prod.id_asa ?? null,
      prod.idcat_laminado ?? null,
      prod.idfoil ?? null,
      prod.idcat_textura ?? null,
      prod.uv === true,
      prod.alto_relieve === true,
      prod.tintasDentroId ?? null,
      limpiar(prod.pantonesDentro),
    ]
  );

  // 3. Detalles (cantidad × precio = precio_total de la línea, igual que en plástico)
  const aprobadoValor = tipoDocumento === "pedido" ? true : null;
  let subtotal = 0;

  for (const i of indices) {
    const cant = Number(prod.cantidades?.[i] ?? 0);
    const precioUnit = Number(prod.precios?.[i] ?? 0);
    if (cant <= 0 || precioUnit <= 0) continue;

    const precioTotal = Math.round(cant * precioUnit * 100) / 100;
    await client.query(
      `INSERT INTO solicitud_detalle (
         solicitud_producto_id, cantidad, precio_total, aprobado, kilogramos, modo_cantidad
       ) VALUES ($1, $2, $3, $4, NULL, 'unidad')`,
      [solicitudProductoId, cant, precioTotal, aprobadoValor]
    );
    subtotal += precioTotal;
  }

  console.log(`✅ [papel] línea ${solicitudProductoId} | producto_papel=${prod.idproducto_papel} | subtotal=${subtotal}`);
  return subtotal;
}

// ──────────────────────────────────────────────────────────────────────────
// READ — construye el objeto de producto de papel para getCotizaciones.
// Recibe una fila ya unida con los JOINs de papel (ver patch del controller).
// ──────────────────────────────────────────────────────────────────────────
export function construirProductoPapel(row: any) {
  const foilNombre = row.foil_color
    ? `${row.foil_color}${row.foil_codigo ? " " + row.foil_codigo : ""}`
    : null;

  return {
    idsolicitud:            row.idsolicitud,
    idsolicitud_producto:   row.idsolicitud_producto,
    idcotizacion_producto:  row.idsolicitud_producto,
    tipoCotizacion:         "papel",
    tipo_material:          "papel",

    idproducto_papel:       row.producto_papel_idproducto_papel,
    nombre:                 row.papel_tipo_producto || `Papel #${row.producto_papel_idproducto_papel}`,
    descripcion_papel:      row.papel_descripcion_papel ?? null,
    medida:                 row.papel_medida ?? null,

    idgrupo_papel:          row.grupo_papel_idgrupo_papel ?? null,
    grupo_descripcion:      row.grupo_papel_descripcion ?? null,
    precio_sugerido:        row.papel_precio_sugerido != null ? Number(row.papel_precio_sugerido) : null,

    // Tintas exteriores
    tintas:                 row.tintas_cantidad ?? null,
    tintasId:               row.tintas_idtintas ?? null,
    pantones:               row.pantones || null,

    // Tintas interiores
    tintasDentroId:         row.tintas_dentro_idtintas ?? null,
    tintasDentro:           row.tintas_dentro_cantidad ?? 0,
    pantonesDentro:         row.pantones_dentro || "",

    caras:                  row.caras_cantidad ?? null,
    carasId:                row.caras_idcaras ?? null,

    id_asa:                 row.id_asa ?? null,
    asa_nombre:             row.asa_nombre ?? null,
    idcat_laminado:         row.idcat_laminado ?? null,
    laminado_nombre:        row.laminado_nombre ?? null,
    idfoil:                 row.idfoil ?? null,
    foil_nombre:            foilNombre,
    idcat_textura:          row.idcat_textura ?? null,
    textura_nombre:         row.textura_nombre ?? null,
    uv:                     row.uv ?? false,
    alto_relieve:           row.alto_relieve ?? false,

    observacion:            row.observacion ?? null,
    descripcion:            row.descripcion ?? null,

    detalles:               [],
    subtotal:               0,
  };
}