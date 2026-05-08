import { Request, Response } from "express";
import { uploadToS3, deleteFromS3, getPresignedUrl, CarpetaS3, CARPETAS, MulterFile } from "../../config/multer";
import { pool } from "../../config/db";

// Request extendido con file tipado con nuestra interfaz propia
type RequestConArchivo = Request & { file?: MulterFile };

const getTipo = (mimetype: string): string => {
  if (mimetype === "application/pdf") return "pdf";
  if (mimetype.startsWith("image/")) return "image";
  return "document";
};

const validarCarpeta = (carpeta: string): CarpetaS3 => {
  const valores = Object.values(CARPETAS) as string[];
  if (valores.includes(carpeta)) return carpeta as CarpetaS3;
  return "disenos";
};

export const subirArchivo = async (req: RequestConArchivo, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No se recibió ningún archivo" });
      return;
    }

    const carpeta = validarCarpeta(req.body.carpeta || "disenos");
    const { url, public_id, resource_type } = await uploadToS3(req.file, carpeta);
    const tipo      = getTipo(req.file.mimetype);
    const tamanoKb  = Math.round(req.file.size / 1024);
    const subidoPor = (req as any).user?.id || null;

    const result = await pool.query(
      `INSERT INTO archivos 
        (nombre, tipo, mime_type, url, public_id, tamano_kb, subido_por, resource_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.file.originalname, tipo, req.file.mimetype, url, public_id, tamanoKb, subidoPor, resource_type]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("❌ Error al subir archivo:", error);
    res.status(500).json({ error: "Error al subir el archivo" });
  }
};

export const listarArchivos = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT id_archivo, nombre, tipo, mime_type, url, public_id,
              tamano_kb, subido_por, resource_type, created_at
       FROM archivos ORDER BY created_at DESC`
    );

    const archivosConUrl = await Promise.all(
      result.rows.map(async (archivo) => ({
        ...archivo,
        url:    await getPresignedUrl(archivo.public_id),
        carpeta: archivo.public_id?.split("/")?.[1] ?? "disenos",
      }))
    );

    res.json(archivosConUrl);
  } catch (error) {
    console.error("❌ Error al listar archivos:", error);
    res.status(500).json({ error: "Error al listar archivos" });
  }
};

export const eliminarArchivo = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id_archivo } = req.params;

    const archivo = await pool.query(
      "SELECT public_id FROM archivos WHERE id_archivo = $1",
      [id_archivo]
    );

    if (archivo.rows.length === 0) {
      res.status(404).json({ error: "Archivo no encontrado" });
      return;
    }

    await deleteFromS3(archivo.rows[0].public_id);
    await pool.query("DELETE FROM archivos WHERE id_archivo = $1", [id_archivo]);

    res.json({ message: "Archivo eliminado" });
  } catch (error) {
    console.error("❌ Error al eliminar archivo:", error);
    res.status(500).json({ error: "Error al eliminar el archivo" });
  }
};

export const obtenerUrlFirmada = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id_archivo } = req.params;

    const result = await pool.query(
      "SELECT public_id FROM archivos WHERE id_archivo = $1",
      [id_archivo]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Archivo no encontrado" });
      return;
    }

    const url = await getPresignedUrl(result.rows[0].public_id);
    res.json({ url });
  } catch (error) {
    console.error("❌ Error al obtener URL:", error);
    res.status(500).json({ error: "Error al obtener URL" });
  }
};

export const verArchivo = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id_archivo } = req.params;

    const result = await pool.query(
      "SELECT public_id FROM archivos WHERE id_archivo = $1",
      [id_archivo]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Archivo no encontrado" });
      return;
    }

    const url = await getPresignedUrl(result.rows[0].public_id);
    res.redirect(302, url);
  } catch (error) {
    console.error("❌ Error al ver archivo:", error);
    res.status(500).json({ error: "Error al obtener archivo" });
  }
};

export const obtenerEstadisticas = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)                                                                   AS total_archivos,
        COALESCE(SUM(tamano_kb), 0)                                                AS total_kb,
        COUNT(*) FILTER (WHERE tipo = 'image')                                     AS total_imagenes,
        COUNT(*) FILTER (WHERE tipo = 'pdf')                                       AS total_pdfs,
        COUNT(*) FILTER (WHERE tipo = 'document')                                  AS total_documentos,
        COALESCE(SUM(tamano_kb) FILTER (WHERE public_id LIKE '%disenos%'),      0) AS kb_disenos,
        COALESCE(SUM(tamano_kb) FILTER (WHERE public_id LIKE '%pdfs%'),         0) AS kb_pdfs,
        COALESCE(SUM(tamano_kb) FILTER (WHERE public_id LIKE '%fotos-envios%'), 0) AS kb_fotos,
        COALESCE(SUM(tamano_kb) FILTER (WHERE public_id LIKE '%backups%'),      0) AS kb_backups
      FROM archivos
    `);

    const row = result.rows[0];

    const totalKb    = Number(row.total_kb);
    const totalMb    = totalKb / 1024;
    const totalGb    = totalMb / 1024;
    const limiteGb   = 10;
    const porcentaje = Math.min((totalGb / limiteGb) * 100, 100);

    res.json({
      total_archivos:   Number(row.total_archivos),
      total_imagenes:   Number(row.total_imagenes),
      total_pdfs:       Number(row.total_pdfs),
      total_documentos: Number(row.total_documentos),
      almacenamiento: {
        kb:         totalKb,
        mb:         parseFloat(totalMb.toFixed(2)),
        gb:         parseFloat(totalGb.toFixed(4)),
        limite_gb:  limiteGb,
        porcentaje: parseFloat(porcentaje.toFixed(2)),
      },
      por_carpeta: {
        disenos:      parseFloat((Number(row.kb_disenos) / 1024).toFixed(2)),
        pdfs:         parseFloat((Number(row.kb_pdfs)    / 1024).toFixed(2)),
        fotos_envios: parseFloat((Number(row.kb_fotos)   / 1024).toFixed(2)),
        backups:      parseFloat((Number(row.kb_backups) / 1024).toFixed(2)),
      },
    });
  } catch (error) {
    console.error("❌ Error al obtener estadísticas:", error);
    res.status(500).json({ error: "Error al obtener estadísticas" });
  }
};