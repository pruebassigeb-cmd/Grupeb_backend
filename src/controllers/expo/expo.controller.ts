// import { Request, Response } from "express";
// import { pool } from "../../config/db";
// import { getPresignedUrl } from "../../config/multer";
// import { insertarProductoPapel } from "../cotizaciones/cotizacionPapel.helper";
// import type { ProductoPapelPayload } from "../cotizaciones/cotizacionPapel.helper";

// const ESTADO = { PENDIENTE: 1, EN_PROCESO: 2, APROBADO: 3, RECHAZADO: 4 } as const;

// // ─── Helpers de folio ─────────────────────────────────────────────────────────

// async function obtenerSiguienteFolioCotizacion(client: any): Promise<string> {
//   const yy = new Date().getFullYear().toString().slice(-2);
//   const { rows } = await client.query(`
//     SELECT COALESCE(MAX(CAST(SUBSTRING(no_cotizacion FROM 'CO${yy}(\\d+)') AS INTEGER)),0)+1 AS siguiente
//     FROM solicitud WHERE no_cotizacion LIKE 'CO${yy}%'`);
//   return `CO${yy}${String(rows[0].siguiente).padStart(3, "0")}`;
// }

// async function obtenerSiguienteFolioPedido(client: any): Promise<string> {
//   const yy = new Date().getFullYear().toString().slice(-2);
//   const { rows } = await client.query(`
//     SELECT COALESCE(MAX(CAST(SUBSTRING(no_pedido FROM 'P${yy}(\\d+)') AS INTEGER)),0)+1 AS siguiente
//     FROM solicitud WHERE no_pedido LIKE 'P${yy}%'`);
//   return `P${yy}${String(rows[0].siguiente).padStart(3, "0")}`;
// }

// async function generarFolioOrdenDiseno(client: any): Promise<string> {
//   const yy = new Date().getFullYear().toString().slice(-2);
//   const { rows } = await client.query(`
//     SELECT COALESCE(MAX(CAST(SUBSTRING(no_orden_diseno FROM 'OD${yy}(\\d+)') AS INTEGER)),0)+1 AS siguiente
//     FROM orden_diseno WHERE no_orden_diseno LIKE 'OD${yy}%'`);
//   return `OD${yy}${String(rows[0].siguiente).padStart(3, "0")}`;
// }

// async function generarIdentificador(client: any): Promise<string> {
//   const { rows } = await client.query(`
//     SELECT identificar FROM clientes WHERE identificar ~ '^[0-9]+$'
//     ORDER BY CAST(identificar AS INTEGER) DESC LIMIT 1`);
//   let next = 600;
//   if (rows.length > 0) {
//     const last = parseInt(rows[0].identificar, 10);
//     if (!isNaN(last) && last >= 600) next = last + 1;
//   }
//   return String(next);
// }

// async function crearVentaYDiseno(
//   client: any, solicitudId: number, folioPedido: string,
//   subtotal: number, sinIva = false
// ): Promise<void> {
//   const iva = sinIva ? 0 : Number((subtotal * 0.16).toFixed(2));
//   const total = Number((subtotal + iva).toFixed(2));
//   const anticipo = Number((total * 0.50).toFixed(2));
//   const { rows: vr } = await client.query(
//     `INSERT INTO ventas (solicitud_idsolicitud,estado_administrativo_cat_idestado_administrativo_cat,
//        subtotal,iva,total,anticipo,saldo,abono,fecha_creacion)
//      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING idventas`,
//     [solicitudId, ESTADO.PENDIENTE, subtotal, iva, total, anticipo, total, 0]
//   );
//   console.log(`✅ [EXPO] Venta #${vr[0].idventas}`);
//   const { rows: dr } = await client.query(
//     `INSERT INTO diseno (solicitud_idsolicitud,estado_administrativo_cat_idestado_administrativo_cat,fecha)
//      VALUES ($1,$2,NOW()) RETURNING iddiseno`,
//     [solicitudId, ESTADO.PENDIENTE]
//   );
//   const disenoId = dr[0].iddiseno;
//   const { rows: prods } = await client.query(
//     `SELECT idsolicitud_producto FROM solicitud_producto WHERE solicitud_idsolicitud=$1`, [solicitudId]
//   );
//   for (const prod of prods) {
//     await client.query(
//       `INSERT INTO diseno_producto (diseno_iddiseno,solicitud_producto_idsolicitud_producto,
//          estado_administrativo_cat_idestado_administrativo_cat,fecha)
//        VALUES ($1,$2,$3,NOW())`,
//       [disenoId, prod.idsolicitud_producto, ESTADO.PENDIENTE]
//     );
//     const folioOD = await generarFolioOrdenDiseno(client);
//     await client.query(
//       `INSERT INTO orden_diseno (solicitud_producto_id,no_pedido,no_orden_diseno,estado,version_actual)
//        VALUES ($1,$2,$3,'en_revision',1)`,
//       [prod.idsolicitud_producto, folioPedido, folioOD]
//     );
//   }
//   console.log(`✅ [EXPO] Diseño #${disenoId} con ${prods.length} producto(s)`);
// }

// // ═══════════════════════════════════════════════════════════
// // CATÁLOGO PROPIO
// // ═══════════════════════════════════════════════════════════

// // ─── Backfill de imagen Expo ⇄ Sistema ─────────────────────────────────────
// // Si el producto del Catálogo Expo no tiene foto propia (imagen_url vacío)
// // pero el producto YA resuelto en el sistema (producto_papel o
// // configuracion_plastico) sí tiene una guardada, usamos esa — así no se ve
// // vacío en Expo solo porque la foto se subió del otro lado (Papel.tsx /
// // Plastico.tsx). Es un "rellenar si está vacío", no una sincronización
// // continua: si luego cambian la foto del sistema, esto no se actualiza solo,
// // habría que volver a resolver el FK (editar el producto en Catálogo Expo).
// async function buscarImagenSistema(
//   client: any,
//   opts: { idproducto_papel?: number | null; idconfiguracion_plastico?: number | null }
// ): Promise<number | null> {
//   if (opts.idproducto_papel) {
//     const { rows } = await client.query(
//       `SELECT id_archivo FROM archivos
//        WHERE idproducto_papel = $1 AND categoria = 'imagen-suaje-papel'
//        ORDER BY id_archivo DESC LIMIT 1`,
//       [opts.idproducto_papel]
//     );
//     return rows[0]?.id_archivo ?? null;
//   }
//   if (opts.idconfiguracion_plastico) {
//     const { rows } = await client.query(
//       `SELECT id_archivo FROM archivos
//        WHERE idconfiguracion_plastico = $1 AND categoria = 'imagen-producto-plastico'
//        ORDER BY id_archivo DESC LIMIT 1`,
//       [opts.idconfiguracion_plastico]
//     );
//     return rows[0]?.id_archivo ?? null;
//   }
//   return null;
// }

// // URL estable (NO una presigned URL de S3, que expira) — mismo patrón que ya
// // usa el frontend en ModalProducto.tsx: apunta al endpoint público
// // /archivos/:id/ver, que hace un 302 a una presigned URL fresca cada vez que
// // se visita. Requiere una variable de entorno con la URL pública del backend
// // (ej. API_BASE_URL="https://api.tudominio.com") — si no está configurada,
// // se omite el backfill sin tronar nada.
// function construirUrlArchivoEstable(id_archivo: number): string | null {
//   const base = process.env.API_BASE_URL || process.env.BACKEND_URL;
//   if (!base) {
//     console.warn("⚠️ [EXPO] Falta API_BASE_URL/BACKEND_URL — no se puede hacer backfill de imagen");
//     return null;
//   }
//   return `${base.replace(/\/$/, "")}/archivos/${id_archivo}/ver`;
// }

// export const getCatalogoPropio = async (req: Request, res: Response) => {
//   try {
//     const { rows } = await pool.query(
//       `SELECT * FROM catalogo_expo WHERE activo=true ORDER BY categoria,idcatalogo_expo`
//     );
//     return res.json(rows);
//   } catch (e: any) { return res.status(500).json({ error: e.message }); }
// };

// export const getCatalogoSistema = async (req: Request, res: Response) => {
//   try {
//     const { rows: plasticoRaw } = await pool.query(`
//       SELECT cp.idconfiguracion_plastico AS id,'plastico' AS categoria,
//         tpp.material_plastico_producto AS nombre, cp.medida,
//         mp.tipo_material AS material, cal.calibre, cal.calibre_bopp,
//         cp.altura,cp.ancho,cp.fuelle_fondo,cp.fuelle_latiz,cp.fuelle_latde,cp.refuerzo,cp.por_kilo,
//         img_prev.public_id AS imagen_public_id
//       FROM configuracion_plastico cp
//       LEFT JOIN tipo_producto_plastico tpp ON tpp.idtipo_producto_plastico=cp.tipo_producto_plastico_plastico_idtipo_producto_plastico
//       LEFT JOIN material_plastico mp ON mp.idmaterial_plastico=cp.material_plastico_plastico_idmaterial_plastico
//       LEFT JOIN calibre cal ON cal.idcalibre=cp.calibre_idcalibre
//       LEFT JOIN LATERAL (
//         SELECT public_id FROM archivos
//         WHERE idconfiguracion_plastico = cp.idconfiguracion_plastico
//           AND categoria = 'imagen-producto-plastico'
//         ORDER BY id_archivo DESC
//         LIMIT 1
//       ) img_prev ON true
//       ORDER BY tpp.material_plastico_producto,cp.medida`);

//     const plastico = await Promise.all(
//       plasticoRaw.map(async (row) => {
//         const { imagen_public_id, ...rest } = row;
//         return {
//           ...rest,
//           imagen_url: imagen_public_id ? await getPresignedUrl(imagen_public_id) : null,
//         };
//       })
//     );

//     // ── Papel del sistema — ahora también trae la imagen registrada en el
//     // alta de "Productos Papel" (carpeta interna "suaje", subcarpeta
//     // "imagen"), para poder mostrarla en el catálogo de Expo. Se resuelve
//     // con un LATERAL a `archivos` (mismo patrón que ya usa
//     // getProductosPapel en producto_papel.controller.ts) y se firma la URL
//     // después, en JS, igual que ahí.
//     const { rows: papelRaw } = await pool.query(`
//       SELECT pp.idproducto_papel AS id,'papel' AS categoria,
//         ctp.nombre AS nombre, pp.medida, pp.descripcion_papel,
//         pp.ancho,pp.fuelle,pp.altura,
//         (SELECT ctp2.nombre FROM detalle_material_papel dmp
//          JOIN cat_tipo_papel ctp2 ON ctp2.idcat_tipo_papel=dmp.idcat_tipo_papel
//          WHERE dmp.idgrupo_papel IN (SELECT gp.idgrupo_papel FROM grupo_papel gp WHERE gp.idproducto_papel=pp.idproducto_papel)
//          LIMIT 1) AS primer_material,
//         (SELECT cc.nombre FROM detalle_material_papel dmp
//          JOIN cat_calibre cc ON cc.idcat_calibre=dmp.idcat_calibre
//          WHERE dmp.idgrupo_papel IN (SELECT gp.idgrupo_papel FROM grupo_papel gp WHERE gp.idproducto_papel=pp.idproducto_papel)
//          LIMIT 1) AS primer_calibre,
//         img_prev.public_id AS imagen_public_id
//       FROM producto_papel pp
//       LEFT JOIN cat_tipo_producto_papel ctp ON ctp.idcat_tipo_producto_papel=pp.idcat_tipo_producto_papel
//       LEFT JOIN LATERAL (
//         SELECT public_id FROM archivos
//         WHERE idproducto_papel = pp.idproducto_papel
//           AND categoria = 'imagen-suaje-papel'
//         ORDER BY id_archivo DESC
//         LIMIT 1
//       ) img_prev ON true
//       WHERE pp.activo=true ORDER BY ctp.nombre,pp.medida`);

//     const papel = await Promise.all(
//       papelRaw.map(async (row) => {
//         const { imagen_public_id, ...rest } = row;
//         return {
//           ...rest,
//           imagen_url: imagen_public_id ? await getPresignedUrl(imagen_public_id) : null,
//         };
//       })
//     );

//     const { rows: coloresAsa } = await pool.query(
//       `SELECT id_color AS id, INITCAP(color) AS nombre FROM color_asa ORDER BY id_color`
//     );
//     const { rows: suajesPlast } = await pool.query(
//       `SELECT idsuaje AS id, tipo FROM asa_suaje WHERE idproductos = 1 ORDER BY idsuaje`
//     );
//     return res.json({ plastico, papel, coloresAsa, suajesPlast });
//   } catch (e: any) { return res.status(500).json({ error: e.message }); }
// };

// export const crearProductoCatalogo = async (req: Request, res: Response) => {
//   try {
//     const {
//       nombre, categoria, medida, material, calibre, tintas,
//       laminacion, tipo_laminado, hs, tipo_hs, ar, textura, tipo_textura,
//       uv, asa, tipo_asa, otro, precio_500, precio_1000, precio_3000, imagen_url,
//       tipo_producto,
//       altura, ancho, fuelle, fuelle_fondo, fuelle_lateral_iz, fuelle_lateral_de, refuerzo,
//       origen,
//     } = req.body;

//     if (!nombre?.trim()) return res.status(400).json({ error: "El nombre es requerido" });
//     if (!["papel", "plastico", "carton"].includes(categoria))
//       return res.status(400).json({ error: `Categoría inválida: "${categoria}"` });

//     const bool = (v: any) => v === true || v === "true";
//     const num = (v: any) => (v != null && v !== "") ? Number(v) : null;

//     const client = await pool.connect();
//     try {
//       await client.query("BEGIN");
//       const { rows } = await client.query(`
//         INSERT INTO catalogo_expo (nombre,categoria,medida,material,calibre,tintas,
//           laminacion,tipo_laminado,hs,tipo_hs,ar,textura,tipo_textura,uv,asa,tipo_asa,otro,
//           precio_500,precio_1000,precio_3000,imagen_url,tipo_producto,
//           altura,ancho,fuelle,fuelle_fondo,fuelle_lateral_iz,fuelle_lateral_de,refuerzo,origen)
//         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
//                 $23,$24,$25,$26,$27,$28,$29,$30)
//         RETURNING *`,
//         [nombre.trim(), categoria, medida || null, material || null, calibre || null, tintas || null,
//         bool(laminacion), tipo_laminado || null, bool(hs), tipo_hs || null,
//         bool(ar), bool(textura), tipo_textura || null, bool(uv), bool(asa), tipo_asa || null, otro || null,
//         num(precio_500), num(precio_1000), num(precio_3000), imagen_url || null, tipo_producto || null,
//         num(altura), num(ancho), num(fuelle), num(fuelle_fondo),
//         num(fuelle_lateral_iz), num(fuelle_lateral_de), num(refuerzo),
//         origen || "expo"]
//       );
//       const prod = rows[0];
//       const fks = await resolverFKsProductoExpo(client, {
//         categoria: prod.categoria, nombre: prod.nombre,
//         material: prod.material, calibre: prod.calibre, tipo_producto: prod.tipo_producto,
//         altura: prod.altura, ancho: prod.ancho, fuelle: prod.fuelle,
//         fuelle_fondo: prod.fuelle_fondo, fuelle_lateral_iz: prod.fuelle_lateral_iz,
//         fuelle_lateral_de: prod.fuelle_lateral_de, refuerzo: prod.refuerzo,
//       });
//       if (fks.idproducto_papel || fks.idconfiguracion_plastico) {
//         let imagenBackfill: string | null = null;
//         if (!prod.imagen_url) {
//           const idArchivo = await buscarImagenSistema(client, fks);
//           if (idArchivo) imagenBackfill = construirUrlArchivoEstable(idArchivo);
//         }
//         const { rows: upd } = await client.query(`
//           UPDATE catalogo_expo SET idproducto_papel=$1, idconfiguracion_plastico=$2,
//             imagen_url = COALESCE(imagen_url, $4)
//           WHERE idcatalogo_expo=$3 RETURNING imagen_url`,
//           [fks.idproducto_papel, fks.idconfiguracion_plastico, prod.idcatalogo_expo, imagenBackfill]);
//         prod.idproducto_papel = fks.idproducto_papel;
//         prod.idconfiguracion_plastico = fks.idconfiguracion_plastico;
//         prod.imagen_url = upd[0]?.imagen_url ?? prod.imagen_url;
//       }
//       await client.query("COMMIT");
//       return res.status(201).json({ message: "Producto agregado", producto: prod });
//     } catch (e: any) {
//       await client.query("ROLLBACK");
//       throw e;
//     } finally { client.release(); }
//   } catch (e: any) { return res.status(500).json({ error: e.message }); }
// };

