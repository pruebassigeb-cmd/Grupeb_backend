import { PoolClient } from "pg";
import { pool } from "../../config/db";
import { construirDiff } from "../../middlewares/auditoria";

/**
 * FICHA DE ORDEN DE DISEÑO — servicio
 *
 * Toda escritura recibe el `client` de una transacción abierta por
 * req.tx(), para que los triggers de auditoría sepan quién es el
 * usuario. Las lecturas van directo al pool.
 */

export interface UbicacionInput {
  zona?: string | null;
  descripcion_libre?: string | null;
  imagen_id?: number | null;
  pin_x?: number | null;
  pin_y?: number | null;
}

export type TipoElemento = "acabado" | "red_social" | "texto";

export interface DetalleInput {
  idficha_detalle?: number;
  tipo_elemento: TipoElemento;
  nombre: string;
  detalle?: string | null;
  url?: string | null;
  ubicaciones?: UbicacionInput[];
}

export interface PantoneInput {
  codigo: string;
  hex_referencia?: string | null;
  cara?: "fuera" | "dentro" | null;
}

const ETIQUETAS: Record<string, string> = {
  compromiso_entrega: "compromiso de entrega",
  fecha_conclusion: "fecha de conclusión",
  comentarios: "comentarios",
  especificacion: "especificación",
  estado: "estado",
};

// ============================================================
// LECTURA
// ============================================================

export const getFichaPorOrden = async (ordenDisenoId: number) => {
  // escala_pin no está en la vista: se toma de la tabla para no
  // tener que recrear vw_ficha_completa.
  const result = await pool.query(
    `SELECT v.*, f.escala_pin
       FROM vw_ficha_completa v
       JOIN orden_diseno_ficha f ON f.idficha = v.idficha
      WHERE v.orden_diseno_id = $1`,
    [ordenDisenoId]
  );
  return result.rows[0] ?? null;
};

export const getSugerencias = async (texto = "", limite = 10) => {
  const result = await pool.query(
    `SELECT nombre, veces FROM fn_sugerencias_acabado($1, $2)`,
    [texto, limite]
  );
  return result.rows;
};

export const getRedesCliente = async (idclientes: number) => {
  const result = await pool.query(
    `SELECT idcliente_red, red, usuario, url
       FROM cliente_red_social
      WHERE idclientes = $1
        AND activo = true
        AND eliminado_at IS NULL
      ORDER BY red`,
    [idclientes]
  );
  return result.rows;
};

// ============================================================
// CREACIÓN
//
// El snapshot se arma aquí, una sola vez. A partir de este punto
// la ficha ya no consulta el producto: si mañana cambia el
// calibre del catálogo, esta ficha conserva el que se pactó.
// ============================================================

/**
 * Lee el producto de la solicitud y arma la especificación.
 *
 * Vive aparte porque la usan dos caminos: crear la ficha y
 * refrescarla cuando el pedido cambió. Si estuviera duplicada,
 * tarde o temprano las dos versiones dirían cosas distintas.
 */
