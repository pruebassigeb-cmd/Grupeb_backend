// src/controllers/cotizadorLibre/cotizadorLibreCotizaciones.controller.ts
import { Request, Response } from "express";
import { pool } from "../../config/db";
import type { AuthRequest } from "../../middlewares/auth.middleware";
import {
  insertarProductoPapel,
  type ProductoPapelPayload,
} from "../cotizaciones/cotizacionPapel.helper";
import {
  calcularPrecioPapel,
  ErrorCalculoPrecioPapel,
} from "../../services/producto_papel/calculadorPrecioPapel.service";
import {
  calcularPreciosPlasticoBatch,
  ErrorCalculoPrecioPlastico,
} from "../../services/plastico/calculadorPrecioPlastico.service";
import {
  ESTADO,
  obtenerSiguienteFolioCotizacion,
  obtenerSiguienteFolioPedido,
  crearVentaYDiseno,
} from "../cotizaciones/cotizaciones.controller";
import type {
  CrearCotizacionCotizadorLibreRequest,
  ProductoPapelCotizadorLibreInput,
  ProductoPlasticoCotizadorLibreInput,
} from "../../types/cotizadorLibre/cotizadorLibreCotizaciones.types";

const redondear2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

// La regla de negocio "el cargo por asa solo aplica si el nombre contiene
// 'listón'" vive hoy solo en el frontend interno (useCalculoPrecioPapel.ts).
// Aquí se recalcula el precio del lado del servidor, así que también se
// resuelve aquí — nunca se confía en un booleano que mande el cliente.
const esAsaDeListon = (nombre: string | null): boolean =>
  String(nombre ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .includes("liston");

async function resolverIdTintasPorCantidad(
  client: any,
  cantidad: number
): Promise<number | null> {
  const { rows } = await client.query(
    `SELECT idtintas FROM tintas WHERE cantidad = $1 LIMIT 1`,
    [cantidad]
  );
  return rows[0]?.idtintas ?? null;
}

// ==========================
// Procesa un producto de papel: recalcula precio en servidor, arma el
// payload real y reutiliza insertarProductoPapel (misma función que ya usa
// el sistema general).
// ==========================
async function procesarProductoPapel(
  client: any,
  solicitudId: number,
  input: ProductoPapelCotizadorLibreInput,
  tipoDocumentoInterno: "cotizacion" | "pedido"
): Promise<number> {
  const { idproducto_papel, idgrupo_papel, cantidad, acabados } = input;

  if (!Number.isInteger(idproducto_papel) || !Number.isInteger(idgrupo_papel) || cantidad <= 0) {
    throw new Error("Datos de producto de papel inválidos.");
  }

  const tintasFrente = Math.max(0, Math.min(6, Number(acabados.tintas_frente ?? 0)));
  const tintasDentro = Math.max(0, Math.min(6, Number(acabados.tintas_dentro ?? 0)));

  // Nombre del asa (si hay), para aplicar la regla de "solo listón cobra".
  let nombreAsa: string | null = null;
  if (acabados.id_asa) {
    const { rows } = await client.query(
      `SELECT nombre FROM cat_tipo_asa WHERE idcat_tipo_asa = $1`,
      [acabados.id_asa]
    );
    nombreAsa = rows[0]?.nombre ?? null;
  }

  // Datos del producto para armar un nombre descriptivo confiable (no se
  // toma texto libre del cliente para esto).
  const { rows: prodRows } = await client.query(
    `SELECT medida, descripcion_papel FROM producto_papel WHERE idproducto_papel = $1 AND activo = true`,
    [idproducto_papel]
  );
  if (prodRows.length === 0) {
    throw new Error(`El producto de papel ${idproducto_papel} no existe o está inactivo.`);
  }
  const nombreProducto =
    [prodRows[0].descripcion_papel, prodRows[0].medida].filter(Boolean).join(" - ") ||
    `Producto ${idproducto_papel}`;

  // ---- Recalcular precio en servidor (nunca se confía en el del cliente) ----
  const resultadoPrecio = await calcularPrecioPapel(
    {
      idproducto_papel,
      idgrupo_papel,
      cantidades: [{ referencia: "unica", cantidad }],
      acabados: {
        tintas_frente: tintasFrente,
        tintas_dentro: tintasDentro,
        laminado: acabados.idcat_laminado != null,
        hot_stamping: acabados.idfoil != null,
        alto_relieve: acabados.alto_relieve === true,
        textura: acabados.idcat_textura != null,
        uv: acabados.uv === true,
        asa: acabados.id_asa != null && esAsaDeListon(nombreAsa),
      },
    },
    client
  );

  const resultado = resultadoPrecio.resultados[0];
  if (resultado.advertencias.length > 0) {
    throw new Error(
      `No se pudo calcular un precio confiable para "${nombreProducto}". Intenta con otra configuración o contacta a un asesor.`
    );
  }

  const precioUnitario = redondear2(resultado.precio_calculado);

  // ---- Resolver IDs de tintas reales (para persistencia) ----
  const tintasId = await resolverIdTintasPorCantidad(client, tintasFrente);
  const tintasDentroId = tintasDentro > 0 ? await resolverIdTintasPorCantidad(client, tintasDentro) : null;

  const payload: ProductoPapelPayload = {
    tipoCotizacion: "papel",
    idproducto_papel,
    nombre: nombreProducto,
    idgrupo_papel,
    grupo_descripcion: null,
    tintasId,
    tintasFrenteCantidad: tintasFrente,
    pantones: null,
    tintasDentroId,
    tintasDentroCantidad: tintasDentro,
    pantonesDentro: null,
    carasId: null,
    id_asa: acabados.id_asa ?? null,
    tamano_asa: null,
    id_color: null,
    idcat_laminado: acabados.idcat_laminado ?? null,
    idfoil: acabados.idfoil ?? null,
    idcat_textura: acabados.idcat_textura ?? null,
    uv: acabados.uv === true,
    alto_relieve: acabados.alto_relieve === true,
    lleva_armado: null,
    observacion: null,
    descripcion: null,
    cantidades: [cantidad, 0, 0],
    precios: [precioUnitario, 0, 0],
    permitir_sin_tintas: tintasId === null,
  };

  return insertarProductoPapel(client, solicitudId, payload, tipoDocumentoInterno);
}

// ==========================
// Procesa un producto de plástico: recalcula precio, inserta directo
// (no existe una función exportada equivalente a insertarProductoPapel
// para plástico — se replica aquí el mismo INSERT que usa el flujo
// general, ver cotizaciones.controller.ts).
// ==========================
async function procesarProductoPlastico(
  client: any,
  solicitudId: number,
  input: ProductoPlasticoCotizadorLibreInput,
  tipoDocumentoInterno: "cotizacion" | "pedido"
): Promise<number> {
  const { idconfiguracion_plastico, cantidad, tintasId } = input;

  if (!Number.isInteger(idconfiguracion_plastico) || cantidad <= 0 || !Number.isInteger(tintasId)) {
    throw new Error("Datos de producto de plástico inválidos.");
  }

  const { rows: prodRows } = await client.query(
    `SELECT por_kilo FROM configuracion_plastico WHERE idconfiguracion_plastico = $1 AND activo = true`,
    [idconfiguracion_plastico]
  );
  if (prodRows.length === 0) {
    throw new Error(`El producto de plástico ${idconfiguracion_plastico} no existe o está inactivo.`);
  }
  const porKilo = Number(prodRows[0].por_kilo);

  const resultadoPrecio = await calcularPreciosPlasticoBatch({
    cantidades: [cantidad],
    porKilo,
    tintasId,
  });

  let precioTotal: number;
  if (resultadoPrecio.sin_tintas) {
    throw new Error("Este producto requiere al menos un número de tintas para cotizarse.");
  }
  const resultado = resultadoPrecio.resultados[0];
  if (!resultado) {
    throw new Error("No se encontró una tarifa aplicable para esta configuración de plástico.");
  }
  precioTotal = redondear2(resultado.precio_unitario * cantidad);

  const aprobadoValor = tipoDocumentoInterno === "pedido" ? true : null;

  const { rows: spRows } = await client.query(
    `INSERT INTO solicitud_producto (
       solicitud_idsolicitud,
       configuracion_plastico_idconfiguracion_plastico,
       tintas_idtintas, caras_idcaras,
       idsuaje, pigmentos, pantones, observacion, descripcion,
       perforacion, id_color, id_medidatro,
       tipo_material
     ) VALUES ($1,$2,$3,NULL,NULL,NULL,NULL,NULL,NULL,false,NULL,NULL,'plastico')
     RETURNING idsolicitud_producto`,
    [solicitudId, idconfiguracion_plastico, tintasId]
  );

  const solicitudProductoId = spRows[0].idsolicitud_producto;

  await client.query(
    `INSERT INTO solicitud_detalle (
       solicitud_producto_id, cantidad, precio_total, aprobado, kilogramos, modo_cantidad
     ) VALUES ($1, $2, $3, $4, $5, 'unidad')`,
    [solicitudProductoId, cantidad, precioTotal, aprobadoValor, redondear2(cantidad / porKilo)]
  );

  return precioTotal;
}

// ==========================
// ENDPOINT PRINCIPAL
// ==========================
export const crearCotizacionCotizadorLibre = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const body = req.body as CrearCotizacionCotizadorLibreRequest;

    if (!Number.isInteger(body.clienteId)) {
      return res.status(400).json({ error: "clienteId es requerido." });
    }
    if (!Array.isArray(body.productos) || body.productos.length === 0) {
      return res.status(400).json({ error: "Se requiere al menos un producto." });
    }
    if (body.tipo !== "cotizacion" && body.tipo !== "pedido") {
      return res.status(400).json({ error: "tipo debe ser 'cotizacion' o 'pedido'." });
    }

    // El badge "🌐 Cliente" en las listas del sistema debe reflejar que la
    // cotización/pedido vino de un cliente externo real usando la cuenta
    // compartida — no que un asesor haya usado esta misma pantalla con su
    // propia cuenta de staff (mismo endpoint, mismo motor de precio, pero
    // sin marcar el origen público). Se decide por el ROL del usuario
    // autenticado, no por cuál endpoint se llamó.
    const esClienteExterno = (req as AuthRequest).user?.rol === "CotizadorLibre";

    // El cliente externo (cuenta compartida) solo puede generar cotizaciones
    // — nunca pedidos directos. Esto se valida aquí, no solo ocultando el
    // botón en el frontend, porque el frontend no es de confiar: cualquiera
    // podría mandar tipo:"pedido" manipulando la petición directamente.
    if (esClienteExterno && body.tipo === "pedido") {
      return res.status(403).json({
        error: "No tienes permiso para convertir cotizaciones a pedido directamente.",
      });
    }

    // Si no se verificó la identidad, la solicitud SIEMPRE queda en
    // revisión — sin importar si el cliente pidió cotización o pedido — y
    // nunca se auto-aprueba ni se fija maquinaria hasta que un asesor la
    // revise. Internamente se procesa como si fuera "cotizacion" (sin
    // aprobación automática), pero el estado final que se guarda es
    // 'en_revision', no 'cotizacion'.
    const enRevision = body.verificado !== true;
    const tipoDocumentoInterno: "cotizacion" | "pedido" = enRevision ? "cotizacion" : body.tipo;
    const estadoFinal = enRevision ? "en_revision" : tipoDocumentoInterno;

    await client.query("BEGIN");

    let folioCotizacion: string | null = null;
    let folioPedido: string | null = null;

    if (tipoDocumentoInterno === "cotizacion") {
      folioCotizacion = await obtenerSiguienteFolioCotizacion(client);
    } else {
      folioPedido = await obtenerSiguienteFolioPedido(client);
    }

    const { rows: solRows } = await client.query(
      `INSERT INTO solicitud (
         clientes_idclientes,
         estado_administrativo_cat_idestado_administrativo_cat,
         estado, no_cotizacion, no_pedido, sin_iva, moneda,
         origen_cotizador_libre
       ) VALUES ($1, $2, $3, $4, $5, false, 'MXN', $6)
       RETURNING idsolicitud, no_cotizacion, no_pedido, estado`,
      [body.clienteId, ESTADO.PENDIENTE, estadoFinal, folioCotizacion, folioPedido, esClienteExterno]
    );

    const solicitudId = solRows[0].idsolicitud;
    let subtotalTotal = 0;

    for (const producto of body.productos) {
      if (producto.categoria === "papel") {
        subtotalTotal += await procesarProductoPapel(client, solicitudId, producto, tipoDocumentoInterno);
      } else if (producto.categoria === "plastico") {
        subtotalTotal += await procesarProductoPlastico(client, solicitudId, producto, tipoDocumentoInterno);
      } else {
        throw new Error("categoria de producto inválida.");
      }
    }

    // La creación de venta/diseño solo aplica si de verdad se está creando
    // un pedido confirmado (verificado=true y tipo='pedido') — nunca para
    // casos en_revision, aunque el cliente haya pedido "pedido".
    if (tipoDocumentoInterno === "pedido" && !enRevision) {
      await crearVentaYDiseno(client, solicitudId, folioPedido!, subtotalTotal, false, "MXN", null);
    }

    await client.query("COMMIT");

    console.log(
      `✅ Solicitud creada desde Cotizador Libre — id=${solicitudId} estado=${estadoFinal} cliente=${body.clienteId}`
    );

    // Se regresa el registro completo del cliente para que el frontend arme
    // el PDF con datos reales — a estas alturas la identidad ya se resolvió
    // (cliente nuevo o ya existente), así que devolverle sus propios datos
    // no es una fuga de privacidad, es simplemente su propia información.
    const { rows: clienteRows } = await pool.query(
      `SELECT cli.atencion, cli.empresa, cli.telefono, cli.celular, cli.correo, cli.impresion,
              cli.razon_social, cli.identificar,
              df.rfc,
              dom.domicilio, dom.numero, dom.colonia, dom.codigo_postal, dom.poblacion, dom.estado
       FROM clientes cli
       LEFT JOIN datos_facturacion df ON df.clientes_idclientes = cli.idclientes
       LEFT JOIN domicilio dom ON dom.clientes_idclientes = cli.idclientes
       WHERE cli.idclientes = $1
       LIMIT 1`,
      [body.clienteId]
    );
    const clienteCompleto = clienteRows[0] || null;

    return res.status(201).json({
      idsolicitud: solicitudId,
      estado: solRows[0].estado,
      no_cotizacion: solRows[0].no_cotizacion,
      no_pedido: solRows[0].no_pedido,
      cliente: clienteCompleto
        ? {
            atencion: clienteCompleto.atencion,
            empresa: clienteCompleto.empresa,
            telefono: clienteCompleto.telefono,
            celular: clienteCompleto.celular,
            correo: clienteCompleto.correo,
            impresion: clienteCompleto.impresion,
            razon_social: clienteCompleto.razon_social,
            identificar: clienteCompleto.identificar,
            rfc: clienteCompleto.rfc,
            domicilio: clienteCompleto.domicilio,
            numero: clienteCompleto.numero,
            colonia: clienteCompleto.colonia,
            codigo_postal: clienteCompleto.codigo_postal,
            poblacion: clienteCompleto.poblacion,
            estado_cliente: clienteCompleto.estado,
          }
        : null,
    });
  } catch (error: any) {
    await client.query("ROLLBACK").catch(() => {});

    if (error instanceof ErrorCalculoPrecioPapel || error instanceof ErrorCalculoPrecioPlastico) {
      return res.status(error.statusCode).json({ error: error.message });
    }

    console.error("❌ CREAR COTIZACION COTIZADOR LIBRE ERROR:", error.message);
    return res.status(500).json({
      error: error.message || "No se pudo crear la cotización. Intenta de nuevo.",
    });
  } finally {
    client.release();
  }
};