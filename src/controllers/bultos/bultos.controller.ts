import { Request, Response } from "express";
import { pool } from "../../config/db";

// ─────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────
type ProcesoOrigen = "bolseo" | "asa_flexible";

interface FkBulto {
  tipo: ProcesoOrigen;
  id:   number;
}

// ─────────────────────────────────────────────
// HELPER — resuelve qué FK usar
// ─────────────────────────────────────────────
async function resolverFkBulto(idproduccion: number): Promise<FkBulto | null> {
  const { rows: asaRows } = await pool.query(
    `SELECT idasa_flexible, estado_produccion_cat_idestado_produccion_cat AS estado_id
     FROM asa_flexible
     WHERE orden_produccion_idproduccion = $1`,
    [idproduccion]
  );

  if (asaRows.length > 0 && Number(asaRows[0].estado_id) === 3) {
    return { tipo: "asa_flexible", id: Number(asaRows[0].idasa_flexible) };
  }

  const { rows: bolRows } = await pool.query(
    `SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = $1`,
    [idproduccion]
  );

  if (bolRows.length > 0) {
    return { tipo: "bolseo", id: Number(bolRows[0].idbolseo) };
  }

  return null;
}

// ─────────────────────────────────────────────
// GET /api/seguimiento/:idproduccion/bultos
// ─────────────────────────────────────────────
export const getBultos = async (req: Request, res: Response): Promise<Response> => {
  try {
    const idproduccion = Number(req.params.idproduccion);

    const { rows: ordenRows } = await pool.query(
      `SELECT bultos_finalizado FROM orden_produccion WHERE idproduccion = $1`,
      [idproduccion]
    );

    if (ordenRows.length === 0) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    const bultos_finalizado = Boolean(ordenRows[0].bultos_finalizado);

    const { rows } = await pool.query(
      `SELECT
         b.idbulto,
         b.cantidad_unidades,
         b.fecha_creacion,
         b.peso,
         b.alto,
         b.largo,
         b.ancho,
         CASE
           WHEN b.bolseo_idbolseo             IS NOT NULL THEN 'bolseo'
           WHEN b.asa_flexible_idasa_flexible IS NOT NULL THEN 'asa_flexible'
         END AS proceso_origen
       FROM bultos b
       WHERE
         b.bolseo_idbolseo IN (
           SELECT idbolseo FROM bolseo
           WHERE orden_produccion_idproduccion = $1
         )
         OR
         b.asa_flexible_idasa_flexible IN (
           SELECT idasa_flexible FROM asa_flexible
           WHERE orden_produccion_idproduccion = $1
         )
       ORDER BY b.idbulto ASC`,
      [idproduccion]
    );

    const total_unidades: number = rows.reduce(
      (sum: number, r: any) => sum + Number(r.cantidad_unidades),
      0
    );

    return res.json({
      bultos_finalizado,
      bultos: rows.map((r: any) => ({
        idbulto:           Number(r.idbulto),
        cantidad_unidades: Number(r.cantidad_unidades),
        fecha_creacion:    r.fecha_creacion,
        proceso_origen:    r.proceso_origen as ProcesoOrigen,
        peso:  r.peso  != null ? Number(r.peso)  : null,
        alto:  r.alto  != null ? Number(r.alto)  : null,
        largo: r.largo != null ? Number(r.largo) : null,
        ancho: r.ancho != null ? Number(r.ancho) : null,
      })),
      total_bultos:   rows.length,
      total_unidades,
    });
  } catch (error: any) {
    console.error("❌ GET BULTOS ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener bultos" });
  }
};

