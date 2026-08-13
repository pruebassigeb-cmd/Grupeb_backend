// src/controllers/cotizadorLibre/cotizadorLibreCatalogo.controller.ts
import { Request, Response } from "express";
import { pool } from "../../config/db";
import { getPresignedUrl } from "../../config/multer";

// ============================================================================
// ⚠️ productos.idproductos = 1 corresponde a 'Plástico' — confirmado contra
// datos reales (SELECT idproductos, tipo_producto FROM productos), no por
// nombre de texto, para evitar problemas de codificación de acentos.
// Si algún día se reordena esa tabla catálogo, ajustar esta constante.
// ============================================================================
const ID_PRODUCTOS_PLASTICO = 1;

// ============================================================================
// Criterio de "producto calificado para el Cotizador Interactivo" (evita que
// el cliente externo vea tipos/medidas sin precio real registrado):
//
// - PAPEL: debe tener costo base (grupo_papel.precio_sugerido del Grupo 1,
//   es decir el de menor `orden` — mismo criterio que "Costo base" en la
//   tabla de admin, Papel.tsx) Y costo laminado
//   (producto_papel.costo_laminado) registrados. Ambos NOT NULL. Se resuelve
//   con un LATERAL join al grupo de menor orden (grupo1) en cada query.
// - PLÁSTICO: debe tener configuracion_plastico.por_kilo registrado
//   (NOT NULL y > 0 — por_kilo se deja en NULL cuando no se pudo calcular,
//   ver producto_papel_controller.ts línea ~606).
//
// Se aplica en tipos, medidas Y detalle, para que ni por URL directa se
// pueda llegar a un producto que no califica todavía.
// ============================================================================

// ==========================
// 1. TIPOS (categoría "Tipo" — Bolsas, Cajas, Sobres, Etiquetas, etc.)
// ==========================
export const getTiposCotizadorLibre = async (req: Request, res: Response) => {
  try {
    const categoria = String(req.query.categoria || "");

    if (categoria === "papel") {
      const { rows } = await pool.query(
        `SELECT t.idcat_tipo_producto_papel AS id, t.nombre
         FROM cat_tipo_producto_papel t
         WHERE t.activo = true
           AND EXISTS (
             SELECT 1
             FROM producto_papel p
             JOIN LATERAL (
               SELECT g1.precio_sugerido
               FROM grupo_papel g1
               WHERE g1.idproducto_papel = p.idproducto_papel
               ORDER BY g1.orden ASC
               LIMIT 1
             ) grupo1 ON true
             WHERE p.idcat_tipo_producto_papel = t.idcat_tipo_producto_papel
               AND p.activo = true
               AND (p.origen_expo IS NOT TRUE)
               AND grupo1.precio_sugerido IS NOT NULL
               AND p.costo_laminado IS NOT NULL
           )
         ORDER BY t.nombre`
      );
      const imagenes = await resolverImagenesCatalogo(
        rows.map((r: any) => ({ key: "tipo_producto", id: r.id }))
      );
      return res.json(
        rows.map((r: any) => ({
          ...r,
          imagenUrl: imagenes.get(`tipo_producto:${r.id}`) ?? null,
        }))
      );
    }

    if (categoria === "plastico") {
      // Solo se muestra al público lo que ya es un tipo de bolsa terminado
      // (Bolsa plana, troquelada, envíos, celofán, asa flexible...). El
      // resto (Bobina, Rollo perforado, Faldón, Lámina) son tipos que
      // todavía no están configurados como producto — no es que sean
      // materia prima, simplemente aún no tienen esa configuración. Filtro
      // dinámico por nombre, sin lista de IDs fija: cualquier tipo nuevo
      // que se llame "Bolsa ..." aparece solo, sin tocar este código.
      const { rows } = await pool.query(
        `SELECT t.idtipo_producto_plastico AS id, t.material_plastico_producto AS nombre
         FROM tipo_producto_plastico t
         WHERE t.activo = true
           AND t.productos_idproductos = $1
           AND LOWER(t.material_plastico_producto) LIKE '%bolsa%'
           AND EXISTS (
             SELECT 1
             FROM configuracion_plastico cp
             WHERE cp.tipo_producto_plastico_plastico_idtipo_producto_plastico = t.idtipo_producto_plastico
               AND cp.activo = true
               AND (cp.origen_expo IS NOT TRUE)
               AND cp.por_kilo IS NOT NULL
               AND cp.por_kilo > 0
           )
         ORDER BY t.material_plastico_producto`,
        [ID_PRODUCTOS_PLASTICO]
      );
      return res.json(rows);
    }

    return res.status(400).json({ error: "categoria debe ser 'papel' o 'plastico'." });
  } catch (error: any) {
    console.error("❌ GET TIPOS COTIZADOR LIBRE ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener el catálogo de tipos." });
  }
};

