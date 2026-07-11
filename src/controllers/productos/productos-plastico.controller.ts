// import { Request, Response } from "express";
// import { pool } from "../../config/db";
// import { getPresignedUrl } from "../../config/multer";

// // ═══════════════════════════════════════════════════════════════════════════
// // HELPER: query de duplicado (reutilizado por create / update / check).
// // Solo considera productos activos, para que un producto desactivado no
// // bloquee volver a registrar la misma combinación.
// // ═══════════════════════════════════════════════════════════════════════════
// async function buscarDuplicado(
//   client: any,
//   params: {
//     tipo_producto_plastico_id: number;
//     material_plastico_id: number;
//     calibre_id: number;
//     altura: number;
//     ancho: number;
//     fuelle_fondo: number;
//     fuelle_latIz: number;
//     fuelle_latDe: number;
//     refuerzo: number;
//     excluirId?: number;
//   }
// ) {
//   const excluir = params.excluirId ? `AND cp.idconfiguracion_plastico != $10` : "";
//   const values = [
//     params.tipo_producto_plastico_id,
//     params.material_plastico_id,
//     params.calibre_id,
//     params.altura,
//     params.ancho,
//     params.fuelle_fondo,
//     params.fuelle_latIz,
//     params.fuelle_latDe,
//     params.refuerzo,
//   ];
//   if (params.excluirId) values.push(params.excluirId);

//   const { rows } = await client.query(
//     `SELECT
//        cp.idconfiguracion_plastico,
//        cp.medida,
//        tpp.material_plastico_producto AS tipo_producto,
//        mp.tipo_material               AS material,
//        c.calibre
//      FROM configuracion_plastico cp
//      JOIN tipo_producto_plastico tpp
//          ON tpp.idtipo_producto_plastico = cp.tipo_producto_plastico_plastico_idtipo_producto_plastico
//      JOIN material_plastico mp
//          ON mp.idmaterial_plastico = cp.material_plastico_plastico_idmaterial_plastico
//      JOIN calibre c
//          ON c.idcalibre = cp.calibre_idcalibre
//      WHERE cp.tipo_producto_plastico_plastico_idtipo_producto_plastico = $1
//        AND cp.material_plastico_plastico_idmaterial_plastico            = $2
//        AND cp.calibre_idcalibre                                         = $3
//        AND cp.altura       = $4
//        AND cp.ancho        = $5
//        AND cp.fuelle_fondo = $6
//        AND cp.fuelle_latIz = $7
//        AND cp.fuelle_latDe = $8
//        AND cp.refuerzo     = $9
//        AND cp.activo       = true
//        ${excluir}
//      LIMIT 1`,
//     values
//   );
//   return rows[0] ?? null;
// }

// // ═══════════════════════════════════════════════════════════════════════════
// // HELPER: archivos del producto (categorías: imagen-producto-plastico,
// // render-plastico, master-plastico — guardados con carpeta="catalogoproductos"
// // y subcarpeta="plastico" en S3, ya existentes en tu config/multer.ts)
// // ═══════════════════════════════════════════════════════════════════════════
// async function getArchivosProducto(idconfiguracion_plastico: number) {
//   const { rows } = await pool.query(
//     `SELECT id_archivo, nombre, tipo, mime_type, public_id, tamano_kb, categoria
//      FROM archivos
//      WHERE idconfiguracion_plastico = $1
//      ORDER BY
//        CASE categoria
//          WHEN 'imagen-producto-plastico' THEN 1
//          WHEN 'render-plastico' THEN 2
//          WHEN 'master-plastico' THEN 3
//          ELSE 4
//        END,
//        id_archivo ASC`,
//     [idconfiguracion_plastico]
//   );

//   return Promise.all(
//     rows.map(async (a) => ({ ...a, url: await getPresignedUrl(a.public_id) }))
//   );
// }

// // ═══════════════════════════════════════════════════════════════════════════
// // CREAR PRODUCTO PLÁSTICO
// // (validateCreateProductoPlastico ya valida tipos/obligatoriedad antes de
// // llegar aquí — altura, ancho, medida y por_kilo llegan garantizados)
// // ═══════════════════════════════════════════════════════════════════════════
// export const createProductoPlastico = async (req: Request, res: Response) => {
//   const client = await pool.connect();

//   try {
//     const {
//       tipo_producto_plastico_id,
//       material_plastico_id,
//       calibre_id,
//       altura,
//       ancho,
//       fuelle_fondo,
//       fuelle_latIz,
//       fuelle_latDe,
//       refuerzo,
//       medida,
//       por_kilo,
//     } = req.body;

//     console.log("📝 Creando nuevo producto plástico:", { medida, por_kilo });

//     await client.query("BEGIN");

//     const [tipoProducto, material, calibre] = await Promise.all([
//       client.query(
//         "SELECT 1 FROM tipo_producto_plastico WHERE idtipo_producto_plastico = $1 AND activo = true",
//         [tipo_producto_plastico_id]
//       ),
//       client.query(
//         "SELECT 1 FROM material_plastico WHERE idmaterial_plastico = $1 AND activo = true",
//         [material_plastico_id]
//       ),
//       client.query(
//         "SELECT 1 FROM calibre WHERE idcalibre = $1 AND activo = true",
//         [calibre_id]
//       ),
//     ]);

//     if ((tipoProducto.rowCount ?? 0) === 0) {
//       await client.query("ROLLBACK");
//       return res.status(400).json({ error: "El tipo de producto seleccionado no existe o está inactivo" });
//     }
//     if ((material.rowCount ?? 0) === 0) {
//       await client.query("ROLLBACK");
//       return res.status(400).json({ error: "El material seleccionado no existe o está inactivo" });
//     }
//     if ((calibre.rowCount ?? 0) === 0) {
//       await client.query("ROLLBACK");
//       return res.status(400).json({ error: "El calibre seleccionado no existe o está inactivo" });
//     }

//     const duplicado = await buscarDuplicado(client, {
//       tipo_producto_plastico_id,
//       material_plastico_id,
//       calibre_id,
//       altura,
//       ancho,
//       fuelle_fondo: fuelle_fondo || 0,
//       fuelle_latIz: fuelle_latIz || 0,
//       fuelle_latDe: fuelle_latDe || 0,
//       refuerzo: refuerzo || 0,
//     });

