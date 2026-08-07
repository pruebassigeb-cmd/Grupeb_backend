import { PoolClient } from "pg";

/**
 * req.tx — ejecutor de transacciones con auditoría.
 *
 * Lo monta el middleware contextoAuditoria (src/middlewares/auditoria.ts)
 * sobre TODAS las peticiones. Abre la transacción, declara
 * app.usuario_id para los triggers de la bitácora, y hace COMMIT o ROLLBACK.
 *
 * Vive en src/@types/ y no en src/types/ por una razón concreta:
 * typeRoots carga automáticamente cada subcarpeta de aquí como paquete de
 * tipos, así que tanto `tsc` como ts-node (`npm run dev`) lo ven siempre.
 * Un .d.ts suelto en src/types/ no lo importa nadie, y ts-node —que solo
 * carga lo que alcanza siguiendo imports— se lo saltaba: `tsc` compilaba
 * pero el servidor tronaba con "Property 'tx' does not exist on type
 * 'Request'".
 *
 * Y NO se puede meter src/types/ en typeRoots: sus subcarpetas
 * (cotizadorLibre, expo, producto_papel, whatsapp) son módulos .types.ts
 * normales, no paquetes de tipos, y TS las reporta como paquetes rotos.
 */
declare global {
  namespace Express {
    interface Request {
      tx: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
    }
  }
}

export {};
