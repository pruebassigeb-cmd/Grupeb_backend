// type TipoDocumento = "cotizacion" | "pedido";
// type MaquinariaSeleccionadaPapel = Record<
//   string,
//   { id: number; nombre?: string | null } | null
// >;

// const MAQUINARIA_PEDIDO_PAPEL: Record<
//   string,
//   { pivot: string; catalogo: string; fk: string; tipoMaquina?: string }
// > = {
//   // NUEVO: el producto puede tener registrada una máquina Hojeadora y una
//   // Guillotina por separado (ambas viven en la misma tabla pivote/catálogo,
//   // diferenciadas por tipo_maquina). Ya no se deriva "el método" — las dos
//   // quedan disponibles siempre en la orden de producción, y cada una usa la
//   // máquina que le corresponde por tipo.
//   hojeadora: {
//     pivot: "maquinaria_hojeado_guillotina",
//     catalogo: "cat_hojeado_guillotina",
//     fk: "idcat_hojeado_guillotina",
//     tipoMaquina: "hojeadora",
//   },
//   guillotina: {
//     pivot: "maquinaria_hojeado_guillotina",
//     catalogo: "cat_hojeado_guillotina",
//     fk: "idcat_hojeado_guillotina",
//     tipoMaquina: "guillotina",
//   },
//   impresora: {
//     pivot: "maquinaria_impresora",
//     catalogo: "cat_impresora",
//     fk: "idcat_impresora",
//   },
//   laminado_maquina: {
//     pivot: "maquinaria_laminado",
//     catalogo: "cat_laminado_maquina",
//     fk: "idcat_laminado_maquina",
//   },
//   uv: { pivot: "maquinaria_uv", catalogo: "cat_uv", fk: "idcat_uv" },
//   hs_ar: {
//     pivot: "maquinaria_hs_ar",
//     catalogo: "cat_hs_ar",
//     fk: "idcat_hs_ar",
//   },
//   texturizadora: {
//     pivot: "maquinaria_texturizadora",
//     catalogo: "cat_texturizadora",
//     fk: "idcat_texturizadora",
//   },
//   suaje_maquina: {
//     pivot: "maquinaria_suaje_maquina",
//     catalogo: "cat_suaje_maquina",
//     fk: "idcat_suaje_maquina",
//   },
//   armado: {
//     pivot: "maquinaria_armado",
//     catalogo: "cat_armado",
//     fk: "idcat_armado",
//   },
//   empaque_maquina: {
//     pivot: "maquinaria_empaque",
//     catalogo: "cat_empaque_maquina",
//     fk: "idcat_empaque_maquina",
//   },
// };

// export interface ProductoPapelPayload {
//   tipoCotizacion: "papel";
//   idproducto_papel: number;
//   nombre: string;
//   idgrupo_papel: number | null;
//   grupo_descripcion: string | null;
//   tintasId: number | null;
//   pantones: string | null;
//   tintasDentroId: number | null;
//   pantonesDentro: string | null;
//   carasId: number | null;
//   id_asa: number | null;
//   tamano_asa?: string | null;
//   id_color?: number | null;
//   color_asa_nombre?: string | null;
//   asa_color?: string | null;
//   idcat_laminado: number | null;
//   idfoil: number | null;
//   idcat_textura: number | null;
//   uv: boolean;
//   alto_relieve: boolean;
//   // NUEVO: lleva_armado sigue viniendo de la cotización (specs.lleva_armado
//   // en FormularioProductoPapel.tsx). metodo_hojeado y maquinaria_seleccionada
//   // ya NO se reciben del frontend — la maquinaria se deriva automáticamente
//   // del producto al crear/convertir el pedido (ver fijarMaquinariaPedidoPapel).
//   lleva_armado?: boolean | null;
//   observacion: string | null;
//   descripcion: string | null;
//   cantidades: [number, number, number];
//   precios: [number, number, number];
//   herramental_descripcion?: string | null;
//   herramental_precio?: number | null;
//   cargo_adicional_descripcion?: string | null;
//   cargo_adicional_precio?: number | null;
// }

// const limpiar = (v: unknown): string | null =>
//   typeof v === "string" && v.trim() !== "" ? v.trim() : null;

// const normalizarId = (v: unknown): number | null => {
//   if (v === null || v === undefined || v === "") return null;
//   const n = Number(v);
//   return Number.isInteger(n) && n > 0 ? n : null;
// };

// async function resolverCarasAutomaticasPapel(
//   client: any,
//   prod: ProductoPapelPayload,
// ): Promise<number | null> {
//   // Regla comercial para papel:
//   // - Tintas solo al frente = 1 cara
//   // - Tintas frente + tintas por dentro = 2 caras
//   // Esto evita que cotización, diseño, anticipo/liquidación y producción
//   // reciban información contradictoria.
//   const cantidadCaras = prod.tintasDentroId ? 2 : 1;

//   const { rows } = await client.query(
//     `SELECT idcaras
//        FROM caras
//       WHERE cantidad = $1
//       LIMIT 1`,
//     [cantidadCaras],
//   );

//   return rows[0]?.idcaras ?? prod.carasId ?? null;
// }

