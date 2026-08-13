// src/controllers/cotizadorLibre/cotizadorLibreLanding.controller.ts
import { Request, Response } from "express";
import { qAudit } from "../../middlewares/auditoria";
import { pool } from "../../config/db";
import {
  uploadToS3,
  deleteFromS3,
  getPresignedUrl,
  CARPETAS,
  MulterFile,
} from "../../config/multer";
import { SECCIONES_LANDING_COTIZADOR_LIBRE } from "../../types/cotizadorLibre/cotizadorLibreLanding.types";

type RequestConArchivo = Request & { file?: MulterFile };

// ============================================================================
// Mismo criterio que ya usas en el sidebar para áreas admin-only (Archivos,
// Backups BD, Cotizador Expo): user.acceso_total === true. Solo estos
// usuarios pueden agregar/editar/quitar espacios e imágenes; cualquier otro
// usuario autenticado (incluida la cuenta compartida CotizadorLibre) solo
// puede ver el resultado vía GET.
// ============================================================================
const esAdmin = (req: Request): boolean => (req as any).user?.acceso_total === true;

const seccionValida = (seccion: unknown): seccion is (typeof SECCIONES_LANDING_COTIZADOR_LIBRE)[number] =>
  typeof seccion === "string" &&
  (SECCIONES_LANDING_COTIZADOR_LIBRE as readonly string[]).includes(seccion);

// ==========================
// GET — lectura (cualquier usuario autenticado, incluida la cuenta
// compartida del cotizador). Solo espacios activos.
// ==========================
export const getLandingCotizadorLibre = async (_req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `SELECT l.idlanding_cotizador_libre AS id, l.seccion, l.titulo, l.orden,
              l.id_archivo, a.public_id
       FROM landing_cotizador_libre l
       LEFT JOIN archivos a ON a.id_archivo = l.id_archivo
       WHERE l.activo = true
       ORDER BY l.seccion, l.orden, l.idlanding_cotizador_libre`
    );

    const conImagen = await Promise.all(
      rows.map(async (r: any) => {
        let imagenUrl: string | null = null;
        if (r.public_id) {
          try {
            imagenUrl = await getPresignedUrl(r.public_id);
          } catch {
            imagenUrl = null;
          }
        }
        return {
          id: r.id,
          seccion: r.seccion,
          titulo: r.titulo,
          orden: r.orden,
          idArchivo: r.id_archivo,
          imagenUrl,
        };
      })
    );

    res.json(conImagen);
  } catch (error: any) {
    console.error("❌ GET LANDING COTIZADOR LIBRE ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener la landing del cotizador." });
  }
};

// ==========================
// POST — crear un espacio nuevo (sin imagen todavía) — solo admin
// ==========================
export const crearSlotLandingCotizadorLibre = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!esAdmin(req)) {
      res.status(403).json({ error: "No tienes permiso para editar la landing del cotizador." });
      return;
    }

    const { seccion, titulo } = req.body as { seccion?: string; titulo?: string };

    if (!seccionValida(seccion)) {
      res.status(400).json({ error: "Sección inválida." });
      return;
    }

    const usuarioId = (req as any).user?.id || null;

    // El nuevo espacio se agrega al final de su sección.
    const { rows: ordenRows } = await pool.query(
      `SELECT COALESCE(MAX(orden), -1) + 1 AS siguiente_orden
       FROM landing_cotizador_libre
       WHERE seccion = $1`,
      [seccion]
    );
    const siguienteOrden = ordenRows[0].siguiente_orden;

    const result = await qAudit(req)(
      `INSERT INTO landing_cotizador_libre (seccion, titulo, orden, creado_por, actualizado_por)
       VALUES ($1, $2, $3, $4, $4)
       RETURNING idlanding_cotizador_libre AS id, seccion, titulo, orden, id_archivo`,
      [seccion, (titulo ?? "").trim(), siguienteOrden, usuarioId]
    );

    res.status(201).json({ ...result.rows[0], imagenUrl: null });
  } catch (error: any) {
    console.error("❌ CREAR SLOT LANDING COTIZADOR LIBRE ERROR:", error.message);
    res.status(500).json({ error: "Error al crear el espacio." });
  }
};

