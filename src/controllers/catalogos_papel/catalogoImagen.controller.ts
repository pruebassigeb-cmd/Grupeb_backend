import { qAudit } from "../../middlewares/auditoria";
import { Request, Response } from "express";
import { pool } from "../../config/db";
import { uploadToS3, deleteFromS3, getPresignedUrl, CARPETAS, MulterFile } from "../../config/multer";

// ═══════════════════════════════════════════════════════════════════════════
// Imágenes de referencia de catálogos de papel.
//
// Reutiliza la tabla `archivos` (mismo mecanismo que fotos de producto,
// diseño, etc.) en vez de agregar una columna id_archivo en cada tabla
// cat_*. `catalogo_id = NULL` significa "imagen global" del catálogo —
// usado por HS y AR / UV, donde la imagen es de la máquina/proceso en
// general y no de un renglón particular.
// ═══════════════════════════════════════════════════════════════════════════

type RequestConArchivo = Request & { file?: MulterFile };

// Nota: "color_asa" NO lleva imagen — ahí solo se usa el swatch de color/hex.
const CATALOGOS_CON_IMAGEN = [
  "tipo_producto",
  "tipo_papel",
  "tipo_asa",
  "laminado",
  "textura",
  "foil",
  "hs_ar",
  "uv",
  // ✅ NUEVO — catálogos de plástico (medidas_troquel, asa_suaje,
  // cinta_seguridad usan su propio idcatalogo como catalogo_id;
  // tipo_producto_plastico también gana imagen aquí).
  "tipo_producto_plastico",
  "medidas_troquel",
  "asa_suaje",
  "cinta_seguridad",
] as const;

type CatalogoConImagen = (typeof CATALOGOS_CON_IMAGEN)[number];

const esCatalogoValido = (v: unknown): v is CatalogoConImagen =>
  typeof v === "string" && (CATALOGOS_CON_IMAGEN as readonly string[]).includes(v);

// ═══════════════════════════════════════════════════════════════════════════
// GET /catalogos-papel/imagenes — todas las imágenes activas, con URL
// prefirmada, en una sola consulta (evita N llamadas a S3 desde el front).
// ═══════════════════════════════════════════════════════════════════════════
export const getImagenesCatalogo = async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id_archivo, catalogo_key, catalogo_id, public_id
       FROM archivos
       WHERE catalogo_key IS NOT NULL AND eliminado_at IS NULL
       ORDER BY id_archivo`
    );

    const conUrl = await Promise.all(
      rows.map(async (r) => ({
        id_archivo: r.id_archivo,
        catalogo_key: r.catalogo_key,
        catalogo_id: r.catalogo_id,
        url: await getPresignedUrl(r.public_id),
      }))
    );

    return res.json(conUrl);
  } catch (error: any) {
    console.error("❌ GET IMAGENES CATALOGO ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener imágenes de catálogo" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /catalogos-papel/imagenes — sube/reemplaza la imagen de un renglón
// de catálogo (o la imagen global si catalogo_id viene vacío).
// ═══════════════════════════════════════════════════════════════════════════
export const subirImagenCatalogo = async (req: RequestConArchivo, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No se recibió ningún archivo" });
      return;
    }

    const catalogo_key = req.body.catalogo_key;
    if (!esCatalogoValido(catalogo_key)) {
      res.status(400).json({ error: "catalogo_key inválido" });
      return;
    }
    const catalogo_id = req.body.catalogo_id ? Number(req.body.catalogo_id) : null;

    // Si ya había una imagen para este renglón (o la global), se reemplaza:
    // se borra la anterior de S3 y de la tabla antes de insertar la nueva.
    const { rows: existentes } = await pool.query(
      `SELECT id_archivo, public_id FROM archivos
       WHERE catalogo_key = $1 AND catalogo_id IS NOT DISTINCT FROM $2 AND eliminado_at IS NULL`,
      [catalogo_key, catalogo_id]
    );
    for (const existente of existentes) {
      await deleteFromS3(existente.public_id);
      await pool.query(`DELETE FROM archivos WHERE id_archivo = $1`, [existente.id_archivo]);
    }

    // Una subcarpeta por tipo de catálogo (tipo_producto, tipo_asa, foil, ...)
    // para que se vean organizados en la pantalla de Gestión de Archivos.
    const { url, public_id, resource_type } = await uploadToS3(req.file, CARPETAS.catalogos_admin, catalogo_key);
    const subidoPor = (req as any).user?.id || null;

    const { rows } = await qAudit(req)(
      `INSERT INTO archivos
        (nombre, tipo, mime_type, url, public_id, tamano_kb, subido_por, resource_type, categoria, catalogo_key, catalogo_id)
       VALUES ($1, $2, 'image', $3, $4, $5, $6, $7, 'otro', $8, $9)
       RETURNING id_archivo, catalogo_key, catalogo_id, public_id`,
      [
        req.file.originalname,
        "image",
        url,
        public_id,
        Math.round(req.file.size / 1024),
        subidoPor,
        resource_type,
        catalogo_key,
        catalogo_id,
      ]
    );

    const fila = rows[0];
    res.status(201).json({
      id_archivo: fila.id_archivo,
      catalogo_key: fila.catalogo_key,
      catalogo_id: fila.catalogo_id,
      url: await getPresignedUrl(fila.public_id),
    });
  } catch (error: any) {
    console.error("❌ SUBIR IMAGEN CATALOGO ERROR:", error.message);
    res.status(500).json({ error: "Error al subir la imagen del catálogo" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /catalogos-papel/imagenes/:id_archivo — solo borra imágenes de
// catálogo (catalogo_key IS NOT NULL), no cualquier archivo de la tabla.
// ═══════════════════════════════════════════════════════════════════════════
export const eliminarImagenCatalogo = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id_archivo } = req.params;

    const { rows } = await pool.query(
      `SELECT public_id FROM archivos WHERE id_archivo = $1 AND catalogo_key IS NOT NULL`,
      [id_archivo]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "Imagen no encontrada" });
      return;
    }

    await deleteFromS3(rows[0].public_id);
    await req.tx((client) => client.query(`DELETE FROM archivos WHERE id_archivo = $1`, [id_archivo]));

    res.json({ message: "Imagen eliminada" });
  } catch (error: any) {
    console.error("❌ ELIMINAR IMAGEN CATALOGO ERROR:", error.message);
    res.status(500).json({ error: "Error al eliminar la imagen" });
  }
};
