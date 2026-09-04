import { iniciarTx } from "../../middlewares/auditoria";
import { Request, Response } from "express";
import { pool } from "../../config/db";
import { emitirOrdenesProduccion } from "../../services/produccion/emitirOrdenProduccionEspecial.service";
import { AuthRequest } from "../../middlewares/auth.middleware";

const ESTADO = {
  PENDIENTE:  1,
  EN_PROCESO: 2,
  APROBADO:   3,
} as const;

// ════════════════════════════════════════════════════════════════════════
// HELPERS — PLÁSTICO (sin cambios respecto al original)
// ════════════════════════════════════════════════════════════════════════

async function generarNoProduccion(client: any): Promise<string> {
  const anio = new Date().getFullYear().toString().slice(-2);
  const prefijo = `OP${anio}`;

  const { rows } = await client.query(
    `SELECT MAX(CAST(SUBSTRING(no_produccion FROM 5) AS INTEGER)) AS ultimo
     FROM orden_produccion
     WHERE no_produccion LIKE $1`,
    [`${prefijo}%`]
  );

  const siguiente = (rows[0].ultimo ?? 0) + 1;
  return `${prefijo}${String(siguiente).padStart(3, "0")}`;
}

async function anticipoPagado(client: any, solicitudId: number): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT anticipo, abono, estado_administrativo_cat_idestado_administrativo_cat AS estado_id
     FROM ventas WHERE solicitud_idsolicitud = $1`,
    [solicitudId]
  );
  if (rows.length === 0) return false;
  const abono    = Number(rows[0].abono);
  const anticipo = Number(rows[0].anticipo);
  const estadoId = Number(rows[0].estado_id);
  return abono >= anticipo || estadoId === 2 || estadoId === 6;
}

async function obtenerMerma(client: any, kilos: number, tintasId: number): Promise<number> {
  if (!kilos || kilos <= 0) return 0;
  try {
    const { rows } = await client.query(`
      SELECT tp.merma_porcentaje
      FROM tarifas_produccion tp
      INNER JOIN kilogramos k ON k.idkilogramos = tp.kilogramos_idkilogramos
      WHERE tp.tintas_idtintas = $1
        AND $2 >= k.kg_min
        AND ($2 <= k.kg_max OR k.kg_max IS NULL)
      LIMIT 1
    `, [tintasId, kilos]);
    if (rows.length === 0) {
      console.warn(`⚠️ No se encontró tarifa de merma para ${kilos} kg / tintas_id=${tintasId} — se usará 0%`);
      return 0;
    }
    const merma = Number(rows[0].merma_porcentaje);
    console.log(`📊 Merma para ${kilos} kg + tintas_id=${tintasId} → ${merma}%`);
    return merma;
  } catch (err: any) {
    console.warn("⚠️ obtenerMerma error:", err.message);
    return 0;
  }
}

function calcularDatosExtrusion(p: {
  alto: number; ancho: number;
  fuelle_fondo: number; fuelle_lat_iz: number; fuelle_lat_de: number;
  refuerzo: number; cantidad: number;
}): { repeticion_extrusion: number; repeticion_metro: number; metros: number; ancho_bobina: number } {
  let repeticion_extrusion: number;
  let ancho_bobina: number;

  if (p.fuelle_fondo > 0) {
    repeticion_extrusion = p.ancho;
    ancho_bobina         = p.alto + p.fuelle_fondo + p.refuerzo;
  } else {
    repeticion_extrusion = p.alto;
    ancho_bobina         = p.ancho + p.fuelle_lat_iz + p.fuelle_lat_de + p.refuerzo;
  }

  const repeticion_metro = repeticion_extrusion > 0
    ? parseFloat((100 / repeticion_extrusion).toFixed(4)) : 0;
  const metros = parseFloat((p.cantidad * (repeticion_extrusion / 100)).toFixed(1));

  return {
    repeticion_extrusion: parseFloat(repeticion_extrusion.toFixed(2)),
    repeticion_metro,
    metros,
    ancho_bobina: parseFloat(ancho_bobina.toFixed(2)),
  };
}

async function buscarRepeticionRodillos(
  client: any, valor: number
): Promise<{ kidder: string | null; sicosa: string | null }> {
  if (!valor || valor <= 0) return { kidder: null, sicosa: null };
  try {
    const { rows: kidderRows } = await client.query(`
      SELECT sin_grabado, con_grabado_1rep, con_grabado_2rep, con_grabado_3rep,
        LEAST(ABS(con_grabado_1rep-$1),ABS(con_grabado_2rep-$1),ABS(con_grabado_3rep-$1)) AS distancia_min
      FROM rodillos_kidder ORDER BY distancia_min ASC LIMIT 1
    `, [valor]);

    const { rows: sicosaRows } = await client.query(`
      SELECT sin_grabado, con_grabado_1rep, con_grabado_2rep, con_grabado_3rep,
             con_grabado_4rep, con_grabado_5rep,
        LEAST(ABS(con_grabado_1rep-$1),ABS(con_grabado_2rep-$1),ABS(con_grabado_3rep-$1),
              ABS(con_grabado_4rep-$1),ABS(con_grabado_5rep-$1)) AS distancia_min
      FROM rodillos_sicosa ORDER BY distancia_min ASC LIMIT 1
    `, [valor]);

    const formatearRodillo = (row: any, reps: { label: string; col: string }[]): string | null => {
      if (!row) return null;
      const candidatos = reps
        .map(r => ({ label: r.label, valor: parseFloat(row[r.col]) || 0 }))
        .filter(r => r.valor > 0);
      if (candidatos.length === 0) return null;
      const mejor = candidatos.reduce((prev, curr) =>
        Math.abs(curr.valor - valor) < Math.abs(prev.valor - valor) ? curr : prev
      );
      const sinGrab  = parseFloat(row.sin_grabado).toFixed(2);
      const esExacto = Math.abs(mejor.valor - valor) < 0.001;
      return `SG=${sinGrab} | ${esExacto ? "" : "~"}${mejor.valor.toFixed(2)} (${mejor.label})`;
    };

    const kidder = formatearRodillo(kidderRows[0], [
      { label: "1 rep", col: "con_grabado_1rep" },
      { label: "2 rep", col: "con_grabado_2rep" },
      { label: "3 rep", col: "con_grabado_3rep" },
    ]);
    const sicosa = formatearRodillo(sicosaRows[0], [
      { label: "1 rep", col: "con_grabado_1rep" },
      { label: "2 rep", col: "con_grabado_2rep" },
      { label: "3 rep", col: "con_grabado_3rep" },
      { label: "4 rep", col: "con_grabado_4rep" },
      { label: "5 rep", col: "con_grabado_5rep" },
    ]);
    return { kidder, sicosa };
  } catch (err: any) {
    console.warn("⚠️ buscarRepeticionRodillos error:", err.message);
    return { kidder: null, sicosa: null };
  }
}

// Kilos equivalentes de una cantidad en piezas, usando el factor bolsas/kg del
// producto. Es la misma fórmula que aplica el front al capturar el pedido; aquí
// sirve de respaldo cuando solicitud_detalle.kilogramos llegó vacío.
function calcularKilosDesdePorKilo(cantidad: number, porKilo: unknown): number | null {
  const pk = Number(porKilo);
  if (!cantidad || cantidad <= 0 || !Number.isFinite(pk) || pk <= 0) return null;
  return parseFloat((cantidad / pk).toFixed(4));
}

async function getMedidasParaOrden(client: any, idsolicitudProducto: number) {
  const { rows } = await client.query(`
    SELECT
      COALESCE(cfg.altura,       0) AS alto,
      COALESCE(cfg.ancho,        0) AS ancho,
      COALESCE(cfg.fuelle_fondo, 0) AS fuelle_fondo,
      COALESCE(cfg.fuelle_latIz, 0) AS fuelle_lat_iz,
      COALESCE(cfg.fuelle_latDe, 0) AS fuelle_lat_de,
      COALESCE(cfg.refuerzo,     0) AS refuerzo,
      COALESCE(sd.cantidad,      0) AS cantidad,
      sd.kilogramos,
      sd.modo_cantidad,
      cfg.por_kilo,
      sp.tintas_idtintas
    FROM solicitud_producto sp
    JOIN configuracion_plastico cfg
        ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
    LEFT JOIN LATERAL (
      SELECT
        SUM(sd0.cantidad) AS cantidad,
        SUM(sd0.kilogramos) AS kilogramos,
        CASE
          WHEN COUNT(*) > 0
           AND BOOL_AND(COALESCE(sd0.modo_cantidad, 'unidad') = 'kilo')
          THEN 'kilo'
          ELSE 'unidad'
        END AS modo_cantidad
      FROM solicitud_detalle sd0
      WHERE sd0.solicitud_producto_id = sp.idsolicitud_producto
        AND sd0.aprobado = true
    ) sd ON true
    WHERE sp.idsolicitud_producto = $1
    LIMIT 1
  `, [idsolicitudProducto]);
  return rows[0] ?? null;
}

export async function prepararDatosOrden(client: any, idsolicitudProducto: number) {
  const medidas = await getMedidasParaOrden(client, idsolicitudProducto);

  if (!medidas) {
    return {
      repeticion_extrusion: null, repeticion_metro: null,
      metros: null, metros_merma: null, ancho_bobina: null,
      kilos: null, kilos_merma: null, pzas: null, pzas_merma: null,
      repeticion_kidder: null, repeticion_sicosa: null,
    };
  }

  const cantidad = Number(medidas.cantidad);
  // Fallback a cantidad / por_kilo: solicitud_detalle.kilogramos puede venir en
  // NULL (pedidos creados sin porKilo en el payload, o editados por una versión
  // del front que lo mandaba vacío). Sin esto la orden se congela con kilos NULL
  // y la celda "Kilos" del PDF sale en blanco aunque el producto sí tenga
  // por_kilo registrado en configuracion_plastico.
  const kilos    = medidas.kilogramos
    ? parseFloat(Number(medidas.kilogramos).toFixed(4))
    : calcularKilosDesdePorKilo(cantidad, medidas.por_kilo);
  const tintasId = Number(medidas.tintas_idtintas) || 1;

  const mermaPct    = kilos ? await obtenerMerma(client, kilos, tintasId) : 0;
  const factorMerma = 1 + mermaPct / 100;

  const kilos_merma = kilos ? parseFloat((kilos * factorMerma).toFixed(2)) : null;
  const pzas        = cantidad > 0 ? cantidad : null;
  const pzas_merma  = pzas ? Math.round(pzas * factorMerma) : null;

  console.log(`🧮 Merma [${idsolicitudProducto}] tintas_id=${tintasId} → ${mermaPct}% | kilos: ${kilos} → ${kilos_merma} | pzas: ${pzas} → ${pzas_merma}`);

  if (cantidad <= 0) {
    return {
      repeticion_extrusion: null, repeticion_metro: null,
      metros: null, metros_merma: null, ancho_bobina: null,
      kilos, kilos_merma, pzas, pzas_merma,
      repeticion_kidder: null, repeticion_sicosa: null,
    };
  }

  const ext = calcularDatosExtrusion({
    alto:          Number(medidas.alto),
    ancho:         Number(medidas.ancho),
    fuelle_fondo:  Number(medidas.fuelle_fondo),
    fuelle_lat_iz: Number(medidas.fuelle_lat_iz),
    fuelle_lat_de: Number(medidas.fuelle_lat_de),
    refuerzo:      Number(medidas.refuerzo),
    cantidad,
  });

  const metros_merma = parseFloat((ext.metros * factorMerma).toFixed(1));

  console.log(`📐 Orden [${idsolicitudProducto}] → rep=${ext.repeticion_extrusion} | metros=${ext.metros} | metros_merma=${metros_merma} | bobina=${ext.ancho_bobina}`);

  const rodillos = await buscarRepeticionRodillos(client, ext.repeticion_extrusion);
  console.log(`🎡 Rodillos → KIDDER: ${rodillos.kidder} | SICOSA: ${rodillos.sicosa}`);

  return {
    repeticion_extrusion: ext.repeticion_extrusion,
    repeticion_metro:     ext.repeticion_metro,
    metros:               ext.metros,
    metros_merma,
    ancho_bobina:         ext.ancho_bobina,
    kilos, kilos_merma, pzas, pzas_merma,
    repeticion_kidder:    rodillos.kidder,
    repeticion_sicosa:    rodillos.sicosa,
  };
}

// ════════════════════════════════════════════════════════════════════════
// HELPER NUEVO — PAPEL
// ════════════════════════════════════════════════════════════════════════
// Papel no tiene proceso de extrusión/merma propio todavía (eso se define
// en la etapa de Seguimiento/Producción de papel). Por ahora, al aprobar
// el diseño de un producto de papel, solo se necesita:
//   1) Saber si tiene_material === 'papel' para NO intentar leer
//      configuracion_plastico (que no existe para papel).
//   2) Generar la orden_produccion con los campos de extrusión en null,
//      usando como "cantidad" la ya aprobada en solicitud_detalle
//      (el precio de papel ya viene fijo desde la cotización/pedido,
//      sin recálculo de producción real).
// ════════════════════════════════════════════════════════════════════════

async function esProductoPapel(client: any, idsolicitudProducto: number): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT tipo_material FROM solicitud_producto WHERE idsolicitud_producto = $1`,
    [idsolicitudProducto]
  );
  // Los especiales (tipo_material="especial") corren por la misma
  // preparación de datos que papel normal (Jose, 2026-09-03).
  return rows[0]?.tipo_material === "papel" || rows[0]?.tipo_material === "especial";
}