// ==========================
// PUT — editar título/orden/sección de un espacio — solo admin
// ==========================
export const actualizarSlotLandingCotizadorLibre = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!esAdmin(req)) {
      res.status(403).json({ error: "No tienes permiso para editar la landing del cotizador." });
      return;
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id inválido." });
      return;
    }

    const { titulo, orden, seccion } = req.body as {
      titulo?: string;
      orden?: number;
      seccion?: string;
    };

    if (seccion !== undefined && !seccionValida(seccion)) {
      res.status(400).json({ error: "Sección inválida." });
      return;
    }

    const usuarioId = (req as any).user?.id || null;

    const result = await qAudit(req)(
      `UPDATE landing_cotizador_libre
       SET titulo = COALESCE($1, titulo),
           orden = COALESCE($2, orden),
           seccion = COALESCE($3, seccion),
           actualizado_por = $4,
           updated_at = now()
       WHERE idlanding_cotizador_libre = $5
       RETURNING idlanding_cotizador_libre AS id, seccion, titulo, orden, id_archivo`,
      [
        titulo !== undefined ? titulo.trim() : null,
        orden !== undefined ? orden : null,
        seccion !== undefined ? seccion : null,
        usuarioId,
        id,
      ]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Espacio no encontrado." });
      return;
    }

    const row = result.rows[0];
    let imagenUrl: string | null = null;
    if (row.id_archivo) {
      const { rows: archivoRows } = await pool.query(
        "SELECT public_id FROM archivos WHERE id_archivo = $1",
        [row.id_archivo]
      );
      if (archivoRows[0]) {
        try {
          imagenUrl = await getPresignedUrl(archivoRows[0].public_id);
        } catch {
          imagenUrl = null;
        }
      }
    }

    res.json({ ...row, imagenUrl });
  } catch (error: any) {
    console.error("❌ ACTUALIZAR SLOT LANDING COTIZADOR LIBRE ERROR:", error.message);
    res.status(500).json({ error: "Error al actualizar el espacio." });
  }
};

// ==========================
// DELETE — quitar un espacio completo (y su imagen, si tenía) — solo admin
// ==========================
export const eliminarSlotLandingCotizadorLibre = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!esAdmin(req)) {
      res.status(403).json({ error: "No tienes permiso para editar la landing del cotizador." });
      return;
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id inválido." });
      return;
    }

    const { rows } = await pool.query(
      `SELECT l.id_archivo, a.public_id
       FROM landing_cotizador_libre l
       LEFT JOIN archivos a ON a.id_archivo = l.id_archivo
       WHERE l.idlanding_cotizador_libre = $1`,
      [id]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "Espacio no encontrado." });
      return;
    }

    const { id_archivo, public_id } = rows[0];

    await req.tx(async (client) => {
      await client.query("DELETE FROM landing_cotizador_libre WHERE idlanding_cotizador_libre = $1", [id]);
      if (id_archivo) {
        await client.query("DELETE FROM archivos WHERE id_archivo = $1", [id_archivo]);
      }
    });

    if (public_id) {
      try {
        await deleteFromS3(public_id);
      } catch (err) {
        console.error("⚠️ No se pudo borrar la imagen de S3:", public_id);
      }
    }

    res.json({ message: "Espacio eliminado" });
  } catch (error: any) {
    console.error("❌ ELIMINAR SLOT LANDING COTIZADOR LIBRE ERROR:", error.message);
    res.status(500).json({ error: "Error al eliminar el espacio." });
  }
};

