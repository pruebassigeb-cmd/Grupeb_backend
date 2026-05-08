import { Request, Response } from "express";
import { pool } from "../../config/db";
import bcrypt from "bcrypt";
import validator from "validator";

// ==========================
// CONSTANTES
// ==========================
const BCRYPT_ROUNDS = 12;
const MAX_USERS_TO_CHECK = 1000;

// ==========================
// CREAR USUARIO (REGISTER)
// ==========================
export const createUsuario = async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    let { nombre, apellido, correo, telefono, codigo, roles_idroles, privilegios } = req.body;

    // Sanitización
    nombre = validator.escape(nombre.trim());
    apellido = validator.escape(apellido.trim());
    correo = validator.normalizeEmail(correo.trim()) || "";

    console.log("📝 Creando nuevo usuario:", { nombre, apellido, correo, roles_idroles });

    // Validaciones críticas
    if (!nombre || !apellido || !correo || !codigo) {
      return res.status(400).json({ 
        error: "Todos los campos requeridos deben estar completos" 
      });
    }

    if (!/^\d{5}$/.test(codigo)) {
      return res.status(400).json({ 
        error: "Datos de entrada inválidos" 
      });
    }

    if (!validator.isEmail(correo)) {
      return res.status(400).json({ 
        error: "El formato del correo no es válido" 
      });
    }

    if (!Number.isInteger(Number(roles_idroles)) || Number(roles_idroles) < 1) {
      return res.status(400).json({ 
        error: "Datos de entrada inválidos" 
      });
    }

    // Iniciar transacción
    await client.query("BEGIN");

    // Verificar correo único
    const existeCorreo = await client.query(
      "SELECT 1 FROM usuarios WHERE correo = $1 LIMIT 1",
      [correo]
    );

    if ((existeCorreo.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ 
        error: "El correo ya está registrado" 
      });
    }

    // Validar código único
    const todosLosCodigos = await client.query(
      "SELECT codigo FROM usuarios LIMIT $1",
      [MAX_USERS_TO_CHECK]
    );

    for (const row of todosLosCodigos.rows) {
      if (await bcrypt.compare(codigo, row.codigo)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ 
          error: "El código ya está en uso" 
        });
      }
    }

    // Hashear código
    const hash = await bcrypt.hash(codigo, BCRYPT_ROUNDS);

    // Insertar usuario
    const resultUsuario = await client.query(
      `INSERT INTO usuarios (nombre, apellido, correo, telefono, codigo, roles_idroles)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING idusuario, nombre, apellido, correo, telefono, roles_idroles`,
      [nombre, apellido, correo, telefono || null, hash, roles_idroles]
    );

    const nuevoUsuario = resultUsuario.rows[0];

    console.log("✅ Usuario creado:", { id: nuevoUsuario.idusuario, correo: nuevoUsuario.correo });

    // Verificar acceso total
    const rol = await client.query(
      "SELECT acceso_total FROM roles WHERE idroles = $1 LIMIT 1",
      [roles_idroles]
    );

    const tieneAccesoTotal = rol.rows[0]?.acceso_total;

    // Insertar privilegios si corresponde
    if (!tieneAccesoTotal && privilegios && Array.isArray(privilegios) && privilegios.length > 0) {
      console.log("📋 Insertando privilegios:", privilegios.length);

      // Validar privilegios
      const privilegiosValidos = privilegios.every(
        (id) => Number.isInteger(Number(id)) && Number(id) > 0
      );

      if (!privilegiosValidos) {
        await client.query("ROLLBACK");
        return res.status(400).json({ 
          error: "Datos de privilegios inválidos" 
        });
      }

      for (const idPrivilegio of privilegios) {
        await client.query(
          `INSERT INTO privilegios_has_usuarios (privilegios_idprivilegios, usuarios_idusuario)
           VALUES ($1, $2)`,
          [idPrivilegio, nuevoUsuario.idusuario]
        );
      }
    } else if (tieneAccesoTotal) {
      console.log("👑 Usuario con acceso total");
    }

    await client.query("COMMIT");

    console.log("✅ Usuario creado exitosamente");

    res.status(201).json({
      message: "Usuario creado exitosamente",
      usuario: {
        id: nuevoUsuario.idusuario,
        nombre: nuevoUsuario.nombre,
        apellido: nuevoUsuario.apellido,
        correo: nuevoUsuario.correo,
        telefono: nuevoUsuario.telefono,
        rol: nuevoUsuario.roles_idroles,
      },
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ CREATE USUARIO ERROR:", error.message);
    res.status(500).json({ 
      error: "Error al procesar la solicitud" 
    });
  } finally {
    client.release();
  }
};

