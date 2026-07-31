// src/controllers/expo/expo.controller.ts
import { Request, Response } from "express";
import { pool } from "../../config/db";
import { getPresignedUrl } from "../../config/multer";
import { clonarProductoPapelSistemaAExpo } from "../../services/expo/clonarProductoPapelExpo.service";
import { insertarProductoPapel } from "../cotizaciones/cotizacionPapel.helper";
import type { ProductoPapelPayload } from "../cotizaciones/cotizacionPapel.helper";
import {
  listarCatalogoPapelPropio,
  listarCatalogoPapelSistema,
  obtenerProductoPapelCatalogoExpoPorId,
} from "../../services/expo/catalogoPapelExpo.service";
import { calcularTotalesVenta } from "../../services/ventas/totalesVenta.service";
import {
  type Moneda,
  validarMonedaYTipoCambio,
} from "../../utils/moneda.utils";

const ESTADO = { PENDIENTE: 1, EN_PROCESO: 2, APROBADO: 3, RECHAZADO: 4 } as const;

// ─── Helpers de folio ─────────────────────────────────────────────────────────

async function obtenerSiguienteFolioCotizacion(client: any): Promise<string> {
  // La función de PostgreSQL usa una secuencia anual y devuelve el folio
  // definitivo. nextval() es atómico: dos vendedores nunca reciben el mismo.
  const { rows } = await client.query(
    `SELECT public.generar_folio_cotizacion() AS folio`,
  );
  return String(rows[0].folio);
}

async function obtenerSiguienteFolioPedido(client: any): Promise<string> {
  // Se aplica el mismo mecanismo a los pedidos para evitar colisiones al
  // aprobar cotizaciones simultáneamente.
  const { rows } = await client.query(
    `SELECT public.generar_folio_pedido() AS folio`,
  );
  return String(rows[0].folio);
}

async function generarFolioOrdenDiseno(client: any): Promise<string> {
  const yy = new Date().getFullYear().toString().slice(-2);
  const { rows } = await client.query(`
    SELECT COALESCE(MAX(CAST(SUBSTRING(no_orden_diseno FROM 'OD${yy}(\\d+)') AS INTEGER)),0)+1 AS siguiente
    FROM orden_diseno WHERE no_orden_diseno LIKE 'OD${yy}%'`);
  return `OD${yy}${String(rows[0].siguiente).padStart(3, "0")}`;
}

async function generarIdentificador(client: any): Promise<string> {
  const { rows } = await client.query(`
    SELECT identificar FROM clientes WHERE identificar ~ '^[0-9]+$'
    ORDER BY CAST(identificar AS INTEGER) DESC LIMIT 1`);
  let next = 600;
  if (rows.length > 0) {
    const last = parseInt(rows[0].identificar, 10);
    if (!isNaN(last) && last >= 600) next = last + 1;
  }
  return String(next);
}

async function crearVentaYDiseno(
  client: any, solicitudId: number, folioPedido: string,
  subtotal: number, sinIva = false,
  moneda: Moneda = "MXN", tipoCambio: number | null = null,
): Promise<void> {
  const { iva, total, anticipo } = calcularTotalesVenta({ subtotal, sinIva });
  const { rows: vr } = await client.query(
    `INSERT INTO ventas (solicitud_idsolicitud,estado_administrativo_cat_idestado_administrativo_cat,
       subtotal,iva,total,anticipo,saldo,abono,moneda,tipo_cambio,fecha_creacion)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING idventas`,
    [solicitudId, ESTADO.PENDIENTE, subtotal, iva, total, anticipo, total, 0, moneda, tipoCambio]
  );
  console.log(`✅ [EXPO] Venta #${vr[0].idventas}`);
  const { rows: dr } = await client.query(
    `INSERT INTO diseno (solicitud_idsolicitud,estado_administrativo_cat_idestado_administrativo_cat,fecha)
     VALUES ($1,$2,NOW()) RETURNING iddiseno`,
    [solicitudId, ESTADO.PENDIENTE]
  );
  const disenoId = dr[0].iddiseno;
  const { rows: prods } = await client.query(
    `SELECT idsolicitud_producto FROM solicitud_producto WHERE solicitud_idsolicitud=$1`, [solicitudId]
  );
  for (const prod of prods) {
    await client.query(
      `INSERT INTO diseno_producto (diseno_iddiseno,solicitud_producto_idsolicitud_producto,
         estado_administrativo_cat_idestado_administrativo_cat,fecha)
       VALUES ($1,$2,$3,NOW())`,
      [disenoId, prod.idsolicitud_producto, ESTADO.PENDIENTE]
    );
    const folioOD = await generarFolioOrdenDiseno(client);
    await client.query(
      `INSERT INTO orden_diseno (solicitud_producto_id,no_pedido,no_orden_diseno,estado,version_actual)
       VALUES ($1,$2,$3,'en_revision',1)`,
      [prod.idsolicitud_producto, folioPedido, folioOD]
    );
  }
  console.log(`✅ [EXPO] Diseño #${disenoId} con ${prods.length} producto(s)`);
}

// ─── Resolver cantidad de tintas (0-6, o null) → id real ────────────────────
// El frontend de Expo nunca conoce ni maneja ids de tintas — solo maneja
// números planos. La cantidad 0 significa “sin tintas”: no se cobra y la FK
// se guarda como NULL. Solo las cantidades positivas se traducen al id real
// de la tabla `tintas`.
async function resolverIdTintasPorCantidad(
  client: any, cantidad: number | null | undefined
): Promise<number | null> {
  if (cantidad === null || cantidad === undefined) return null;

  const cantidadNumero = Number(cantidad);
  if (!Number.isInteger(cantidadNumero) || cantidadNumero < 0) return null;
  if (cantidadNumero === 0) return null;

  const { rows } = await client.query(
    `SELECT idtintas
     FROM tintas
     WHERE cantidad = $1
     ORDER BY idtintas
     LIMIT 1`,
    [cantidadNumero],
  );

  return rows[0]?.idtintas ?? null;
}


const numeroNullable = (valor: unknown): number | null => {
  if (valor === null || valor === undefined || valor === "") return null;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
};

async function resolverIdTamanoProducto(
  client: any,
  valor: unknown,
): Promise<number | null> {
  if (valor === null || valor === undefined || valor === "") return null;

  const numero = Number(valor);
  if (Number.isInteger(numero) && numero > 0) {
    const { rows } = await client.query(
      `SELECT idcat_tamano_producto
       FROM cat_tamano_producto
       WHERE idcat_tamano_producto = $1
         AND activo = TRUE
       LIMIT 1`,
      [numero],
    );
    return rows[0]?.idcat_tamano_producto ?? null;
  }

  const texto = String(valor).trim();
  if (!texto) return null;

  const normalizado = texto
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

  const { rows } = await client.query(
    `SELECT idcat_tamano_producto
     FROM cat_tamano_producto
     WHERE activo = TRUE
       AND (
         LOWER(nombre) = LOWER($1)
         OR LOWER(clave) = LOWER($1)
         OR LOWER(REGEXP_REPLACE(nombre, '[[:space:]_-]+', '', 'g')) = $2
         OR LOWER(REGEXP_REPLACE(clave, '[[:space:]_-]+', '', 'g')) = $2
       )
     ORDER BY idcat_tamano_producto
     LIMIT 1`,
    [texto, normalizado],
  );

  return rows[0]?.idcat_tamano_producto ?? null;
}

async function guardarPrecioBaseGrupoPapel(
  client: any,
  datos: {
    idproductoPapel: number;
    idgrupoPapel?: number | null;
    precioBase: number | null;
    idusuario?: number | null;
  },
): Promise<number> {
  const { idproductoPapel, precioBase, idusuario = null } = datos;
  let idgrupoPapel = datos.idgrupoPapel ?? null;

  if (idgrupoPapel) {
    const { rows } = await client.query(
      `UPDATE grupo_papel
       SET precio_sugerido = $1,
           actualizado_por = COALESCE($2, actualizado_por),
           updated_at = NOW()
       WHERE idgrupo_papel = $3
         AND idproducto_papel = $4
       RETURNING idgrupo_papel`,
      [precioBase, idusuario, idgrupoPapel, idproductoPapel],
    );

    if (rows.length) return Number(rows[0].idgrupo_papel);
    idgrupoPapel = null;
  }

  const { rows: existentes } = await client.query(
    `SELECT idgrupo_papel
     FROM grupo_papel
     WHERE idproducto_papel = $1
     ORDER BY orden, idgrupo_papel
     LIMIT 1`,
    [idproductoPapel],
  );

  if (existentes.length) {
    idgrupoPapel = Number(existentes[0].idgrupo_papel);
    await client.query(
      `UPDATE grupo_papel
       SET precio_sugerido = $1,
           actualizado_por = COALESCE($2, actualizado_por),
           updated_at = NOW()
       WHERE idgrupo_papel = $3`,
      [precioBase, idusuario, idgrupoPapel],
    );
    return idgrupoPapel;
  }

  const { rows: creados } = await client.query(
    `INSERT INTO grupo_papel (
       idproducto_papel,
       precio_sugerido,
       orden,
       creado_por,
       actualizado_por
     )
     VALUES ($1,$2,1,$3,$3)
     RETURNING idgrupo_papel`,
    [idproductoPapel, precioBase, idusuario],
  );

  return Number(creados[0].idgrupo_papel);
}

// ═══════════════════════════════════════════════════════════
// CATÁLOGO PROPIO
// ═══════════════════════════════════════════════════════════

// ─── Backfill de imagen Expo ⇄ Sistema ─────────────────────────────────────
async function buscarImagenSistema(
  client: any,
  opts: { idproducto_papel?: number | null; idconfiguracion_plastico?: number | null }
): Promise<number | null> {
  if (opts.idproducto_papel) {
    const { rows } = await client.query(
      `SELECT id_archivo FROM archivos
       WHERE idproducto_papel = $1 AND categoria = 'imagen-suaje-papel'
       ORDER BY id_archivo DESC LIMIT 1`,
      [opts.idproducto_papel]
    );
    return rows[0]?.id_archivo ?? null;
  }
  if (opts.idconfiguracion_plastico) {
    const { rows } = await client.query(
      `SELECT id_archivo FROM archivos
       WHERE idconfiguracion_plastico = $1 AND categoria = 'imagen-producto-plastico'
       ORDER BY id_archivo DESC LIMIT 1`,
      [opts.idconfiguracion_plastico]
    );
    return rows[0]?.id_archivo ?? null;
  }
  return null;
}

function construirUrlArchivoEstable(id_archivo: number): string | null {
  const base = process.env.API_BASE_URL || process.env.BACKEND_URL;
  if (!base) {
    console.warn("⚠️ [EXPO] Falta API_BASE_URL/BACKEND_URL — no se puede hacer backfill de imagen");
    return null;
  }
  return `${base.replace(/\/$/, "")}/archivos/${id_archivo}/ver`;
}