// function validarProductoPapelBasico(prod: ProductoPapelPayload): void {
//   if (!prod.tintasId) {
//     throw new Error(
//       `El producto de papel "${prod.nombre}" requiere tintas porque Impresión es obligatoria`,
//     );
//   }
// }

// export async function validarMaquinariaSeleccionadaPapel(
//   client: any,
//   idproductoPapel: number,
//   seleccion: MaquinariaSeleccionadaPapel | null | undefined,
// ): Promise<MaquinariaSeleccionadaPapel> {
//   const resultado: MaquinariaSeleccionadaPapel = {};

//   for (const [key, valor] of Object.entries(seleccion ?? {})) {
//     if (valor == null) {
//       resultado[key] = null;
//       continue;
//     }

//     const config = MAQUINARIA_PEDIDO_PAPEL[key];
//     if (!config) continue;

//     const id = Number(valor.id);
//     if (!Number.isInteger(id) || id <= 0) {
//       throw new Error(`La máquina seleccionada para "${key}" no es válida`);
//     }

//     const tipoMaquinaFiltro = config.tipoMaquina;

//     const condicionTipo = tipoMaquinaFiltro
//       ? `AND c.tipo_maquina = $3`
//       : "";

//     const valores = tipoMaquinaFiltro
//       ? [idproductoPapel, id, tipoMaquinaFiltro]
//       : [idproductoPapel, id];

//     const { rows } = await client.query(
//       `SELECT c.nombre
//        FROM ${config.pivot} m
//        JOIN ${config.catalogo} c ON c.${config.fk} = m.${config.fk}
//        WHERE m.idproducto_papel = $1
//          AND m.${config.fk} = $2
//          ${condicionTipo}
//        LIMIT 1`,
//       valores,
//     );

//     if (rows.length === 0) {
//       throw new Error(
//         tipoMaquinaFiltro
//           ? `La máquina seleccionada para "${key}" no es de tipo "${tipoMaquinaFiltro}" o no pertenece al producto`
//           : `La máquina seleccionada para "${key}" no pertenece al producto de papel`,
//       );
//     }

//     resultado[key] = { id, nombre: rows[0].nombre };
//   }

//   return resultado;
// }

// export async function validarMaquinariaRequeridaPapel(
//   client: any,
//   idproductoPapel: number,
//   clavesRequeridas: string[],
//   seleccion: MaquinariaSeleccionadaPapel | null | undefined,
// ): Promise<MaquinariaSeleccionadaPapel> {
//   const resultado = await validarMaquinariaSeleccionadaPapel(
//     client,
//     idproductoPapel,
//     seleccion,
//   );

//   for (const key of [...new Set(clavesRequeridas)]) {
//     const config = MAQUINARIA_PEDIDO_PAPEL[key];
//     if (!config) continue;

//     const condicionTipo = config.tipoMaquina ? `AND c.tipo_maquina = $2` : "";
//     const valores = config.tipoMaquina
//       ? [idproductoPapel, config.tipoMaquina]
//       : [idproductoPapel];

//     const { rows } = await client.query(
//       `SELECT EXISTS (
//          SELECT 1
//          FROM ${config.pivot} m
//          ${config.tipoMaquina ? `JOIN ${config.catalogo} c ON c.${config.fk} = m.${config.fk}` : ""}
//          WHERE m.idproducto_papel = $1
//          ${condicionTipo}
//        ) AS tiene_opciones`,
//       valores,
//     );

//     if (rows[0]?.tiene_opciones === true && !resultado[key]) {
//       throw new Error(`Selecciona la máquina para el proceso "${key}"`);
//     }
//   }

//   return resultado;
// }

// // NUEVO: la máquina de cada proceso ya no se elige por pedido — es la que
// // quedó registrada como default del producto desde su alta
// // (FormularioProductoPapelAlta, una sola máquina por proceso gracias al
// // UNIQUE(idproducto_papel) en cada tabla maquinaria_*). Esta función la lee
// // directo de esas tablas, sin necesitar nada del frontend.
// export function clavesMaquinariaRequeridasPapel(
//   producto: {
//     idcat_laminado?: number | null;
//     uv?: boolean | null;
//     idfoil?: number | null;
//     alto_relieve?: boolean | null;
//     idcat_textura?: number | null;
//   },
//   llevaArmado: boolean,
// ): string[] {
//   return [
//     "hojeadora",
//     "guillotina",
//     "impresora",
//     ...(producto.idcat_laminado != null ? ["laminado_maquina"] : []),
//     ...(producto.uv === true ? ["uv"] : []),
//     ...(producto.idfoil != null || producto.alto_relieve === true
//       ? ["hs_ar"]
//       : []),
//     ...(producto.idcat_textura != null ? ["texturizadora"] : []),
//     "suaje_maquina",
//     ...(llevaArmado ? ["armado"] : []),
//     "empaque_maquina",
//   ];
// }

// async function obtenerMaquinariaDefaultPapel(
//   client: any,
//   idproductoPapel: number,
//   claves: string[],
// ): Promise<MaquinariaSeleccionadaPapel> {
//   const resultado: MaquinariaSeleccionadaPapel = {};

