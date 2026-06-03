import { Request, Response } from "express";
import { pool } from "../../config/db";
import bcrypt from "bcrypt";
import validator from "validator";
import { getPresignedUrl, deleteFromS3 } from "../../config/multer";

const BCRYPT_ROUNDS      = 12;
const MAX_USERS_TO_CHECK = 1000;

const CAMPOS_DIRECCION = [
  "calle", "numero_ext", "numero_int", "colonia",
  "codigo_postal", "municipio", "estado",
] as const;

const CAMPOS_FICHA = [
  "fecha_nacimiento", "nss", "tipo_sangre", "alergias", "enfermedades", "medicamentos",
  "emergencia_nombre", "emergencia_parentesco", "emergencia_telefono",
] as const;

const CAMPOS_USUARIO_EXTRA = ["foto_id_archivo", "rfc", "curp"] as const;

function extraerCampos(body: Record<string, any>, campos: readonly string[]) {
  const resultado: Record<string, any> = {};
  for (const campo of campos) {
    if (body[campo] !== undefined) {
      resultado[campo] = body[campo] === "" ? null : body[campo];
    }
  }
  return resultado;
}

async function upsertDetalle(
  client: any,
  tabla: string,
  fkColumn: string,
  idusuario: number,
  campos: Record<string, any>
) {
  const keys   = Object.keys(campos);
  const values = Object.values(campos);
  if (keys.length === 0) return;

  const setClauses   = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const updateResult = await client.query(
    `UPDATE ${tabla} SET ${setClauses}, updated_at = NOW() WHERE ${fkColumn} = $1`,
    [idusuario, ...values]
  );

  if ((updateResult.rowCount ?? 0) === 0) {
    const cols   = [fkColumn, ...keys].join(", ");
    const params = [`$1`, ...keys.map((_, i) => `$${i + 2}`)].join(", ");
    await client.query(
      `INSERT INTO ${tabla} (${cols}) VALUES (${params})`,
      [idusuario, ...values]
    );
  }
}

function normalizarFecha(valor: any): string | null {
  if (!valor) return null;
  if (valor instanceof Date) return valor.toISOString().split("T")[0];
  if (typeof valor === "string") return valor.split("T")[0];
  return null;
}

