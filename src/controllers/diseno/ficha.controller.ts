import { Request, Response } from "express";
import { pool } from "../../config/db";
import { getPresignedUrl } from "../../config/multer";
import { generarPdfFicha, archivarPdfFicha } from "../../services/diseno/ficha.pdf";
import {
  getFichaPorOrden,
  getSugerencias,
  getRedesCliente,
  crearFicha,
  actualizarCabecera,
  guardarDetalles,
  guardarPantones,
  vincularImagen,
  publicarFicha,
  detectarCambiosProducto,
  refrescarSnapshot,
  getCatalogoAcabados,
  crearOpcionCatalogo,
  getZonas,
  crearZona,
  DetalleInput,
  PantoneInput,
} from "../../services/diseno/ficha.service";

/**
 * FICHA DE ORDEN DE DISEÑO — controlador
 *
 * Toda escritura pasa por req.tx() para que la auditoría registre
 * quién hizo el cambio. Las lecturas van directo al pool.
 */

// ============================================================
// GET /api/ficha/orden/:ordenId
// ============================================================

export const obtenerFicha = async (req: Request, res: Response): Promise<void> => {
  try {
    const ordenId = Number(req.params.ordenId);

    if (!Number.isInteger(ordenId)) {
      res.status(400).json({ error: "Id de orden inválido" });
      return;
    }

    const ficha = await getFichaPorOrden(ordenId);

    if (!ficha) {
      res.status(404).json({ error: "La orden aún no tiene ficha" });
      return;
    }

    // La vista guarda public_id. La URL firmada se resuelve aquí
    // para que el frontend no tenga que pedirla imagen por imagen.
    ficha.imagenes = await Promise.all(
      (ficha.imagenes ?? []).map(async (img: any) => ({
        ...img,
        url: img.public_id ? await getPresignedUrl(img.public_id) : null,
      }))
    );

    res.json(ficha);
  } catch (error) {
    console.error("❌ Error al obtener ficha:", error);
    res.status(500).json({ error: "Error al obtener la ficha" });
  }
};

// ============================================================
// POST /api/ficha/orden/:ordenId
//
// Crea la ficha a partir del producto de la solicitud. El
// snapshot se congela aquí y no se vuelve a tocar.
// ============================================================

export const crear = async (req: Request, res: Response): Promise<void> => {
  try {
    const ordenId = Number(req.params.ordenId);

    if (!Number.isInteger(ordenId)) {
      res.status(400).json({ error: "Id de orden inválido" });
      return;
    }

    const orden = await pool.query(
      `SELECT idorden_diseno, solicitud_producto_id
         FROM orden_diseno
        WHERE idorden_diseno = $1`,
      [ordenId]
    );

    if (orden.rows.length === 0) {
      res.status(404).json({ error: "La orden de diseño no existe" });
      return;
    }

    if (!orden.rows[0].solicitud_producto_id) {
      res.status(400).json({
        error: "La orden no tiene producto asociado. No se puede crear la ficha.",
      });
      return;
    }

    const existente = await pool.query(
      `SELECT idficha FROM orden_diseno_ficha
        WHERE orden_diseno_id = $1 AND eliminado_at IS NULL`,
      [ordenId]
    );

    if (existente.rows.length > 0) {
      res.status(409).json({
        error: "Esta orden ya tiene ficha",
        idficha: existente.rows[0].idficha,
      });
      return;
    }

    const creada = await (req as any).tx(async (client: any) =>
      crearFicha(client, {
        orden_diseno_id: ordenId,
        solicitud_producto_id: orden.rows[0].solicitud_producto_id,
        compromiso_entrega: req.body.compromiso_entrega ?? null,
      })
    );

    const ficha = await getFichaPorOrden(ordenId);
    res.status(201).json(ficha ?? creada);
  } catch (error) {
    console.error("❌ Error al crear ficha:", error);
    res.status(500).json({ error: "Error al crear la ficha" });
  }
};

// ============================================================
// PUT /api/ficha/:idficha
//
// Guarda cabecera, pantones y detalles en una sola transacción.
// Si algo falla, no queda a medias.
// ============================================================