async function prepararDatosOrdenPapel(client: any, idsolicitudProducto: number) {
  // Para papel, "cantidad" / "kilogramos" aprobados ya están fijos en
  // solicitud_detalle (no hay merma ni extrusión que calcular). Se deja
  // constancia de la cantidad aprobada en kilos/pzas según corresponda,
  // y todos los campos exclusivos de plástico quedan en null.
  const { rows } = await client.query(`
    SELECT
      COALESCE(sd.cantidad, 0) AS cantidad,
      sd.kilogramos,
      sd.modo_cantidad
    FROM solicitud_detalle sd
    WHERE sd.solicitud_producto_id = $1
      AND sd.aprobado = true
    LIMIT 1
  `, [idsolicitudProducto]);

  const detalle = rows[0] ?? null;

  const modoKilo = detalle?.modo_cantidad === "kilo";
  const cantidad = detalle ? Number(detalle.cantidad) : null;
  const kilos    = modoKilo && detalle?.kilogramos != null
    ? Number(Number(detalle.kilogramos).toFixed(4))
    : null;

  return {
    // Campos exclusivos de extrusión de plástico — no aplican a papel
    repeticion_extrusion: null,
    repeticion_metro:     null,
    metros:               null,
    metros_merma:         null,
    ancho_bobina:         null,
    repeticion_kidder:    null,
    repeticion_sicosa:    null,
    // Cantidad/kilos aprobados — sin merma, ya que el precio de papel
    // está fijo desde la cotización/pedido
    kilos,
    kilos_merma: null,
    pzas:        cantidad,
    pzas_merma:  null,
  };
}

