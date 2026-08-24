import { Request, Response } from "express";
import { pool } from "../../config/db";
import { qAudit } from "../../middlewares/auditoria";

// ==========================
// OBTENER TODOS LOS ROLES
// ==========================
export const getRoles = async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT 
        idroles,
        nombre,
        descripcion,
        acceso_total
      FROM roles
      ORDER BY idroles ASC
    `);

    res.json(result.rows);
  } catch (error: any) {
    console.error("❌ GET ROLES ERROR:", error.message);
    res.status(500).json({ 
      error: "Error al obtener roles" 
    });
  }
};

// ==========================
// OBTENER PRIVILEGIOS DE UN ROL
// ==========================
export const getPrivilegiosByRol = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Validar ID
    if (!Number.isInteger(Number(id)) || Number(id) < 1) {
      return res.status(400).json({ 
        error: "ID de rol inválido" 
      });
    }

    console.log(`📋 Obteniendo privilegios del rol ${id}`);

    // Verificar que el rol existe
    const rolExiste = await pool.query(
      "SELECT idroles, nombre, acceso_total FROM roles WHERE idroles = $1 LIMIT 1",
      [id]
    );

    if ((rolExiste.rowCount ?? 0) === 0) {
      return res.status(404).json({ 
        error: "Rol no encontrado" 
      });
    }

    const rol = rolExiste.rows[0];

    // ANTES: si el rol tenía acceso_total, se regresaba base: [] sin
    // siquiera consultar roles_privilegios — total, ese flag ya le daba
    // acceso a todo. Pero Mesa de Tickets es la excepción: ahí el acceso
    // NO depende de acceso_total, depende 100% de que este privilegio esté
    // realmente en roles_privilegios. Si seguíamos cortando camino aquí, el
    // formulario de Roles nunca podía saber (ni mostrar) qué privilegios de
    // tickets tenía asignados un rol como Admin o Super Usuario — por eso
    // el frontend no dejaba ni ver la casilla. Ahora SIEMPRE se consulta la
    // base real; acceso_total sigue viajando en la respuesta para que el
    // frontend lo siga tratando distinto (no es una base editable normal,
    // solo sirve para precargar la selección de tickets).
    const result = await pool.query(
      `
      SELECT privilegios_idprivilegios as privilegio_id
      FROM roles_privilegios
      WHERE roles_idroles = $1
      ORDER BY privilegios_idprivilegios ASC
    `,
      [id]
    );

    const base = result.rows.map(row => row.privilegio_id);

    if (rol.acceso_total) {
      console.log(`👑 Rol con acceso total — base real (solo aplica a tickets): ${base.length} privilegios`);
    } else {
      console.log(`✅ Base del rol: ${base.length} privilegios`);
    }

    res.json({
      rol_id: rol.idroles,
      rol_nombre: rol.nombre,
      acceso_total: rol.acceso_total,
      base,
    });
  } catch (error: any) {
    console.error("❌ GET PRIVILEGIOS BY ROL ERROR:", error.message);
    res.status(500).json({
      error: "Error al obtener privilegios del rol"
    });
  }
};

// ==========================
// CREAR ROL
// ==========================
export const crearRol = async (req: Request, res: Response) => {
  try {
    const { nombre, descripcion, acceso_total } = req.body;
    if (!nombre?.trim()) {
      return res.status(400).json({ error: "El nombre del rol es requerido" });
    }

    const existe = await pool.query(
      "SELECT 1 FROM roles WHERE lower(btrim(nombre)) = lower(btrim($1)) LIMIT 1",
      [nombre]
    );
    if ((existe.rowCount ?? 0) > 0) {
      return res.status(400).json({ error: "Ya existe un rol con ese nombre" });
    }

    const result = await qAudit(req)(
      `INSERT INTO roles (nombre, descripcion, acceso_total)
       VALUES ($1, $2, $3)
       RETURNING idroles, nombre, descripcion, acceso_total`,
      [nombre.trim(), descripcion?.trim() || null, !!acceso_total]
    );

    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    console.error("❌ CREAR ROL ERROR:", error.message);
    res.status(500).json({ error: "Error al crear el rol" });
  }
};

// ==========================
// EDITAR ROL
// ==========================
export const editarRol = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { nombre, descripcion, acceso_total } = req.body;

    if (!Number.isInteger(Number(id)) || Number(id) < 1) {
      return res.status(400).json({ error: "ID de rol inválido" });
    }
    if (!nombre?.trim()) {
      return res.status(400).json({ error: "El nombre del rol es requerido" });
    }

    const existe = await pool.query(
      "SELECT 1 FROM roles WHERE lower(btrim(nombre)) = lower(btrim($1)) AND idroles != $2 LIMIT 1",
      [nombre, id]
    );
    if ((existe.rowCount ?? 0) > 0) {
      return res.status(400).json({ error: "Ya existe un rol con ese nombre" });
    }

    const result = await qAudit(req)(
      `UPDATE roles SET nombre = $1, descripcion = $2, acceso_total = $3
       WHERE idroles = $4
       RETURNING idroles, nombre, descripcion, acceso_total`,
      [nombre.trim(), descripcion?.trim() || null, !!acceso_total, id]
    );

    if ((result.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: "Rol no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error: any) {
    console.error("❌ EDITAR ROL ERROR:", error.message);
    res.status(500).json({ error: "Error al editar el rol" });
  }
};

// ==========================
// ACTUALIZAR BASE DE PRIVILEGIOS DE UN ROL
// Reemplaza por completo roles_privilegios para ese rol. Los privilegios
// individuales de los usuarios (privilegios_has_usuarios) no se tocan aquí.
//
// A propósito NO valida acceso_total ni lo rechaza — un rol con acceso
// total puede perfectamente tener filas aquí (ver el caso de tickets). El
// resto del sistema simplemente no las necesita porque ya bypassa con el
// flag; guardarlas de más no rompe nada.
// ==========================
export const actualizarPrivilegiosRol = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { privilegios } = req.body;

    if (!Number.isInteger(Number(id)) || Number(id) < 1) {
      return res.status(400).json({ error: "ID de rol inválido" });
    }
    if (!Array.isArray(privilegios)) {
      return res.status(400).json({ error: "privilegios debe ser un arreglo" });
    }
    const privilegiosValidos = privilegios.every(
      (p: any) => Number.isInteger(Number(p)) && Number(p) > 0
    );
    if (!privilegiosValidos) {
      return res.status(400).json({ error: "Datos de privilegios inválidos" });
    }

    const rolExiste = await pool.query(
      "SELECT idroles FROM roles WHERE idroles = $1 LIMIT 1", [id]
    );
    if ((rolExiste.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: "Rol no encontrado" });
    }

    await req.tx(async (client) => {
      await client.query("DELETE FROM roles_privilegios WHERE roles_idroles = $1", [id]);
      for (const idPrivilegio of privilegios) {
        await client.query(
          `INSERT INTO roles_privilegios (roles_idroles, privilegios_idprivilegios)
           VALUES ($1, $2)`,
          [id, idPrivilegio]
        );
      }
    });

    res.json({
      message: "Base del rol actualizada",
      roles_idroles: Number(id),
      privilegios: privilegios.map(Number),
    });
  } catch (error: any) {
    console.error("❌ ACTUALIZAR PRIVILEGIOS ROL ERROR:", error.message);
    res.status(500).json({ error: "Error al actualizar los privilegios del rol" });
  }
};