// ==========================
// 2. MEDIDAS (productos reales filtrados por tipo — la "medida" ES el
// producto específico, no un catálogo separado)
// ==========================
export const getMedidasCotizadorLibre = async (req: Request, res: Response) => {
  try {
    const categoria = String(req.query.categoria || "");
    const idTipo = Number(req.query.idTipo);

    if (!Number.isInteger(idTipo) || idTipo <= 0) {
      return res.status(400).json({ error: "idTipo es requerido y debe ser válido." });
    }

    if (categoria === "papel") {
      const { rows } = await pool.query(
        `SELECT p.idproducto_papel AS id, p.medida, p.ancho, p.fuelle, p.altura, p.descripcion_papel,
                img.public_id AS foto_public_id
         FROM producto_papel p
         JOIN LATERAL (
           -- Costo base = precio_sugerido del Grupo 1 (menor orden). Debe
           -- estar registrado para que el producto sea cotizable aquí.
           SELECT g1.precio_sugerido
           FROM grupo_papel g1
           WHERE g1.idproducto_papel = p.idproducto_papel
           ORDER BY g1.orden ASC
           LIMIT 1
         ) grupo1 ON true
         LEFT JOIN LATERAL (
           -- Foto real del producto (mismo mecanismo que ya usa Expo:
           -- archivos.idproducto_papel, distinto del sistema de imágenes
           -- de catálogo por catalogo_key/catalogo_id). Se toma la más
           -- reciente si hay varias.
           SELECT public_id FROM archivos
           WHERE idproducto_papel = p.idproducto_papel AND eliminado_at IS NULL
           ORDER BY id_archivo DESC
           LIMIT 1
         ) img ON true
         WHERE p.activo = true
           AND (p.origen_expo IS NOT TRUE)
           AND p.idcat_tipo_producto_papel = $1
           AND grupo1.precio_sugerido IS NOT NULL
           AND p.costo_laminado IS NOT NULL
         ORDER BY p.medida`,
        [idTipo]
      );

      const conImagen = await Promise.all(
        rows.map(async (r: any) => {
          let imagenUrl: string | null = null;
          if (r.foto_public_id) {
            try {
              imagenUrl = await getPresignedUrl(r.foto_public_id);
            } catch {
              imagenUrl = null;
            }
          }
          const { foto_public_id, ...resto } = r;
          return { ...resto, imagenUrl };
        })
      );

      return res.json(conImagen);
    }

    if (categoria === "plastico") {
      const { rows } = await pool.query(
        `SELECT cp.idconfiguracion_plastico AS id, cp.medida, cp.ancho, cp.altura,
                cp.fuelle_fondo, cp.fuelle_latiz, cp.fuelle_latde, cp.por_kilo,
                cp.descripcion, img.public_id AS foto_public_id
         FROM configuracion_plastico cp
         LEFT JOIN LATERAL (
           -- Mismo criterio de prioridad que getArchivosProducto() en
           -- productos-plastico_controller.ts: imagen-producto-plastico
           -- primero, luego render-plastico, luego master-plastico.
           SELECT public_id FROM archivos
           WHERE idconfiguracion_plastico = cp.idconfiguracion_plastico
             AND eliminado_at IS NULL
           ORDER BY
             CASE categoria
               WHEN 'imagen-producto-plastico' THEN 1
               WHEN 'render-plastico' THEN 2
               WHEN 'master-plastico' THEN 3
               ELSE 4
             END,
             id_archivo ASC
           LIMIT 1
         ) img ON true
         WHERE cp.activo = true
           AND (cp.origen_expo IS NOT TRUE)
           AND cp.tipo_producto_plastico_plastico_idtipo_producto_plastico = $1
           AND cp.por_kilo IS NOT NULL
           AND cp.por_kilo > 0
         ORDER BY cp.medida`,
        [idTipo]
      );

      const conImagen = await Promise.all(
        rows.map(async (r: any) => {
          let imagenUrl: string | null = null;
          if (r.foto_public_id) {
            try {
              imagenUrl = await getPresignedUrl(r.foto_public_id);
            } catch {
              imagenUrl = null;
            }
          }
          const { foto_public_id, ...resto } = r;
          return { ...resto, imagenUrl };
        })
      );

      return res.json(conImagen);
    }

    return res.status(400).json({ error: "categoria debe ser 'papel' o 'plastico'." });
  } catch (error: any) {
    console.error("❌ GET MEDIDAS COTIZADOR LIBRE ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener el catálogo de medidas." });
  }
};

