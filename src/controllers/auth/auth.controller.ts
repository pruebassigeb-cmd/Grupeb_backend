import { Request, Response } from "express";
import { pool } from "../../config/db";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import validator from "validator";
import { getPresignedUrl } from "../../config/multer";

// ==========================
// CONSTANTES DE SEGURIDAD
// ==========================
const JWT_EXPIRATION = "16h";

// ==========================
// HELPER — obtener privilegios del usuario
// ==========================
async function obtenerPrivilegios(
  userId: number,
  rolId: number,
  accesoTotal: boolean
): Promise<string[]> {
  if (accesoTotal) return [];

  const { rows: custom } = await pool.query(
    `SELECT p.privilegio
     FROM privilegios_has_usuarios pu
     JOIN privilegios p ON p.idprivilegios = pu.privilegios_idprivilegios
     WHERE pu.usuarios_idusuario = $1`,
    [userId]
  );

  if (custom.length > 0) return custom.map((r: any) => r.privilegio);

  const { rows: rolPrivs } = await pool.query(
    `SELECT p.privilegio
     FROM roles_has_privilegios rp
     JOIN privilegios p ON p.idprivilegios = rp.privilegios_idprivilegios
     WHERE rp.roles_idroles = $1`,
    [rolId]
  );

  return rolPrivs.map((r: any) => r.privilegio);
}

// ==========================
// HELPER — verificar si un usuario tiene un privilegio
// ==========================
async function tienePrivilegio(
  userId: number,
  rolId: number,
  accesoTotal: boolean,
  privilegio: string
): Promise<boolean> {
  if (accesoTotal) return true;

  const { rows: custom } = await pool.query(
    `SELECT 1
     FROM privilegios_has_usuarios pu
     JOIN privilegios p ON p.idprivilegios = pu.privilegios_idprivilegios
     WHERE pu.usuarios_idusuario = $1
       AND p.privilegio = $2
     LIMIT 1`,
    [userId, privilegio]
  );

  if (custom.length > 0) return true;

  const { rows: rolPrivs } = await pool.query(
    `SELECT 1
     FROM roles_has_privilegios rp
     JOIN privilegios p ON p.idprivilegios = rp.privilegios_idprivilegios
     WHERE rp.roles_idroles = $1
       AND p.privilegio = $2
     LIMIT 1`,
    [rolId, privilegio]
  );

  return rolPrivs.length > 0;
}

// ==========================
// LOGIN
// ==========================
export const login = async (req: Request, res: Response) => {
  try {
    const { codigo, correo } = req.body;

    console.log("🔑 Intento de login");

    if (!codigo || !correo) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    if (!/^\d{4,8}$/.test(codigo)) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    if (!validator.isEmail(correo)) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const codigoSanitizado = codigo.replace(/\D/g, "");
    const correoSanitizado =
      validator.normalizeEmail(correo) || correo.toLowerCase().trim();

    const result = await pool.query(
      `SELECT u.idusuario, u.nombre, u.apellido, u.correo, u.codigo,
              u.roles_idroles, u.activo,
              r.nombre as rol, r.acceso_total,
              a.public_id AS foto_public_id
       FROM usuarios u
       LEFT JOIN roles r    ON u.roles_idroles = r.idroles
       LEFT JOIN archivos a ON a.id_archivo = u.foto_id_archivo
       WHERE LOWER(u.correo) = LOWER($1)
       LIMIT 1`,
      [correoSanitizado]
    );

    if ((result.rowCount ?? 0) === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const usuario = result.rows[0];

    // ── Verificar que la cuenta esté activa ──
    if (usuario.activo === false) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return res.status(403).json({
        error: "Tu cuenta está desactivada. Contacta al administrador.",
      });
    }

    const isMatch = await bcrypt.compare(codigoSanitizado, usuario.codigo);

    if (!isMatch) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      console.error("❌ JWT_SECRET no configurado");
      return res.status(500).json({ error: "Error de configuración del servidor" });
    }

    const privilegios = await obtenerPrivilegios(
      usuario.idusuario,
      usuario.roles_idroles,
      usuario.acceso_total
    );

    // Generar URL firmada de la foto si tiene
    const foto_url = usuario.foto_public_id
      ? await getPresignedUrl(usuario.foto_public_id)
      : null;

    const token = jwt.sign(
      {
        id:           usuario.idusuario,
        correo:       usuario.correo,
        rol:          usuario.rol,
        acceso_total: usuario.acceso_total,
        privilegios,
      },
      jwtSecret,
      {
        expiresIn: JWT_EXPIRATION,
        algorithm: "HS256",
      }
    );

    res.json({
      token,
      usuario: {
        id:           usuario.idusuario,
        nombre:       usuario.nombre,
        apellido:     usuario.apellido,
        correo:       usuario.correo,
        rol:          usuario.rol,
        acceso_total: usuario.acceso_total,
        privilegios,
        foto_url,
      },
    });

    console.log("✅ Login exitoso:", {
      id:          usuario.idusuario,
      rol:         usuario.rol,
      privilegios: privilegios.length,
    });
  } catch (error: any) {
    console.error("❌ LOGIN ERROR:", error.message);
    res.status(500).json({ error: "Error al procesar la solicitud" });
  }
};