// // ─── Seguridad para sincronizar Expo ⇄ Sistema al editar/eliminar ──────────
// // Solo se permite editar-en-lugar o desactivar en cascada un producto del
// // sistema (producto_papel / configuracion_plastico) desde el lado de Expo
// // cuando:
// //   1. Ese producto se creó automáticamente DESDE Expo (origen_expo=true) —
// //      si lo dio de alta alguien a mano en Papel/Plástico, su "dueño" real
// //      es esa alta manual y nunca se toca desde aquí.
// //   2. Ninguna cotización/pedido AJENA a Expo (solicitud.origen_expo=false)
// //      lo está usando — si sí, tocarlo podría romper algo de SIGEB normal
// //      que no tiene nada que ver con esta edición de Expo.
// // Si cualquiera de las dos falla, se sigue el comportamiento de siempre:
// // solo se desvincula (no se edita ni se borra nada del sistema).
// async function puedeModificarProductoSistemaDeExpo(
//   client: any,
//   opts: { idproducto_papel?: number | null; idconfiguracion_plastico?: number | null }
// ): Promise<boolean> {
//   if (opts.idproducto_papel) {
//     const { rows } = await client.query(
//       `SELECT pp.origen_expo,
//         (SELECT COUNT(*) FROM solicitud_producto sp
//          JOIN solicitud s ON s.idsolicitud = sp.solicitud_idsolicitud
//          WHERE sp.producto_papel_idproducto_papel = pp.idproducto_papel
//            AND s.origen_expo = false) AS usos_externos
//        FROM producto_papel pp WHERE pp.idproducto_papel = $1`,
//       [opts.idproducto_papel]
//     );
//     if (!rows.length) return false;
//     return rows[0].origen_expo === true && Number(rows[0].usos_externos) === 0;
//   }
//   if (opts.idconfiguracion_plastico) {
//     const { rows } = await client.query(
//       `SELECT cp.origen_expo,
//         (SELECT COUNT(*) FROM solicitud_producto sp
//          JOIN solicitud s ON s.idsolicitud = sp.solicitud_idsolicitud
//          WHERE sp.configuracion_plastico_idconfiguracion_plastico = cp.idconfiguracion_plastico
//            AND s.origen_expo = false) AS usos_externos
//        FROM configuracion_plastico cp WHERE cp.idconfiguracion_plastico = $1`,
//       [opts.idconfiguracion_plastico]
//     );
//     if (!rows.length) return false;
//     return rows[0].origen_expo === true && Number(rows[0].usos_externos) === 0;
//   }
//   return false;
// }

// // Actualiza EN EL MISMO producto_papel (sin crear uno nuevo) sus campos
// // descriptivos, cuando ya se determinó que es seguro hacerlo (ver arriba).
// async function actualizarProductoPapelEnLugar(
//   client: any,
//   idproducto_papel: number,
//   cat: {
//     nombre: string; material: string | null; calibre: string | null; tipo_producto: string | null;
//     altura: number | null; ancho: number | null; fuelle: number | null;
//   }
// ) {
//   const tipoStr = (cat.tipo_producto || "").toLowerCase();
//   const { rows: tpRows } = await client.query(
//     `SELECT idcat_tipo_producto_papel FROM cat_tipo_producto_papel WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
//     [`%${tipoStr}%`]
//   );
//   const idcatTipoProductoPapel = tpRows[0]?.idcat_tipo_producto_papel ?? null;

//   const altura = Number(cat.altura) || null;
//   const ancho = Number(cat.ancho) || null;
//   const fuelle = Number(cat.fuelle) || null;
//   const medida = [altura, fuelle, ancho].filter(Boolean).length >= 2
//     ? `${altura || ""}${fuelle ? "+" + fuelle : ""}x${ancho || ""}` : null;

//   await client.query(
//     `UPDATE producto_papel SET
//        idcat_tipo_producto_papel = COALESCE($1, idcat_tipo_producto_papel),
//        descripcion_papel = $2, ancho = $3, fuelle = $4, altura = $5, medida = $6,
//        updated_at = NOW()
//      WHERE idproducto_papel = $7`,
//     [idcatTipoProductoPapel, cat.nombre, ancho, fuelle, altura, medida, idproducto_papel]
//   );

//   if (cat.material || cat.calibre) {
//     const { rows: tmatRows } = await client.query(
//       `SELECT idcat_tipo_papel FROM cat_tipo_papel WHERE LOWER(nombre) = LOWER($1) LIMIT 1`,
//       [cat.material || ""]
//     );
//     const idcatTipoPapel = tmatRows[0]?.idcat_tipo_papel ?? null;
//     let idcatCalibre: number | null = null;
//     if (cat.calibre) {
//       const { rows: calRows } = await client.query(
//         `SELECT idcat_calibre FROM cat_calibre WHERE LOWER(nombre) = LOWER($1) LIMIT 1`,
//         [cat.calibre]
//       );
//       idcatCalibre = calRows[0]?.idcat_calibre ?? null;
//     }
//     if (idcatTipoPapel || idcatCalibre) {
//       const { rows: gpRows } = await client.query(
//         `SELECT idgrupo_papel FROM grupo_papel WHERE idproducto_papel=$1 ORDER BY idgrupo_papel ASC LIMIT 1`,
//         [idproducto_papel]
//       );
//       if (gpRows.length) {
//         const idgrupo = gpRows[0].idgrupo_papel;
//         const { rows: dmRows } = await client.query(
//           `SELECT iddetalle_material FROM detalle_material_papel WHERE idgrupo_papel=$1 ORDER BY orden ASC LIMIT 1`,
//           [idgrupo]
//         );
//         if (dmRows.length) {
//           await client.query(
//             `UPDATE detalle_material_papel SET
//                idcat_tipo_papel = COALESCE($1, idcat_tipo_papel),
//                idcat_calibre = COALESCE($2, idcat_calibre)
//              WHERE iddetalle_material=$3`,
//             [idcatTipoPapel, idcatCalibre, dmRows[0].iddetalle_material]
//           );
//         } else {
//           await client.query(
//             `INSERT INTO detalle_material_papel (idgrupo_papel, idcat_tipo_papel, idcat_calibre, orden)
//              VALUES ($1,$2,$3,1)`,
//             [idgrupo, idcatTipoPapel, idcatCalibre]
//           );
//         }
//       } else {
//         const { rows: newGp } = await client.query(
//           `INSERT INTO grupo_papel (idproducto_papel, precio_sugerido, orden) VALUES ($1,NULL,1) RETURNING idgrupo_papel`,
//           [idproducto_papel]
//         );
//         await client.query(
//           `INSERT INTO detalle_material_papel (idgrupo_papel, idcat_tipo_papel, idcat_calibre, orden) VALUES ($1,$2,$3,1)`,
//           [newGp[0].idgrupo_papel, idcatTipoPapel, idcatCalibre]
//         );
//       }
//     }
//   }
// }

// // Igual que arriba pero para configuracion_plastico.
// async function actualizarConfiguracionPlasticoEnLugar(
//   client: any,
//   idconfiguracion_plastico: number,
//   cat: {
//     material: string | null; calibre: string | null; tipo_producto: string | null;
//     altura: number | null; ancho: number | null; fuelle: number | null;
//     fuelle_fondo: number | null; fuelle_lateral_iz: number | null; fuelle_lateral_de: number | null;
//     refuerzo: number | null;
//   }
// ) {
//   const materialNorm = normalizarMaterial(cat.material);
//   const esBopp = materialNorm === "BOPP";
//   const { rows: matRows } = await client.query(
//     `SELECT idmaterial_plastico, valor FROM material_plastico WHERE LOWER(tipo_material) = LOWER($1) LIMIT 1`,
//     [materialNorm]
//   );
//   const materialId = matRows[0]?.idmaterial_plastico ?? null;
//   const factorMaterial = matRows[0] ? parseFloat(matRows[0].valor) || 0 : 0;

//   let tipoId: number | null = null;
//   if (cat.tipo_producto) {
//     const { rows: tipoRows } = await client.query(
//       `SELECT idtipo_producto_plastico FROM tipo_producto_plastico WHERE LOWER(material_plastico_producto) LIKE $1 LIMIT 1`,
//       [`%${cat.tipo_producto.toLowerCase()}%`]
//     );
//     tipoId = tipoRows[0]?.idtipo_producto_plastico ?? null;
//   }

//   let calibreId: number | null = null;
//   const calibreNum = cat.calibre ? parseFloat(cat.calibre) || 0 : 0;
//   if (calibreNum) {
//     const calibreCol = esBopp ? "calibre_bopp" : "calibre";
//     const { rows: calRows } = await client.query(
//       `SELECT idcalibre FROM calibre WHERE ${calibreCol} = $1 LIMIT 1`, [calibreNum]
//     );
//     calibreId = calRows[0]?.idcalibre ?? null;
//   }

//   const altura = Number(cat.altura) || 0;
//   const ancho = Number(cat.ancho) || 0;
//   const fuelleFondo = Number(cat.fuelle_fondo || cat.fuelle) || 0;
//   const fuelleLat1 = Number(cat.fuelle_lateral_iz) || 0;
//   const fuelleLat2 = Number(cat.fuelle_lateral_de) || 0;
//   const refuerzo = Number(cat.refuerzo) || 0;
//   let porKilo: number | null = null;
//   if (altura && ancho && calibreNum && factorMaterial) {
//     porKilo = calcularPorKiloExpo(altura, ancho, fuelleFondo, fuelleLat1, fuelleLat2, refuerzo, calibreNum, factorMaterial);
//   }

//   const partes: string[] = [String(altura)];
//   if (fuelleFondo > 0) partes.push(String(fuelleFondo));
//   if (refuerzo > 0) partes.push(String(refuerzo));
//   const partesDer: string[] = [String(ancho)];
//   if (fuelleLat1 > 0) partesDer.push(String(fuelleLat1));
//   if (fuelleLat2 > 0 && fuelleLat2 !== fuelleLat1) partesDer.push(String(fuelleLat2));
//   const medida = `${partes.join("+")}x${partesDer.join("+")}`;

//   await client.query(
//     `UPDATE configuracion_plastico SET
//        tipo_producto_plastico_plastico_idtipo_producto_plastico = COALESCE($1, tipo_producto_plastico_plastico_idtipo_producto_plastico),
//        material_plastico_plastico_idmaterial_plastico = COALESCE($2, material_plastico_plastico_idmaterial_plastico),
//        calibre_idcalibre = COALESCE($3, calibre_idcalibre),
//        altura = $4, ancho = $5, fuelle_fondo = $6, fuelle_latiz = $7, fuelle_latde = $8, refuerzo = $9,
//        medida = $10, por_kilo = COALESCE($11, por_kilo)
//      WHERE idconfiguracion_plastico = $12`,
//     [tipoId, materialId, calibreId, altura, ancho, fuelleFondo, fuelleLat1, fuelleLat2, refuerzo, medida, porKilo, idconfiguracion_plastico]
//   );
// }

// export const actualizarProductoCatalogo = async (req: Request, res: Response) => {
//   try {
//     const { id } = req.params;
//     const {
//       nombre, categoria, medida, material, calibre, tintas,
//       laminacion, tipo_laminado, hs, tipo_hs, ar, textura, tipo_textura,
//       uv, asa, tipo_asa, otro, precio_500, precio_1000, precio_3000, imagen_url,
//       tipo_producto,
//       altura, ancho, fuelle, fuelle_fondo, fuelle_lateral_iz, fuelle_lateral_de, refuerzo,
//       origen,
//     } = req.body;

//     const bool = (v: any) => v === true || v === "true";
//     const num = (v: any) => (v != null && v !== "") ? Number(v) : null;

//     const client = await pool.connect();
//     try {
//       await client.query("BEGIN");

//       // ── Ver primero a qué estaba vinculado ANTES de editar, y si es
//       // seguro editar ese mismo producto del sistema en lugar de crear
//       // otro nuevo (que es lo que pasaba antes de este cambio).
//       const { rows: viejoRows } = await client.query(
//         `SELECT idproducto_papel, idconfiguracion_plastico FROM catalogo_expo
//          WHERE idcatalogo_expo=$1 AND activo=true`, [id]
//       );
//       if (!viejoRows.length) {
//         await client.query("ROLLBACK");
//         return res.status(404).json({ error: "Producto no encontrado" });
//       }
//       const viejo = viejoRows[0];
//       const esSeguroEditarEnLugar = (viejo.idproducto_papel || viejo.idconfiguracion_plastico)
//         ? await puedeModificarProductoSistemaDeExpo(client, viejo)
//         : false;

//       // Si es seguro editar en lugar, NO nulificamos los FKs (se quedan
//       // apuntando al mismo producto de siempre). Si no, se nulifican y más
//       // abajo se resuelve/crea uno nuevo — el comportamiento de siempre.
//       const { rows, rowCount } = await client.query(`
//         UPDATE catalogo_expo SET
//           nombre=$1,categoria=$2,medida=$3,material=$4,calibre=$5,tintas=$6,
//           laminacion=$7,tipo_laminado=$8,hs=$9,tipo_hs=$10,ar=$11,textura=$12,tipo_textura=$13,
//           uv=$14,asa=$15,tipo_asa=$16,otro=$17,precio_500=$18,precio_1000=$19,precio_3000=$20,
//           imagen_url=$21,tipo_producto=$22,
//           altura=$23,ancho=$24,fuelle=$25,fuelle_fondo=$26,
//           fuelle_lateral_iz=$27,fuelle_lateral_de=$28,refuerzo=$29,origen=$30
//           ${esSeguroEditarEnLugar ? "" : ", idproducto_papel=NULL, idconfiguracion_plastico=NULL"}
//         WHERE idcatalogo_expo=$31 AND activo=true RETURNING *`,
//         [nombre?.trim(), categoria, medida || null, material || null, calibre || null, tintas || null,
//         bool(laminacion), tipo_laminado || null, bool(hs), tipo_hs || null,
//         bool(ar), bool(textura), tipo_textura || null, bool(uv), bool(asa), tipo_asa || null, otro || null,
//         num(precio_500), num(precio_1000), num(precio_3000), imagen_url || null, tipo_producto || null,
//         num(altura), num(ancho), num(fuelle), num(fuelle_fondo),
//         num(fuelle_lateral_iz), num(fuelle_lateral_de), num(refuerzo),
//         origen || "expo", id]
//       );
//       if ((rowCount ?? 0) === 0) {
//         await client.query("ROLLBACK");
//         return res.status(404).json({ error: "Producto no encontrado" });
//       }
//       const prod = rows[0];

//       if (esSeguroEditarEnLugar) {
//         // Mismo producto del sistema de siempre — solo se le actualizan sus
//         // datos descriptivos, nunca se crea uno nuevo ni se pierde el vínculo.
//         if (viejo.idproducto_papel) {
//           await actualizarProductoPapelEnLugar(client, viejo.idproducto_papel, {
//             nombre: prod.nombre, material: prod.material, calibre: prod.calibre,
//             tipo_producto: prod.tipo_producto, altura: prod.altura, ancho: prod.ancho, fuelle: prod.fuelle,
//           });
//         } else if (viejo.idconfiguracion_plastico) {
//           await actualizarConfiguracionPlasticoEnLugar(client, viejo.idconfiguracion_plastico, {
//             material: prod.material, calibre: prod.calibre, tipo_producto: prod.tipo_producto,
//             altura: prod.altura, ancho: prod.ancho, fuelle: prod.fuelle,
//             fuelle_fondo: prod.fuelle_fondo, fuelle_lateral_iz: prod.fuelle_lateral_iz,
//             fuelle_lateral_de: prod.fuelle_lateral_de, refuerzo: prod.refuerzo,
//           });
//         }
//         // Los FKs no se tocaron en el UPDATE de arriba, así que prod.idproducto_papel
//         // / prod.idconfiguracion_plastico ya vienen correctos en el RETURNING *.
//       } else {
//         // Comportamiento de siempre: no era seguro tocar el producto viejo
//         // (o no había ninguno vinculado) — se busca uno que coincida con los
//         // datos nuevos, o se crea uno nuevo si no existe.
//         const fks = await resolverFKsProductoExpo(client, {
//           categoria: prod.categoria, nombre: prod.nombre,
//           material: prod.material, calibre: prod.calibre, tipo_producto: prod.tipo_producto,
//           altura: prod.altura, ancho: prod.ancho, fuelle: prod.fuelle,
//           fuelle_fondo: prod.fuelle_fondo, fuelle_lateral_iz: prod.fuelle_lateral_iz,
//           fuelle_lateral_de: prod.fuelle_lateral_de, refuerzo: prod.refuerzo,
//         });
//         if (fks.idproducto_papel || fks.idconfiguracion_plastico) {
//           let imagenBackfill: string | null = null;
//           if (!prod.imagen_url) {
//             const idArchivo = await buscarImagenSistema(client, fks);
//             if (idArchivo) imagenBackfill = construirUrlArchivoEstable(idArchivo);
//           }
//           const { rows: upd } = await client.query(`
//             UPDATE catalogo_expo SET idproducto_papel=$1, idconfiguracion_plastico=$2,
//               imagen_url = COALESCE(imagen_url, $4)
//             WHERE idcatalogo_expo=$3 RETURNING imagen_url`,
//             [fks.idproducto_papel, fks.idconfiguracion_plastico, prod.idcatalogo_expo, imagenBackfill]);
//           prod.idproducto_papel = fks.idproducto_papel;
//           prod.idconfiguracion_plastico = fks.idconfiguracion_plastico;
//           prod.imagen_url = upd[0]?.imagen_url ?? prod.imagen_url;
//         }
//       }

//       await client.query("COMMIT");
//       return res.json({ message: "Producto actualizado", producto: prod });
//     } catch (e: any) {
//       await client.query("ROLLBACK");
//       throw e;
//     } finally { client.release(); }
//   } catch (e: any) { return res.status(500).json({ error: e.message }); }
// };

// export const eliminarProductoCatalogo = async (req: Request, res: Response) => {
//   const client = await pool.connect();
//   try {
//     const { id } = req.params;
//     await client.query("BEGIN");

//     const { rows: catRows } = await client.query(
//       `SELECT idproducto_papel, idconfiguracion_plastico FROM catalogo_expo
//        WHERE idcatalogo_expo=$1 AND activo=true`, [id]
//     );
//     if (!catRows.length) {
//       await client.query("ROLLBACK");
//       return res.status(404).json({ error: "Producto no encontrado" });
//     }
//     const { idproducto_papel, idconfiguracion_plastico } = catRows[0];