//     if (duplicado) {
//       await client.query("ROLLBACK");
//       return res.status(409).json({
//         error: "Ya existe un producto con estas características",
//         detalle: `"${duplicado.tipo_producto} — ${duplicado.medida}" ya está registrado con el mismo material (${duplicado.material}), calibre (${duplicado.calibre}) y medidas.`,
//         producto_existente: { id: duplicado.idconfiguracion_plastico, medida: duplicado.medida },
//       });
//     }

//     // NOTA: origen_expo NO se manda aquí — este endpoint es el alta manual
//     // desde la página de Plástico, así que se queda en el DEFAULT false de
//     // la columna. Solo resolverFKsProductoExpo (creación automática desde
//     // Expo, en expoCatalogo.controller.ts) lo marca en true.
//     const result = await client.query(
//       `INSERT INTO configuracion_plastico (
//         material_plastico_plastico_idmaterial_plastico,
//         tipo_producto_plastico_plastico_idtipo_producto_plastico,
//         calibre_idcalibre,
//         altura,
//         fuelle_fondo,
//         refuerzo,
//         ancho,
//         fuelle_latIz,
//         fuelle_latDe,
//         medida,
//         por_kilo,
//         activo
//       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
//       RETURNING idconfiguracion_plastico, medida, por_kilo, identificador`,
//       [
//         material_plastico_id,
//         tipo_producto_plastico_id,
//         calibre_id,
//         altura,
//         fuelle_fondo || 0,
//         refuerzo || 0,
//         ancho,
//         fuelle_latIz || 0,
//         fuelle_latDe || 0,
//         medida,
//         por_kilo,
//       ]
//     );

//     const nuevoProducto = result.rows[0];
//     await client.query("COMMIT");

//     console.log("✅ Producto plástico creado:", nuevoProducto.idconfiguracion_plastico);

//     res.status(201).json({
//       message: "Producto creado exitosamente",
//       producto: {
//         id: nuevoProducto.idconfiguracion_plastico,
//         medida: nuevoProducto.medida,
//         por_kilo: nuevoProducto.por_kilo,
//         identificador: nuevoProducto.identificador,
//       },
//     });
//   } catch (error: any) {
//     await client.query("ROLLBACK");
//     console.error("❌ CREATE PRODUCTO PLÁSTICO ERROR:", error.message);
//     res.status(500).json({ error: "Error al procesar la solicitud" });
//   } finally {
//     client.release();
//   }
// };

// // ═══════════════════════════════════════════════════════════════════════════
// // OBTENER TODOS LOS PRODUCTOS (solo activos, con preview de archivos)
// // ═══════════════════════════════════════════════════════════════════════════
// export const getProductosPlastico = async (req: Request, res: Response) => {
//   try {
//     console.log("📋 Obteniendo todos los productos plástico");

//     const { rows } = await pool.query(`
//       SELECT
//         cp.idconfiguracion_plastico as id,
//         cp.altura,
//         cp.fuelle_fondo,
//         cp.refuerzo,
//         cp.ancho,
//         cp.fuelle_latIz as fuelle_lateral_izquierdo,
//         cp.fuelle_latDe as fuelle_lateral_derecho,
//         cp.medida,
//         cp.por_kilo,
//         cp.identificador,
//         cp.origen_expo,
//         tpp.material_plastico_producto as tipo_producto,
//         mp.tipo_material as material,
//         c.calibre,
//         arch_prev.archivos_raw
//       FROM configuracion_plastico cp
//       INNER JOIN tipo_producto_plastico tpp
//         ON cp.tipo_producto_plastico_plastico_idtipo_producto_plastico = tpp.idtipo_producto_plastico
//       INNER JOIN material_plastico mp
//         ON cp.material_plastico_plastico_idmaterial_plastico = mp.idmaterial_plastico
//       INNER JOIN calibre c
//         ON cp.calibre_idcalibre = c.idcalibre
//       LEFT JOIN LATERAL (
//         SELECT json_agg(
//           json_build_object(
//             'id_archivo', a.id_archivo,
//             'public_id',  a.public_id,
//             'categoria',  a.categoria,
//             'nombre',     a.nombre,
//             'tipo',       a.tipo
//           )
//           ORDER BY
//             CASE a.categoria
//               WHEN 'imagen-producto-plastico' THEN 1
//               WHEN 'render-plastico' THEN 2
//               WHEN 'master-plastico' THEN 3
//               ELSE 4
//             END,
//             a.id_archivo ASC
//         ) AS archivos_raw
//         FROM (
//           SELECT * FROM archivos
//           WHERE idconfiguracion_plastico = cp.idconfiguracion_plastico
//           ORDER BY
//             CASE categoria
//               WHEN 'imagen-producto-plastico' THEN 1
//               WHEN 'render-plastico' THEN 2
//               WHEN 'master-plastico' THEN 3
//               ELSE 4
//             END,
//             id_archivo ASC
//           LIMIT 3
//         ) a
//       ) arch_prev ON true
//       WHERE cp.activo = true
//       ORDER BY cp.idconfiguracion_plastico DESC
//       LIMIT 1000
//     `);

//     const rowsConUrls = await Promise.all(
//       rows.map(async (row) => {
//         const archivosRaw: any[] = row.archivos_raw ?? [];
//         const archivos_preview = await Promise.all(
//           archivosRaw.map(async (a) => ({
//             id_archivo: a.id_archivo,
//             nombre: a.nombre,
//             categoria: a.categoria,
//             tipo: a.tipo,
//             url: await getPresignedUrl(a.public_id),
//           }))
//         );
//         const { archivos_raw, ...rest } = row;
//         return { ...rest, archivos_preview };
//       })
//     );

//     console.log(`✅ ${rowsConUrls.length} productos obtenidos`);
//     res.json(rowsConUrls);
//   } catch (error: any) {
//     console.error("❌ GET PRODUCTOS PLÁSTICO ERROR:", error.message);
//     res.status(500).json({ error: "Error al obtener productos" });
//   }
// };

