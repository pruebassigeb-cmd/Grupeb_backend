import { iniciarTx } from "../../middlewares/auditoria";
// src/controllers/reportes/reportesDestinatarios.controller.ts
import { Request, Response } from "express";
import { pool } from "../../config/db";

const REPORTES_VALIDOS = ["produccion", "cotizaciones", "pedidos", "diseno", "anticipos"] as const;
type Reporte = (typeof REPORTES_VALIDOS)[number];

// ============================================================
// GET /api/reportes/destinatarios
// Lista todos los usuarios activos con sus reportes activados
// ============================================================
export const getDestinatariosReporte = async (_req: Request, res: Response) => {
  try {
    const { rows: usuarios } = await pool.query(`
      SELECT u.idusuario, u.nombre, u.apellido, u.correo, r.nombre AS rol
      FROM usuarios u
      JOIN roles r ON r.idroles = u.roles_idroles
      WHERE u.activo = true
      ORDER BY u.nombre ASC
    `);

    const { rows: preferencias } = await pool.query(`
      SELECT usuarios_idusuario, reporte FROM preferencia_correo_reporte
    `);

    const reportesPorUsuario = new Map<number, Set<string>>();
    for (const p of preferencias) {
      if (!reportesPorUsuario.has(p.usuarios_idusuario)) {
        reportesPorUsuario.set(p.usuarios_idusuario, new Set());
      }
      reportesPorUsuario.get(p.usuarios_idusuario)!.add(p.reporte);
    }

    const resultado = usuarios.map((u) => ({
      idusuario: u.idusuario,
      nombre: `${u.nombre} ${u.apellido}`,
      correo: u.correo,
      rol: u.rol,
      reportes: REPORTES_VALIDOS.reduce((acc, r) => {
        acc[r] = reportesPorUsuario.get(u.idusuario)?.has(r) ?? false;
        return acc;
      }, {} as Record<Reporte, boolean>),
    }));

    return res.json(resultado);
  } catch (e: any) {
    console.error("❌ GET DESTINATARIOS REPORTE ERROR:", e.message);
    return res.status(500).json({ error: "Error al obtener destinatarios de reportes" });
  }
};

// ============================================================
// PUT /api/reportes/destinatarios/:idusuario
// Body: { reportes: { produccion: bool, cotizaciones: bool, ... } }
// Reemplaza por completo la selección de ese usuario.
// ============================================================
export const actualizarDestinatarioReporte = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { idusuario } = req.params;
    const { reportes } = req.body as { reportes: Record<string, boolean> };

    if (!reportes || typeof reportes !== "object") {
      return res.status(400).json({ error: "Se requiere el objeto 'reportes'" });
    }

    const activos = REPORTES_VALIDOS.filter((r) => reportes[r] === true);

    await iniciarTx(req, client);
    await client.query(`DELETE FROM preferencia_correo_reporte WHERE usuarios_idusuario = $1`, [idusuario]);

    for (const reporte of activos) {
      await client.query(
        `INSERT INTO preferencia_correo_reporte (usuarios_idusuario, reporte) VALUES ($1, $2)`,
        [idusuario, reporte],
      );
    }

    await client.query("COMMIT");
    return res.json({ message: "Preferencias actualizadas", reportes: activos });
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error("❌ ACTUALIZAR DESTINATARIO REPORTE ERROR:", e.message);
    return res.status(500).json({ error: "Error al actualizar preferencias" });
  } finally {
    client.release();
  }
};