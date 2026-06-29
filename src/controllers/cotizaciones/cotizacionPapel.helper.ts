type TipoDocumento = "cotizacion" | "pedido";
type MetodoHojeadoPapel = "hojeado" | "guillotina";
type MaquinariaSeleccionadaPapel = Record<
  string,
  { id: number; nombre?: string | null } | null
>;
type FiltroMaquinaPapel = { tipo_maquina?: string };
type FiltrosMaquinariaPapel = Record<string, FiltroMaquinaPapel>;

const MAQUINARIA_PEDIDO_PAPEL: Record<
  string,
  { pivot: string; catalogo: string; fk: string }
> = {
  hojeado_guillotina: {
    pivot: "maquinaria_hojeado_guillotina",
    catalogo: "cat_hojeado_guillotina",
    fk: "idcat_hojeado_guillotina",
  },
  impresora: {
    pivot: "maquinaria_impresora",
    catalogo: "cat_impresora",
    fk: "idcat_impresora",
  },
  laminado_maquina: {
    pivot: "maquinaria_laminado",
    catalogo: "cat_laminado_maquina",
    fk: "idcat_laminado_maquina",
  },
  uv: { pivot: "maquinaria_uv", catalogo: "cat_uv", fk: "idcat_uv" },
  hs_ar: {
    pivot: "maquinaria_hs_ar",
    catalogo: "cat_hs_ar",
    fk: "idcat_hs_ar",
  },
  texturizadora: {
    pivot: "maquinaria_texturizadora",
    catalogo: "cat_texturizadora",
    fk: "idcat_texturizadora",
  },
  suaje_maquina: {
    pivot: "maquinaria_suaje_maquina",
    catalogo: "cat_suaje_maquina",
    fk: "idcat_suaje_maquina",
  },
  armado: {
    pivot: "maquinaria_armado",
    catalogo: "cat_armado",
    fk: "idcat_armado",
  },
  empaque_maquina: {
    pivot: "maquinaria_empaque",
    catalogo: "cat_empaque_maquina",
    fk: "idcat_empaque_maquina",
  },
};

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
  tamano_asa?: string | null;
  id_color?: number | null;
  color_asa_nombre?: string | null;
  asa_color?: string | null;
  idcat_laminado: number | null;
  idfoil: number | null;
  idcat_textura: number | null;
  uv: boolean;
  alto_relieve: boolean;
  metodo_hojeado?: MetodoHojeadoPapel | null;
  lleva_armado?: boolean | null;
  maquinaria_seleccionada?: MaquinariaSeleccionadaPapel;
  observacion: string | null;
  descripcion: string | null;
  cantidades: [number, number, number];
  precios: [number, number, number];
  herramental_descripcion?: string | null;
  herramental_precio?: number | null;
  cargo_adicional_descripcion?: string | null;
  cargo_adicional_precio?: number | null;
}

const limpiar = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

const normalizarId = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function resolverCarasAutomaticasPapel(
  client: any,
  prod: ProductoPapelPayload,
): Promise<number | null> {
  // Regla comercial para papel:
  // - Tintas solo al frente = 1 cara
  // - Tintas frente + tintas por dentro = 2 caras
  // Esto evita que cotización, diseño, anticipo/liquidación y producción
  // reciban información contradictoria.
  const cantidadCaras = prod.tintasDentroId ? 2 : 1;

  const { rows } = await client.query(
    `SELECT idcaras
       FROM caras
      WHERE cantidad = $1
      LIMIT 1`,
    [cantidadCaras],
  );

  return rows[0]?.idcaras ?? prod.carasId ?? null;
}

function validarProductoPapelBasico(prod: ProductoPapelPayload): void {
  if (!prod.tintasId) {
    throw new Error(
      `El producto de papel "${prod.nombre}" requiere tintas porque Impresión es obligatoria`,
    );
  }
}

export async function validarMaquinariaSeleccionadaPapel(
  client: any,
  idproductoPapel: number,
  seleccion: MaquinariaSeleccionadaPapel | null | undefined,
  filtros?: FiltrosMaquinariaPapel,
): Promise<MaquinariaSeleccionadaPapel> {
  const resultado: MaquinariaSeleccionadaPapel = {};

  for (const [key, valor] of Object.entries(seleccion ?? {})) {
    if (valor == null) {
      resultado[key] = null;
      continue;
    }

    const config = MAQUINARIA_PEDIDO_PAPEL[key];
    if (!config) continue;

    const id = Number(valor.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`La máquina seleccionada para "${key}" no es válida`);
    }

    const tipoMaquinaFiltro = filtros?.[key]?.tipo_maquina;

    const condicionTipo = tipoMaquinaFiltro
      ? `AND c.tipo_maquina = $3`
      : "";

    const valores = tipoMaquinaFiltro
      ? [idproductoPapel, id, tipoMaquinaFiltro]
      : [idproductoPapel, id];

    const { rows } = await client.query(
      `SELECT c.nombre
       FROM ${config.pivot} m
       JOIN ${config.catalogo} c ON c.${config.fk} = m.${config.fk}
       WHERE m.idproducto_papel = $1
         AND m.${config.fk} = $2
         ${condicionTipo}
       LIMIT 1`,
      valores,
    );

    if (rows.length === 0) {
      throw new Error(
        tipoMaquinaFiltro
          ? `La máquina seleccionada para "${key}" no es de tipo "${tipoMaquinaFiltro}" o no pertenece al producto`
          : `La máquina seleccionada para "${key}" no pertenece al producto de papel`,
      );
    }

    resultado[key] = { id, nombre: rows[0].nombre };
  }

  return resultado;
}

