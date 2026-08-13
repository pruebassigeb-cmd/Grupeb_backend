import { Request, Response } from "express";
import { pool } from "../../config/db";
import { qAudit } from "../../middlewares/auditoria";

// ==========================
// OBTENER TODOS LOS PRIVILEGIOS
// ==========================
export const getPrivilegios = async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      "SELECT * FROM privilegios ORDER BY idmodulo NULLS LAST, orden, idprivilegios LIMIT 1000"
    );

    res.json(result.rows);
  } catch (error: any) {
    console.error("❌ GET PRIVILEGIOS ERROR:", error.message);
    res.status(500).json({
      error: "Error al obtener privilegios"
    });
  }
};

// ==========================
// OBTENER MÓDULOS — agrupación para la UI de administración (acordeón +
// buscador). No genera pantallas del sistema real, solo organiza esta lista.
// ==========================
export const getModulos = async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      "SELECT * FROM privilegio_modulo ORDER BY idmodulo_padre NULLS FIRST, orden, idmodulo"
    );
    res.json(result.rows);
  } catch (error: any) {
    console.error("❌ GET MODULOS ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener los módulos" });
  }
};

// ==========================
// CREAR PRIVILEGIO
// La clave debe ser única y con el formato modulo.recurso.accion — es la
// llave real que el código consulta (ver docs/roles-privilegios-plan.md).
// es_sistema siempre nace en false: ese flag solo lo pone una migración,
// para privilegios que el código ya tiene cableados.
// ==========================
const CLAVE_REGEX = /^[a-z0-9]+(\.[a-z0-9_]+)+$/;

export const crearPrivilegio = async (req: Request, res: Response) => {
  try {
    const { privilegio, clave, idmodulo, descripcion } = req.body;

    if (!privilegio?.trim()) {
      return res.status(400).json({ error: "El nombre del privilegio es requerido" });
    }
    if (!clave?.trim() || !CLAVE_REGEX.test(clave.trim())) {
      return res.status(400).json({
        error: "La clave debe tener el formato modulo.recurso.accion (minúsculas, sin espacios)",
      });
    }
    if (!Number.isInteger(Number(idmodulo)) || Number(idmodulo) < 1) {
      return res.status(400).json({ error: "Debe seleccionar un módulo" });
    }

    const existe = await pool.query(
      "SELECT 1 FROM privilegios WHERE clave = $1 LIMIT 1", [clave.trim()]
    );
    if ((existe.rowCount ?? 0) > 0) {
      return res.status(400).json({ error: "Ya existe un privilegio con esa clave" });
    }

    const result = await qAudit(req)(
      `INSERT INTO privilegios (privilegio, clave, idmodulo, descripcion, acceso, activo, es_sistema)
       VALUES ($1, $2, $3, $4, true, true, false)
       RETURNING *`,
      [privilegio.trim(), clave.trim(), idmodulo, descripcion?.trim() || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    console.error("❌ CREAR PRIVILEGIO ERROR:", error.message);
    res.status(500).json({ error: "Error al crear el privilegio" });
  }
};

// ==========================
// EDITAR PRIVILEGIO
// La clave NO se puede editar aquí a propósito: es la llave que el código
// consulta (checkPermiso/tienePermiso), cambiarla desde la UI dejaría sin
// candado a lo que ya la usaba. Solo nombre, descripción y módulo.
// ==========================
export const editarPrivilegio = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { privilegio, idmodulo, descripcion, orden } = req.body;

    if (!Number.isInteger(Number(id)) || Number(id) < 1) {
      return res.status(400).json({ error: "ID de privilegio inválido" });
    }
    if (!privilegio?.trim()) {
      return res.status(400).json({ error: "El nombre del privilegio es requerido" });
    }
    if (!Number.isInteger(Number(idmodulo)) || Number(idmodulo) < 1) {
      return res.status(400).json({ error: "Debe seleccionar un módulo" });
    }

    const result = await qAudit(req)(
      `UPDATE privilegios
       SET privilegio = $1, idmodulo = $2, descripcion = $3, orden = COALESCE($4, orden)
       WHERE idprivilegios = $5
       RETURNING *`,
      [privilegio.trim(), idmodulo, descripcion?.trim() || null, orden ?? null, id]
    );

    if ((result.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: "Privilegio no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error: any) {
    console.error("❌ EDITAR PRIVILEGIO ERROR:", error.message);
    res.status(500).json({ error: "Error al editar el privilegio" });
  }
};

// ==========================
// ACTIVAR / DESACTIVAR PRIVILEGIO
// Un privilegio inactivo desaparece de las pantallas de asignación, pero no
// se borra: las filas que ya existían en roles_privilegios /
// privilegios_has_usuarios se conservan (histórico de auditoría intacto).
// Los es_sistema piden confirmación extra en el frontend antes de llamar
// esto, porque desactivar uno de los que el código ya tiene cableado le
// quita el acceso a quien lo tuviera.
// ==========================
export const toggleActivoPrivilegio = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!Number.isInteger(Number(id)) || Number(id) < 1) {
      return res.status(400).json({ error: "ID de privilegio inválido" });
    }

    const result = await qAudit(req)(
      `UPDATE privilegios SET activo = NOT activo
       WHERE idprivilegios = $1
       RETURNING *`,
      [id]
    );

    if ((result.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: "Privilegio no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error: any) {
    console.error("❌ TOGGLE ACTIVO PRIVILEGIO ERROR:", error.message);
    res.status(500).json({ error: "Error al cambiar el estado del privilegio" });
  }
};