//   for (const key of [...new Set(claves)]) {
//     const config = MAQUINARIA_PEDIDO_PAPEL[key];
//     if (!config) continue;

//     const condicionTipo = config.tipoMaquina ? `AND c.tipo_maquina = $2` : "";
//     const valores = config.tipoMaquina
//       ? [idproductoPapel, config.tipoMaquina]
//       : [idproductoPapel];

//     const { rows } = await client.query(
//       `SELECT m.${config.fk} AS id, c.nombre
//          FROM ${config.pivot} m
//          JOIN ${config.catalogo} c ON c.${config.fk} = m.${config.fk}
//         WHERE m.idproducto_papel = $1
//           ${condicionTipo}
//         LIMIT 1`,
//       valores,
//     );

//     resultado[key] = rows[0]
//       ? { id: Number(rows[0].id), nombre: rows[0].nombre }
//       : null;
//   }

//   return resultado;
// }

// // NUEVO: reemplaza el paso manual de "Configurar maquinaria". Lee la
// // máquina default de cada proceso requerido directo de las tablas
// // maquinaria_* del producto y la guarda en el pedido. Si al producto le
// // falta registrar la máquina de algún proceso obligatorio, truena con un
// // error claro (hay que registrarla en el alta del producto, no aquí).
// export async function fijarMaquinariaPedidoPapel(
//   client: any,
//   idproductoPapel: number,
//   idsolicitudProductoPapel: number,
//   claves: string[],
//   nombreProducto: string,
// ): Promise<void> {
//   const seleccion = await obtenerMaquinariaDefaultPapel(
//     client,
//     idproductoPapel,
//     claves,
//   );

//   const faltante = claves.find((key) => !seleccion[key]);
//   if (faltante) {
//     throw new Error(
//       `El producto de papel "${nombreProducto}" no tiene registrada la máquina de "${faltante}". Configúrala en el alta del producto antes de crear/convertir el pedido.`,
//     );
//   }

//   await guardarMaquinariaSeleccionadaPapel(
//     client,
//     idsolicitudProductoPapel,
//     seleccion,
//   );
// }

// export async function guardarMaquinariaSeleccionadaPapel(
//   client: any,
//   idsolicitudProductoPapel: number,
//   seleccion: MaquinariaSeleccionadaPapel,
// ): Promise<void> {
//   await client.query(
//     `DELETE FROM solicitud_producto_papel_maquinaria
//      WHERE idsolicitud_producto_papel = $1`,
//     [idsolicitudProductoPapel],
//   );

//   for (const [proceso, maquina] of Object.entries(seleccion)) {
//     if (!maquina) continue;
//     await client.query(
//       `INSERT INTO solicitud_producto_papel_maquinaria (
//          idsolicitud_producto_papel,
//          proceso,
//          idmaquina,
//          nombre_maquina
//        ) VALUES ($1, $2, $3, $4)`,
//       [
//         idsolicitudProductoPapel,
//         proceso,
//         Number(maquina.id),
//         maquina.nombre?.trim() || `Maquina #${maquina.id}`,
//       ],
//     );
//   }
// }

// export async function insertarProductoPapel(
//   client: any,
//   solicitudId: number,
//   prod: ProductoPapelPayload,
//   tipoDocumento: TipoDocumento,
// ): Promise<number> {
//   if (!prod.idproducto_papel) {
//     throw new Error("Cada producto de papel requiere idproducto_papel");
//   }

//   validarProductoPapelBasico(prod);

//   const carasIdPapel = await resolverCarasAutomaticasPapel(client, prod);

//   const indices = tipoDocumento === "pedido" ? [0] : [0, 1, 2];
//   const tieneValido = indices.some(
//     (i) =>
//       Number(prod.cantidades?.[i] ?? 0) > 0 &&
//       Number(prod.precios?.[i] ?? 0) > 0,
//   );
//   if (!tieneValido) {
//     throw new Error(
//       `El producto de papel "${prod.nombre}" no tiene cantidades o precios validos`,
//     );
//   }

//   const idColorAsa = prod.id_asa ? normalizarId(prod.id_color) : null;

//   console.log(
//     `📎 insertarProductoPapel: idsolicitud_producto a insertar | id_asa=${prod.id_asa} | id_color recibido=${prod.id_color} | id_color guardado=${idColorAsa}`
//   );

//   const { rows: spRows } = await client.query(
//     `INSERT INTO solicitud_producto (
//        solicitud_idsolicitud,
//        tipo_material,
//        producto_papel_idproducto_papel,
//        grupo_papel_idgrupo_papel,
//        grupo_papel_descripcion,
//        tintas_idtintas,
//        caras_idcaras,
//        pantones,
//        observacion,
//        descripcion,
//        id_color
//      ) VALUES ($1, 'papel', $2, $3, $4, $5, $6, $7, $8, $9, $10)
//      RETURNING idsolicitud_producto`,
//     [
//       solicitudId,
//       prod.idproducto_papel,
//       prod.idgrupo_papel ?? null,
//       limpiar(prod.grupo_descripcion),
//       prod.tintasId,
//       carasIdPapel,
//       limpiar(prod.pantones),
//       limpiar(prod.observacion),
//       limpiar(prod.descripcion),
//       idColorAsa,
//     ],
//   );