// // ═══════════════════════════════════════════════════════════════════════════
// // OBTENER PRODUCTO POR ID (incluye archivos completos)
// // ═══════════════════════════════════════════════════════════════════════════
// export const getProductoPlasticoById = async (req: Request, res: Response) => {
//   try {
//     const { id } = req.params;
//     console.log("🔍 Obteniendo producto plástico:", id);

//     const result = await pool.query(
//       `SELECT
//         cp.idconfiguracion_plastico as id,
//         cp.altura,
//         cp.fuelle_fondo,
//         cp.refuerzo,
//         cp.ancho,
//         cp.fuelle_latIz as fuelle_lateral_izquierdo,
//         cp.fuelle_latDe as fuelle_lateral_derecho,
//         cp.medida,
//         cp.por_kilo,
//         cp.identificador,
//         cp.activo,
//         cp.origen_expo,
//         cp.tipo_producto_plastico_plastico_idtipo_producto_plastico as tipo_producto_id,
//         cp.material_plastico_plastico_idmaterial_plastico as material_id,
//         cp.calibre_idcalibre as calibre_id,
//         tpp.material_plastico_producto as tipo_producto,
//         mp.tipo_material as material,
//         c.calibre
//       FROM configuracion_plastico cp
//       INNER JOIN tipo_producto_plastico tpp
//         ON cp.tipo_producto_plastico_plastico_idtipo_producto_plastico = tpp.idtipo_producto_plastico
//       INNER JOIN material_plastico mp
//         ON cp.material_plastico_plastico_idmaterial_plastico = mp.idmaterial_plastico
//       INNER JOIN calibre c
//         ON cp.calibre_idcalibre = c.idcalibre
//       WHERE cp.idconfiguracion_plastico = $1 AND cp.activo = true
//       LIMIT 1`,
//       [id]
//     );

//     if ((result.rowCount ?? 0) === 0) {
//       return res.status(404).json({ error: "Producto no encontrado" });
//     }

//     const producto = result.rows[0];
//     producto.archivos = await getArchivosProducto(Number(id));

//     console.log("✅ Producto obtenido:", producto.medida);
//     res.json(producto);
//   } catch (error: any) {
//     console.error("❌ GET PRODUCTO BY ID ERROR:", error.message);
//     res.status(500).json({ error: "Error al obtener producto" });
//   }
// };

// // ═══════════════════════════════════════════════════════════════════════════
// // ACTUALIZAR PRODUCTO
// // ═══════════════════════════════════════════════════════════════════════════
// export const updateProductoPlastico = async (req: Request, res: Response) => {
//   const client = await pool.connect();

//   try {
//     const { id } = req.params;
//     const {
//       tipo_producto_plastico_id,
//       material_plastico_id,
//       calibre_id,
//       altura,
//       ancho,
//       fuelle_fondo,
//       fuelle_latIz,
//       fuelle_latDe,
//       refuerzo,
//       medida,
//       por_kilo,
//     } = req.body;

//     console.log("📝 Actualizando producto plástico:", id);

//     await client.query("BEGIN");

//     const productoExiste = await client.query(
//       "SELECT 1 FROM configuracion_plastico WHERE idconfiguracion_plastico = $1 AND activo = true",
//       [id]
//     );
//     if ((productoExiste.rowCount ?? 0) === 0) {
//       await client.query("ROLLBACK");
//       return res.status(404).json({ error: "Producto no encontrado" });
//     }

//     const [tipoProducto, material, calibre] = await Promise.all([
//       client.query(
//         "SELECT 1 FROM tipo_producto_plastico WHERE idtipo_producto_plastico = $1 AND activo = true",
//         [tipo_producto_plastico_id]
//       ),
//       client.query(
//         "SELECT 1 FROM material_plastico WHERE idmaterial_plastico = $1 AND activo = true",
//         [material_plastico_id]
//       ),
//       client.query(
//         "SELECT 1 FROM calibre WHERE idcalibre = $1 AND activo = true",
//         [calibre_id]
//       ),
//     ]);

//     if ((tipoProducto.rowCount ?? 0) === 0) {
//       await client.query("ROLLBACK");
//       return res.status(400).json({ error: "El tipo de producto seleccionado no existe o está inactivo" });
//     }
//     if ((material.rowCount ?? 0) === 0) {
//       await client.query("ROLLBACK");
//       return res.status(400).json({ error: "El material seleccionado no existe o está inactivo" });
//     }
//     if ((calibre.rowCount ?? 0) === 0) {
//       await client.query("ROLLBACK");
//       return res.status(400).json({ error: "El calibre seleccionado no existe o está inactivo" });
//     }

//     const duplicado = await buscarDuplicado(client, {
//       tipo_producto_plastico_id,
//       material_plastico_id,
//       calibre_id,
//       altura,
//       ancho,
//       fuelle_fondo: fuelle_fondo || 0,
//       fuelle_latIz: fuelle_latIz || 0,
//       fuelle_latDe: fuelle_latDe || 0,
//       refuerzo: refuerzo || 0,
//       excluirId: Number(id),
//     });

//     if (duplicado) {
//       await client.query("ROLLBACK");
//       return res.status(409).json({
//         error: "Ya existe un producto con estas características",
//         detalle: `"${duplicado.tipo_producto} — ${duplicado.medida}" ya está registrado con el mismo material (${duplicado.material}), calibre (${duplicado.calibre}) y medidas.`,
//         producto_existente: { id: duplicado.idconfiguracion_plastico, medida: duplicado.medida },
//       });
//     }

//     // origen_expo tampoco se toca aquí — una vez marcado (por la creación
//     // automática desde Expo) se queda así aunque después se edite a mano
//     // desde esta página; solo cambian sus datos, no su origen.
//     const result = await client.query(
//       `UPDATE configuracion_plastico
//        SET
//          material_plastico_plastico_idmaterial_plastico = $1,
//          tipo_producto_plastico_plastico_idtipo_producto_plastico = $2,
//          calibre_idcalibre = $3,
//          altura = $4,
//          fuelle_fondo = $5,
//          refuerzo = $6,
//          ancho = $7,
//          fuelle_latIz = $8,
//          fuelle_latDe = $9,
//          medida = $10,
//          por_kilo = $11
//        WHERE idconfiguracion_plastico = $12
//        RETURNING idconfiguracion_plastico, medida, por_kilo`,
//       [
//         material_plastico_id,
//         tipo_producto_plastico_id,
//         calibre_id,
//         altura,
//         fuelle_fondo || 0,
//         refuerzo || 0,
//         ancho,
//         fuelle_latIz || 0,
//         fuelle_latDe || 0,
//         medida,
//         por_kilo,
//         id,
//       ]
//     );