export const construirEspecificacion = async (
  client: PoolClient,
  solicitudProductoId: number
) => {
  const spec = await client.query(
    `SELECT sp.idsolicitud_producto,
            sp.tipo_material,
            sp.producto_papel_idproducto_papel                  AS idproducto_papel,
            sp.configuracion_plastico_idconfiguracion_plastico  AS idconfiguracion_plastico,
            sp.pantones,
            sp.pigmentos,
            sp.descripcion,
            sp.observacion,

            -- Catálogos resueltos a su valor, no al id
            ti.cantidad          AS tintas,
            ca.cantidad          AS caras,
            sj.tipo              AS suaje,

            -- Papel
            pp.medida            AS papel_medida,
            pp.descripcion_papel AS papel_descripcion,
            tpp.nombre           AS papel_tipo,
            spp.tamano_asa,
            asa.nombre           AS asa_tipo,
            lam.nombre           AS laminado,
            tex.nombre           AS textura,
            fo.colorfoil         AS foil,
            spp.uv,
            spp.alto_relieve,
            spp.lleva_armado,
            spp.metodo_hojeado,
            spp.pantones_dentro,
            tid.cantidad         AS tintas_dentro,

            -- Plástico
            cp.medida            AS plastico_medida,
            cp.identificador     AS plastico_identificador,
            cp.descripcion       AS plastico_descripcion,
            mp.tipo_material     AS plastico_material,
            tpl.material_plastico_producto AS plastico_tipo,
            cal.calibre          AS plastico_calibre

       FROM solicitud_producto sp
       LEFT JOIN tintas ti  ON ti.idtintas = sp.tintas_idtintas
       LEFT JOIN caras  ca  ON ca.idcaras  = sp.caras_idcaras
       LEFT JOIN asa_suaje sj ON sj.idsuaje = sp.idsuaje

       LEFT JOIN producto_papel pp
              ON pp.idproducto_papel = sp.producto_papel_idproducto_papel
       LEFT JOIN cat_tipo_producto_papel tpp
              ON tpp.idcat_tipo_producto_papel = pp.idcat_tipo_producto_papel
       LEFT JOIN solicitud_producto_papel spp
              ON spp.idsolicitud_producto = sp.idsolicitud_producto
       LEFT JOIN cat_tipo_asa asa ON asa.idcat_tipo_asa   = spp.id_asa
       LEFT JOIN cat_laminado lam ON lam.idcat_laminado   = spp.idcat_laminado
       LEFT JOIN cat_textura  tex ON tex.idcat_textura    = spp.idcat_textura
       LEFT JOIN foil         fo  ON fo.idfoil            = spp.idfoil
       LEFT JOIN tintas       tid ON tid.idtintas         = spp.tintas_dentro_idtintas

       LEFT JOIN configuracion_plastico cp
              ON cp.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
       LEFT JOIN material_plastico mp
              ON mp.idmaterial_plastico = cp.material_plastico_plastico_idmaterial_plastico
       LEFT JOIN tipo_producto_plastico tpl
              ON tpl.idtipo_producto_plastico = cp.tipo_producto_plastico_plastico_idtipo_producto_plastico
       LEFT JOIN calibre cal
              ON cal.idcalibre = cp.calibre_idcalibre

      WHERE sp.idsolicitud_producto = $1`,
    [solicitudProductoId]
  );

  if (spec.rows.length === 0) {
    throw new Error("El producto de la solicitud no existe");
  }

  const s = spec.rows[0];

  // tipo_material se normaliza porque el default de la tabla es
  // 'plastico' y basta un espacio o una mayúscula para que la
  // comparación estricta mande el producto a la rama equivocada.
  const material = String(s.tipo_material ?? "").trim().toLowerCase();
  const esPapel =
    material === "papel" ||
    (material !== "plastico" && s.idproducto_papel !== null);

  // Solo entran los campos con valor. Un snapshot lleno de guiones
  // no le dice nada a quien lo lee.
  const limpiar = (obj: Record<string, any>) =>
    Object.fromEntries(
      Object.entries(obj).filter(
        ([, v]) => v !== null && v !== undefined && v !== ""
      )
    );

  const booleano = (v: any) => (v === true ? "Sí" : v === false ? "No" : null);

  const especificacion = esPapel
    ? limpiar({
        producto: s.papel_tipo,
        medida: s.papel_medida,
        descripcion: s.papel_descripcion,
        asa: s.asa_tipo,
        tamano_asa: s.tamano_asa,
        tintas: s.tintas,
        tintas_dentro: s.tintas_dentro,
        caras: s.caras,
        laminado: s.laminado,
        textura: s.textura,
        hot_stamping: s.foil,
        uv: booleano(s.uv),
        alto_relieve: booleano(s.alto_relieve),
        armado: booleano(s.lleva_armado),
        hojeado: s.metodo_hojeado,
        suaje: s.suaje,
        pigmentos: s.pigmentos,
        observacion: s.observacion,
      })
    : limpiar({
        producto: s.plastico_tipo,
        identificador: s.plastico_identificador,
        medida: s.plastico_medida,
        material: s.plastico_material,
        calibre: s.plastico_calibre,
        tintas: s.tintas,
        caras: s.caras,
        suaje: s.suaje,
        descripcion: s.plastico_descripcion,
        pigmentos: s.pigmentos,
        observacion: s.observacion,
      });

  // La familia decide qué zonas se ofrecen al ubicar los pines.
  const familia = /caja/i.test(s.papel_tipo ?? s.plastico_tipo ?? "")
    ? "caja"
    : "bolsa";

  return {
    especificacion,
    familia,
    esPapel,
    tipo_material: esPapel ? "papel" : "plastico",
    idproducto_papel: esPapel ? s.idproducto_papel : null,
    idconfiguracion_plastico: esPapel ? null : s.idconfiguracion_plastico,
    pantones: (s.pantones ?? null) as string | null,
    pantones_dentro: (s.pantones_dentro ?? null) as string | null,
  };
};