//     await client.query(`UPDATE catalogo_expo SET activo=false WHERE idcatalogo_expo=$1`, [id]);

//     // Solo se desactiva también en el sistema si es seguro (ver
//     // puedeModificarProductoSistemaDeExpo) — si no, se queda tal cual,
//     // solo se desconecta del lado de Expo.
//     let tambienDesactivadoEnSistema = false;
//     if (idproducto_papel || idconfiguracion_plastico) {
//       const seguro = await puedeModificarProductoSistemaDeExpo(client, { idproducto_papel, idconfiguracion_plastico });
//       if (seguro) {
//         if (idproducto_papel) {
//           await client.query(`UPDATE producto_papel SET activo=false, updated_at=NOW() WHERE idproducto_papel=$1`, [idproducto_papel]);
//         } else if (idconfiguracion_plastico) {
//           await client.query(`UPDATE configuracion_plastico SET activo=false WHERE idconfiguracion_plastico=$1`, [idconfiguracion_plastico]);
//         }
//         tambienDesactivadoEnSistema = true;
//       }
//     }

//     await client.query("COMMIT");
//     return res.json({ message: "Producto eliminado", tambienDesactivadoEnSistema });
//   } catch (e: any) {
//     await client.query("ROLLBACK");
//     return res.status(500).json({ error: e.message });
//   } finally {
//     client.release();
//   }
// };


// // ═══════════════════════════════════════════════════════════
// // CLIENTES EXPO
// // ═══════════════════════════════════════════════════════════

// export const crearClienteExpo = async (req: Request, res: Response) => {
//   const client = await pool.connect();
//   try {
//     const { nombre, celular, correo, impresion, ciudad, estado, clase, intereses, observaciones } = req.body;
//     if (!nombre?.trim()) return res.status(400).json({ error: "El nombre es requerido" });
//     await client.query("BEGIN");
//     const identificar = await generarIdentificador(client);
//     const { rows } = await client.query(`
//       INSERT INTO clientes (atencion,celular,correo,impresion,origen_expo,clasificacion_expo,
//         intereses_expo,observaciones_expo,fecha,identificar)
//       VALUES ($1,$2,$3,$4,true,$5,$6,$7,CURRENT_TIMESTAMP,$8)
//       RETURNING idclientes,atencion,celular,correo,impresion,identificar`,
//       [nombre.trim(), celular || null, correo || null, impresion || null,
//       clase || null, intereses?.length ? intereses : null, observaciones || null, identificar]
//     );
//     const idclientes = rows[0].idclientes;
//     if (ciudad || estado) {
//       await client.query(
//         `INSERT INTO domicilio (clientes_idclientes,poblacion,estado) VALUES ($1,$2,$3)`,
//         [idclientes, ciudad || null, estado || null]
//       );
//     }
//     await client.query("COMMIT");
//     console.log(`✅ [EXPO] Cliente id=${idclientes} identificar=${identificar}`);
//     return res.status(201).json({
//       message: "Prospecto registrado",
//       cliente: {
//         id: idclientes, identificar, nombre: rows[0].atencion,
//         celular: rows[0].celular, correo: rows[0].correo, impresion: rows[0].impresion
//       },
//     });
//   } catch (e: any) {
//     await client.query("ROLLBACK");
//     console.error("❌ [EXPO] CREATE CLIENTE:", e.message);
//     return res.status(500).json({ error: e.message });
//   } finally { client.release(); }
// };

// export const getClientesExpo = async (req: Request, res: Response) => {
//   try {
//     const { rows } = await pool.query(`
//       SELECT c.idclientes, c.atencion AS nombre, c.celular, c.correo, c.impresion,
//         c.clasificacion_expo AS clase, c.intereses_expo AS intereses,
//         c.observaciones_expo AS observaciones, c.identificar,
//         d.poblacion AS ciudad, d.estado
//       FROM clientes c
//       LEFT JOIN domicilio d ON d.clientes_idclientes=c.idclientes
//       WHERE c.origen_expo=true
//       ORDER BY c.fecha DESC`);
//     return res.json(rows);
//   } catch (e: any) { return res.status(500).json({ error: e.message }); }
// };

// export const actualizarClienteExpo = async (req: Request, res: Response) => {
//   const client = await pool.connect();
//   try {
//     const { id } = req.params;
//     const { nombre, celular, correo, impresion, ciudad, estado, clase, intereses, observaciones } = req.body;
//     await client.query("BEGIN");
//     await client.query(`
//       UPDATE clientes SET atencion=$1,celular=$2,correo=$3,impresion=$4,
//         clasificacion_expo=$5,intereses_expo=$6,observaciones_expo=$7
//       WHERE idclientes=$8 AND origen_expo=true`,
//       [nombre?.trim() || null, celular || null, correo || null, impresion || null,
//       clase || null, intereses?.length ? intereses : null, observaciones || null, id]
//     );
//     const { rowCount } = await client.query(
//       `SELECT 1 FROM domicilio WHERE clientes_idclientes=$1`, [id]
//     );
//     if ((rowCount ?? 0) > 0) {
//       await client.query(
//         `UPDATE domicilio SET poblacion=$1,estado=$2 WHERE clientes_idclientes=$3`,
//         [ciudad || null, estado || null, id]
//       );
//     } else if (ciudad || estado) {
//       await client.query(
//         `INSERT INTO domicilio (clientes_idclientes,poblacion,estado) VALUES ($1,$2,$3)`,
//         [id, ciudad || null, estado || null]
//       );
//     }
//     await client.query("COMMIT");
//     return res.json({ message: "Prospecto actualizado" });
//   } catch (e: any) {
//     await client.query("ROLLBACK");
//     return res.status(500).json({ error: e.message });
//   } finally { client.release(); }
// };

// export const eliminarClienteExpo = async (req: Request, res: Response) => {
//   const client = await pool.connect();
//   try {
//     const { id } = req.params;
//     await client.query("BEGIN");
//     const { rows } = await client.query(
//       `SELECT COUNT(*) AS total FROM solicitud WHERE clientes_idclientes=$1`, [id]
//     );
//     if (Number(rows[0].total) > 0) {
//       await client.query(`UPDATE clientes SET origen_expo=false WHERE idclientes=$1`, [id]);
//       await client.query("COMMIT");
//       return res.json({ message: "Prospecto eliminado", teniaCotizaciones: true });
//     }
//     await client.query(`DELETE FROM domicilio WHERE clientes_idclientes=$1`, [id]);
//     await client.query(`DELETE FROM clientes WHERE idclientes=$1`, [id]);
//     await client.query("COMMIT");
//     return res.json({ message: "Prospecto eliminado", teniaCotizaciones: false });
//   } catch (e: any) {
//     await client.query("ROLLBACK");
//     return res.status(500).json({ error: e.message });
//   } finally { client.release(); }
// };

// // ═══════════════════════════════════════════════════════════
// // COTIZACIONES EXPO
// // ═══════════════════════════════════════════════════════════

// export const getSiguienteFolioExpo = async (req: Request, res: Response) => {
//   try {
//     const yy = new Date().getFullYear().toString().slice(-2);
//     const { rows } = await pool.query(`
//       SELECT COALESCE(MAX(CAST(SUBSTRING(no_cotizacion FROM 'CO${yy}(\\d+)') AS INTEGER)),0)+1 AS siguiente
//       FROM solicitud WHERE no_cotizacion LIKE 'CO${yy}%'`);
//     const folio = `CO${yy}${String(rows[0].siguiente).padStart(3, "0")}`;
//     return res.json({ folio });
//   } catch (e: any) { return res.status(500).json({ error: e.message }); }
// };

// export const crearCotizacionExpo = async (req: Request, res: Response) => {
//   const client = await pool.connect();
//   try {
//     const { clienteId, productos, comentarios } = req.body;
//     if (!clienteId) return res.status(400).json({ error: "Se requiere clienteId" });
//     if (!productos?.length) return res.status(400).json({ error: "Se requiere al menos un producto" });

//     await client.query("BEGIN");
//     const folioCotizacion = await obtenerSiguienteFolioCotizacion(client);
//     const { rows: solRows } = await client.query(`
//       INSERT INTO solicitud (clientes_idclientes,estado_administrativo_cat_idestado_administrativo_cat,
//         estado,no_cotizacion,origen_expo,sin_iva)
//       VALUES ($1,$2,'cotizacion',$3,true,false)
//       RETURNING idsolicitud,no_cotizacion`,
//       [clienteId, ESTADO.PENDIENTE, folioCotizacion]
//     );
//     const solicitudId = solRows[0].idsolicitud;
//     const noCotizacion = solRows[0].no_cotizacion;
//     console.log(`✅ [EXPO] Solicitud ${noCotizacion} id=${solicitudId}`);

//     // Comentarios generales de la cotización — se guardan en observacion de cada producto
//     const obsGeneral = comentarios?.trim() || null;

//     let subtotalTotal = 0;

//     for (const prod of productos) {
//       console.log("[EXPO] tipoCotizacion:", prod.tipoCotizacion, "nombre:", prod.nombre);


//       // ── PAPEL SIGEB (sistema) ──────────────────────────────────────────────
//       if (prod.tipoCotizacion === "papel" || prod.tipo_material === "papel") {
//         let idgrupo_papel = prod.idgrupo_papel ?? null;
//         if (!idgrupo_papel && prod.idproducto_papel) {
//           const { rows: grupos } = await client.query(
//             `SELECT idgrupo_papel FROM grupo_papel
//      WHERE idproducto_papel=$1 ORDER BY idgrupo_papel ASC LIMIT 1`,
//             [prod.idproducto_papel]
//           );
//           idgrupo_papel = grupos[0]?.idgrupo_papel ?? null;
//         }

//         // Resolver grupo_descripcion si no viene del frontend
//         let grupo_descripcion = prod.grupo_descripcion ?? null;
//         if (!grupo_descripcion && idgrupo_papel) {
//           const { rows: gdRows } = await client.query(`
//     SELECT string_agg(CONCAT(ctp.nombre, ' ', cc.nombre), ' + ') AS desc
//     FROM detalle_material_papel dmp
//     LEFT JOIN cat_tipo_papel ctp ON ctp.idcat_tipo_papel = dmp.idcat_tipo_papel
//     LEFT JOIN cat_calibre cc ON cc.idcat_calibre = dmp.idcat_calibre
//     WHERE dmp.idgrupo_papel = $1`, [idgrupo_papel]
//           );
//           grupo_descripcion = gdRows[0]?.desc ?? null;
//         }

//         let metodo_hojeado: "hojeado" | "guillotina" = "hojeado";
//         if (prod.idproducto_papel) {
//           const { rows: maq } = await client.query(
//             `SELECT c.nombre FROM maquinaria_hojeado_guillotina m
//              JOIN cat_hojeado_guillotina c ON c.idcat_hojeado_guillotina = m.idcat_hojeado_guillotina
//              WHERE m.idproducto_papel = $1 LIMIT 1`,
//             [prod.idproducto_papel]
//           );
//           const nombreMaq = (maq[0]?.nombre || "").toLowerCase();
//           if (nombreMaq.includes("guillotina")) metodo_hojeado = "guillotina";
//         }

//         let tintasId = prod.tintasId ?? null;
//         if (!tintasId) {
//           const { rows: tRows } = await client.query(
//             `SELECT idtintas FROM tintas WHERE cantidad=1 LIMIT 1`
//           );
//           tintasId = tRows[0]?.idtintas ?? null;
//         }

//         const papelPayload: ProductoPapelPayload = {
//           tipoCotizacion: "papel",
//           idproducto_papel: prod.idproducto_papel,
//           nombre: prod.nombre ?? "",
//           idgrupo_papel,
//           grupo_descripcion: grupo_descripcion,
//           tintasId,
//           pantones: prod.pantones ?? null,
//           tintasDentroId: prod.tintasDentroId ?? null,
//           pantonesDentro: prod.pantonesDentro ?? null,
//           carasId: prod.carasId ?? null,
//           id_asa: prod.id_asa ?? null,
//           idcat_laminado: prod.idcat_laminado ?? null,
//           idfoil: prod.idfoil ?? null,
//           idcat_textura: prod.idcat_textura ?? null,
//           uv: prod.uv ?? false,
//           alto_relieve: prod.alto_relieve ?? false,
//           observacion: prod.observacion || obsGeneral,   // ← comentarios generales
//           descripcion: prod.descripcion ?? null,
//           cantidades: prod.cantidades,
//           precios: prod.precios,
//           herramental_descripcion: null,
//           herramental_precio: null,
//           cargo_adicional_descripcion: null,
//           cargo_adicional_precio: null,
//           metodo_hojeado,
//           lleva_armado: prod.lleva_armado ?? false,
//         };

//         subtotalTotal += await insertarProductoPapel(client, solicitudId, papelPayload, "cotizacion");
//         continue;
//       }

//       // ── PAPEL EXPO PROPIO (categoría papel/cartón del catálogo expo) ────────
//       if (prod.tipoCotizacion === "expo_papel") {
//         const {
//           nombre: epNombre = null, tintas_cantidad: epTintas,
//           tipoLaminado = null, tipoHs = null, tipoTextura = null, tipoAsa: epTipoAsa = null,
//           uv: epUv = false, ar: epAr = false,
//           cantidades: epCants, precios: epPrecios,
//           observacion: epObs = null,
//         } = prod;

//         let epTintasId: number | null = null;
//         if (epTintas != null) {
//           const num = parseInt(String(epTintas), 10);
//           if (!isNaN(num)) {
//             const { rows: tr } = await client.query(
//               `SELECT idtintas FROM tintas WHERE cantidad=$1 LIMIT 1`, [num]
//             );
//             epTintasId = tr[0]?.idtintas ?? null;
//           }
//         }

//         const { rows: catExpoRows } = await client.query(`
//           SELECT * FROM catalogo_expo WHERE LOWER(nombre) = LOWER($1) AND activo=true LIMIT 1`,
//           [epNombre || ""]
//         );

//         let epIdproductoPapel: number | null = null;
//         if (catExpoRows.length > 0) {
//           const catE = catExpoRows[0];
//           if (catE.idproducto_papel) {
//             epIdproductoPapel = catE.idproducto_papel;
//           } else {
//             const fks = await resolverFKsProductoExpo(client, {
//               categoria: catE.categoria, nombre: catE.nombre,
//               material: catE.material, calibre: catE.calibre,
//               tipo_producto: catE.tipo_producto,
//               altura: catE.altura, ancho: catE.ancho, fuelle: catE.fuelle,
//               fuelle_fondo: catE.fuelle_fondo, fuelle_lateral_iz: catE.fuelle_lateral_iz,
//               fuelle_lateral_de: catE.fuelle_lateral_de, refuerzo: catE.refuerzo,
//             });
//             epIdproductoPapel = fks.idproducto_papel;
//             if (epIdproductoPapel) {
//               let imagenBackfill: string | null = null;
//               if (!catE.imagen_url) {
//                 const idArchivo = await buscarImagenSistema(client, fks);
//                 if (idArchivo) imagenBackfill = construirUrlArchivoEstable(idArchivo);
//               }
//               await client.query(
//                 `UPDATE catalogo_expo SET idproducto_papel=$1, imagen_url = COALESCE(imagen_url, $3)
//                  WHERE idcatalogo_expo=$2`,
//                 [epIdproductoPapel, catE.idcatalogo_expo, imagenBackfill]
//               );
//             }
//           }
//         }

//         if (!epIdproductoPapel) {
//           console.warn(`[EXPO] No se pudo resolver idproducto_papel para "${epNombre}", insertando como expo`);
//           const { rows: spGenRows } = await client.query(`
//             INSERT INTO solicitud_producto
//               (solicitud_idsolicitud, tintas_idtintas, descripcion, observacion, tipo_material)
//             VALUES ($1,$2,$3,$4,'expo')
//             RETURNING idsolicitud_producto`,
//             [solicitudId, epTintasId, epNombre || null, epObs || obsGeneral || null]  // ← comentarios generales
//           );
//           const spGenId = spGenRows[0].idsolicitud_producto;
//           for (let i = 0; i < 3; i++) {
//             const cant = Number(epCants?.[i] ?? 0);
//             const precio = Number(epPrecios?.[i] ?? 0);
//             if (cant > 0 && precio > 0) {
//               await client.query(`
//                 INSERT INTO solicitud_detalle (solicitud_producto_id, cantidad, precio_total, aprobado, modo_cantidad)
//                 VALUES ($1,$2,$3,$4,'unidad')`,
//                 [spGenId, cant, Math.round(cant * precio * 100) / 100, null]
//               );
//               subtotalTotal += Math.round(cant * precio * 100) / 100;
//             }
//           }
//           continue;
//         }

//         let epIdAsa: number | null = null;
//         if (epTipoAsa) {
//           const { rows: asaR } = await client.query(
//             `SELECT idcat_tipo_asa FROM cat_tipo_asa WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
//             [`%${epTipoAsa.toLowerCase()}%`]
//           );
//           epIdAsa = asaR[0]?.idcat_tipo_asa ?? null;
//         }

//         let epIdLaminado: number | null = null;
//         if (tipoLaminado) {
//           const { rows: lamR } = await client.query(
//             `SELECT idcat_laminado FROM cat_laminado WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
//             [`%${tipoLaminado.toLowerCase()}%`]
//           );
//           epIdLaminado = lamR[0]?.idcat_laminado ?? null;
//         }