// ==========================
// LOGOUT
// ==========================
export const logout = (req: Request, res: Response) => {
  try {
    res.json({ message: "Sesión cerrada exitosamente" });
    console.log("✅ Logout exitoso");
  } catch (error: any) {
    console.error("❌ LOGOUT ERROR:", error.message);
    res.status(500).json({ error: "Error al cerrar sesión" });
  }
};

// ==========================
// VERIFICAR TOKEN
// ==========================
export const verifyToken = (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        error:           "No autenticado",
        isAuthenticated: false,
      });
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      return res.status(500).json({ error: "Error de configuración del servidor" });
    }

    const decoded = jwt.verify(token, jwtSecret) as any;

    res.json({
      isAuthenticated: true,
      usuario: {
        id:           decoded.id,
        correo:       decoded.correo,
        rol:          decoded.rol,
        acceso_total: decoded.acceso_total,
        privilegios:  decoded.privilegios ?? [],
      },
    });
  } catch (error: any) {
    console.error("❌ TOKEN VERIFICATION ERROR:", error.message);
    res.status(401).json({
      error:           "Token inválido o expirado",
      isAuthenticated: false,
    });
  }
};

// ==========================
// VERIFICAR OPERADOR DE PLANTA
// ==========================
export const verificarOperador = async (req: Request, res: Response) => {
  try {
    const { correo, codigo, proceso } = req.body;

    const PROCESO_PRIVILEGIO: Record<string, string> = {
      extrusion:    "Operar Extrusión",
      impresion:    "Operar Impresión",
      bolseo:       "Operar Bolseo",
      asa_flexible: "Operar Asa Flexible",
      orden_diseno: "Orden de Diseño",
    };

    if (!correo || !codigo || !proceso) {
      return res.status(400).json({ error: "Correo, código y proceso son requeridos" });
    }

    if (!PROCESO_PRIVILEGIO[proceso]) {
      return res.status(400).json({ error: "Proceso inválido" });
    }

    if (!/^\d{4,8}$/.test(codigo)) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    if (!validator.isEmail(correo)) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const correoSanitizado =
      validator.normalizeEmail(correo) || correo.toLowerCase().trim();

    const { rows } = await pool.query(
      `SELECT u.idusuario, u.codigo, u.nombre, u.apellido,
              u.roles_idroles, u.activo, r.acceso_total
       FROM usuarios u
       LEFT JOIN roles r ON u.roles_idroles = r.idroles
       WHERE LOWER(u.correo) = LOWER($1)
       LIMIT 1`,
      [correoSanitizado]
    );

    if (rows.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const usuario = rows[0];

    // ── Verificar que la cuenta esté activa ──
    if (usuario.activo === false) {
      return res.status(403).json({ error: "Esta cuenta está desactivada." });
    }

    const isMatch = await bcrypt.compare(codigo, usuario.codigo);
    if (!isMatch) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const privilegioRequerido = PROCESO_PRIVILEGIO[proceso];
    const autorizado = await tienePrivilegio(
      usuario.idusuario,
      usuario.roles_idroles,
      usuario.acceso_total,
      privilegioRequerido
    );

    if (!autorizado) {
      return res.status(403).json({
        autorizado: false,
        error: `No tienes permiso para acceder a ${proceso.replace("_", " ")}`,
      });
    }

    console.log(`✅ Operador verificado: ${usuario.nombre} → ${proceso}`);

    return res.json({
      autorizado: true,
      operador: {
        id:       usuario.idusuario,
        nombre:   usuario.nombre,
        apellido: usuario.apellido,
      },
    });
  } catch (error: any) {
    console.error("❌ VERIFICAR OPERADOR ERROR:", error.message);
    return res.status(500).json({ error: "Error al verificar operador" });
  }
};