export async function validarMaquinariaRequeridaPapel(
  client: any,
  idproductoPapel: number,
  clavesRequeridas: string[],
  seleccion: MaquinariaSeleccionadaPapel | null | undefined,
  filtros?: FiltrosMaquinariaPapel,
): Promise<MaquinariaSeleccionadaPapel> {
  const resultado = await validarMaquinariaSeleccionadaPapel(
    client,
    idproductoPapel,
    seleccion,
    filtros,
  );

  for (const key of [...new Set(clavesRequeridas)]) {
    const config = MAQUINARIA_PEDIDO_PAPEL[key];
    if (!config) continue;

    const { rows } = await client.query(
      `SELECT EXISTS (
         SELECT 1
         FROM ${config.pivot}
         WHERE idproducto_papel = $1
       ) AS tiene_opciones`,
      [idproductoPapel],
    );

    if (rows[0]?.tiene_opciones === true && !resultado[key]) {
      throw new Error(`Selecciona la máquina para el proceso "${key}"`);
    }
  }

  return resultado;
}

export async function guardarMaquinariaSeleccionadaPapel(
  client: any,
  idsolicitudProductoPapel: number,
  seleccion: MaquinariaSeleccionadaPapel,
): Promise<void> {
  await client.query(
    `DELETE FROM solicitud_producto_papel_maquinaria
     WHERE idsolicitud_producto_papel = $1`,
    [idsolicitudProductoPapel],
  );

  for (const [proceso, maquina] of Object.entries(seleccion)) {
    if (!maquina) continue;
    await client.query(
      `INSERT INTO solicitud_producto_papel_maquinaria (
         idsolicitud_producto_papel,
         proceso,
         idmaquina,
         nombre_maquina
       ) VALUES ($1, $2, $3, $4)`,
      [
        idsolicitudProductoPapel,
        proceso,
        Number(maquina.id),
        maquina.nombre?.trim() || `Maquina #${maquina.id}`,
      ],
    );
  }
}