// ==========================
// OBTENER TODOS LOS USUARIOS
// ==========================
export const getUsuarios = async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.idusuario,
        u.nombre,
        u.apellido,
        u.correo,
        u.telefono,
        u.roles_idroles,
        u.created_at,
        r.nombre as rol,
        r.acceso_total
      FROM usuarios u
      LEFT JOIN roles r ON u.roles_idroles = r.idroles
      ORDER BY u.idusuario DESC
      LIMIT 1000
    `);

    res.json(result.rows);
  } catch (error: any) {
    console.error("❌ GET USUARIOS ERROR:", error.message);
    res.status(500).json({ 
      error: "Error al obtener usuarios" 
    });
  }
};

// ==========================
// OBTENER USUARIO POR ID
// ==========================
export const getUsuarioById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Validar ID
    if (!Number.isInteger(Number(id)) || Number(id) < 1) {
      return res.status(400).json({ 
        error: "ID inválido" 
      });
    }

    const result = await pool.query(`
      SELECT 
        u.idusuario,
        u.nombre,
        u.apellido,
        u.correo,
        u.telefono,
        u.roles_idroles,
        r.nombre as rol,
        r.acceso_total
      FROM usuarios u
      LEFT JOIN roles r ON u.roles_idroles = r.idroles
      WHERE u.idusuario = $1
      LIMIT 1
    `, [id]);

    if ((result.rowCount ?? 0) === 0) {
      return res.status(404).json({ 
        error: "Usuario no encontrado" 
      });
    }

    const usuario = result.rows[0];

    // Obtener privilegios
    const privilegiosResult = await pool.query(`
      SELECT privilegios_idprivilegios
      FROM privilegios_has_usuarios
      WHERE usuarios_idusuario = $1
    `, [id]);

    usuario.privilegios = privilegiosResult.rows.map(p => p.privilegios_idprivilegios);

    res.json(usuario);
  } catch (error: any) {
    console.error("❌ GET USUARIO BY ID ERROR:", error.message);
    res.status(500).json({ 
      error: "Error al obtener usuario" 
    });
  }
};

// ==========================
// ACTUALIZAR USUARIO
// ==========================
export const updateUsuario = async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    let { nombre, apellido, correo, telefono, codigo, roles_idroles, privilegios } = req.body;

    // Validar ID
    if (!Number.isInteger(Number(id)) || Number(id) < 1) {
      return res.status(400).json({ 
        error: "ID inválido" 
      });
    }

    // Sanitización
    nombre = validator.escape(nombre.trim());
    apellido = validator.escape(apellido.trim());
    correo = validator.normalizeEmail(correo.trim()) || "";

    console.log("📝 Actualizando usuario:", id);

    // Validaciones
    if (!nombre || !apellido || !correo) {
      return res.status(400).json({ 
        error: "Nombre, apellido y correo son requeridos" 
      });
    }

    if (!validator.isEmail(correo)) {
      return res.status(400).json({ 
        error: "El formato del correo no es válido" 
      });
    }

    if (!Number.isInteger(Number(roles_idroles)) || Number(roles_idroles) < 1) {
      return res.status(400).json({ 
        error: "Debe seleccionar un rol válido" 
      });
    }

    await client.query("BEGIN");

    // Verificar correo único (excepto el mismo usuario)
    const existeCorreo = await client.query(
      "SELECT 1 FROM usuarios WHERE correo = $1 AND idusuario != $2 LIMIT 1",
      [correo, id]
    );

    if ((existeCorreo.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ 
        error: "El correo ya está registrado" 
      });
    }

    let updateQuery = `
      UPDATE usuarios 
      SET nombre = $1, apellido = $2, correo = $3, telefono = $4, roles_idroles = $5
      WHERE idusuario = $6
      RETURNING idusuario, nombre, apellido, correo, telefono, roles_idroles
    `;
    let updateParams: any[] = [nombre, apellido, correo, telefono || null, roles_idroles, id];

    // Si se proporciona nuevo código
    if (codigo && codigo.trim() !== "") {
      if (!/^\d{5}$/.test(codigo)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ 
          error: "Datos de entrada inválidos" 
        });
      }

      // Validar código único
      const todosLosCodigos = await client.query(
        "SELECT idusuario, codigo FROM usuarios WHERE idusuario != $1 LIMIT $2",
        [id, MAX_USERS_TO_CHECK]
      );

      for (const row of todosLosCodigos.rows) {
        if (await bcrypt.compare(codigo, row.codigo)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ 
            error: "El código ya está en uso" 
          });
        }
      }

      const hash = await bcrypt.hash(codigo, BCRYPT_ROUNDS);
      updateQuery = `
        UPDATE usuarios 
        SET nombre = $1, apellido = $2, correo = $3, telefono = $4, roles_idroles = $5, codigo = $6
        WHERE idusuario = $7
        RETURNING idusuario, nombre, apellido, correo, telefono, roles_idroles
      `;
      updateParams = [nombre, apellido, correo, telefono || null, roles_idroles, hash, id];
    }

    const resultUsuario = await client.query(updateQuery, updateParams);

    if ((resultUsuario.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ 
        error: "Usuario no encontrado" 
      });
    }

    const usuarioActualizado = resultUsuario.rows[0];

    console.log("✅ Usuario actualizado:", { id: usuarioActualizado.idusuario });

    // Eliminar privilegios anteriores
    await client.query(
      "DELETE FROM privilegios_has_usuarios WHERE usuarios_idusuario = $1",
      [id]
    );

    // Verificar acceso total
    const rol = await client.query(
      "SELECT acceso_total FROM roles WHERE idroles = $1 LIMIT 1",
      [roles_idroles]
    );

    const tieneAccesoTotal = rol.rows[0]?.acceso_total;

    // Insertar nuevos privilegios
    if (!tieneAccesoTotal && privilegios && Array.isArray(privilegios) && privilegios.length > 0) {
      console.log("📋 Actualizando privilegios:", privilegios.length);

      const privilegiosValidos = privilegios.every(
        (idPriv) => Number.isInteger(Number(idPriv)) && Number(idPriv) > 0
      );

      if (!privilegiosValidos) {
        await client.query("ROLLBACK");
        return res.status(400).json({ 
          error: "Datos de privilegios inválidos" 
        });
      }

      for (const idPrivilegio of privilegios) {
        await client.query(
          `INSERT INTO privilegios_has_usuarios (privilegios_idprivilegios, usuarios_idusuario)
           VALUES ($1, $2)`,
          [idPrivilegio, id]
        );
      }
    }

    await client.query("COMMIT");

    console.log("✅ Actualización completada");

    res.json({
      message: "Usuario actualizado exitosamente",
      usuario: usuarioActualizado,
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ UPDATE USUARIO ERROR:", error.message);
    res.status(500).json({ 
      error: "Error al procesar la solicitud" 
    });
  } finally {
    client.release();
  }
};

// ==========================
// ELIMINAR USUARIO
// ==========================
export const deleteUsuario = async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    // Validar ID
    if (!Number.isInteger(Number(id)) || Number(id) < 1) {
      return res.status(400).json({ 
        error: "ID inválido" 
      });
    }

    await client.query("BEGIN");

    // Eliminar privilegios asociados
    await client.query(
      "DELETE FROM privilegios_has_usuarios WHERE usuarios_idusuario = $1",
      [id]
    );

    // Eliminar usuario
    const result = await client.query(
      "DELETE FROM usuarios WHERE idusuario = $1 RETURNING idusuario",
      [id]
    );

    if ((result.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ 
        error: "Usuario no encontrado" 
      });
    }

    await client.query("COMMIT");

    console.log("✅ Usuario eliminado:", id);

    res.json({ 
      message: "Usuario eliminado exitosamente" 
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ DELETE USUARIO ERROR:", error.message);
    res.status(500).json({ 
      error: "Error al procesar la solicitud" 
    });
  } finally {
    client.release();
  }
};

// ==========================
// OBTENER CONDUCTORES
// (usuarios con privilegio Conductor = 20)
// ==========================
export const getConductores = async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT
        u.idusuario,
        u.nombre,
        u.apellido,
        u.telefono,
        r.nombre AS rol
      FROM usuarios u
      JOIN roles r ON r.idroles = u.roles_idroles
      JOIN privilegios_has_usuarios phu ON phu.usuarios_idusuario = u.idusuario
      WHERE phu.privilegios_idprivilegios = 20
      ORDER BY u.nombre ASC
    `);
    res.json(result.rows);
  } catch (error: any) {
    console.error("❌ GET CONDUCTORES ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener conductores" });
  }
};


export const getUsuariosDiseno = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        u.idusuario,
        u.nombre,
        u.apellido,
        u.telefono,
        r.nombre AS rol
      FROM usuarios u
      JOIN roles r ON r.idroles = u.roles_idroles
      WHERE
        u.roles_idroles = 6
        OR EXISTS (
          SELECT 1 FROM privilegios_has_usuarios phu
          WHERE phu.usuarios_idusuario = u.idusuario
          AND phu.privilegios_idprivilegios = 22
        )
        OR r.acceso_total = true
      ORDER BY u.nombre ASC
    `);
    res.json(rows);
  } catch (error: any) {
    console.error("❌ GET USUARIOS DISEÑO ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener usuarios de diseño" });
  }
};