// src/services/produccion/emitirOrdenProduccionEspecial.service.ts
//
// Punto único donde se INSERTA la(s) fila(s) reales de orden_produccion una
// vez que ya se decidió que un producto está listo para producción (diseño
// aprobado + anticipo cubierto). Antes de esto, esa misma inserción vivía
// copiada y pegada en tres controllers (diseno.controller.ts,
// ordenDiseno.controller.ts, ventas.controller.ts → generarOrdenesPendientes),
// cada uno con su propio INSERT INTO orden_produccion casi idéntico.
//
// Lo que SÍ sigue siendo distinto entre esos tres archivos (a propósito, no
// se tocó): cómo deciden que ya toca emitir (anticipoPagado, el guard
// "¿ya existe orden para este producto?", el advisory lock), cómo generan
// `noProduccion` (dos variantes ligeramente distintas hoy) y cómo preparan
// `datosOrden` (prepararDatosOrden para plástico vs prepararDatosOrdenPapel
// para papel). Unificar eso es un cambio más grande, aparte. Aquí solo se
// centraliza el paso final: dado un no_produccion YA generado y un
// datosOrden YA preparado, crear la(s) fila(s) de orden_produccion que le
// correspondan a ESE producto — una si es normal, una por cada
// componente_papel (OP de inicio + OP de unión/única) si es un producto
// especial de papel — y congelar la merma de papel en cada una.
//
// ── Folio de las OP de inicio ───────────────────────────────────────────
// Las OP de inicio de un especial NO son una orden final (no despachan
// nada por sí solas, solo alimentan el Punto de Unión), así que no llevan
// el folio OP##### de siempre. Llevan "OPIn-{no. de orden de producción}-
// {no. de OP de inicio}" — p. ej. si la orden de unión de ese pedido va a
// ser OP26114 y tiene 3 OP de inicio: OPIn-26114-1, OPIn-26114-2,
// OPIn-26114-3 (Jose). La OP de unión (o la única, en modo "misma orden")
// sí lleva el folio normal, tal cual se generó siempre.

import { congelarMermaSiEsPapel } from "../producto_papel/merma.service";

export interface DatosOrdenComunes {
  repeticion_extrusion: number | null;
  repeticion_metro: number | null;
  metros: number | null;
  metros_merma: number | null;
  ancho_bobina: number | null;
  kilos: number | null;
  kilos_merma: number | null;
  pzas: number | null;
  pzas_merma: number | null;
  repeticion_kidder: string | null;
  repeticion_sicosa: string | null;
}

interface ComponenteParaEmision {
  idcomponente_papel: number;
  tipo: "unica" | "inicio" | "union";
  orden: number | null;
}

// "OP26114" -> "26114". Tolerante a que algún día cambie el prefijo/año.
export function folioOpInicio(noProduccionBase: string, numero: number): string {
  const sinPrefijo = String(noProduccionBase ?? "").replace(/^OP/i, "").trim();
  return `OPIn-${sinPrefijo || noProduccionBase}-${numero}`;
}

async function idProductoPapelDeSolicitud(
  client: any,
  idsolicitudProducto: number
): Promise<{ idproductoPapel: number | null; esEspecial: boolean }> {
  const { rows } = await client.query(
    `SELECT pp.idproducto_papel, pp.es_especial
       FROM solicitud_producto sp
       JOIN solicitud_producto_papel spp
           ON spp.idsolicitud_producto = sp.idsolicitud_producto
       JOIN producto_papel pp
           ON pp.idproducto_papel = sp.producto_papel_idproducto_papel
      WHERE sp.idsolicitud_producto = $1`,
    [idsolicitudProducto]
  );
  if (rows.length === 0) return { idproductoPapel: null, esEspecial: false };
  return {
    idproductoPapel: rows[0].idproducto_papel,
    esEspecial: rows[0].es_especial === true,
  };
}

async function obtenerComponentesParaEmision(
  client: any,
  idproductoPapel: number
): Promise<ComponenteParaEmision[]> {
  const { rows } = await client.query(
    `SELECT idcomponente_papel, tipo, orden
       FROM componente_papel
      WHERE idproducto_papel = $1
      ORDER BY (tipo = 'union') ASC, orden ASC NULLS LAST, idcomponente_papel ASC`,
    [idproductoPapel]
  );
  return rows;
}

async function insertarOrdenProduccion(
  client: any,
  p: {
    estadoPendiente: number;
    noProduccion: string;
    solicitudId: number;
    idsolicitudProducto: number;
    idcomponentePapel: number | null;
    datosOrden: DatosOrdenComunes;
  }
): Promise<number | null> {
  const { rows } = await client.query(
    `INSERT INTO orden_produccion (
      estado_administrativo_cat_idestado_administrativo_cat,
      no_produccion, fecha, fecha_entrega, idsolicitud, idsolicitud_producto,
      idestado_produccion_cat, idcomponente_papel,
      repeticion_extrusion, repeticion_metro, metros, metros_merma, ancho_bobina,
      kilos, kilos_merma, pzas, pzas_merma, repeticion_kidder, repeticion_sicosa
    ) VALUES ($1,$2,NOW(),NOW() + INTERVAL '35 days',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (no_produccion) DO NOTHING
    RETURNING idproduccion`,
    [
      p.estadoPendiente,
      p.noProduccion,
      p.solicitudId,
      p.idsolicitudProducto,
      p.estadoPendiente,
      p.idcomponentePapel,
      p.datosOrden.repeticion_extrusion,
      p.datosOrden.repeticion_metro,
      p.datosOrden.metros,
      p.datosOrden.metros_merma,
      p.datosOrden.ancho_bobina,
      p.datosOrden.kilos,
      p.datosOrden.kilos_merma,
      p.datosOrden.pzas,
      p.datosOrden.pzas_merma,
      p.datosOrden.repeticion_kidder,
      p.datosOrden.repeticion_sicosa,
    ]
  );
  return rows[0]?.idproduccion ?? null;
}