// ==========================
// Helper — resuelve imágenes de catálogo desde `archivos` (patrón genérico:
// catalogo_key + catalogo_id, con catalogo_id = NULL para las globales).
// Para 'tipo_papel' y 'laminado', catalogo_id NO es el PK de la tabla cat_*
// — es insumo.idinsumo, vía la columna espejo insumo_idinsumo que ya trae
// cada fila de esos dos catálogos (ver insumoCatalogoBridge.ts).
// ==========================
type ImagenLookup = Map<string, string>;

async function resolverImagenesCatalogo(
  pares: Array<{ key: string; id: number | null }>
): Promise<ImagenLookup> {
  const lookup: ImagenLookup = new Map();
  if (pares.length === 0) return lookup;

  const condiciones: string[] = [];
  const valores: any[] = [];

  // Agrupa por key para armar "catalogo_key = $1 AND catalogo_id = ANY($2)"
  const idsPorKey = new Map<string, Set<number>>();
  const globalesKeys = new Set<string>();
  for (const p of pares) {
    if (p.id === null) {
      globalesKeys.add(p.key);
    } else {
      if (!idsPorKey.has(p.key)) idsPorKey.set(p.key, new Set());
      idsPorKey.get(p.key)!.add(p.id);
    }
  }

  for (const [key, ids] of idsPorKey) {
    valores.push(key, Array.from(ids));
    condiciones.push(`(catalogo_key = $${valores.length - 1} AND catalogo_id = ANY($${valores.length}::int[]))`);
  }
  if (globalesKeys.size > 0) {
    valores.push(Array.from(globalesKeys));
    condiciones.push(`(catalogo_key = ANY($${valores.length}::text[]) AND catalogo_id IS NULL)`);
  }
  if (condiciones.length === 0) return lookup;

  const { rows } = await pool.query(
    `SELECT catalogo_key, catalogo_id, public_id
     FROM archivos
     WHERE eliminado_at IS NULL AND (${condiciones.join(" OR ")})`,
    valores
  );

  await Promise.all(
    rows.map(async (row: any) => {
      try {
        const url = await getPresignedUrl(row.public_id);
        lookup.set(`${row.catalogo_key}:${row.catalogo_id ?? "global"}`, url);
      } catch (err) {
        console.error("⚠️ No se pudo firmar imagen de catálogo:", row.public_id);
      }
    })
  );

  return lookup;
}

