import PDFDocument from "pdfkit";
import { PoolClient } from "pg";
import { pool } from "../../config/db";
import { getPresignedUrl, uploadToS3, MulterFile } from "../../config/multer";

/**
 * PDF DE LA ORDEN DE DISEÑO
 *
 * Dos formatos sobre el mismo esqueleto: papel lleva más campos
 * de acabado (asa, laminado, foil, textura, relieve, armado) y
 * plástico lleva los suyos (material, calibre, fuelles, sellado).
 * Lo que cambia es la tabla de especificación; el resto de la
 * hoja es idéntico para que en planta se lean igual.
 *
 * La clave del diseño: los números de los pines sobre la imagen
 * empatan con el listado de la derecha.
 *
 * PDFKit y no Puppeteer: no requiere Chromium en el servidor.
 */

const MARGEN = 40;
const ANCHO_HOJA = 612;
const ALTO_HOJA = 792;
const ANCHO_UTIL = ANCHO_HOJA - MARGEN * 2;

const TINTA = "#1a1a1a";
const OSCURO = "#3d3d3d";
const GRIS = "#8a8a8a";
const GRIS_CLARO = "#c9c9c9";
const LINEA = "#e2e2e2";
const AZUL = "#2563eb";
const MORADO = "#7c3aed";
const VERDE = "#059669";
const GRIS_PIN = "#a3a3a3";

/**
 * Orden y etiqueta de los campos por material. Es lo único que
 * distingue un formato del otro: si el campo no viene en el
 * snapshot, simplemente no se imprime.
 */
const CAMPOS_PAPEL: [string, string][] = [
  ["producto", "Producto"],
  ["medida", "Medida"],
  ["descripcion", "Material"],
  ["tintas", "Tintas"],
  ["caras", "Caras"],
  ["tintas_dentro", "Tintas int."],
  ["asa", "Asa"],
  ["tamano_asa", "Tamaño asa"],
  ["laminado", "Laminado"],
  ["hot_stamping", "Foil / HS"],
  ["textura", "Textura"],
  ["uv", "UV"],
  ["alto_relieve", "Alto relieve"],
  ["armado", "Armado"],
  ["hojeado", "Hojeado"],
  ["suaje", "Suaje"],
  ["pigmentos", "Pigmentos"],
  ["observacion", "Observación"],
];

const CAMPOS_PLASTICO: [string, string][] = [
  ["producto", "Producto"],
  ["medida", "Medida"],
  ["calibre", "Calibre"],
  ["material", "Material"],
  ["tintas", "Tintas"],
  ["caras", "Caras"],
  ["suaje", "Suaje"],
  ["identificador", "Identificador"],
  ["descripcion", "Descripción"],
  ["pigmentos", "Pigmentos"],
  ["observacion", "Observación"],
];