export const crearFicha = async (
  client: PoolClient,
  datos: {
    orden_diseno_id: number;
    solicitud_producto_id: number;
    compromiso_entrega?: string | null;
  }
) => {
  const snap = await construirEspecificacion(client, datos.solicitud_producto_id);

  const ficha = await client.query(
    `INSERT INTO orden_diseno_ficha
       (orden_diseno_id, solicitud_producto_id, tipo_material, familia,
        idproducto_papel, idconfiguracion_plastico,
        especificacion, compromiso_entrega)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING idficha, version`,
    [
      datos.orden_diseno_id,
      datos.solicitud_producto_id,
      snap.tipo_material,
      snap.familia,
      snap.idproducto_papel,
      snap.idconfiguracion_plastico,
      JSON.stringify(snap.especificacion),
      datos.compromiso_entrega ?? null,
    ]
  );

  const idficha = ficha.rows[0].idficha;

  // Los pantones vienen como texto libre en la solicitud.
  // Se parten por coma y se guardan como renglones contables.
  await migrarPantones(client, idficha, snap.pantones, "fuera");
  if (snap.esPapel) {
    await migrarPantones(client, idficha, snap.pantones_dentro, "dentro");
  }

  // Fotos ya registradas del producto, como imágenes iniciales
  await client.query(
    `INSERT INTO ficha_imagen (ficha_id, archivo_id, vista, es_principal, orden)
     SELECT $1, a.id_archivo, 'Frontal',
            row_number() OVER (ORDER BY a.id_archivo) = 1,
            row_number() OVER (ORDER BY a.id_archivo)
       FROM archivos a
      WHERE ($2::int IS NOT NULL AND a.idproducto_papel = $2)
         OR ($3::int IS NOT NULL AND a.idconfiguracion_plastico = $3)`,
    [
      idficha,
      snap.idproducto_papel,
      snap.idconfiguracion_plastico,
    ]
  );

  await publicarMensajeSistema(
    client,
    datos.orden_diseno_id,
    "Ficha de diseño creada"
  );

  return { idficha, version: ficha.rows[0].version };
};

const migrarPantones = async (
  client: PoolClient,
  idficha: number,
  texto: string | null,
  cara: "fuera" | "dentro"
) => {
  if (!texto) return;

  const codigos = texto
    .split(/[,;\n]/)
    .map((c) => c.trim())
    .filter(Boolean);

  for (let i = 0; i < codigos.length; i++) {
    try {
      await client.query(
        `INSERT INTO ficha_pantone (ficha_id, orden, codigo, cara)
         VALUES ($1, $2, $3, $4)`,
        [idficha, i + 1, codigos[i], cara]
      );
    } catch (error: any) {
      // El trigger de límite corta el excedente. No es un fallo:
      // el dato viejo venía como texto sin tope y puede traer más
      // de los que la máquina permite.
      if (error.code !== "23514") throw error;
      break;
    }
  }
};

// ============================================================
// GUARDADO DE DETALLES
//
// Se reemplazan por completo en cada guardado. Es más simple que
// diferenciar altas, bajas y cambios, y la bitácora conserva el
// histórico de todos modos.
// ============================================================