// ==========================
// 3. DETALLE DE PRODUCTO — PAPEL
// (grupos = opciones de material; asas/laminados permitidos para ESE
// producto específico, vía las tablas de vínculo; texturas/foils sin
// restricción por producto, se ofrece el catálogo activo completo)
// ==========================
export const getDetalleProductoPapelCotizadorLibre = async (req: Request, res: Response) => {
  try {
    const idproducto_papel = Number(req.params.idproducto_papel);

    if (!Number.isInteger(idproducto_papel) || idproducto_papel <= 0) {
      return res.status(400).json({ error: "idproducto_papel inválido." });
    }

    const { rows: productoRows } = await pool.query(
      `SELECT p.idproducto_papel, p.medida, p.ancho, p.fuelle, p.altura, p.descripcion_papel, p.activo
       FROM producto_papel p
       JOIN LATERAL (
         SELECT g1.precio_sugerido
         FROM grupo_papel g1
         WHERE g1.idproducto_papel = p.idproducto_papel
         ORDER BY g1.orden ASC
         LIMIT 1
       ) grupo1 ON true
       WHERE p.idproducto_papel = $1 AND p.activo = true AND (p.origen_expo IS NOT TRUE)
         AND grupo1.precio_sugerido IS NOT NULL
         AND p.costo_laminado IS NOT NULL`,
      [idproducto_papel]
    );

    if (productoRows.length === 0) {
      return res.status(404).json({ error: "Producto no encontrado o inactivo." });
    }

    const { rows: grupos } = await pool.query(
      `SELECT g.idgrupo_papel, g.precio_sugerido, dm.idcat_tipo_papel, ctp.nombre AS material,
              ctp.insumo_idinsumo AS insumo_id_tipo_papel
       FROM grupo_papel g
       LEFT JOIN detalle_material_papel dm ON dm.idgrupo_papel = g.idgrupo_papel
       LEFT JOIN cat_tipo_papel ctp ON ctp.idcat_tipo_papel = dm.idcat_tipo_papel
       WHERE g.idproducto_papel = $1
       ORDER BY g.orden`,
      [idproducto_papel]
    );

    const { rows: asas } = await pool.query(
      `SELECT DISTINCT cta.idcat_tipo_asa AS id, cta.nombre
       FROM acabados_papel ap
       JOIN acabados_asas aa ON aa.idacabados_papel = ap.idacabados_papel
       JOIN cat_tipo_asa cta ON cta.idcat_tipo_asa = aa.idcat_tipo_asa
       WHERE ap.idproducto_papel = $1 AND cta.activo = true
       ORDER BY cta.nombre`,
      [idproducto_papel]
    );

    const { rows: laminados } = await pool.query(
      `SELECT DISTINCT cl.idcat_laminado AS id, cl.nombre, cl.insumo_idinsumo AS insumo_id_laminado
       FROM acabados_papel ap
       JOIN acabados_laminado al ON al.idacabados_papel = ap.idacabados_papel
       JOIN cat_laminado cl ON cl.idcat_laminado = al.idcat_laminado
       WHERE ap.idproducto_papel = $1 AND cl.activo = true
       ORDER BY cl.nombre`,
      [idproducto_papel]
    );

    const { rows: texturas } = await pool.query(
      `SELECT idcat_textura AS id, nombre FROM cat_textura WHERE activo = true ORDER BY nombre`
    );

    const { rows: foils } = await pool.query(
      `SELECT idfoil AS id, colorfoil AS nombre FROM foil WHERE activo = true ORDER BY colorfoil`
    );

    // Las 4 banderas viven directo en acabados_papel (1 fila por producto,
    // no una tabla de vínculo aparte) — determinan si el producto permite
    // cada acabado en absoluto, sin importar cuál opción específica se
    // elija después. Si el producto todavía no tiene fila en
    // acabados_papel, se asume que no permite ninguno (false por defecto).
    const { rows: acabadosRows } = await pool.query(
      `SELECT lleva_uv, lleva_alto_relieve, lleva_textura, lleva_hot_stamping
       FROM acabados_papel
       WHERE idproducto_papel = $1
       LIMIT 1`,
      [idproducto_papel]
    );
    const acabadosPermitidos = {
      uv: acabadosRows[0]?.lleva_uv === true,
      alto_relieve: acabadosRows[0]?.lleva_alto_relieve === true,
      textura: acabadosRows[0]?.lleva_textura === true,
      hot_stamping: acabadosRows[0]?.lleva_hot_stamping === true,
    };

    // ---- Imágenes de catálogo (patrón archivos.catalogo_key/catalogo_id) ----
    const pares: Array<{ key: string; id: number | null }> = [
      ...grupos
        .filter((g: any) => g.insumo_id_tipo_papel != null)
        .map((g: any) => ({ key: "tipo_papel", id: g.insumo_id_tipo_papel as number })),
      ...laminados
        .filter((l: any) => l.insumo_id_laminado != null)
        .map((l: any) => ({ key: "laminado", id: l.insumo_id_laminado as number })),
      ...asas.map((a: any) => ({ key: "tipo_asa", id: a.id as number })),
      ...texturas.map((t: any) => ({ key: "textura", id: t.id as number })),
      ...foils.map((f: any) => ({ key: "foil", id: f.id as number })),
      { key: "hs_ar", id: null },
      { key: "uv", id: null },
    ];
    const imagenes = await resolverImagenesCatalogo(pares);

    return res.json({
      producto: productoRows[0],
      grupos: grupos.map((g: any) => ({
        idgrupo_papel: g.idgrupo_papel,
        precio_sugerido: g.precio_sugerido,
        idcat_tipo_papel: g.idcat_tipo_papel,
        material: g.material,
        imagenUrl: g.insumo_id_tipo_papel != null ? imagenes.get(`tipo_papel:${g.insumo_id_tipo_papel}`) ?? null : null,
      })),
      asas: asas.map((a: any) => ({ ...a, imagenUrl: imagenes.get(`tipo_asa:${a.id}`) ?? null })),
      laminados: laminados.map((l: any) => ({
        id: l.id,
        nombre: l.nombre,
        imagenUrl: l.insumo_id_laminado != null ? imagenes.get(`laminado:${l.insumo_id_laminado}`) ?? null : null,
      })),
      texturas: texturas.map((t: any) => ({ ...t, imagenUrl: imagenes.get(`textura:${t.id}`) ?? null })),
      foils: foils.map((f: any) => ({ ...f, imagenUrl: imagenes.get(`foil:${f.id}`) ?? null })),
      linea: null, // pendiente — ver §5 de la especificación
      acabadosPermitidos,
      imagenesGlobales: {
        hotStamping: imagenes.get("hs_ar:global") ?? null,
        altoRelieve: imagenes.get("hs_ar:global") ?? null,
        uv: imagenes.get("uv:global") ?? null,
      },
    });
  } catch (error: any) {
    console.error("❌ GET DETALLE PRODUCTO PAPEL COTIZADOR LIBRE ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener el detalle del producto." });
  }
};

