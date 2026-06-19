// ============================================================================
// Helper de PRODUCTOS DE PAPEL dentro de cotizaciones / pedidos.
// ============================================================================

type TipoDocumento = "cotizacion" | "pedido";

export interface ProductoPapelPayload {
  tipoCotizacion: "papel";
  idproducto_papel: number;
  nombre: string;

  idgrupo_papel: number | null;
  grupo_descripcion: string | null;

  tintasId: number | null;
  pantones: string | null;

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
  precios: [number, number, number];

  // ── Herramental ──────────────────────────────────────────────────────────
  herramental_descripcion?: string | null;
  herramental_precio?: number | null;

  // ── Cargo adicional (nuevo, exclusivo de papel, sin aprobación) ─────────
  cargo_adicional_descripcion?: string | null;
  cargo_adicional_precio?: number | null;
}

const limpiar = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

// ──────────────────────────────────────────────────────────────────────────
// INSERT
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

  const indices = tipoDocumento === "pedido" ? [0] : [0, 1, 2];
  const tieneValido = indices.some(
    (i) => Number(prod.cantidades?.[i] ?? 0) > 0 && Number(prod.precios?.[i] ?? 0) > 0
  );
  if (!tieneValido) {
    throw new Error(`El producto de papel "${prod.nombre}" no tiene cantidades o precios válidos`);
  }

  // 1. solicitud_producto
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

  // 2. solicitud_producto_papel (acabados + cargo adicional)
  const cargoAdicionalPrecio =
    prod.cargo_adicional_precio != null ? Number(prod.cargo_adicional_precio) : null;

  await client.query(
    `INSERT INTO solicitud_producto_papel (
       idsolicitud_producto, id_asa, idcat_laminado, idfoil, idcat_textura,
       uv, alto_relieve, tintas_dentro_idtintas, pantones_dentro,
       cargo_adicional_descripcion, cargo_adicional_precio
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
      limpiar(prod.cargo_adicional_descripcion),
      cargoAdicionalPrecio != null && cargoAdicionalPrecio > 0 ? cargoAdicionalPrecio : null,
    ]
  );

  let subtotal = 0;

  // 3. Cargo adicional — siempre se suma, sin aprobación
  if (cargoAdicionalPrecio != null && cargoAdicionalPrecio > 0) {
    subtotal += cargoAdicionalPrecio;
    console.log(`✅ [papel] Cargo adicional $${cargoAdicionalPrecio} agregado al producto ${solicitudProductoId}`);
  }

  // 4. Herramental (igual que en plástico)
  const herramentalPrecio =
    prod.herramental_precio != null ? Number(prod.herramental_precio) : null;

  if (herramentalPrecio != null && herramentalPrecio > 0) {
    await client.query(
      `INSERT INTO herramental (idsolicitud_producto, herramental_descripcion, herramental_precio)
       VALUES ($1, $2, $3)`,
      [
        solicitudProductoId,
        limpiar(prod.herramental_descripcion) ?? null,
        herramentalPrecio,
      ]
    );
    subtotal += herramentalPrecio;
    console.log(`✅ [papel] Herramental $${herramentalPrecio} agregado al producto ${solicitudProductoId}`);
  }

  // 5. Detalles
  const aprobadoValor = tipoDocumento === "pedido" ? true : null;

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

  console.log(
    `✅ [papel] línea ${solicitudProductoId} | producto_papel=${prod.idproducto_papel} | subtotal=${subtotal}`
  );
  return subtotal;
}

// ──────────────────────────────────────────────────────────────────────────
// READ
// ──────────────────────────────────────────────────────────────────────────
export function construirProductoPapel(row: any) {
  const foilNombre = row.foil_color
    ? `${row.foil_color}${row.foil_codigo ? " " + row.foil_codigo : ""}`
    : null;

  return {
    idsolicitud:           row.idsolicitud,
    idsolicitud_producto:  row.idsolicitud_producto,
    idcotizacion_producto: row.idsolicitud_producto,
    tipoCotizacion:        "papel",
    tipo_material:         "papel",

    idproducto_papel:      row.producto_papel_idproducto_papel,
    nombre:                row.papel_tipo_producto || `Papel #${row.producto_papel_idproducto_papel}`,
    descripcion_papel:     row.papel_descripcion_papel ?? null,
    medida:                row.papel_medida ?? null,

    idgrupo_papel:         row.grupo_papel_idgrupo_papel ?? null,
    grupo_descripcion:     row.grupo_papel_descripcion ?? null,
    precio_sugerido:       row.papel_precio_sugerido != null ? Number(row.papel_precio_sugerido) : null,

    tintas:                row.tintas_cantidad ?? null,
    tintasId:              row.tintas_idtintas ?? null,
    pantones:              row.pantones || null,

    tintasDentroId:        row.tintas_dentro_idtintas ?? null,
    tintasDentro:          row.tintas_dentro_cantidad ?? 0,
    pantonesDentro:        row.pantones_dentro || "",

    caras:                 row.caras_cantidad ?? null,
    carasId:               row.caras_idcaras ?? null,

    id_asa:                row.id_asa ?? null,
    asa_nombre:            row.asa_nombre ?? null,
    idcat_laminado:        row.idcat_laminado ?? null,
    laminado_nombre:       row.laminado_nombre ?? null,
    idfoil:                row.idfoil ?? null,
    foil_nombre:           foilNombre,
    idcat_textura:         row.idcat_textura ?? null,
    textura_nombre:        row.textura_nombre ?? null,
    uv:                    row.uv ?? false,
    alto_relieve:          row.alto_relieve ?? false,

    observacion:           row.observacion ?? null,
    descripcion:           row.descripcion ?? null,

    // ── Herramental ──────────────────────────────────────────────────────
    herramental_descripcion: row.herramental_descripcion ?? null,
    herramental_precio:      row.herramental_precio != null ? Number(row.herramental_precio) : null,
    herramental_aprobado:    row.herramental_aprobado ?? null,
    herramental_id:          row.id_herramental ?? null,

    // ── Cargo adicional (nuevo) ──────────────────────────────────────────
    cargo_adicional_descripcion: row.cargo_adicional_descripcion ?? null,
    cargo_adicional_precio:      row.cargo_adicional_precio != null ? Number(row.cargo_adicional_precio) : null,

    detalles:              [],
    subtotal:              0,
  };
}