// ==========================
// POST /:id/imagen — subir (o reemplazar) la imagen de un espacio — solo admin
// ==========================
export const subirImagenSlotLandingCotizadorLibre = async (
  req: RequestConArchivo,
  res: Response
): Promise<void> => {
  try {
    if (!esAdmin(req)) {
      res.status(403).json({ error: "No tienes permiso para editar la landing del cotizador." });
      return;
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id inválido." });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: "No se recibió ninguna imagen." });
      return;
    }

    const { rows: slotRows } = await pool.query(
      `SELECT l.id_archivo AS id_archivo_anterior, a.public_id AS public_id_anterior
       FROM landing_cotizador_libre l
       LEFT JOIN archivos a ON a.id_archivo = l.id_archivo
       WHERE l.idlanding_cotizador_libre = $1`,
      [id]
    );

    if (slotRows.length === 0) {
      res.status(404).json({ error: "Espacio no encontrado." });
      return;
    }

    const { id_archivo_anterior, public_id_anterior } = slotRows[0];
    const usuarioId = (req as any).user?.id || null;

    const { url, public_id } = await uploadToS3(req.file, CARPETAS.cotizador_interactivo);
    const tamanoKb = Math.round(req.file.size / 1024);

    const archivoResult = await qAudit(req)(
      `INSERT INTO archivos (nombre, tipo, mime_type, url, public_id, tamano_kb, subido_por, resource_type)
       VALUES ($1, 'image', $2, $3, $4, $5, $6, 'image')
       RETURNING id_archivo`,
      [req.file.originalname, req.file.mimetype, url, public_id, tamanoKb, usuarioId]
    );
    const nuevoIdArchivo = archivoResult.rows[0].id_archivo;

    const slotResult = await qAudit(req)(
      `UPDATE landing_cotizador_libre
       SET id_archivo = $1, actualizado_por = $2, updated_at = now()
       WHERE idlanding_cotizador_libre = $3
       RETURNING idlanding_cotizador_libre AS id, seccion, titulo, orden, id_archivo`,
      [nuevoIdArchivo, usuarioId, id]
    );

    // Se reemplaza la imagen anterior (si había) — se borra después de que
    // la nueva ya quedó guardada, para no dejar el espacio sin imagen si
    // algo falla a medio camino.
    if (id_archivo_anterior) {
      await pool.query("DELETE FROM archivos WHERE id_archivo = $1", [id_archivo_anterior]);
      if (public_id_anterior) {
        try {
          await deleteFromS3(public_id_anterior);
        } catch {
          console.error("⚠️ No se pudo borrar la imagen anterior de S3:", public_id_anterior);
        }
      }
    }

    const imagenUrl = await getPresignedUrl(public_id);
    res.status(201).json({ ...slotResult.rows[0], imagenUrl });
  } catch (error: any) {
    console.error("❌ SUBIR IMAGEN SLOT LANDING COTIZADOR LIBRE ERROR:", error.message);
    res.status(500).json({ error: "Error al subir la imagen." });
  }
};

// ==========================
// DELETE /:id/imagen — quitar solo la imagen, el espacio (título) se
// conserva — solo admin
// ==========================
export const eliminarImagenSlotLandingCotizadorLibre = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!esAdmin(req)) {
      res.status(403).json({ error: "No tienes permiso para editar la landing del cotizador." });
      return;
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id inválido." });
      return;
    }

    const { rows } = await pool.query(
      `SELECT l.id_archivo, a.public_id
       FROM landing_cotizador_libre l
       LEFT JOIN archivos a ON a.id_archivo = l.id_archivo
       WHERE l.idlanding_cotizador_libre = $1`,
      [id]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "Espacio no encontrado." });
      return;
    }

    const { id_archivo, public_id } = rows[0];
    const usuarioId = (req as any).user?.id || null;

    const slotResult = await qAudit(req)(
      `UPDATE landing_cotizador_libre
       SET id_archivo = NULL, actualizado_por = $1, updated_at = now()
       WHERE idlanding_cotizador_libre = $2
       RETURNING idlanding_cotizador_libre AS id, seccion, titulo, orden, id_archivo`,
      [usuarioId, id]
    );

    if (id_archivo) {
      await pool.query("DELETE FROM archivos WHERE id_archivo = $1", [id_archivo]);
      if (public_id) {
        try {
          await deleteFromS3(public_id);
        } catch {
          console.error("⚠️ No se pudo borrar la imagen de S3:", public_id);
        }
      }
    }

    res.json({ ...slotResult.rows[0], imagenUrl: null });
  } catch (error: any) {
    console.error("❌ ELIMINAR IMAGEN SLOT LANDING COTIZADOR LIBRE ERROR:", error.message);
    res.status(500).json({ error: "Error al eliminar la imagen." });
  }
};