//         let epIdFoil: number | null = null;
//         if (tipoHs) {
//           const termino = tipoHs.toLowerCase().trim();
//           const palabras = termino.split(/\s+/);
//           const ultimaPalab = palabras[palabras.length - 1];
//           const { rows: foilR } = await client.query(
//             `SELECT idfoil FROM foil WHERE LOWER(colorfoil) LIKE $1 OR LOWER(codigofoil) LIKE $2 LIMIT 1`,
//             [`%${termino}%`, `%${ultimaPalab}%`]
//           );
//           epIdFoil = foilR[0]?.idfoil ?? null;
//         }

//         let epIdTextura: number | null = null;
//         if (tipoTextura) {
//           const { rows: texR } = await client.query(
//             `SELECT idcat_textura FROM cat_textura WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
//             [`%${tipoTextura.toLowerCase()}%`]
//           );
//           epIdTextura = texR[0]?.idcat_textura ?? null;
//         }

//         const { rows: gpRows } = await client.query(
//           `SELECT idgrupo_papel FROM grupo_papel WHERE idproducto_papel=$1 ORDER BY idgrupo_papel ASC LIMIT 1`,
//           [epIdproductoPapel]
//         );
//         const epIdgrupo = gpRows[0]?.idgrupo_papel ?? null;

//         let epGrupoDesc: string | null = null;
//         if (epIdgrupo) {
//           const { rows: gdRows } = await client.query(`
//             SELECT string_agg(CONCAT(ctp.nombre, ' ', cc.nombre), ' + ') AS desc
//             FROM detalle_material_papel dmp
//             LEFT JOIN cat_tipo_papel ctp ON ctp.idcat_tipo_papel = dmp.idcat_tipo_papel
//             LEFT JOIN cat_calibre cc ON cc.idcat_calibre = dmp.idcat_calibre
//             WHERE dmp.idgrupo_papel = $1`, [epIdgrupo]
//           );
//           epGrupoDesc = gdRows[0]?.desc ?? null;
//         }

//         console.log("[EXPO] epGrupoDesc:", epGrupoDesc);
//         console.log("[EXPO] catExpoRows:", catExpoRows.length, catExpoRows[0]?.material, catExpoRows[0]?.calibre);

//         // ← NUEVO: fallback desde catálogo expo si no hay grupo_descripcion
//         if (!epGrupoDesc && catExpoRows.length > 0) {
//           const catE = catExpoRows[0];
//           const partes = [catE.material, catE.calibre].filter(Boolean);
//           if (partes.length > 0) epGrupoDesc = partes.join(" ");
//         }

//         const epPayload: ProductoPapelPayload = {
//           tipoCotizacion: "papel",
//           idproducto_papel: epIdproductoPapel,
//           nombre: epNombre ?? "",
//           idgrupo_papel: epIdgrupo,
//           grupo_descripcion: epGrupoDesc,
//           tintasId: epTintasId,
//           pantones: null,
//           tintasDentroId: null,
//           pantonesDentro: null,
//           carasId: null,
//           id_asa: epIdAsa,
//           idcat_laminado: epIdLaminado,
//           idfoil: epIdFoil,
//           idcat_textura: epIdTextura,
//           uv: epUv === true,
//           alto_relieve: epAr === true,
//           observacion: epObs || obsGeneral || null,  // ← comentarios generales
//           descripcion: epNombre ?? null,
//           cantidades: epCants ?? [0, 0, 0],
//           precios: epPrecios ?? [0, 0, 0],
//           herramental_descripcion: null,
//           herramental_precio: null,
//           cargo_adicional_descripcion: null,
//           cargo_adicional_precio: null,
//           metodo_hojeado: "hojeado",
//           lleva_armado: false,
//         };

//         subtotalTotal += await insertarProductoPapel(client, solicitudId, epPayload, "cotizacion");
//         continue;
//       }

//       // ── PLÁSTICO (sistema o expo) — igual a SIGEB normal ─────────────────
//       const {
//         configuracion_plastico_id,
//         tintas_cantidad,
//         nombre: prodNombre = null,
//         observacion: prodObs = null,
//         cantidades,
//         precios,
//         idsuaje: prodIdsuaje = null,
//         id_color: prodIdColor = null,
//         pigmento: prodPigmento = null,
//       } = prod;

//       const tipoMaterial = configuracion_plastico_id ? "plastico" : "expo";

//       let tintasId: number | null = null;
//       if (tintas_cantidad != null) {
//         const tNum = parseInt(String(tintas_cantidad), 10);
//         if (!isNaN(tNum)) {
//           const { rows: tr } = await client.query(
//             `SELECT idtintas FROM tintas WHERE cantidad=$1 LIMIT 1`, [tNum]
//           );
//           tintasId = tr[0]?.idtintas ?? null;
//         }
//       }

//       const idsuaje = prodIdsuaje != null ? Number(prodIdsuaje) : null;
//       const idColor = prodIdColor != null ? Number(prodIdColor) : null;
//       console.log(`[EXPO] Plástico cfg_id=${configuracion_plastico_id} idsuaje=${idsuaje} id_color=${idColor}`);

//       const { rows: spRows } = await client.query(`
//         INSERT INTO solicitud_producto (
//           solicitud_idsolicitud,
//           configuracion_plastico_idconfiguracion_plastico,
//           producto_papel_idproducto_papel,
//           tintas_idtintas,
//           descripcion,
//           observacion,
//           tipo_material,
//           idsuaje,
//           id_color,
//           pigmentos
//         ) VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9)
//         RETURNING idsolicitud_producto`,
//         [
//           solicitudId,
//           configuracion_plastico_id ?? null,
//           tintasId,
//           prodNombre || null,
//           prodObs || obsGeneral || null,   // ← comentarios generales
//           tipoMaterial,
//           idsuaje,
//           idColor,
//           prodPigmento || null,
//         ]
//       );
//       const spId = spRows[0].idsolicitud_producto;

//       const cantArr: number[] = Array.isArray(cantidades) ? cantidades : [0, 0, 0];
//       const preArr: number[] = Array.isArray(precios) ? precios : [0, 0, 0];

//       for (let i = 0; i < cantArr.length; i++) {
//         const cant = Number(cantArr[i]);
//         const precio = Number(preArr[i]);
//         if (cant <= 0 || precio <= 0) continue;
//         const precioTotal = Math.round(cant * precio * 100) / 100;
//         await client.query(`
//           INSERT INTO solicitud_detalle
//             (solicitud_producto_id, cantidad, precio_total, precio_unitario, aprobado, modo_cantidad)
//           VALUES ($1,$2,$3,$4,NULL,'unidad')`,
//           [spId, cant, precioTotal, precio]
//         );
//         subtotalTotal += precioTotal;
//       }

//       console.log(`✅ [EXPO] sp_id=${spId} tipo=${tipoMaterial} idsuaje=${idsuaje} id_color=${idColor} subtotal_acum=${subtotalTotal}`);
//     }

//     await client.query("COMMIT");
//     console.log(`✅ [EXPO] Cotización ${noCotizacion} guardada. Subtotal=${subtotalTotal}`);
//     return res.status(201).json({
//       message: "Cotización expo guardada",
//       no_cotizacion: noCotizacion,
//       idsolicitud: solicitudId,
//     });

//   } catch (e: any) {
//     await client.query("ROLLBACK");
//     console.error("❌ [EXPO] CREATE COT:", e.message, e.stack);
//     return res.status(500).json({ error: "Error al guardar cotización expo", detalle: e.message });
//   } finally {
//     client.release();
//   }
// };

// export const getCotizacionesExpo = async (req: Request, res: Response) => {
//   try {
//     const { rows } = await pool.query(`
//       SELECT
//         s.idsolicitud, s.no_cotizacion, s.no_pedido, s.estado, s.fecha,
//         s.clientes_idclientes,
//         cli.atencion AS cliente, cli.celular, cli.correo, cli.impresion,
//         cli.clasificacion_expo, cli.intereses_expo, cli.observaciones_expo, cli.identificar,
//         dom.poblacion AS ciudad, dom.estado AS estado_cliente,
//         sp.idsolicitud_producto, sp.tipo_material, sp.descripcion, sp.observacion,
//         sp.configuracion_plastico_idconfiguracion_plastico,
//         sp.producto_papel_idproducto_papel,
//         sp.pigmentos,
//         sp.grupo_papel_descripcion,
// sp.grupo_papel_idgrupo_papel,
//         sp.idsuaje, sp.id_color,
//         asz.tipo AS suaje_tipo,
//         ca.color AS color_asa_nombre,
//         t.cantidad AS tintas_cantidad,
//         cfg.medida AS cfg_medida,
//         tpp.material_plastico_producto AS tipo_producto_nombre,
//         mp.tipo_material AS material_nombre,
//         cal.calibre AS calibre_numero, cal.calibre_bopp,
//         ctp.nombre AS papel_tipo_producto,
//         pp.medida AS papel_medida, pp.descripcion_papel AS papel_descripcion,
//         spp.id_asa, asa.nombre AS asa_nombre,
//         spp.idcat_laminado, lam.nombre AS laminado_nombre,
//         spp.idfoil, fo.colorfoil AS foil_color, fo.codigofoil AS foil_codigo,
//         spp.idcat_textura, tex.nombre AS textura_nombre,
//         spp.uv, spp.alto_relieve,
//         sd.idsolicitud_detalle, sd.cantidad, sd.precio_total, sd.precio_unitario, sd.aprobado,
//         ce_exp.medida AS expo_medida, ce_exp.material AS expo_material, ce_exp.calibre AS expo_calibre,
//         ce_exp.tipo_producto AS expo_tipo_producto
//       FROM solicitud s
//       LEFT JOIN clientes cli ON cli.idclientes=s.clientes_idclientes
//       LEFT JOIN domicilio dom ON dom.clientes_idclientes=cli.idclientes
//       LEFT JOIN solicitud_producto sp ON sp.solicitud_idsolicitud=s.idsolicitud
//       LEFT JOIN asa_suaje asz ON asz.idsuaje=sp.idsuaje
//       LEFT JOIN color_asa ca ON ca.id_color=sp.id_color
//       LEFT JOIN tintas t ON t.idtintas=sp.tintas_idtintas
//       LEFT JOIN configuracion_plastico cfg ON cfg.idconfiguracion_plastico=sp.configuracion_plastico_idconfiguracion_plastico
//       LEFT JOIN tipo_producto_plastico tpp ON tpp.idtipo_producto_plastico=cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
//       LEFT JOIN material_plastico mp ON mp.idmaterial_plastico=cfg.material_plastico_plastico_idmaterial_plastico
//       LEFT JOIN calibre cal ON cal.idcalibre=cfg.calibre_idcalibre
//       LEFT JOIN producto_papel pp ON pp.idproducto_papel=sp.producto_papel_idproducto_papel
//       LEFT JOIN cat_tipo_producto_papel ctp ON ctp.idcat_tipo_producto_papel=pp.idcat_tipo_producto_papel
//       LEFT JOIN solicitud_producto_papel spp ON spp.idsolicitud_producto=sp.idsolicitud_producto
//       LEFT JOIN cat_tipo_asa asa ON asa.idcat_tipo_asa=spp.id_asa
//       LEFT JOIN cat_laminado lam ON lam.idcat_laminado=spp.idcat_laminado
//       LEFT JOIN foil fo ON fo.idfoil=spp.idfoil
//       LEFT JOIN cat_textura tex ON tex.idcat_textura=spp.idcat_textura
//       LEFT JOIN grupo_papel gp ON gp.idgrupo_papel=sp.grupo_papel_idgrupo_papel
//       LEFT JOIN LATERAL (
//         SELECT ce.medida, ce.material, ce.calibre, ce.tipo_producto
//         FROM catalogo_expo ce
//         WHERE sp.tipo_material = 'expo'
//           AND ce.activo = true
//           AND LOWER(ce.nombre) = LOWER(sp.descripcion)
//         ORDER BY ce.idcatalogo_expo DESC
//         LIMIT 1
//       ) ce_exp ON true
//       LEFT JOIN solicitud_detalle sd ON sd.solicitud_producto_id=sp.idsolicitud_producto
//       WHERE s.origen_expo=true
//       ORDER BY s.fecha DESC, sp.idsolicitud_producto, sd.idsolicitud_detalle`);

//     const agrupadas: Record<string, any> = {};
//     for (const row of rows) {
//       const key = String(row.idsolicitud);
//       if (!agrupadas[key]) {
//         agrupadas[key] = {
//           idsolicitud: row.idsolicitud, no_cotizacion: row.no_cotizacion,
//           no_pedido: row.no_pedido, estado: row.estado, fecha: row.fecha,
//           cliente_id: row.clientes_idclientes, cliente: row.cliente || "",
//           celular: row.celular || "", correo: row.correo || "", impresion: row.impresion || "",
//           clasificacion: row.clasificacion_expo || "", intereses: row.intereses_expo || [],
//           observaciones: row.observaciones_expo || "", ciudad: row.ciudad || "",
//           estado_cliente: row.estado_cliente || "", identificar: row.identificar || "",
//           productos: [],
//         };
//       }
//       if (!row.idsolicitud_producto) continue;
//       let prod = agrupadas[key].productos.find(
//         (p: any) => p.idsolicitud_producto === row.idsolicitud_producto
//       );
//       if (!prod) {
//         let nombre = row.descripcion || "";
//         if (!nombre) {
//           if (row.tipo_material === "papel") {
//             nombre = row.papel_tipo_producto
//               ? (row.papel_descripcion ? `${row.papel_tipo_producto} — ${row.papel_descripcion}` : row.papel_tipo_producto)
//               : `Papel #${row.producto_papel_idproducto_papel}`;
//           } else if (row.cfg_medida) {
//             nombre = [row.tipo_producto_nombre, row.cfg_medida,
//             (row.material_nombre || "").toLowerCase()].filter(Boolean).join(" ");
//           } else { nombre = "Producto expo"; }
//         }
//         const foilNombre = row.foil_color
//           ? `${row.foil_color}${row.foil_codigo ? " " + row.foil_codigo : ""}` : null;
// prod = {
//   idsolicitud_producto: row.idsolicitud_producto,
//   tipo_material: row.tipo_material, nombre,
//   medida: row.tipo_material === "papel" ? row.papel_medida : (row.cfg_medida || row.expo_medida || null),
//   material: row.material_nombre || row.expo_material || null,
//   calibre: (() => {
//     const esBoppRow = (row.material_nombre || "").toUpperCase() === "BOPP";
//     if (esBoppRow) return row.calibre_bopp != null ? String(row.calibre_bopp) : (row.expo_calibre || null);
//     return row.calibre_numero != null ? String(row.calibre_numero) : (row.expo_calibre || null);
//   })(),
//   tipo_producto: row.tipo_material === "papel"
//     ? (row.papel_tipo_producto ?? null)
//     : (row.tipo_producto_nombre || row.expo_tipo_producto || null),
//   tintas: row.tintas_cantidad ?? null,
//           descripcion: row.descripcion || null, observacion: row.observacion || null,
//           pigmentos: row.pigmentos || null,
//           idsuaje: row.idsuaje ?? null, suaje_tipo: row.suaje_tipo ?? null,
//           id_color: row.id_color ?? null, color_asa_nombre: row.color_asa_nombre ?? null,
//           id_asa: row.id_asa ?? null, asa_nombre: row.asa_nombre ?? null,
//           idcat_laminado: row.idcat_laminado ?? null, laminado_nombre: row.laminado_nombre ?? null,
//           idfoil: row.idfoil ?? null, foil_nombre: foilNombre,
//           grupo_descripcion: row.grupo_papel_descripcion ?? null,
//           idcat_textura: row.idcat_textura ?? null, textura_nombre: row.textura_nombre ?? null,
//           uv: row.uv ?? false, alto_relieve: row.alto_relieve ?? false,
//           detalles: [],
//         };
//         agrupadas[key].productos.push(prod);
//       }
//       if (row.idsolicitud_detalle) {
//         prod.detalles.push({
//           idsolicitud_detalle: row.idsolicitud_detalle,
//           cantidad: Number(row.cantidad),
//           precio_total: Number(row.precio_total),
//           precio_unitario: row.precio_unitario != null ? Number(row.precio_unitario) : null,
//           aprobado: row.aprobado,
//         });
//       }
//     }
//     return res.json(Object.values(agrupadas));
//   } catch (e: any) {
//     console.error("❌ [EXPO] GET COTS:", e.message);
//     return res.status(500).json({ error: e.message });
//   }
// };

// // ═══════════════════════════════════════════════════════════════════════════
// // HELPERS — Conversión automática de producto expo → configuracion_plastico
// // ═══════════════════════════════════════════════════════════════════════════

// function calcularPorKiloExpo(
//   altura: number, ancho: number,
//   fuelleFondo: number, fuelleLat1: number, fuelleLat2: number,
//   refuerzo: number, calibre: number, factorMaterial: number
// ): number | null {
//   if (altura === 0 || ancho === 0 || calibre === 0 || factorMaterial === 0) return null;
//   const sumaV = altura + fuelleFondo + refuerzo;
//   const sumaH = ancho + fuelleLat1 + fuelleLat2;
//   const resultado = 1000 / (((sumaV / 100) * (sumaH / 100) * calibre) * factorMaterial);
//   return parseFloat(resultado.toFixed(3));
// }

// function normalizarMaterial(material: string | null): string {
//   const m = (material || "").toLowerCase();
//   if (m.includes("alta")) return "Alta densidad";
//   if (m.includes("baja")) return "Baja densidad";
//   if (m.includes("bopp") || m.includes("celofan") || m.includes("celofán")) return "BOPP";
//   return material || "";
// }