// ════════════════════════════════════════════════════════════════════════
// OBTENER DISEÑO POR no_pedido
// ════════════════════════════════════════════════════════════════════════
export const getDisenoByPedido = async (req: Request, res: Response) => {
  try {
    const { noPedido } = req.params;

    const { rows: solicitudRows } = await pool.query(
      `SELECT
        s.idsolicitud, s.no_pedido, s.no_cotizacion,
        d.iddiseno, d.fecha_aprobacion_general,
        COALESCE(v.anticipo, 0) AS anticipo,
        COALESCE(v.abono, 0)    AS abono,
        od.idorden_diseno,
        od.no_orden_diseno,
        od.estado               AS orden_diseno_estado
       FROM solicitud s
       JOIN diseno d ON d.solicitud_idsolicitud = s.idsolicitud
       LEFT JOIN ventas v ON v.solicitud_idsolicitud = s.idsolicitud
       LEFT JOIN orden_diseno od ON od.solicitud_producto_id = s.idsolicitud
       WHERE s.no_pedido = $1`,
      [noPedido]
    );

    if (solicitudRows.length === 0)
      return res.status(404).json({ error: "Pedido no encontrado" });

    const solicitud        = solicitudRows[0];
    const solicitudId      = solicitud.idsolicitud;
    const disenoId         = solicitud.iddiseno;
    const anticupoCubierto = Number(solicitud.abono) >= Number(solicitud.anticipo);

    // ── Query de productos: AGREGAMOS columnas de papel con LEFT JOIN ──
    // (no quitamos nada de plástico; sp.tipo_material decide qué nombre usar)
    const { rows: productos } = await pool.query(`
      SELECT
        dp.iddiseno_producto,
        dp.diseno_iddiseno,
        dp.solicitud_producto_idsolicitud_producto AS idsolicitud_producto,
        dp.observaciones,
        dp.fecha,
        dp.fecha_aprobacion,
        dp.estado_administrativo_cat_idestado_administrativo_cat AS estado_id,
        est.nombre AS estado_nombre,

        sp.tipo_material,
        sp.descripcion,

        -- Plástico
        cfg.medida  AS cfg_medida,
        tpp.material_plastico_producto AS tipo_producto_nombre,
        mp.tipo_material               AS material_nombre,

        -- Papel
        sp.grupo_papel_descripcion     AS papel_grupo_descripcion,
        tpp2.nombre                    AS papel_tipo_producto,
        pp2.medida                     AS papel_medida,

        sd.cantidad,
        sd.kilogramos,
        sd.modo_cantidad,
        sd.precio_total,
        op.no_produccion,
        op.idproduccion,
        op.kilos,
        op.kilos_merma,
        op.pzas,
        op.pzas_merma,
        op.metros,
        op.metros_merma,
        od.idorden_diseno,
        od.no_orden_diseno,
        od.estado               AS orden_diseno_estado
      FROM diseno_producto dp
      JOIN estado_administrativo_cat est
          ON est.idestado_administrativo_cat = dp.estado_administrativo_cat_idestado_administrativo_cat
      JOIN solicitud_producto sp
          ON sp.idsolicitud_producto = dp.solicitud_producto_idsolicitud_producto

      -- ── Plástico (no existe la fila si el producto es de papel) ──
      LEFT JOIN configuracion_plastico cfg
          ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN tipo_producto_plastico tpp
          ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN material_plastico mp
          ON mp.idmaterial_plastico = cfg.material_plastico_plastico_idmaterial_plastico

      -- ── Papel (no existe la fila si el producto es de plástico) ──
      LEFT JOIN producto_papel pp2
          ON pp2.idproducto_papel = sp.producto_papel_idproducto_papel
      LEFT JOIN cat_tipo_producto_papel tpp2
          ON tpp2.idcat_tipo_producto_papel = pp2.idcat_tipo_producto_papel

      LEFT JOIN solicitud_detalle sd
          ON sd.solicitud_producto_id = sp.idsolicitud_producto
          AND sd.aprobado = true
      LEFT JOIN orden_produccion op
          ON op.idsolicitud_producto = dp.solicitud_producto_idsolicitud_producto
      LEFT JOIN orden_diseno od
          ON od.solicitud_producto_id = dp.solicitud_producto_idsolicitud_producto
      WHERE dp.diseno_iddiseno = $1
      ORDER BY dp.iddiseno_producto
    `, [disenoId]);

    const productosFormateados = productos.map((p: any) => {
      // Los especiales usan los mismos campos papel_* que el papel normal.
      const esPapel = p.tipo_material === "papel" || p.tipo_material === "especial";

      const nombre = esPapel
        ? ([p.papel_tipo_producto, p.papel_medida].filter(Boolean).join(" ") ||
           `Papel #${p.idsolicitud_producto}`)
        : ([p.tipo_producto_nombre, p.cfg_medida, p.material_nombre].filter(Boolean).join(" ") ||
           `Producto #${p.idsolicitud_producto}`);

      return {
        iddiseno_producto:    p.iddiseno_producto,
        diseno_iddiseno:      p.diseno_iddiseno,
        idsolicitud_producto: p.idsolicitud_producto,
        tipo_material:        p.tipo_material ?? "plastico",
        nombre,
        estado_id:        p.estado_id,
        estado:           p.estado_nombre,
        observaciones:    p.observaciones,
        fecha:            p.fecha,
        fecha_aprobacion: p.fecha_aprobacion ?? null,
        descripcion:      p.descripcion ?? null,
        cantidad:         p.cantidad    ? Number(p.cantidad)    : null,
        kilogramos:       p.kilogramos  ? Number(p.kilogramos)  : null,
        modo_cantidad:    p.modo_cantidad || "unidad",
        precio_total:     p.precio_total ? Number(p.precio_total) : null,
        no_produccion:    p.no_produccion ?? null,
        idproduccion:     p.idproduccion  ?? null,
        orden_generada:   !!p.no_produccion,
        kilos:        p.kilos        != null ? Number(p.kilos)        : null,
        kilos_merma:  p.kilos_merma  != null ? Number(p.kilos_merma)  : null,
        pzas:         p.pzas         != null ? Number(p.pzas)         : null,
        pzas_merma:   p.pzas_merma   != null ? Number(p.pzas_merma)   : null,
        metros:       p.metros       != null ? Number(p.metros)       : null,
        metros_merma: p.metros_merma != null ? Number(p.metros_merma) : null,
        idorden_diseno:      p.idorden_diseno      ?? null,
        no_orden_diseno:     p.no_orden_diseno     ?? null,
        orden_diseno_estado: p.orden_diseno_estado ?? null,
      };
    });

    const total     = productosFormateados.length;
    const aprobados = productosFormateados.filter((p: any) => p.estado_id === ESTADO.APROBADO).length;
    const enProceso = productosFormateados.filter((p: any) => p.estado_id === ESTADO.EN_PROCESO).length;
    const conOrden  = productosFormateados.filter((p: any) => p.orden_generada).length;

    const estadoGlobal =
      aprobados === total && total > 0 ? ESTADO.APROBADO  :
      aprobados > 0 || enProceso > 0  ? ESTADO.EN_PROCESO :
                                         ESTADO.PENDIENTE;

    return res.json({
      no_pedido:                Number(noPedido),
      no_cotizacion:            solicitud.no_cotizacion ?? null,
      idsolicitud:             solicitudId,
      diseno_id:                disenoId,
      fecha_aprobacion_general: solicitud.fecha_aprobacion_general ?? null,
      anticipo_cubierto:        anticupoCubierto,
      anticipo:                 Number(solicitud.anticipo),
      abono:                    Number(solicitud.abono),
      no_orden_diseno:          solicitud.no_orden_diseno     ?? null,
      idorden_diseno:           solicitud.idorden_diseno       ?? null,
      orden_diseno_estado:      solicitud.orden_diseno_estado  ?? null,
      estado_id:                estadoGlobal,
      total_productos:          total,
      aprobados,
      pendientes:               total - aprobados - enProceso,
      en_proceso:               enProceso,
      con_orden:                conOrden,
      diseno_completado:        estadoGlobal === ESTADO.APROBADO,
      productos:                productosFormateados,
    });

  } catch (error: any) {
    console.error("❌ GET DISEÑO BY PEDIDO ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener diseño" });
  }
};

