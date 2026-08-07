import { iniciarTx } from "../../middlewares/auditoria";
// NOTA: Este endpoint ya no se llama desde un modal manual — la
// confirmación de "Configurar maquinaria" (ModalMaquinariaPedidoPapel /
// ConfigurarMaquinariaPedidoPapel) se quitó del flujo de aprobación en
// EditarCotizacion.tsx. Si nada más lo invoca (revisar EditarPedidoPapel.tsx
// / Pedido.tsx, que no tengo en esta revisión), este archivo y su ruta
// pueden eliminarse. Si se conserva, item.maquinaria_seleccionada seguiría
// esperando que alguien lo mande — confirma si sigue teniendo un llamador.
import type { Request, Response } from "express";
import { pool } from "../../config/db";
import {
  guardarMaquinariaSeleccionadaPapel,
  validarMaquinariaRequeridaPapel,
  clavesMaquinariaRequeridasPapel,
} from "../cotizaciones/cotizacionPapel.helper";

export const guardarMaquinariaPedidoPapel = async (
  req: Request,
  res: Response
) => {
  const client = await pool.connect();
  try {
    const { noPedido } = req.params;
    const { maquinariaPapel = [] } = req.body;

    if (!Array.isArray(maquinariaPapel)) {
      return res.status(400).json({
        error: "maquinariaPapel debe ser una lista",
      });
    }

    await iniciarTx(req, client);

    const { rows: productos } = await client.query(
      `SELECT
         sp.idsolicitud_producto,
         sp.producto_papel_idproducto_papel,
         spp.idsolicitud_producto_papel,
         spp.idcat_laminado,
         spp.idfoil,
         spp.idcat_textura,
         spp.uv,
         spp.alto_relieve,
         spp.lleva_armado
       FROM solicitud s
       JOIN solicitud_producto sp
         ON sp.solicitud_idsolicitud = s.idsolicitud
       JOIN solicitud_producto_papel spp
         ON spp.idsolicitud_producto = sp.idsolicitud_producto
       WHERE s.no_pedido = $1
         AND s.estado = 'pedido'
         AND (
           sp.tipo_material = 'papel'
           OR sp.producto_papel_idproducto_papel IS NOT NULL
         )`,
      [noPedido]
    );

    if (productos.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "El pedido no existe o no contiene productos de papel",
      });
    }

    const seleccionPorProducto = new Map(
      maquinariaPapel.map((item: any) => [
        Number(item.idsolicitud_producto),
        item,
      ])
    );

    for (const producto of productos) {
      const item = seleccionPorProducto.get(
        Number(producto.idsolicitud_producto)
      ) as any;
      if (!item) {
        throw new Error(
          `Falta configurar los procesos y la maquinaria del producto ${producto.idsolicitud_producto}`
        );
      }

      const llevaArmado = item.lleva_armado === true;

      // NUEVO: metodo_hojeado ya no se guarda — Hojeado/Guillotina se
      // decide físicamente en producción, no en el sistema. Se deja lo que
      // ya traiga la fila (normalmente NULL); solo se actualiza lleva_armado.
      await client.query(
        `UPDATE solicitud_producto_papel
         SET lleva_armado = $1
         WHERE idsolicitud_producto_papel = $2`,
        [llevaArmado, Number(producto.idsolicitud_producto_papel)]
      );

      // NUEVO: ya no se filtra por tipo_maquina según un método elegido —
      // "hojeadora" y "guillotina" ahora son dos claves independientes, cada
      // una con la máquina que el producto ya tiene registrada por default.
      const seleccionValidada = await validarMaquinariaRequeridaPapel(
        client,
        Number(producto.producto_papel_idproducto_papel),
        clavesMaquinariaRequeridasPapel(producto, llevaArmado),
        item.maquinaria_seleccionada
      );

      await guardarMaquinariaSeleccionadaPapel(
        client,
        Number(producto.idsolicitud_producto_papel),
        seleccionValidada
      );
    }

    await client.query("COMMIT");
    return res.json({
      message: "Maquinaria del pedido guardada correctamente",
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("GUARDAR MAQUINARIA PEDIDO PAPEL ERROR:", error.message);
    return res.status(400).json({
      error: error.message || "No se pudo guardar la maquinaria del pedido",
    });
  } finally {
    client.release();
  }
};