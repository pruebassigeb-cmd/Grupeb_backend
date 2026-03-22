import { Request, Response } from "express";
import { pool } from "../../config/db";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import validator from "validator";

// ==========================
// CONSTANTES DE SEGURIDAD
// ==========================
const JWT_EXPIRATION = "8h";

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

    if (!/^\d{5}$/.test(codigo)) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    if (!validator.isEmail(correo)) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const codigoSanitizado = codigo.replace(/\D/g, "");
    const correoSanitizado = validator.normalizeEmail(correo) || correo.toLowerCase().trim();

    const result = await pool.query(
      `SELECT u.idusuario, u.nombre, u.apellido, u.correo, u.codigo, 
              r.nombre as rol, r.acceso_total
       FROM usuarios u
       LEFT JOIN roles r ON u.roles_idroles = r.idroles
       WHERE LOWER(u.correo) = LOWER($1)
       LIMIT 1`,
      [correoSanitizado]
    );

    if ((result.rowCount ?? 0) === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const usuario = result.rows[0];

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

    const token = jwt.sign(
      {
        id: usuario.idusuario,
        correo: usuario.correo,
        rol: usuario.rol,
        acceso_total: usuario.acceso_total,
      },
      jwtSecret,
      {
        expiresIn: JWT_EXPIRATION,
        algorithm: "HS256",
      }
    );

    // Devolver token en el body
    res.json({
      token,
      usuario: {
        id: usuario.idusuario,
        nombre: usuario.nombre,
        apellido: usuario.apellido,
        correo: usuario.correo,
        rol: usuario.rol,
        acceso_total: usuario.acceso_total,
      },
    });

    console.log("✅ Login exitoso:", { id: usuario.idusuario, rol: usuario.rol });
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
        error: "No autenticado",
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
        id: decoded.id,
        correo: decoded.correo,
        rol: decoded.rol,
        acceso_total: decoded.acceso_total,
      },
    });
  } catch (error: any) {
    console.error("❌ TOKEN VERIFICATION ERROR:", error.message);
    res.status(401).json({
      error: "Token inválido o expirado",
      isAuthenticated: false,
    });
  }
};