// async function resolverFKsProductoExpo(
//   client: any,
//   cat: {
//     categoria: string; nombre: string; material: string | null; calibre: string | null;
//     tipo_producto: string | null; altura: number | null; ancho: number | null;
//     fuelle: number | null; fuelle_fondo: number | null; fuelle_lateral_iz: number | null;
//     fuelle_lateral_de: number | null; refuerzo: number | null;
//   }
// ): Promise<{ idproducto_papel: number | null; idconfiguracion_plastico: number | null }> {

//   if (cat.categoria === "plastico") {
//     if (!cat.material || !cat.calibre || !cat.tipo_producto) return { idproducto_papel: null, idconfiguracion_plastico: null };
//     const materialNorm = normalizarMaterial(cat.material);
//     const esBopp = materialNorm === "BOPP";
//     const calibreNum = parseFloat(cat.calibre) || 0;
//     if (!calibreNum) return { idproducto_papel: null, idconfiguracion_plastico: null };
//     const { rows: matRows } = await client.query(
//       `SELECT idmaterial_plastico, valor FROM material_plastico WHERE LOWER(tipo_material) = LOWER($1) LIMIT 1`,
//       [materialNorm]
//     );
//     if (!matRows.length) return { idproducto_papel: null, idconfiguracion_plastico: null };
//     const materialId = matRows[0].idmaterial_plastico;
//     const factorMaterial = parseFloat(matRows[0].valor) || 0;
//     const { rows: tipoRows } = await client.query(
//       `SELECT idtipo_producto_plastico FROM tipo_producto_plastico WHERE LOWER(material_plastico_producto) LIKE $1 LIMIT 1`,
//       [`%${cat.tipo_producto.toLowerCase()}%`]
//     );
//     if (!tipoRows.length) return { idproducto_papel: null, idconfiguracion_plastico: null };
//     const tipoId = tipoRows[0].idtipo_producto_plastico;
//     const calibreCol = esBopp ? "calibre_bopp" : "calibre";
//     const { rows: calRows } = await client.query(
//       `SELECT idcalibre FROM calibre WHERE ${calibreCol} = $1 LIMIT 1`, [calibreNum]
//     );
//     if (!calRows.length) return { idproducto_papel: null, idconfiguracion_plastico: null };
//     const calibreId = calRows[0].idcalibre;
//     const altura = Number(cat.altura) || 0;
//     const ancho = Number(cat.ancho) || 0;
//     const fuelleFondo = Number(cat.fuelle_fondo || cat.fuelle) || 0;
//     const fuelleLat1 = Number(cat.fuelle_lateral_iz) || 0;
//     const fuelleLat2 = Number(cat.fuelle_lateral_de) || 0;
//     const refuerzo = Number(cat.refuerzo) || 0;
//     if (!altura || !ancho) return { idproducto_papel: null, idconfiguracion_plastico: null };
//     const porKilo = calcularPorKiloExpo(altura, ancho, fuelleFondo, fuelleLat1, fuelleLat2, refuerzo, calibreNum, factorMaterial);
//     if (!porKilo) return { idproducto_papel: null, idconfiguracion_plastico: null };
//     const partes: string[] = [String(altura)];
//     if (fuelleFondo > 0) partes.push(String(fuelleFondo));
//     if (refuerzo > 0) partes.push(String(refuerzo));
//     const partesDer: string[] = [String(ancho)];
//     if (fuelleLat1 > 0) partesDer.push(String(fuelleLat1));
//     if (fuelleLat2 > 0 && fuelleLat2 !== fuelleLat1) partesDer.push(String(fuelleLat2));
//     const medida = `${partes.join("+")}x${partesDer.join("+")}`;
//     const { rows: cfgRows } = await client.query(`
//       INSERT INTO configuracion_plastico (
//         tipo_producto_plastico_plastico_idtipo_producto_plastico,
//         material_plastico_plastico_idmaterial_plastico,
//         calibre_idcalibre, altura, ancho, fuelle_fondo, fuelle_latiz, fuelle_latde,
//         refuerzo, medida, por_kilo, origen_expo
//       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)
//       ON CONFLICT DO NOTHING RETURNING idconfiguracion_plastico`,
//       [tipoId, materialId, calibreId, altura, ancho, fuelleFondo, fuelleLat1, fuelleLat2, refuerzo, medida, porKilo]
//     );
//     let configId: number;
//     if (cfgRows.length > 0) {
//       configId = cfgRows[0].idconfiguracion_plastico;
//     } else {
//       const { rows: ex } = await client.query(`
//         SELECT idconfiguracion_plastico FROM configuracion_plastico
//         WHERE tipo_producto_plastico_plastico_idtipo_producto_plastico=$1
//           AND material_plastico_plastico_idmaterial_plastico=$2
//           AND calibre_idcalibre=$3 AND altura=$4 AND ancho=$5
//           AND fuelle_fondo=$6 AND fuelle_latiz=$7 AND fuelle_latde=$8 AND refuerzo=$9
//         LIMIT 1`,
//         [tipoId, materialId, calibreId, altura, ancho, fuelleFondo, fuelleLat1, fuelleLat2, refuerzo]
//       );
//       if (!ex.length) return { idproducto_papel: null, idconfiguracion_plastico: null };
//       configId = ex[0].idconfiguracion_plastico;
//     }
//     return { idproducto_papel: null, idconfiguracion_plastico: configId };
//   }

//   if (cat.categoria === "papel" || cat.categoria === "carton") {
//     const idproductos = cat.categoria === "carton" ? 3 : 2;
//     const tipoStr = (cat.tipo_producto || "").toLowerCase();
//     const { rows: tpRows } = await client.query(
//       `SELECT idcat_tipo_producto_papel FROM cat_tipo_producto_papel WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
//       [`%${tipoStr}%`]
//     );
//     if (!tpRows.length) return { idproducto_papel: null, idconfiguracion_plastico: null };
//     const idcatTipoProductoPapel = tpRows[0].idcat_tipo_producto_papel;
//     const { rows: tmatRows } = await client.query(
//       `SELECT idcat_tipo_papel FROM cat_tipo_papel WHERE LOWER(nombre) = LOWER($1) LIMIT 1`,
//       [cat.material || ""]
//     );
//     const idcatTipoPapel = tmatRows[0]?.idcat_tipo_papel ?? null;
//     let idcatCalibre: number | null = null;
//     if (cat.calibre) {
//       const { rows: calRows } = await client.query(
//         `SELECT idcat_calibre FROM cat_calibre WHERE LOWER(nombre) = LOWER($1) LIMIT 1`,
//         [cat.calibre]
//       );
//       idcatCalibre = calRows[0]?.idcat_calibre ?? null;
//     }
//     const altura = Number(cat.altura) || null;
//     const ancho = Number(cat.ancho) || null;
//     const fuelle = Number(cat.fuelle || cat.fuelle_fondo) || null;
//     const medida = [altura, fuelle, ancho].filter(Boolean).length >= 2
//       ? `${altura || ""}${fuelle ? "+" + fuelle : ""}x${ancho || ""}` : null;
//     const { rows: ppExist } = await client.query(`
//       SELECT pp.idproducto_papel FROM producto_papel pp
//       WHERE pp.idproductos=$1 AND pp.idcat_tipo_producto_papel=$2
//         AND (pp.ancho=$3 OR ($3 IS NULL AND pp.ancho IS NULL))
//         AND (pp.altura=$4 OR ($4 IS NULL AND pp.altura IS NULL))
//         AND (pp.fuelle=$5 OR ($5 IS NULL AND pp.fuelle IS NULL))
//       LIMIT 1`, [idproductos, idcatTipoProductoPapel, ancho, altura, fuelle]
//     );
//     let idproductoPapel: number;
//     if (ppExist.length > 0) {
//       idproductoPapel = ppExist[0].idproducto_papel;
//     } else {
//       const { rows: ppRows } = await client.query(`
//         INSERT INTO producto_papel (idproductos, idcat_tipo_producto_papel, ancho, fuelle, altura, medida, descripcion_papel, activo, origen_expo)
//         VALUES ($1,$2,$3,$4,$5,$6,$7,true,true) RETURNING idproducto_papel`,
//         [idproductos, idcatTipoProductoPapel, ancho, fuelle, altura, medida, cat.nombre]
//       );
//       idproductoPapel = ppRows[0].idproducto_papel;
//       const { rows: gpRows } = await client.query(`
//         INSERT INTO grupo_papel (idproducto_papel, precio_sugerido, orden)
//         VALUES ($1,NULL,1) RETURNING idgrupo_papel`, [idproductoPapel]
//       );
//       const idgrupoPapel = gpRows[0].idgrupo_papel;
//       if (idcatTipoPapel && idcatCalibre) {
//         await client.query(`
//           INSERT INTO detalle_material_papel (idgrupo_papel, idcat_tipo_papel, idcat_calibre, orden)
//           VALUES ($1,$2,$3,1)`, [idgrupoPapel, idcatTipoPapel, idcatCalibre]
//         );
//       }
//     }
//     return { idproducto_papel: idproductoPapel, idconfiguracion_plastico: null };
//   }

//   return { idproducto_papel: null, idconfiguracion_plastico: null };
// }

// async function convertirProductoExpoASistema(
//   client: any, idsolicitudProducto: number, nombre: string
// ): Promise<string | null> {
//   const { rows: spRows } = await client.query(`
//     SELECT sp.configuracion_plastico_idconfiguracion_plastico AS cfg_id,
//            sp.tipo_material, sp.descripcion
//     FROM solicitud_producto sp WHERE sp.idsolicitud_producto=$1`, [idsolicitudProducto]
//   );
//   if (!spRows.length) return null;
//   const sp = spRows[0];
//   if (sp.cfg_id != null) return null;
//   if (sp.tipo_material === "papel") return null;
//   if (sp.tipo_material !== "expo") return null;
//   const nombreBuscar = (sp.descripcion || nombre || "").trim();
//   if (!nombreBuscar) return `Producto expo sin nombre. Revisar en SIGEB.`;
//   const { rows: catRows } = await client.query(`
//     SELECT ce.categoria, ce.material, ce.calibre, ce.tipo_producto,
//            ce.altura, ce.ancho, ce.fuelle, ce.fuelle_fondo,
//            ce.fuelle_lateral_iz, ce.fuelle_lateral_de, ce.refuerzo,
//            ce.idproducto_papel, ce.idconfiguracion_plastico, ce.nombre, ce.imagen_url
//     FROM catalogo_expo ce
//     WHERE LOWER(ce.nombre) = LOWER($1) AND ce.activo=true LIMIT 1`, [nombreBuscar]
//   );
//   if (!catRows.length) return null;
//   const cat = catRows[0];
//   if (cat.idconfiguracion_plastico) {
//     await client.query(`
//       UPDATE solicitud_producto
//       SET configuracion_plastico_idconfiguracion_plastico=$1, tipo_material='plastico'
//       WHERE idsolicitud_producto=$2`, [cat.idconfiguracion_plastico, idsolicitudProducto]
//     );
//     return null;
//   }
//   if (cat.idproducto_papel) {
//     const { rows: sppCheck } = await client.query(
//       `SELECT 1 FROM solicitud_producto_papel WHERE idsolicitud_producto=$1`, [idsolicitudProducto]
//     );
//     if (!sppCheck.length) {
//       await client.query(`
//         INSERT INTO solicitud_producto_papel (idsolicitud_producto, uv, alto_relieve, lleva_armado)
//         VALUES ($1,false,false,true) ON CONFLICT (idsolicitud_producto) DO NOTHING`, [idsolicitudProducto]
//       );
//     }
//     await client.query(`
//       UPDATE solicitud_producto
//       SET tipo_material='papel', producto_papel_idproducto_papel=$1
//       WHERE idsolicitud_producto=$2`, [cat.idproducto_papel, idsolicitudProducto]
//     );
//     return null;
//   }
//   const fks = await resolverFKsProductoExpo(client, {
//     categoria: cat.categoria, nombre: cat.nombre,
//     material: cat.material, calibre: cat.calibre, tipo_producto: cat.tipo_producto,
//     altura: cat.altura, ancho: cat.ancho, fuelle: cat.fuelle,
//     fuelle_fondo: cat.fuelle_fondo, fuelle_lateral_iz: cat.fuelle_lateral_iz,
//     fuelle_lateral_de: cat.fuelle_lateral_de, refuerzo: cat.refuerzo,
//   });
//   if (fks.idconfiguracion_plastico) {
//     let imagenBackfill: string | null = null;
//     if (!cat.imagen_url) {
//       const idArchivo = await buscarImagenSistema(client, fks);
//       if (idArchivo) imagenBackfill = construirUrlArchivoEstable(idArchivo);
//     }
//     await client.query(
//       `UPDATE catalogo_expo SET idconfiguracion_plastico=$1, imagen_url = COALESCE(imagen_url, $3)
//        WHERE LOWER(nombre)=LOWER($2)`,
//       [fks.idconfiguracion_plastico, nombreBuscar, imagenBackfill]
//     );
//     await client.query(`
//       UPDATE solicitud_producto
//       SET configuracion_plastico_idconfiguracion_plastico=$1, tipo_material='plastico'
//       WHERE idsolicitud_producto=$2`, [fks.idconfiguracion_plastico, idsolicitudProducto]
//     );
//     return null;
//   }
//   if (fks.idproducto_papel) {
//     let imagenBackfill: string | null = null;
//     if (!cat.imagen_url) {
//       const idArchivo = await buscarImagenSistema(client, fks);
//       if (idArchivo) imagenBackfill = construirUrlArchivoEstable(idArchivo);
//     }
//     await client.query(
//       `UPDATE catalogo_expo SET idproducto_papel=$1, imagen_url = COALESCE(imagen_url, $3)
//        WHERE LOWER(nombre)=LOWER($2)`,
//       [fks.idproducto_papel, nombreBuscar, imagenBackfill]
//     );
//     const { rows: sppCheck } = await client.query(
//       `SELECT 1 FROM solicitud_producto_papel WHERE idsolicitud_producto=$1`, [idsolicitudProducto]
//     );
//     if (!sppCheck.length) {
//       await client.query(`
//         INSERT INTO solicitud_producto_papel (idsolicitud_producto, uv, alto_relieve, lleva_armado)
//         VALUES ($1,false,false,true) ON CONFLICT (idsolicitud_producto) DO NOTHING`, [idsolicitudProducto]
//       );
//     }
//     await client.query(`
//       UPDATE solicitud_producto
//       SET tipo_material='papel', producto_papel_idproducto_papel=$1
//       WHERE idsolicitud_producto=$2`, [fks.idproducto_papel, idsolicitudProducto]
//     );
//     return null;
//   }
//   return null;
// }

// export const aprobarCotizacionExpo = async (req: Request, res: Response) => {
//   const client = await pool.connect();
//   try {
//     const { folio } = req.params;
//     const { itemsAprobados } = req.body;
//     if (!itemsAprobados?.length) return res.status(400).json({ error: "Selecciona al menos un producto" });
//     await client.query("BEGIN");
//     const { rows: solRows } = await client.query(
//       `SELECT idsolicitud,estado,no_pedido,sin_iva FROM solicitud
//        WHERE no_cotizacion=$1 AND origen_expo=true`, [folio]
//     );
//     if (!solRows.length) {
//       await client.query("ROLLBACK");
//       return res.status(404).json({ error: "No encontrada" });
//     }
//     const sol = solRows[0];
//     if (sol.estado !== "cotizacion") {
//       await client.query("ROLLBACK");
//       return res.status(400).json({ error: "Ya fue convertida a pedido" });
//     }
//     const folioPedido = await obtenerSiguienteFolioPedido(client);
//     await client.query(`
//       UPDATE solicitud_detalle SET aprobado=false
//       WHERE solicitud_producto_id IN (
//         SELECT idsolicitud_producto FROM solicitud_producto WHERE solicitud_idsolicitud=$1
//       )`, [sol.idsolicitud]
//     );
//     const detalleIds = itemsAprobados
//       .map((i: any) => i.idsolicitud_detalle)
//       .filter((id: any) => id && id > 0);
//     if (detalleIds.length > 0) {
//       await client.query(
//         `UPDATE solicitud_detalle SET aprobado=true WHERE idsolicitud_detalle=ANY($1::int[])`,
//         [detalleIds]
//       );
//     }
//     await client.query(`
//       DELETE FROM solicitud_detalle
//       WHERE solicitud_producto_id IN (
//         SELECT idsolicitud_producto FROM solicitud_producto WHERE solicitud_idsolicitud=$1
//       ) AND (aprobado IS NULL OR aprobado=false)`, [sol.idsolicitud]
//     );
//     const { rows: expoProds } = await client.query(`
//       SELECT sp.idsolicitud_producto, COALESCE(sp.descripcion,'Producto expo') AS nombre_prod
//       FROM solicitud_producto sp
//       WHERE sp.solicitud_idsolicitud=$1 AND sp.tipo_material='expo'
//         AND sp.configuracion_plastico_idconfiguracion_plastico IS NULL
//         AND EXISTS (
//           SELECT 1 FROM solicitud_detalle sd
//           WHERE sd.solicitud_producto_id=sp.idsolicitud_producto AND sd.aprobado=true
//         )`, [sol.idsolicitud]
//     );
//     const advertencias: string[] = [];
//     for (const prod of expoProds) {
//       const adv = await convertirProductoExpoASistema(client, prod.idsolicitud_producto, prod.nombre_prod);
//       if (adv) advertencias.push(adv);
//     }
//     await client.query(`
//       UPDATE solicitud SET estado='pedido', no_pedido=$1, fecha_aprobacion=NOW(),
//         estado_administrativo_cat_idestado_administrativo_cat=$2
//       WHERE idsolicitud=$3`,
//       [folioPedido, ESTADO.APROBADO, sol.idsolicitud]
//     );
//     const { rows: stRows } = await client.query(`
//       SELECT COALESCE(SUM(sd.precio_total),0) AS subtotal
//       FROM solicitud_producto sp
//       LEFT JOIN solicitud_detalle sd ON sd.solicitud_producto_id=sp.idsolicitud_producto
//       WHERE sp.solicitud_idsolicitud=$1`, [sol.idsolicitud]
//     );
//     await crearVentaYDiseno(client, sol.idsolicitud, folioPedido, Number(stRows[0].subtotal), sol.sin_iva);
//     await client.query("COMMIT");
//     return res.json({
//       message: "Cotización aprobada y convertida a pedido",
//       no_pedido: folioPedido, no_cotizacion: folio,
//       advertencias: advertencias.length > 0 ? advertencias : undefined,
//     });
//   } catch (e: any) {
//     await client.query("ROLLBACK");
//     console.error("❌ [EXPO] APROBAR:", e.message);
//     return res.status(500).json({ error: e.message });
//   } finally { client.release(); }
// };