// ════════════════════════════════════════════════════════════════════════
// ACTUALIZAR ESTADO DE UN PRODUCTO EN DISEÑO
// ════════════════════════════════════════════════════════════════════════
export const actualizarEstadoProducto = async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const { id }                      = req.params;
    const { estadoId, observaciones } = req.body;
    const usuarioId                   = req.user?.id ?? null;

    if (!estadoId) return res.status(400).json({ error: "Se requiere estadoId" });

    const estadoNum = Number(estadoId);
    if (![ESTADO.PENDIENTE, ESTADO.EN_PROCESO, ESTADO.APROBADO].includes(estadoNum as any))
      return res.status(400).json({ error: "Estado inválido. Use: 1, 2 o 3" });

    await iniciarTx(req, client);

    const { rowCount } = await client.query(
      `UPDATE diseno_producto
       SET estado_administrativo_cat_idestado_administrativo_cat = $1,
           observaciones = $2,
           fecha         = NOW()
       WHERE iddiseno_producto = $3`,
      [estadoNum, observaciones || null, id]
    );

    if (rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Producto de diseño no encontrado" });
    }

    if (estadoNum === ESTADO.APROBADO) {
      await client.query(
        `UPDATE diseno_producto SET fecha_aprobacion = NOW() WHERE iddiseno_producto = $1`, [id]
      );
    } else {
      await client.query(
        `UPDATE diseno_producto SET fecha_aprobacion = NULL WHERE iddiseno_producto = $1`, [id]
      );
    }

    const { rows: dpRows } = await client.query(
      `SELECT dp.diseno_iddiseno,
              dp.solicitud_producto_idsolicitud_producto AS idsolicitud_producto,
              d.solicitud_idsolicitud
       FROM diseno_producto dp
       JOIN diseno d ON d.iddiseno = dp.diseno_iddiseno
       WHERE dp.iddiseno_producto = $1`,
      [id]
    );

    const disenoId            = dpRows[0].diseno_iddiseno;
    const idsolicitudProducto = dpRows[0].idsolicitud_producto;
    const solicitudId         = dpRows[0].solicitud_idsolicitud;

    const { rows: todosProductos } = await client.query(
      `SELECT estado_administrativo_cat_idestado_administrativo_cat AS estado_id
       FROM diseno_producto WHERE diseno_iddiseno = $1`,
      [disenoId]
    );

    const estadosPadre = todosProductos.map((p: any) => Number(p.estado_id));
    const nuevoEstadoPadre =
      estadosPadre.every(e => e === ESTADO.APROBADO)                            ? ESTADO.APROBADO   :
      estadosPadre.some(e  => e === ESTADO.EN_PROCESO || e === ESTADO.APROBADO) ? ESTADO.EN_PROCESO :
                                                                                   ESTADO.PENDIENTE;

    await client.query(
      `UPDATE diseno SET estado_administrativo_cat_idestado_administrativo_cat = $1 WHERE iddiseno = $2`,
      [nuevoEstadoPadre, disenoId]
    );

    if (nuevoEstadoPadre === ESTADO.APROBADO) {
      await client.query(`UPDATE diseno SET fecha_aprobacion_general = NOW() WHERE iddiseno = $1`, [disenoId]);
    } else {
      await client.query(`UPDATE diseno SET fecha_aprobacion_general = NULL WHERE iddiseno = $1`, [disenoId]);
    }

    let ordenGenerada = false;
    let noProduccion: string | null = null;
    let foliosGenerados: string[] = [];

    if (estadoNum === ESTADO.APROBADO) {
      const cubierto = await anticipoPagado(client, solicitudId);

      if (cubierto) {
        // Advisory lock por producto — evita race condition con aprobarOrdenDiseno
        await client.query(
          `SELECT pg_advisory_xact_lock($1)`,
          [idsolicitudProducto]
        );

        const { rows: ordenExistente } = await client.query(
          `SELECT idproduccion FROM orden_produccion WHERE idsolicitud_producto = $1`,
          [idsolicitudProducto]
        );

        if (ordenExistente.length === 0) {
          noProduccion = await generarNoProduccion(client);

          // ── DISCRIMINADOR PAPEL vs PLÁSTICO ──
          // El folio (no_produccion / prefijo OP) es el mismo para ambos
          // tipos de material, tal como se definió. La única diferencia
          // es de dónde se obtienen los datos de la orden: papel no pasa
          // por configuracion_plastico ni calcula merma/extrusión.
          const esPapel    = await esProductoPapel(client, idsolicitudProducto);
          const datosOrden = esPapel
            ? await prepararDatosOrdenPapel(client, idsolicitudProducto)
            : await prepararDatosOrden(client, idsolicitudProducto);

          // ── UNA orden, o una por componente si es un especial de papel ──
          // (ver emitirOrdenProduccionEspecial.service.ts). noProduccion
          // sigue siendo el folio "real" (el de la OP de unión/única); si
          // hay OP de inicio, sus folios OPIn-... salen en foliosGenerados.
          const { folios, esEspecial } = await emitirOrdenesProduccion(client, {
            solicitudId,
            idsolicitudProducto,
            noProduccionBase: noProduccion,
            datosOrden,
            estadoPendiente: ESTADO.PENDIENTE,
            usuarioId,
          });
          foliosGenerados = folios;

          if (folios.length > 0) {
            ordenGenerada = true;
            console.log(
              esEspecial
                ? `✅ Especial: órdenes ${folios.join(", ")} creadas`
                : esPapel
                  ? `✅ Orden ${noProduccion} creada para PAPEL (sin datos de extrusión)`
                  : `✅ Orden ${noProduccion} creada con metros_merma incluido`
            );
          }
        } else {
          ordenGenerada = true;
        }
      }
    }

    await client.query("COMMIT");

    return res.json({
      message:            "Estado de diseño actualizado",
      iddiseno_producto:  Number(id),
      estado_id:          estadoNum,
      estado_cabecera_id: nuevoEstadoPadre,
      diseno_completado:  nuevoEstadoPadre === ESTADO.APROBADO,
      orden_generada:     ordenGenerada,
      no_produccion:      noProduccion,
      folios_generados:   foliosGenerados,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ ACTUALIZAR ESTADO DISEÑO PRODUCTO ERROR:", error.message);
    return res.status(500).json({ error: "Error al actualizar estado de diseño" });
  } finally {
    client.release();
  }
};

