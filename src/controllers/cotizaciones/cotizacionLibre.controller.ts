import { iniciarTx } from "../../middlewares/auditoria";
import { Request, Response } from "express";
import { pool } from "../../config/db";

// ═══════════════════════════════════════════════════════════════════
// Tipos de campo permitidos por renglón. Todos vienen del front ya
// resueltos como { id, texto } — nunca se valida cuál de los dos llegó,
// ambos son opcionales y ambos se guardan tal cual (sin FK, sin CHECK,
// igual que el resto del sistema).
// ═══════════════════════════════════════════════════════════════════
interface CampoLibre {
  id?: number | null;
  texto?: string | null;
}

interface ItemLibrePayload {
  tipo: "plastico" | "papel" | "especial";
  producto_id?: number | null;
  producto_texto?: string | null;
  medida_texto?: string | null;
  material?: CampoLibre;
  calibre?: CampoLibre;
  tintas_frente?: CampoLibre;
  tintas_dentro?: CampoLibre;
  pantones_texto?: string | null;
  pantones_dentro_texto?: string | null;
  caras?: CampoLibre;
  laminado?: CampoLibre;
  hs?: CampoLibre;
  alto_relieve?: { bool?: boolean | null; texto?: string | null };
  textura?: CampoLibre;
  uv?: { bool?: boolean | null; texto?: string | null };
  asa?: CampoLibre;
  color_asa?: CampoLibre;
  medida_troquel?: CampoLibre;
  cinta_seguridad?: CampoLibre;
  perforacion?: boolean;
  pigmentos_texto?: string | null;
  cantidades: [number | null, number | null, number | null];
  precios: [number | null, number | null, number | null];
  notas?: string | null;
}

interface CrearCotizacionLibrePayload {
  clienteId?: number | null;
  clienteTexto?: string | null;
  empresaTexto?: string | null;
  asesorId?: number | null;
  moneda?: "MXN" | "USD";
  sinRemision?: boolean;
  comentarios?: string | null;
  items: ItemLibrePayload[];
}

const limpiar = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const campo = (c?: CampoLibre) => ({
  id: c?.id != null ? Number(c.id) : null,
  texto: limpiar(c?.texto),
});

// Reutilizada por crear y por actualizar — un renglón se inserta igual en
// los dos casos (al actualizar, primero se borran los renglones viejos).
async function insertarItemLibre(
  client: any,
  cotizacionLibreId: number,
  orden: number,
  item: ItemLibrePayload
) {
  const material = campo(item.material);
  const calibre = campo(item.calibre);
  const tintasFrente = campo(item.tintas_frente);
  const tintasDentro = campo(item.tintas_dentro);
  const caras = campo(item.caras);
  const laminado = campo(item.laminado);
  const hs = campo(item.hs);
  const textura = campo(item.textura);
  const asa = campo(item.asa);
  const colorAsa = campo(item.color_asa);
  const medidaTroquel = campo(item.medida_troquel);
  const cintaSeguridad = campo(item.cinta_seguridad);

  await client.query(
    `INSERT INTO cotizacion_libre_item (
       cotizacion_libre_id, orden, tipo,
       producto_id, producto_texto, medida_texto,
       material_id, material_texto,
       calibre_id, calibre_texto,
       tintas_frente_id, tintas_frente_texto,
       tintas_dentro_id, tintas_dentro_texto,
       pantones_texto, pantones_dentro_texto,
       caras_id, caras_texto,
       laminado_id, laminado_texto,
       hs_id, hs_texto,
       alto_relieve_bool, alto_relieve_texto,
       textura_id, textura_texto,
       uv_bool, uv_texto,
       asa_id, asa_texto,
       color_asa_id, color_asa_texto,
       medida_troquel_id, medida_troquel_texto,
       cinta_seguridad_id, cinta_seguridad_texto,
       perforacion_bool, pigmentos_texto,
       cantidad_1, precio_1, cantidad_2, precio_2, cantidad_3, precio_3,
       notas
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
       $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,
       $35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45
     )`,
    [
      cotizacionLibreId, orden, item.tipo,
      item.producto_id ?? null, limpiar(item.producto_texto), limpiar(item.medida_texto),
      material.id, material.texto,
      calibre.id, calibre.texto,
      tintasFrente.id, tintasFrente.texto,
      tintasDentro.id, tintasDentro.texto,
      limpiar(item.pantones_texto), limpiar(item.pantones_dentro_texto),
      caras.id, caras.texto,
      laminado.id, laminado.texto,
      hs.id, hs.texto,
      item.alto_relieve?.bool ?? null, limpiar(item.alto_relieve?.texto),
      textura.id, textura.texto,
      item.uv?.bool ?? null, limpiar(item.uv?.texto),
      asa.id, asa.texto,
      colorAsa.id, colorAsa.texto,
      medidaTroquel.id, medidaTroquel.texto,
      cintaSeguridad.id, cintaSeguridad.texto,
      item.perforacion === true, limpiar(item.pigmentos_texto),
      num(item.cantidades?.[0]), num(item.precios?.[0]),
      num(item.cantidades?.[1]), num(item.precios?.[1]),
      num(item.cantidades?.[2]), num(item.precios?.[2]),
      limpiar(item.notas),
    ]
  );
}