// export const eliminarCotizacionExpo = async (req: Request, res: Response) => {
//   const client = await pool.connect();
//   try {
//     const { folio } = req.params;
//     await client.query("BEGIN");
//     const { rows: solRows } = await client.query(
//       `SELECT idsolicitud,estado FROM solicitud WHERE no_cotizacion=$1 AND origen_expo=true`, [folio]
//     );
//     if (!solRows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "No encontrada" }); }
//     if (solRows[0].estado === "pedido") { await client.query("ROLLBACK"); return res.status(400).json({ error: "No se puede eliminar un pedido" }); }
//     const solicitudId = solRows[0].idsolicitud;
//     const { rows: prodRows } = await client.query(
//       `SELECT idsolicitud_producto FROM solicitud_producto WHERE solicitud_idsolicitud=$1`, [solicitudId]
//     );
//     const ids = prodRows.map((r: any) => r.idsolicitud_producto);
//     if (ids.length > 0) {
//       await client.query(`DELETE FROM solicitud_producto_papel WHERE idsolicitud_producto=ANY($1::int[])`, [ids]);
//       await client.query(`DELETE FROM solicitud_detalle WHERE solicitud_producto_id=ANY($1::int[])`, [ids]);
//       await client.query(`DELETE FROM solicitud_producto WHERE solicitud_idsolicitud=$1`, [solicitudId]);
//     }
//     await client.query(`DELETE FROM solicitud WHERE idsolicitud=$1`, [solicitudId]);
//     await client.query("COMMIT");
//     return res.json({ message: "Cotización eliminada" });
//   } catch (e: any) {
//     await client.query("ROLLBACK");
//     return res.status(500).json({ error: e.message });
//   } finally { client.release(); }
// };


















import { Request, Response } from "express";
import { pool } from "../../config/db";
import { getPresignedUrl } from "../../config/multer";
import { insertarProductoPapel } from "../cotizaciones/cotizacionPapel.helper";
import type { ProductoPapelPayload } from "../cotizaciones/cotizacionPapel.helper";

const ESTADO = { PENDIENTE: 1, EN_PROCESO: 2, APROBADO: 3, RECHAZADO: 4 } as const;

// ─── Helpers de folio ─────────────────────────────────────────────────────────

async function obtenerSiguienteFolioCotizacion(client: any): Promise<string> {
  const yy = new Date().getFullYear().toString().slice(-2);
  const { rows } = await client.query(`
    SELECT COALESCE(MAX(CAST(SUBSTRING(no_cotizacion FROM 'CO${yy}(\\d+)') AS INTEGER)),0)+1 AS siguiente
    FROM solicitud WHERE no_cotizacion LIKE 'CO${yy}%'`);
  return `CO${yy}${String(rows[0].siguiente).padStart(3, "0")}`;
}