// ════════════════════════════════════════════════════════════════════════
// VERIFICAR CONDICIONES PARA PRODUCCIÓN
// ════════════════════════════════════════════════════════════════════════
export const verificarCondicionesProduccion = async (req: Request, res: Response) => {
  try {
    const { noPedido } = req.params;

    const { rows: ventaRows } = await pool.query(`
      SELECT v.anticipo, v.abono
      FROM ventas v
      JOIN solicitud s ON s.idsolicitud = v.solicitud_idsolicitud
      WHERE s.no_pedido = $1
    `, [noPedido]);

    const { rows: disenoRows } = await pool.query(`
      SELECT
        COUNT(dp.iddiseno_producto) AS total_productos,
        COUNT(*) FILTER (
          WHERE dp.estado_administrativo_cat_idestado_administrativo_cat = $1
        ) AS aprobados
      FROM diseno d
      JOIN solicitud s ON s.idsolicitud = d.solicitud_idsolicitud
      LEFT JOIN diseno_producto dp ON dp.diseno_iddiseno = d.iddiseno
      WHERE s.no_pedido = $2
    `, [ESTADO.APROBADO, noPedido]);

    if (ventaRows.length === 0 || disenoRows.length === 0)
      return res.status(404).json({ error: "Pedido no encontrado" });

    const venta  = ventaRows[0];
    const diseno = disenoRows[0];

    const anticipo_cubierto = Number(venta.abono)      >= Number(venta.anticipo);
    const diseno_completado = Number(diseno.aprobados) === Number(diseno.total_productos)
                              && Number(diseno.total_productos) > 0;

    return res.json({
      no_pedido:        Number(noPedido),
      puede_produccion: anticipo_cubierto && diseno_completado,
      condiciones: {
        anticipo_cubierto,
        anticipo_requerido:  Number(venta.anticipo),
        anticipo_pagado:     Number(venta.abono),
        diseno_completado,
        productos_total:     Number(diseno.total_productos),
        productos_aprobados: Number(diseno.aprobados),
      },
    });

  } catch (error: any) {
    console.error("❌ VERIFICAR CONDICIONES ERROR:", error.message);
    return res.status(500).json({ error: "Error al verificar condiciones" });
  }
};