// ─────────────────────────────────────────────
// POST /api/seguimiento/:idproduccion/bultos
// ─────────────────────────────────────────────
export const agregarBulto = async (req: Request, res: Response): Promise<Response> => {
  try {
    const idproduccion      = Number(req.params.idproduccion);
    const cantidad_unidades = Number(req.body.cantidad_unidades);
    const peso  = req.body.peso  != null ? Number(req.body.peso)  : null;
    const alto  = req.body.alto  != null ? Number(req.body.alto)  : null;
    const largo = req.body.largo != null ? Number(req.body.largo) : null;
    const ancho = req.body.ancho != null ? Number(req.body.ancho) : null;

    if (!cantidad_unidades || cantidad_unidades <= 0) {
      return res.status(400).json({ error: "La cantidad de unidades debe ser mayor a 0" });
    }

    const { rows: ordenRows } = await pool.query(
      `SELECT idestado_produccion_cat, proceso_actual, bultos_finalizado
       FROM orden_produccion WHERE idproduccion = $1`,
      [idproduccion]
    );

    if (ordenRows.length === 0) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    if (
      ordenRows[0].proceso_actual !== null ||
      Number(ordenRows[0].idestado_produccion_cat) !== 3
    ) {
      return res.status(400).json({
        error: "La orden debe estar completamente terminada para registrar bultos",
      });
    }

    if (Boolean(ordenRows[0].bultos_finalizado)) {
      return res.status(400).json({
        error: "Los bultos de esta orden ya fueron finalizados. No se pueden agregar más.",
      });
    }

    const fk = await resolverFkBulto(idproduccion);
    if (!fk) {
      return res.status(404).json({
        error: "No existe registro de bolseo ni asa_flexible para esta orden",
      });
    }

    const columnaFk = fk.tipo === "bolseo"
      ? "bolseo_idbolseo"
      : "asa_flexible_idasa_flexible";

    const { rows: inserted } = await pool.query(
      `INSERT INTO bultos (${columnaFk}, cantidad_unidades, peso, alto, largo, ancho)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING idbulto, cantidad_unidades, fecha_creacion, peso, alto, largo, ancho`,
      [fk.id, cantidad_unidades, peso, alto, largo, ancho]
    );

    const r = inserted[0];
    return res.status(201).json({
      idbulto:           Number(r.idbulto),
      cantidad_unidades: Number(r.cantidad_unidades),
      fecha_creacion:    r.fecha_creacion,
      proceso_origen:    fk.tipo,
      peso:  r.peso  != null ? Number(r.peso)  : null,
      alto:  r.alto  != null ? Number(r.alto)  : null,
      largo: r.largo != null ? Number(r.largo) : null,
      ancho: r.ancho != null ? Number(r.ancho) : null,
    });
  } catch (error: any) {
    console.error("❌ AGREGAR BULTO ERROR:", error.message);
    return res.status(500).json({ error: "Error al agregar bulto" });
  }
};

// ─────────────────────────────────────────────
// DELETE /api/seguimiento/:idproduccion/bultos/:idbulto
// ─────────────────────────────────────────────
export const eliminarBulto = async (req: Request, res: Response): Promise<Response> => {
  try {
    const idproduccion = Number(req.params.idproduccion);
    const idbulto      = Number(req.params.idbulto);

    const { rows: ordenRows } = await pool.query(
      `SELECT bultos_finalizado FROM orden_produccion WHERE idproduccion = $1`,
      [idproduccion]
    );

    if (ordenRows.length === 0) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    if (Boolean(ordenRows[0].bultos_finalizado)) {
      return res.status(400).json({
        error: "Los bultos ya fueron finalizados. No se pueden eliminar.",
      });
    }

    const { rows } = await pool.query(
      `SELECT b.idbulto FROM bultos b
       WHERE b.idbulto = $1
         AND (
           b.bolseo_idbolseo IN (
             SELECT idbolseo FROM bolseo
             WHERE orden_produccion_idproduccion = $2
           )
           OR
           b.asa_flexible_idasa_flexible IN (
             SELECT idasa_flexible FROM asa_flexible
             WHERE orden_produccion_idproduccion = $2
           )
         )`,
      [idbulto, idproduccion]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Bulto no encontrado" });
    }

    await pool.query(`DELETE FROM bultos WHERE idbulto = $1`, [idbulto]);

    return res.json({ message: "Bulto eliminado", idbulto });
  } catch (error: any) {
    console.error("❌ ELIMINAR BULTO ERROR:", error.message);
    return res.status(500).json({ error: "Error al eliminar bulto" });
  }
};

// ─────────────────────────────────────────────
// PATCH /api/seguimiento/:idproduccion/bultos/finalizar
// ─────────────────────────────────────────────
export const finalizarBultos = async (req: Request, res: Response): Promise<Response> => {
  try {
    const idproduccion = Number(req.params.idproduccion);

    const { rows: ordenRows } = await pool.query(
      `SELECT bultos_finalizado FROM orden_produccion WHERE idproduccion = $1`,
      [idproduccion]
    );

    if (ordenRows.length === 0) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    if (Boolean(ordenRows[0].bultos_finalizado)) {
      return res.status(400).json({ error: "Los bultos ya fueron finalizados previamente" });
    }

    const { rows: bultosRows } = await pool.query(
      `SELECT COUNT(*) AS total FROM bultos b
       WHERE
         b.bolseo_idbolseo IN (
           SELECT idbolseo FROM bolseo
           WHERE orden_produccion_idproduccion = $1
         )
         OR
         b.asa_flexible_idasa_flexible IN (
           SELECT idasa_flexible FROM asa_flexible
           WHERE orden_produccion_idproduccion = $1
         )`,
      [idproduccion]
    );

    if (Number(bultosRows[0].total) === 0) {
      return res.status(400).json({
        error: "Debes registrar al menos un bulto antes de finalizar",
      });
    }

    await pool.query(
      `UPDATE orden_produccion SET bultos_finalizado = TRUE WHERE idproduccion = $1`,
      [idproduccion]
    );

    return res.json({
      message:           "Bultos finalizados correctamente",
      idproduccion,
      bultos_finalizado: true,
    });
  } catch (error: any) {
    console.error("❌ FINALIZAR BULTOS ERROR:", error.message);
    return res.status(500).json({ error: "Error al finalizar bultos" });
  }
};