export async function insertarProductoPapel(
  client: any,
  solicitudId: number,
  prod: ProductoPapelPayload,
  tipoDocumento: TipoDocumento,
): Promise<number> {
  if (!prod.idproducto_papel) {
    throw new Error("Cada producto de papel requiere idproducto_papel");
  }

  validarProductoPapelBasico(prod);

  const carasIdPapel = await resolverCarasAutomaticasPapel(client, prod);

  const indices = tipoDocumento === "pedido" ? [0] : [0, 1, 2];
  const tieneValido = indices.some(
    (i) =>
      Number(prod.cantidades?.[i] ?? 0) > 0 &&
      Number(prod.precios?.[i] ?? 0) > 0,
  );
  if (!tieneValido) {
    throw new Error(
      `El producto de papel "${prod.nombre}" no tiene cantidades o precios validos`,
    );
  }

  const idColorAsa = prod.id_asa ? normalizarId(prod.id_color) : null;

  console.log(
    `📎 insertarProductoPapel: idsolicitud_producto a insertar | id_asa=${prod.id_asa} | id_color recibido=${prod.id_color} | id_color guardado=${idColorAsa}`
  );

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
       descripcion,
       id_color
     ) VALUES ($1, 'papel', $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING idsolicitud_producto`,
    [
      solicitudId,
      prod.idproducto_papel,
      prod.idgrupo_papel ?? null,
      limpiar(prod.grupo_descripcion),
      prod.tintasId,
      carasIdPapel,
      limpiar(prod.pantones),
      limpiar(prod.observacion),
      limpiar(prod.descripcion),
      idColorAsa,
    ],
  );

  const solicitudProductoId = spRows[0].idsolicitud_producto;

  // IMPORTANTE:
  // La selección de Hojeado/Guillotina, Armado y maquinaria ya NO se hace
  // al crear la cotización/pedido. Se guarda después, en el modal de
  // procesos y maquinaria:
  // - Cotización: al aprobar y convertir a pedido.
  // - Pedido directo: paso 2 obligatorio justo después de guardar el pedido.
  const cargoAdicionalPrecio =
    prod.cargo_adicional_precio != null
      ? Number(prod.cargo_adicional_precio)
      : null;

  await client.query(
    `INSERT INTO solicitud_producto_papel (
       idsolicitud_producto, id_asa, tamano_asa,
       idcat_laminado, idfoil, idcat_textura,
       uv, alto_relieve, tintas_dentro_idtintas, pantones_dentro,
       cargo_adicional_descripcion, cargo_adicional_precio,
       metodo_hojeado, lleva_armado
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12, $13, $14
     )
     RETURNING idsolicitud_producto_papel`,
    [
      solicitudProductoId,
      prod.id_asa ?? null,
      prod.id_asa ? limpiar(prod.tamano_asa) : null,
      prod.idcat_laminado ?? null,
      prod.idfoil ?? null,
      prod.idcat_textura ?? null,
      prod.uv === true,
      prod.alto_relieve === true,
      prod.tintasDentroId ?? null,
      limpiar(prod.pantonesDentro),
      limpiar(prod.cargo_adicional_descripcion),
      cargoAdicionalPrecio != null && cargoAdicionalPrecio > 0
        ? cargoAdicionalPrecio
        : null,
      prod.metodo_hojeado ?? null,
      prod.lleva_armado ?? null,
    ],
  );

  let subtotal = 0;
  if (cargoAdicionalPrecio != null && cargoAdicionalPrecio > 0) {
    subtotal += cargoAdicionalPrecio;
  }

  const herramentalPrecio =
    prod.herramental_precio != null ? Number(prod.herramental_precio) : null;

  if (herramentalPrecio != null && herramentalPrecio > 0) {
    await client.query(
      `INSERT INTO herramental (
         idsolicitud_producto,
         herramental_descripcion,
         herramental_precio
       ) VALUES ($1, $2, $3)`,
      [
        solicitudProductoId,
        limpiar(prod.herramental_descripcion),
        herramentalPrecio,
      ],
    );
    subtotal += herramentalPrecio;
  }

  const aprobadoValor = tipoDocumento === "pedido" ? true : null;
  for (const i of indices) {
    const cant = Number(prod.cantidades?.[i] ?? 0);
    const precioUnit = Number(prod.precios?.[i] ?? 0);
    if (cant <= 0 || precioUnit <= 0) continue;

    const precioTotal = Math.round(cant * precioUnit * 100) / 100;
    await client.query(
      `INSERT INTO solicitud_detalle (
         solicitud_producto_id, cantidad, precio_total,
         aprobado, kilogramos, modo_cantidad
       ) VALUES ($1, $2, $3, $4, NULL, 'unidad')`,
      [solicitudProductoId, cant, precioTotal, aprobadoValor],
    );
    subtotal += precioTotal;
  }

  return subtotal;
}

export function construirProductoPapel(row: any) {
  const foilNombre = row.foil_color
    ? `${row.foil_color}${row.foil_codigo ? " " + row.foil_codigo : ""}`
    : null;

  return {
    idsolicitud: row.idsolicitud,
    idsolicitud_producto: row.idsolicitud_producto,
    idcotizacion_producto: row.idsolicitud_producto,
    tipoCotizacion: "papel",
    tipo_material: "papel",
    idproducto_papel: row.producto_papel_idproducto_papel,
    nombre:
      row.papel_tipo_producto ||
      `Papel #${row.producto_papel_idproducto_papel}`,
    descripcion_papel: row.papel_descripcion_papel ?? null,
    medida: row.papel_medida ?? null,
    idgrupo_papel: row.grupo_papel_idgrupo_papel ?? null,
    grupo_descripcion: row.grupo_papel_descripcion ?? null,
    precio_sugerido:
      row.papel_precio_sugerido != null
        ? Number(row.papel_precio_sugerido)
        : null,
    tintas: row.tintas_cantidad ?? null,
    tintasId: row.tintas_idtintas ?? null,
    pantones: row.pantones || null,
    tintasDentroId: row.tintas_dentro_idtintas ?? null,
    tintasDentro: row.tintas_dentro_cantidad ?? 0,
    pantonesDentro: row.pantones_dentro || "",
    caras: row.caras_cantidad ?? null,
    carasId: row.caras_idcaras ?? null,
    id_asa: row.id_asa ?? null,
    asa_nombre: row.asa_nombre ?? null,
    tamano_asa: row.tamano_asa ?? null,
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
    herramental_precio:
      row.herramental_precio != null ? Number(row.herramental_precio) : null,
    herramental_aprobado: row.herramental_aprobado ?? null,
    herramental_id: row.id_herramental ?? null,
    cargo_adicional_descripcion: row.cargo_adicional_descripcion ?? null,
    cargo_adicional_precio:
      row.cargo_adicional_precio != null
        ? Number(row.cargo_adicional_precio)
        : null,
    detalles: [],
    subtotal: 0,
  };
}
