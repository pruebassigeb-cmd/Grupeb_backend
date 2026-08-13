import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// ==========================
// INTERFACES
// ==========================
export interface JwtPayload {
  id:           number;
  correo:       string;
  rol?:         string;
  acceso_total?: boolean;
  privilegios?: string[];
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}

// Fase 6: estos dos ya son clave, no el texto visible — ver
// docs/roles-privilegios-plan.md. El texto (privilegios.privilegio) queda
// libre para renombrar desde la pantalla de Roles sin romper nada.
export const PERMISO_EDITAR_DISENO = "diseno.editar";
export const PERMISO_ORDEN_DISENO = "diseno.orden";

const normalizarRol = (rol?: string): string =>
  (rol ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

/**
 * `usuario.privilegios` trae claves (fase 6), no el texto visible del
 * privilegio — así renombrar la etiqueta desde la pantalla de Roles no
 * rompe nada aquí. La antigua excepción por nombre de rol para
 * Diseño/Ventas se quitó: los dos roles ya tienen estos privilegios en su
 * base real (roles_privilegios) desde antes de la fase 0, así que era pura
 * redundancia — confirmado contra la BD antes de quitarla.
 */
export const usuarioTienePermiso = (
  usuario: JwtPayload | undefined,
  privilegio: string
): boolean => {
  if (!usuario) return false;
  if (usuario.acceso_total) return true;
  return (usuario.privilegios ?? []).includes(privilegio);
};

const ROLES_ADMINISTRATIVOS = new Set([
  "admin",
  "administrador",
  "super usuario",
  "superusuario",
]);

export const usuarioEsAdminOSuper = (usuario: JwtPayload | undefined): boolean =>
  Boolean(
    usuario?.acceso_total &&
    ROLES_ADMINISTRATIVOS.has(normalizarRol(usuario.rol))
  );

// ==========================
// MODO SIMULACIÓN — fase 3 de roles y privilegios
//
// checkPermiso/checkAnyPermiso se están agregando a rutas que hoy no piden
// ningún privilegio específico. Activarlas en frío bloquearía a cualquiera
// que hoy dependa de ese hueco sin tener el privilegio formal asignado
// todavía (ver GrupEB_Frontend/docs/roles-privilegios-plan.md §5.1).
//
// PERMISOS_MODO=simular (default, incluso si la variable no existe) → nunca
// bloquea; cuando alguien HABRÍA sido rechazado, deja pasar la petición
// igual y solo registra un aviso. PERMISOS_MODO=bloquear → comportamiento
// real (403). El default seguro es intencional: si alguien olvida poner la
// variable en un ambiente nuevo, el sistema no empieza a rechazar gente por
// accidente.
// ==========================
export const modoSimulacion = (): boolean =>
  (process.env.PERMISOS_MODO ?? "simular").trim().toLowerCase() !== "bloquear";

const registrarSimulacion = (
  req: AuthRequest,
  privilegioODescripcion: string
) => {
  console.warn(
    `🧪 [SIMULACIÓN] usuario ${req.user?.id} habría sido bloqueado en ` +
    `${req.method} ${req.originalUrl} por faltarle "${privilegioODescripcion}"`
  );
};

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
// Marca la función devuelta por checkPermiso/checkAnyPermiso para que
// scripts/verificarCoberturaPermisos.ts pueda reconocerla al recorrer el
// árbol de rutas de Express — el nombre de una función retornada así
// (`return (req,res,next) => {...}`) no queda inferido de forma confiable.
const marcarComoGuardaAuth = <T extends (...args: any[]) => any>(fn: T): T => {
  (fn as any).__esGuardaAuth = true;
  return fn;
};

const NOMBRES_GUARDA_AUTH = new Set([
  "authMiddleware",
  "requireAccessTotal",
  "requireAdminOrSuperUser",
]);

export const esGuardaAuth = (fn: unknown): boolean =>
  typeof fn === "function" &&
  ((fn as any).__esGuardaAuth === true || NOMBRES_GUARDA_AUTH.has((fn as Function).name));

export const checkPermiso = (privilegio: string) => {
  return marcarComoGuardaAuth((req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Usuario no autenticado" });
      }

      // Acceso total → pasa sin validar privilegios
      const tienePermiso = usuarioTienePermiso(req.user, privilegio);

      if (!tienePermiso) {
        console.warn(
          `🚫 Acceso denegado — usuario ${req.user.id} no tiene "${privilegio}"`
        );
        if (modoSimulacion()) {
          registrarSimulacion(req, privilegio);
          return next();
        }
        return res.status(403).json({
          error: "No tienes permisos para realizar esta acción",
        });
      }

      next();
    } catch (err: any) {
      console.error("❌ CHECK PERMISO ERROR:", err.message);
      return res.status(500).json({ error: "Error al verificar permisos" });
    }
  });
};

// ==========================
// MIDDLEWARE DE CUALQUIERA DE VARIOS PRIVILEGIOS
// ==========================
export const checkAnyPermiso = (...privilegios: string[]) => {
  return marcarComoGuardaAuth((req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Usuario no autenticado" });
      }

      const tieneAlguno = privilegios.some((privilegio) =>
        usuarioTienePermiso(req.user, privilegio)
      );

      if (!tieneAlguno) {
        if (modoSimulacion()) {
          registrarSimulacion(req, privilegios.join(" | "));
          return next();
        }
        return res.status(403).json({
          error: "No tienes permisos para acceder a este recurso",
        });
      }

      next();
    } catch (err: any) {
      console.error("❌ CHECK ANY PERMISO ERROR:", err.message);
      return res.status(500).json({ error: "Error al verificar permisos" });
    }
  });
};

// ==========================
// MIDDLEWARE DE AUTORIZACIÓN POR ROL
// ==========================
export const requireRole = (...allowedRoles: string[]) => {
  return marcarComoGuardaAuth((req: AuthRequest, res: Response, next: NextFunction) => {
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
  });
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

// ==========================
// MIDDLEWARE EXCLUSIVO DE ADMIN / SUPER USUARIO
// Además de acceso_total valida el rol para excluir cuentas especiales que
// históricamente pudieron conservar ese flag (por ejemplo Expo).
// ==========================
export const requireAdminOrSuperUser = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Usuario no autenticado" });
    }

    if (!usuarioEsAdminOSuper(req.user)) {
      return res.status(403).json({
        error: "Esta operación es exclusiva de administradores",
      });
    }

    next();
  } catch (err: any) {
    console.error("❌ ADMIN ACCESS MIDDLEWARE ERROR:", err.message);
    return res.status(500).json({ error: "Error al verificar permisos" });
  }
};