export const guardar = async (req: Request, res: Response): Promise<void> => {
  try {
    const idficha = Number(req.params.idficha);

    if (!Number.isInteger(idficha)) {
      res.status(400).json({ error: "Id de ficha inválido" });
      return;
    }

    const detalles: DetalleInput[] = Array.isArray(req.body.detalles)
      ? req.body.detalles
      : [];
    const pantones: PantoneInput[] = Array.isArray(req.body.pantones)
      ? req.body.pantones
      : [];

    const invalido = detalles.find((d) => !d.nombre || !d.nombre.trim());
    if (invalido) {
      res.status(400).json({ error: "Todos los detalles necesitan nombre" });
      return;
    }

    await (req as any).tx(async (client: any) => {
      // La escala se acota aquí además del CHECK de la base:
      // un valor absurdo desde el frontend no debe tumbar el
      // guardado completo de la ficha.
      const escala = Number(req.body.escala_pin);
      const escalaValida = Number.isFinite(escala)
        ? Math.min(Math.max(escala, 0.4), 2)
        : null;

      await actualizarCabecera(client, idficha, {
        compromiso_entrega: req.body.compromiso_entrega,
        fecha_conclusion: req.body.fecha_conclusion,
        comentarios: req.body.comentarios,
        escala_pin: escalaValida,
      });

      await guardarPantones(client, idficha, pantones);
      await guardarDetalles(client, idficha, detalles);
    });

    const orden = await pool.query(
      `SELECT orden_diseno_id FROM orden_diseno_ficha WHERE idficha = $1`,
      [idficha]
    );

    const ficha = await getFichaPorOrden(orden.rows[0].orden_diseno_id);
    res.json(ficha);
  } catch (error: any) {
    console.error("❌ Error al guardar ficha:", error);

    // El trigger de límite de pantones lanza check_violation
    if (error.code === "23514") {
      res.status(400).json({ error: error.message });
      return;
    }

    res.status(500).json({ error: "Error al guardar la ficha" });
  }
};

// ============================================================
// POST /api/ficha/:idficha/publicar
//
// Sube la versión y publica el mensaje de sistema en el chat.
// Guardar un borrador no sube versión; publicar sí.
// ============================================================

export const publicar = async (req: Request, res: Response): Promise<void> => {
  try {
    const idficha = Number(req.params.idficha);

    const orden = await pool.query(
      `SELECT orden_diseno_id FROM orden_diseno_ficha
        WHERE idficha = $1 AND eliminado_at IS NULL`,
      [idficha]
    );

    if (orden.rows.length === 0) {
      res.status(404).json({ error: "La ficha no existe" });
      return;
    }

    const ordenId = orden.rows[0].orden_diseno_id;

    const resultado = await (req as any).tx(async (client: any) => {
      const version = await publicarFicha(client, idficha, ordenId);

      // El PDF se congela con la versión recién publicada. Si el
      // archivado falla, no se tumba la publicación: la ficha ya
      // subió de versión y el PDF se puede regenerar al vuelo.
      let archivo = null;
      try {
        archivo = await archivarPdfFicha(client, idficha);
      } catch (error) {
        console.error("⚠️ No se pudo archivar el PDF de la ficha:", error);
      }

      return { version, archivo };
    });

    res.json({
      version: resultado.version,
      archivo: resultado.archivo,
      mensaje: `Ficha publicada como versión ${resultado.version}`,
    });
  } catch (error) {
    console.error("❌ Error al publicar ficha:", error);
    res.status(500).json({ error: "Error al publicar la ficha" });
  }
};

// ============================================================
// POST /api/ficha/:idficha/imagen
//
// El archivo ya se subió por /api/archivos/upload. Aquí solo se
// vincula a la ficha como una vista más.
// ============================================================

export const agregarImagen = async (req: Request, res: Response): Promise<void> => {
  try {
    const idficha = Number(req.params.idficha);
    const archivoId = Number(req.body.archivo_id);

    if (!Number.isInteger(archivoId)) {
      res.status(400).json({ error: "Falta el archivo" });
      return;
    }

    const imagen = await (req as any).tx(async (client: any) =>
      vincularImagen(client, idficha, {
        archivo_id: archivoId,
        vista: req.body.vista,
        es_principal: req.body.es_principal,
      })
    );

    res.status(201).json(imagen);
  } catch (error) {
    console.error("❌ Error al agregar imagen:", error);
    res.status(500).json({ error: "Error al agregar la imagen" });
  }
};

