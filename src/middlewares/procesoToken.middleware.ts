import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

interface PayloadProceso {
  tipo: "proceso";
  operadorId: number;
  proceso: string;
  idproduccion: number;
}

/**
 * Lee X-Proceso-Token (emitido por /auth/verificar-operador, fase 5 de
 * roles y privilegios) y, si es válido y corresponde a la orden de esta
 * petición, deja disponible al operador real para que iniciarTx/qAudit lo
 * usen en vez del usuario de la sesión — que en el caso de la cuenta
 * compartida de Planta nunca es la persona que de verdad operó el proceso.
 *
 * A propósito NO bloquea la petición si el token falta, venció o no
 * coincide con la orden: esta fase resuelve la AUTORÍA de la bitácora, no
 * la AUTORIZACIÓN (eso ya lo cubrió verificarOperador antes de emitir el
 * token). Sin token válido, todo sigue exactamente igual que hoy — la
 * escritura se atribuye al usuario de sesión, como siempre.
 */
export const resolverOperadorProceso = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const token = req.headers["x-proceso-token"];
  if (!token || typeof token !== "string") return next();

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) return next();

  try {
    const payload = jwt.verify(token, jwtSecret) as PayloadProceso;
    if (payload.tipo !== "proceso") return next();

    const idproduccionRuta = Number(req.params.idproduccion);
    if (!Number.isInteger(idproduccionRuta) || payload.idproduccion !== idproduccionRuta) {
      console.warn(
        `⚠️ Token de proceso no coincide con la orden de esta petición — ` +
        `token emitido para producción ${payload.idproduccion}, petición para ${idproduccionRuta}`
      );
      return next();
    }

    (req as any).operadorId = payload.operadorId;
    (req as any).operadorProceso = payload.proceso;
  } catch {
    // Token vencido o inválido: se ignora sin bloquear la petición.
  }

  next();
};