// "Catálogo Expo" ya no vive en su propia tabla — ahora son simplemente los
// productos de producto_papel/configuracion_plastico con origen_expo=true.
//
// tintas_frente_default / tintas_dentro_default se regresan como CANTIDAD
// (join a `tintas`), no como id — el frontend de Expo nunca debe manejar
// ids de tintas directamente. Sin pantones.
export const getCatalogoPropio = async (req: Request, res: Response) => {
  try {
    const papelRowsPromise = listarCatalogoPapelPropio();

    const { rows: plasticoRows } = await pool.query(`
      SELECT cp.idconfiguracion_plastico AS idcatalogo_expo, 'plastico' AS categoria,
        COALESCE(
  NULLIF(cp.descripcion, ''),
  NULLIF(cp.identificador, ''),
  tpp.material_plastico_producto,
  cp.medida
) AS nombre,
cp.descripcion,
cp.medida,
cp.altura,
cp.ancho,
cp.fuelle_fondo,
cp.fuelle_latiz AS fuelle_lateral_iz,
cp.fuelle_latde AS fuelle_lateral_de,
cp.refuerzo,
cp.por_kilo,
mp.tipo_material AS material,
        COALESCE(cal.calibre_bopp, cal.calibre)::text AS calibre,
        false AS laminacion, NULL::text AS tipo_laminado,
        false AS hs, NULL::text AS tipo_hs, false AS ar, false AS textura, NULL::text AS tipo_textura,
        false AS uv,
        (pad.id_color_default IS NOT NULL) AS asa, ca.color AS tipo_asa,
        NULL::text AS otro, NULL::text AS tintas, pad.pigmento_default AS pigmento,
        tf.cantidad AS tintas_frente_default,
        cp.precio_500, cp.precio_1000, cp.precio_3000,
        tpp.material_plastico_producto AS tipo_producto,
        img_prev.public_id AS imagen_public_id
      FROM configuracion_plastico cp
      LEFT JOIN tipo_producto_plastico tpp ON tpp.idtipo_producto_plastico=cp.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN material_plastico mp ON mp.idmaterial_plastico=cp.material_plastico_plastico_idmaterial_plastico
      LEFT JOIN calibre cal ON cal.idcalibre=cp.calibre_idcalibre
      LEFT JOIN producto_acabado_default pad ON pad.idconfiguracion_plastico=cp.idconfiguracion_plastico
      LEFT JOIN color_asa ca ON ca.id_color=pad.id_color_default
      LEFT JOIN tintas tf ON tf.idtintas = pad.idtintas_frente_default
      LEFT JOIN LATERAL (
        SELECT public_id FROM archivos WHERE idconfiguracion_plastico=cp.idconfiguracion_plastico
          AND categoria='imagen-producto-plastico' ORDER BY id_archivo DESC LIMIT 1
      ) img_prev ON true
      WHERE cp.origen_expo = true AND cp.activo = true
      ORDER BY cp.idconfiguracion_plastico DESC`);

    const [papelRows, plasticoConUrls] = await Promise.all([
      papelRowsPromise,
      Promise.all(plasticoRows.map(async (row) => {
        const { imagen_public_id, ...rest } = row;
        return {
          ...rest,
          imagen_url: imagen_public_id
            ? await getPresignedUrl(imagen_public_id)
            : null,
        };
      })),
    ]);

    return res.json([...papelRows, ...plasticoConUrls]);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
};

// Helper compartido: arma UN producto ya resuelto (post crear/editar).
async function obtenerProductoCatalogoExpoPorId(
  id: number, categoria: "papel" | "carton" | "plastico"
) {
  if (categoria === "plastico") {
    const { rows } = await pool.query(`
      SELECT cp.idconfiguracion_plastico AS idcatalogo_expo, 'plastico' AS categoria,
        COALESCE(
  NULLIF(cp.descripcion, ''),
  NULLIF(cp.identificador, ''),
  tpp.material_plastico_producto,
  cp.medida
) AS nombre,
cp.descripcion,
cp.medida,
cp.altura,
cp.ancho,
cp.fuelle_fondo,
cp.fuelle_latiz AS fuelle_lateral_iz,
cp.fuelle_latde AS fuelle_lateral_de,
cp.refuerzo,
cp.por_kilo,
mp.tipo_material AS material,
        COALESCE(cal.calibre_bopp, cal.calibre)::text AS calibre,
        false AS laminacion, NULL::text AS tipo_laminado,
        false AS hs, NULL::text AS tipo_hs, false AS ar, false AS textura, NULL::text AS tipo_textura,
        false AS uv,
        (pad.id_color_default IS NOT NULL) AS asa, ca.color AS tipo_asa,
        NULL::text AS otro, NULL::text AS tintas, pad.pigmento_default AS pigmento,
        tf.cantidad AS tintas_frente_default,
        cp.precio_500, cp.precio_1000, cp.precio_3000,
        tpp.material_plastico_producto AS tipo_producto,
        img_prev.public_id AS imagen_public_id
      FROM configuracion_plastico cp
      LEFT JOIN tipo_producto_plastico tpp ON tpp.idtipo_producto_plastico=cp.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN material_plastico mp ON mp.idmaterial_plastico=cp.material_plastico_plastico_idmaterial_plastico
      LEFT JOIN calibre cal ON cal.idcalibre=cp.calibre_idcalibre
      LEFT JOIN producto_acabado_default pad ON pad.idconfiguracion_plastico=cp.idconfiguracion_plastico
      LEFT JOIN color_asa ca ON ca.id_color=pad.id_color_default
      LEFT JOIN tintas tf ON tf.idtintas = pad.idtintas_frente_default
      LEFT JOIN LATERAL (
        SELECT public_id FROM archivos WHERE idconfiguracion_plastico=cp.idconfiguracion_plastico
          AND categoria='imagen-producto-plastico' ORDER BY id_archivo DESC LIMIT 1
      ) img_prev ON true
      WHERE cp.idconfiguracion_plastico = $1`, [id]);
    if (!rows.length) return null;
    const { imagen_public_id, ...rest } = rows[0];
    return { ...rest, imagen_url: imagen_public_id ? await getPresignedUrl(imagen_public_id) : null };
  }

  return obtenerProductoPapelCatalogoExpoPorId(id);
}

// Asegura que el acabado elegido como predeterminado también forme parte de
// las opciones permitidas del producto. Las opciones se guardan en
// acabados_papel; el default exacto se guarda en producto_acabado_default.
async function aplicarAcabadosPapel(
  client: any,
  idproducto_papel: number,
  datos: {
    idcat_laminado?: number | null;
    idcat_tipo_asa?: number | null;
    tipo_laminado?: string | null;
    tipo_asa?: string | null;
  }
) {
  let idcatLaminado = numeroNullable(datos.idcat_laminado);
  let idcatTipoAsa = numeroNullable(datos.idcat_tipo_asa);

  if (!idcatLaminado && datos.tipo_laminado) {
    const { rows } = await client.query(
      `SELECT idcat_laminado
         FROM cat_laminado
        WHERE LOWER(nombre) = LOWER($1)
           OR LOWER(nombre) LIKE $2
        ORDER BY CASE WHEN LOWER(nombre) = LOWER($1) THEN 0 ELSE 1 END
        LIMIT 1`,
      [datos.tipo_laminado.trim(), `%${datos.tipo_laminado.trim().toLowerCase()}%`],
    );
    idcatLaminado = rows[0]?.idcat_laminado ?? null;
  }

  if (!idcatTipoAsa && datos.tipo_asa) {
    const { rows } = await client.query(
      `SELECT idcat_tipo_asa
         FROM cat_tipo_asa
        WHERE LOWER(nombre) = LOWER($1)
           OR LOWER(nombre) LIKE $2
        ORDER BY CASE WHEN LOWER(nombre) = LOWER($1) THEN 0 ELSE 1 END
        LIMIT 1`,
      [datos.tipo_asa.trim(), `%${datos.tipo_asa.trim().toLowerCase()}%`],
    );
    idcatTipoAsa = rows[0]?.idcat_tipo_asa ?? null;
  }

  if (!idcatLaminado && !idcatTipoAsa) return;

  const { rows: acabRows } = await client.query(
    `SELECT idacabados_papel
       FROM acabados_papel
      WHERE idproducto_papel = $1
      ORDER BY idacabados_papel
      LIMIT 1`,
    [idproducto_papel],
  );

  let idacabadosPapel: number;
  if (acabRows.length) {
    idacabadosPapel = Number(acabRows[0].idacabados_papel);
  } else {
    const { rows: nuevo } = await client.query(
      `INSERT INTO acabados_papel (idproducto_papel)
       VALUES ($1)
       RETURNING idacabados_papel`,
      [idproducto_papel],
    );
    idacabadosPapel = Number(nuevo[0].idacabados_papel);
  }

  if (idcatLaminado) {
    await client.query(
      `INSERT INTO acabados_laminado (idacabados_papel, idcat_laminado)
       VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [idacabadosPapel, idcatLaminado],
    );
  }

  if (idcatTipoAsa) {
    await client.query(
      `INSERT INTO acabados_asas (idacabados_papel, idcat_tipo_asa)
       VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [idacabadosPapel, idcatTipoAsa],
    );
  }
}

// Acabados seleccionados en Expo. Estos son los valores que aparecerán
// inicialmente en el cotizador; no sustituyen las opciones permitidas copiadas
// desde el producto del sistema.
async function guardarAcabadosDefaultPapel(
  client: any,
  idproducto_papel: number,
  datos: {
    idcatLaminado?: number | null;
    idcatTipoAsa?: number | null;
    idfoil?: number | null;
    idcatTextura?: number | null;
    tipo_laminado?: string | null;
    tipo_asa?: string | null;
    tipo_hs?: string | null;
    tipo_textura?: string | null;
    uv?: boolean;
    ar?: boolean;
    tintasFrenteCantidad?: number | null;
    tintasDentroCantidad?: number | null;
  }
) {
  let idcatLaminado = numeroNullable(datos.idcatLaminado);
  let idcatTipoAsa = numeroNullable(datos.idcatTipoAsa);
  let idfoil = numeroNullable(datos.idfoil);
  let idcatTextura = numeroNullable(datos.idcatTextura);

  if (!idcatLaminado && datos.tipo_laminado) {
    const { rows } = await client.query(
      `SELECT idcat_laminado FROM cat_laminado
       WHERE LOWER(nombre) = LOWER($1) OR LOWER(nombre) LIKE $2
       ORDER BY CASE WHEN LOWER(nombre) = LOWER($1) THEN 0 ELSE 1 END
       LIMIT 1`,
      [datos.tipo_laminado.trim(), `%${datos.tipo_laminado.trim().toLowerCase()}%`],
    );
    idcatLaminado = rows[0]?.idcat_laminado ?? null;
  }

  if (!idcatTipoAsa && datos.tipo_asa) {
    const { rows } = await client.query(
      `SELECT idcat_tipo_asa FROM cat_tipo_asa
       WHERE LOWER(nombre) = LOWER($1) OR LOWER(nombre) LIKE $2
       ORDER BY CASE WHEN LOWER(nombre) = LOWER($1) THEN 0 ELSE 1 END
       LIMIT 1`,
      [datos.tipo_asa.trim(), `%${datos.tipo_asa.trim().toLowerCase()}%`],
    );
    idcatTipoAsa = rows[0]?.idcat_tipo_asa ?? null;
  }

  if (!idfoil && datos.tipo_hs) {
    const termino = datos.tipo_hs.toLowerCase().trim();
    const palabras = termino.split(/\s+/);
    const ultima = palabras[palabras.length - 1];
    const { rows } = await client.query(
      `SELECT idfoil
         FROM foil
        WHERE LOWER(colorfoil) LIKE $1 OR LOWER(codigofoil) LIKE $2
        LIMIT 1`,
      [`%${termino}%`, `%${ultima}%`],
    );
    idfoil = rows[0]?.idfoil ?? null;
  }

  if (!idcatTextura && datos.tipo_textura) {
    const { rows } = await client.query(
      `SELECT idcat_textura
         FROM cat_textura
        WHERE LOWER(nombre) = LOWER($1) OR LOWER(nombre) LIKE $2
        ORDER BY CASE WHEN LOWER(nombre) = LOWER($1) THEN 0 ELSE 1 END
        LIMIT 1`,
      [datos.tipo_textura.trim(), `%${datos.tipo_textura.trim().toLowerCase()}%`],
    );
    idcatTextura = rows[0]?.idcat_textura ?? null;
  }

  const idTintasFrente = await resolverIdTintasPorCantidad(
    client,
    datos.tintasFrenteCantidad,
  );
  const idTintasDentro = await resolverIdTintasPorCantidad(
    client,
    datos.tintasDentroCantidad,
  );

  await client.query(
    `INSERT INTO producto_acabado_default (
       idproducto_papel,
       idcat_laminado_default,
       idcat_tipo_asa_default,
       idfoil_default,
       idcat_textura_default,
       uv_default,
       alto_relieve_default,
       idtintas_frente_default,
       idtintas_dentro_default
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (idproducto_papel) DO UPDATE SET
       idcat_laminado_default = EXCLUDED.idcat_laminado_default,
       idcat_tipo_asa_default = EXCLUDED.idcat_tipo_asa_default,
       idfoil_default = EXCLUDED.idfoil_default,
       idcat_textura_default = EXCLUDED.idcat_textura_default,
       uv_default = EXCLUDED.uv_default,
       alto_relieve_default = EXCLUDED.alto_relieve_default,
       idtintas_frente_default = EXCLUDED.idtintas_frente_default,
       idtintas_dentro_default = EXCLUDED.idtintas_dentro_default`,
    [
      idproducto_papel,
      idcatLaminado,
      idcatTipoAsa,
      idfoil,
      idcatTextura,
      datos.uv === true,
      datos.ar === true,
      idTintasFrente,
      idTintasDentro,
    ],
  );
}

async function guardarAcabadosDefaultPlastico(
  client: any, idconfiguracion_plastico: number,
  datos: { pigmento?: string | null; tipo_asa?: string | null; tintasFrenteCantidad?: number | null }
) {
  let idColor: number | null = null;
  if (datos.tipo_asa) {
    const { rows } = await client.query(
      `SELECT id_color FROM color_asa WHERE LOWER(color) LIKE $1 LIMIT 1`,
      [`%${datos.tipo_asa.toLowerCase()}%`]
    );
    idColor = rows[0]?.id_color ?? null;
  }

  const idTintasFrente = await resolverIdTintasPorCantidad(client, datos.tintasFrenteCantidad);

  await client.query(`
    INSERT INTO producto_acabado_default (idconfiguracion_plastico, pigmento_default, id_color_default, idtintas_frente_default)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (idconfiguracion_plastico) DO UPDATE SET
      pigmento_default        = COALESCE(EXCLUDED.pigmento_default, producto_acabado_default.pigmento_default),
      id_color_default        = COALESCE(EXCLUDED.id_color_default, producto_acabado_default.id_color_default),
      idtintas_frente_default = COALESCE(EXCLUDED.idtintas_frente_default, producto_acabado_default.idtintas_frente_default)`,
    [idconfiguracion_plastico, datos.pigmento || null, idColor, idTintasFrente]
  );
}

// tintas_frente_default / tintas_dentro_default como CANTIDAD (join a
// `tintas`). Sin pantones.
export const getCatalogoSistema = async (req: Request, res: Response) => {
  try {
    const papelPromise = listarCatalogoPapelSistema();
    const { rows: plasticoRaw } = await pool.query(`
      SELECT cp.idconfiguracion_plastico AS id,'plastico' AS categoria,
        tpp.material_plastico_producto AS nombre, cp.medida,
        mp.tipo_material AS material, cal.calibre, cal.calibre_bopp,
        cp.altura,cp.ancho,cp.fuelle_fondo,cp.fuelle_latiz,cp.fuelle_latde,cp.refuerzo,cp.por_kilo,
        cp.tamano_prod, cp.precio_500, cp.precio_1000, cp.precio_3000,
        pad.pigmento_default AS pigmento,
        tf.cantidad AS tintas_frente_default,
        (pad.id_color_default IS NOT NULL) AS asa, ca.color AS tipo_asa,
        pad.idsuaje_default AS idsuaje,
        pad.id_color_default AS id_color,
        cp.descripcion AS descripcion,
        img_prev.public_id AS imagen_public_id
      FROM configuracion_plastico cp
      LEFT JOIN tipo_producto_plastico tpp ON tpp.idtipo_producto_plastico=cp.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN material_plastico mp ON mp.idmaterial_plastico=cp.material_plastico_plastico_idmaterial_plastico
      LEFT JOIN calibre cal ON cal.idcalibre=cp.calibre_idcalibre
      LEFT JOIN producto_acabado_default pad ON pad.idconfiguracion_plastico=cp.idconfiguracion_plastico
      LEFT JOIN color_asa ca ON ca.id_color=pad.id_color_default
      LEFT JOIN tintas tf ON tf.idtintas = pad.idtintas_frente_default
      LEFT JOIN LATERAL (
        SELECT public_id FROM archivos
        WHERE idconfiguracion_plastico = cp.idconfiguracion_plastico
          AND categoria = 'imagen-producto-plastico'
        ORDER BY id_archivo DESC
        LIMIT 1
      ) img_prev ON true
      WHERE cp.activo=true
      ORDER BY tpp.material_plastico_producto,cp.medida`);

    const plastico = await Promise.all(
      plasticoRaw.map(async (row) => {
        const { imagen_public_id, ...rest } = row;
        return {
          ...rest,
          imagen_url: imagen_public_id ? await getPresignedUrl(imagen_public_id) : null,
        };
      })
    );

    const papel = await papelPromise;

    const { rows: coloresAsa } = await pool.query(
      `SELECT id_color AS id, INITCAP(color) AS nombre FROM color_asa ORDER BY id_color`
    );
    const { rows: suajesPlast } = await pool.query(
      `SELECT idsuaje AS id, tipo FROM asa_suaje WHERE idproductos = 1 ORDER BY idsuaje`
    );
    return res.json({ plastico, papel, coloresAsa, suajesPlast });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
};

// ─── Seguridad para sincronizar Expo ⇄ Sistema al editar/eliminar ──────────
async function puedeModificarProductoSistemaDeExpo(
  client: any,
  opts: { idproducto_papel?: number | null; idconfiguracion_plastico?: number | null }
): Promise<boolean> {
  if (opts.idproducto_papel) {
    const { rows } = await client.query(
      `SELECT pp.origen_expo,
        (SELECT COUNT(*) FROM solicitud_producto sp
         JOIN solicitud s ON s.idsolicitud = sp.solicitud_idsolicitud
         WHERE sp.producto_papel_idproducto_papel = pp.idproducto_papel
           AND s.origen_expo = false) AS usos_externos
       FROM producto_papel pp WHERE pp.idproducto_papel = $1`,
      [opts.idproducto_papel]
    );
    if (!rows.length) return false;
    return rows[0].origen_expo === true && Number(rows[0].usos_externos) === 0;
  }
  if (opts.idconfiguracion_plastico) {
    const { rows } = await client.query(
      `SELECT cp.origen_expo,
        (SELECT COUNT(*) FROM solicitud_producto sp
         JOIN solicitud s ON s.idsolicitud = sp.solicitud_idsolicitud
         WHERE sp.configuracion_plastico_idconfiguracion_plastico = cp.idconfiguracion_plastico
           AND s.origen_expo = false) AS usos_externos
       FROM configuracion_plastico cp WHERE cp.idconfiguracion_plastico = $1`,
      [opts.idconfiguracion_plastico]
    );
    if (!rows.length) return false;
    return rows[0].origen_expo === true && Number(rows[0].usos_externos) === 0;
  }
  return false;
}

async function actualizarProductoPapelEnLugar(
  client: any,
  idproducto_papel: number,
  cat: {
    nombre: string; material: string | null; calibre: string | null; tipo_producto: string | null;
    altura: number | null; ancho: number | null; fuelle: number | null;
  }
) {
  const tipoStr = (cat.tipo_producto || "").toLowerCase();
  const { rows: tpRows } = await client.query(
    `SELECT idcat_tipo_producto_papel FROM cat_tipo_producto_papel WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
    [`%${tipoStr}%`]
  );
  const idcatTipoProductoPapel = tpRows[0]?.idcat_tipo_producto_papel ?? null;

  const altura = Number(cat.altura) || null;
  const ancho = Number(cat.ancho) || null;
  const fuelle = Number(cat.fuelle) || null;
  const medida = [altura, fuelle, ancho].filter(Boolean).length >= 2
    ? `${altura || ""}${fuelle ? "+" + fuelle : ""}x${ancho || ""}` : null;

  await client.query(
    `UPDATE producto_papel SET
       idcat_tipo_producto_papel = COALESCE($1, idcat_tipo_producto_papel),
       descripcion_papel = COALESCE(NULLIF($2,''), descripcion_papel), ancho = $3, fuelle = $4, altura = $5,
       medida = COALESCE($6, medida),
       updated_at = NOW()
     WHERE idproducto_papel = $7`,
    [idcatTipoProductoPapel, cat.nombre, ancho, fuelle, altura, medida, idproducto_papel]
  );

  if (cat.material || cat.calibre) {
    const { rows: tmatRows } = await client.query(
      `SELECT idcat_tipo_papel FROM cat_tipo_papel WHERE LOWER(nombre) = LOWER($1) LIMIT 1`,
      [cat.material || ""]
    );
    const idcatTipoPapel = tmatRows[0]?.idcat_tipo_papel ?? null;
    let idcatCalibre: number | null = null;
    if (cat.calibre) {
      const { rows: calRows } = await client.query(
        `SELECT idcat_calibre FROM cat_calibre WHERE LOWER(nombre) = LOWER($1) LIMIT 1`,
        [cat.calibre]
      );
      idcatCalibre = calRows[0]?.idcat_calibre ?? null;
    }
    if (idcatTipoPapel || idcatCalibre) {
      const { rows: gpRows } = await client.query(
        `SELECT idgrupo_papel FROM grupo_papel WHERE idproducto_papel=$1 ORDER BY idgrupo_papel ASC LIMIT 1`,
        [idproducto_papel]
      );
      if (gpRows.length) {
        const idgrupo = gpRows[0].idgrupo_papel;
        const { rows: dmRows } = await client.query(
          `SELECT iddetalle_material FROM detalle_material_papel WHERE idgrupo_papel=$1 ORDER BY orden ASC LIMIT 1`,
          [idgrupo]
        );
        if (dmRows.length) {
          await client.query(
            `UPDATE detalle_material_papel SET
               idcat_tipo_papel = COALESCE($1, idcat_tipo_papel),
               idcat_calibre = COALESCE($2, idcat_calibre)
             WHERE iddetalle_material=$3`,
            [idcatTipoPapel, idcatCalibre, dmRows[0].iddetalle_material]
          );
        } else {
          await client.query(
            `INSERT INTO detalle_material_papel (idgrupo_papel, idcat_tipo_papel, idcat_calibre, orden)
             VALUES ($1,$2,$3,1)`,
            [idgrupo, idcatTipoPapel, idcatCalibre]
          );
        }
      } else {
        const { rows: newGp } = await client.query(
          `INSERT INTO grupo_papel (idproducto_papel, precio_sugerido, orden) VALUES ($1,NULL,1) RETURNING idgrupo_papel`,
          [idproducto_papel]
        );
        await client.query(
          `INSERT INTO detalle_material_papel (idgrupo_papel, idcat_tipo_papel, idcat_calibre, orden) VALUES ($1,$2,$3,1)`,
          [newGp[0].idgrupo_papel, idcatTipoPapel, idcatCalibre]
        );
      }
    }
  }
}

async function actualizarConfiguracionPlasticoEnLugar(
  client: any,
  idconfiguracion_plastico: number,
  cat: {
    material: string | null; calibre: string | null; tipo_producto: string | null;
    altura: number | null; ancho: number | null; fuelle: number | null;
    fuelle_fondo: number | null; fuelle_lateral_iz: number | null; fuelle_lateral_de: number | null;
    refuerzo: number | null;
  }
) {
  const materialNorm = normalizarMaterial(cat.material);
  const esBopp = materialNorm === "BOPP";
  const { rows: matRows } = await client.query(
    `SELECT idmaterial_plastico, valor FROM material_plastico WHERE LOWER(tipo_material) = LOWER($1) LIMIT 1`,
    [materialNorm]
  );
  const materialId = matRows[0]?.idmaterial_plastico ?? null;
  const factorMaterial = matRows[0] ? parseFloat(matRows[0].valor) || 0 : 0;

  let tipoId: number | null = null;
  if (cat.tipo_producto) {
    const { rows: tipoRows } = await client.query(
      `SELECT idtipo_producto_plastico FROM tipo_producto_plastico WHERE LOWER(material_plastico_producto) LIKE $1 LIMIT 1`,
      [`%${cat.tipo_producto.toLowerCase()}%`]
    );
    tipoId = tipoRows[0]?.idtipo_producto_plastico ?? null;
  }

  let calibreId: number | null = null;
  const calibreNum = cat.calibre ? parseFloat(cat.calibre) || 0 : 0;
  if (calibreNum) {
    const calibreCol = esBopp ? "calibre_bopp" : "calibre";
    const { rows: calRows } = await client.query(
      `SELECT idcalibre FROM calibre WHERE ${calibreCol} = $1 LIMIT 1`, [calibreNum]
    );
    calibreId = calRows[0]?.idcalibre ?? null;
  }

  const altura = Number(cat.altura) || 0;
  const ancho = Number(cat.ancho) || 0;
  const fuelleFondo = Number(cat.fuelle_fondo || cat.fuelle) || 0;
  const fuelleLat1 = Number(cat.fuelle_lateral_iz) || 0;
  const fuelleLat2 = Number(cat.fuelle_lateral_de) || 0;
  const refuerzo = Number(cat.refuerzo) || 0;
  let porKilo: number | null = null;
  if (altura && ancho && calibreNum && factorMaterial) {
    porKilo = calcularPorKiloExpo(altura, ancho, fuelleFondo, fuelleLat1, fuelleLat2, refuerzo, calibreNum, factorMaterial);
  }

  const partes: string[] = [String(altura)];
  if (fuelleFondo > 0) partes.push(String(fuelleFondo));
  if (refuerzo > 0) partes.push(String(refuerzo));
  const partesDer: string[] = [String(ancho)];
  if (fuelleLat1 > 0) partesDer.push(String(fuelleLat1));
  if (fuelleLat2 > 0 && fuelleLat2 !== fuelleLat1) partesDer.push(String(fuelleLat2));
  const medida = `${partes.join("+")}x${partesDer.join("+")}`;

  await client.query(
    `UPDATE configuracion_plastico SET
       tipo_producto_plastico_plastico_idtipo_producto_plastico = COALESCE($1, tipo_producto_plastico_plastico_idtipo_producto_plastico),
       material_plastico_plastico_idmaterial_plastico = COALESCE($2, material_plastico_plastico_idmaterial_plastico),
       calibre_idcalibre = COALESCE($3, calibre_idcalibre),
       altura = $4, ancho = $5, fuelle_fondo = $6, fuelle_latiz = $7, fuelle_latde = $8, refuerzo = $9,
       medida = COALESCE($10, medida), por_kilo = COALESCE($11, por_kilo)
     WHERE idconfiguracion_plastico = $12`,
    [tipoId, materialId, calibreId, altura, ancho, fuelleFondo, fuelleLat1, fuelleLat2, refuerzo, medida, porKilo, idconfiguracion_plastico]
  );
}

// Recibe tintas_frente_default / tintas_dentro_default como CANTIDAD. Sin
// pantones.
export const crearProductoCatalogo = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const {
      nombre, descripcion, categoria, medida, material, calibre, tamano_prod,
      id_tamano_producto, idgrupo_papel, precio_base, costo_laminado,
      idproducto_sistema_base, idgrupo_sistema_base,
      copiar_desde_sistema,
      tipo_laminado, tipo_asa,
      idcat_laminado_default, idcat_tipo_asa_default,
      tipo_hs, tipo_textura, idfoil_default, idcat_textura_default,
      uv, ar, pigmento,
      precio_500, precio_1000, precio_3000,
      tipo_producto,
      altura, ancho, fuelle, fuelle_fondo, fuelle_lateral_iz, fuelle_lateral_de, refuerzo,
      tintas_frente_default, tintas_dentro_default,
    } = req.body;

    if (!nombre?.trim()) return res.status(400).json({ error: "El nombre es requerido" });
    if (!["papel", "plastico", "carton"].includes(categoria))
      return res.status(400).json({ error: `Categoría inválida: "${categoria}"` });

    const num = (v: any) => (v != null && v !== "") ? Number(v) : null;
    const bool = (v: any) => v === true || v === "true";

    await client.query("BEGIN");

    if (categoria === "plastico") {
      let tipoId: number | null = null;
      if (tipo_producto) {
        const { rows } = await client.query(
          `SELECT idtipo_producto_plastico FROM tipo_producto_plastico WHERE LOWER(material_plastico_producto) LIKE $1 LIMIT 1`,
          [`%${String(tipo_producto).toLowerCase()}%`]
        );
        tipoId = rows[0]?.idtipo_producto_plastico ?? null;
      }
      let materialId: number | null = null;
      if (material) {
        const { rows } = await client.query(
          `SELECT idmaterial_plastico FROM material_plastico WHERE LOWER(tipo_material) = LOWER($1) LIMIT 1`, [material]
        );
        materialId = rows[0]?.idmaterial_plastico ?? null;
      }
      let calibreId: number | null = null;
      if (calibre) {
        const calibreNum = parseFloat(calibre) || 0;
        if (calibreNum) {
          const { rows } = await client.query(
            `SELECT idcalibre FROM calibre WHERE calibre = $1 OR calibre_bopp = $1 LIMIT 1`, [calibreNum]
          );
          calibreId = rows[0]?.idcalibre ?? null;
        }
      }

      const { rows: cpRows } = await client.query(`
  INSERT INTO configuracion_plastico (
    material_plastico_plastico_idmaterial_plastico,
    tipo_producto_plastico_plastico_idtipo_producto_plastico,
    calibre_idcalibre,
    altura,
    fuelle_fondo,
    refuerzo,
    ancho,
    fuelle_latIz,
    fuelle_latDe,
medida,
descripcion,
por_kilo,
tamano_prod,
precio_500,
    precio_1000,
    precio_3000,
    activo,
    origen_expo
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
NULL,$12,$13,$14,$15,true,true
  )
  RETURNING idconfiguracion_plastico`,
  [
    materialId,
    tipoId,
    calibreId,
    num(altura),
    num(fuelle_fondo),
    num(refuerzo),
    num(ancho),
    num(fuelle_lateral_iz),
    num(fuelle_lateral_de),
    medida || null,

descripcion?.trim() || nombre?.trim() || null,

// Tamaño no aplica a plástico.
null,

num(precio_500),
num(precio_1000),
num(precio_3000),
  ]
);
      const idconfiguracion_plastico = cpRows[0].idconfiguracion_plastico;

      if (pigmento || tipo_asa || tintas_frente_default) {
        await guardarAcabadosDefaultPlastico(client, idconfiguracion_plastico, {
          pigmento, tipo_asa, tintasFrenteCantidad: tintas_frente_default ?? null,
        });
      }

      await client.query("COMMIT");
      const prod = await obtenerProductoCatalogoExpoPorId(idconfiguracion_plastico, "plastico");
      return res.status(201).json({ message: "Producto agregado", producto: prod });
    }

// ── PAPEL / CARTÓN ────────────────────────────────────────────────────────
// El producto seleccionado del sistema solamente sirve como plantilla.
// Siempre se crea un producto nuevo con origen_expo = true.

// Resolver tipo de producto.
let idcatTipoProductoPapel: number | null = null;

if (tipo_producto) {
  const { rows: tipoRows } = await client.query(
    `
    SELECT idcat_tipo_producto_papel
    FROM cat_tipo_producto_papel
    WHERE LOWER(nombre) = LOWER($1)
       OR LOWER(nombre) LIKE $2
    ORDER BY
      CASE
        WHEN LOWER(nombre) = LOWER($1) THEN 0
        ELSE 1
      END
    LIMIT 1
    `,
    [
      String(tipo_producto).trim(),
      `%${String(tipo_producto).trim().toLowerCase()}%`,
    ]
  );

  idcatTipoProductoPapel =
    tipoRows[0]?.idcat_tipo_producto_papel ?? null;
}

if (!idcatTipoProductoPapel) {
  await client.query("ROLLBACK");

  return res.status(400).json({
    error:
      "No se encontró el tipo de producto en el catálogo de Papel.",
  });
}

// Resolver tipo de papel.
let idcatTipoPapel: number | null = null;

if (material) {
  const { rows: materialRows } = await client.query(
    `
    SELECT idcat_tipo_papel
    FROM cat_tipo_papel
    WHERE LOWER(nombre) = LOWER($1)
    LIMIT 1
    `,
    [String(material).trim()]
  );

  idcatTipoPapel =
    materialRows[0]?.idcat_tipo_papel ?? null;
}

// Resolver calibre.
let idcatCalibre: number | null = null;

if (calibre) {
  const { rows: calibreRows } = await client.query(
    `
    SELECT idcat_calibre
    FROM cat_calibre
    WHERE LOWER(nombre) = LOWER($1)
    LIMIT 1
    `,
    [String(calibre).trim()]
  );

  idcatCalibre =
    calibreRows[0]?.idcat_calibre ?? null;
}

const idusuario = (req as any).user?.id ?? null;

// Según tu esquema actual:
// 2 = papel
// 3 = cartón
const idproductos = categoria === "carton" ? 3 : 2;

// Resolver tamaño normalizado. Durante la transición se acepta tanto el
// nuevo id_tamano_producto como el antiguo tamano_prod (id o nombre).
const tamanoRecibido = id_tamano_producto ?? tamano_prod ?? null;
const idTamanoProducto = await resolverIdTamanoProducto(client, tamanoRecibido);

if (tamanoRecibido != null && tamanoRecibido !== "" && !idTamanoProducto) {
  await client.query("ROLLBACK");
  return res.status(400).json({
    error: "El tamaño seleccionado no existe o está inactivo.",
  });
}

// Compatibilidad temporal: si un frontend anterior todavía manda únicamente
// precio_500, se toma como precio base. La fuente de verdad se guarda en
// grupo_papel.precio_sugerido.
const precioBase = numeroNullable(precio_base ?? precio_500);
const idProductoSistemaBase = numeroNullable(idproducto_sistema_base);
const idGrupoSistemaBase = numeroNullable(idgrupo_sistema_base);
const copiarDesdeSistema = bool(copiar_desde_sistema);

if (copiarDesdeSistema && (!idProductoSistemaBase || !idGrupoSistemaBase)) {
  await client.query("ROLLBACK");
  return res.status(400).json({
    error:
      "Se solicitó copiar un producto del sistema, pero no llegaron correctamente los ids del producto y del grupo.",
  });
}

if ((idProductoSistemaBase && !idGrupoSistemaBase) || (!idProductoSistemaBase && idGrupoSistemaBase)) {
  await client.query("ROLLBACK");
  return res.status(400).json({
    error: "Para copiar un producto del sistema se requieren el producto y su grupo.",
  });
}

// Cuando existe plantilla, la copia se hace por completo dentro del backend.
// El frontend únicamente manda los ids del producto/grupo y los defaults Expo.
if (idProductoSistemaBase && idGrupoSistemaBase) {
  const clonado = await clonarProductoPapelSistemaAExpo(client, {
    idProductoSistema: idProductoSistemaBase,
    idGrupoSistema: idGrupoSistemaBase,
    idUsuario: idusuario,
    categoriaEsperada: categoria === "carton" ? "carton" : "papel",
    nombre: nombre?.trim() || null,
    ancho: num(ancho),
    fuelle: num(fuelle),
    altura: num(altura),
    medida: medida || null,
    idTamanoProducto,
    costoLaminado: numeroNullable(costo_laminado),
    precioBase,
    precioReferencia500: num(precio_1000),
    precioReferencia1000: num(precio_3000),
  });

  await aplicarAcabadosPapel(client, clonado.idproductoPapel, {
    idcat_laminado: numeroNullable(idcat_laminado_default),
    idcat_tipo_asa: numeroNullable(idcat_tipo_asa_default),
    tipo_laminado,
    tipo_asa,
  });

  await guardarAcabadosDefaultPapel(client, clonado.idproductoPapel, {
    idcatLaminado: numeroNullable(idcat_laminado_default),
    idcatTipoAsa: numeroNullable(idcat_tipo_asa_default),
    idfoil: numeroNullable(idfoil_default),
    idcatTextura: numeroNullable(idcat_textura_default),
    tipo_laminado,
    tipo_asa,
    tipo_hs,
    tipo_textura,
    uv: bool(uv),
    ar: bool(ar),
    tintasFrenteCantidad: tintas_frente_default ?? null,
    tintasDentroCantidad: tintas_dentro_default ?? null,
  });

  await client.query("COMMIT");

  const producto = await obtenerProductoCatalogoExpoPorId(
    clonado.idproductoPapel,
    categoria === "carton" ? "carton" : "papel",
  );

  return res.status(201).json({
    message: "Producto del sistema copiado al catálogo Expo",
    producto,
    idproducto_papel: clonado.idproductoPapel,
    idgrupo_papel: clonado.idgrupoPapel,
  });
}

// Sin plantilla se conserva el registro manual actual.
// Crear un producto NUEVO, aunque coincida con uno del sistema.
const { rows: productoRows } = await client.query(
  `
  INSERT INTO producto_papel (
    idproductos,
    idcat_tipo_producto_papel,
    descripcion_papel,
    ancho,
    fuelle,
    altura,
    medida,
    tamano_prod,
    costo_laminado,
    creado_por,
    actualizado_por,
    activo,
    origen_expo
  )
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,TRUE,TRUE)
  RETURNING idproducto_papel
  `,
  [
    idproductos,
    idcatTipoProductoPapel,
    nombre.trim(),
    num(ancho),
    num(fuelle),
    num(altura),
    medida || null,
    idTamanoProducto,
    numeroNullable(costo_laminado),
    idusuario,
  ],
);

const idproductoPapelNuevo = Number(productoRows[0].idproducto_papel);

// Referencias comerciales del catálogo Expo. Estos campos son únicamente
// informativos y NO participan en precio_base, precio_sugerido ni en los
// calculadores de papel/cartón.
await client.query(
  `UPDATE producto_papel
   SET precio_1000 = $1,
       precio_3000 = $2
   WHERE idproducto_papel = $3`,
  [num(precio_1000), num(precio_3000), idproductoPapelNuevo],
);

// Todo producto Expo de papel necesita grupo, aunque material/calibre todavía
// estén vacíos, porque el precio base pertenece al grupo.
const { rows: grupoRows } = await client.query(
  `
  INSERT INTO grupo_papel (
    idproducto_papel,
    precio_sugerido,
    orden,
    creado_por,
    actualizado_por
  )
  VALUES ($1,$2,1,$3,$3)
  RETURNING idgrupo_papel
  `,
  [idproductoPapelNuevo, precioBase, idusuario],
);

const idgrupoPapelNuevo = Number(grupoRows[0].idgrupo_papel);

if (idcatTipoPapel || idcatCalibre) {
  await client.query(
    `
    INSERT INTO detalle_material_papel (
      idgrupo_papel,
      idcat_tipo_papel,
      idcat_calibre,
      orden,
      creado_por,
      actualizado_por
    )
    VALUES ($1,$2,$3,1,$4,$4)
    `,
    [idgrupoPapelNuevo, idcatTipoPapel, idcatCalibre, idusuario],
  );
}

await aplicarAcabadosPapel(client, idproductoPapelNuevo, {
  idcat_laminado: numeroNullable(idcat_laminado_default),
  idcat_tipo_asa: numeroNullable(idcat_tipo_asa_default),
  tipo_laminado,
  tipo_asa,
});

await guardarAcabadosDefaultPapel(client, idproductoPapelNuevo, {
  idcatLaminado: numeroNullable(idcat_laminado_default),
  idcatTipoAsa: numeroNullable(idcat_tipo_asa_default),
  idfoil: numeroNullable(idfoil_default),
  idcatTextura: numeroNullable(idcat_textura_default),
  tipo_laminado,
  tipo_asa,
  tipo_hs,
  tipo_textura,
  uv: bool(uv),
  ar: bool(ar),
  tintasFrenteCantidad: tintas_frente_default ?? null,
  tintasDentroCantidad: tintas_dentro_default ?? null,
});

await client.query("COMMIT");

const prod = await obtenerProductoCatalogoExpoPorId(
  idproductoPapelNuevo,
  categoria === "carton" ? "carton" : "papel"
);

return res.status(201).json({
  message: "Producto agregado",
  producto: prod,
});
  } catch (e: any) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
};

export const actualizarProductoCatalogo = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const {
  nombre,
  descripcion,
  categoria,
  medida,
  material,
  calibre,

  tamano_prod,
  id_tamano_producto,
  idgrupo_papel,
  precio_base,
  costo_laminado,

  tipo_laminado,
  tipo_asa,
  idcat_laminado_default,
  idcat_tipo_asa_default,
  tipo_hs,
  tipo_textura,
  idfoil_default,
  idcat_textura_default,
  uv,
  ar,
  pigmento,
  precio_500,
  precio_1000,
  precio_3000,
  tipo_producto,
  altura,
  ancho,
  fuelle,
  fuelle_fondo,
  fuelle_lateral_iz,
  fuelle_lateral_de,
  refuerzo,
  tintas_frente_default,
  tintas_dentro_default,
} = req.body;
    const num = (v: any) => (v != null && v !== "") ? Number(v) : null;
    const bool = (v: any) => v === true || v === "true";

    await client.query("BEGIN");

    if (categoria === "plastico") {
      await actualizarConfiguracionPlasticoEnLugar(client, Number(id), {
        material: material || null, calibre: calibre || null, tipo_producto: tipo_producto || null,
        altura: num(altura), ancho: num(ancho), fuelle: num(fuelle),
        fuelle_fondo: num(fuelle_fondo), fuelle_lateral_iz: num(fuelle_lateral_iz),
        fuelle_lateral_de: num(fuelle_lateral_de), refuerzo: num(refuerzo),
      });
      await client.query(
  `
  UPDATE configuracion_plastico
  SET
    descripcion = $1,
    precio_500 = $2,
    precio_1000 = $3,
    precio_3000 = $4
  WHERE idconfiguracion_plastico = $5
  `,
  [
    descripcion?.trim() || nombre?.trim() || null,
    num(precio_500),
    num(precio_1000),
    num(precio_3000),
    id,
  ]
);
      if (pigmento || tipo_asa || tintas_frente_default) {
        await guardarAcabadosDefaultPlastico(client, Number(id), {
          pigmento, tipo_asa, tintasFrenteCantidad: tintas_frente_default ?? null,
        });
      }
      await client.query("COMMIT");
      const prod = await obtenerProductoCatalogoExpoPorId(Number(id), "plastico");
      if (!prod) return res.status(404).json({ error: "Producto no encontrado" });
      return res.json({ message: "Producto actualizado", producto: prod });
    }

    const idProductoPapel = Number(id);
    const idusuario = (req as any).user?.id ?? null;
    const recibioTamano =
      Object.prototype.hasOwnProperty.call(req.body, "id_tamano_producto") ||
      Object.prototype.hasOwnProperty.call(req.body, "tamano_prod");
    const tamanoRecibido = id_tamano_producto ?? tamano_prod ?? null;
    const idTamanoProducto = recibioTamano
      ? await resolverIdTamanoProducto(client, tamanoRecibido)
      : null;

    if (
      recibioTamano &&
      tamanoRecibido != null &&
      tamanoRecibido !== "" &&
      !idTamanoProducto
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "El tamaño seleccionado no existe o está inactivo.",
      });
    }

    await actualizarProductoPapelEnLugar(client, idProductoPapel, {
      nombre: nombre?.trim() || "",
      material: material || null,
      calibre: calibre || null,
      tipo_producto: tipo_producto || null,
      altura: num(altura),
      ancho: num(ancho),
      fuelle: num(fuelle),
    });

    if (recibioTamano) {
      await client.query(
        `UPDATE producto_papel
         SET tamano_prod = $1,
             actualizado_por = COALESCE($2, actualizado_por),
             updated_at = NOW()
         WHERE idproducto_papel = $3`,
        [idTamanoProducto, idusuario, idProductoPapel],
      );
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "costo_laminado")) {
      await client.query(
        `UPDATE producto_papel
         SET costo_laminado = $1,
             actualizado_por = COALESCE($2, actualizado_por),
             updated_at = NOW()
         WHERE idproducto_papel = $3`,
        [numeroNullable(costo_laminado), idusuario, idProductoPapel],
      );
    }

    const recibioPrecioBase =
      Object.prototype.hasOwnProperty.call(req.body, "precio_base") ||
      Object.prototype.hasOwnProperty.call(req.body, "precio_500");

    if (recibioPrecioBase) {
      await guardarPrecioBaseGrupoPapel(client, {
        idproductoPapel: idProductoPapel,
        idgrupoPapel: numeroNullable(idgrupo_papel),
        precioBase: numeroNullable(precio_base ?? precio_500),
        idusuario,
      });
    }

    // Referencias comerciales del catálogo Expo. Se actualizan de forma
    // independiente para no tocar el precio base unitario ni los cálculos.
    const recibioReferencia500 =
      Object.prototype.hasOwnProperty.call(req.body, "precio_1000");
    const recibioReferencia1000 =
      Object.prototype.hasOwnProperty.call(req.body, "precio_3000");

    if (recibioReferencia500 || recibioReferencia1000) {
      await client.query(
        `UPDATE producto_papel
         SET precio_1000 = CASE WHEN $1 THEN $2 ELSE precio_1000 END,
             precio_3000 = CASE WHEN $3 THEN $4 ELSE precio_3000 END,
             actualizado_por = COALESCE($5, actualizado_por),
             updated_at = NOW()
         WHERE idproducto_papel = $6`,
        [
          recibioReferencia500,
          num(precio_1000),
          recibioReferencia1000,
          num(precio_3000),
          idusuario,
          idProductoPapel,
        ],
      );
    }

    await aplicarAcabadosPapel(client, idProductoPapel, {
      idcat_laminado: numeroNullable(idcat_laminado_default),
      idcat_tipo_asa: numeroNullable(idcat_tipo_asa_default),
      tipo_laminado,
      tipo_asa,
    });

    await guardarAcabadosDefaultPapel(client, idProductoPapel, {
      idcatLaminado: numeroNullable(idcat_laminado_default),
      idcatTipoAsa: numeroNullable(idcat_tipo_asa_default),
      idfoil: numeroNullable(idfoil_default),
      idcatTextura: numeroNullable(idcat_textura_default),
      tipo_laminado,
      tipo_asa,
      tipo_hs,
      tipo_textura,
      uv: bool(uv),
      ar: bool(ar),
      tintasFrenteCantidad: tintas_frente_default ?? null,
      tintasDentroCantidad: tintas_dentro_default ?? null,
    });

    await client.query("COMMIT");
    const prod = await obtenerProductoCatalogoExpoPorId(Number(id), categoria === "carton" ? "carton" : "papel");
    if (!prod) return res.status(404).json({ error: "Producto no encontrado" });
    return res.json({ message: "Producto actualizado", producto: prod });
  } catch (e: any) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
};

export const eliminarProductoCatalogo = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const categoria = String(req.query.categoria || req.body?.categoria || "");

    if (categoria === "plastico") {
      const { rowCount } = await pool.query(
        `UPDATE configuracion_plastico SET activo=false WHERE idconfiguracion_plastico=$1 AND origen_expo=true`, [id]
      );
      if (!rowCount) return res.status(404).json({ error: "Producto no encontrado (o no fue creado desde Expo)" });
      return res.json({ message: "Producto eliminado" });
    }

    const { rowCount } = await pool.query(
      `UPDATE producto_papel SET activo=false, updated_at=NOW() WHERE idproducto_papel=$1 AND origen_expo=true`, [id]
    );
    if (!rowCount) return res.status(404).json({ error: "Producto no encontrado (o no fue creado desde Expo)" });
    return res.json({ message: "Producto eliminado" });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
};


// ═══════════════════════════════════════════════════════════
// CLIENTES EXPO
// ═══════════════════════════════════════════════════════════

export const crearClienteExpo = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { nombre, celular, correo, impresion, ciudad, estado, clase, intereses, observaciones } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ error: "El nombre es requerido" });
    await client.query("BEGIN");
    const identificar = await generarIdentificador(client);
    const { rows } = await client.query(`
      INSERT INTO clientes (atencion,celular,correo,impresion,origen_expo,clasificacion_expo,
        intereses_expo,observaciones_expo,fecha,identificar)
      VALUES ($1,$2,$3,$4,true,$5,$6,$7,CURRENT_TIMESTAMP,$8)
      RETURNING idclientes,atencion,celular,correo,impresion,identificar`,
      [nombre.trim(), celular || null, correo || null, impresion || null,
      clase || null, intereses?.length ? intereses : null, observaciones || null, identificar]
    );
    const idclientes = rows[0].idclientes;
    if (ciudad || estado) {
      await client.query(
        `INSERT INTO domicilio (clientes_idclientes,poblacion,estado) VALUES ($1,$2,$3)`,
        [idclientes, ciudad || null, estado || null]
      );
    }
    await client.query("COMMIT");
    console.log(`✅ [EXPO] Cliente id=${idclientes} identificar=${identificar}`);
    return res.status(201).json({
      message: "Prospecto registrado",
      cliente: {
        id: idclientes, identificar, nombre: rows[0].atencion,
        celular: rows[0].celular, correo: rows[0].correo, impresion: rows[0].impresion
      },
    });
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error("❌ [EXPO] CREATE CLIENTE:", e.message);
    return res.status(500).json({ error: e.message });
  } finally { client.release(); }
};

export const getClientesExpo = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.idclientes, c.atencion AS nombre, c.celular, c.correo, c.impresion,
        c.clasificacion_expo AS clase, c.intereses_expo AS intereses,
        c.observaciones_expo AS observaciones, c.identificar,
        d.poblacion AS ciudad, d.estado
      FROM clientes c
      LEFT JOIN domicilio d ON d.clientes_idclientes=c.idclientes
      WHERE c.origen_expo=true
      ORDER BY c.fecha DESC`);
    return res.json(rows);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
};

export const actualizarClienteExpo = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { nombre, celular, correo, impresion, ciudad, estado, clase, intereses, observaciones } = req.body;
    await client.query("BEGIN");
    await client.query(`
      UPDATE clientes SET atencion=$1,celular=$2,correo=$3,impresion=$4,
        clasificacion_expo=$5,intereses_expo=$6,observaciones_expo=$7
      WHERE idclientes=$8 AND origen_expo=true`,
      [nombre?.trim() || null, celular || null, correo || null, impresion || null,
      clase || null, intereses?.length ? intereses : null, observaciones || null, id]
    );
    const { rowCount } = await client.query(
      `SELECT 1 FROM domicilio WHERE clientes_idclientes=$1`, [id]
    );
    if ((rowCount ?? 0) > 0) {
      await client.query(
        `UPDATE domicilio SET poblacion=$1,estado=$2 WHERE clientes_idclientes=$3`,
        [ciudad || null, estado || null, id]
      );
    } else if (ciudad || estado) {
      await client.query(
        `INSERT INTO domicilio (clientes_idclientes,poblacion,estado) VALUES ($1,$2,$3)`,
        [id, ciudad || null, estado || null]
      );
    }
    await client.query("COMMIT");
    return res.json({ message: "Prospecto actualizado" });
  } catch (e: any) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e.message });
  } finally { client.release(); }
};

