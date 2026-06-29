import type { Request, Response } from "express";
import { pool } from "../../config/db";
import {
  guardarMaquinariaSeleccionadaPapel,
  validarMaquinariaRequeridaPapel,
} from "../cotizaciones/cotizacionPapel.helper";

type MetodoHojeadoPapel = "hojeado" | "guillotina";

const esMetodoHojeadoValido = (valor: unknown): valor is MetodoHojeadoPapel =>
  valor === "hojeado" || valor === "guillotina";

const clavesRequeridas = (producto: any, llevaArmado: boolean): string[] => [
  "hojeado_guillotina",
  "impresora",
  ...(producto.idcat_laminado != null ? ["laminado_maquina"] : []),
  ...(producto.uv === true ? ["uv"] : []),
  ...(producto.idfoil != null || producto.alto_relieve === true
    ? ["hs_ar"]
    : []),
  ...(producto.idcat_textura != null ? ["texturizadora"] : []),
  "suaje_maquina",
  ...(llevaArmado ? ["armado"] : []),
  "empaque_maquina",
];

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

    await client.query("BEGIN");

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

      if (!esMetodoHojeadoValido(item.metodo_hojeado)) {
        throw new Error(
          `Selecciona Hojeado o Guillotina para el producto ${producto.idsolicitud_producto}`
        );
      }

      const llevaArmado = item.lleva_armado === true;

      await client.query(
        `UPDATE solicitud_producto_papel
         SET metodo_hojeado = $1, lleva_armado = $2
         WHERE idsolicitud_producto_papel = $3`,
        [
          item.metodo_hojeado,
          llevaArmado,
          Number(producto.idsolicitud_producto_papel),
        ]
      );

      const filtroHojeadoGuillotina = {
        hojeado_guillotina: {
          tipo_maquina: item.metodo_hojeado === "guillotina" ? "guillotina" : "hojeadora",
        },
      } as const;

      const seleccionValidada = await validarMaquinariaRequeridaPapel(
        client,
        Number(producto.producto_papel_idproducto_papel),
        clavesRequeridas(producto, llevaArmado),
        item.maquinaria_seleccionada,
        filtroHojeadoGuillotina
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