//     const productoActualizado = result.rows[0];

//     // ── Reflejar el cambio en Catálogo Expo si algún registro apunta a este
//     // mismo producto (idconfiguracion_plastico). Igual que en papel: aquí no
//     // hace falta el checkeo de "uso externo" — el Sistema es la fuente de
//     // verdad, Expo solo debe reflejar la realidad.
//     const { rows: matCalRows } = await client.query(
//       `SELECT mp.tipo_material AS material, c.calibre
//        FROM material_plastico mp, calibre c
//        WHERE mp.idmaterial_plastico = $1 AND c.idcalibre = $2`,
//       [material_plastico_id, calibre_id]
//     );
//     const materialSync = matCalRows[0]?.material ?? null;
//     const calibreSync = matCalRows[0]?.calibre != null ? String(matCalRows[0].calibre) : null;

//     await client.query(
//       `UPDATE catalogo_expo SET
//          medida = COALESCE($1, medida),
//          material = COALESCE($2, material),
//          calibre = COALESCE($3, calibre)
//        WHERE idconfiguracion_plastico = $4 AND activo = true`,
//       [productoActualizado.medida || null, materialSync, calibreSync, id]
//     );

//     await client.query("COMMIT");

//     console.log("✅ Producto actualizado:", productoActualizado.idconfiguracion_plastico);
//     res.json({
//       message: "Producto actualizado exitosamente",
//       producto: {
//         id: productoActualizado.idconfiguracion_plastico,
//         medida: productoActualizado.medida,
//         por_kilo: productoActualizado.por_kilo,
//       },
//     });
//   } catch (error: any) {
//     await client.query("ROLLBACK");
//     console.error("❌ UPDATE PRODUCTO PLÁSTICO ERROR:", error.message);
//     res.status(500).json({ error: "Error al procesar la solicitud" });
//   } finally {
//     client.release();
//   }
// };

// // ═══════════════════════════════════════════════════════════════════════════
// // ELIMINAR PRODUCTO (SOFT-DELETE)
// // ═══════════════════════════════════════════════════════════════════════════
// export const deleteProductoPlastico = async (req: Request, res: Response) => {
//   const client = await pool.connect();
//   try {
//     const { id } = req.params;
//     console.log("🗑️ Desactivando producto plástico:", id);

//     await client.query("BEGIN");

//     const { rows } = await client.query(
//       `UPDATE configuracion_plastico SET activo = false
//        WHERE idconfiguracion_plastico = $1 AND activo = true
//        RETURNING idconfiguracion_plastico, medida`,
//       [id]
//     );

//     if (rows.length === 0) {
//       await client.query("ROLLBACK");
//       return res.status(404).json({ error: "Producto no encontrado" });
//     }

//     // Igual que en papel: si el producto ya no existe en el sistema,
//     // cualquier registro de Catálogo Expo que lo usaba queda obsoleto.
//     await client.query(
//       `UPDATE catalogo_expo SET activo = false WHERE idconfiguracion_plastico = $1 AND activo = true`,
//       [id]
//     );

//     await client.query("COMMIT");
//     console.log("✅ Producto desactivado:", rows[0].medida);
//     res.json({ message: "Producto eliminado correctamente" });
//   } catch (error: any) {
//     await client.query("ROLLBACK");
//     console.error("❌ DELETE PRODUCTO PLÁSTICO ERROR:", error.message);
//     res.status(500).json({ error: "Error al procesar la solicitud" });
//   } finally {
//     client.release();
//   }
// };

// // ═══════════════════════════════════════════════════════════════════════════
// // REACTIVAR PRODUCTO
// // ═══════════════════════════════════════════════════════════════════════════
// export const reactivarProductoPlastico = async (req: Request, res: Response) => {
//   try {
//     const { id } = req.params;
//     console.log("♻️ Reactivando producto plástico:", id);

//     const { rows } = await pool.query(
//       `UPDATE configuracion_plastico SET activo = true
//        WHERE idconfiguracion_plastico = $1 AND activo = false
//        RETURNING idconfiguracion_plastico, medida`,
//       [id]
//     );

//     if (rows.length === 0) {
//       return res.status(404).json({ error: "Producto no encontrado o ya está activo" });
//     }

//     console.log("✅ Producto reactivado:", rows[0].medida);
//     res.json({ message: "Producto reactivado correctamente" });
//   } catch (error: any) {
//     console.error("❌ REACTIVAR PRODUCTO PLÁSTICO ERROR:", error.message);
//     res.status(500).json({ error: "Error al procesar la solicitud" });
//   }
// };

// // ═══════════════════════════════════════════════════════════════════════════
// // VERIFICAR DUPLICADO (GET — sin crear)
// // ═══════════════════════════════════════════════════════════════════════════
// export const checkProductoDuplicado = async (req: Request, res: Response) => {
//   try {
//     const {
//       tipo_producto_plastico_id,
//       material_plastico_id,
//       calibre_id,
//       altura,
//       ancho,
//       fuelle_fondo = 0,
//       fuelle_latIz = 0,
//       fuelle_latDe = 0,
//       refuerzo = 0,
//     } = req.query;

//     const duplicado = await buscarDuplicado(pool, {
//       tipo_producto_plastico_id: Number(tipo_producto_plastico_id),
//       material_plastico_id: Number(material_plastico_id),
//       calibre_id: Number(calibre_id),
//       altura: Number(altura),
//       ancho: Number(ancho),
//       fuelle_fondo: Number(fuelle_fondo),
//       fuelle_latIz: Number(fuelle_latIz),
//       fuelle_latDe: Number(fuelle_latDe),
//       refuerzo: Number(refuerzo),
//     });

//     if (!duplicado) {
//       return res.json({ existe: false });
//     }