export const eliminarClienteExpo = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT COUNT(*) AS total FROM solicitud WHERE clientes_idclientes=$1`, [id]
    );
    if (Number(rows[0].total) > 0) {
      await client.query(`UPDATE clientes SET origen_expo=false WHERE idclientes=$1`, [id]);
      await client.query("COMMIT");
      return res.json({ message: "Prospecto eliminado", teniaCotizaciones: true });
    }
    await client.query(`DELETE FROM domicilio WHERE clientes_idclientes=$1`, [id]);
    await client.query(`DELETE FROM clientes WHERE idclientes=$1`, [id]);
    await client.query("COMMIT");
    return res.json({ message: "Prospecto eliminado", teniaCotizaciones: false });
  } catch (e: any) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e.message });
  } finally { client.release(); }
};

// ═══════════════════════════════════════════════════════════
// COTIZACIONES EXPO
// ═══════════════════════════════════════════════════════════

export const getSiguienteFolioExpo = async (_req: Request, res: Response) => {
  // No se consume una secuencia para una vista previa. El folio definitivo se
  // asigna dentro de crearCotizacionExpo y se devuelve en la misma respuesta
  // del POST. Se conserva este endpoint únicamente por compatibilidad.
  return res.json({
    folio: "Se asigna al guardar",
    provisional: true,
  });
};

// La cotización recibe CANTIDADES de tintas del frontend
// (tintasFrenteCantidad / tintasDentroCantidad para papel/cartón,
// tintasFrenteCantidad para plástico) — aquí se resuelven a ids reales
// justo antes de insertar. Sin pantones.
export const crearCotizacionExpo = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { clienteId, productos, comentarios, moneda: monedaRaw, tipoCambio: tipoCambioRaw } = req.body;
    if (!clienteId) return res.status(400).json({ error: "Se requiere clienteId" });
    if (!productos?.length) return res.status(400).json({ error: "Se requiere al menos un producto" });

    let moneda: Moneda;
    let tipoCambio: number | null;
    try {
      ({ moneda, tipoCambio } = validarMonedaYTipoCambio(monedaRaw, tipoCambioRaw));
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }

    await client.query("BEGIN");
    const folioCotizacion = await obtenerSiguienteFolioCotizacion(client);
    const { rows: solRows } = await client.query(`
      INSERT INTO solicitud (clientes_idclientes,estado_administrativo_cat_idestado_administrativo_cat,
        estado,no_cotizacion,origen_expo,sin_iva,moneda,tipo_cambio)
      VALUES ($1,$2,'cotizacion',$3,true,false,$4,$5)
      RETURNING idsolicitud,no_cotizacion`,
      [clienteId, ESTADO.PENDIENTE, folioCotizacion, moneda, tipoCambio]
    );
    const solicitudId = solRows[0].idsolicitud;
    const noCotizacion = solRows[0].no_cotizacion;
    console.log(`✅ [EXPO] Solicitud ${noCotizacion} id=${solicitudId}`);

    const obsGeneral = comentarios?.trim() || null;

    let subtotalTotal = 0;

    for (const prod of productos) {
      console.log("[EXPO] tipoCotizacion:", prod.tipoCotizacion, "nombre:", prod.nombre);

      // ── PAPEL SIGEB (sistema) ──────────────────────────────────────────
      if (prod.tipoCotizacion === "papel" || prod.tipo_material === "papel") {
        let idgrupo_papel = prod.idgrupo_papel ?? null;
        if (!idgrupo_papel && prod.idproducto_papel) {
          const { rows: grupos } = await client.query(
            `SELECT idgrupo_papel FROM grupo_papel
     WHERE idproducto_papel=$1 ORDER BY idgrupo_papel ASC LIMIT 1`,
            [prod.idproducto_papel]
          );
          idgrupo_papel = grupos[0]?.idgrupo_papel ?? null;
        }

        let grupo_descripcion = prod.grupo_descripcion ?? null;
        if (!grupo_descripcion && idgrupo_papel) {
          const { rows: gdRows } = await client.query(`
    SELECT string_agg(CONCAT(ctp.nombre, ' ', cc.nombre), ' + ') AS desc
    FROM detalle_material_papel dmp
    LEFT JOIN cat_tipo_papel ctp ON ctp.idcat_tipo_papel = dmp.idcat_tipo_papel
    LEFT JOIN cat_calibre cc ON cc.idcat_calibre = dmp.idcat_calibre
    WHERE dmp.idgrupo_papel = $1`, [idgrupo_papel]
          );
          grupo_descripcion = gdRows[0]?.desc ?? null;
        }

        //let metodo_hojeado: "hojeado" | "guillotina" = "hojeado";
        if (prod.idproducto_papel) {
          const { rows: maq } = await client.query(
            `SELECT c.nombre FROM maquinaria_hojeado_guillotina m
             JOIN cat_hojeado_guillotina c ON c.idcat_hojeado_guillotina = m.idcat_hojeado_guillotina
             WHERE m.idproducto_papel = $1 LIMIT 1`,
            [prod.idproducto_papel]
          );
          const nombreMaq = (maq[0]?.nombre || "").toLowerCase();
          //if (nombreMaq.includes("guillotina")) metodo_hojeado = "guillotina";
        }

        const tintasId = await resolverIdTintasPorCantidad(
          client,
          prod.tintasFrenteCantidad,
        );
        const tintasDentroId = await resolverIdTintasPorCantidad(client, prod.tintasDentroCantidad);

        const papelPayload: ProductoPapelPayload = {
          tipoCotizacion: "papel",
          idproducto_papel: prod.idproducto_papel,
          nombre: prod.nombre ?? "",
          idgrupo_papel,
          grupo_descripcion: grupo_descripcion,
          tintasId,
          tintasFrenteCantidad: prod.tintasFrenteCantidad ?? 0,
          pantones: null,
          tintasDentroId,
          tintasDentroCantidad: prod.tintasDentroCantidad ?? 0,
          pantonesDentro: null,
          carasId: prod.carasId ?? null,
          id_asa: prod.id_asa ?? null,
          idcat_laminado: prod.idcat_laminado ?? null,
          idfoil: prod.idfoil ?? null,
          idcat_textura: prod.idcat_textura ?? null,
          laminacion: prod.laminacion ?? prod.idcat_laminado != null,
          hs: prod.hs ?? prod.idfoil != null,
          textura: prod.textura ?? prod.idcat_textura != null,
          asa: prod.asa ?? prod.id_asa != null,
          uv: prod.uv ?? false,
          alto_relieve: prod.alto_relieve ?? false,
          observacion: prod.observacion || obsGeneral,
          descripcion: prod.descripcion ?? null,
          cantidades: prod.cantidades,
          precios: prod.precios,
          opciones_precio: prod.opciones_precio,
          permitir_sin_tintas: true,
          herramental_descripcion: null,
          herramental_precio: null,
          cargo_adicional_descripcion: null,
          cargo_adicional_precio: null,
          //metodo_hojeado,
          lleva_armado: prod.lleva_armado ?? false,
        };

        subtotalTotal += await insertarProductoPapel(client, solicitudId, papelPayload, "cotizacion");
        continue;
      }

      // ── PAPEL EXPO PROPIO (categoría papel/cartón del catálogo expo) ────
      if (prod.tipoCotizacion === "expo_papel") {
        const {
          nombre: epNombre = null,
          tintasFrenteCantidad: epTintasFrenteCantidad = null,
          tintasDentroCantidad: epTintasDentroCantidad = null,
          tipoLaminado = null, tipoHs = null, tipoTextura = null, tipoAsa: epTipoAsa = null,
          uv: epUv = false, ar: epAr = false,
          cantidades: epCants, precios: epPrecios,
          observacion: epObs = null,
        } = prod;

        const epTintasId = await resolverIdTintasPorCantidad(client, epTintasFrenteCantidad);
        const epTintasDentroId = await resolverIdTintasPorCantidad(client, epTintasDentroCantidad);

        const { rows: catExpoRows } = await client.query(`
          SELECT * FROM catalogo_expo WHERE LOWER(nombre) = LOWER($1) AND activo=true LIMIT 1`,
          [epNombre || ""]
        );

        let epIdproductoPapel: number | null = null;
        if (catExpoRows.length > 0) {
          const catE = catExpoRows[0];
          if (catE.idproducto_papel) {
            epIdproductoPapel = catE.idproducto_papel;
          } else {
            const fks = await resolverFKsProductoExpo(client, {
              categoria: catE.categoria, nombre: catE.nombre,
              material: catE.material, calibre: catE.calibre,
              tipo_producto: catE.tipo_producto,
              altura: catE.altura, ancho: catE.ancho, fuelle: catE.fuelle,
              fuelle_fondo: catE.fuelle_fondo, fuelle_lateral_iz: catE.fuelle_lateral_iz,
              fuelle_lateral_de: catE.fuelle_lateral_de, refuerzo: catE.refuerzo,
            });
            epIdproductoPapel = fks.idproducto_papel;
            if (epIdproductoPapel) {
              let imagenBackfill: string | null = null;
              if (!catE.imagen_url) {
                const idArchivo = await buscarImagenSistema(client, fks);
                if (idArchivo) imagenBackfill = construirUrlArchivoEstable(idArchivo);
              }
              await client.query(
                `UPDATE catalogo_expo SET idproducto_papel=$1, imagen_url = COALESCE(imagen_url, $3)
                 WHERE idcatalogo_expo=$2`,
                [epIdproductoPapel, catE.idcatalogo_expo, imagenBackfill]
              );
            }
          }
        }

        if (!epIdproductoPapel) {
          console.warn(`[EXPO] No se pudo resolver idproducto_papel para "${epNombre}", insertando como expo`);
          const { rows: spGenRows } = await client.query(`
            INSERT INTO solicitud_producto
              (solicitud_idsolicitud, tintas_idtintas, descripcion, observacion, tipo_material)
            VALUES ($1,$2,$3,$4,'expo')
            RETURNING idsolicitud_producto`,
            [solicitudId, epTintasId, epNombre || null, epObs || obsGeneral || null]
          );
          const spGenId = spGenRows[0].idsolicitud_producto;
          for (let i = 0; i < 3; i++) {
            const cant = Number(epCants?.[i] ?? 0);
            const precio = Number(epPrecios?.[i] ?? 0);
            if (cant > 0 && precio > 0) {
              await client.query(`
                INSERT INTO solicitud_detalle (
                  solicitud_producto_id, cantidad, precio_total,
                  precio_unitario, aprobado, modo_cantidad
                )
                VALUES ($1,$2,$3,$4,$5,'unidad')`,
                [
                  spGenId,
                  cant,
                  Math.round(cant * precio * 100) / 100,
                  Math.round(precio * 100) / 100,
                  null,
                ]
              );
              subtotalTotal += Math.round(cant * precio * 100) / 100;
            }
          }
          continue;
        }

        let epIdAsa: number | null = null;
        if (epTipoAsa) {
          const { rows: asaR } = await client.query(
            `SELECT idcat_tipo_asa FROM cat_tipo_asa WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
            [`%${epTipoAsa.toLowerCase()}%`]
          );
          epIdAsa = asaR[0]?.idcat_tipo_asa ?? null;
        }

        let epIdLaminado: number | null = null;
        if (tipoLaminado) {
          const { rows: lamR } = await client.query(
            `SELECT idcat_laminado FROM cat_laminado WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
            [`%${tipoLaminado.toLowerCase()}%`]
          );
          epIdLaminado = lamR[0]?.idcat_laminado ?? null;
        }

        let epIdFoil: number | null = null;
        if (tipoHs) {
          const termino = tipoHs.toLowerCase().trim();
          const palabras = termino.split(/\s+/);
          const ultimaPalab = palabras[palabras.length - 1];
          const { rows: foilR } = await client.query(
            `SELECT idfoil FROM foil WHERE LOWER(colorfoil) LIKE $1 OR LOWER(codigofoil) LIKE $2 LIMIT 1`,
            [`%${termino}%`, `%${ultimaPalab}%`]
          );
          epIdFoil = foilR[0]?.idfoil ?? null;
        }

        let epIdTextura: number | null = null;
        if (tipoTextura) {
          const { rows: texR } = await client.query(
            `SELECT idcat_textura FROM cat_textura WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
            [`%${tipoTextura.toLowerCase()}%`]
          );
          epIdTextura = texR[0]?.idcat_textura ?? null;
        }

        const { rows: gpRows } = await client.query(
          `SELECT idgrupo_papel FROM grupo_papel WHERE idproducto_papel=$1 ORDER BY idgrupo_papel ASC LIMIT 1`,
          [epIdproductoPapel]
        );
        const epIdgrupo = gpRows[0]?.idgrupo_papel ?? null;

        let epGrupoDesc: string | null = null;
        if (epIdgrupo) {
          const { rows: gdRows } = await client.query(`
            SELECT string_agg(CONCAT(ctp.nombre, ' ', cc.nombre), ' + ') AS desc
            FROM detalle_material_papel dmp
            LEFT JOIN cat_tipo_papel ctp ON ctp.idcat_tipo_papel = dmp.idcat_tipo_papel
            LEFT JOIN cat_calibre cc ON cc.idcat_calibre = dmp.idcat_calibre
            WHERE dmp.idgrupo_papel = $1`, [epIdgrupo]
          );
          epGrupoDesc = gdRows[0]?.desc ?? null;
        }

        if (!epGrupoDesc && catExpoRows.length > 0) {
          const catE = catExpoRows[0];
          const partes = [catE.material, catE.calibre].filter(Boolean);
          if (partes.length > 0) epGrupoDesc = partes.join(" ");
        }

        const epPayload: ProductoPapelPayload = {
          tipoCotizacion: "papel",
          idproducto_papel: epIdproductoPapel,
          nombre: epNombre ?? "",
          idgrupo_papel: epIdgrupo,
          grupo_descripcion: epGrupoDesc,
          tintasId: epTintasId,
          tintasFrenteCantidad: epTintasFrenteCantidad ?? 0,
          pantones: null,
          tintasDentroId: epTintasDentroId,
          tintasDentroCantidad: epTintasDentroCantidad ?? 0,
          pantonesDentro: null,
          carasId: null,
          id_asa: epIdAsa,
          idcat_laminado: epIdLaminado,
          idfoil: epIdFoil,
          idcat_textura: epIdTextura,
          laminacion: Boolean(tipoLaminado),
          hs: Boolean(tipoHs),
          textura: Boolean(tipoTextura),
          asa: Boolean(epTipoAsa),
          uv: epUv === true,
          alto_relieve: epAr === true,
          observacion: epObs || obsGeneral || null,
          descripcion: epNombre ?? null,
          cantidades: epCants ?? [0, 0, 0],
          precios: epPrecios ?? [0, 0, 0],
          opciones_precio: prod.opciones_precio,
          permitir_sin_tintas: true,
          herramental_descripcion: null,
          herramental_precio: null,
          cargo_adicional_descripcion: null,
          cargo_adicional_precio: null,
          //metodo_hojeado: "hojeado",
          lleva_armado: false,
        };

        subtotalTotal += await insertarProductoPapel(client, solicitudId, epPayload, "cotizacion");
        continue;
      }

      // ── PLÁSTICO (sistema o expo) ────────────────────────────────────
      const {
        configuracion_plastico_id,
        tintasFrenteCantidad = null,
        nombre: prodNombre = null,
        observacion: prodObs = null,
        cantidades,
        precios,
        idsuaje: prodIdsuaje = null,
        id_color: prodIdColor = null,
        pigmento: prodPigmento = null,
      } = prod;

      const tipoMaterial = configuracion_plastico_id ? "plastico" : "expo";
      const tintasId = await resolverIdTintasPorCantidad(client, tintasFrenteCantidad);

      const idsuaje = prodIdsuaje != null ? Number(prodIdsuaje) : null;
      const idColor = prodIdColor != null ? Number(prodIdColor) : null;
      console.log(`[EXPO] Plástico cfg_id=${configuracion_plastico_id} idsuaje=${idsuaje} id_color=${idColor}`);

      const { rows: spRows } = await client.query(`
        INSERT INTO solicitud_producto (
          solicitud_idsolicitud,
          configuracion_plastico_idconfiguracion_plastico,
          producto_papel_idproducto_papel,
          tintas_idtintas,
          descripcion,
          observacion,
          tipo_material,
          idsuaje,
          id_color,
          pigmentos
        ) VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9)
        RETURNING idsolicitud_producto`,
        [
          solicitudId,
          configuracion_plastico_id ?? null,
          tintasId,
          prodNombre || null,
          prodObs || obsGeneral || null,
          tipoMaterial,
          idsuaje,
          idColor,
          prodPigmento || null,
        ]
      );
      const spId = spRows[0].idsolicitud_producto;

      const cantArr: number[] = Array.isArray(cantidades) ? cantidades : [0, 0, 0];
      const preArr: number[] = Array.isArray(precios) ? precios : [0, 0, 0];

      for (let i = 0; i < cantArr.length; i++) {
        const cant = Number(cantArr[i]);
        const precio = Number(preArr[i]);
        if (cant <= 0 || precio <= 0) continue;
        const precioTotal = Math.round(cant * precio * 100) / 100;
        await client.query(`
          INSERT INTO solicitud_detalle
            (solicitud_producto_id, cantidad, precio_total, precio_unitario, aprobado, modo_cantidad)
          VALUES ($1,$2,$3,$4,NULL,'unidad')`,
          [spId, cant, precioTotal, precio]
        );
        subtotalTotal += precioTotal;
      }

      console.log(`✅ [EXPO] sp_id=${spId} tipo=${tipoMaterial} idsuaje=${idsuaje} id_color=${idColor} subtotal_acum=${subtotalTotal}`);
    }

    await client.query("COMMIT");
    console.log(`✅ [EXPO] Cotización ${noCotizacion} guardada. Subtotal=${subtotalTotal}`);
    return res.status(201).json({
      message: "Cotización expo guardada",
      no_cotizacion: noCotizacion,
      idsolicitud: solicitudId,
    });

  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error("❌ [EXPO] CREATE COT:", e.message, e.stack);
    return res.status(500).json({ error: "Error al guardar cotización expo", detalle: e.message });
  } finally {
    client.release();
  }
};