async function obtenerSiguienteFolioPedido(client: any): Promise<string> {
  const yy = new Date().getFullYear().toString().slice(-2);
  const { rows } = await client.query(`
    SELECT COALESCE(MAX(CAST(SUBSTRING(no_pedido FROM 'P${yy}(\\d+)') AS INTEGER)),0)+1 AS siguiente
    FROM solicitud WHERE no_pedido LIKE 'P${yy}%'`);
  return `P${yy}${String(rows[0].siguiente).padStart(3, "0")}`;
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
  subtotal: number, sinIva = false
): Promise<void> {
  const iva = sinIva ? 0 : Number((subtotal * 0.16).toFixed(2));
  const total = Number((subtotal + iva).toFixed(2));
  const anticipo = Number((total * 0.50).toFixed(2));
  const { rows: vr } = await client.query(
    `INSERT INTO ventas (solicitud_idsolicitud,estado_administrativo_cat_idestado_administrativo_cat,
       subtotal,iva,total,anticipo,saldo,abono,fecha_creacion)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING idventas`,
    [solicitudId, ESTADO.PENDIENTE, subtotal, iva, total, anticipo, total, 0]
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

// ═══════════════════════════════════════════════════════════
// CATÁLOGO PROPIO
// ═══════════════════════════════════════════════════════════

// ─── Backfill de imagen Expo ⇄ Sistema ─────────────────────────────────────
// Si el producto del Catálogo Expo no tiene foto propia (imagen_url vacío)
// pero el producto YA resuelto en el sistema (producto_papel o
// configuracion_plastico) sí tiene una guardada, usamos esa — así no se ve
// vacío en Expo solo porque la foto se subió del otro lado (Papel.tsx /
// Plastico.tsx). Es un "rellenar si está vacío", no una sincronización
// continua: si luego cambian la foto del sistema, esto no se actualiza solo,
// habría que volver a resolver el FK (editar el producto en Catálogo Expo).
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

// URL estable (NO una presigned URL de S3, que expira) — mismo patrón que ya
// usa el frontend en ModalProducto.tsx: apunta al endpoint público
// /archivos/:id/ver, que hace un 302 a una presigned URL fresca cada vez que
// se visita. Requiere una variable de entorno con la URL pública del backend
// (ej. API_BASE_URL="https://api.tudominio.com") — si no está configurada,
// se omite el backfill sin tronar nada.
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
// El helper devuelve la misma forma de JSON que antes (mismos nombres de
// campo) para no tener que reescribir todo el frontend de golpe — solo que
// hs/tipo_hs/textura/tipo_textura/uv ya no tienen dónde vivir como default
// del producto (el sistema no lo soporta) y siempre regresan vacíos/false;
// se siguen pudiendo elegir libremente al cotizar, igual que ya pasa con
// cualquier producto de papel del sistema.
export const getCatalogoPropio = async (req: Request, res: Response) => {
  try {
    const { rows: papelRows } = await pool.query(`
      SELECT pp.idproducto_papel AS idcatalogo_expo,
        (CASE WHEN pp.idproductos = 3 THEN 'carton' ELSE 'papel' END) AS categoria,
        pp.descripcion_papel AS nombre, pp.medida,
        mat.material, mat.calibre,
        (lam.idcat_laminado IS NOT NULL) AS laminacion, lam.nombre AS tipo_laminado,
        (pad.idfoil_default IS NOT NULL) AS hs,
        CASE WHEN fo.idfoil IS NOT NULL THEN concat(fo.colorfoil, CASE WHEN fo.codigofoil IS NOT NULL THEN ' '||fo.codigofoil ELSE '' END) END AS tipo_hs,
        COALESCE(pad.alto_relieve_default, false) AS ar,
        (pad.idcat_textura_default IS NOT NULL) AS textura,
        tex.nombre AS tipo_textura,
        COALESCE(pad.uv_default, false) AS uv,
        (asa.idcat_tipo_asa IS NOT NULL) AS asa, asa.nombre AS tipo_asa,
        NULL::text AS otro, NULL::text AS tintas,
        pp.precio_500, pp.precio_1000, pp.precio_3000,
        ctp.nombre AS tipo_producto,
        img_prev.public_id AS imagen_public_id
      FROM producto_papel pp
      LEFT JOIN cat_tipo_producto_papel ctp ON ctp.idcat_tipo_producto_papel=pp.idcat_tipo_producto_papel
      LEFT JOIN LATERAL (
        SELECT ctp2.nombre AS material, cc.nombre AS calibre
        FROM detalle_material_papel dmp
        JOIN grupo_papel gp ON gp.idgrupo_papel=dmp.idgrupo_papel
        LEFT JOIN cat_tipo_papel ctp2 ON ctp2.idcat_tipo_papel=dmp.idcat_tipo_papel
        LEFT JOIN cat_calibre cc ON cc.idcat_calibre=dmp.idcat_calibre
        WHERE gp.idproducto_papel=pp.idproducto_papel
        ORDER BY gp.orden ASC, dmp.orden ASC LIMIT 1
      ) mat ON true
      LEFT JOIN acabados_papel ap ON ap.idproducto_papel=pp.idproducto_papel
      LEFT JOIN LATERAL (
        SELECT al.idcat_laminado, cl.nombre FROM acabados_laminado al
        JOIN cat_laminado cl ON cl.idcat_laminado=al.idcat_laminado
        WHERE al.idacabados_papel=ap.idacabados_papel LIMIT 1
      ) lam ON true
      LEFT JOIN LATERAL (
        SELECT aa.idcat_tipo_asa, ta.nombre FROM acabados_asas aa
        JOIN cat_tipo_asa ta ON ta.idcat_tipo_asa=aa.idcat_tipo_asa
        WHERE aa.idacabados_papel=ap.idacabados_papel LIMIT 1
      ) asa ON true
      LEFT JOIN producto_acabado_default pad ON pad.idproducto_papel=pp.idproducto_papel
      LEFT JOIN foil fo ON fo.idfoil=pad.idfoil_default
      LEFT JOIN cat_textura tex ON tex.idcat_textura=pad.idcat_textura_default
      LEFT JOIN LATERAL (
        SELECT public_id FROM archivos WHERE idproducto_papel=pp.idproducto_papel
          AND categoria='imagen-suaje-papel' ORDER BY id_archivo DESC LIMIT 1
      ) img_prev ON true
      WHERE pp.origen_expo = true AND pp.activo = true
      ORDER BY pp.idproducto_papel DESC`);

    const { rows: plasticoRows } = await pool.query(`
      SELECT cp.idconfiguracion_plastico AS idcatalogo_expo, 'plastico' AS categoria,
        COALESCE(NULLIF(cp.identificador,''), tpp.material_plastico_producto, cp.medida) AS nombre,
        cp.medida, mp.tipo_material AS material,
        COALESCE(cal.calibre_bopp, cal.calibre)::text AS calibre,
        false AS laminacion, NULL::text AS tipo_laminado,
        false AS hs, NULL::text AS tipo_hs, false AS ar, false AS textura, NULL::text AS tipo_textura,
        false AS uv,
        (pad.id_color_default IS NOT NULL) AS asa, ca.color AS tipo_asa,
        NULL::text AS otro, NULL::text AS tintas, pad.pigmento_default AS pigmento,
        cp.precio_500, cp.precio_1000, cp.precio_3000,
        tpp.material_plastico_producto AS tipo_producto,
        img_prev.public_id AS imagen_public_id
      FROM configuracion_plastico cp
      LEFT JOIN tipo_producto_plastico tpp ON tpp.idtipo_producto_plastico=cp.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN material_plastico mp ON mp.idmaterial_plastico=cp.material_plastico_plastico_idmaterial_plastico
      LEFT JOIN calibre cal ON cal.idcalibre=cp.calibre_idcalibre
      LEFT JOIN producto_acabado_default pad ON pad.idconfiguracion_plastico=cp.idconfiguracion_plastico
      LEFT JOIN color_asa ca ON ca.id_color=pad.id_color_default
      LEFT JOIN LATERAL (
        SELECT public_id FROM archivos WHERE idconfiguracion_plastico=cp.idconfiguracion_plastico
          AND categoria='imagen-producto-plastico' ORDER BY id_archivo DESC LIMIT 1
      ) img_prev ON true
      WHERE cp.origen_expo = true AND cp.activo = true
      ORDER BY cp.idconfiguracion_plastico DESC`);

    const rowsConUrls = await Promise.all(
      [...papelRows, ...plasticoRows].map(async (row) => {
        const { imagen_public_id, ...rest } = row;
        return { ...rest, imagen_url: imagen_public_id ? await getPresignedUrl(imagen_public_id) : null };
      })
    );
    return res.json(rowsConUrls);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
};

// Helper compartido: arma UN producto ya resuelto (post crear/editar) con la
// misma forma que getCatalogoPropio, para regresarlo en la respuesta de
// crear/actualizar sin repetir la query completa.
async function obtenerProductoCatalogoExpoPorId(
  id: number, categoria: "papel" | "carton" | "plastico"
) {
  if (categoria === "plastico") {
    const { rows } = await pool.query(`
      SELECT cp.idconfiguracion_plastico AS idcatalogo_expo, 'plastico' AS categoria,
        COALESCE(NULLIF(cp.identificador,''), tpp.material_plastico_producto, cp.medida) AS nombre,
        cp.medida, mp.tipo_material AS material,
        COALESCE(cal.calibre_bopp, cal.calibre)::text AS calibre,
        false AS laminacion, NULL::text AS tipo_laminado,
        false AS hs, NULL::text AS tipo_hs, false AS ar, false AS textura, NULL::text AS tipo_textura,
        false AS uv,
        (pad.id_color_default IS NOT NULL) AS asa, ca.color AS tipo_asa,
        NULL::text AS otro, NULL::text AS tintas, pad.pigmento_default AS pigmento,
        cp.precio_500, cp.precio_1000, cp.precio_3000,
        tpp.material_plastico_producto AS tipo_producto,
        img_prev.public_id AS imagen_public_id
      FROM configuracion_plastico cp
      LEFT JOIN tipo_producto_plastico tpp ON tpp.idtipo_producto_plastico=cp.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN material_plastico mp ON mp.idmaterial_plastico=cp.material_plastico_plastico_idmaterial_plastico
      LEFT JOIN calibre cal ON cal.idcalibre=cp.calibre_idcalibre
      LEFT JOIN producto_acabado_default pad ON pad.idconfiguracion_plastico=cp.idconfiguracion_plastico
      LEFT JOIN color_asa ca ON ca.id_color=pad.id_color_default
      LEFT JOIN LATERAL (
        SELECT public_id FROM archivos WHERE idconfiguracion_plastico=cp.idconfiguracion_plastico
          AND categoria='imagen-producto-plastico' ORDER BY id_archivo DESC LIMIT 1
      ) img_prev ON true
      WHERE cp.idconfiguracion_plastico = $1`, [id]);
    if (!rows.length) return null;
    const { imagen_public_id, ...rest } = rows[0];
    return { ...rest, imagen_url: imagen_public_id ? await getPresignedUrl(imagen_public_id) : null };
  }

  const { rows } = await pool.query(`
    SELECT pp.idproducto_papel AS idcatalogo_expo,
      (CASE WHEN pp.idproductos = 3 THEN 'carton' ELSE 'papel' END) AS categoria,
      pp.descripcion_papel AS nombre, pp.medida,
      mat.material, mat.calibre,
      (lam.idcat_laminado IS NOT NULL) AS laminacion, lam.nombre AS tipo_laminado,
      (pad.idfoil_default IS NOT NULL) AS hs,
      CASE WHEN fo.idfoil IS NOT NULL THEN concat(fo.colorfoil, CASE WHEN fo.codigofoil IS NOT NULL THEN ' '||fo.codigofoil ELSE '' END) END AS tipo_hs,
      COALESCE(pad.alto_relieve_default, false) AS ar,
      (pad.idcat_textura_default IS NOT NULL) AS textura,
      tex.nombre AS tipo_textura,
      COALESCE(pad.uv_default, false) AS uv,
      (asa.idcat_tipo_asa IS NOT NULL) AS asa, asa.nombre AS tipo_asa,
      NULL::text AS otro, NULL::text AS tintas,
      pp.precio_500, pp.precio_1000, pp.precio_3000,
      ctp.nombre AS tipo_producto,
      img_prev.public_id AS imagen_public_id
    FROM producto_papel pp
    LEFT JOIN cat_tipo_producto_papel ctp ON ctp.idcat_tipo_producto_papel=pp.idcat_tipo_producto_papel
    LEFT JOIN LATERAL (
      SELECT ctp2.nombre AS material, cc.nombre AS calibre
      FROM detalle_material_papel dmp
      JOIN grupo_papel gp ON gp.idgrupo_papel=dmp.idgrupo_papel
      LEFT JOIN cat_tipo_papel ctp2 ON ctp2.idcat_tipo_papel=dmp.idcat_tipo_papel
      LEFT JOIN cat_calibre cc ON cc.idcat_calibre=dmp.idcat_calibre
      WHERE gp.idproducto_papel=pp.idproducto_papel
      ORDER BY gp.orden ASC, dmp.orden ASC LIMIT 1
    ) mat ON true
    LEFT JOIN acabados_papel ap ON ap.idproducto_papel=pp.idproducto_papel
    LEFT JOIN LATERAL (
      SELECT al.idcat_laminado, cl.nombre FROM acabados_laminado al
      JOIN cat_laminado cl ON cl.idcat_laminado=al.idcat_laminado
      WHERE al.idacabados_papel=ap.idacabados_papel LIMIT 1
    ) lam ON true
    LEFT JOIN LATERAL (
      SELECT aa.idcat_tipo_asa, ta.nombre FROM acabados_asas aa
      JOIN cat_tipo_asa ta ON ta.idcat_tipo_asa=aa.idcat_tipo_asa
      WHERE aa.idacabados_papel=ap.idacabados_papel LIMIT 1
    ) asa ON true
    LEFT JOIN producto_acabado_default pad ON pad.idproducto_papel=pp.idproducto_papel
    LEFT JOIN foil fo ON fo.idfoil=pad.idfoil_default
    LEFT JOIN cat_textura tex ON tex.idcat_textura=pad.idcat_textura_default
    LEFT JOIN LATERAL (
      SELECT public_id FROM archivos WHERE idproducto_papel=pp.idproducto_papel
        AND categoria='imagen-suaje-papel' ORDER BY id_archivo DESC LIMIT 1
    ) img_prev ON true
    WHERE pp.idproducto_papel = $1`, [id]);
  if (!rows.length) return null;
  const { imagen_public_id, ...rest } = rows[0];
  return { ...rest, imagen_url: imagen_public_id ? await getPresignedUrl(imagen_public_id) : null };
}

// Guarda/actualiza laminado + asa (los únicos acabados que el sistema sí
// modela como atributo del producto) y los 3 precios de referencia.
async function aplicarAcabadosYPrecioPapel(
  client: any,
  idproducto_papel: number,
  datos: {
    tipo_laminado?: string | null; tipo_asa?: string | null;
    precio_500: number | null; precio_1000: number | null; precio_3000: number | null;
  }
) {
  await client.query(
    `UPDATE producto_papel SET precio_500=$1, precio_1000=$2, precio_3000=$3 WHERE idproducto_papel=$4`,
    [datos.precio_500, datos.precio_1000, datos.precio_3000, idproducto_papel]
  );

  if (!datos.tipo_laminado && !datos.tipo_asa) return;

  const { rows: acabRows } = await client.query(
    `SELECT idacabados_papel FROM acabados_papel WHERE idproducto_papel=$1`, [idproducto_papel]
  );
  let idacabados_papel: number;
  if (acabRows.length) {
    idacabados_papel = acabRows[0].idacabados_papel;
  } else {
    const { rows: nuevo } = await client.query(
      `INSERT INTO acabados_papel (idproducto_papel) VALUES ($1) RETURNING idacabados_papel`,
      [idproducto_papel]
    );
    idacabados_papel = nuevo[0].idacabados_papel;
  }

  if (datos.tipo_laminado) {
    const { rows: lamR } = await client.query(
      `SELECT idcat_laminado FROM cat_laminado WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
      [`%${datos.tipo_laminado.toLowerCase()}%`]
    );
    if (lamR[0]?.idcat_laminado) {
      await client.query(
        `INSERT INTO acabados_laminado (idacabados_papel, idcat_laminado) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [idacabados_papel, lamR[0].idcat_laminado]
      );
    }
  }

  if (datos.tipo_asa) {
    const { rows: asaR } = await client.query(
      `SELECT idcat_tipo_asa FROM cat_tipo_asa WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
      [`%${datos.tipo_asa.toLowerCase()}%`]
    );
    if (asaR[0]?.idcat_tipo_asa) {
      await client.query(
        `INSERT INTO acabados_asas (idacabados_papel, idcat_tipo_asa) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [idacabados_papel, asaR[0].idcat_tipo_asa]
      );
    }
  }
}

// ─── Acabados "de fábrica" (foil/textura/UV/AR para papel; pigmento/color
// de asa para plástico) — tabla aparte producto_acabado_default, no se pide
// prestado nada de acabados_papel. Resuelve nombre→ID igual que ya se hace
// en otros lados de este archivo (foil, textura, color de asa).
async function guardarAcabadosDefaultPapel(
  client: any, idproducto_papel: number,
  datos: { tipo_hs?: string | null; tipo_textura?: string | null; uv?: boolean; ar?: boolean }
) {
  let idfoil: number | null = null;
  if (datos.tipo_hs) {
    const termino = datos.tipo_hs.toLowerCase().trim();
    const palabras = termino.split(/\s+/);
    const ultima = palabras[palabras.length - 1];
    const { rows } = await client.query(
      `SELECT idfoil FROM foil WHERE LOWER(colorfoil) LIKE $1 OR LOWER(codigofoil) LIKE $2 LIMIT 1`,
      [`%${termino}%`, `%${ultima}%`]
    );
    idfoil = rows[0]?.idfoil ?? null;
  }
  let idcatTextura: number | null = null;
  if (datos.tipo_textura) {
    const { rows } = await client.query(
      `SELECT idcat_textura FROM cat_textura WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
      [`%${datos.tipo_textura.toLowerCase()}%`]
    );
    idcatTextura = rows[0]?.idcat_textura ?? null;
  }

  await client.query(`
    INSERT INTO producto_acabado_default (idproducto_papel, idfoil_default, idcat_textura_default, uv_default, alto_relieve_default)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (idproducto_papel) DO UPDATE SET
      idfoil_default        = COALESCE(EXCLUDED.idfoil_default, producto_acabado_default.idfoil_default),
      idcat_textura_default = COALESCE(EXCLUDED.idcat_textura_default, producto_acabado_default.idcat_textura_default),
      uv_default             = EXCLUDED.uv_default,
      alto_relieve_default   = EXCLUDED.alto_relieve_default`,
    [idproducto_papel, idfoil, idcatTextura, datos.uv === true, datos.ar === true]
  );
}

async function guardarAcabadosDefaultPlastico(
  client: any, idconfiguracion_plastico: number,
  datos: { pigmento?: string | null; tipo_asa?: string | null }
) {
  let idColor: number | null = null;
  if (datos.tipo_asa) {
    const { rows } = await client.query(
      `SELECT id_color FROM color_asa WHERE LOWER(color) LIKE $1 LIMIT 1`,
      [`%${datos.tipo_asa.toLowerCase()}%`]
    );
    idColor = rows[0]?.id_color ?? null;
  }

  await client.query(`
    INSERT INTO producto_acabado_default (idconfiguracion_plastico, pigmento_default, id_color_default)
    VALUES ($1,$2,$3)
    ON CONFLICT (idconfiguracion_plastico) DO UPDATE SET
      pigmento_default = COALESCE(EXCLUDED.pigmento_default, producto_acabado_default.pigmento_default),
      id_color_default = COALESCE(EXCLUDED.id_color_default, producto_acabado_default.id_color_default)`,
    [idconfiguracion_plastico, datos.pigmento || null, idColor]
  );
}

export const getCatalogoSistema = async (req: Request, res: Response) => {
  try {
    const { rows: plasticoRaw } = await pool.query(`
      SELECT cp.idconfiguracion_plastico AS id,'plastico' AS categoria,
        tpp.material_plastico_producto AS nombre, cp.medida,
        mp.tipo_material AS material, cal.calibre, cal.calibre_bopp,
        cp.altura,cp.ancho,cp.fuelle_fondo,cp.fuelle_latiz,cp.fuelle_latde,cp.refuerzo,cp.por_kilo,
        cp.tamano_prod, cp.precio_500, cp.precio_1000, cp.precio_3000,
        pad.pigmento_default AS pigmento,
        (pad.id_color_default IS NOT NULL) AS asa, ca.color AS tipo_asa,
        pad.idsuaje_default AS idsuaje,
        pad.id_color_default AS id_color,
        img_prev.public_id AS imagen_public_id
      FROM configuracion_plastico cp
      LEFT JOIN tipo_producto_plastico tpp ON tpp.idtipo_producto_plastico=cp.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN material_plastico mp ON mp.idmaterial_plastico=cp.material_plastico_plastico_idmaterial_plastico
      LEFT JOIN calibre cal ON cal.idcalibre=cp.calibre_idcalibre
      LEFT JOIN producto_acabado_default pad ON pad.idconfiguracion_plastico=cp.idconfiguracion_plastico
      LEFT JOIN color_asa ca ON ca.id_color=pad.id_color_default
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

    // ── Papel del sistema — ahora también trae la imagen registrada en el
    // alta de "Productos Papel" (carpeta interna "suaje", subcarpeta
    // "imagen"), para poder mostrarla en el catálogo de Expo. Se resuelve
    // con un LATERAL a `archivos` (mismo patrón que ya usa
    // getProductosPapel en producto_papel.controller.ts) y se firma la URL
    // después, en JS, igual que ahí.
    //
    // NUEVO: también trae laminado + asa (acabados_papel/acabados_laminado/
    // acabados_asas) y foil/textura/UV/AR (producto_acabado_default) — antes
    // esta query no los pedía y por eso al arrastrar un producto al
    // cotizador salían todos "Sin ___" aunque sí estuvieran guardados.
    const { rows: papelRaw } = await pool.query(`
      SELECT pp.idproducto_papel AS id,'papel' AS categoria,
        ctp.nombre AS nombre, pp.medida, pp.descripcion_papel,
        pp.ancho,pp.fuelle,pp.altura,
        pp.tamano_prod, pp.precio_500, pp.precio_1000, pp.precio_3000,
        (SELECT ctp2.nombre FROM detalle_material_papel dmp
         JOIN cat_tipo_papel ctp2 ON ctp2.idcat_tipo_papel=dmp.idcat_tipo_papel
         WHERE dmp.idgrupo_papel IN (SELECT gp.idgrupo_papel FROM grupo_papel gp WHERE gp.idproducto_papel=pp.idproducto_papel)
         LIMIT 1) AS primer_material,
        (SELECT cc.nombre FROM detalle_material_papel dmp
         JOIN cat_calibre cc ON cc.idcat_calibre=dmp.idcat_calibre
         WHERE dmp.idgrupo_papel IN (SELECT gp.idgrupo_papel FROM grupo_papel gp WHERE gp.idproducto_papel=pp.idproducto_papel)
         LIMIT 1) AS primer_calibre,
        (lam.idcat_laminado IS NOT NULL) AS laminacion, lam.nombre AS tipo_laminado, lam.idcat_laminado AS idcat_laminado,
        (asa.idcat_tipo_asa IS NOT NULL) AS asa, asa.nombre AS tipo_asa, asa.idcat_tipo_asa AS idcat_tipo_asa,
        (pad.idfoil_default IS NOT NULL) AS hs,
        CASE WHEN fo.idfoil IS NOT NULL THEN concat(fo.colorfoil, CASE WHEN fo.codigofoil IS NOT NULL THEN ' '||fo.codigofoil ELSE '' END) END AS tipo_hs,
        fo.idfoil AS idfoil,
        COALESCE(pad.alto_relieve_default, false) AS ar,
        (pad.idcat_textura_default IS NOT NULL) AS textura,
        tex.nombre AS tipo_textura,
        pad.idcat_textura_default AS idcat_textura,
        COALESCE(pad.uv_default, false) AS uv,
        img_prev.public_id AS imagen_public_id
      FROM producto_papel pp
      LEFT JOIN cat_tipo_producto_papel ctp ON ctp.idcat_tipo_producto_papel=pp.idcat_tipo_producto_papel
      LEFT JOIN acabados_papel ap ON ap.idproducto_papel=pp.idproducto_papel
      LEFT JOIN LATERAL (
        SELECT al.idcat_laminado, cl.nombre FROM acabados_laminado al
        JOIN cat_laminado cl ON cl.idcat_laminado=al.idcat_laminado
        WHERE al.idacabados_papel=ap.idacabados_papel LIMIT 1
      ) lam ON true
      LEFT JOIN LATERAL (
        SELECT aa.idcat_tipo_asa, ta.nombre FROM acabados_asas aa
        JOIN cat_tipo_asa ta ON ta.idcat_tipo_asa=aa.idcat_tipo_asa
        WHERE aa.idacabados_papel=ap.idacabados_papel LIMIT 1
      ) asa ON true
      LEFT JOIN producto_acabado_default pad ON pad.idproducto_papel=pp.idproducto_papel
      LEFT JOIN foil fo ON fo.idfoil=pad.idfoil_default
      LEFT JOIN cat_textura tex ON tex.idcat_textura=pad.idcat_textura_default
      LEFT JOIN LATERAL (
        SELECT public_id FROM archivos
        WHERE idproducto_papel = pp.idproducto_papel
          AND categoria = 'imagen-suaje-papel'
        ORDER BY id_archivo DESC
        LIMIT 1
      ) img_prev ON true
      WHERE pp.activo=true ORDER BY ctp.nombre,pp.medida`);

    const papel = await Promise.all(
      papelRaw.map(async (row) => {
        const { imagen_public_id, ...rest } = row;
        return {
          ...rest,
          imagen_url: imagen_public_id ? await getPresignedUrl(imagen_public_id) : null,
        };
      })
    );

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
// (Se sigue usando por compatibilidad con los ~16 productos viejos que
// puedan quedar todavía ligados vía catalogo_expo → producto_papel; para
// productos creados con el flujo nuevo esto ya no aplica, porque ya no hay
// una tabla catalogo_expo separada de la que "desconectarse".)
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

// Actualiza EN EL MISMO producto_papel (sin crear uno nuevo) sus campos
// descriptivos — usada tanto por actualizarProductoCatalogo (flujo nuevo)
// como por el flujo viejo de compatibilidad.
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

// Igual que arriba pero para configuracion_plastico.
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

export const crearProductoCatalogo = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const {
      nombre, categoria, medida, material, calibre,
      tipo_laminado, tipo_asa,
      tipo_hs, tipo_textura, uv, ar, pigmento,
      precio_500, precio_1000, precio_3000,
      tipo_producto,
      altura, ancho, fuelle, fuelle_fondo, fuelle_lateral_iz, fuelle_lateral_de, refuerzo,
    } = req.body;

    if (!nombre?.trim()) return res.status(400).json({ error: "El nombre es requerido" });
    if (!["papel", "plastico", "carton"].includes(categoria))
      return res.status(400).json({ error: `Categoría inválida: "${categoria}"` });

    const num = (v: any) => (v != null && v !== "") ? Number(v) : null;
    const bool = (v: any) => v === true || v === "true";

    await client.query("BEGIN");

    // ── Plástico: registro directo, sin acabados especiales ────────────────
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
          calibre_idcalibre, altura, fuelle_fondo, refuerzo, ancho,
          fuelle_latIz, fuelle_latDe, medida, por_kilo,
          precio_500, precio_1000, precio_3000, activo, origen_expo
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,$12,$13,true,true)
        RETURNING idconfiguracion_plastico`,
        [materialId, tipoId, calibreId,
         num(altura), num(fuelle_fondo), num(refuerzo), num(ancho),
         num(fuelle_lateral_iz), num(fuelle_lateral_de), medida || nombre.trim(),
         num(precio_500), num(precio_1000), num(precio_3000)]
      );
      const idconfiguracion_plastico = cpRows[0].idconfiguracion_plastico;

      if (pigmento || tipo_asa) {
        await guardarAcabadosDefaultPlastico(client, idconfiguracion_plastico, { pigmento, tipo_asa });
      }

      await client.query("COMMIT");
      const prod = await obtenerProductoCatalogoExpoPorId(idconfiguracion_plastico, "plastico");
      return res.status(201).json({ message: "Producto agregado", producto: prod });
    }

    // ── Papel / cartón: reutiliza resolverFKsProductoExpo (ya sabe buscar
    // o crear un producto_papel a partir de tipo+material+calibre+medida) ──
    const fks = await resolverFKsProductoExpo(client, {
      categoria, nombre: nombre.trim(), material: material || null, calibre: calibre || null,
      tipo_producto: tipo_producto || null,
      altura: num(altura), ancho: num(ancho), fuelle: num(fuelle),
      fuelle_fondo: null, fuelle_lateral_iz: null, fuelle_lateral_de: null, refuerzo: null,
    });

    if (!fks.idproducto_papel) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "No se pudo resolver el tipo de producto — revisa que el 'Tipo' capturado exista en el catálogo de Papel.",
      });
    }

    // resolverFKsProductoExpo solo pone descripcion_papel al CREAR uno
    // nuevo; si reusó uno existente sin nombre, lo completamos aquí.
    await client.query(
      `UPDATE producto_papel SET descripcion_papel = COALESCE(NULLIF(descripcion_papel,''), $1) WHERE idproducto_papel = $2`,
      [nombre.trim(), fks.idproducto_papel]
    );

    await aplicarAcabadosYPrecioPapel(client, fks.idproducto_papel, {
      tipo_laminado, tipo_asa,
      precio_500: num(precio_500), precio_1000: num(precio_1000), precio_3000: num(precio_3000),
    });

    if (tipo_hs || tipo_textura || uv != null || ar != null) {
      await guardarAcabadosDefaultPapel(client, fks.idproducto_papel, {
        tipo_hs, tipo_textura, uv: bool(uv), ar: bool(ar),
      });
    }

    await client.query("COMMIT");
    const prod = await obtenerProductoCatalogoExpoPorId(fks.idproducto_papel, categoria === "carton" ? "carton" : "papel");
    return res.status(201).json({ message: "Producto agregado", producto: prod });
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
      nombre, categoria, medida, material, calibre,
      tipo_laminado, tipo_asa,
      tipo_hs, tipo_textura, uv, ar, pigmento,
      precio_500, precio_1000, precio_3000,
      tipo_producto,
      altura, ancho, fuelle, fuelle_fondo, fuelle_lateral_iz, fuelle_lateral_de, refuerzo,
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
        `UPDATE configuracion_plastico SET precio_500=$1, precio_1000=$2, precio_3000=$3 WHERE idconfiguracion_plastico=$4`,
        [num(precio_500), num(precio_1000), num(precio_3000), id]
      );
      if (pigmento || tipo_asa) {
        await guardarAcabadosDefaultPlastico(client, Number(id), { pigmento, tipo_asa });
      }
      await client.query("COMMIT");
      const prod = await obtenerProductoCatalogoExpoPorId(Number(id), "plastico");
      if (!prod) return res.status(404).json({ error: "Producto no encontrado" });
      return res.json({ message: "Producto actualizado", producto: prod });
    }

    await actualizarProductoPapelEnLugar(client, Number(id), {
      nombre: nombre?.trim() || "", material: material || null, calibre: calibre || null,
      tipo_producto: tipo_producto || null, altura: num(altura), ancho: num(ancho), fuelle: num(fuelle),
    });
    await aplicarAcabadosYPrecioPapel(client, Number(id), {
      tipo_laminado, tipo_asa,
      precio_500: num(precio_500), precio_1000: num(precio_1000), precio_3000: num(precio_3000),
    });
    if (tipo_hs || tipo_textura || uv != null || ar != null) {
      await guardarAcabadosDefaultPapel(client, Number(id), {
        tipo_hs, tipo_textura, uv: bool(uv), ar: bool(ar),
      });
    }

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

// NOTA: ahora exige `categoria` (papel/carton/plastico) en el body o
// querystring para saber en qué tabla buscar — antes no hacía falta porque
// catalogo_expo era una sola tabla. El `AND origen_expo=true` es además una
// protección extra: este endpoint nunca puede desactivar por accidente un
// producto que alguien dio de alta a mano en Papel.tsx/Plastico.tsx.
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

export const getSiguienteFolioExpo = async (req: Request, res: Response) => {
  try {
    const yy = new Date().getFullYear().toString().slice(-2);
    const { rows } = await pool.query(`
      SELECT COALESCE(MAX(CAST(SUBSTRING(no_cotizacion FROM 'CO${yy}(\\d+)') AS INTEGER)),0)+1 AS siguiente
      FROM solicitud WHERE no_cotizacion LIKE 'CO${yy}%'`);
    const folio = `CO${yy}${String(rows[0].siguiente).padStart(3, "0")}`;
    return res.json({ folio });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
};

export const crearCotizacionExpo = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { clienteId, productos, comentarios } = req.body;
    if (!clienteId) return res.status(400).json({ error: "Se requiere clienteId" });
    if (!productos?.length) return res.status(400).json({ error: "Se requiere al menos un producto" });

    await client.query("BEGIN");
    const folioCotizacion = await obtenerSiguienteFolioCotizacion(client);
    const { rows: solRows } = await client.query(`
      INSERT INTO solicitud (clientes_idclientes,estado_administrativo_cat_idestado_administrativo_cat,
        estado,no_cotizacion,origen_expo,sin_iva)
      VALUES ($1,$2,'cotizacion',$3,true,false)
      RETURNING idsolicitud,no_cotizacion`,
      [clienteId, ESTADO.PENDIENTE, folioCotizacion]
    );
    const solicitudId = solRows[0].idsolicitud;
    const noCotizacion = solRows[0].no_cotizacion;
    console.log(`✅ [EXPO] Solicitud ${noCotizacion} id=${solicitudId}`);

    // Comentarios generales de la cotización — se guardan en observacion de cada producto
    const obsGeneral = comentarios?.trim() || null;

    let subtotalTotal = 0;

    for (const prod of productos) {
      console.log("[EXPO] tipoCotizacion:", prod.tipoCotizacion, "nombre:", prod.nombre);


      // ── PAPEL SIGEB (sistema) ──────────────────────────────────────────────
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

        // Resolver grupo_descripcion si no viene del frontend
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

        let metodo_hojeado: "hojeado" | "guillotina" = "hojeado";
        if (prod.idproducto_papel) {
          const { rows: maq } = await client.query(
            `SELECT c.nombre FROM maquinaria_hojeado_guillotina m
             JOIN cat_hojeado_guillotina c ON c.idcat_hojeado_guillotina = m.idcat_hojeado_guillotina
             WHERE m.idproducto_papel = $1 LIMIT 1`,
            [prod.idproducto_papel]
          );
          const nombreMaq = (maq[0]?.nombre || "").toLowerCase();
          if (nombreMaq.includes("guillotina")) metodo_hojeado = "guillotina";
        }

        let tintasId = prod.tintasId ?? null;
        if (!tintasId) {
          const { rows: tRows } = await client.query(
            `SELECT idtintas FROM tintas WHERE cantidad=1 LIMIT 1`
          );
          tintasId = tRows[0]?.idtintas ?? null;
        }

        const papelPayload: ProductoPapelPayload = {
          tipoCotizacion: "papel",
          idproducto_papel: prod.idproducto_papel,
          nombre: prod.nombre ?? "",
          idgrupo_papel,
          grupo_descripcion: grupo_descripcion,
          tintasId,
          pantones: prod.pantones ?? null,
          tintasDentroId: prod.tintasDentroId ?? null,
          pantonesDentro: prod.pantonesDentro ?? null,
          carasId: prod.carasId ?? null,
          id_asa: prod.id_asa ?? null,
          idcat_laminado: prod.idcat_laminado ?? null,
          idfoil: prod.idfoil ?? null,
          idcat_textura: prod.idcat_textura ?? null,
          uv: prod.uv ?? false,
          alto_relieve: prod.alto_relieve ?? false,
          observacion: prod.observacion || obsGeneral,   // ← comentarios generales
          descripcion: prod.descripcion ?? null,
          cantidades: prod.cantidades,
          precios: prod.precios,
          herramental_descripcion: null,
          herramental_precio: null,
          cargo_adicional_descripcion: null,
          cargo_adicional_precio: null,
          metodo_hojeado,
          lleva_armado: prod.lleva_armado ?? false,
        };

        subtotalTotal += await insertarProductoPapel(client, solicitudId, papelPayload, "cotizacion");
        continue;
      }

      // ── PAPEL EXPO PROPIO (categoría papel/cartón del catálogo expo) ────────
      if (prod.tipoCotizacion === "expo_papel") {
        const {
          nombre: epNombre = null, tintas_cantidad: epTintas,
          tipoLaminado = null, tipoHs = null, tipoTextura = null, tipoAsa: epTipoAsa = null,
          uv: epUv = false, ar: epAr = false,
          cantidades: epCants, precios: epPrecios,
          observacion: epObs = null,
        } = prod;

        let epTintasId: number | null = null;
        if (epTintas != null) {
          const num = parseInt(String(epTintas), 10);
          if (!isNaN(num)) {
            const { rows: tr } = await client.query(
              `SELECT idtintas FROM tintas WHERE cantidad=$1 LIMIT 1`, [num]
            );
            epTintasId = tr[0]?.idtintas ?? null;
          }
        }

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
            [solicitudId, epTintasId, epNombre || null, epObs || obsGeneral || null]  // ← comentarios generales
          );
          const spGenId = spGenRows[0].idsolicitud_producto;
          for (let i = 0; i < 3; i++) {
            const cant = Number(epCants?.[i] ?? 0);
            const precio = Number(epPrecios?.[i] ?? 0);
            if (cant > 0 && precio > 0) {
              await client.query(`
                INSERT INTO solicitud_detalle (solicitud_producto_id, cantidad, precio_total, aprobado, modo_cantidad)
                VALUES ($1,$2,$3,$4,'unidad')`,
                [spGenId, cant, Math.round(cant * precio * 100) / 100, null]
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

        console.log("[EXPO] epGrupoDesc:", epGrupoDesc);
        console.log("[EXPO] catExpoRows:", catExpoRows.length, catExpoRows[0]?.material, catExpoRows[0]?.calibre);

        // ← NUEVO: fallback desde catálogo expo si no hay grupo_descripcion
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
          pantones: null,
          tintasDentroId: null,
          pantonesDentro: null,
          carasId: null,
          id_asa: epIdAsa,
          idcat_laminado: epIdLaminado,
          idfoil: epIdFoil,
          idcat_textura: epIdTextura,
          uv: epUv === true,
          alto_relieve: epAr === true,
          observacion: epObs || obsGeneral || null,  // ← comentarios generales
          descripcion: epNombre ?? null,
          cantidades: epCants ?? [0, 0, 0],
          precios: epPrecios ?? [0, 0, 0],
          herramental_descripcion: null,
          herramental_precio: null,
          cargo_adicional_descripcion: null,
          cargo_adicional_precio: null,
          metodo_hojeado: "hojeado",
          lleva_armado: false,
        };

        subtotalTotal += await insertarProductoPapel(client, solicitudId, epPayload, "cotizacion");
        continue;
      }

      // ── PLÁSTICO (sistema o expo) — igual a SIGEB normal ─────────────────
      const {
        configuracion_plastico_id,
        tintas_cantidad,
        nombre: prodNombre = null,
        observacion: prodObs = null,
        cantidades,
        precios,
        idsuaje: prodIdsuaje = null,
        id_color: prodIdColor = null,
        pigmento: prodPigmento = null,
      } = prod;

      const tipoMaterial = configuracion_plastico_id ? "plastico" : "expo";

      let tintasId: number | null = null;
      if (tintas_cantidad != null) {
        const tNum = parseInt(String(tintas_cantidad), 10);
        if (!isNaN(tNum)) {
          const { rows: tr } = await client.query(
            `SELECT idtintas FROM tintas WHERE cantidad=$1 LIMIT 1`, [tNum]
          );
          tintasId = tr[0]?.idtintas ?? null;
        }
      }

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
          prodObs || obsGeneral || null,   // ← comentarios generales
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

export const getCotizacionesExpo = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        s.idsolicitud, s.no_cotizacion, s.no_pedido, s.estado, s.fecha,
        s.clientes_idclientes,
        cli.atencion AS cliente, cli.celular, cli.correo, cli.impresion,
        cli.clasificacion_expo, cli.intereses_expo, cli.observaciones_expo, cli.identificar,
        dom.poblacion AS ciudad, dom.estado AS estado_cliente,
        sp.idsolicitud_producto, sp.tipo_material, sp.descripcion, sp.observacion,
        sp.configuracion_plastico_idconfiguracion_plastico,
        sp.producto_papel_idproducto_papel,
        sp.pigmentos,
        sp.grupo_papel_descripcion,
sp.grupo_papel_idgrupo_papel,
        sp.idsuaje, sp.id_color,
        asz.tipo AS suaje_tipo,
        ca.color AS color_asa_nombre,
        t.cantidad AS tintas_cantidad,
        cfg.medida AS cfg_medida,
        tpp.material_plastico_producto AS tipo_producto_nombre,
        mp.tipo_material AS material_nombre,
        cal.calibre AS calibre_numero, cal.calibre_bopp,
        ctp.nombre AS papel_tipo_producto,
        pp.medida AS papel_medida, pp.descripcion_papel AS papel_descripcion,
        spp.id_asa, asa.nombre AS asa_nombre,
        spp.idcat_laminado, lam.nombre AS laminado_nombre,
        spp.idfoil, fo.colorfoil AS foil_color, fo.codigofoil AS foil_codigo,
        spp.idcat_textura, tex.nombre AS textura_nombre,
        spp.uv, spp.alto_relieve,
        sd.idsolicitud_detalle, sd.cantidad, sd.precio_total, sd.precio_unitario, sd.aprobado,
        ce_exp.medida AS expo_medida, ce_exp.material AS expo_material, ce_exp.calibre AS expo_calibre,
        ce_exp.tipo_producto AS expo_tipo_producto
      FROM solicitud s
      LEFT JOIN clientes cli ON cli.idclientes=s.clientes_idclientes
      LEFT JOIN domicilio dom ON dom.clientes_idclientes=cli.idclientes
      LEFT JOIN solicitud_producto sp ON sp.solicitud_idsolicitud=s.idsolicitud
      LEFT JOIN asa_suaje asz ON asz.idsuaje=sp.idsuaje
      LEFT JOIN color_asa ca ON ca.id_color=sp.id_color
      LEFT JOIN tintas t ON t.idtintas=sp.tintas_idtintas
      LEFT JOIN configuracion_plastico cfg ON cfg.idconfiguracion_plastico=sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN tipo_producto_plastico tpp ON tpp.idtipo_producto_plastico=cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN material_plastico mp ON mp.idmaterial_plastico=cfg.material_plastico_plastico_idmaterial_plastico
      LEFT JOIN calibre cal ON cal.idcalibre=cfg.calibre_idcalibre
      LEFT JOIN producto_papel pp ON pp.idproducto_papel=sp.producto_papel_idproducto_papel
      LEFT JOIN cat_tipo_producto_papel ctp ON ctp.idcat_tipo_producto_papel=pp.idcat_tipo_producto_papel
      LEFT JOIN solicitud_producto_papel spp ON spp.idsolicitud_producto=sp.idsolicitud_producto
      LEFT JOIN cat_tipo_asa asa ON asa.idcat_tipo_asa=spp.id_asa
      LEFT JOIN cat_laminado lam ON lam.idcat_laminado=spp.idcat_laminado
      LEFT JOIN foil fo ON fo.idfoil=spp.idfoil
      LEFT JOIN cat_textura tex ON tex.idcat_textura=spp.idcat_textura
      LEFT JOIN grupo_papel gp ON gp.idgrupo_papel=sp.grupo_papel_idgrupo_papel
      LEFT JOIN LATERAL (
        SELECT ce.medida, ce.material, ce.calibre, ce.tipo_producto
        FROM catalogo_expo ce
        WHERE sp.tipo_material = 'expo'
          AND ce.activo = true
          AND LOWER(ce.nombre) = LOWER(sp.descripcion)
        ORDER BY ce.idcatalogo_expo DESC
        LIMIT 1
      ) ce_exp ON true
      LEFT JOIN solicitud_detalle sd ON sd.solicitud_producto_id=sp.idsolicitud_producto
      WHERE s.origen_expo=true
      ORDER BY s.fecha DESC, sp.idsolicitud_producto, sd.idsolicitud_detalle`);

    const agrupadas: Record<string, any> = {};
    for (const row of rows) {
      const key = String(row.idsolicitud);
      if (!agrupadas[key]) {
        agrupadas[key] = {
          idsolicitud: row.idsolicitud, no_cotizacion: row.no_cotizacion,
          no_pedido: row.no_pedido, estado: row.estado, fecha: row.fecha,
          cliente_id: row.clientes_idclientes, cliente: row.cliente || "",
          celular: row.celular || "", correo: row.correo || "", impresion: row.impresion || "",
          clasificacion: row.clasificacion_expo || "", intereses: row.intereses_expo || [],
          observaciones: row.observaciones_expo || "", ciudad: row.ciudad || "",
          estado_cliente: row.estado_cliente || "", identificar: row.identificar || "",
          productos: [],
        };
      }
      if (!row.idsolicitud_producto) continue;
      let prod = agrupadas[key].productos.find(
        (p: any) => p.idsolicitud_producto === row.idsolicitud_producto
      );
      if (!prod) {
        let nombre = row.descripcion || "";
        if (!nombre) {
          if (row.tipo_material === "papel") {
            nombre = row.papel_tipo_producto
              ? (row.papel_descripcion ? `${row.papel_tipo_producto} — ${row.papel_descripcion}` : row.papel_tipo_producto)
              : `Papel #${row.producto_papel_idproducto_papel}`;
          } else if (row.cfg_medida) {
            nombre = [row.tipo_producto_nombre, row.cfg_medida,
            (row.material_nombre || "").toLowerCase()].filter(Boolean).join(" ");
          } else { nombre = "Producto expo"; }
        }
        const foilNombre = row.foil_color
          ? `${row.foil_color}${row.foil_codigo ? " " + row.foil_codigo : ""}` : null;
prod = {
  idsolicitud_producto: row.idsolicitud_producto,
  tipo_material: row.tipo_material, nombre,
  medida: row.tipo_material === "papel" ? row.papel_medida : (row.cfg_medida || row.expo_medida || null),
  material: row.material_nombre || row.expo_material || null,
  calibre: (() => {
    const esBoppRow = (row.material_nombre || "").toUpperCase() === "BOPP";
    if (esBoppRow) return row.calibre_bopp != null ? String(row.calibre_bopp) : (row.expo_calibre || null);
    return row.calibre_numero != null ? String(row.calibre_numero) : (row.expo_calibre || null);
  })(),
  tipo_producto: row.tipo_material === "papel"
    ? (row.papel_tipo_producto ?? null)
    : (row.tipo_producto_nombre || row.expo_tipo_producto || null),
  tintas: row.tintas_cantidad ?? null,
          descripcion: row.descripcion || null, observacion: row.observacion || null,
          pigmentos: row.pigmentos || null,
          idsuaje: row.idsuaje ?? null, suaje_tipo: row.suaje_tipo ?? null,
          id_color: row.id_color ?? null, color_asa_nombre: row.color_asa_nombre ?? null,
          id_asa: row.id_asa ?? null, asa_nombre: row.asa_nombre ?? null,
          idcat_laminado: row.idcat_laminado ?? null, laminado_nombre: row.laminado_nombre ?? null,
          idfoil: row.idfoil ?? null, foil_nombre: foilNombre,
          grupo_descripcion: row.grupo_papel_descripcion ?? null,
          idcat_textura: row.idcat_textura ?? null, textura_nombre: row.textura_nombre ?? null,
          uv: row.uv ?? false, alto_relieve: row.alto_relieve ?? false,
          detalles: [],
        };
        agrupadas[key].productos.push(prod);
      }
      if (row.idsolicitud_detalle) {
        prod.detalles.push({
          idsolicitud_detalle: row.idsolicitud_detalle,
          cantidad: Number(row.cantidad),
          precio_total: Number(row.precio_total),
          precio_unitario: row.precio_unitario != null ? Number(row.precio_unitario) : null,
          aprobado: row.aprobado,
        });
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
      `SELECT idsolicitud,estado,no_pedido,sin_iva FROM solicitud
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
    await crearVentaYDiseno(client, sol.idsolicitud, folioPedido, Number(stRows[0].subtotal), sol.sin_iva);
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