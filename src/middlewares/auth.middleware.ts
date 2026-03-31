import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// ==========================
// INTERFACES
// ==========================
interface JwtPayload {
  id:           number;
  correo:       string;
  rol?:         string;
  acceso_total?: boolean;
  privilegios?: string[];
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}

// ==========================
// MIDDLEWARE DE AUTENTICACIÓN
// ==========================
export const authMiddleware = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const token =
      req.cookies?.token || req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        error: "Acceso no autorizado - Token requerido",
      });
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      console.error("❌ JWT_SECRET no configurado");
      return res.status(500).json({
        error: "Error de configuración del servidor",
      });
    }

    const decoded = jwt.verify(token, jwtSecret, {
      algorithms: ["HS256"],
      complete:   false,
    }) as JwtPayload;

    if (!decoded.id || !decoded.correo) {
      return res.status(401).json({
        error: "Token inválido - Datos incompletos",
      });
    }

    req.user = {
      id:           decoded.id,
      correo:       decoded.correo,
      rol:          decoded.rol,
      acceso_total: decoded.acceso_total,
      privilegios:  decoded.privilegios ?? [],
    };

    next();
  } catch (err: any) {
    console.error("❌ AUTH MIDDLEWARE ERROR:", err.message);

    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        error: "Token expirado - Por favor inicia sesión nuevamente",
      });
    }

    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Token inválido" });
    }

    return res.status(401).json({ error: "Error de autenticación" });
  }
};

// ==========================
// MIDDLEWARE DE PRIVILEGIO
// Verifica que el usuario tenga un privilegio específico.
// Si tiene acceso_total → pasa siempre.
// Si no → busca el privilegio en su lista.
// ==========================
export const checkPermiso = (privilegio: string) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Usuario no autenticado" });
      }

      // Acceso total → pasa sin validar privilegios
      if (req.user.acceso_total) {
        return next();
      }

      const tienePermiso = (req.user.privilegios ?? []).includes(privilegio);

      if (!tienePermiso) {
        console.warn(
          `🚫 Acceso denegado — usuario ${req.user.id} no tiene "${privilegio}"`
        );
        return res.status(403).json({
          error: "No tienes permisos para realizar esta acción",
        });
      }

      next();
    } catch (err: any) {
      console.error("❌ CHECK PERMISO ERROR:", err.message);
      return res.status(500).json({ error: "Error al verificar permisos" });
    }
  };
};

// ==========================
// MIDDLEWARE DE AUTORIZACIÓN POR ROL
// ==========================
export const requireRole = (...allowedRoles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Usuario no autenticado" });
      }

      if (req.user.acceso_total) {
        return next();
      }

      const userRole = req.user.rol;

      if (!userRole || !allowedRoles.includes(userRole)) {
        return res.status(403).json({
          error: "No tienes permisos para acceder a este recurso",
        });
      }

      next();
    } catch (err: any) {
      console.error("❌ ROLE MIDDLEWARE ERROR:", err.message);
      return res.status(500).json({ error: "Error al verificar permisos" });
    }
  };
};

// ==========================
// MIDDLEWARE DE ACCESO TOTAL
// ==========================
export const requireAccessTotal = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Usuario no autenticado" });
    }

    if (!req.user.acceso_total) {
      return res.status(403).json({
        error: "Requiere acceso total para esta operación",
      });
    }

    next();
  } catch (err: any) {
    console.error("❌ ACCESS TOTAL MIDDLEWARE ERROR:", err.message);
    return res.status(500).json({ error: "Error al verificar permisos" });
  }
};

// ==========================
// MIDDLEWARE OPCIONAL DE AUTENTICACIÓN
// ==========================
export const optionalAuth = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const token =
      req.cookies?.token || req.headers.authorization?.split(" ")[1];

    if (!token) return next();

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) return next();

    const decoded = jwt.verify(token, jwtSecret, {
      algorithms: ["HS256"],
    }) as JwtPayload;

    req.user = {
      id:           decoded.id,
      correo:       decoded.correo,
      rol:          decoded.rol,
      acceso_total: decoded.acceso_total,
      privilegios:  decoded.privilegios ?? [],
    };

    next();
  } catch (err) {
    next();
  }
};