export const guardarDetalles = async (
  client: PoolClient,
  idficha: number,
  detalles: DetalleInput[]
) => {
  await client.query(
    `UPDATE ficha_detalle_ubicacion
        SET eliminado_at = now()
      WHERE eliminado_at IS NULL
        AND detalle_id IN (
            SELECT idficha_detalle FROM ficha_detalle
             WHERE ficha_id = $1 AND eliminado_at IS NULL)`,
    [idficha]
  );

  await client.query(
    `UPDATE ficha_detalle
        SET eliminado_at = now()
      WHERE ficha_id = $1 AND eliminado_at IS NULL`,
    [idficha]
  );

  for (let i = 0; i < detalles.length; i++) {
    const d = detalles[i];

    const res = await client.query(
      `INSERT INTO ficha_detalle
         (ficha_id, tipo_elemento, nombre, detalle, url, orden)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING idficha_detalle`,
      [
        idficha,
        d.tipo_elemento,
        d.nombre,
        d.detalle ?? null,
        d.url ?? null,
        i + 1,
      ]
    );

    const detalleId = res.rows[0].idficha_detalle;

    for (let j = 0; j < (d.ubicaciones ?? []).length; j++) {
      const u = d.ubicaciones![j];

      await client.query(
        `INSERT INTO ficha_detalle_ubicacion
           (detalle_id, zona, descripcion_libre, imagen_id, pin_x, pin_y, orden)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          detalleId,
          u.zona ?? null,
          u.descripcion_libre ?? null,
          u.imagen_id ?? null,
          u.pin_x ?? null,
          u.pin_y ?? null,
          j + 1,
        ]
      );
    }
  }

  // Sube el contador del catálogo con lo que se acaba de usar,
  // para que el desplegable ordene por frecuencia real.
  await contarUso(
    client,
    detalles,
    detalles.flatMap((d) => (d.ubicaciones ?? []).map((u) => u.zona ?? ""))
  );
};

// ============================================================
// CABECERA Y PANTONES
// ============================================================

// ============================================================
// CATÁLOGO AMPLIABLE DE ACABADOS Y ZONAS
//
// El desplegable arranca con una semilla y crece con el uso. Si
// el vendedor escribe algo que no está, lo agrega desde la misma
// pantalla y queda disponible para la próxima ficha.
//
// Se ordena por veces_usado y no alfabéticamente: lo que más se
// captura queda arriba, que es lo que ahorra clics de verdad.
// ============================================================

export interface OpcionCatalogo {
  idcatalogo_acabado: number;
  nombre: string;
  aplica_a: "papel" | "plastico" | "ambos";
  veces_usado: number;
}

export const getCatalogoAcabados = async (
  material?: "papel" | "plastico"
): Promise<OpcionCatalogo[]> => {
  const result = await pool.query(
    `SELECT idcatalogo_acabado, nombre, aplica_a, veces_usado
       FROM catalogo_acabado
      WHERE activo = true
        AND eliminado_at IS NULL
        AND tipo_elemento = 'acabado'
        AND ($1::text IS NULL OR aplica_a = $1 OR aplica_a = 'ambos')
      ORDER BY veces_usado DESC, nombre`,
    [material ?? null]
  );
  return result.rows;
};

/**
 * Alta desde la ficha. Si ya existe con otro uso de mayúsculas,
 * devuelve la que ya estaba en lugar de fallar: para el usuario
 * "Logo" y "logo" son lo mismo.
 */
export const crearOpcionCatalogo = async (
  client: PoolClient,
  datos: { nombre: string; aplica_a?: "papel" | "plastico" | "ambos" }
): Promise<OpcionCatalogo> => {
  const nombre = datos.nombre.trim();
  const aplicaA = datos.aplica_a ?? "ambos";

  if (!nombre) {
    throw new Error("El nombre de la opción no puede ir vacío");
  }

  const existente = await client.query(
    `SELECT idcatalogo_acabado, nombre, aplica_a, veces_usado
       FROM catalogo_acabado
      WHERE lower(nombre) = lower($1)
        AND aplica_a IN ($2, 'ambos')
        AND eliminado_at IS NULL
      LIMIT 1`,
    [nombre, aplicaA]
  );

  if (existente.rows.length > 0) {
    // Si estaba desactivada, se reactiva
    await client.query(
      `UPDATE catalogo_acabado SET activo = true
        WHERE idcatalogo_acabado = $1 AND activo = false`,
      [existente.rows[0].idcatalogo_acabado]
    );
    return existente.rows[0];
  }

  const nueva = await client.query(
    `INSERT INTO catalogo_acabado (nombre, aplica_a)
     VALUES ($1, $2)
     RETURNING idcatalogo_acabado, nombre, aplica_a, veces_usado`,
    [nombre, aplicaA]
  );

  return nueva.rows[0];
};

export const getZonas = async (familia = "bolsa") => {
  const result = await pool.query(
    `SELECT idcat_zona, clave, nombre, orden, personalizada
       FROM cat_zona_producto
      WHERE familia = $1 AND activo = true
      ORDER BY orden, veces_usado DESC, nombre`,
    [familia]
  );
  return result.rows;
};

/** La clave se deriva del nombre para que no haya que capturarla. */
export const crearZona = async (
  client: PoolClient,
  datos: { familia: string; nombre: string }
) => {
  const nombre = datos.nombre.trim();

  if (!nombre) {
    throw new Error("El nombre de la zona no puede ir vacío");
  }

  const clave = nombre
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

  const existente = await client.query(
    `SELECT idcat_zona, clave, nombre, orden, personalizada
       FROM cat_zona_producto
      WHERE familia = $1 AND lower(clave) = $2`,
    [datos.familia, clave]
  );

  if (existente.rows.length > 0) {
    await client.query(
      `UPDATE cat_zona_producto SET activo = true WHERE idcat_zona = $1`,
      [existente.rows[0].idcat_zona]
    );
    return existente.rows[0];
  }

  const nueva = await client.query(
    `INSERT INTO cat_zona_producto (familia, clave, nombre, orden, personalizada)
     VALUES ($1, $2, $3, 50, true)
     RETURNING idcat_zona, clave, nombre, orden, personalizada`,
    [datos.familia, clave, nombre]
  );

  return nueva.rows[0];
};

/**
 * Sube el contador de lo que se acaba de usar. Se llama al
 * guardar la ficha, en la misma transacción.
 *
 * Los nombres que no estén en el catálogo no se dan de alta
 * solos: si se agregaran automáticamente, cualquier error de
 * dedo quedaría en el desplegable para siempre.
 */
const contarUso = async (
  client: PoolClient,
  detalles: DetalleInput[],
  ubicaciones: string[]
) => {
  const nombres = detalles
    .filter((d) => d.tipo_elemento === "acabado" && d.nombre?.trim())
    .map((d) => d.nombre.trim().toLowerCase());

  if (nombres.length > 0) {
    await client.query(
      `UPDATE catalogo_acabado
          SET veces_usado = veces_usado + 1
        WHERE lower(nombre) = ANY($1::text[])
          AND eliminado_at IS NULL`,
      [nombres]
    );
  }

  const zonas = ubicaciones.filter(Boolean).map((z) => z.toLowerCase());

  if (zonas.length > 0) {
    await client.query(
      `UPDATE cat_zona_producto
          SET veces_usado = veces_usado + 1
        WHERE lower(clave) = ANY($1::text[])`,
      [zonas]
    );
  }
};

// ============================================================
// SINCRONÍA CON EL PRODUCTO
//
// La ficha congela el producto al crearse. Si el pedido se edita
// después, el usuario decide si trae los cambios — nunca se hace
// solo, porque cambiar la ficha bajo los pies del diseñador que
// ya entregó tres renders es justo lo que el snapshot evita.
// ============================================================

export interface CambioSnapshot {
  campo: string;
  antes: any;
  ahora: any;
}

const compararSnapshots = (
  antes: Record<string, any>,
  ahora: Record<string, any>
): CambioSnapshot[] => {
  const claves = new Set([
    ...Object.keys(antes ?? {}),
    ...Object.keys(ahora ?? {}),
  ]);
  const cambios: CambioSnapshot[] = [];

  claves.forEach((campo) => {
    const a = antes?.[campo] ?? null;
    const b = ahora?.[campo] ?? null;
    if (String(a) !== String(b)) {
      cambios.push({ campo, antes: a, ahora: b });
    }
  });

  return cambios;
};

/**
 * Compara el snapshot guardado contra el producto tal como está
 * hoy. No escribe nada: solo reporta.
 */
export const detectarCambiosProducto = async (
  idficha: number
): Promise<{ hayCambios: boolean; cambios: CambioSnapshot[] }> => {
  const client = await pool.connect();

  try {
    const ficha = await client.query(
      `SELECT solicitud_producto_id, especificacion
         FROM orden_diseno_ficha
        WHERE idficha = $1 AND eliminado_at IS NULL`,
      [idficha]
    );

    if (ficha.rows.length === 0 || !ficha.rows[0].solicitud_producto_id) {
      return { hayCambios: false, cambios: [] };
    }

    const actual = await construirEspecificacion(
      client,
      ficha.rows[0].solicitud_producto_id
    );

    const cambios = compararSnapshots(
      ficha.rows[0].especificacion,
      actual.especificacion
    );

    return { hayCambios: cambios.length > 0, cambios };
  } finally {
    client.release();
  }
};

/**
 * Trae los datos actuales del producto a la ficha.
 *
 * Solo toca lo que viene del producto: especificación, familia y
 * pantones. Acabados, pines, redes y comentarios son captura
 * humana y no se tocan nunca.
 */
export const refrescarSnapshot = async (
  client: PoolClient,
  idficha: number
): Promise<{ cambios: CambioSnapshot[]; especificacion: Record<string, any> }> => {
  const ficha = await client.query(
    `SELECT orden_diseno_id, solicitud_producto_id, especificacion
       FROM orden_diseno_ficha
      WHERE idficha = $1 AND eliminado_at IS NULL`,
    [idficha]
  );

  if (ficha.rows.length === 0) {
    throw new Error("La ficha no existe");
  }

  if (!ficha.rows[0].solicitud_producto_id) {
    throw new Error("La ficha no tiene producto asociado");
  }

  const actual = await construirEspecificacion(
    client,
    ficha.rows[0].solicitud_producto_id
  );

  const cambios = compararSnapshots(
    ficha.rows[0].especificacion,
    actual.especificacion
  );

  if (cambios.length === 0) {
    return { cambios: [], especificacion: ficha.rows[0].especificacion };
  }

  await client.query(
    `UPDATE orden_diseno_ficha
        SET especificacion_anterior = especificacion,
            especificacion          = $2,
            familia                 = $3,
            snapshot_at             = now()
      WHERE idficha = $1`,
    [idficha, JSON.stringify(actual.especificacion), actual.familia]
  );

  // Los pantones también vienen del producto
  await client.query(
    `UPDATE ficha_pantone SET eliminado_at = now()
      WHERE ficha_id = $1 AND eliminado_at IS NULL`,
    [idficha]
  );
  await migrarPantones(client, idficha, actual.pantones, "fuera");
  if (actual.esPapel) {
    await migrarPantones(client, idficha, actual.pantones_dentro, "dentro");
  }

  const resumen = cambios
    .slice(0, 4)
    .map((c) => `${c.campo}: ${c.antes ?? "vacío"} → ${c.ahora ?? "vacío"}`)
    .join(" · ");

  await publicarMensajeSistema(
    client,
    ficha.rows[0].orden_diseno_id,
    `Ficha actualizada con los cambios del producto — ${resumen}${
      cambios.length > 4 ? ` y ${cambios.length - 4} más` : ""
    }`
  );

  return { cambios, especificacion: actual.especificacion };
};

// ============================================================
// CABECERA Y PANTONES
// ============================================================

export const actualizarCabecera = async (
  client: PoolClient,
  idficha: number,
  datos: {
    compromiso_entrega?: string | null;
    fecha_conclusion?: string | null;
    comentarios?: string | null;
    escala_pin?: number | null;
  }
) => {
  await client.query(
    `UPDATE orden_diseno_ficha
        SET compromiso_entrega = COALESCE($2, compromiso_entrega),
            fecha_conclusion   = COALESCE($3, fecha_conclusion),
            comentarios        = $4,
            escala_pin         = COALESCE($5, escala_pin)
      WHERE idficha = $1
        AND eliminado_at IS NULL`,
    [
      idficha,
      datos.compromiso_entrega ?? null,
      datos.fecha_conclusion ?? null,
      datos.comentarios ?? null,
      datos.escala_pin ?? null,
    ]
  );
};

/**
 * Reemplazo completo, igual que los detalles. El trigger de la
 * base corta si se pasan del tope del material.
 */
export const guardarPantones = async (
  client: PoolClient,
  idficha: number,
  pantones: PantoneInput[]
) => {
  await client.query(
    `UPDATE ficha_pantone
        SET eliminado_at = now()
      WHERE ficha_id = $1 AND eliminado_at IS NULL`,
    [idficha]
  );

  const limpios = pantones.filter((p) => p.codigo && p.codigo.trim());

  for (let i = 0; i < limpios.length; i++) {
    const p = limpios[i];
    await client.query(
      `INSERT INTO ficha_pantone (ficha_id, orden, codigo, hex_referencia, cara)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        idficha,
        i + 1,
        p.codigo.trim(),
        p.hex_referencia ?? null,
        p.cara ?? null,
      ]
    );
  }
};