/**
 * Crea la(s) fila(s) de orden_produccion para un idsolicitud_producto que
 * ya se decidió que está listo (diseño aprobado + anticipo cubierto).
 *
 * Quien llama ya hizo el advisory lock, ya confirmó que no existía una
 * orden previa, ya generó `noProduccionBase` (generarNoProduccion) y ya
 * preparó `datosOrden` (prepararDatosOrden / prepararDatosOrdenPapel) —
 * este helper solo decide CUÁNTAS filas le tocan a ese producto y las
 * inserta, congelando la merma de papel en cada una.
 */
export async function emitirOrdenesProduccion(
  client: any,
  opciones: {
    solicitudId: number;
    idsolicitudProducto: number;
    noProduccionBase: string;
    datosOrden: DatosOrdenComunes;
    estadoPendiente: number;
    usuarioId?: number | null;
  }
): Promise<{ folios: string[]; esEspecial: boolean }> {
  const { idproductoPapel, esEspecial } = await idProductoPapelDeSolicitud(
    client,
    opciones.idsolicitudProducto
  );

  // ── Producto normal (o no es de papel): una sola fila, igual que siempre ──
  if (!esEspecial || !idproductoPapel) {
    const idproduccion = await insertarOrdenProduccion(client, {
      estadoPendiente: opciones.estadoPendiente,
      noProduccion: opciones.noProduccionBase,
      solicitudId: opciones.solicitudId,
      idsolicitudProducto: opciones.idsolicitudProducto,
      idcomponentePapel: null,
      datosOrden: opciones.datosOrden,
    });
    if (idproduccion) {
      const { aplico } = await congelarMermaSiEsPapel(client, idproduccion, opciones.usuarioId);
      if (aplico) {
        console.log(`📐 Merma de papel congelada para la orden ${opciones.noProduccionBase}`);
      }
    }
    return { folios: idproduccion ? [opciones.noProduccionBase] : [], esEspecial: false };
  }

  // ── Especial: una orden por componente (OP de inicio + OP de unión/única) ──
  const componentes = await obtenerComponentesParaEmision(client, idproductoPapel);

  if (componentes.length === 0) {
    // No debería pasar — FormularioProductoEspecial ya bloquea guardar un
    // especial sin ruta armada — pero por seguridad no truena la emisión,
    // solo no genera nada y lo deja anotado.
    console.warn(
      `⚠️ Producto especial (idproducto_papel=${idproductoPapel}) sin componente_papel al emitir orden — no se generó ninguna OP.`
    );
    return { folios: [], esEspecial: true };
  }

  const inicios = componentes.filter((c) => c.tipo === "inicio");
  const cierre = componentes.find((c) => c.tipo === "union" || c.tipo === "unica") ?? null;

  const folios: string[] = [];

  // Numeradas por su posición entre ellas (1, 2, 3...), no por su `orden`
  // crudo — por si algún día queda un hueco (una OP de inicio borrada).
  for (let i = 0; i < inicios.length; i++) {
    const comp = inicios[i];
    const folio = folioOpInicio(opciones.noProduccionBase, i + 1);
    const idproduccion = await insertarOrdenProduccion(client, {
      estadoPendiente: opciones.estadoPendiente,
      noProduccion: folio,
      solicitudId: opciones.solicitudId,
      idsolicitudProducto: opciones.idsolicitudProducto,
      idcomponentePapel: comp.idcomponente_papel,
      datosOrden: opciones.datosOrden,
    });
    if (idproduccion) {
      folios.push(folio);
      await congelarMermaSiEsPapel(client, idproduccion, opciones.usuarioId);
    }
  }

  if (cierre) {
    const idproduccion = await insertarOrdenProduccion(client, {
      estadoPendiente: opciones.estadoPendiente,
      noProduccion: opciones.noProduccionBase,
      solicitudId: opciones.solicitudId,
      idsolicitudProducto: opciones.idsolicitudProducto,
      idcomponentePapel: cierre.idcomponente_papel,
      datosOrden: opciones.datosOrden,
    });
    if (idproduccion) {
      folios.push(opciones.noProduccionBase);
      await congelarMermaSiEsPapel(client, idproduccion, opciones.usuarioId);
    }
  }

  if (folios.length > 0) {
    console.log(`✅ Especial: ${folios.length} orden(es) creadas (${folios.join(", ")})`);
  }

  return { folios, esEspecial: true };
}