// ============================================================
// GET /api/ficha/sugerencias?q=lis
//
// Alimenta el autocompletado. Devuelve lo más escrito primero.
// ============================================================

export const sugerencias = async (req: Request, res: Response): Promise<void> => {
  try {
    const texto = typeof req.query.q === "string" ? req.query.q : "";
    const limite = Number(req.query.limite ?? 10);

    const filas = await getSugerencias(
      texto,
      Number.isInteger(limite) && limite > 0 ? Math.min(limite, 50) : 10
    );

    res.json(filas);
  } catch (error) {
    console.error("❌ Error al obtener sugerencias:", error);
    res.status(500).json({ error: "Error al obtener sugerencias" });
  }
};

// ============================================================
// GET /api/ficha/redes-cliente/:idclientes
// ============================================================

export const redesCliente = async (req: Request, res: Response): Promise<void> => {
  try {
    const idclientes = Number(req.params.idclientes);

    if (!Number.isInteger(idclientes)) {
      res.status(400).json({ error: "Id de cliente inválido" });
      return;
    }

    res.json(await getRedesCliente(idclientes));
  } catch (error) {
    console.error("❌ Error al obtener redes del cliente:", error);
    res.status(500).json({ error: "Error al obtener redes" });
  }
};

// ============================================================
// POST /api/ficha/redes-cliente/:idclientes
//
// Guarda la red a nivel cliente para que la próxima ficha del
// mismo cliente ya la traiga.
// ============================================================

export const guardarRedCliente = async (req: Request, res: Response): Promise<void> => {
  try {
    const idclientes = Number(req.params.idclientes);
    const { red, usuario, url } = req.body;

    if (!red || !String(red).trim()) {
      res.status(400).json({ error: "Falta la red" });
      return;
    }

    const guardada = await (req as any).tx(async (client: any) => {
      const r = await client.query(
        `INSERT INTO cliente_red_social (idclientes, red, usuario, url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (idclientes, red, usuario)
         DO UPDATE SET url = EXCLUDED.url, activo = true, eliminado_at = NULL
         RETURNING idcliente_red, red, usuario, url`,
        [idclientes, red, usuario ?? null, url ?? null]
      );
      return r.rows[0];
    });

    res.status(201).json(guardada);
  } catch (error) {
    console.error("❌ Error al guardar red del cliente:", error);
    res.status(500).json({ error: "Error al guardar la red" });
  }
};

// ============================================================
// GET /api/ficha/:idficha/pdf
//
// ?descargar=1 fuerza la descarga; por defecto abre en el visor
// del navegador.
// ============================================================

export const pdf = async (req: Request, res: Response): Promise<void> => {
  try {
    const idficha = Number(req.params.idficha);

    if (!Number.isInteger(idficha)) {
      res.status(400).json({ error: "Id de ficha inválido" });
      return;
    }

    const resultado = await generarPdfFicha(idficha);

    if (!resultado) {
      res.status(404).json({ error: "La ficha no existe" });
      return;
    }

    const disposicion = req.query.descargar ? "attachment" : "inline";

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `${disposicion}; filename="${resultado.nombre}"`
    );
    res.setHeader("Content-Length", resultado.buffer.length);
    res.send(resultado.buffer);
  } catch (error) {
    console.error("❌ Error al generar PDF de la ficha:", error);
    res.status(500).json({ error: "Error al generar el PDF" });
  }
};

// ============================================================
// GET /api/ficha/:idficha/cambios-producto
//
// Solo reporta. La ficha no se toca hasta que el usuario lo pida.
// ============================================================

export const cambiosProducto = async (req: Request, res: Response): Promise<void> => {
  try {
    const idficha = Number(req.params.idficha);

    if (!Number.isInteger(idficha)) {
      res.status(400).json({ error: "Id de ficha inválido" });
      return;
    }

    res.json(await detectarCambiosProducto(idficha));
  } catch (error) {
    console.error("❌ Error al detectar cambios del producto:", error);
    res.status(500).json({ error: "Error al comparar con el producto" });
  }
};