//   const solicitudProductoId = spRows[0].idsolicitud_producto;

//   // NUEVO: metodo_hojeado ya no se guarda — Hojeado/Guillotina se decide
//   // físicamente en producción, no en el sistema. lleva_armado sí se sigue
//   // capturando (viene de specs.lleva_armado en FormularioProductoPapel.tsx).
//   const cargoAdicionalPrecio =
//     prod.cargo_adicional_precio != null
//       ? Number(prod.cargo_adicional_precio)
//       : null;

//   const { rows: sppRows } = await client.query(
//     `INSERT INTO solicitud_producto_papel (
//        idsolicitud_producto, id_asa, tamano_asa,
//        idcat_laminado, idfoil, idcat_textura,
//        uv, alto_relieve, tintas_dentro_idtintas, pantones_dentro,
//        cargo_adicional_descripcion, cargo_adicional_precio,
//        lleva_armado
//      ) VALUES (
//        $1, $2, $3, $4, $5, $6, $7, $8,
//        $9, $10, $11, $12, $13
//      )
//      RETURNING idsolicitud_producto_papel`,
//     [
//       solicitudProductoId,
//       prod.id_asa ?? null,
//       prod.id_asa ? limpiar(prod.tamano_asa) : null,
//       prod.idcat_laminado ?? null,
//       prod.idfoil ?? null,
//       prod.idcat_textura ?? null,
//       prod.uv === true,
//       prod.alto_relieve === true,
//       prod.tintasDentroId ?? null,
//       limpiar(prod.pantonesDentro),
//       limpiar(prod.cargo_adicional_descripcion),
//       cargoAdicionalPrecio != null && cargoAdicionalPrecio > 0
//         ? cargoAdicionalPrecio
//         : null,
//       prod.lleva_armado ?? null,
//     ],
//   );

//   const idsolicitudProductoPapel = sppRows[0].idsolicitud_producto_papel;

//   // NUEVO: si es un pedido (directo o recién convertido), la maquinaria de
//   // cada proceso se fija de inmediato leyendo el default registrado en el
//   // producto — ya no hay paso manual de "Configurar maquinaria".
//   if (tipoDocumento === "pedido") {
//     const llevaArmado = prod.lleva_armado === true;
//     await fijarMaquinariaPedidoPapel(
//       client,
//       prod.idproducto_papel,
//       idsolicitudProductoPapel,
//       clavesMaquinariaRequeridasPapel(prod, llevaArmado),
//       prod.nombre,
//     );
//   }

//   let subtotal = 0;
//   if (cargoAdicionalPrecio != null && cargoAdicionalPrecio > 0) {
//     subtotal += cargoAdicionalPrecio;
//   }

//   const herramentalPrecio =
//     prod.herramental_precio != null ? Number(prod.herramental_precio) : null;

//   if (herramentalPrecio != null && herramentalPrecio > 0) {
//     await client.query(
//       `INSERT INTO herramental (
//          idsolicitud_producto,
//          herramental_descripcion,
//          herramental_precio
//        ) VALUES ($1, $2, $3)`,
//       [
//         solicitudProductoId,
//         limpiar(prod.herramental_descripcion),
//         herramentalPrecio,
//       ],
//     );
//     subtotal += herramentalPrecio;
//   }

//   const aprobadoValor = tipoDocumento === "pedido" ? true : null;
//   for (const i of indices) {
//     const cant = Number(prod.cantidades?.[i] ?? 0);
//     const precioUnit = Number(prod.precios?.[i] ?? 0);
//     if (cant <= 0 || precioUnit <= 0) continue;

//     const precioTotal = Math.round(cant * precioUnit * 100) / 100;
//     await client.query(
//       `INSERT INTO solicitud_detalle (
//          solicitud_producto_id, cantidad, precio_total,
//          aprobado, kilogramos, modo_cantidad
//        ) VALUES ($1, $2, $3, $4, NULL, 'unidad')`,
//       [solicitudProductoId, cant, precioTotal, aprobadoValor],
//     );
//     subtotal += precioTotal;
//   }

//   return subtotal;
// }

// export function construirProductoPapel(row: any) {
//   const foilNombre = row.foil_color
//     ? `${row.foil_color}${row.foil_codigo ? " " + row.foil_codigo : ""}`
//     : null;