// ==========================
// 4. DETALLE DE PRODUCTO — PLÁSTICO
// (material/calibre ya son fijos en la fila de configuracion_plastico; la
// única personalización real disponible es el número de tintas)
// ==========================
export const getDetalleProductoPlasticoCotizadorLibre = async (req: Request, res: Response) => {
  try {
    const idconfiguracion_plastico = Number(req.params.idconfiguracion_plastico);

    if (!Number.isInteger(idconfiguracion_plastico) || idconfiguracion_plastico <= 0) {
      return res.status(400).json({ error: "idconfiguracion_plastico inválido." });
    }

    const { rows } = await pool.query(
      `SELECT cp.idconfiguracion_plastico, cp.medida, cp.ancho, cp.altura,
              cp.fuelle_fondo, cp.fuelle_latiz, cp.fuelle_latde, cp.por_kilo, cp.activo,
              mp.tipo_material AS material, c.calibre
       FROM configuracion_plastico cp
       LEFT JOIN material_plastico mp
         ON mp.idmaterial_plastico = cp.material_plastico_plastico_idmaterial_plastico
       LEFT JOIN calibre c ON c.idcalibre = cp.calibre_idcalibre
       WHERE cp.idconfiguracion_plastico = $1 AND cp.activo = true AND (cp.origen_expo IS NOT TRUE)
         AND cp.por_kilo IS NOT NULL AND cp.por_kilo > 0`,
      [idconfiguracion_plastico]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Producto no encontrado o inactivo." });
    }

    const { rows: tintas } = await pool.query(
      `SELECT idtintas AS id, cantidad FROM tintas WHERE cantidad IS NOT NULL ORDER BY cantidad`
    );

    return res.json({
      producto: rows[0],
      tintas,
    });
  } catch (error: any) {
    console.error("❌ GET DETALLE PRODUCTO PLASTICO COTIZADOR LIBRE ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener el detalle del producto." });
  }
};