//     return res.json({
//       existe: true,
//       detalle: `"${duplicado.tipo_producto} — ${duplicado.medida}" ya está registrado con el mismo material (${duplicado.material}), calibre (${duplicado.calibre}) y medidas.`,
//       producto_existente: { id: duplicado.idconfiguracion_plastico, medida: duplicado.medida },
//     });
//   } catch (error: any) {
//     console.error("❌ CHECK DUPLICADO ERROR:", error.message);
//     return res.status(500).json({ error: "Error al verificar duplicado" });
//   }
// };
















import { Request, Response } from "express";
import { pool } from "../../config/db";
import { getPresignedUrl } from "../../config/multer";

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: query de duplicado (reutilizado por create / update / check).
// Solo considera productos activos, para que un producto desactivado no
// bloquee volver a registrar la misma combinación.
// ═══════════════════════════════════════════════════════════════════════════
async function buscarDuplicado(
  client: any,
  params: {
    tipo_producto_plastico_id: number;
    material_plastico_id: number;
    calibre_id: number;
    altura: number;
    ancho: number;
    fuelle_fondo: number;
    fuelle_latIz: number;
    fuelle_latDe: number;
    refuerzo: number;
    excluirId?: number;
  }
) {
  const excluir = params.excluirId ? `AND cp.idconfiguracion_plastico != $10` : "";
  const values = [
    params.tipo_producto_plastico_id,
    params.material_plastico_id,
    params.calibre_id,
    params.altura,
    params.ancho,
    params.fuelle_fondo,
    params.fuelle_latIz,
    params.fuelle_latDe,
    params.refuerzo,
  ];
  if (params.excluirId) values.push(params.excluirId);

  const { rows } = await client.query(
    `SELECT
       cp.idconfiguracion_plastico,
       cp.medida,
       tpp.material_plastico_producto AS tipo_producto,
       mp.tipo_material               AS material,
       c.calibre
     FROM configuracion_plastico cp
     JOIN tipo_producto_plastico tpp
         ON tpp.idtipo_producto_plastico = cp.tipo_producto_plastico_plastico_idtipo_producto_plastico
     JOIN material_plastico mp
         ON mp.idmaterial_plastico = cp.material_plastico_plastico_idmaterial_plastico
     JOIN calibre c
         ON c.idcalibre = cp.calibre_idcalibre
     WHERE cp.tipo_producto_plastico_plastico_idtipo_producto_plastico = $1
       AND cp.material_plastico_plastico_idmaterial_plastico            = $2
       AND cp.calibre_idcalibre                                         = $3
       AND cp.altura       = $4
       AND cp.ancho        = $5
       AND cp.fuelle_fondo = $6
       AND cp.fuelle_latIz = $7
       AND cp.fuelle_latDe = $8
       AND cp.refuerzo     = $9
       AND cp.activo       = true
       ${excluir}
     LIMIT 1`,
    values
  );
  return rows[0] ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: archivos del producto (categorías: imagen-producto-plastico,
// render-plastico, master-plastico — guardados con carpeta="catalogoproductos"
// y subcarpeta="plastico" en S3, ya existentes en tu config/multer.ts)
// ═══════════════════════════════════════════════════════════════════════════
async function getArchivosProducto(idconfiguracion_plastico: number) {
  const { rows } = await pool.query(
    `SELECT id_archivo, nombre, tipo, mime_type, public_id, tamano_kb, categoria
     FROM archivos
     WHERE idconfiguracion_plastico = $1
     ORDER BY
       CASE categoria
         WHEN 'imagen-producto-plastico' THEN 1
         WHEN 'render-plastico' THEN 2
         WHEN 'master-plastico' THEN 3
         ELSE 4
       END,
       id_archivo ASC`,
    [idconfiguracion_plastico]
  );

  return Promise.all(
    rows.map(async (a) => ({ ...a, url: await getPresignedUrl(a.public_id) }))
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CREAR PRODUCTO PLÁSTICO
// (validateCreateProductoPlastico ya valida tipos/obligatoriedad antes de
// llegar aquí — altura, ancho, medida y por_kilo llegan garantizados)
// ═══════════════════════════════════════════════════════════════════════════
export const createProductoPlastico = async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const {
      tipo_producto_plastico_id,
      material_plastico_id,
      calibre_id,
      altura,
      ancho,
      fuelle_fondo,
      fuelle_latIz,
      fuelle_latDe,
      refuerzo,
      medida,
      por_kilo,
    } = req.body;

    console.log("📝 Creando nuevo producto plástico:", { medida, por_kilo });

    await client.query("BEGIN");

    const [tipoProducto, material, calibre] = await Promise.all([
      client.query(
        "SELECT 1 FROM tipo_producto_plastico WHERE idtipo_producto_plastico = $1 AND activo = true",
        [tipo_producto_plastico_id]
      ),
      client.query(
        "SELECT 1 FROM material_plastico WHERE idmaterial_plastico = $1 AND activo = true",
        [material_plastico_id]
      ),
      client.query(
        "SELECT 1 FROM calibre WHERE idcalibre = $1 AND activo = true",
        [calibre_id]
      ),
    ]);

    if ((tipoProducto.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El tipo de producto seleccionado no existe o está inactivo" });
    }
    if ((material.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El material seleccionado no existe o está inactivo" });
    }
    if ((calibre.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El calibre seleccionado no existe o está inactivo" });
    }

    const duplicado = await buscarDuplicado(client, {
      tipo_producto_plastico_id,
      material_plastico_id,
      calibre_id,
      altura,
      ancho,
      fuelle_fondo: fuelle_fondo || 0,
      fuelle_latIz: fuelle_latIz || 0,
      fuelle_latDe: fuelle_latDe || 0,
      refuerzo: refuerzo || 0,
    });

    if (duplicado) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Ya existe un producto con estas características",
        detalle: `"${duplicado.tipo_producto} — ${duplicado.medida}" ya está registrado con el mismo material (${duplicado.material}), calibre (${duplicado.calibre}) y medidas.`,
        producto_existente: { id: duplicado.idconfiguracion_plastico, medida: duplicado.medida },
      });
    }

    // NOTA: origen_expo NO se manda aquí — este endpoint es el alta manual
    // desde la página de Plástico, así que se queda en el DEFAULT false de
    // la columna. Solo resolverFKsProductoExpo (creación automática desde
    // Expo, en expoCatalogo.controller.ts) lo marca en true.
    const result = await client.query(
      `INSERT INTO configuracion_plastico (
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
        por_kilo,
        activo
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
      RETURNING idconfiguracion_plastico, medida, por_kilo, identificador`,
      [
        material_plastico_id,
        tipo_producto_plastico_id,
        calibre_id,
        altura,
        fuelle_fondo || 0,
        refuerzo || 0,
        ancho,
        fuelle_latIz || 0,
        fuelle_latDe || 0,
        medida,
        por_kilo,
      ]
    );

    const nuevoProducto = result.rows[0];
    await client.query("COMMIT");

    console.log("✅ Producto plástico creado:", nuevoProducto.idconfiguracion_plastico);

    res.status(201).json({
      message: "Producto creado exitosamente",
      producto: {
        id: nuevoProducto.idconfiguracion_plastico,
        medida: nuevoProducto.medida,
        por_kilo: nuevoProducto.por_kilo,
        identificador: nuevoProducto.identificador,
      },
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ CREATE PRODUCTO PLÁSTICO ERROR:", error.message);
    res.status(500).json({ error: "Error al procesar la solicitud" });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// OBTENER TODOS LOS PRODUCTOS (solo activos, con preview de archivos)
// ═══════════════════════════════════════════════════════════════════════════
export const getProductosPlastico = async (req: Request, res: Response) => {
  try {
    console.log("📋 Obteniendo todos los productos plástico");

    const { rows } = await pool.query(`
      SELECT
        cp.idconfiguracion_plastico as id,
        cp.altura,
        cp.fuelle_fondo,
        cp.refuerzo,
        cp.ancho,
        cp.fuelle_latIz as fuelle_lateral_izquierdo,
        cp.fuelle_latDe as fuelle_lateral_derecho,
        cp.medida,
        cp.por_kilo,
        cp.identificador,
        cp.origen_expo,
        cp.tamano_prod,
        cp.precio_500,
        cp.precio_1000,
        cp.precio_3000,
        tpp.material_plastico_producto as tipo_producto,
        mp.tipo_material as material,
        c.calibre,
        arch_prev.archivos_raw
      FROM configuracion_plastico cp
      LEFT JOIN tipo_producto_plastico tpp
        ON cp.tipo_producto_plastico_plastico_idtipo_producto_plastico = tpp.idtipo_producto_plastico
      LEFT JOIN material_plastico mp
        ON cp.material_plastico_plastico_idmaterial_plastico = mp.idmaterial_plastico
      LEFT JOIN calibre c
        ON cp.calibre_idcalibre = c.idcalibre
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id_archivo', a.id_archivo,
            'public_id',  a.public_id,
            'categoria',  a.categoria,
            'nombre',     a.nombre,
            'tipo',       a.tipo
          )
          ORDER BY
            CASE a.categoria
              WHEN 'imagen-producto-plastico' THEN 1
              WHEN 'render-plastico' THEN 2
              WHEN 'master-plastico' THEN 3
              ELSE 4
            END,
            a.id_archivo ASC
        ) AS archivos_raw
        FROM (
          SELECT * FROM archivos
          WHERE idconfiguracion_plastico = cp.idconfiguracion_plastico
          ORDER BY
            CASE categoria
              WHEN 'imagen-producto-plastico' THEN 1
              WHEN 'render-plastico' THEN 2
              WHEN 'master-plastico' THEN 3
              ELSE 4
            END,
            id_archivo ASC
          LIMIT 3
        ) a
      ) arch_prev ON true
      WHERE cp.activo = true
      ORDER BY cp.idconfiguracion_plastico DESC
      LIMIT 1000
    `);

    const rowsConUrls = await Promise.all(
      rows.map(async (row) => {
        const archivosRaw: any[] = row.archivos_raw ?? [];
        const archivos_preview = await Promise.all(
          archivosRaw.map(async (a) => ({
            id_archivo: a.id_archivo,
            nombre: a.nombre,
            categoria: a.categoria,
            tipo: a.tipo,
            url: await getPresignedUrl(a.public_id),
          }))
        );
        const { archivos_raw, ...rest } = row;
        return { ...rest, archivos_preview };
      })
    );

    console.log(`✅ ${rowsConUrls.length} productos obtenidos`);
    res.json(rowsConUrls);
  } catch (error: any) {
    console.error("❌ GET PRODUCTOS PLÁSTICO ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener productos" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// OBTENER PRODUCTO POR ID (incluye archivos completos)
// ═══════════════════════════════════════════════════════════════════════════
export const getProductoPlasticoById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    console.log("🔍 Obteniendo producto plástico:", id);

    const result = await pool.query(
      `SELECT
        cp.idconfiguracion_plastico as id,
        cp.altura,
        cp.fuelle_fondo,
        cp.refuerzo,
        cp.ancho,
        cp.fuelle_latIz as fuelle_lateral_izquierdo,
        cp.fuelle_latDe as fuelle_lateral_derecho,
        cp.medida,
        cp.por_kilo,
        cp.identificador,
        cp.activo,
        cp.origen_expo,
        cp.tamano_prod,
        cp.precio_500,
        cp.precio_1000,
        cp.precio_3000,
        cp.tipo_producto_plastico_plastico_idtipo_producto_plastico as tipo_producto_id,
        cp.material_plastico_plastico_idmaterial_plastico as material_id,
        cp.calibre_idcalibre as calibre_id,
        tpp.material_plastico_producto as tipo_producto,
        mp.tipo_material as material,
        c.calibre
      FROM configuracion_plastico cp
      LEFT JOIN tipo_producto_plastico tpp
        ON cp.tipo_producto_plastico_plastico_idtipo_producto_plastico = tpp.idtipo_producto_plastico
      LEFT JOIN material_plastico mp
        ON cp.material_plastico_plastico_idmaterial_plastico = mp.idmaterial_plastico
      LEFT JOIN calibre c
        ON cp.calibre_idcalibre = c.idcalibre
      WHERE cp.idconfiguracion_plastico = $1 AND cp.activo = true
      LIMIT 1`,
      [id]
    );

    if ((result.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    const producto = result.rows[0];
    producto.archivos = await getArchivosProducto(Number(id));

    console.log("✅ Producto obtenido:", producto.medida);
    res.json(producto);
  } catch (error: any) {
    console.error("❌ GET PRODUCTO BY ID ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener producto" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ACTUALIZAR PRODUCTO
// ═══════════════════════════════════════════════════════════════════════════
export const updateProductoPlastico = async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const {
      tipo_producto_plastico_id,
      material_plastico_id,
      calibre_id,
      altura,
      ancho,
      fuelle_fondo,
      fuelle_latIz,
      fuelle_latDe,
      refuerzo,
      medida,
      por_kilo,
    } = req.body;

    console.log("📝 Actualizando producto plástico:", id);

    await client.query("BEGIN");

    const productoExiste = await client.query(
      "SELECT 1 FROM configuracion_plastico WHERE idconfiguracion_plastico = $1 AND activo = true",
      [id]
    );
    if ((productoExiste.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    const [tipoProducto, material, calibre] = await Promise.all([
      client.query(
        "SELECT 1 FROM tipo_producto_plastico WHERE idtipo_producto_plastico = $1 AND activo = true",
        [tipo_producto_plastico_id]
      ),
      client.query(
        "SELECT 1 FROM material_plastico WHERE idmaterial_plastico = $1 AND activo = true",
        [material_plastico_id]
      ),
      client.query(
        "SELECT 1 FROM calibre WHERE idcalibre = $1 AND activo = true",
        [calibre_id]
      ),
    ]);

    if ((tipoProducto.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El tipo de producto seleccionado no existe o está inactivo" });
    }
    if ((material.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El material seleccionado no existe o está inactivo" });
    }
    if ((calibre.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El calibre seleccionado no existe o está inactivo" });
    }

    const duplicado = await buscarDuplicado(client, {
      tipo_producto_plastico_id,
      material_plastico_id,
      calibre_id,
      altura,
      ancho,
      fuelle_fondo: fuelle_fondo || 0,
      fuelle_latIz: fuelle_latIz || 0,
      fuelle_latDe: fuelle_latDe || 0,
      refuerzo: refuerzo || 0,
      excluirId: Number(id),
    });

    if (duplicado) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Ya existe un producto con estas características",
        detalle: `"${duplicado.tipo_producto} — ${duplicado.medida}" ya está registrado con el mismo material (${duplicado.material}), calibre (${duplicado.calibre}) y medidas.`,
        producto_existente: { id: duplicado.idconfiguracion_plastico, medida: duplicado.medida },
      });
    }

    // origen_expo tampoco se toca aquí — una vez marcado (por la creación
    // automática desde Expo) se queda así aunque después se edite a mano
    // desde esta página; solo cambian sus datos, no su origen.
    const result = await client.query(
      `UPDATE configuracion_plastico
       SET
         material_plastico_plastico_idmaterial_plastico = $1,
         tipo_producto_plastico_plastico_idtipo_producto_plastico = $2,
         calibre_idcalibre = $3,
         altura = $4,
         fuelle_fondo = $5,
         refuerzo = $6,
         ancho = $7,
         fuelle_latIz = $8,
         fuelle_latDe = $9,
         medida = $10,
         por_kilo = $11
       WHERE idconfiguracion_plastico = $12
       RETURNING idconfiguracion_plastico, medida, por_kilo`,
      [
        material_plastico_id,
        tipo_producto_plastico_id,
        calibre_id,
        altura,
        fuelle_fondo || 0,
        refuerzo || 0,
        ancho,
        fuelle_latIz || 0,
        fuelle_latDe || 0,
        medida,
        por_kilo,
        id,
      ]
    );

    const productoActualizado = result.rows[0];

    // ── Reflejar el cambio en Catálogo Expo si algún registro apunta a este
    // mismo producto (idconfiguracion_plastico). Igual que en papel: aquí no
    // hace falta el checkeo de "uso externo" — el Sistema es la fuente de
    // verdad, Expo solo debe reflejar la realidad.
    const { rows: matCalRows } = await client.query(
      `SELECT mp.tipo_material AS material, c.calibre
       FROM material_plastico mp, calibre c
       WHERE mp.idmaterial_plastico = $1 AND c.idcalibre = $2`,
      [material_plastico_id, calibre_id]
    );
    const materialSync = matCalRows[0]?.material ?? null;
    const calibreSync = matCalRows[0]?.calibre != null ? String(matCalRows[0].calibre) : null;

    await client.query(
      `UPDATE catalogo_expo SET
         medida = COALESCE($1, medida),
         material = COALESCE($2, material),
         calibre = COALESCE($3, calibre)
       WHERE idconfiguracion_plastico = $4 AND activo = true`,
      [productoActualizado.medida || null, materialSync, calibreSync, id]
    );

    await client.query("COMMIT");

    console.log("✅ Producto actualizado:", productoActualizado.idconfiguracion_plastico);
    res.json({
      message: "Producto actualizado exitosamente",
      producto: {
        id: productoActualizado.idconfiguracion_plastico,
        medida: productoActualizado.medida,
        por_kilo: productoActualizado.por_kilo,
      },
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ UPDATE PRODUCTO PLÁSTICO ERROR:", error.message);
    res.status(500).json({ error: "Error al procesar la solicitud" });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// REGISTRO EN BLANCO DESDE EXPO (relajado — sin validaciones estrictas)
// ═══════════════════════════════════════════════════════════════════════════
// A diferencia de createProductoPlastico (alta normal desde Plastico.tsx),
// aquí no se exige tipo/material/calibre resueltos por ID — se guarda lo que
// se tenga como texto, se intenta resolver el ID si hace match, y si no, se
// deja null para completarse después (cuando la cotización se vuelva pedido).
export const registrarProductoPlasticoEnBlancoExpo = async (req: Request, res: Response) => {
  try {
    const { nombre, tipo_producto, material, calibre, medida,
      altura, ancho, fuelle_fondo, fuelle_latIz, fuelle_latDe, refuerzo,
      precio_500, precio_1000, precio_3000 } = req.body;

    if (!nombre?.trim() && !tipo_producto?.trim())
      return res.status(400).json({ error: "El nombre o tipo de producto es requerido" });

    const num = (v: any) => (v != null && v !== "") ? Number(v) : null;

    let tipoId: number | null = null;
    if (tipo_producto) {
      const { rows } = await pool.query(
        `SELECT idtipo_producto_plastico FROM tipo_producto_plastico WHERE LOWER(material_plastico_producto) LIKE $1 LIMIT 1`,
        [`%${String(tipo_producto).toLowerCase()}%`]
      );
      tipoId = rows[0]?.idtipo_producto_plastico ?? null;
    }

    let materialId: number | null = null;
    if (material) {
      const { rows } = await pool.query(
        `SELECT idmaterial_plastico FROM material_plastico WHERE LOWER(tipo_material) = LOWER($1) LIMIT 1`,
        [material]
      );
      materialId = rows[0]?.idmaterial_plastico ?? null;
    }

    let calibreId: number | null = null;
    if (calibre) {
      const calibreNum = parseFloat(calibre) || 0;
      if (calibreNum) {
        const { rows } = await pool.query(
          `SELECT idcalibre FROM calibre WHERE calibre = $1 OR calibre_bopp = $1 LIMIT 1`, [calibreNum]
        );
        calibreId = rows[0]?.idcalibre ?? null;
      }
    }

    // por_kilo ahora se deja en NULL de verdad si no se puede calcular
    // (antes se forzaba a 0 como parche porque la columna no aceptaba NULL
    // en la práctica sin material/tipo/calibre resueltos — ya no hace falta).
    const result = await pool.query(
      `INSERT INTO configuracion_plastico (
        material_plastico_plastico_idmaterial_plastico,
        tipo_producto_plastico_plastico_idtipo_producto_plastico,
        calibre_idcalibre, altura, fuelle_fondo, refuerzo, ancho,
        fuelle_latIz, fuelle_latDe, medida, por_kilo,
        precio_500, precio_1000, precio_3000, activo, origen_expo
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,$12,$13,true,true)
      RETURNING idconfiguracion_plastico`,
      [
        materialId, tipoId, calibreId,
        altura || null, fuelle_fondo || null, refuerzo || null, ancho || null,
        fuelle_latIz || null, fuelle_latDe || null, medida || nombre || null,
        num(precio_500), num(precio_1000), num(precio_3000),
      ]
    );

    const idconfiguracion_plastico = result.rows[0].idconfiguracion_plastico;
    console.log("✅ Producto plástico EN BLANCO (Expo) creado:", idconfiguracion_plastico);
    return res.status(201).json({ idconfiguracion_plastico });
  } catch (error: any) {
    console.error("❌ REGISTRAR PRODUCTO PLÁSTICO EN BLANCO (Expo) ERROR:", error.message);
    return res.status(500).json({ error: "Error al registrar el producto" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ELIMINAR PRODUCTO (SOFT-DELETE)
// ═══════════════════════════════════════════════════════════════════════════
export const deleteProductoPlastico = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    console.log("🗑️ Desactivando producto plástico:", id);

    await client.query("BEGIN");

    const { rows } = await client.query(
      `UPDATE configuracion_plastico SET activo = false
       WHERE idconfiguracion_plastico = $1 AND activo = true
       RETURNING idconfiguracion_plastico, medida`,
      [id]
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    // Igual que en papel: si el producto ya no existe en el sistema,
    // cualquier registro de Catálogo Expo que lo usaba queda obsoleto.
    await client.query(
      `UPDATE catalogo_expo SET activo = false WHERE idconfiguracion_plastico = $1 AND activo = true`,
      [id]
    );

    await client.query("COMMIT");
    console.log("✅ Producto desactivado:", rows[0].medida);
    res.json({ message: "Producto eliminado correctamente" });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ DELETE PRODUCTO PLÁSTICO ERROR:", error.message);
    res.status(500).json({ error: "Error al procesar la solicitud" });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// REACTIVAR PRODUCTO
// ═══════════════════════════════════════════════════════════════════════════
export const reactivarProductoPlastico = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    console.log("♻️ Reactivando producto plástico:", id);

    const { rows } = await pool.query(
      `UPDATE configuracion_plastico SET activo = true
       WHERE idconfiguracion_plastico = $1 AND activo = false
       RETURNING idconfiguracion_plastico, medida`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Producto no encontrado o ya está activo" });
    }

    console.log("✅ Producto reactivado:", rows[0].medida);
    res.json({ message: "Producto reactivado correctamente" });
  } catch (error: any) {
    console.error("❌ REACTIVAR PRODUCTO PLÁSTICO ERROR:", error.message);
    res.status(500).json({ error: "Error al procesar la solicitud" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// VERIFICAR DUPLICADO (GET — sin crear)
// ═══════════════════════════════════════════════════════════════════════════
export const checkProductoDuplicado = async (req: Request, res: Response) => {
  try {
    const {
      tipo_producto_plastico_id,
      material_plastico_id,
      calibre_id,
      altura,
      ancho,
      fuelle_fondo = 0,
      fuelle_latIz = 0,
      fuelle_latDe = 0,
      refuerzo = 0,
    } = req.query;

    const duplicado = await buscarDuplicado(pool, {
      tipo_producto_plastico_id: Number(tipo_producto_plastico_id),
      material_plastico_id: Number(material_plastico_id),
      calibre_id: Number(calibre_id),
      altura: Number(altura),
      ancho: Number(ancho),
      fuelle_fondo: Number(fuelle_fondo),
      fuelle_latIz: Number(fuelle_latIz),
      fuelle_latDe: Number(fuelle_latDe),
      refuerzo: Number(refuerzo),
    });

    if (!duplicado) {
      return res.json({ existe: false });
    }

    return res.json({
      existe: true,
      detalle: `"${duplicado.tipo_producto} — ${duplicado.medida}" ya está registrado con el mismo material (${duplicado.material}), calibre (${duplicado.calibre}) y medidas.`,
      producto_existente: { id: duplicado.idconfiguracion_plastico, medida: duplicado.medida },
    });
  } catch (error: any) {
    console.error("❌ CHECK DUPLICADO ERROR:", error.message);
    return res.status(500).json({ error: "Error al verificar duplicado" });
  }
};