//   return {
//     idsolicitud: row.idsolicitud,
//     idsolicitud_producto: row.idsolicitud_producto,
//     idcotizacion_producto: row.idsolicitud_producto,
//     tipoCotizacion: "papel",
//     tipo_material: "papel",
//     idproducto_papel: row.producto_papel_idproducto_papel,
//     nombre:
//       row.papel_tipo_producto ||
//       `Papel #${row.producto_papel_idproducto_papel}`,
//     descripcion_papel: row.papel_descripcion_papel ?? null,
//     medida: row.papel_medida ?? null,
//     idgrupo_papel: row.grupo_papel_idgrupo_papel ?? null,
//     grupo_descripcion: row.grupo_papel_descripcion ?? null,
//     precio_sugerido:
//       row.papel_precio_sugerido != null
//         ? Number(row.papel_precio_sugerido)
//         : null,
//     tintas: row.tintas_cantidad ?? null,
//     tintasId: row.tintas_idtintas ?? null,
//     pantones: row.pantones || null,
//     tintasDentroId: row.tintas_dentro_idtintas ?? null,
//     tintasDentro: row.tintas_dentro_cantidad ?? 0,
//     pantonesDentro: row.pantones_dentro || "",
//     caras: row.caras_cantidad ?? null,
//     carasId: row.caras_idcaras ?? null,
//     id_asa: row.id_asa ?? null,
//     asa_nombre: row.asa_nombre ?? null,
//     tamano_asa: row.tamano_asa ?? null,
//     idcat_laminado: row.idcat_laminado ?? null,
//     laminado_nombre: row.laminado_nombre ?? null,
//     idfoil: row.idfoil ?? null,
//     foil_nombre: foilNombre,
//     idcat_textura: row.idcat_textura ?? null,
//     textura_nombre: row.textura_nombre ?? null,
//     uv: row.uv ?? false,
//     alto_relieve: row.alto_relieve ?? false,
//     metodo_hojeado: row.metodo_hojeado ?? null,
//     lleva_armado: row.lleva_armado ?? true,
//     maquinaria_seleccionada: row.maquinaria_seleccionada ?? {},
//     observacion: row.observacion ?? null,
//     descripcion: row.descripcion ?? null,
//     herramental_descripcion: row.herramental_descripcion ?? null,
//     herramental_precio:
//       row.herramental_precio != null ? Number(row.herramental_precio) : null,
//     herramental_aprobado: row.herramental_aprobado ?? null,
//     herramental_id: row.id_herramental ?? null,
//     cargo_adicional_descripcion: row.cargo_adicional_descripcion ?? null,
//     cargo_adicional_precio:
//       row.cargo_adicional_precio != null
//         ? Number(row.cargo_adicional_precio)
//         : null,
//     detalles: [],
//     subtotal: 0,
//   };
// }

import { calcularPrecioPapel } from "../../services/producto_papel/calculadorPrecioPapel.service";
import type { ResultadoCantidadPrecioPapel } from "../../types/producto_papel/calculadorPrecioPapel.types";

type TipoDocumento = "cotizacion" | "pedido";
type MaquinariaSeleccionadaPapel = Record<
  string,
  { id: number; nombre?: string | null } | null
>;

const MAQUINARIA_PEDIDO_PAPEL: Record<
  string,
  { pivot: string; catalogo: string; fk: string; tipoMaquina?: string }