const fmtFecha = (valor: any): string => {
  if (!valor) return "—";
  try {
    return new Date(valor).toLocaleDateString("es-MX", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return String(valor);
  }
};

const colorDe = (tipo: string) =>
  tipo === "red_social" ? MORADO : tipo === "texto" ? VERDE : AZUL;

// ============================================================
// DATOS
// ============================================================

const cargarDatos = async (idficha: number) => {
  const ficha = await pool.query(
    `SELECT v.*,
            f.escala_pin,
            c.empresa,
            c.atencion,
            c.correo,
            c.telefono,
            s.no_cotizacion,
            u.nombre   AS creador_nombre,
            u.apellido AS creador_apellido
       FROM vw_ficha_completa v
       JOIN orden_diseno_ficha f
              ON f.idficha = v.idficha
       JOIN orden_diseno o
              ON o.idorden_diseno = v.orden_diseno_id
       LEFT JOIN solicitud_producto sp
              ON sp.idsolicitud_producto = o.solicitud_producto_id
       LEFT JOIN solicitud s
              ON s.idsolicitud = sp.solicitud_idsolicitud
       LEFT JOIN clientes c
              ON c.idclientes = s.clientes_idclientes
       LEFT JOIN usuarios u
              ON u.idusuario = v.creado_por
      WHERE v.idficha = $1`,
    [idficha]
  );

  if (ficha.rows.length === 0) return null;

  const datos = ficha.rows[0];

  const principal =
    (datos.imagenes ?? []).find((i: any) => i.es_principal) ??
    (datos.imagenes ?? [])[0] ??
    null;

  let imagenBuffer: Buffer | null = null;

  if (principal?.public_id) {
    try {
      const url = await getPresignedUrl(principal.public_id);
      const res = await fetch(url);
      if (res.ok) imagenBuffer = Buffer.from(await res.arrayBuffer());
    } catch (error) {
      // Sin imagen la hoja se genera igual, solo con el listado.
      console.error("No se pudo descargar la imagen de la ficha:", error);
    }
  }

  return { ...datos, imagenPrincipal: principal, imagenBuffer };
};

// ============================================================
// PRIMITIVAS DE DIBUJO
// ============================================================

const etiqueta = (doc: any, texto: string, x: number, y: number, ancho: number) => {
  doc.font("Helvetica-Bold").fontSize(6).fillColor(GRIS_CLARO);
  doc.text(texto.toUpperCase(), x, y, { width: ancho, characterSpacing: 0.8 });
};

/** Celda con cabecera oscura arriba y valor sobre blanco abajo. */
const celda = (
  doc: any,
  x: number,
  y: number,
  ancho: number,
  titulo: string,
  valor: string
) => {
  const ALTO_CAB = 15;
  const ALTO_VAL = 22;

  doc.rect(x, y, ancho, ALTO_CAB).fill(OSCURO);
  doc.font("Helvetica-Bold").fontSize(6).fillColor("#ffffff");
  doc.text(titulo.toUpperCase(), x + 6, y + 5, {
    width: ancho - 12,
    ellipsis: true,
    characterSpacing: 0.6,
    lineBreak: false,
  });

  doc.rect(x, y + ALTO_CAB, ancho, ALTO_VAL).lineWidth(0.5).strokeColor(LINEA).stroke();
  doc.font("Helvetica").fontSize(9).fillColor(TINTA);
  doc.text(valor || "—", x + 6, y + ALTO_CAB + 7, {
    width: ancho - 12,
    ellipsis: true,
    lineBreak: false,
  });

  return ALTO_CAB + ALTO_VAL;
};

// ============================================================
// GENERACIÓN
// ============================================================

export const generarPdfFicha = async (
  idficha: number
): Promise<{ buffer: Buffer; nombre: string } | null> => {
  const d = await cargarDatos(idficha);
  if (!d) return null;

  const esPapel = d.tipo_material === "papel";
  const campos = esPapel ? CAMPOS_PAPEL : CAMPOS_PLASTICO;

  const doc = new PDFDocument({ size: "LETTER", margin: MARGEN });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const terminado = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  let y = MARGEN;

  // ── Encabezado ──────────────────────────────────────────
  doc.font("Helvetica-Bold").fontSize(20).fillColor(TINTA);
  doc.text("GRUPO EB", MARGEN, y + 4, { lineBreak: false });
  doc.fontSize(19);
  doc.text("Orden de diseño", MARGEN, y + 30, { lineBreak: false });

  // Bloque de datos, arriba a la derecha
  const xCaja = 330;
  const anchoCaja = ANCHO_HOJA - MARGEN - xCaja;
  const mitad = anchoCaja / 2;
  let yCaja = y;

  celda(doc, xCaja, yCaja, mitad, "Fecha", fmtFecha(d.created_at));
  celda(
    doc,
    xCaja + mitad,
    yCaja,
    mitad,
    "No",
    `${d.no_orden_diseno ?? `F-${d.idficha}`} · v${d.version}`
  );
  yCaja += 37;

  celda(doc, xCaja, yCaja, mitad, "Pedido", d.no_pedido ?? "—");
  celda(
    doc,
    xCaja + mitad,
    yCaja,
    mitad,
    "Admin",
    [d.creador_nombre, d.creador_apellido].filter(Boolean).join(" ") || "—"
  );
  yCaja += 37;

  celda(doc, xCaja, yCaja, anchoCaja, "Compromiso entrega", fmtFecha(d.compromiso_entrega));
  yCaja += 37;
  celda(doc, xCaja, yCaja, anchoCaja, "Fecha conclusión", fmtFecha(d.fecha_conclusion));
  yCaja += 37;

  y = Math.max(yCaja, y + 70) + 8;
  doc.moveTo(MARGEN, y).lineTo(ANCHO_HOJA - MARGEN, y).lineWidth(0.5)
     .strokeColor(LINEA).stroke();
  y += 10;

  // ── Cliente ─────────────────────────────────────────────
  const tercio = ANCHO_UTIL / 3;

  etiqueta(doc, "Cliente", MARGEN, y, tercio);
  doc.font("Helvetica").fontSize(9).fillColor(TINTA);
  doc.text(d.empresa ?? "—", MARGEN, y + 10, { width: tercio - 10, ellipsis: true });

  etiqueta(doc, "Contacto", MARGEN + tercio, y, tercio);
  doc.font("Helvetica").fontSize(9).fillColor(TINTA);
  doc.text(
    [d.telefono, d.correo].filter(Boolean).join(" · ") || "—",
    MARGEN + tercio,
    y + 10,
    { width: tercio - 10, ellipsis: true }
  );

  etiqueta(doc, "Cotización", MARGEN + tercio * 2, y, tercio);
  doc.font("Helvetica").fontSize(9).fillColor(TINTA);
  doc.text(d.no_cotizacion ?? "—", MARGEN + tercio * 2, y + 10, { width: tercio - 10 });

  y += 30;

  // ── Especificación: aquí es donde difieren los formatos ──
  const spec = d.especificacion ?? {};
  const presentes = campos.filter(
    ([clave]) => spec[clave] !== null && spec[clave] !== undefined && spec[clave] !== ""
  );

  const COLUMNAS = 4;
  const anchoCelda = ANCHO_UTIL / COLUMNAS;

  presentes.forEach(([clave, titulo], i) => {
    const col = i % COLUMNAS;
    const fila = Math.floor(i / COLUMNAS);
    celda(
      doc,
      MARGEN + col * anchoCelda,
      y + fila * 37,
      anchoCelda,
      titulo,
      String(spec[clave])
    );
  });

  y += Math.ceil(presentes.length / COLUMNAS) * 37 + 10;

  // ── Pantones ────────────────────────────────────────────
  const pantones = (d.pantones ?? []) as any[];

  if (pantones.length > 0) {
    doc.rect(MARGEN, y, ANCHO_UTIL, 15).fill(OSCURO);
    doc.font("Helvetica-Bold").fontSize(6).fillColor("#ffffff");
    doc.text("PANTONES", MARGEN + 6, y + 5, { characterSpacing: 0.6, lineBreak: false });

    const alto = 20 + Math.floor(pantones.length / 4) * 14;
    doc.rect(MARGEN, y + 15, ANCHO_UTIL, alto).lineWidth(0.5).strokeColor(LINEA).stroke();

    let px = MARGEN + 10;
    let py = y + 21;

    pantones.forEach((p) => {
      const texto = `${p.codigo}${p.cara ? ` (${p.cara})` : ""}`;
      doc.font("Helvetica").fontSize(8.5);
      const ancho = doc.widthOfString(texto) + 26;

      if (px + ancho > ANCHO_HOJA - MARGEN - 10) {
        px = MARGEN + 10;
        py += 14;
      }

      doc.circle(px + 4, py + 4, 4).fill(p.hex_referencia ?? "#cccccc");
      doc.font("Helvetica").fontSize(8.5).fillColor(TINTA);
      doc.text(texto, px + 13, py, { lineBreak: false });

      px += ancho;
    });

    y += 15 + alto + 12;
  }

  // ── Imagen y listado ────────────────────────────────────
  const detalles = (d.detalles ?? []) as any[];
  const yBloque = y;
  const anchoImagen = 285;
  const xLista = MARGEN + anchoImagen + 22;
  const anchoLista = ANCHO_HOJA - MARGEN - xLista;

  etiqueta(doc, "Vista frontal", MARGEN, yBloque, anchoImagen);
  etiqueta(doc, "Acabados y ubicación", xLista, yBloque, anchoLista);

  let altoImagen = 0;
  const yImagen = yBloque + 14;

  // El tamaño lo decide quien arma la ficha, y aquí se respeta
  // tal cual para que el PDF se vea como se vio en pantalla.
  const escala = Math.min(Math.max(Number(d.escala_pin ?? 1) || 1, 0.4), 2);
  const radioPin = 9 * escala;
  const cuerpoPin = Math.max(radioPin - 1, 4);

  if (d.imagenBuffer) {
    try {
      // save/restore aísla el estado de trazo: sin esto, un
      // lineWidth o un color de línea que quedó pendiente de un
      // bloque anterior se dibuja como un marco alrededor de la
      // imagen.
      doc.save();
      const img = (doc as any).openImage(d.imagenBuffer);
      const escala = Math.min(anchoImagen / img.width, 250 / img.height);
      const wReal = img.width * escala;
      const hReal = img.height * escala;
      const xReal = MARGEN + (anchoImagen - wReal) / 2;

      doc.image(d.imagenBuffer, xReal, yImagen, { width: wReal, height: hReal });
      altoImagen = hReal;

      detalles.forEach((det, i) => {
        (det.ubicaciones ?? []).forEach((u: any) => {
          if (
            u.imagen_id === d.imagenPrincipal?.idficha_imagen &&
            u.pin_x !== null &&
            u.pin_y !== null
          ) {
            const cx = xReal + (Number(u.pin_x) / 100) * wReal;
            const cy = yImagen + (Number(u.pin_y) / 100) * hReal;

            doc.circle(cx, cy, radioPin).lineWidth(radioPin > 7 ? 1.5 : 1)
               .fillAndStroke(colorDe(det.tipo_elemento), "#ffffff");
            doc.font("Helvetica-Bold").fontSize(cuerpoPin).fillColor("#ffffff");
            doc.text(String(i + 1), cx - radioPin, cy - cuerpoPin / 2 - 0.5, {
              width: radioPin * 2,
              align: "center",
              lineBreak: false,
            });
          }
        });
      });
      doc.restore();
    } catch (error) {
      console.error("No se pudo dibujar la imagen:", error);
      altoImagen = 0;
    }
  }

  // Listado numerado
  //
  // Los textos del producto se imprimen aquí mismo, completos y
  // debajo de su renglón, en vez de en un bloque aparte. El alto
  // del renglón se calcula con el texto ya ajustado al ancho de
  // la columna, y el cuerpo baja de tamaño si el texto es largo,
  // para que un instructivo de media cuartilla no desborde.
  let yl = yImagen;
  let hojasExtra = 0;

  const cuerpoSegun = (largo: number) => (largo > 800 ? 7 : largo > 300 ? 8 : 9);

  detalles.forEach((det, i) => {
    const u = (det.ubicaciones ?? [])[0];
    const conPin =
      u && u.pin_x !== null && u.imagen_id === d.imagenPrincipal?.idficha_imagen;

    const esTexto = det.tipo_elemento === "texto" && det.detalle;
    const lineas: string[] = esTexto ? String(det.detalle).split("\n") : [];
    const cuerpo = esTexto ? cuerpoSegun(String(det.detalle).length) : 9;
    const anchoTexto = anchoLista - 30;

    // Alto que va a ocupar este renglón, para saber si cabe
    let altoTexto = 0;
    if (esTexto) {
      doc.font("Helvetica").fontSize(cuerpo);
      altoTexto =
        lineas.reduce(
          (acc, linea) =>
            acc +
            Math.max(
              doc.heightOfString(linea || " ", { width: anchoTexto }),
              cuerpo + 3
            ),
          0
        ) + 6;
    }

    const altoRenglon = 20 + altoTexto;

    if (yl + altoRenglon > ALTO_HOJA - MARGEN) {
      doc.addPage();
      yl = MARGEN;
      hojasExtra++;
    }

    doc.circle(xLista + 8, yl + 7, 8).fill(conPin ? colorDe(det.tipo_elemento) : GRIS_PIN);
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#ffffff");
    doc.text(String(i + 1), xLista - 1, yl + 4, {
      width: 18,
      align: "center",
      lineBreak: false,
    });

    doc.font("Helvetica-Bold").fontSize(9).fillColor(TINTA);
    doc.text(det.nombre, xLista + 22, yl + 2, {
      width: anchoLista - 110,
      ellipsis: true,
      lineBreak: false,
    });

    const zona =
      u?.zona === "personalizado"
        ? u?.descripcion_libre || "personalizado"
        : u?.zona || "—";

    doc.font("Helvetica").fontSize(7.5).fillColor(GRIS);
    doc.text(String(zona), xLista + anchoLista - 150, yl + 3, {
      width: 60,
      ellipsis: true,
      lineBreak: false,
    });

    if (!esTexto) {
      doc.font("Helvetica").fontSize(8).fillColor(GRIS);
      doc.text((det.detalle ?? "").replace(/\n/g, " "), xLista + anchoLista - 88, yl + 3, {
        width: 88,
        align: "right",
        ellipsis: true,
        lineBreak: false,
      });
    }

    // Texto completo, con los saltos marcados con ¶
    if (esTexto) {
      let yt = yl + 20;

      lineas.forEach((linea, k) => {
        doc.font("Helvetica").fontSize(cuerpo).fillColor(TINTA);
        const alto = Math.max(
          doc.heightOfString(linea || " ", { width: anchoTexto }),
          cuerpo + 3
        );
        doc.text(linea, xLista + 22, yt, { width: anchoTexto });

        if (k < lineas.length - 1) {
          doc.font("Helvetica").fontSize(cuerpo).fillColor(VERDE);
          doc.text("¶", ANCHO_HOJA - MARGEN - 10, yt, {
            width: 10,
            align: "right",
            lineBreak: false,
          });
        }

        yt += alto;
      });
    }

    yl += altoRenglon;
    doc.moveTo(xLista, yl - 3).lineTo(ANCHO_HOJA - MARGEN, yl - 3)
       .lineWidth(0.5).strokeColor("#f2f2f2").stroke();
  });

  y = (hojasExtra > 0 ? yl : Math.max(yl, yImagen + altoImagen)) + 16;

  // ── Comentarios ─────────────────────────────────────────
  if (d.comentarios) {
    doc.font("Helvetica").fontSize(9);
    const alto = doc.heightOfString(d.comentarios, { width: ANCHO_UTIL - 24 }) + 28;

    if (y + alto + 12 > ALTO_HOJA - MARGEN) {
      doc.addPage();
      y = MARGEN;
    }

    etiqueta(doc, "Comentarios", MARGEN, y, ANCHO_UTIL);
    y += 12;

    doc.rect(MARGEN, y, ANCHO_UTIL, alto).lineWidth(0.5).strokeColor(LINEA).stroke();
    doc.font("Helvetica").fontSize(9).fillColor(TINTA);
    doc.text(d.comentarios, MARGEN + 12, y + 12, { width: ANCHO_UTIL - 24 });
  }

  doc.end();

  const buffer = await terminado;
  const nombre = `${d.no_orden_diseno ?? `ficha-${d.idficha}`}-v${d.version}.pdf`;

  return { buffer, nombre };
};

// ============================================================
// ARCHIVADO
//
// Cada versión publicada guarda su propio PDF congelado. Así se
// puede reimprimir exactamente lo que se le mandó al cliente,
// aunque la ficha haya cambiado después.
// ============================================================

export const archivarPdfFicha = async (
  client: PoolClient,
  idficha: number
): Promise<{ id_archivo: number; nombre: string } | null> => {
  const generado = await generarPdfFicha(idficha);
  if (!generado) return null;

  const ficha = await client.query(
    `SELECT version FROM orden_diseno_ficha WHERE idficha = $1`,
    [idficha]
  );

  if (ficha.rows.length === 0) return null;

  const archivo: MulterFile = {
    fieldname: "archivo",
    originalname: generado.nombre,
    encoding: "7bit",
    mimetype: "application/pdf",
    size: generado.buffer.length,
    buffer: generado.buffer,
  };

  const { url, public_id, resource_type } = await uploadToS3(
    archivo,
    "pdfs",
    "ordenes-diseno"
  );

  const insert = await client.query(
    `INSERT INTO archivos
       (nombre, tipo, mime_type, url, public_id, tamano_kb,
        resource_type, categoria, ficha_id, ficha_version)
     VALUES ($1, 'pdf', 'application/pdf', $2, $3, $4, $5, 'ordenes-diseno', $6, $7)
     RETURNING id_archivo`,
    [
      generado.nombre,
      url,
      public_id,
      Math.round(generado.buffer.length / 1024),
      resource_type,
      idficha,
      ficha.rows[0].version,
    ]
  );

  return { id_archivo: insert.rows[0].id_archivo, nombre: generado.nombre };
};