export const getCotizacionesExpo = async (
  req: Request,
  res: Response
) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        s.idsolicitud,
        s.no_cotizacion,
        s.no_pedido,
        s.estado,
        s.fecha,
        s.clientes_idclientes,

        cli.atencion AS cliente,
        cli.celular,
        cli.correo,
        cli.impresion,
        cli.clasificacion_expo,
        cli.intereses_expo,
        cli.observaciones_expo,
        cli.identificar,

        dom.poblacion AS ciudad,
        dom.estado AS estado_cliente,

        sp.idsolicitud_producto,
        sp.tipo_material,
        sp.descripcion,
        sp.observacion,
        sp.configuracion_plastico_idconfiguracion_plastico,
        sp.producto_papel_idproducto_papel,
        sp.pigmentos,
        sp.grupo_papel_descripcion,
        sp.grupo_papel_idgrupo_papel,
        sp.idsuaje,
        sp.id_color,

        asz.tipo AS suaje_tipo,
        ca.color AS color_asa_nombre,

        t.cantidad AS tintas_cantidad,
        td.cantidad AS tintas_dentro_cantidad,

        cfg.medida AS cfg_medida,
        cfg.descripcion AS cfg_descripcion,

        tpp.material_plastico_producto AS tipo_producto_nombre,
        mp.tipo_material AS material_nombre,

        cal.calibre AS calibre_numero,
        cal.calibre_bopp,

        ctp.nombre AS papel_tipo_producto,
        pp.medida AS papel_medida,
        pp.descripcion_papel AS papel_descripcion,

        spp.id_asa,
        asa.nombre AS asa_nombre,

        spp.idcat_laminado,
        lam.nombre AS laminado_nombre,

        spp.idfoil,
        fo.colorfoil AS foil_color,
        fo.codigofoil AS foil_codigo,

        spp.idcat_textura,
        tex.nombre AS textura_nombre,

        spp.uv,
        spp.alto_relieve,

        sd.idsolicitud_detalle,
        sd.cantidad,
        sd.precio_total,
        sd.precio_unitario,
        sd.aprobado,

        sdc.precio_calculado_unitario,
        sdc.precio_tablero_unitario,
        sdc.cargo_extra_unitario,
        sdc.ajuste_manual,
        sdc.idcat_escala_costo,
        sdc.escala_cantidad,
        sdc.calculo_snapshot,

        ce_exp.medida AS expo_medida,
        ce_exp.material AS expo_material,
        ce_exp.calibre AS expo_calibre,
        ce_exp.tipo_producto AS expo_tipo_producto

      FROM solicitud s

      LEFT JOIN clientes cli
        ON cli.idclientes = s.clientes_idclientes

      LEFT JOIN domicilio dom
        ON dom.clientes_idclientes = cli.idclientes

      LEFT JOIN solicitud_producto sp
        ON sp.solicitud_idsolicitud = s.idsolicitud

      LEFT JOIN asa_suaje asz
        ON asz.idsuaje = sp.idsuaje

      LEFT JOIN color_asa ca
        ON ca.id_color = sp.id_color

      LEFT JOIN tintas t
        ON t.idtintas = sp.tintas_idtintas

      LEFT JOIN solicitud_producto_papel spp
        ON spp.idsolicitud_producto = sp.idsolicitud_producto

      LEFT JOIN tintas td
        ON td.idtintas = spp.tintas_dentro_idtintas

      LEFT JOIN configuracion_plastico cfg
        ON cfg.idconfiguracion_plastico =
           sp.configuracion_plastico_idconfiguracion_plastico

      LEFT JOIN tipo_producto_plastico tpp
        ON tpp.idtipo_producto_plastico =
           cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico

      LEFT JOIN material_plastico mp
        ON mp.idmaterial_plastico =
           cfg.material_plastico_plastico_idmaterial_plastico

      LEFT JOIN calibre cal
        ON cal.idcalibre = cfg.calibre_idcalibre

      LEFT JOIN producto_papel pp
        ON pp.idproducto_papel =
           sp.producto_papel_idproducto_papel

      LEFT JOIN cat_tipo_producto_papel ctp
        ON ctp.idcat_tipo_producto_papel =
           pp.idcat_tipo_producto_papel

      LEFT JOIN cat_tipo_asa asa
        ON asa.idcat_tipo_asa = spp.id_asa

      LEFT JOIN cat_laminado lam
        ON lam.idcat_laminado = spp.idcat_laminado

      LEFT JOIN foil fo
        ON fo.idfoil = spp.idfoil

      LEFT JOIN cat_textura tex
        ON tex.idcat_textura = spp.idcat_textura

      LEFT JOIN grupo_papel gp
        ON gp.idgrupo_papel =
           sp.grupo_papel_idgrupo_papel

      LEFT JOIN LATERAL (
        SELECT
          ce.medida,
          ce.material,
          ce.calibre,
          ce.tipo_producto
        FROM catalogo_expo ce
        WHERE sp.tipo_material = 'expo'
          AND ce.activo = true
          AND LOWER(ce.nombre) = LOWER(sp.descripcion)
        ORDER BY ce.idcatalogo_expo DESC
        LIMIT 1
      ) ce_exp ON true

      LEFT JOIN solicitud_detalle sd
        ON sd.solicitud_producto_id =
           sp.idsolicitud_producto

      LEFT JOIN solicitud_detalle_calculo sdc
        ON sdc.solicitud_detalle_id =
           sd.idsolicitud_detalle

      WHERE s.origen_expo = true

      ORDER BY
        s.fecha DESC,
        sp.idsolicitud_producto,
        sd.idsolicitud_detalle
    `);

    const agrupadas: Record<string, any> = {};

    for (const row of rows) {
      const key = String(row.idsolicitud);

      if (!agrupadas[key]) {
        agrupadas[key] = {
          idsolicitud: row.idsolicitud,
          no_cotizacion: row.no_cotizacion,
          no_pedido: row.no_pedido,
          estado: row.estado,
          fecha: row.fecha,

          cliente_id: row.clientes_idclientes,
          cliente: row.cliente || "",
          celular: row.celular || "",
          correo: row.correo || "",
          impresion: row.impresion || "",

          clasificacion: row.clasificacion_expo || "",
          intereses: row.intereses_expo || [],
          observaciones: row.observaciones_expo || "",
          ciudad: row.ciudad || "",
          estado_cliente: row.estado_cliente || "",
          identificar: row.identificar || "",

          productos: [],
        };
      }

      if (!row.idsolicitud_producto) {
        continue;
      }

      let prod = agrupadas[key].productos.find(
        (p: any) =>
          p.idsolicitud_producto === row.idsolicitud_producto
      );

      if (!prod) {
        let nombre = row.descripcion || "";

        if (!nombre) {
          if (row.tipo_material === "papel") {
            nombre = row.papel_tipo_producto
              ? row.papel_descripcion
                ? `${row.papel_tipo_producto} — ${row.papel_descripcion}`
                : row.papel_tipo_producto
              : `Papel #${row.producto_papel_idproducto_papel}`;
          } else if (row.tipo_material === "plastico") {
            nombre =
              row.cfg_descripcion ||
              row.tipo_producto_nombre ||
              row.cfg_medida ||
              "Producto plástico";
          } else if (row.cfg_medida) {
            nombre = [
              row.tipo_producto_nombre,
              row.cfg_medida,
              (row.material_nombre || "").toLowerCase(),
            ]
              .filter(Boolean)
              .join(" ");
          } else {
            nombre = "Producto expo";
          }
        }

        const foilNombre = row.foil_color
          ? `${row.foil_color}${
              row.foil_codigo ? ` ${row.foil_codigo}` : ""
            }`
          : null;

        const esBoppRow =
          (row.material_nombre || "").toUpperCase() === "BOPP";

        const calibre = esBoppRow
          ? row.calibre_bopp != null
            ? String(row.calibre_bopp)
            : row.expo_calibre || null
          : row.calibre_numero != null
            ? String(row.calibre_numero)
            : row.expo_calibre || null;

        const esPapel = row.tipo_material === "papel";
        const esPlastico = row.tipo_material === "plastico";

        prod = {
          idsolicitud_producto: row.idsolicitud_producto,
          tipo_material: row.tipo_material,
          nombre,

          medida: esPapel
            ? row.papel_medida
            : row.cfg_medida || row.expo_medida || null,

          material:
            row.material_nombre || row.expo_material || null,

          calibre,

          tipo_producto: esPapel
            ? row.papel_tipo_producto ?? null
            : row.tipo_producto_nombre ||
              row.expo_tipo_producto ||
              null,

          tintas: row.tintas_cantidad ?? null,
          tintas_dentro:
            row.tintas_dentro_cantidad ?? null,

          descripcion: esPlastico
            ? row.cfg_descripcion || row.descripcion || null
            : row.descripcion || null,

          observacion: row.observacion || null,
          pigmentos: row.pigmentos || null,

          idsuaje: row.idsuaje ?? null,
          suaje_tipo: row.suaje_tipo ?? null,
          id_color: row.id_color ?? null,
          color_asa_nombre: row.color_asa_nombre ?? null,
          id_asa: row.id_asa ?? null,
          asa_nombre: row.asa_nombre ?? null,
          idcat_laminado: row.idcat_laminado ?? null,
          laminado_nombre: row.laminado_nombre ?? null,
          idfoil: row.idfoil ?? null,
          foil_nombre: foilNombre,
          grupo_descripcion:
            row.grupo_papel_descripcion ?? null,
          idcat_textura: row.idcat_textura ?? null,
          textura_nombre: row.textura_nombre ?? null,
          uv: row.uv ?? false,
          alto_relieve: row.alto_relieve ?? false,

          detalles: [],
        };

        agrupadas[key].productos.push(prod);
      }

      if (row.idsolicitud_detalle) {
        const detalleYaExiste = prod.detalles.some(
          (detalle: any) =>
            detalle.idsolicitud_detalle ===
            row.idsolicitud_detalle
        );

        if (!detalleYaExiste) {
          prod.detalles.push({
            idsolicitud_detalle:
              row.idsolicitud_detalle,
            cantidad: Number(row.cantidad),
            precio_total: Number(row.precio_total),
            precio_unitario:
              row.precio_unitario != null
                ? Number(row.precio_unitario)
                : null,
            aprobado: row.aprobado,
            precio_calculado_unitario:
              row.precio_calculado_unitario != null
                ? Number(row.precio_calculado_unitario)
                : null,
            precio_tablero_unitario:
              row.precio_tablero_unitario != null
                ? Number(row.precio_tablero_unitario)
                : null,
            cargo_extra_unitario:
              row.cargo_extra_unitario != null
                ? Number(row.cargo_extra_unitario)
                : null,
            ajuste_manual: row.ajuste_manual ?? null,
            idcat_escala_costo: row.idcat_escala_costo ?? null,
            escala_cantidad:
              row.escala_cantidad != null
                ? Number(row.escala_cantidad)
                : null,
            calculo_snapshot: row.calculo_snapshot ?? null,
          });
        }
      }
    }

    return res.json(Object.values(agrupadas));
  } catch (e: any) {
    console.error("❌ [EXPO] GET COTS:", e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS — Conversión automática de producto expo → configuracion_plastico
// ═══════════════════════════════════════════════════════════════════════════

function calcularPorKiloExpo(
  altura: number, ancho: number,
  fuelleFondo: number, fuelleLat1: number, fuelleLat2: number,
  refuerzo: number, calibre: number, factorMaterial: number
): number | null {
  if (altura === 0 || ancho === 0 || calibre === 0 || factorMaterial === 0) return null;
  const sumaV = altura + fuelleFondo + refuerzo;
  const sumaH = ancho + fuelleLat1 + fuelleLat2;
  const resultado = 1000 / (((sumaV / 100) * (sumaH / 100) * calibre) * factorMaterial);
  return parseFloat(resultado.toFixed(3));
}

function normalizarMaterial(material: string | null): string {
  const m = (material || "").toLowerCase();
  if (m.includes("alta")) return "Alta densidad";
  if (m.includes("baja")) return "Baja densidad";
  if (m.includes("bopp") || m.includes("celofan") || m.includes("celofán")) return "BOPP";
  return material || "";
}

async function resolverFKsProductoExpo(
  client: any,
  cat: {
    categoria: string; nombre: string; material: string | null; calibre: string | null;
    tipo_producto: string | null; altura: number | null; ancho: number | null;
    fuelle: number | null; fuelle_fondo: number | null; fuelle_lateral_iz: number | null;
    fuelle_lateral_de: number | null; refuerzo: number | null;
  }
): Promise<{ idproducto_papel: number | null; idconfiguracion_plastico: number | null }> {

  if (cat.categoria === "plastico") {
    if (!cat.material || !cat.calibre || !cat.tipo_producto) return { idproducto_papel: null, idconfiguracion_plastico: null };
    const materialNorm = normalizarMaterial(cat.material);
    const esBopp = materialNorm === "BOPP";
    const calibreNum = parseFloat(cat.calibre) || 0;
    if (!calibreNum) return { idproducto_papel: null, idconfiguracion_plastico: null };
    const { rows: matRows } = await client.query(
      `SELECT idmaterial_plastico, valor FROM material_plastico WHERE LOWER(tipo_material) = LOWER($1) LIMIT 1`,
      [materialNorm]
    );
    if (!matRows.length) return { idproducto_papel: null, idconfiguracion_plastico: null };
    const materialId = matRows[0].idmaterial_plastico;
    const factorMaterial = parseFloat(matRows[0].valor) || 0;
    const { rows: tipoRows } = await client.query(
      `SELECT idtipo_producto_plastico FROM tipo_producto_plastico WHERE LOWER(material_plastico_producto) LIKE $1 LIMIT 1`,
      [`%${cat.tipo_producto.toLowerCase()}%`]
    );
    if (!tipoRows.length) return { idproducto_papel: null, idconfiguracion_plastico: null };
    const tipoId = tipoRows[0].idtipo_producto_plastico;
    const calibreCol = esBopp ? "calibre_bopp" : "calibre";
    const { rows: calRows } = await client.query(
      `SELECT idcalibre FROM calibre WHERE ${calibreCol} = $1 LIMIT 1`, [calibreNum]
    );
    if (!calRows.length) return { idproducto_papel: null, idconfiguracion_plastico: null };
    const calibreId = calRows[0].idcalibre;
    const altura = Number(cat.altura) || 0;
    const ancho = Number(cat.ancho) || 0;
    const fuelleFondo = Number(cat.fuelle_fondo || cat.fuelle) || 0;
    const fuelleLat1 = Number(cat.fuelle_lateral_iz) || 0;
    const fuelleLat2 = Number(cat.fuelle_lateral_de) || 0;
    const refuerzo = Number(cat.refuerzo) || 0;
    if (!altura || !ancho) return { idproducto_papel: null, idconfiguracion_plastico: null };
    const porKilo = calcularPorKiloExpo(altura, ancho, fuelleFondo, fuelleLat1, fuelleLat2, refuerzo, calibreNum, factorMaterial);
    if (!porKilo) return { idproducto_papel: null, idconfiguracion_plastico: null };
    const partes: string[] = [String(altura)];
    if (fuelleFondo > 0) partes.push(String(fuelleFondo));
    if (refuerzo > 0) partes.push(String(refuerzo));
    const partesDer: string[] = [String(ancho)];
    if (fuelleLat1 > 0) partesDer.push(String(fuelleLat1));
    if (fuelleLat2 > 0 && fuelleLat2 !== fuelleLat1) partesDer.push(String(fuelleLat2));
    const medida = `${partes.join("+")}x${partesDer.join("+")}`;
    const { rows: cfgRows } = await client.query(`
      INSERT INTO configuracion_plastico (
        tipo_producto_plastico_plastico_idtipo_producto_plastico,
        material_plastico_plastico_idmaterial_plastico,
        calibre_idcalibre, altura, ancho, fuelle_fondo, fuelle_latiz, fuelle_latde,
        refuerzo, medida, por_kilo, origen_expo
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)
      ON CONFLICT DO NOTHING RETURNING idconfiguracion_plastico`,
      [tipoId, materialId, calibreId, altura, ancho, fuelleFondo, fuelleLat1, fuelleLat2, refuerzo, medida, porKilo]
    );
    let configId: number;
    if (cfgRows.length > 0) {
      configId = cfgRows[0].idconfiguracion_plastico;
    } else {
      const { rows: ex } = await client.query(`
        SELECT idconfiguracion_plastico FROM configuracion_plastico
        WHERE tipo_producto_plastico_plastico_idtipo_producto_plastico=$1
          AND material_plastico_plastico_idmaterial_plastico=$2
          AND calibre_idcalibre=$3 AND altura=$4 AND ancho=$5
          AND fuelle_fondo=$6 AND fuelle_latiz=$7 AND fuelle_latde=$8 AND refuerzo=$9
        LIMIT 1`,
        [tipoId, materialId, calibreId, altura, ancho, fuelleFondo, fuelleLat1, fuelleLat2, refuerzo]
      );
      if (!ex.length) return { idproducto_papel: null, idconfiguracion_plastico: null };
      configId = ex[0].idconfiguracion_plastico;
    }
    return { idproducto_papel: null, idconfiguracion_plastico: configId };
  }

  if (cat.categoria === "papel" || cat.categoria === "carton") {
    const idproductos = cat.categoria === "carton" ? 3 : 2;
    const tipoStr = (cat.tipo_producto || "").toLowerCase();
    const { rows: tpRows } = await client.query(
      `SELECT idcat_tipo_producto_papel FROM cat_tipo_producto_papel WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
      [`%${tipoStr}%`]
    );
    if (!tpRows.length) return { idproducto_papel: null, idconfiguracion_plastico: null };
    const idcatTipoProductoPapel = tpRows[0].idcat_tipo_producto_papel;
    const { rows: tmatRows } = await client.query(
      `SELECT idcat_tipo_papel FROM cat_tipo_papel WHERE LOWER(nombre) = LOWER($1) LIMIT 1`,
      [cat.material || ""]
    );
    const idcatTipoPapel = tmatRows[0]?.idcat_tipo_papel ?? null;
    let idcatCalibre: number | null = null;
    if (cat.calibre) {
      const { rows: calRows } = await client.query(
        `SELECT idcat_calibre FROM cat_calibre WHERE LOWER(nombre) = LOWER($1) LIMIT 1`,
        [cat.calibre]
      );
      idcatCalibre = calRows[0]?.idcat_calibre ?? null;
    }
    const altura = Number(cat.altura) || null;
    const ancho = Number(cat.ancho) || null;
    const fuelle = Number(cat.fuelle || cat.fuelle_fondo) || null;
    const medida = [altura, fuelle, ancho].filter(Boolean).length >= 2
      ? `${altura || ""}${fuelle ? "+" + fuelle : ""}x${ancho || ""}` : null;
    const { rows: ppExist } = await client.query(`
      SELECT pp.idproducto_papel FROM producto_papel pp
      WHERE pp.idproductos=$1 AND pp.idcat_tipo_producto_papel=$2
        AND (pp.ancho=$3 OR ($3 IS NULL AND pp.ancho IS NULL))
        AND (pp.altura=$4 OR ($4 IS NULL AND pp.altura IS NULL))
        AND (pp.fuelle=$5 OR ($5 IS NULL AND pp.fuelle IS NULL))
      LIMIT 1`, [idproductos, idcatTipoProductoPapel, ancho, altura, fuelle]
    );
    let idproductoPapel: number;
    if (ppExist.length > 0) {
      idproductoPapel = ppExist[0].idproducto_papel;
    } else {
      const { rows: ppRows } = await client.query(`
        INSERT INTO producto_papel (idproductos, idcat_tipo_producto_papel, ancho, fuelle, altura, medida, descripcion_papel, activo, origen_expo)
        VALUES ($1,$2,$3,$4,$5,$6,$7,true,true) RETURNING idproducto_papel`,
        [idproductos, idcatTipoProductoPapel, ancho, fuelle, altura, medida, cat.nombre]
      );
      idproductoPapel = ppRows[0].idproducto_papel;
      const { rows: gpRows } = await client.query(`
        INSERT INTO grupo_papel (idproducto_papel, precio_sugerido, orden)
        VALUES ($1,NULL,1) RETURNING idgrupo_papel`, [idproductoPapel]
      );
      const idgrupoPapel = gpRows[0].idgrupo_papel;
      if (idcatTipoPapel && idcatCalibre) {
        await client.query(`
          INSERT INTO detalle_material_papel (idgrupo_papel, idcat_tipo_papel, idcat_calibre, orden)
          VALUES ($1,$2,$3,1)`, [idgrupoPapel, idcatTipoPapel, idcatCalibre]
        );
      }
    }
    return { idproducto_papel: idproductoPapel, idconfiguracion_plastico: null };
  }

  return { idproducto_papel: null, idconfiguracion_plastico: null };
}

async function convertirProductoExpoASistema(
  client: any, idsolicitudProducto: number, nombre: string
): Promise<string | null> {
  const { rows: spRows } = await client.query(`
    SELECT sp.configuracion_plastico_idconfiguracion_plastico AS cfg_id,
           sp.tipo_material, sp.descripcion
    FROM solicitud_producto sp WHERE sp.idsolicitud_producto=$1`, [idsolicitudProducto]
  );
  if (!spRows.length) return null;
  const sp = spRows[0];
  if (sp.cfg_id != null) return null;
  if (sp.tipo_material === "papel") return null;
  if (sp.tipo_material !== "expo") return null;
  const nombreBuscar = (sp.descripcion || nombre || "").trim();
  if (!nombreBuscar) return `Producto expo sin nombre. Revisar en SIGEB.`;
  const { rows: catRows } = await client.query(`
    SELECT ce.categoria, ce.material, ce.calibre, ce.tipo_producto,
           ce.altura, ce.ancho, ce.fuelle, ce.fuelle_fondo,
           ce.fuelle_lateral_iz, ce.fuelle_lateral_de, ce.refuerzo,
           ce.idproducto_papel, ce.idconfiguracion_plastico, ce.nombre, ce.imagen_url
    FROM catalogo_expo ce
    WHERE LOWER(ce.nombre) = LOWER($1) AND ce.activo=true LIMIT 1`, [nombreBuscar]
  );
  if (!catRows.length) return null;
  const cat = catRows[0];
  if (cat.idconfiguracion_plastico) {
    await client.query(`
      UPDATE solicitud_producto
      SET configuracion_plastico_idconfiguracion_plastico=$1, tipo_material='plastico'
      WHERE idsolicitud_producto=$2`, [cat.idconfiguracion_plastico, idsolicitudProducto]
    );
    return null;
  }
  if (cat.idproducto_papel) {
    const { rows: sppCheck } = await client.query(
      `SELECT 1 FROM solicitud_producto_papel WHERE idsolicitud_producto=$1`, [idsolicitudProducto]
    );
    if (!sppCheck.length) {
      await client.query(`
        INSERT INTO solicitud_producto_papel (idsolicitud_producto, uv, alto_relieve, lleva_armado)
        VALUES ($1,false,false,true) ON CONFLICT (idsolicitud_producto) DO NOTHING`, [idsolicitudProducto]
      );
    }
    await client.query(`
      UPDATE solicitud_producto
      SET tipo_material='papel', producto_papel_idproducto_papel=$1
      WHERE idsolicitud_producto=$2`, [cat.idproducto_papel, idsolicitudProducto]
    );
    return null;
  }
  const fks = await resolverFKsProductoExpo(client, {
    categoria: cat.categoria, nombre: cat.nombre,
    material: cat.material, calibre: cat.calibre, tipo_producto: cat.tipo_producto,
    altura: cat.altura, ancho: cat.ancho, fuelle: cat.fuelle,
    fuelle_fondo: cat.fuelle_fondo, fuelle_lateral_iz: cat.fuelle_lateral_iz,
    fuelle_lateral_de: cat.fuelle_lateral_de, refuerzo: cat.refuerzo,
  });
  if (fks.idconfiguracion_plastico) {
    let imagenBackfill: string | null = null;
    if (!cat.imagen_url) {
      const idArchivo = await buscarImagenSistema(client, fks);
      if (idArchivo) imagenBackfill = construirUrlArchivoEstable(idArchivo);
    }
    await client.query(
      `UPDATE catalogo_expo SET idconfiguracion_plastico=$1, imagen_url = COALESCE(imagen_url, $3)
       WHERE LOWER(nombre)=LOWER($2)`,
      [fks.idconfiguracion_plastico, nombreBuscar, imagenBackfill]
    );
    await client.query(`
      UPDATE solicitud_producto
      SET configuracion_plastico_idconfiguracion_plastico=$1, tipo_material='plastico'
      WHERE idsolicitud_producto=$2`, [fks.idconfiguracion_plastico, idsolicitudProducto]
    );
    return null;
  }
  if (fks.idproducto_papel) {
    let imagenBackfill: string | null = null;
    if (!cat.imagen_url) {
      const idArchivo = await buscarImagenSistema(client, fks);
      if (idArchivo) imagenBackfill = construirUrlArchivoEstable(idArchivo);
    }
    await client.query(
      `UPDATE catalogo_expo SET idproducto_papel=$1, imagen_url = COALESCE(imagen_url, $3)
       WHERE LOWER(nombre)=LOWER($2)`,
      [fks.idproducto_papel, nombreBuscar, imagenBackfill]
    );
    const { rows: sppCheck } = await client.query(
      `SELECT 1 FROM solicitud_producto_papel WHERE idsolicitud_producto=$1`, [idsolicitudProducto]
    );
    if (!sppCheck.length) {
      await client.query(`
        INSERT INTO solicitud_producto_papel (idsolicitud_producto, uv, alto_relieve, lleva_armado)
        VALUES ($1,false,false,true) ON CONFLICT (idsolicitud_producto) DO NOTHING`, [idsolicitudProducto]
      );
    }
    await client.query(`
      UPDATE solicitud_producto
      SET tipo_material='papel', producto_papel_idproducto_papel=$1
      WHERE idsolicitud_producto=$2`, [fks.idproducto_papel, idsolicitudProducto]
    );
    return null;
  }
  return null;
}

export const aprobarCotizacionExpo = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { folio } = req.params;
    const { itemsAprobados } = req.body;
    if (!itemsAprobados?.length) return res.status(400).json({ error: "Selecciona al menos un producto" });
    await client.query("BEGIN");
    const { rows: solRows } = await client.query(
      `SELECT idsolicitud,estado,no_pedido,sin_iva,moneda,tipo_cambio FROM solicitud
       WHERE no_cotizacion=$1 AND origen_expo=true`, [folio]
    );
    if (!solRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "No encontrada" });
    }
    const sol = solRows[0];
    if (sol.estado !== "cotizacion") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Ya fue convertida a pedido" });
    }
    const folioPedido = await obtenerSiguienteFolioPedido(client);
    await client.query(`
      UPDATE solicitud_detalle SET aprobado=false
      WHERE solicitud_producto_id IN (
        SELECT idsolicitud_producto FROM solicitud_producto WHERE solicitud_idsolicitud=$1
      )`, [sol.idsolicitud]
    );
    const detalleIds = itemsAprobados
      .map((i: any) => i.idsolicitud_detalle)
      .filter((id: any) => id && id > 0);
    if (detalleIds.length > 0) {
      await client.query(
        `UPDATE solicitud_detalle SET aprobado=true WHERE idsolicitud_detalle=ANY($1::int[])`,
        [detalleIds]
      );
    }
    await client.query(`
      DELETE FROM solicitud_detalle
      WHERE solicitud_producto_id IN (
        SELECT idsolicitud_producto FROM solicitud_producto WHERE solicitud_idsolicitud=$1
      ) AND (aprobado IS NULL OR aprobado=false)`, [sol.idsolicitud]
    );
    const { rows: expoProds } = await client.query(`
      SELECT sp.idsolicitud_producto, COALESCE(sp.descripcion,'Producto expo') AS nombre_prod
      FROM solicitud_producto sp
      WHERE sp.solicitud_idsolicitud=$1 AND sp.tipo_material='expo'
        AND sp.configuracion_plastico_idconfiguracion_plastico IS NULL
        AND EXISTS (
          SELECT 1 FROM solicitud_detalle sd
          WHERE sd.solicitud_producto_id=sp.idsolicitud_producto AND sd.aprobado=true
        )`, [sol.idsolicitud]
    );
    const advertencias: string[] = [];
    for (const prod of expoProds) {
      const adv = await convertirProductoExpoASistema(client, prod.idsolicitud_producto, prod.nombre_prod);
      if (adv) advertencias.push(adv);
    }
    await client.query(`
      UPDATE solicitud SET estado='pedido', no_pedido=$1, fecha_aprobacion=NOW(),
        estado_administrativo_cat_idestado_administrativo_cat=$2
      WHERE idsolicitud=$3`,
      [folioPedido, ESTADO.APROBADO, sol.idsolicitud]
    );
    const { rows: stRows } = await client.query(`
      SELECT COALESCE(SUM(sd.precio_total),0) AS subtotal
      FROM solicitud_producto sp
      LEFT JOIN solicitud_detalle sd ON sd.solicitud_producto_id=sp.idsolicitud_producto
      WHERE sp.solicitud_idsolicitud=$1`, [sol.idsolicitud]
    );
    await crearVentaYDiseno(
      client, sol.idsolicitud, folioPedido, Number(stRows[0].subtotal), sol.sin_iva,
      sol.moneda ?? "MXN", sol.tipo_cambio ?? null,
    );
    await client.query("COMMIT");
    return res.json({
      message: "Cotización aprobada y convertida a pedido",
      no_pedido: folioPedido, no_cotizacion: folio,
      advertencias: advertencias.length > 0 ? advertencias : undefined,
    });
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error("❌ [EXPO] APROBAR:", e.message);
    return res.status(500).json({ error: e.message });
  } finally { client.release(); }
};

export const eliminarCotizacionExpo = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { folio } = req.params;
    await client.query("BEGIN");
    const { rows: solRows } = await client.query(
      `SELECT idsolicitud,estado FROM solicitud WHERE no_cotizacion=$1 AND origen_expo=true`, [folio]
    );
    if (!solRows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "No encontrada" }); }
    if (solRows[0].estado === "pedido") { await client.query("ROLLBACK"); return res.status(400).json({ error: "No se puede eliminar un pedido" }); }
    const solicitudId = solRows[0].idsolicitud;
    const { rows: prodRows } = await client.query(
      `SELECT idsolicitud_producto FROM solicitud_producto WHERE solicitud_idsolicitud=$1`, [solicitudId]
    );
    const ids = prodRows.map((r: any) => r.idsolicitud_producto);
    if (ids.length > 0) {
      await client.query(`DELETE FROM solicitud_producto_papel WHERE idsolicitud_producto=ANY($1::int[])`, [ids]);
      await client.query(`DELETE FROM solicitud_detalle WHERE solicitud_producto_id=ANY($1::int[])`, [ids]);
      await client.query(`DELETE FROM solicitud_producto WHERE solicitud_idsolicitud=$1`, [solicitudId]);
    }
    await client.query(`DELETE FROM solicitud WHERE idsolicitud=$1`, [solicitudId]);
    await client.query("COMMIT");
    return res.json({ message: "Cotización eliminada" });
  } catch (e: any) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e.message });
  } finally { client.release(); }
};

// ═══════════════════════════════════════════════════════════
// NUEVO: OPCIONES DE REGISTRO EXPO
// ═══════════════════════════════════════════════════════════

export const getOpcionesRegistroExpo = async (_req: Request, res: Response) => {
  try {
    const { rows: papelRaw } = await pool.query(`
      SELECT
        pp.idproducto_papel AS id,
        CASE WHEN pp.idproductos = 3 THEN 'carton' ELSE 'papel' END AS categoria,
        ctp.nombre AS tipo_producto,
        pp.descripcion_papel AS descripcion,
        pp.medida,
        pp.ancho,
        pp.fuelle,
        pp.altura,
        pp.tamano_prod AS id_tamano_producto,
        ctm.nombre AS tamano_prod,
        ctm.nombre AS tamano_producto,
        pp.costo_laminado,
        pp.precio_500,
        pp.precio_1000,
        pp.precio_3000,

        COALESCE(materiales.items, '[]'::json) AS materiales,
        COALESCE(grupos.items, '[]'::json) AS grupos,
        COALESCE(laminados.items, '[]'::json) AS laminados,
        COALESCE(asas.items, '[]'::json) AS asas,

        laminado_preferido.idcat_laminado AS idcat_laminado_default,
        laminado_preferido.nombre AS tipo_laminado_default,
        asa_preferida.idcat_tipo_asa AS idcat_tipo_asa_default,
        asa_preferida.nombre AS tipo_asa_default,

        tf.cantidad AS tintas_frente_default,
        td.cantidad AS tintas_dentro_default,

        pad.idfoil_default,
        (pad.idfoil_default IS NOT NULL) AS hs,
        CASE
          WHEN fo.idfoil IS NOT NULL
          THEN CONCAT(
            fo.colorfoil,
            CASE
              WHEN fo.codigofoil IS NOT NULL
              THEN ' ' || fo.codigofoil
              ELSE ''
            END
          )
        END AS tipo_hs,

        COALESCE(pad.alto_relieve_default, false) AS ar,
        pad.idcat_textura_default,
        (pad.idcat_textura_default IS NOT NULL) AS textura,
        tex.nombre AS tipo_textura,
        COALESCE(pad.uv_default, false) AS uv,

        img.public_id AS imagen_public_id

      FROM producto_papel pp

      LEFT JOIN cat_tipo_producto_papel ctp
        ON ctp.idcat_tipo_producto_papel =
           pp.idcat_tipo_producto_papel

      LEFT JOIN cat_tamano_producto ctm
        ON ctm.idcat_tamano_producto = pp.tamano_prod

      LEFT JOIN producto_acabado_default pad
        ON pad.idproducto_papel = pp.idproducto_papel

      LEFT JOIN foil fo
        ON fo.idfoil = pad.idfoil_default

      LEFT JOIN cat_textura tex
        ON tex.idcat_textura = pad.idcat_textura_default

      LEFT JOIN tintas tf
        ON tf.idtintas = pad.idtintas_frente_default

      LEFT JOIN tintas td
        ON td.idtintas = pad.idtintas_dentro_default

      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'idgrupo_papel', gp.idgrupo_papel,
            'precio_sugerido', gp.precio_sugerido,
            'idcat_tipo_papel', dmp.idcat_tipo_papel,
            'tipo_papel', ctp2.nombre,
            'idcat_calibre', dmp.idcat_calibre,
            'calibre', cc.nombre
          )
          ORDER BY gp.orden, dmp.orden
        ) AS items
        FROM grupo_papel gp
        JOIN detalle_material_papel dmp
          ON dmp.idgrupo_papel = gp.idgrupo_papel
        LEFT JOIN cat_tipo_papel ctp2
          ON ctp2.idcat_tipo_papel = dmp.idcat_tipo_papel
        LEFT JOIN cat_calibre cc
          ON cc.idcat_calibre = dmp.idcat_calibre
        WHERE gp.idproducto_papel = pp.idproducto_papel
      ) materiales ON true

      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'idgrupo_papel', gp.idgrupo_papel,
            'precio_sugerido', gp.precio_sugerido,
            'orden', gp.orden,
            'materiales', COALESCE(detalles.items, '[]'::json)
          )
          ORDER BY gp.orden, gp.idgrupo_papel
        ) AS items
        FROM grupo_papel gp
        LEFT JOIN LATERAL (
          SELECT json_agg(
            json_build_object(
              'iddetalle_material', dmp.iddetalle_material,
              'orden', dmp.orden,
              'idcat_tipo_papel', dmp.idcat_tipo_papel,
              'tipo_papel', ctp2.nombre,
              'idcat_calibre', dmp.idcat_calibre,
              'calibre', cc.nombre
            )
            ORDER BY dmp.orden, dmp.iddetalle_material
          ) AS items
          FROM detalle_material_papel dmp
          LEFT JOIN cat_tipo_papel ctp2
            ON ctp2.idcat_tipo_papel = dmp.idcat_tipo_papel
          LEFT JOIN cat_calibre cc
            ON cc.idcat_calibre = dmp.idcat_calibre
          WHERE dmp.idgrupo_papel = gp.idgrupo_papel
        ) detalles ON true
        WHERE gp.idproducto_papel = pp.idproducto_papel
      ) grupos ON true

      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id', opciones.idcat_laminado,
            'nombre', opciones.nombre
          )
          ORDER BY opciones.nombre
        ) AS items
        FROM (
          SELECT DISTINCT cl.idcat_laminado, cl.nombre
          FROM acabados_papel ap
          JOIN acabados_laminado al
            ON al.idacabados_papel = ap.idacabados_papel
          JOIN cat_laminado cl
            ON cl.idcat_laminado = al.idcat_laminado
          WHERE ap.idproducto_papel = pp.idproducto_papel
        ) opciones
      ) laminados ON true

      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id', opciones.idcat_tipo_asa,
            'nombre', opciones.nombre
          )
          ORDER BY opciones.nombre
        ) AS items
        FROM (
          SELECT DISTINCT ta.idcat_tipo_asa, ta.nombre
          FROM acabados_papel ap
          JOIN acabados_asas aa
            ON aa.idacabados_papel = ap.idacabados_papel
          JOIN cat_tipo_asa ta
            ON ta.idcat_tipo_asa = aa.idcat_tipo_asa
          WHERE ap.idproducto_papel = pp.idproducto_papel
        ) opciones
      ) asas ON true

      LEFT JOIN LATERAL (
        SELECT cl.idcat_laminado, cl.nombre
        FROM acabados_papel ap
        JOIN acabados_laminado al
          ON al.idacabados_papel = ap.idacabados_papel
        JOIN cat_laminado cl
          ON cl.idcat_laminado = al.idcat_laminado
        WHERE ap.idproducto_papel = pp.idproducto_papel
        ORDER BY
          CASE WHEN al.idcat_laminado = pad.idcat_laminado_default THEN 0 ELSE 1 END,
          al.idacabados_laminado
        LIMIT 1
      ) laminado_preferido ON true

      LEFT JOIN LATERAL (
        SELECT ta.idcat_tipo_asa, ta.nombre
        FROM acabados_papel ap
        JOIN acabados_asas aa
          ON aa.idacabados_papel = ap.idacabados_papel
        JOIN cat_tipo_asa ta
          ON ta.idcat_tipo_asa = aa.idcat_tipo_asa
        WHERE ap.idproducto_papel = pp.idproducto_papel
        ORDER BY
          CASE WHEN aa.idcat_tipo_asa = pad.idcat_tipo_asa_default THEN 0 ELSE 1 END,
          aa.idacabados_asa
        LIMIT 1
      ) asa_preferida ON true

      LEFT JOIN LATERAL (
        SELECT public_id
        FROM archivos
        WHERE idproducto_papel = pp.idproducto_papel
          AND categoria = 'imagen-suaje-papel'
        ORDER BY id_archivo DESC
        LIMIT 1
      ) img ON true

      WHERE pp.activo = true
        AND COALESCE(pp.origen_expo, false) = false

      ORDER BY ctp.nombre, pp.medida
    `);

    const papel = await Promise.all(
      papelRaw.map(async row => {
        const { imagen_public_id, ...rest } = row;

        return {
          ...rest,
          categoria: row.categoria,
          imagen_url: imagen_public_id
            ? await getPresignedUrl(imagen_public_id)
            : null,
        };
      })
    );

    const { rows: plasticoRaw } = await pool.query(`
      SELECT
  cp.idconfiguracion_plastico AS id,
  tpp.material_plastico_producto AS tipo_producto,

  cp.descripcion,

  mp.tipo_material AS material,

  CASE
    WHEN UPPER(mp.tipo_material) = 'BOPP'
      THEN cal.calibre_bopp
    ELSE cal.calibre
  END::text AS calibre,

  cp.medida,
  cp.altura,
  cp.ancho,
  cp.fuelle_fondo,
  cp.fuelle_latiz AS fuelle_lateral_izquierdo,
  cp.fuelle_latde AS fuelle_lateral_derecho,
  cp.refuerzo,
        cp.por_kilo,
        cp.tamano_prod,
        cp.precio_500,
        cp.precio_1000,
        cp.precio_3000,

        pad.pigmento_default AS pigmento,
        tf.cantidad AS tintas_frente_default,

        img.public_id AS imagen_public_id

      FROM configuracion_plastico cp

      LEFT JOIN tipo_producto_plastico tpp
        ON tpp.idtipo_producto_plastico =
           cp.tipo_producto_plastico_plastico_idtipo_producto_plastico

      LEFT JOIN material_plastico mp
        ON mp.idmaterial_plastico =
           cp.material_plastico_plastico_idmaterial_plastico

      LEFT JOIN calibre cal
        ON cal.idcalibre = cp.calibre_idcalibre

      LEFT JOIN producto_acabado_default pad
        ON pad.idconfiguracion_plastico =
           cp.idconfiguracion_plastico

      LEFT JOIN tintas tf
        ON tf.idtintas = pad.idtintas_frente_default

      LEFT JOIN LATERAL (
        SELECT public_id
        FROM archivos
        WHERE idconfiguracion_plastico =
              cp.idconfiguracion_plastico
          AND categoria = 'imagen-producto-plastico'
        ORDER BY id_archivo DESC
        LIMIT 1
      ) img ON true

      WHERE cp.activo = true
        AND COALESCE(cp.origen_expo, false) = false

      ORDER BY tpp.material_plastico_producto, cp.medida
    `);

    const plastico = await Promise.all(
      plasticoRaw.map(async row => {
        const { imagen_public_id, ...rest } = row;

        return {
          ...rest,
          categoria: "plastico",
          imagen_url: imagen_public_id
            ? await getPresignedUrl(imagen_public_id)
            : null,
        };
      })
    );

    const { rows: tamanos } = await pool.query(`
      SELECT
        idcat_tamano_producto AS id,
        clave,
        nombre
      FROM cat_tamano_producto
      WHERE activo = TRUE
      ORDER BY idcat_tamano_producto
    `);

    return res.json({
      papel,
      plastico,
      tamanos,
    });
  } catch (error: any) {
    console.error(
      "❌ GET OPCIONES REGISTRO EXPO:",
      error.message
    );

    return res.status(500).json({
      error: "No se pudieron cargar los productos del sistema",
      detalle: error.message,
    });
  }
};