// ═══════════════════════════════════════════════════════════════════
// POST /cotizaciones-libres
// ═══════════════════════════════════════════════════════════════════
export const crearCotizacionLibre = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const body = req.body as CrearCotizacionLibrePayload;

    if (!body.items || body.items.length === 0) {
      return res.status(400).json({ error: "Se requiere al menos un producto" });
    }
    for (const it of body.items) {
      if (!it.tipo || !["plastico", "papel", "especial"].includes(it.tipo)) {
        return res.status(400).json({ error: `El renglón "${it.producto_texto ?? "(sin nombre)"}" no tiene un tipo válido` });
      }
    }

    await iniciarTx(req, client);

    // Mismo folio y misma fuente atómica que la cotización normal —
    // ver generar_folio_cotizacion() en la base de datos.
    const { rows: folioRows } = await client.query(
      `SELECT public.generar_folio_cotizacion() AS folio`
    );
    const folio = String(folioRows[0].folio);

    const moneda = body.moneda === "USD" ? "USD" : "MXN";

    const { rows: cabRows } = await client.query(
      `INSERT INTO cotizacion_libre (
         folio, cliente_id, cliente_texto, empresa_texto,
         asesor_id, moneda, sin_remision, comentarios
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, folio`,
      [
        folio,
        body.clienteId ?? null,
        limpiar(body.clienteTexto),
        limpiar(body.empresaTexto),
        body.asesorId ?? null,
        moneda,
        body.sinRemision === true,
        limpiar(body.comentarios),
      ]
    );
    const cotizacionLibreId = cabRows[0].id;

    let orden = 0;
    for (const item of body.items) {
      const tieneAlgunPrecio = [0, 1, 2].some(
        (i) => num(item.cantidades?.[i]) && num(item.precios?.[i])
      );
      if (!tieneAlgunPrecio) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `El renglón "${item.producto_texto ?? "(sin nombre)"}" no tiene ninguna cantidad/precio válidos`,
        });
      }

      const material = campo(item.material);
      const calibre = campo(item.calibre);
      const tintasFrente = campo(item.tintas_frente);
      const tintasDentro = campo(item.tintas_dentro);
      const caras = campo(item.caras);
      const laminado = campo(item.laminado);
      const hs = campo(item.hs);
      const textura = campo(item.textura);
      const asa = campo(item.asa);
      const colorAsa = campo(item.color_asa);
      const medidaTroquel = campo(item.medida_troquel);
      const cintaSeguridad = campo(item.cinta_seguridad);

      await insertarItemLibre(client, cotizacionLibreId, orden++, item);
    }

    await client.query("COMMIT");
    return res.status(201).json({ message: "Cotización libre creada", folio, id: cotizacionLibreId });
  } catch (error: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("❌ Error al crear cotización libre:", error.message);
    return res.status(500).json({ error: "Error al crear la cotización libre" });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════
// GET /cotizaciones-libres
// Shape mínimo, pensado para mezclarse en el listado junto con
// getCotizaciones() del lado del frontend (Cotizar.tsx).
// ═══════════════════════════════════════════════════════════════════
export const getCotizacionesLibres = async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        cl.id,
        cl.folio,
        cl.fecha,
        cl.moneda,
        cl.estatus,
        COALESCE(cli.atencion, cl.cliente_texto)  AS cliente_nombre,
        COALESCE(cli.empresa, cl.empresa_texto)   AS cliente_empresa,
        (
          SELECT array_agg(DISTINCT cli_item.tipo)
          FROM cotizacion_libre_item cli_item
          WHERE cli_item.cotizacion_libre_id = cl.id
        ) AS tipos,
        (
          SELECT COUNT(*)
          FROM cotizacion_libre_item cli_item
          WHERE cli_item.cotizacion_libre_id = cl.id
        ) AS total_productos,
        (
          SELECT COALESCE(SUM(
            COALESCE(cli_item.cantidad_1 * cli_item.precio_1, 0) +
            COALESCE(cli_item.cantidad_2 * cli_item.precio_2, 0) +
            COALESCE(cli_item.cantidad_3 * cli_item.precio_3, 0)
          ), 0)
          FROM cotizacion_libre_item cli_item
          WHERE cli_item.cotizacion_libre_id = cl.id
        ) AS total_estimado
      FROM cotizacion_libre cl
      LEFT JOIN clientes cli ON cli.idclientes = cl.cliente_id
      ORDER BY cl.created_at DESC
    `);

    const resultado = rows.map((r) => ({
      folio: r.folio,
      es_libre: true,
      tipos: r.tipos ?? [],
      total_productos: Number(r.total_productos),
      fecha: r.fecha,
      moneda: r.moneda,
      estatus: r.estatus,
      cliente: r.cliente_nombre,
      empresa: r.cliente_empresa,
      total: Number(r.total_estimado),
    }));

    return res.json(resultado);
  } catch (error: any) {
    console.error("❌ Error al listar cotizaciones libres:", error.message);
    return res.status(500).json({ error: "Error al obtener cotizaciones libres" });
  }
};

// ═══════════════════════════════════════════════════════════════════
// GET /cotizaciones-libres/:folio
// Detalle completo — usado para el PDF y para reabrir/consultar.
// ═══════════════════════════════════════════════════════════════════
export const getCotizacionLibrePorFolio = async (req: Request, res: Response) => {
  try {
    const { folio } = req.params;

    const { rows: cabRows } = await pool.query(
      `SELECT cl.*, cli.atencion AS cliente_nombre, cli.empresa AS cliente_empresa_real,
              u.nombre AS asesor_nombre, u.apellido AS asesor_apellido
       FROM cotizacion_libre cl
       LEFT JOIN clientes cli ON cli.idclientes = cl.cliente_id
       LEFT JOIN usuarios u ON u.idusuario = cl.asesor_id
       WHERE cl.folio = $1`,
      [folio]
    );

    if (cabRows.length === 0) {
      return res.status(404).json({ error: "Cotización libre no encontrada" });
    }

    const { rows: itemRows } = await pool.query(
      `SELECT * FROM cotizacion_libre_item WHERE cotizacion_libre_id = $1 ORDER BY orden ASC`,
      [cabRows[0].id]
    );

    return res.json({ ...cabRows[0], items: itemRows });
  } catch (error: any) {
    console.error("❌ Error al obtener cotización libre:", error.message);
    return res.status(500).json({ error: "Error al obtener la cotización libre" });
  }
};

// ═══════════════════════════════════════════════════════════════════
// PUT /cotizaciones-libres/:folio
// Reemplaza cabecera + renglones. Más simple que un diff fino: se borran
// los renglones viejos y se insertan los nuevos dentro de la misma
// transacción — el id y el folio del documento no cambian.
// ═══════════════════════════════════════════════════════════════════
export const actualizarCotizacionLibre = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { folio } = req.params;
    const body = req.body as CrearCotizacionLibrePayload;

    if (!body.items || body.items.length === 0) {
      return res.status(400).json({ error: "Se requiere al menos un producto" });
    }
    for (const it of body.items) {
      if (!it.tipo || !["plastico", "papel", "especial"].includes(it.tipo)) {
        return res.status(400).json({ error: `El renglón "${it.producto_texto ?? "(sin nombre)"}" no tiene un tipo válido` });
      }
    }

    await iniciarTx(req, client);

    const { rows: existente } = await client.query(
      `SELECT id FROM cotizacion_libre WHERE folio = $1`,
      [folio]
    );
    if (existente.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Cotización libre no encontrada" });
    }
    const cotizacionLibreId = existente[0].id;

    const moneda = body.moneda === "USD" ? "USD" : "MXN";
    await client.query(
      `UPDATE cotizacion_libre SET
         cliente_id = $1, cliente_texto = $2, empresa_texto = $3,
         asesor_id = $4, moneda = $5, sin_remision = $6, comentarios = $7,
         updated_at = now()
       WHERE id = $8`,
      [
        body.clienteId ?? null,
        limpiar(body.clienteTexto),
        limpiar(body.empresaTexto),
        body.asesorId ?? null,
        moneda,
        body.sinRemision === true,
        limpiar(body.comentarios),
        cotizacionLibreId,
      ]
    );

    await client.query(`DELETE FROM cotizacion_libre_item WHERE cotizacion_libre_id = $1`, [cotizacionLibreId]);

    let orden = 0;
    for (const item of body.items) {
      const tieneAlgunPrecio = [0, 1, 2].some(
        (i) => num(item.cantidades?.[i]) && num(item.precios?.[i])
      );
      if (!tieneAlgunPrecio) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `El renglón "${item.producto_texto ?? "(sin nombre)"}" no tiene ninguna cantidad/precio válidos`,
        });
      }
      await insertarItemLibre(client, cotizacionLibreId, orden++, item);
    }

    await client.query("COMMIT");
    return res.json({ message: "Cotización libre actualizada", folio });
  } catch (error: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("❌ Error al actualizar cotización libre:", error.message);
    return res.status(500).json({ error: "Error al actualizar la cotización libre" });
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════
// DELETE /cotizaciones-libres/:folio
// Borra la cabecera — los renglones se van solos por el ON DELETE CASCADE
// de cotizacion_libre_item.cotizacion_libre_id.
// ═══════════════════════════════════════════════════════════════════
export const eliminarCotizacionLibre = async (req: Request, res: Response) => {
  try {
    const { folio } = req.params;
    const { rowCount } = await pool.query(`DELETE FROM cotizacion_libre WHERE folio = $1`, [folio]);
    if (rowCount === 0) {
      return res.status(404).json({ error: "Cotización libre no encontrada" });
    }
    return res.json({ message: "Cotización libre eliminada" });
  } catch (error: any) {
    console.error("❌ Error al eliminar cotización libre:", error.message);
    return res.status(500).json({ error: "Error al eliminar la cotización libre" });
  }
};