// ============================================================
// POST /api/ficha/:idficha/refrescar
//
// Trae los datos actuales del producto. No toca acabados, pines,
// redes ni comentarios.
// ============================================================

export const refrescar = async (req: Request, res: Response): Promise<void> => {
  try {
    const idficha = Number(req.params.idficha);

    if (!Number.isInteger(idficha)) {
      res.status(400).json({ error: "Id de ficha inválido" });
      return;
    }

    const resultado = await (req as any).tx(async (client: any) =>
      refrescarSnapshot(client, idficha)
    );

    const orden = await pool.query(
      `SELECT orden_diseno_id FROM orden_diseno_ficha WHERE idficha = $1`,
      [idficha]
    );

    const ficha = await getFichaPorOrden(orden.rows[0].orden_diseno_id);

    // Igual que en obtenerFicha: la vista trae public_id y el
    // frontend necesita la URL firmada.
    if (ficha) {
      ficha.imagenes = await Promise.all(
        (ficha.imagenes ?? []).map(async (img: any) => ({
          ...img,
          url: img.public_id ? await getPresignedUrl(img.public_id) : null,
        }))
      );
    }

    res.json({
      ficha,
      cambios: resultado.cambios,
      mensaje:
        resultado.cambios.length === 0
          ? "La ficha ya estaba al día"
          : `Se actualizaron ${resultado.cambios.length} campo(s)`,
    });
  } catch (error: any) {
    console.error("❌ Error al refrescar la ficha:", error);
    res.status(500).json({ error: error.message || "Error al refrescar la ficha" });
  }
};

// ============================================================
// CATÁLOGO DE ACABADOS
//
// GET  /api/ficha/catalogo-acabados?material=papel
// POST /api/ficha/catalogo-acabados   { nombre, aplica_a }
// ============================================================

export const catalogoAcabados = async (req: Request, res: Response): Promise<void> => {
  try {
    const material = String(req.query.material ?? "");
    const filtro =
      material === "papel" || material === "plastico" ? material : undefined;

    res.json(await getCatalogoAcabados(filtro));
  } catch (error) {
    console.error("❌ Error al obtener el catálogo de acabados:", error);
    res.status(500).json({ error: "Error al obtener el catálogo" });
  }
};

export const agregarOpcionCatalogo = async (req: Request, res: Response): Promise<void> => {
  try {
    const { nombre, aplica_a } = req.body;

    if (!nombre || !String(nombre).trim()) {
      res.status(400).json({ error: "Falta el nombre de la opción" });
      return;
    }

    const opcion = await (req as any).tx(async (client: any) =>
      crearOpcionCatalogo(client, {
        nombre: String(nombre),
        aplica_a:
          aplica_a === "papel" || aplica_a === "plastico" ? aplica_a : "ambos",
      })
    );

    res.status(201).json(opcion);
  } catch (error: any) {
    console.error("❌ Error al agregar opción al catálogo:", error);
    res.status(500).json({ error: error.message || "Error al agregar la opción" });
  }
};

// ============================================================
// ZONAS
//
// GET  /api/ficha/zonas/:familia
// POST /api/ficha/zonas/:familia   { nombre }
// ============================================================

export const zonas = async (req: Request, res: Response): Promise<void> => {
  try {
    // String() porque los tipos de Express permiten que un
    // parámetro de ruta llegue como arreglo.
    const familia = String(req.params.familia || "bolsa");
    res.json(await getZonas(familia));
  } catch (error) {
    console.error("❌ Error al obtener zonas:", error);
    res.status(500).json({ error: "Error al obtener zonas" });
  }
};

export const agregarZona = async (req: Request, res: Response): Promise<void> => {
  try {
    const { nombre } = req.body;

    if (!nombre || !String(nombre).trim()) {
      res.status(400).json({ error: "Falta el nombre de la zona" });
      return;
    }

    const zona = await (req as any).tx(async (client: any) =>
      crearZona(client, {
        familia: String(req.params.familia || "bolsa"),
        nombre: String(nombre),
      })
    );

    res.status(201).json(zona);
  } catch (error: any) {
    console.error("❌ Error al agregar zona:", error);
    res.status(500).json({ error: error.message || "Error al agregar la zona" });
  }
};