// ==========================
// CREAR USUARIO
// ==========================
export const createUsuario = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    let { nombre, apellido, correo, telefono, codigo, roles_idroles, privilegios } = req.body;

    if (!nombre?.trim() || !apellido?.trim() || !correo?.trim() || !codigo)
      return res.status(400).json({ error: "Todos los campos requeridos deben estar completos" });
    if (!/^\d{4,5}$/.test(codigo))
      return res.status(400).json({ error: "El código debe tener entre 4 y 5 dígitos" });
    if (!validator.isEmail(correo.trim()))
      return res.status(400).json({ error: "El formato del correo no es válido" });
    if (!Number.isInteger(Number(roles_idroles)) || Number(roles_idroles) < 1)
      return res.status(400).json({ error: "Datos de entrada inválidos" });

    nombre   = nombre.trim();
    apellido = apellido.trim();
    correo   = validator.normalizeEmail(correo.trim()) || "";

    console.log("📝 Creando nuevo usuario:", { nombre, apellido, correo, roles_idroles });

    await client.query("BEGIN");

    const existeCorreo = await client.query(
      "SELECT 1 FROM usuarios WHERE correo = $1 LIMIT 1", [correo]
    );
    if ((existeCorreo.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El correo ya está registrado" });
    }

    const hash = await bcrypt.hash(codigo, BCRYPT_ROUNDS);

    const extrasUsuario    = extraerCampos(req.body, CAMPOS_USUARIO_EXTRA);
    const extraKeys        = Object.keys(extrasUsuario);
    const extraValues      = Object.values(extrasUsuario);
    const baseColumns      = ["nombre", "apellido", "correo", "telefono", "codigo", "roles_idroles"];
    const basePlaceholders = ["$1", "$2", "$3", "$4", "$5", "$6"];
    const baseValues       = [nombre, apellido, correo, telefono || null, hash, roles_idroles];
    const allColumns       = [...baseColumns, ...extraKeys];
    const allPlaceholders  = [...basePlaceholders, ...extraKeys.map((_, i) => `$${i + 7}`)];
    const allValues        = [...baseValues, ...extraValues];

    const resultUsuario = await client.query(
      `INSERT INTO usuarios (${allColumns.join(", ")})
       VALUES (${allPlaceholders.join(", ")})
       RETURNING idusuario, nombre, apellido, correo, telefono, roles_idroles`,
      allValues
    );

    const nuevoUsuario = resultUsuario.rows[0];
    const uid          = nuevoUsuario.idusuario;
    console.log("✅ Usuario creado:", { id: uid });

    const camposDireccion = extraerCampos(req.body, CAMPOS_DIRECCION);
    if (Object.keys(camposDireccion).length > 0)
      await upsertDetalle(client, "usuarios_direccion", "idusuario", uid, camposDireccion);

    const camposFicha = extraerCampos(req.body, CAMPOS_FICHA);
    if (Object.keys(camposFicha).length > 0)
      await upsertDetalle(client, "usuarios_ficha_medica", "idusuario", uid, camposFicha);

    const rol = await client.query(
      "SELECT acceso_total FROM roles WHERE idroles = $1 LIMIT 1", [roles_idroles]
    );
    const tieneAccesoTotal = rol.rows[0]?.acceso_total;

    if (!tieneAccesoTotal && privilegios && Array.isArray(privilegios) && privilegios.length > 0) {
      const privilegiosValidos = privilegios.every(
        (id) => Number.isInteger(Number(id)) && Number(id) > 0
      );
      if (!privilegiosValidos) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Datos de privilegios inválidos" });
      }
      for (const idPrivilegio of privilegios) {
        await client.query(
          `INSERT INTO privilegios_has_usuarios (privilegios_idprivilegios, usuarios_idusuario)
           VALUES ($1, $2)`,
          [idPrivilegio, uid]
        );
      }
    }

    await client.query("COMMIT");
    console.log("✅ Usuario creado exitosamente");

    res.status(201).json({
      message: "Usuario creado exitosamente",
      usuario: {
        id:       uid,
        idusuario: uid,
        nombre:   nuevoUsuario.nombre,
        apellido: nuevoUsuario.apellido,
        correo:   nuevoUsuario.correo,
        telefono: nuevoUsuario.telefono,
        rol:      nuevoUsuario.roles_idroles,
      },
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ CREATE USUARIO ERROR:", error.message);
    res.status(500).json({ error: "Error al procesar la solicitud" });
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
        u.idusuario, u.nombre, u.apellido, u.correo, u.telefono,
        u.roles_idroles, u.created_at, u.activo, u.foto_id_archivo, u.rfc, u.curp,
        a.public_id AS foto_public_id,
        r.nombre       AS rol,
        r.acceso_total,
        d.calle, d.numero_ext, d.numero_int, d.colonia,
        d.codigo_postal, d.municipio, d.estado,
        fm.fecha_nacimiento, fm.nss, fm.tipo_sangre,
        fm.alergias, fm.enfermedades, fm.medicamentos,
        fm.emergencia_nombre, fm.emergencia_parentesco, fm.emergencia_telefono
      FROM usuarios u
      LEFT JOIN roles r                  ON u.roles_idroles = r.idroles
      LEFT JOIN usuarios_direccion d     ON d.idusuario = u.idusuario
      LEFT JOIN usuarios_ficha_medica fm ON fm.idusuario = u.idusuario
      LEFT JOIN archivos a               ON a.id_archivo = u.foto_id_archivo
      ORDER BY u.idusuario DESC
      LIMIT 1000
    `);

    const rows = await Promise.all(result.rows.map(async row => ({
      ...row,
      fecha_nacimiento: normalizarFecha(row.fecha_nacimiento),
      foto_url: row.foto_public_id ? await getPresignedUrl(row.foto_public_id) : null,
    })));

    res.json(rows);
  } catch (error: any) {
    console.error("❌ GET USUARIOS ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener usuarios" });
  }
};

// ==========================
// OBTENER USUARIO POR ID
// ==========================
export const getUsuarioById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!Number.isInteger(Number(id)) || Number(id) < 1)
      return res.status(400).json({ error: "ID inválido" });

    const result = await pool.query(`
      SELECT
        u.idusuario, u.nombre, u.apellido, u.correo, u.telefono,
        u.roles_idroles, u.activo, u.foto_id_archivo, u.rfc, u.curp,
        a.public_id AS foto_public_id,
        r.nombre       AS rol,
        r.acceso_total,
        d.calle, d.numero_ext, d.numero_int, d.colonia,
        d.codigo_postal, d.municipio, d.estado,
        fm.fecha_nacimiento, fm.nss, fm.tipo_sangre,
        fm.alergias, fm.enfermedades, fm.medicamentos,
        fm.emergencia_nombre, fm.emergencia_parentesco, fm.emergencia_telefono
      FROM usuarios u
      LEFT JOIN roles r                  ON u.roles_idroles = r.idroles
      LEFT JOIN usuarios_direccion d     ON d.idusuario = u.idusuario
      LEFT JOIN usuarios_ficha_medica fm ON fm.idusuario = u.idusuario
      LEFT JOIN archivos a               ON a.id_archivo = u.foto_id_archivo
      WHERE u.idusuario = $1
      LIMIT 1
    `, [id]);

    if ((result.rowCount ?? 0) === 0)
      return res.status(404).json({ error: "Usuario no encontrado" });

    const usuario = result.rows[0];
    usuario.fecha_nacimiento = normalizarFecha(usuario.fecha_nacimiento);
    usuario.foto_url = usuario.foto_public_id
      ? await getPresignedUrl(usuario.foto_public_id)
      : null;

    const privilegiosResult = await pool.query(`
      SELECT privilegios_idprivilegios
      FROM privilegios_has_usuarios
      WHERE usuarios_idusuario = $1
    `, [id]);

    usuario.privilegios = privilegiosResult.rows.map(p => p.privilegios_idprivilegios);

    res.json(usuario);
  } catch (error: any) {
    console.error("❌ GET USUARIO BY ID ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener usuario" });
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

    if (!Number.isInteger(Number(id)) || Number(id) < 1)
      return res.status(400).json({ error: "ID inválido" });
    if (!nombre?.trim() || !apellido?.trim() || !correo?.trim())
      return res.status(400).json({ error: "Nombre, apellido y correo son requeridos" });
    if (!validator.isEmail(correo.trim()))
      return res.status(400).json({ error: "El formato del correo no es válido" });
    if (!Number.isInteger(Number(roles_idroles)) || Number(roles_idroles) < 1)
      return res.status(400).json({ error: "Debe seleccionar un rol válido" });

    nombre   = nombre.trim();
    apellido = apellido.trim();
    correo   = validator.normalizeEmail(correo.trim()) || "";

    console.log("📝 Actualizando usuario:", id);

    await client.query("BEGIN");

    const existeCorreo = await client.query(
      "SELECT 1 FROM usuarios WHERE correo = $1 AND idusuario != $2 LIMIT 1", [correo, id]
    );
    if ((existeCorreo.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El correo ya está registrado" });
    }

    // ── Foto actual ───────────────────────────────────────────────────────────
    const fotoActualResult = await client.query(
      `SELECT u.foto_id_archivo, a.public_id AS foto_public_id
       FROM usuarios u
       LEFT JOIN archivos a ON a.id_archivo = u.foto_id_archivo
       WHERE u.idusuario = $1`, [id]
    );
    const fotoActual         = fotoActualResult.rows[0];
    const fotoIdActual       = fotoActual?.foto_id_archivo  ?? null;
    const fotoPublicIdActual = fotoActual?.foto_public_id   ?? null;
    const publicIdsABorrarDeS3: string[] = [];

    // ── Caso 1: eliminando foto ───────────────────────────────────────────────
    const eliminandoFoto =
      req.body.foto_id_archivo === null || req.body.foto_id_archivo === "";
    if (eliminandoFoto) {
      if (fotoIdActual) {
        await client.query("UPDATE usuarios SET foto_id_archivo = NULL WHERE idusuario = $1", [id]);
        await client.query("DELETE FROM archivos WHERE id_archivo = $1", [fotoIdActual]);
        if (fotoPublicIdActual) publicIdsABorrarDeS3.push(fotoPublicIdActual);
      }
      delete req.body.foto_id_archivo;
    }

    // ── Caso 2: reemplazando foto ─────────────────────────────────────────────
    const nuevaFotoId = req.body.foto_id_archivo ? Number(req.body.foto_id_archivo) : null;
    if (nuevaFotoId && fotoIdActual && nuevaFotoId !== fotoIdActual) {
      await client.query("DELETE FROM archivos WHERE id_archivo = $1", [fotoIdActual]);
      if (fotoPublicIdActual) publicIdsABorrarDeS3.push(fotoPublicIdActual);
    }

    // ── Construir UPDATE ──────────────────────────────────────────────────────
    const extrasUsuario = extraerCampos(req.body, CAMPOS_USUARIO_EXTRA);
    const extraKeys     = Object.keys(extrasUsuario);
    const extraValues   = Object.values(extrasUsuario);

    let paramIndex = 5;
    const setClauses: string[] = [
      `nombre=$1`, `apellido=$2`, `correo=$3`, `telefono=$4`, `roles_idroles=$5`,
    ];
    const updateValues: any[] = [nombre, apellido, correo, telefono || null, roles_idroles];

    if (codigo && codigo.trim() !== "") {
      if (!/^\d{4,5}$/.test(codigo)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "El código debe tener entre 4 y 5 dígitos" });
      }
      const nuevoHash = await bcrypt.hash(codigo, BCRYPT_ROUNDS);
      paramIndex++;
      setClauses.push(`codigo=$${paramIndex}`);
      updateValues.push(nuevoHash);
    }

    for (const key of extraKeys) {
      paramIndex++;
      setClauses.push(`${key}=$${paramIndex}`);
      updateValues.push(extrasUsuario[key]);
    }

    paramIndex++;
    updateValues.push(id);

    const resultUsuario = await client.query(
      `UPDATE usuarios SET ${setClauses.join(", ")}
       WHERE idusuario = $${paramIndex}
       RETURNING idusuario, nombre, apellido, correo, telefono, roles_idroles`,
      updateValues
    );

    if ((resultUsuario.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const uid = Number(id);

    const camposDireccion = extraerCampos(req.body, CAMPOS_DIRECCION);
    if (Object.keys(camposDireccion).length > 0)
      await upsertDetalle(client, "usuarios_direccion", "idusuario", uid, camposDireccion);

    const camposFicha = extraerCampos(req.body, CAMPOS_FICHA);
    if (Object.keys(camposFicha).length > 0)
      await upsertDetalle(client, "usuarios_ficha_medica", "idusuario", uid, camposFicha);

    await client.query("DELETE FROM privilegios_has_usuarios WHERE usuarios_idusuario = $1", [id]);

    const rol = await client.query(
      "SELECT acceso_total FROM roles WHERE idroles = $1 LIMIT 1", [roles_idroles]
    );
    const tieneAccesoTotal = rol.rows[0]?.acceso_total;

    if (!tieneAccesoTotal && privilegios && Array.isArray(privilegios) && privilegios.length > 0) {
      const privilegiosValidos = privilegios.every(
        (idPriv) => Number.isInteger(Number(idPriv)) && Number(idPriv) > 0
      );
      if (!privilegiosValidos) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Datos de privilegios inválidos" });
      }
      for (const idPrivilegio of privilegios) {
        await client.query(
          `INSERT INTO privilegios_has_usuarios (privilegios_idprivilegios, usuarios_idusuario)
           VALUES ($1, $2)`, [idPrivilegio, id]
        );
      }
    }

    await client.query("COMMIT");

    for (const publicId of publicIdsABorrarDeS3) {
      try {
        await deleteFromS3(publicId);
        console.log("🗑️ Foto eliminada de S3:", publicId);
      } catch (s3Error) {
        console.error("⚠️ No se pudo borrar foto de S3:", s3Error);
      }
    }

    console.log("✅ Actualización completada");
    res.json({ message: "Usuario actualizado exitosamente", usuario: resultUsuario.rows[0] });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ UPDATE USUARIO ERROR:", error.message);
    res.status(500).json({ error: "Error al procesar la solicitud" });
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

    if (!Number.isInteger(Number(id)) || Number(id) < 1)
      return res.status(400).json({ error: "ID inválido" });

    await client.query("BEGIN");

    // Foto de perfil
    const fotoResult = await client.query(
      "SELECT foto_id_archivo FROM usuarios WHERE idusuario = $1", [id]
    );
    const fotoIdArchivo = fotoResult.rows[0]?.foto_id_archivo || null;

    let fotoPublicId: string | null = null;
    if (fotoIdArchivo) {
      const archivoResult = await client.query(
        "SELECT public_id FROM archivos WHERE id_archivo = $1", [fotoIdArchivo]
      );
      fotoPublicId = archivoResult.rows[0]?.public_id || null;
    }

    // Fotos INE — usar usuario_id
    const ineResult = await client.query(
      `SELECT public_id FROM archivos
       WHERE usuario_id = $1 AND public_id LIKE '%usuarios-ine%'`, [id]
    );
    const inePublicIds: string[] = ineResult.rows.map((r: any) => r.public_id).filter(Boolean);

    await client.query("DELETE FROM privilegios_has_usuarios WHERE usuarios_idusuario = $1", [id]);

    const result = await client.query(
      "DELETE FROM usuarios WHERE idusuario = $1 RETURNING idusuario", [id]
    );

    if ((result.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    if (fotoIdArchivo)
      await client.query("DELETE FROM archivos WHERE id_archivo = $1", [fotoIdArchivo]);

    if (inePublicIds.length > 0)
      await client.query(
        `DELETE FROM archivos WHERE usuario_id = $1 AND public_id LIKE '%usuarios-ine%'`, [id]
      );

    await client.query("COMMIT");

    for (const publicId of [fotoPublicId, ...inePublicIds].filter(Boolean) as string[]) {
      try {
        await deleteFromS3(publicId);
        console.log("🗑️ Archivo eliminado de S3:", publicId);
      } catch (s3Error) {
        console.error("⚠️ No se pudo borrar de S3:", s3Error);
      }
    }

    console.log("✅ Usuario eliminado:", id);
    res.json({ message: "Usuario eliminado exitosamente" });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ DELETE USUARIO ERROR:", error.message);
    res.status(500).json({ error: "Error al procesar la solicitud" });
  } finally {
    client.release();
  }
};

// ==========================
// TOGGLE ACTIVO/INACTIVO
// ==========================
export const toggleActivoUsuario = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!Number.isInteger(Number(id)) || Number(id) < 1)
      return res.status(400).json({ error: "ID inválido" });

    const result = await pool.query(
      `UPDATE usuarios SET activo = NOT activo
       WHERE idusuario = $1
       RETURNING idusuario, nombre, apellido, activo`, [id]
    );

    if ((result.rowCount ?? 0) === 0)
      return res.status(404).json({ error: "Usuario no encontrado" });

    const u = result.rows[0];
    console.log(`✅ Usuario ${u.activo ? "activado" : "desactivado"}:`, id);
    res.json({ message: `Usuario ${u.activo ? "activado" : "desactivado"} exitosamente`, usuario: u });
  } catch (error: any) {
    console.error("❌ TOGGLE ACTIVO ERROR:", error.message);
    res.status(500).json({ error: "Error al procesar la solicitud" });
  }
};

// ==========================
// OBTENER CONDUCTORES
// ==========================
export const getConductores = async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT u.idusuario, u.nombre, u.apellido, u.telefono, r.nombre AS rol
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

// ==========================
// OBTENER USUARIOS DISEÑO
// ==========================
export const getUsuariosDiseno = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.idusuario, u.nombre, u.apellido, u.telefono, r.nombre AS rol
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

// ==========================
// OBTENER FOTOS INE DEL USUARIO
// ==========================
export const getFotosINE = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!Number.isInteger(Number(id)) || Number(id) < 1)
      return res.status(400).json({ error: "ID inválido" });

    const result = await pool.query(
      `SELECT id_archivo, nombre, public_id
       FROM archivos
       WHERE usuario_id = $1
         AND public_id LIKE '%usuarios-ine%'
       ORDER BY created_at ASC`,
      [id]
    );

    const archivos = await Promise.all(
      result.rows.map(async row => ({
        id_archivo: row.id_archivo,
        nombre:     row.nombre,
        public_id:  row.public_id,
        url:        await getPresignedUrl(row.public_id),
      }))
    );

    res.json(archivos);
  } catch (error: any) {
    console.error("❌ GET FOTOS INE ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener fotos INE" });
  }
};