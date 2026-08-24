import { Request, Response } from "express";
import { pool } from "../../config/db";
import bcrypt from "bcrypt";
import validator from "validator";
import { getPresignedUrl, deleteFromS3 } from "../../config/multer";
import { ErrorHttp, responderError } from "../../utils/errorHttp";

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

// La base del rol se hereda por referencia (roles_privilegios), no se
// duplica como fila individual en privilegios_has_usuarios. El frontend ya
// no debería mandar ids que vengan de la base, pero se filtran aquí también
// por si acaso — así privilegios_has_usuarios solo guarda extras de verdad,
// sin importar qué mande el cliente.
async function filtrarExtrasDeLaBase(
  client: any,
  rolesIdroles: number,
  privilegios: any[]
): Promise<number[]> {
  if (!Array.isArray(privilegios) || privilegios.length === 0) return [];
  const { rows } = await client.query(
    "SELECT privilegios_idprivilegios FROM roles_privilegios WHERE roles_idroles = $1",
    [rolesIdroles]
  );
  const idsBase = new Set(rows.map((r: any) => Number(r.privilegios_idprivilegios)));
  return privilegios.map(Number).filter((id) => !idsBase.has(id));
}

// ==========================
// CREAR USUARIO
// ==========================
export const createUsuario = async (req: Request, res: Response) => {
  try {
    let { nombre, apellido, correo, telefono, codigo, roles_idroles, privilegios } = req.body;

    if (!nombre?.trim() || !apellido?.trim() || !correo?.trim() || !codigo)
      return res.status(400).json({ error: "Todos los campos requeridos deben estar completos" });
    if (!/^\d{4,8}$/.test(codigo))
      return res.status(400).json({ error: "El código debe tener entre 4 y 5 dígitos" });
    if (!validator.isEmail(correo.trim()))
      return res.status(400).json({ error: "El formato del correo no es válido" });
    if (!Number.isInteger(Number(roles_idroles)) || Number(roles_idroles) < 1)
      return res.status(400).json({ error: "Datos de entrada inválidos" });

    nombre   = nombre.trim();
    apellido = apellido.trim();
    correo   = validator.normalizeEmail(correo.trim()) || "";

    console.log("📝 Creando nuevo usuario:", { nombre, apellido, correo, roles_idroles });

    const nuevoUsuario = await req.tx(async (client) => {
      const existeCorreo = await client.query(
        `SELECT nombre, apellido, activo FROM usuarios
         WHERE correo = $1 AND eliminado_at IS NULL LIMIT 1`,
        [correo]
      );
      if ((existeCorreo.rowCount ?? 0) > 0) {
        const existente = existeCorreo.rows[0];
        if (existente.activo === false) {
          throw new ErrorHttp(
            400,
            `Este correo pertenece a un usuario desactivado (${existente.nombre} ${existente.apellido}). ` +
            `Actívalo o elimínalo antes de reutilizar el correo.`
          );
        }
        throw new ErrorHttp(400, "El correo ya está registrado");
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

      const creado = resultUsuario.rows[0];
      const uid    = creado.idusuario;
      console.log("✅ Usuario creado:", { id: uid });

      const camposDireccion = extraerCampos(req.body, CAMPOS_DIRECCION);
      if (Object.keys(camposDireccion).length > 0)
        await upsertDetalle(client, "usuarios_direccion", "idusuario", uid, camposDireccion);

      const camposFicha = extraerCampos(req.body, CAMPOS_FICHA);
      if (Object.keys(camposFicha).length > 0)
        await upsertDetalle(client, "usuarios_ficha_medica", "idusuario", uid, camposFicha);

      // ANTES: aquí se consultaba "acceso_total" del rol y se usaba para
      // saltar por completo el guardado de privilegios individuales
      // ("if (!tieneAccesoTotal && ...)"). Tickets es la excepción manual:
      // una persona con rol Admin puede necesitar el privilegio individual
      // aunque su rol ya tenga acceso total al resto. filtrarExtrasDeLaBase
      // ya evita duplicar lo que venga heredado del rol, así que guardar
      // sin esa condición es seguro para cualquier rol — ya no hace falta
      // ni consultar acceso_total aquí.
      if (privilegios && Array.isArray(privilegios) && privilegios.length > 0) {
        const privilegiosValidos = privilegios.every(
          (id: any) => Number.isInteger(Number(id)) && Number(id) > 0
        );
        if (!privilegiosValidos) {
          throw new ErrorHttp(400, "Datos de privilegios inválidos");
        }
        const extras = await filtrarExtrasDeLaBase(client, Number(roles_idroles), privilegios);
        for (const idPrivilegio of extras) {
          await client.query(
            `INSERT INTO privilegios_has_usuarios (privilegios_idprivilegios, usuarios_idusuario)
             VALUES ($1, $2)`,
            [idPrivilegio, uid]
          );
        }
      }

      return creado;
    });

    console.log("✅ Usuario creado exitosamente");

    res.status(201).json({
      message: "Usuario creado exitosamente",
      usuario: {
        id:       nuevoUsuario.idusuario,
        idusuario: nuevoUsuario.idusuario,
        nombre:   nuevoUsuario.nombre,
        apellido: nuevoUsuario.apellido,
        correo:   nuevoUsuario.correo,
        telefono: nuevoUsuario.telefono,
        rol:      nuevoUsuario.roles_idroles,
      },
    });
  } catch (error) {
    responderError(res, error, "Error al procesar la solicitud");
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
      WHERE u.eliminado_at IS NULL
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
        AND u.eliminado_at IS NULL
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

    // El borrado en S3 se hace DESPUÉS del commit: si la transacción falla,
    // no queremos haber borrado ya el archivo remoto, que no tiene rollback.
    const publicIdsABorrarDeS3: string[] = [];

    const usuarioActualizado = await req.tx(async (client) => {
      const existeCorreo = await client.query(
        `SELECT nombre, apellido, activo FROM usuarios
         WHERE correo = $1 AND idusuario != $2 AND eliminado_at IS NULL LIMIT 1`,
        [correo, id]
      );
      if ((existeCorreo.rowCount ?? 0) > 0) {
        const existente = existeCorreo.rows[0];
        if (existente.activo === false) {
          throw new ErrorHttp(
            400,
            `Este correo pertenece a un usuario desactivado (${existente.nombre} ${existente.apellido}). ` +
            `Actívalo o elimínalo antes de reutilizar el correo.`
          );
        }
        throw new ErrorHttp(400, "El correo ya está registrado");
      }

      // ── Foto actual ─────────────────────────────────────────────────────────
      const fotoActualResult = await client.query(
        `SELECT u.foto_id_archivo, a.public_id AS foto_public_id
         FROM usuarios u
         LEFT JOIN archivos a ON a.id_archivo = u.foto_id_archivo
         WHERE u.idusuario = $1`, [id]
      );
      const fotoActual         = fotoActualResult.rows[0];
      const fotoIdActual       = fotoActual?.foto_id_archivo  ?? null;
      const fotoPublicIdActual = fotoActual?.foto_public_id   ?? null;

      // ── Caso 1: eliminando foto ─────────────────────────────────────────────
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

      // ── Caso 2: reemplazando foto ───────────────────────────────────────────
      const nuevaFotoId = req.body.foto_id_archivo ? Number(req.body.foto_id_archivo) : null;
      if (nuevaFotoId && fotoIdActual && nuevaFotoId !== fotoIdActual) {
        await client.query("DELETE FROM archivos WHERE id_archivo = $1", [fotoIdActual]);
        if (fotoPublicIdActual) publicIdsABorrarDeS3.push(fotoPublicIdActual);
      }

      // ── Construir UPDATE ────────────────────────────────────────────────────
      const extrasUsuario = extraerCampos(req.body, CAMPOS_USUARIO_EXTRA);
      const extraKeys     = Object.keys(extrasUsuario);

      let paramIndex = 5;
      const setClauses: string[] = [
        `nombre=$1`, `apellido=$2`, `correo=$3`, `telefono=$4`, `roles_idroles=$5`,
      ];
      const updateValues: any[] = [nombre, apellido, correo, telefono || null, roles_idroles];

      if (codigo && codigo.trim() !== "") {
        if (!/^\d{4,8}$/.test(codigo)) {
          throw new ErrorHttp(400, "El código debe tener entre 4 y 5 dígitos");
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
        throw new ErrorHttp(404, "Usuario no encontrado");
      }

      const uid = Number(id);

      const camposDireccion = extraerCampos(req.body, CAMPOS_DIRECCION);
      if (Object.keys(camposDireccion).length > 0)
        await upsertDetalle(client, "usuarios_direccion", "idusuario", uid, camposDireccion);

      const camposFicha = extraerCampos(req.body, CAMPOS_FICHA);
      if (Object.keys(camposFicha).length > 0)
        await upsertDetalle(client, "usuarios_ficha_medica", "idusuario", uid, camposFicha);

      await client.query("DELETE FROM privilegios_has_usuarios WHERE usuarios_idusuario = $1", [id]);

      // Igual que en createUsuario: ya no se salta este guardado por
      // acceso_total — Tickets necesita poder marcarse individual aunque el
      // rol de la persona tenga acceso total al resto.
      if (privilegios && Array.isArray(privilegios) && privilegios.length > 0) {
        const privilegiosValidos = privilegios.every(
          (idPriv: any) => Number.isInteger(Number(idPriv)) && Number(idPriv) > 0
        );
        if (!privilegiosValidos) {
          throw new ErrorHttp(400, "Datos de privilegios inválidos");
        }
        const extras = await filtrarExtrasDeLaBase(client, Number(roles_idroles), privilegios);
        for (const idPrivilegio of extras) {
          await client.query(
            `INSERT INTO privilegios_has_usuarios (privilegios_idprivilegios, usuarios_idusuario)
             VALUES ($1, $2)`, [idPrivilegio, id]
          );
        }
      }

      return resultUsuario.rows[0];
    });

    for (const publicId of publicIdsABorrarDeS3) {
      try {
        await deleteFromS3(publicId);
        console.log("🗑️ Foto eliminada de S3:", publicId);
      } catch (s3Error) {
        console.error("⚠️ No se pudo borrar foto de S3:", s3Error);
      }
    }

    console.log("✅ Actualización completada");
    res.json({ message: "Usuario actualizado exitosamente", usuario: usuarioActualizado });
  } catch (error) {
    responderError(res, error, "Error al procesar la solicitud");
  }
};

// ==========================
// ELIMINAR USUARIO
// ==========================
/**
 * Da de baja un usuario.
 *
 * Es baja LÓGICA, no DELETE. No es una preferencia de estilo: desde que se
 * activó la auditoría, cada tabla auditada tiene creado_por / actualizado_por
 * / eliminado_por con llave foránea a usuarios(idusuario). Borrar físicamente
 * a alguien que alguna vez capturó algo revienta con violación de llave
 * foránea, y si se pudiera sería peor: dejaría toda su huella sin nombre.
 *
 * El usuario deja de aparecer en la lista y no puede entrar (getUsuarios y
 * el login filtran eliminado_at IS NULL), pero su nombre sigue resolviendo
 * en cada "creado por" del historial.
 */
export const deleteUsuario = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!Number.isInteger(Number(id)) || Number(id) < 1)
      return res.status(400).json({ error: "ID inválido" });

    if (Number(id) === (req as any).user?.id) {
      return res.status(400).json({ error: "No puedes darte de baja a ti mismo" });
    }

    const publicIds = await req.tx(async (client) => {
      // Foto de perfil
      const fotoResult = await client.query(
        "SELECT foto_id_archivo FROM usuarios WHERE idusuario = $1 AND eliminado_at IS NULL", [id]
      );
      if (fotoResult.rowCount === 0) {
        throw new ErrorHttp(404, "Usuario no encontrado");
      }
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

      // Los permisos sí se retiran de verdad: un usuario dado de baja no debe
      // conservar accesos. El DELETE queda auditado en la bitácora.
      await client.query("DELETE FROM privilegios_has_usuarios WHERE usuarios_idusuario = $1", [id]);

      // eliminado_por lo llena el trigger fn_tocar_autoria.
      //
      // El correo se libera aquí mismo (prefijo con idusuario + timestamp),
      // no cuando alguien lo desactiva. Así queda disponible de inmediato
      // para un usuario nuevo. El registro (y el correo original, ya con
      // prefijo) se conserva en la fila para no romper la auditoría.
      await client.query(
        `UPDATE usuarios
            SET eliminado_at = now(),
                activo = false,
                correo = 'eliminado_' || idusuario || '_' || extract(epoch FROM now())::bigint || '_' || correo
          WHERE idusuario = $1 AND eliminado_at IS NULL`,
        [id]
      );

      // La foto sí se borra: es un archivo, no un dato de negocio.
      if (fotoIdArchivo) {
        await client.query("UPDATE usuarios SET foto_id_archivo = NULL WHERE idusuario = $1", [id]);
        await client.query("DELETE FROM archivos WHERE id_archivo = $1", [fotoIdArchivo]);
      }

      if (inePublicIds.length > 0)
        await client.query(
          `DELETE FROM archivos WHERE usuario_id = $1 AND public_id LIKE '%usuarios-ine%'`, [id]
        );

      return [fotoPublicId, ...inePublicIds].filter(Boolean) as string[];
    });

    for (const publicId of publicIds) {
      try {
        await deleteFromS3(publicId);
        console.log("🗑️ Archivo eliminado de S3:", publicId);
      } catch (s3Error) {
        console.error("⚠️ No se pudo borrar de S3:", s3Error);
      }
    }

    console.log("✅ Usuario dado de baja:", id);
    res.json({ message: "Usuario eliminado exitosamente" });
  } catch (error) {
    responderError(res, error, "Error al procesar la solicitud");
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

    // eliminado_at IS NULL evita revivir por aquí a alguien dado de baja.
    const u = await req.tx(async (client) => {
      const result = await client.query(
        `UPDATE usuarios SET activo = NOT activo
         WHERE idusuario = $1 AND eliminado_at IS NULL
         RETURNING idusuario, nombre, apellido, activo`, [id]
      );

      if ((result.rowCount ?? 0) === 0) {
        throw new ErrorHttp(404, "Usuario no encontrado");
      }
      return result.rows[0];
    });

    console.log(`✅ Usuario ${u.activo ? "activado" : "desactivado"}:`, id);
    res.json({ message: `Usuario ${u.activo ? "activado" : "desactivado"} exitosamente`, usuario: u });
  } catch (error) {
    responderError(res, error, "Error al procesar la solicitud");
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
      WHERE u.activo = true
        AND u.eliminado_at IS NULL
        AND (
        lower(btrim(r.nombre)) IN ('ventas', 'diseño', 'diseno')
        OR EXISTS (
          SELECT 1
          FROM privilegios_has_usuarios phu
          JOIN privilegios p
            ON p.idprivilegios = phu.privilegios_idprivilegios
          WHERE phu.usuarios_idusuario = u.idusuario
            AND p.privilegio IN ('Editar Diseño', 'Orden de Diseño')
        )
        OR EXISTS (
          SELECT 1
          FROM roles_privilegios rp
          JOIN privilegios p
            ON p.idprivilegios = rp.privilegios_idprivilegios
          WHERE rp.roles_idroles = r.idroles
            AND p.privilegio IN ('Editar Diseño', 'Orden de Diseño')
        )
        OR r.acceso_total = true
        )
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