> = {
  // NUEVO: el producto puede tener registrada una máquina Hojeadora y una
  // Guillotina por separado (ambas viven en la misma tabla pivote/catálogo,
  // diferenciadas por tipo_maquina). Ya no se deriva "el método" — las dos
  // quedan disponibles siempre en la orden de producción, y cada una usa la
  // máquina que le corresponde por tipo.
  hojeadora: {
    pivot: "maquinaria_hojeado_guillotina",
    catalogo: "cat_hojeado_guillotina",
    fk: "idcat_hojeado_guillotina",
    tipoMaquina: "hojeadora",
  },
  guillotina: {
    pivot: "maquinaria_hojeado_guillotina",
    catalogo: "cat_hojeado_guillotina",
    fk: "idcat_hojeado_guillotina",
    tipoMaquina: "guillotina",
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

export type ReferenciaOpcionPrecioPapel =
  | "precio1"
  | "precio2"
  | "precio3";

export interface OpcionPrecioPapelPayload {
  referencia: ReferenciaOpcionPrecioPapel;
  cantidad: number;
  precio_tablero: number;
  cargo_extra_unitario: number;
  precio_final: number;
}

export interface ProductoPapelPayload {
  tipoCotizacion: "papel";
  idproducto_papel: number;
  nombre: string;
  idgrupo_papel: number | null;
  grupo_descripcion: string | null;
  tintasId: number | null;
  // Cantidades originales usadas por el calculador. Los IDs anteriores se
  // conservan para las relaciones de solicitud_producto.
  tintasFrenteCantidad?: number | null;
  pantones: string | null;
  tintasDentroId: number | null;
  tintasDentroCantidad?: number | null;
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
  laminacion?: boolean;
  hs?: boolean;
  textura?: boolean;
  asa?: boolean;
  uv: boolean;
  alto_relieve: boolean;
  // NUEVO: lleva_armado sigue viniendo de la cotización (specs.lleva_armado
  // en FormularioProductoPapel.tsx). metodo_hojeado y maquinaria_seleccionada
  // ya NO se reciben del frontend — la maquinaria se deriva automáticamente
  // del producto al crear/convertir el pedido (ver fijarMaquinariaPedidoPapel).
  lleva_armado?: boolean | null;
  observacion: string | null;
  descripcion: string | null;
  cantidades: [number, number, number];
  precios: [number, number, number];
  // Solo Expo envía esta estructura. El backend vuelve a ejecutar el
  // calculador y no confía en el precio calculado del navegador.
  opciones_precio?: OpcionPrecioPapelPayload[];
  permitir_sin_tintas?: boolean;
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

const redondear2 = (valor: number): number =>
  Math.round((valor + Number.EPSILON) * 100) / 100;

const numeroNoNegativo = (valor: unknown, campo: string): number => {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero < 0) {
    throw new Error(`${campo} debe ser un número mayor o igual a cero`);
  }
  return redondear2(numero);
};

function normalizarOpcionesPrecioPapel(
  opciones: OpcionPrecioPapelPayload[] | undefined,
): Map<ReferenciaOpcionPrecioPapel, OpcionPrecioPapelPayload> {
  const resultado = new Map<
    ReferenciaOpcionPrecioPapel,
    OpcionPrecioPapelPayload
  >();

  if (opciones == null) return resultado;
  if (!Array.isArray(opciones) || opciones.length > 3) {
    throw new Error("opciones_precio debe contener como máximo tres opciones");
  }

  for (const item of opciones) {
    const referencia = String(item?.referencia || "") as ReferenciaOpcionPrecioPapel;
    if (!["precio1", "precio2", "precio3"].includes(referencia)) {
      throw new Error("Cada opción de precio necesita una referencia válida");
    }
    if (resultado.has(referencia)) {
      throw new Error(`La referencia ${referencia} está repetida`);
    }

    const cantidad = Number(item?.cantidad);
    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      throw new Error(`La cantidad de ${referencia} debe ser un entero mayor que cero`);
    }

    const precioTablero = numeroNoNegativo(
      item?.precio_tablero,
      `precio_tablero de ${referencia}`,
    );
    const cargoExtra = numeroNoNegativo(
      item?.cargo_extra_unitario ?? 0,
      `cargo_extra_unitario de ${referencia}`,
    );
    const precioFinal = numeroNoNegativo(
      item?.precio_final,
      `precio_final de ${referencia}`,
    );
    const esperado = redondear2(precioTablero + cargoExtra);

    if (precioFinal !== esperado) {
      throw new Error(
        `El precio final de ${referencia} no coincide con precio_tablero + cargo_extra_unitario`,
      );
    }

    resultado.set(referencia, {
      referencia,
      cantidad,
      precio_tablero: precioTablero,
      cargo_extra_unitario: cargoExtra,
      precio_final: precioFinal,
    });
  }

  return resultado;
}


async function resolverCarasAutomaticasPapel(
  client: any,
  prod: ProductoPapelPayload,
): Promise<number | null> {
  // Regla comercial para papel:
  // - Sin tintas = sin cara de impresión
  // - Tintas solo al frente = 1 cara
  // - Tintas frente + tintas por dentro = 2 caras
  // Esto evita que cotización, diseño, anticipo/liquidación y producción
  // reciban información contradictoria.
  if (!prod.tintasId && !prod.tintasDentroId) {
    return prod.carasId ?? null;
  }

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
  if (!prod.permitir_sin_tintas && !prod.tintasId) {
    throw new Error(
      `El producto de papel "${prod.nombre}" requiere tintas porque Impresión es obligatoria`,
    );
  }

  for (const [nombre, valor] of [
    ["tintasFrenteCantidad", prod.tintasFrenteCantidad],
    ["tintasDentroCantidad", prod.tintasDentroCantidad],
  ] as const) {
    if (valor == null) continue;
    const cantidad = Number(valor);
    if (!Number.isInteger(cantidad) || cantidad < 0 || cantidad > 6) {
      throw new Error(`${nombre} debe ser un entero entre 0 y 6`);
    }
  }
}

export async function validarMaquinariaSeleccionadaPapel(
  client: any,
  idproductoPapel: number,
  seleccion: MaquinariaSeleccionadaPapel | null | undefined,
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

    const tipoMaquinaFiltro = config.tipoMaquina;

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
): Promise<MaquinariaSeleccionadaPapel> {
  const resultado = await validarMaquinariaSeleccionadaPapel(
    client,
    idproductoPapel,
    seleccion,
  );

  for (const key of [...new Set(clavesRequeridas)]) {
    const config = MAQUINARIA_PEDIDO_PAPEL[key];
    if (!config) continue;

    const condicionTipo = config.tipoMaquina ? `AND c.tipo_maquina = $2` : "";
    const valores = config.tipoMaquina
      ? [idproductoPapel, config.tipoMaquina]
      : [idproductoPapel];

    const { rows } = await client.query(
      `SELECT EXISTS (
         SELECT 1
         FROM ${config.pivot} m
         ${config.tipoMaquina ? `JOIN ${config.catalogo} c ON c.${config.fk} = m.${config.fk}` : ""}
         WHERE m.idproducto_papel = $1
         ${condicionTipo}
       ) AS tiene_opciones`,
      valores,
    );

    if (rows[0]?.tiene_opciones === true && !resultado[key]) {
      throw new Error(`Selecciona la máquina para el proceso "${key}"`);
    }
  }

  return resultado;
}

// NUEVO: la máquina de cada proceso ya no se elige por pedido — es la que
// quedó registrada como default del producto desde su alta
// (FormularioProductoPapelAlta, una sola máquina por proceso gracias al
// UNIQUE(idproducto_papel) en cada tabla maquinaria_*). Esta función la lee
// directo de esas tablas, sin necesitar nada del frontend.
export function clavesMaquinariaRequeridasPapel(
  producto: {
    idcat_laminado?: number | null;
    uv?: boolean | null;
    idfoil?: number | null;
    alto_relieve?: boolean | null;
    idcat_textura?: number | null;
  },
  llevaArmado: boolean,
): string[] {
  return [
    "hojeadora",
    "guillotina",
    "impresora",
    ...(producto.idcat_laminado != null ? ["laminado_maquina"] : []),
    ...(producto.uv === true ? ["uv"] : []),
    ...(producto.idfoil != null || producto.alto_relieve === true
      ? ["hs_ar"]
      : []),
    ...(producto.idcat_textura != null ? ["texturizadora"] : []),
    "suaje_maquina",
    ...(llevaArmado ? ["armado"] : []),
    "empaque_maquina",
  ];
}

async function obtenerMaquinariaDefaultPapel(
  client: any,
  idproductoPapel: number,
  claves: string[],
): Promise<MaquinariaSeleccionadaPapel> {
  const resultado: MaquinariaSeleccionadaPapel = {};

  for (const key of [...new Set(claves)]) {
    const config = MAQUINARIA_PEDIDO_PAPEL[key];
    if (!config) continue;

    const condicionTipo = config.tipoMaquina ? `AND c.tipo_maquina = $2` : "";
    const valores = config.tipoMaquina
      ? [idproductoPapel, config.tipoMaquina]
      : [idproductoPapel];

    const { rows } = await client.query(
      `SELECT m.${config.fk} AS id, c.nombre
         FROM ${config.pivot} m
         JOIN ${config.catalogo} c ON c.${config.fk} = m.${config.fk}
        WHERE m.idproducto_papel = $1
          ${condicionTipo}
        LIMIT 1`,
      valores,
    );

    resultado[key] = rows[0]
      ? { id: Number(rows[0].id), nombre: rows[0].nombre }
      : null;
  }

  return resultado;
}

// NUEVO: reemplaza el paso manual de "Configurar maquinaria". Lee la
// máquina default de cada proceso requerido directo de las tablas
// maquinaria_* del producto y la guarda en el pedido. Ya NO exige que el
// producto tenga registrada la máquina de cada proceso — si falta alguna,
// simplemente se guarda como pendiente (null) y se asigna después en
// producción, en vez de bloquear la creación/conversión del pedido.
export async function fijarMaquinariaPedidoPapel(
  client: any,
  idproductoPapel: number,
  idsolicitudProductoPapel: number,
  claves: string[],
  _nombreProducto: string,
): Promise<void> {
  const seleccion = await obtenerMaquinariaDefaultPapel(
    client,
    idproductoPapel,
    claves,
  );

  await guardarMaquinariaSeleccionadaPapel(
    client,
    idsolicitudProductoPapel,
    seleccion,
  );
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

  const opcionesPrecio = normalizarOpcionesPrecioPapel(prod.opciones_precio);
  const resultadosCalculo = new Map<
    ReferenciaOpcionPrecioPapel,
    ResultadoCantidadPrecioPapel
  >();

  if (opcionesPrecio.size > 0) {
    if (!prod.idgrupo_papel) {
      throw new Error(
        `El producto de papel "${prod.nombre}" requiere idgrupo_papel para guardar la trazabilidad del cálculo`,
      );
    }

    const calculo = await calcularPrecioPapel(
      {
        idproducto_papel: prod.idproducto_papel,
        idgrupo_papel: prod.idgrupo_papel,
        cantidades: Array.from(opcionesPrecio.values()).map((opcion) => ({
          referencia: opcion.referencia,
          cantidad: opcion.cantidad,
        })),
        acabados: {
          tintas_frente: Math.max(
            0,
            Number(prod.tintasFrenteCantidad ?? 0) || 0,
          ),
          tintas_dentro: Math.max(
            0,
            Number(prod.tintasDentroCantidad ?? 0) || 0,
          ),
          laminado: prod.laminacion ?? prod.idcat_laminado != null,
          hot_stamping: prod.hs ?? prod.idfoil != null,
          alto_relieve: prod.alto_relieve === true,
          textura: prod.textura ?? prod.idcat_textura != null,
          uv: prod.uv === true,
          asa: prod.asa ?? prod.id_asa != null,
        },
      },
      client,
    );

    for (const resultado of calculo.resultados) {
      const referencia = resultado.referencia as ReferenciaOpcionPrecioPapel;
      resultadosCalculo.set(referencia, resultado);
    }
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

  // NUEVO: metodo_hojeado ya no se guarda — Hojeado/Guillotina se decide
  // físicamente en producción, no en el sistema. lleva_armado sí se sigue
  // capturando (viene de specs.lleva_armado en FormularioProductoPapel.tsx).
  const cargoAdicionalPrecio =
    prod.cargo_adicional_precio != null
      ? Number(prod.cargo_adicional_precio)
      : null;

  const { rows: sppRows } = await client.query(
    `INSERT INTO solicitud_producto_papel (
       idsolicitud_producto, id_asa, tamano_asa,
       idcat_laminado, idfoil, idcat_textura,
       uv, alto_relieve, tintas_dentro_idtintas, pantones_dentro,
       cargo_adicional_descripcion, cargo_adicional_precio,
       lleva_armado
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12, $13
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
      prod.lleva_armado ?? null,
    ],
  );

  const idsolicitudProductoPapel = sppRows[0].idsolicitud_producto_papel;

  // NUEVO: si es un pedido (directo o recién convertido), la maquinaria de
  // cada proceso se fija de inmediato leyendo el default registrado en el
  // producto — ya no hay paso manual de "Configurar maquinaria".
  if (tipoDocumento === "pedido") {
    const llevaArmado = prod.lleva_armado === true;
    await fijarMaquinariaPedidoPapel(
      client,
      prod.idproducto_papel,
      idsolicitudProductoPapel,
      clavesMaquinariaRequeridasPapel(prod, llevaArmado),
      prod.nombre,
    );
  }

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
  const referenciasPorIndice: ReferenciaOpcionPrecioPapel[] = [
    "precio1",
    "precio2",
    "precio3",
  ];

  for (const i of indices) {
    const referencia = referenciasPorIndice[i];
    const opcion = opcionesPrecio.get(referencia);
    const cant = Number(prod.cantidades?.[i] ?? 0);
    const precioUnit = redondear2(Number(prod.precios?.[i] ?? 0));

    if (cant <= 0 || precioUnit <= 0) {
      if (opcion) {
        throw new Error(
          `${referencia} contiene trazabilidad, pero no tiene cantidad y precio final válidos`,
        );
      }
      continue;
    }

    if (opcionesPrecio.size > 0 && !opcion) {
      throw new Error(
        `${referencia} tiene cantidad y precio, pero no incluye su trazabilidad en opciones_precio`,
      );
    }

    if (opcion) {
      if (opcion.cantidad !== cant) {
        throw new Error(
          `La cantidad de ${referencia} no coincide entre cantidades y opciones_precio`,
        );
      }
      if (opcion.precio_final !== precioUnit) {
        throw new Error(
          `El precio final de ${referencia} no coincide entre precios y opciones_precio`,
        );
      }
    }

    const precioTotal = redondear2(cant * precioUnit);
    const { rows: detalleRows } = await client.query(
      `INSERT INTO solicitud_detalle (
         solicitud_producto_id,
         cantidad,
         precio_total,
         precio_unitario,
         aprobado,
         kilogramos,
         modo_cantidad
       ) VALUES ($1, $2, $3, $4, $5, NULL, 'unidad')
       RETURNING idsolicitud_detalle`,
      [
        solicitudProductoId,
        cant,
        precioTotal,
        precioUnit,
        aprobadoValor,
      ],
    );

    if (opcion) {
      const resultado = resultadosCalculo.get(referencia);
      if (!resultado) {
        throw new Error(
          `No se obtuvo el cálculo del servidor para ${referencia}`,
        );
      }

      const snapshot = {
        version: 1,
        producto: {
          idproducto_papel: prod.idproducto_papel,
          idgrupo_papel: prod.idgrupo_papel,
        },
        acabados_solicitados: {
          tintas_frente: Number(prod.tintasFrenteCantidad ?? 0) || 0,
          tintas_dentro: Number(prod.tintasDentroCantidad ?? 0) || 0,
          laminado: prod.laminacion ?? prod.idcat_laminado != null,
          hot_stamping: prod.hs ?? prod.idfoil != null,
          alto_relieve: prod.alto_relieve === true,
          textura: prod.textura ?? prod.idcat_textura != null,
          uv: prod.uv === true,
          asa: prod.asa ?? prod.id_asa != null,
        },
        resultado,
      };

      // La restricción de la tabla exige escala cuando se conserva un precio
      // calculado. Si no hay escalas activas, se guarda NULL como referencia
      // oficial y el resultado provisional permanece dentro del snapshot.
      const precioCalculadoPersistido = resultado.escala_aplicada
        ? redondear2(resultado.precio_calculado)
        : null;

      await client.query(
        `INSERT INTO solicitud_detalle_calculo (
           solicitud_detalle_id,
           idcat_escala_costo,
           escala_cantidad,
           precio_base_unitario,
           incremento_acabados_unitario,
           incremento_laminado_unitario,
           precio_calculado_unitario,
           precio_tablero_unitario,
           cargo_extra_unitario,
           calculo_snapshot
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
         )`,
        [
          detalleRows[0].idsolicitud_detalle,
          resultado.escala_aplicada?.id ?? null,
          resultado.escala_aplicada?.cantidad ?? null,
          redondear2(resultado.precio_base),
          redondear2(resultado.incremento_acabados),
          redondear2(resultado.incremento_laminado),
          precioCalculadoPersistido,
          opcion.precio_tablero,
          opcion.cargo_extra_unitario,
          JSON.stringify(snapshot),
        ],
      );
    }

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