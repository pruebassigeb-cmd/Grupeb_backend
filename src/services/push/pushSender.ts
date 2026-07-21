// src/services/push/pushSender.ts
import { pool } from "../../config/db";
import { webpush } from "../../config/webpush";

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

/**
 * Manda un push a todas las suscripciones activas de un usuario (puede
 * tener varias — un navegador/dispositivo distinto cada vez que se
 * suscribe). Si el servicio de push contesta que la suscripción ya no es
 * válida (404/410 — el usuario desinstaló la app o borró datos del
 * navegador), se borra de la base en vez de seguir reintentando algo que
 * nunca va a llegar.
 */
export async function enviarPush(usuarioId: number, payload: PushPayload): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, endpoint, keys FROM push_subscriptions WHERE usuario_id = $1`,
    [usuarioId]
  );

  await Promise.all(
    rows.map(async (fila) => {
      try {
        await webpush.sendNotification(
          { endpoint: fila.endpoint, keys: fila.keys },
          JSON.stringify(payload)
        );
      } catch (error: any) {
        if (error?.statusCode === 404 || error?.statusCode === 410) {
          await pool.query(`DELETE FROM push_subscriptions WHERE id = $1`, [fila.id]);
        } else {
          console.error("❌ ENVIAR PUSH ERROR:", error?.message || error);
        }
      }
    })
  );
}