// ─────────────────────────────────────────────
// GET /api/seguimiento/:idproduccion/bultos/etiqueta
// ─────────────────────────────────────────────
export const getBultosEtiqueta = async (req: Request, res: Response): Promise<Response> => {
  try {
    const idproduccion = Number(req.params.idproduccion);

    const { rows: pedidoRows } = await pool.query(`
      SELECT
        s.no_pedido,
        s.fecha,
        op.no_produccion,
        op.idproduccion,
        op.fecha_entrega,
        op.bultos_finalizado,
        cli.razon_social  AS cliente,
        cli.empresa,
        cli.telefono,
        cli.celular,
        cli.correo,
        cli.impresion     AS cliente_impresion,
        dom.domicilio     AS calle,
        dom.numero,
        dom.colonia,
        dom.codigo_postal,
        dom.poblacion,
        dom.estado,
        tpp.material_plastico_producto AS nombre_producto,
        cfg.medida,
        mp.tipo_material               AS material,
        sd.cantidad,
        sd.kilogramos,
        sd.modo_cantidad
      FROM orden_produccion op
      JOIN solicitud_producto sp
          ON sp.idsolicitud_producto = op.idsolicitud_producto
      JOIN solicitud s
          ON s.idsolicitud = sp.solicitud_idsolicitud
      JOIN clientes cli
          ON cli.idclientes = s.clientes_idclientes
      LEFT JOIN domicilio dom
          ON dom.clientes_idclientes = cli.idclientes
      LEFT JOIN configuracion_plastico cfg
          ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN tipo_producto_plastico tpp
          ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN material_plastico mp
          ON mp.idmaterial_plastico = cfg.material_plastico_plastico_idmaterial_plastico
      LEFT JOIN solicitud_detalle sd
          ON sd.solicitud_producto_id = sp.idsolicitud_producto
          AND sd.aprobado = true
      WHERE op.idproduccion = $1
      LIMIT 1
    `, [idproduccion]);

    if (pedidoRows.length === 0) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    const pedido = pedidoRows[0];

    if (!pedido.bultos_finalizado) {
      return res.status(403).json({ error: "Los bultos aún no están finalizados" });
    }

    const { rows: bultosRows } = await pool.query(`
      SELECT
        b.idbulto,
        b.cantidad_unidades,
        b.fecha_creacion,
        b.peso,
        b.alto,
        b.largo,
        b.ancho,
        CASE
          WHEN b.asa_flexible_idasa_flexible IS NOT NULL THEN 'asa_flexible'
          ELSE 'bolseo'
        END AS proceso_origen
      FROM bultos b
      WHERE
        b.bolseo_idbolseo IN (
          SELECT idbolseo FROM bolseo WHERE orden_produccion_idproduccion = $1
        )
        OR
        b.asa_flexible_idasa_flexible IN (
          SELECT idasa_flexible FROM asa_flexible WHERE orden_produccion_idproduccion = $1
        )
      ORDER BY b.idbulto ASC
    `, [idproduccion]);

    return res.json({
      no_pedido:         pedido.no_pedido,
      no_produccion:     pedido.no_produccion,
      fecha:             pedido.fecha,
      fecha_entrega:     pedido.fecha_entrega ?? null,
      cliente:           pedido.cliente           || "",
      empresa:           pedido.empresa           || "",
      telefono:          pedido.telefono          || "",
      celular:           pedido.celular           || "",
      correo:            pedido.correo            || "",
      cliente_impresion: pedido.cliente_impresion || "",
      calle:         pedido.calle         || "",
      numero:        pedido.numero        || "",
      colonia:       pedido.colonia       || "",
      codigo_postal: pedido.codigo_postal || "",
      poblacion:     pedido.poblacion     || "",
      estado:        pedido.estado        || "",
      nombre_producto: pedido.nombre_producto || "",
      medida:          pedido.medida          || "",
      material:        pedido.material        || "",
      cantidad_total:  pedido.cantidad   ? Number(pedido.cantidad)   : null,
      kilogramos:      pedido.kilogramos ? Number(pedido.kilogramos) : null,
      modo_cantidad:   pedido.modo_cantidad   || "unidad",
      total_bultos: bultosRows.length,
      bultos: bultosRows.map((b: any) => ({
        idbulto:           Number(b.idbulto),
        cantidad_unidades: Number(b.cantidad_unidades),
        fecha_creacion:    b.fecha_creacion,
        proceso_origen:    b.proceso_origen as ProcesoOrigen,
        peso:  b.peso  != null ? Number(b.peso)  : null,
        alto:  b.alto  != null ? Number(b.alto)  : null,
        largo: b.largo != null ? Number(b.largo) : null,
        ancho: b.ancho != null ? Number(b.ancho) : null,
      })),
    });

  } catch (error: any) {
    console.error("❌ GET BULTOS ETIQUETA ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener datos de etiqueta" });
  }
};