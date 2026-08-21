import { qAudit } from "../../middlewares/auditoria";
import { Request, Response } from "express";
import {
  uploadToS3,
  deleteFromS3,
  getPresignedUrl,
  getPresignedUrlLarga,
  CarpetaS3,
  CARPETAS,
  MulterFile,
  SUBCARPETAS_PDF,
  SUBCARPETAS_SUAJE,
  SUBCARPETAS_CATALOGO,
} from "../../config/multer";import { pool } from "../../config/db";

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

const validarSubcarpeta = (subcarpeta: string): string | undefined => {
  const todasSubcarpetas: readonly string[] = [
    ...SUBCARPETAS_PDF,
    ...SUBCARPETAS_SUAJE,
    ...SUBCARPETAS_CATALOGO,
  ];
  if (todasSubcarpetas.includes(subcarpeta)) return subcarpeta;
  return undefined;
};

export const subirArchivo = async (req: RequestConArchivo, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No se recibió ningún archivo" });
      return;
    }

    

    // Para plástico el frontend manda carpeta="catalogoproductos" y
    // subcarpeta="plastico" (ambos ya existentes en config/multer.ts —
    // CARPETAS.catalogo_productos y SUBCARPETAS_CATALOGO).
    const carpeta = validarCarpeta(req.body.carpeta || "disenos");
    const subcarpeta = req.body.subcarpeta ? validarSubcarpeta(req.body.subcarpeta) : undefined;
    const categoria = req.body.categoria ?? null;

    const { url, public_id, resource_type } = await uploadToS3(req.file, carpeta, subcarpeta);
    const tipo = getTipo(req.file.mimetype);
    const tamanoKb = Math.round(req.file.size / 1024);
    const subidoPor = (req as any).user?.id || null;
    const usuarioId = req.body.usuario_id ? Number(req.body.usuario_id) : null;
    const envioId = req.body.envio_id ? Number(req.body.envio_id) : null;
    const notaId = req.body.nota_id ? Number(req.body.nota_id) : null;
    // ✅ NUEVO — vínculo con Mesa de Tickets (imagen del ticket principal
    // o de un comentario específico; el segundo es opcional).
    const ticketId = req.body.ticket_id ? Number(req.body.ticket_id) : null;
    const ticketComentarioId = req.body.ticket_comentario_id
      ? Number(req.body.ticket_comentario_id)
      : null;
    const idproducto_papel = req.body.idproducto_papel ? Number(req.body.idproducto_papel) : null;
    // ✅ NUEVO: vínculo con producto plástico
    const idconfiguracion_plastico = req.body.idconfiguracion_plastico
      ? Number(req.body.idconfiguracion_plastico)
      : null;

    const result = await qAudit(req)(
      `INSERT INTO archivos 
        (nombre, tipo, mime_type, url, public_id, tamano_kb, subido_por, resource_type, categoria, usuario_id, envio_id, nota_id, idproducto_papel, idconfiguracion_plastico, ticket_id, ticket_comentario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        req.file.originalname, tipo, req.file.mimetype, url, public_id, tamanoKb,
        subidoPor, resource_type,
        categoria,
        usuarioId, envioId, notaId,
        idproducto_papel,
        idconfiguracion_plastico,
        ticketId,
        ticketComentarioId,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("❌ Error al subir archivo:", error);
    res.status(500).json({ error: "Error al subir el archivo" });
  }
};

// ==========================
// GET FOTOS POR ENVIO
// ==========================
export const getFotosEnvio = async (req: Request, res: Response): Promise<void> => {
  try {
    const { idenvio } = req.params;

    const result = await pool.query(
      `SELECT id_archivo, nombre, tipo, mime_type, public_id, tamano_kb, created_at
       FROM archivos
       WHERE envio_id = $1 AND tipo = 'image'
       ORDER BY created_at DESC`,
      [idenvio]
    );

    const archivosConUrl = await Promise.all(
      result.rows.map(async (archivo) => ({
        ...archivo,
        url: await getPresignedUrl(archivo.public_id),
      }))
    );

    res.json(archivosConUrl);
  } catch (error) {
    console.error("❌ Error al obtener fotos del envío:", error);
    res.status(500).json({ error: "Error al obtener fotos" });
  }
};

export const getFotosNota = async (req: Request, res: Response): Promise<void> => {
  try {
    const { idnota } = req.params;

    const result = await pool.query(
      `SELECT id_archivo, nombre, tipo, mime_type, public_id, tamano_kb, created_at
       FROM archivos
       WHERE nota_id = $1 AND tipo = 'image'
       ORDER BY created_at DESC`,
      [idnota]
    );

    const archivosConUrl = await Promise.all(
      result.rows.map(async (archivo) => ({
        ...archivo,
        url: await getPresignedUrl(archivo.public_id),
      }))
    );

    res.json(archivosConUrl);
  } catch (error) {
    console.error("❌ Error al obtener fotos de la nota:", error);
    res.status(500).json({ error: "Error al obtener fotos" });
  }
};

// ✅ NUEVO — GET fotos de un ticket (ticket principal + todos sus
// comentarios). Mismo patrón que getFotosEnvio/getFotosNota. No es
// estrictamente necesario porque GET /tickets/:id ya trae las imágenes
// incluidas, pero sirve si en algún momento se quiere un endpoint suelto
// solo de fotos (ej. para un carrusel aparte).
export const getFotosTicket = async (req: Request, res: Response): Promise<void> => {
  try {
    const { idticket } = req.params;

    const result = await pool.query(
      `SELECT id_archivo, nombre, tipo, mime_type, public_id, tamano_kb, ticket_comentario_id, created_at
       FROM archivos
       WHERE (
              ticket_id = $1
              OR ticket_comentario_id IN (
                   SELECT idticket_comentario FROM ticket_comentario WHERE idticket = $1
                 )
            )
         AND tipo = 'image'
       ORDER BY created_at ASC`,
      [idticket]
    );

    const archivosConUrl = await Promise.all(
      result.rows.map(async (archivo) => ({
        ...archivo,
        url: await getPresignedUrl(archivo.public_id),
      }))
    );

    res.json(archivosConUrl);
  } catch (error) {
    console.error("❌ Error al obtener fotos del ticket:", error);
    res.status(500).json({ error: "Error al obtener fotos" });
  }
};

// ✅ NUEVO — GET archivos por producto plástico.
// Nombre del param es `idproducto` para coincidir EXACTAMENTE con tu ruta:
//   router.get("/producto-plastico/:idproducto", authMiddleware, getArchivosProductoPlastico);
export const getArchivosProductoPlastico = async (req: Request, res: Response): Promise<void> => {
  try {
    const { idproducto } = req.params;

    const result = await pool.query(
      `SELECT id_archivo, nombre, tipo, mime_type, public_id, tamano_kb, categoria, created_at
       FROM archivos
       WHERE idconfiguracion_plastico = $1
       ORDER BY id_archivo ASC`,
      [idproducto]
    );

    const archivosConUrl = await Promise.all(
      result.rows.map(async (archivo) => ({
        ...archivo,
        url: await getPresignedUrl(archivo.public_id),
      }))
    );

    res.json(archivosConUrl);
  } catch (error) {
    console.error("❌ Error al obtener archivos del producto plástico:", error);
    res.status(500).json({ error: "Error al obtener archivos" });
  }
};

export const listarArchivos = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT id_archivo, nombre, tipo, mime_type, url, public_id,
              tamano_kb, subido_por, usuario_id, envio_id, resource_type, categoria, created_at
       FROM archivos ORDER BY created_at DESC`
    );

    const archivosConUrl = await Promise.all(
      result.rows.map(async (archivo) => {
        const partes = archivo.public_id?.split("/") ?? [];
        const carpeta = partes[1] ?? "disenos";
        const subcarpeta = partes.length === 4 ? partes[2] : null;

        return {
          ...archivo,
          url: await getPresignedUrl(archivo.public_id),
          carpeta,
          subcarpeta,
        };
      })
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
    await req.tx((client) => client.query("DELETE FROM archivos WHERE id_archivo = $1", [id_archivo]));

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

export const obtenerUrlFirmadaLarga = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { id_archivo } = req.params;

    const diasRaw = Number(req.query.dias ?? 7);

    const dias =
      Number.isFinite(diasRaw) && diasRaw > 0
        ? Math.min(Math.floor(diasRaw), 7)
        : 7;

    const result = await pool.query(
      "SELECT public_id, nombre, mime_type FROM archivos WHERE id_archivo = $1",
      [id_archivo]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Archivo no encontrado" });
      return;
    }

    const archivo = result.rows[0];

    const url = await getPresignedUrlLarga(archivo.public_id, dias);

    res.json({
      url,
      nombre: archivo.nombre,
      mime_type: archivo.mime_type,
      public_id: archivo.public_id,
      dias,
    });
  } catch (error) {
    console.error("❌ Error al obtener URL larga:", error);
    res.status(500).json({ error: "Error al obtener URL larga" });
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
        COUNT(*)                                                                    AS total_archivos,
        COALESCE(SUM(tamano_kb), 0)                                                 AS total_kb,
        COUNT(*) FILTER (WHERE tipo = 'image')                                      AS total_imagenes,
        COUNT(*) FILTER (WHERE tipo = 'pdf')                                        AS total_pdfs,
        COUNT(*) FILTER (WHERE tipo = 'document')                                   AS total_documentos,
        COALESCE(SUM(tamano_kb) FILTER (WHERE public_id LIKE '%/disenos/%'),      0) AS kb_disenos,
        COALESCE(SUM(tamano_kb) FILTER (WHERE public_id LIKE '%/pdfs/%'),         0) AS kb_pdfs,
        COALESCE(SUM(tamano_kb) FILTER (WHERE public_id LIKE '%/fotos-envios/%'), 0) AS kb_fotos,
        COALESCE(SUM(tamano_kb) FILTER (WHERE public_id LIKE '%/backups/%'),      0) AS kb_backups,
        COALESCE(SUM(tamano_kb) FILTER (WHERE public_id LIKE '%/suaje/%'),        0) AS kb_suaje,
        COALESCE(SUM(tamano_kb) FILTER (WHERE public_id LIKE '%/catalogoproductos/%'),0) AS kb_catalogo_expo      FROM archivos
    `);

    const row = result.rows[0];
    const totalKb = Number(row.total_kb);
    const totalMb = totalKb / 1024;
    const totalGb = totalMb / 1024;
    const limiteGb = 10;
    const porcentaje = Math.min((totalGb / limiteGb) * 100, 100);

    res.json({
      total_archivos: Number(row.total_archivos),
      total_imagenes: Number(row.total_imagenes),
      total_pdfs: Number(row.total_pdfs),
      total_documentos: Number(row.total_documentos),
      almacenamiento: {
        kb: totalKb,
        mb: parseFloat(totalMb.toFixed(2)),
        gb: parseFloat(totalGb.toFixed(4)),
        limite_gb: limiteGb,
        porcentaje: parseFloat(porcentaje.toFixed(2)),
      },
      por_carpeta: {
        disenos: parseFloat((Number(row.kb_disenos) / 1024).toFixed(2)),
        pdfs: parseFloat((Number(row.kb_pdfs) / 1024).toFixed(2)),
        fotos_envios: parseFloat((Number(row.kb_fotos) / 1024).toFixed(2)),
        backups: parseFloat((Number(row.kb_backups) / 1024).toFixed(2)),
        suaje: parseFloat((Number(row.kb_suaje) / 1024).toFixed(2)),
        catalogo_expo: parseFloat((Number(row.kb_catalogo_expo) / 1024).toFixed(2)),
      },
    });
  } catch (error) {
    console.error("❌ Error al obtener estadísticas:", error);
    res.status(500).json({ error: "Error al obtener estadísticas" });
  }
};