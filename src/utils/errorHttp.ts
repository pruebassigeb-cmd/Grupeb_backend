/**
 * Error con código HTTP, para cortar el flujo dentro de una transacción.
 *
 * Con req.tx() ya no hay un `await client.query("ROLLBACK")` a la mano para
 * hacer `return res.status(404)` a media transacción: el rollback lo dispara
 * la excepción. Este error lleva el status pegado para que el catch de
 * afuera responda lo correcto en vez de un 500 genérico.
 *
 *   await req.tx(async (client) => {
 *     const v = await client.query(...);
 *     if (!v.rows.length) throw new ErrorHttp(404, "Venta no encontrada");
 *   });
 */
export class ErrorHttp extends Error {
  constructor(
    public readonly status: number,
    mensaje: string
  ) {
    super(mensaje);
    this.name = "ErrorHttp";
  }
}

/** Responde con el status del ErrorHttp, o 500 si es cualquier otra cosa. */
export const responderError = (
  res: { status: (n: number) => { json: (b: any) => any } },
  error: unknown,
  mensajeGenerico: string
) => {
  if (error instanceof ErrorHttp) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error(`❌ ${mensajeGenerico}:`, (error as Error)?.message ?? error);
  return res.status(500).json({ error: mensajeGenerico });
};