export const vincularImagen = async (
  client: PoolClient,
  idficha: number,
  datos: { archivo_id: number; vista?: string; es_principal?: boolean }
) => {
  const res = await client.query(
    `INSERT INTO ficha_imagen (ficha_id, archivo_id, vista, es_principal, orden)
     VALUES ($1, $2, $3, $4,
             COALESCE((SELECT max(orden) + 1 FROM ficha_imagen
                        WHERE ficha_id = $1 AND eliminado_at IS NULL), 1))
     RETURNING idficha_imagen`,
    [
      idficha,
      datos.archivo_id,
      datos.vista ?? "Frontal",
      datos.es_principal ?? false,
    ]
  );
  return res.rows[0];
};

// ============================================================
// PUBLICAR VERSIÓN
//
// Sube la versión y deja el mensaje de sistema con el diff que
// la propia bitácora acaba de registrar. No se recalcula nada.
// ============================================================
  
export const publicarFicha = async (
  client: PoolClient,
  idficha: number,
  ordenDisenoId: number
) => {
  const res = await client.query(
    `SELECT sp_publicar_ficha($1) AS version`,
    [idficha]
  );
  const version = res.rows[0].version;

  const cambio = await client.query(
    `SELECT idbitacora_cambio, datos_antes, datos_despues, campos_cambiados
       FROM bitacora_cambios
      WHERE tabla = 'orden_diseno_ficha'
        AND registro_id = $1
        AND accion = 'UPDATE'
      ORDER BY created_at DESC
      LIMIT 1`,
    [idficha]
  );

  let texto = `Ficha actualizada a v${version}`;
  let bitacoraId: number | null = null;

  if (cambio.rows.length > 0) {
    const c = cambio.rows[0];
    bitacoraId = c.idbitacora_cambio;

    const diff = construirDiff(
      c.datos_antes,
      c.datos_despues,
      c.campos_cambiados,
      ETIQUETAS
    ).filter((x) => x.campo !== "version" && x.campo !== "estado");

    if (diff.length > 0) {
      const lineas = diff
        .map((x) => `${x.etiqueta}: ${x.antes ?? "vacío"} → ${x.despues ?? "vacío"}`)
        .join(" · ");
      texto = `${texto} — ${lineas}`;
    }
  }

  await publicarMensajeSistema(client, ordenDisenoId, texto, bitacoraId);

  return version;
};

const publicarMensajeSistema = async (
  client: PoolClient,
  ordenDisenoId: number,
  contenido: string,
  bitacoraId: number | null = null
) => {
  await client.query(
    `INSERT INTO mensaje_diseno
       (orden_diseno_id, usuario_id, contenido, tipo, bitacora_id)
     VALUES ($1, NULL, $2, 'sistema', $3)`,
    [ordenDisenoId, contenido, bitacoraId]
  );
};