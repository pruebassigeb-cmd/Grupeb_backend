import { Request, Response } from "express";
import { pool } from "../../config/db";
import { insertarProductoPapel } from "../cotizaciones/cotizacionPapel.helper";
import type { ProductoPapelPayload } from "../cotizaciones/cotizacionPapel.helper";

const ESTADO = { PENDIENTE: 1, EN_PROCESO: 2, APROBADO: 3, RECHAZADO: 4 } as const;

// ─── Helpers de folio ─────────────────────────────────────────────────────────

async function obtenerSiguienteFolioCotizacion(client: any): Promise<string> {
  const yy = new Date().getFullYear().toString().slice(-2);
  const { rows } = await client.query(`
    SELECT COALESCE(MAX(CAST(SUBSTRING(no_cotizacion FROM 'CO${yy}(\\d+)') AS INTEGER)),0)+1 AS siguiente
    FROM solicitud WHERE no_cotizacion LIKE 'CO${yy}%'`);
  return `CO${yy}${String(rows[0].siguiente).padStart(3, "0")}`;
}

async function obtenerSiguienteFolioPedido(client: any): Promise<string> {
  const yy = new Date().getFullYear().toString().slice(-2);
  const { rows } = await client.query(`
    SELECT COALESCE(MAX(CAST(SUBSTRING(no_pedido FROM 'P${yy}(\\d+)') AS INTEGER)),0)+1 AS siguiente
    FROM solicitud WHERE no_pedido LIKE 'P${yy}%'`);
  return `P${yy}${String(rows[0].siguiente).padStart(3, "0")}`;
}

async function generarFolioOrdenDiseno(client: any): Promise<string> {
  const yy = new Date().getFullYear().toString().slice(-2);
  const { rows } = await client.query(`
    SELECT COALESCE(MAX(CAST(SUBSTRING(no_orden_diseno FROM 'OD${yy}(\\d+)') AS INTEGER)),0)+1 AS siguiente
    FROM orden_diseno WHERE no_orden_diseno LIKE 'OD${yy}%'`);
  return `OD${yy}${String(rows[0].siguiente).padStart(3, "0")}`;
}

async function generarIdentificador(client: any): Promise<string> {
  const { rows } = await client.query(`
    SELECT identificar FROM clientes WHERE identificar ~ '^[0-9]+$'
    ORDER BY CAST(identificar AS INTEGER) DESC LIMIT 1`);
  let next = 600;
  if (rows.length > 0) {
    const last = parseInt(rows[0].identificar, 10);
    if (!isNaN(last) && last >= 600) next = last + 1;
  }
  return String(next);
}

async function crearVentaYDiseno(
  client: any, solicitudId: number, folioPedido: string,
  subtotal: number, sinIva = false
): Promise<void> {
  const iva = sinIva ? 0 : Number((subtotal * 0.16).toFixed(2));
  const total = Number((subtotal + iva).toFixed(2));
  const anticipo = Number((total * 0.50).toFixed(2));
  const { rows: vr } = await client.query(
    `INSERT INTO ventas (solicitud_idsolicitud,estado_administrativo_cat_idestado_administrativo_cat,
       subtotal,iva,total,anticipo,saldo,abono,fecha_creacion)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING idventas`,
    [solicitudId, ESTADO.PENDIENTE, subtotal, iva, total, anticipo, total, 0]
  );
  console.log(`✅ [EXPO] Venta #${vr[0].idventas}`);
  const { rows: dr } = await client.query(
    `INSERT INTO diseno (solicitud_idsolicitud,estado_administrativo_cat_idestado_administrativo_cat,fecha)
     VALUES ($1,$2,NOW()) RETURNING iddiseno`,
    [solicitudId, ESTADO.PENDIENTE]
  );
  const disenoId = dr[0].iddiseno;
  const { rows: prods } = await client.query(
    `SELECT idsolicitud_producto FROM solicitud_producto WHERE solicitud_idsolicitud=$1`, [solicitudId]
  );
  for (const prod of prods) {
    await client.query(
      `INSERT INTO diseno_producto (diseno_iddiseno,solicitud_producto_idsolicitud_producto,
         estado_administrativo_cat_idestado_administrativo_cat,fecha)
       VALUES ($1,$2,$3,NOW())`,
      [disenoId, prod.idsolicitud_producto, ESTADO.PENDIENTE]
    );
    const folioOD = await generarFolioOrdenDiseno(client);
    await client.query(
      `INSERT INTO orden_diseno (solicitud_producto_id,no_pedido,no_orden_diseno,estado,version_actual)
       VALUES ($1,$2,$3,'en_revision',1)`,
      [prod.idsolicitud_producto, folioPedido, folioOD]
    );
  }
  console.log(`✅ [EXPO] Diseño #${disenoId} con ${prods.length} producto(s)`);
}

// ═══════════════════════════════════════════════════════════
// CATÁLOGO PROPIO
// ═══════════════════════════════════════════════════════════

export const getCatalogoPropio = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM catalogo_expo WHERE activo=true ORDER BY categoria,idcatalogo_expo`
    );
    return res.json(rows);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
};

export const getCatalogoSistema = async (req: Request, res: Response) => {
  try {
    const { rows: plastico } = await pool.query(`
      SELECT cp.idconfiguracion_plastico AS id,'plastico' AS categoria,
        tpp.material_plastico_producto AS nombre, cp.medida,
        mp.tipo_material AS material, cal.calibre, cal.calibre_bopp,
        cp.altura,cp.ancho,cp.fuelle_fondo,cp.fuelle_latiz,cp.fuelle_latde,cp.refuerzo,cp.por_kilo
      FROM configuracion_plastico cp
      LEFT JOIN tipo_producto_plastico tpp ON tpp.idtipo_producto_plastico=cp.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN material_plastico mp ON mp.idmaterial_plastico=cp.material_plastico_plastico_idmaterial_plastico
      LEFT JOIN calibre cal ON cal.idcalibre=cp.calibre_idcalibre
      ORDER BY tpp.material_plastico_producto,cp.medida`);
    const { rows: papel } = await pool.query(`
      SELECT pp.idproducto_papel AS id,'papel' AS categoria,
        ctp.nombre AS nombre, pp.medida, pp.descripcion_papel,
        pp.ancho,pp.fuelle,pp.altura,
        (SELECT ctp2.nombre FROM detalle_material_papel dmp
         JOIN cat_tipo_papel ctp2 ON ctp2.idcat_tipo_papel=dmp.idcat_tipo_papel
         WHERE dmp.idgrupo_papel IN (SELECT gp.idgrupo_papel FROM grupo_papel gp WHERE gp.idproducto_papel=pp.idproducto_papel)
         LIMIT 1) AS primer_material,
        (SELECT cc.nombre FROM detalle_material_papel dmp
         JOIN cat_calibre cc ON cc.idcat_calibre=dmp.idcat_calibre
         WHERE dmp.idgrupo_papel IN (SELECT gp.idgrupo_papel FROM grupo_papel gp WHERE gp.idproducto_papel=pp.idproducto_papel)
         LIMIT 1) AS primer_calibre
      FROM producto_papel pp
      LEFT JOIN cat_tipo_producto_papel ctp ON ctp.idcat_tipo_producto_papel=pp.idcat_tipo_producto_papel
      WHERE pp.activo=true ORDER BY ctp.nombre,pp.medida`);
    const { rows: coloresAsa } = await pool.query(
      `SELECT id_color AS id, INITCAP(color) AS nombre FROM color_asa ORDER BY id_color`
    );
    const { rows: suajesPlast } = await pool.query(
      `SELECT idsuaje AS id, tipo FROM asa_suaje WHERE idproductos = 1 ORDER BY idsuaje`
    );
    return res.json({ plastico, papel, coloresAsa, suajesPlast });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
};

export const crearProductoCatalogo = async (req: Request, res: Response) => {
  try {
    const {
      nombre, categoria, medida, material, calibre, tintas,
      laminacion, tipo_laminado, hs, tipo_hs, ar, textura, tipo_textura,
      uv, asa, tipo_asa, otro, precio_500, precio_1000, precio_3000, imagen_url,
      tipo_producto,
      altura, ancho, fuelle, fuelle_fondo, fuelle_lateral_iz, fuelle_lateral_de, refuerzo,
      origen,
    } = req.body;

    if (!nombre?.trim()) return res.status(400).json({ error: "El nombre es requerido" });
    if (!["papel", "plastico", "carton"].includes(categoria))
      return res.status(400).json({ error: `Categoría inválida: "${categoria}"` });

    const bool = (v: any) => v === true || v === "true";
    const num = (v: any) => (v != null && v !== "") ? Number(v) : null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`
        INSERT INTO catalogo_expo (nombre,categoria,medida,material,calibre,tintas,
          laminacion,tipo_laminado,hs,tipo_hs,ar,textura,tipo_textura,uv,asa,tipo_asa,otro,
          precio_500,precio_1000,precio_3000,imagen_url,tipo_producto,
          altura,ancho,fuelle,fuelle_fondo,fuelle_lateral_iz,fuelle_lateral_de,refuerzo,origen)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
                $23,$24,$25,$26,$27,$28,$29,$30)
        RETURNING *`,
        [nombre.trim(), categoria, medida || null, material || null, calibre || null, tintas || null,
        bool(laminacion), tipo_laminado || null, bool(hs), tipo_hs || null,
        bool(ar), bool(textura), tipo_textura || null, bool(uv), bool(asa), tipo_asa || null, otro || null,
        num(precio_500), num(precio_1000), num(precio_3000), imagen_url || null, tipo_producto || null,
        num(altura), num(ancho), num(fuelle), num(fuelle_fondo),
        num(fuelle_lateral_iz), num(fuelle_lateral_de), num(refuerzo),
        origen || "expo"]
      );
      const prod = rows[0];
      const fks = await resolverFKsProductoExpo(client, {
        categoria: prod.categoria, nombre: prod.nombre,
        material: prod.material, calibre: prod.calibre, tipo_producto: prod.tipo_producto,
        altura: prod.altura, ancho: prod.ancho, fuelle: prod.fuelle,
        fuelle_fondo: prod.fuelle_fondo, fuelle_lateral_iz: prod.fuelle_lateral_iz,
        fuelle_lateral_de: prod.fuelle_lateral_de, refuerzo: prod.refuerzo,
      });
      if (fks.idproducto_papel || fks.idconfiguracion_plastico) {
        await client.query(`
          UPDATE catalogo_expo SET idproducto_papel=$1, idconfiguracion_plastico=$2
          WHERE idcatalogo_expo=$3`,
          [fks.idproducto_papel, fks.idconfiguracion_plastico, prod.idcatalogo_expo]);
        prod.idproducto_papel = fks.idproducto_papel;
        prod.idconfiguracion_plastico = fks.idconfiguracion_plastico;
      }
      await client.query("COMMIT");
      return res.status(201).json({ message: "Producto agregado", producto: prod });
    } catch (e: any) {
      await client.query("ROLLBACK");
      throw e;
    } finally { client.release(); }
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
};

export const actualizarProductoCatalogo = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      nombre, categoria, medida, material, calibre, tintas,
      laminacion, tipo_laminado, hs, tipo_hs, ar, textura, tipo_textura,
      uv, asa, tipo_asa, otro, precio_500, precio_1000, precio_3000, imagen_url,
      tipo_producto,
      altura, ancho, fuelle, fuelle_fondo, fuelle_lateral_iz, fuelle_lateral_de, refuerzo,
      origen,
    } = req.body;

    const bool = (v: any) => v === true || v === "true";
    const num = (v: any) => (v != null && v !== "") ? Number(v) : null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows, rowCount } = await client.query(`
        UPDATE catalogo_expo SET
          nombre=$1,categoria=$2,medida=$3,material=$4,calibre=$5,tintas=$6,
          laminacion=$7,tipo_laminado=$8,hs=$9,tipo_hs=$10,ar=$11,textura=$12,tipo_textura=$13,
          uv=$14,asa=$15,tipo_asa=$16,otro=$17,precio_500=$18,precio_1000=$19,precio_3000=$20,
          imagen_url=$21,tipo_producto=$22,
          altura=$23,ancho=$24,fuelle=$25,fuelle_fondo=$26,
          fuelle_lateral_iz=$27,fuelle_lateral_de=$28,refuerzo=$29,origen=$30,
          idproducto_papel=NULL, idconfiguracion_plastico=NULL
        WHERE idcatalogo_expo=$31 AND activo=true RETURNING *`,
        [nombre?.trim(), categoria, medida || null, material || null, calibre || null, tintas || null,
        bool(laminacion), tipo_laminado || null, bool(hs), tipo_hs || null,
        bool(ar), bool(textura), tipo_textura || null, bool(uv), bool(asa), tipo_asa || null, otro || null,
        num(precio_500), num(precio_1000), num(precio_3000), imagen_url || null, tipo_producto || null,
        num(altura), num(ancho), num(fuelle), num(fuelle_fondo),
        num(fuelle_lateral_iz), num(fuelle_lateral_de), num(refuerzo),
        origen || "expo", id]
      );
      if ((rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Producto no encontrado" });
      }
      const prod = rows[0];
      const fks = await resolverFKsProductoExpo(client, {
        categoria: prod.categoria, nombre: prod.nombre,
        material: prod.material, calibre: prod.calibre, tipo_producto: prod.tipo_producto,
        altura: prod.altura, ancho: prod.ancho, fuelle: prod.fuelle,
        fuelle_fondo: prod.fuelle_fondo, fuelle_lateral_iz: prod.fuelle_lateral_iz,
        fuelle_lateral_de: prod.fuelle_lateral_de, refuerzo: prod.refuerzo,
      });
      if (fks.idproducto_papel || fks.idconfiguracion_plastico) {
        await client.query(`
          UPDATE catalogo_expo SET idproducto_papel=$1, idconfiguracion_plastico=$2
          WHERE idcatalogo_expo=$3`,
          [fks.idproducto_papel, fks.idconfiguracion_plastico, prod.idcatalogo_expo]);
        prod.idproducto_papel = fks.idproducto_papel;
        prod.idconfiguracion_plastico = fks.idconfiguracion_plastico;
      }
      await client.query("COMMIT");
      return res.json({ message: "Producto actualizado", producto: prod });
    } catch (e: any) {
      await client.query("ROLLBACK");
      throw e;
    } finally { client.release(); }
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
};

export const eliminarProductoCatalogo = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query(
      `UPDATE catalogo_expo SET activo=false WHERE idcatalogo_expo=$1`, [id]
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: "Producto no encontrado" });
    return res.json({ message: "Producto eliminado" });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
};

// ═══════════════════════════════════════════════════════════
// CLIENTES EXPO
// ═══════════════════════════════════════════════════════════

export const crearClienteExpo = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { nombre, celular, correo, impresion, ciudad, estado, clase, intereses, observaciones } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ error: "El nombre es requerido" });
    await client.query("BEGIN");
    const identificar = await generarIdentificador(client);
    const { rows } = await client.query(`
      INSERT INTO clientes (atencion,celular,correo,impresion,origen_expo,clasificacion_expo,
        intereses_expo,observaciones_expo,fecha,identificar)
      VALUES ($1,$2,$3,$4,true,$5,$6,$7,CURRENT_TIMESTAMP,$8)
      RETURNING idclientes,atencion,celular,correo,impresion,identificar`,
      [nombre.trim(), celular || null, correo || null, impresion || null,
      clase || null, intereses?.length ? intereses : null, observaciones || null, identificar]
    );
    const idclientes = rows[0].idclientes;
    if (ciudad || estado) {
      await client.query(
        `INSERT INTO domicilio (clientes_idclientes,poblacion,estado) VALUES ($1,$2,$3)`,
        [idclientes, ciudad || null, estado || null]
      );
    }
    await client.query("COMMIT");
    console.log(`✅ [EXPO] Cliente id=${idclientes} identificar=${identificar}`);
    return res.status(201).json({
      message: "Prospecto registrado",
      cliente: {
        id: idclientes, identificar, nombre: rows[0].atencion,
        celular: rows[0].celular, correo: rows[0].correo, impresion: rows[0].impresion
      },
    });
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error("❌ [EXPO] CREATE CLIENTE:", e.message);
    return res.status(500).json({ error: e.message });
  } finally { client.release(); }
};

export const getClientesExpo = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.idclientes, c.atencion AS nombre, c.celular, c.correo, c.impresion,
        c.clasificacion_expo AS clase, c.intereses_expo AS intereses,
        c.observaciones_expo AS observaciones, c.identificar,
        d.poblacion AS ciudad, d.estado
      FROM clientes c
      LEFT JOIN domicilio d ON d.clientes_idclientes=c.idclientes
      WHERE c.origen_expo=true
      ORDER BY c.fecha DESC`);
    return res.json(rows);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
};

export const actualizarClienteExpo = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { nombre, celular, correo, impresion, ciudad, estado, clase, intereses, observaciones } = req.body;
    await client.query("BEGIN");
    await client.query(`
      UPDATE clientes SET atencion=$1,celular=$2,correo=$3,impresion=$4,
        clasificacion_expo=$5,intereses_expo=$6,observaciones_expo=$7
      WHERE idclientes=$8 AND origen_expo=true`,
      [nombre?.trim() || null, celular || null, correo || null, impresion || null,
      clase || null, intereses?.length ? intereses : null, observaciones || null, id]
    );
    const { rowCount } = await client.query(
      `SELECT 1 FROM domicilio WHERE clientes_idclientes=$1`, [id]
    );
    if ((rowCount ?? 0) > 0) {
      await client.query(
        `UPDATE domicilio SET poblacion=$1,estado=$2 WHERE clientes_idclientes=$3`,
        [ciudad || null, estado || null, id]
      );
    } else if (ciudad || estado) {
      await client.query(
        `INSERT INTO domicilio (clientes_idclientes,poblacion,estado) VALUES ($1,$2,$3)`,
        [id, ciudad || null, estado || null]
      );
    }
    await client.query("COMMIT");
    return res.json({ message: "Prospecto actualizado" });
  } catch (e: any) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e.message });
  } finally { client.release(); }
};

export const eliminarClienteExpo = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT COUNT(*) AS total FROM solicitud WHERE clientes_idclientes=$1`, [id]
    );
    if (Number(rows[0].total) > 0) {
      await client.query(`UPDATE clientes SET origen_expo=false WHERE idclientes=$1`, [id]);
      await client.query("COMMIT");
      return res.json({ message: "Prospecto eliminado", teniaCotizaciones: true });
    }
    await client.query(`DELETE FROM domicilio WHERE clientes_idclientes=$1`, [id]);
    await client.query(`DELETE FROM clientes WHERE idclientes=$1`, [id]);
    await client.query("COMMIT");
    return res.json({ message: "Prospecto eliminado", teniaCotizaciones: false });
  } catch (e: any) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e.message });
  } finally { client.release(); }
};

// ═══════════════════════════════════════════════════════════
// COTIZACIONES EXPO
// ═══════════════════════════════════════════════════════════

export const getSiguienteFolioExpo = async (req: Request, res: Response) => {
  try {
    const yy = new Date().getFullYear().toString().slice(-2);
    const { rows } = await pool.query(`
      SELECT COALESCE(MAX(CAST(SUBSTRING(no_cotizacion FROM 'CO${yy}(\\d+)') AS INTEGER)),0)+1 AS siguiente
      FROM solicitud WHERE no_cotizacion LIKE 'CO${yy}%'`);
    const folio = `CO${yy}${String(rows[0].siguiente).padStart(3, "0")}`;
    return res.json({ folio });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
};

export const crearCotizacionExpo = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { clienteId, productos, comentarios } = req.body;
    if (!clienteId) return res.status(400).json({ error: "Se requiere clienteId" });
    if (!productos?.length) return res.status(400).json({ error: "Se requiere al menos un producto" });

    await client.query("BEGIN");
    const folioCotizacion = await obtenerSiguienteFolioCotizacion(client);
    const { rows: solRows } = await client.query(`
      INSERT INTO solicitud (clientes_idclientes,estado_administrativo_cat_idestado_administrativo_cat,
        estado,no_cotizacion,origen_expo,sin_iva)
      VALUES ($1,$2,'cotizacion',$3,true,false)
      RETURNING idsolicitud,no_cotizacion`,
      [clienteId, ESTADO.PENDIENTE, folioCotizacion]
    );
    const solicitudId = solRows[0].idsolicitud;
    const noCotizacion = solRows[0].no_cotizacion;
    console.log(`✅ [EXPO] Solicitud ${noCotizacion} id=${solicitudId}`);

    // Comentarios generales de la cotización — se guardan en observacion de cada producto
    const obsGeneral = comentarios?.trim() || null;

    let subtotalTotal = 0;

    for (const prod of productos) {
      console.log("[EXPO] tipoCotizacion:", prod.tipoCotizacion, "nombre:", prod.nombre);


      // ── PAPEL SIGEB (sistema) ──────────────────────────────────────────────
      if (prod.tipoCotizacion === "papel" || prod.tipo_material === "papel") {
        let idgrupo_papel = prod.idgrupo_papel ?? null;
        if (!idgrupo_papel && prod.idproducto_papel) {
          const { rows: grupos } = await client.query(
            `SELECT idgrupo_papel FROM grupo_papel
     WHERE idproducto_papel=$1 ORDER BY idgrupo_papel ASC LIMIT 1`,
            [prod.idproducto_papel]
          );
          idgrupo_papel = grupos[0]?.idgrupo_papel ?? null;
        }

        // Resolver grupo_descripcion si no viene del frontend
        let grupo_descripcion = prod.grupo_descripcion ?? null;
        if (!grupo_descripcion && idgrupo_papel) {
          const { rows: gdRows } = await client.query(`
    SELECT string_agg(CONCAT(ctp.nombre, ' ', cc.nombre), ' + ') AS desc
    FROM detalle_material_papel dmp
    LEFT JOIN cat_tipo_papel ctp ON ctp.idcat_tipo_papel = dmp.idcat_tipo_papel
    LEFT JOIN cat_calibre cc ON cc.idcat_calibre = dmp.idcat_calibre
    WHERE dmp.idgrupo_papel = $1`, [idgrupo_papel]
          );
          grupo_descripcion = gdRows[0]?.desc ?? null;
        }

        let metodo_hojeado: "hojeado" | "guillotina" = "hojeado";
        if (prod.idproducto_papel) {
          const { rows: maq } = await client.query(
            `SELECT c.nombre FROM maquinaria_hojeado_guillotina m
             JOIN cat_hojeado_guillotina c ON c.idcat_hojeado_guillotina = m.idcat_hojeado_guillotina
             WHERE m.idproducto_papel = $1 LIMIT 1`,
            [prod.idproducto_papel]
          );
          const nombreMaq = (maq[0]?.nombre || "").toLowerCase();
          if (nombreMaq.includes("guillotina")) metodo_hojeado = "guillotina";
        }

        let tintasId = prod.tintasId ?? null;
        if (!tintasId) {
          const { rows: tRows } = await client.query(
            `SELECT idtintas FROM tintas WHERE cantidad=1 LIMIT 1`
          );
          tintasId = tRows[0]?.idtintas ?? null;
        }

        const papelPayload: ProductoPapelPayload = {
          tipoCotizacion: "papel",
          idproducto_papel: prod.idproducto_papel,
          nombre: prod.nombre ?? "",
          idgrupo_papel,
          grupo_descripcion: grupo_descripcion,
          tintasId,
          pantones: prod.pantones ?? null,
          tintasDentroId: prod.tintasDentroId ?? null,
          pantonesDentro: prod.pantonesDentro ?? null,
          carasId: prod.carasId ?? null,
          id_asa: prod.id_asa ?? null,
          idcat_laminado: prod.idcat_laminado ?? null,
          idfoil: prod.idfoil ?? null,
          idcat_textura: prod.idcat_textura ?? null,
          uv: prod.uv ?? false,
          alto_relieve: prod.alto_relieve ?? false,
          observacion: prod.observacion || obsGeneral,   // ← comentarios generales
          descripcion: prod.descripcion ?? null,
          cantidades: prod.cantidades,
          precios: prod.precios,
          herramental_descripcion: null,
          herramental_precio: null,
          cargo_adicional_descripcion: null,
          cargo_adicional_precio: null,
          metodo_hojeado,
          lleva_armado: prod.lleva_armado ?? false,
        };

        subtotalTotal += await insertarProductoPapel(client, solicitudId, papelPayload, "cotizacion");
        continue;
      }

      // ── PAPEL EXPO PROPIO (categoría papel/cartón del catálogo expo) ────────
      if (prod.tipoCotizacion === "expo_papel") {
        const {
          nombre: epNombre = null, tintas_cantidad: epTintas,
          tipoLaminado = null, tipoHs = null, tipoTextura = null, tipoAsa: epTipoAsa = null,
          uv: epUv = false, ar: epAr = false,
          cantidades: epCants, precios: epPrecios,
          observacion: epObs = null,
        } = prod;

        let epTintasId: number | null = null;
        if (epTintas != null) {
          const num = parseInt(String(epTintas), 10);
          if (!isNaN(num)) {
            const { rows: tr } = await client.query(
              `SELECT idtintas FROM tintas WHERE cantidad=$1 LIMIT 1`, [num]
            );
            epTintasId = tr[0]?.idtintas ?? null;
          }
        }

        const { rows: catExpoRows } = await client.query(`
          SELECT * FROM catalogo_expo WHERE LOWER(nombre) = LOWER($1) AND activo=true LIMIT 1`,
          [epNombre || ""]
        );

        let epIdproductoPapel: number | null = null;
        if (catExpoRows.length > 0) {
          const catE = catExpoRows[0];
          if (catE.idproducto_papel) {
            epIdproductoPapel = catE.idproducto_papel;
          } else {
            const fks = await resolverFKsProductoExpo(client, {
              categoria: catE.categoria, nombre: catE.nombre,
              material: catE.material, calibre: catE.calibre,
              tipo_producto: catE.tipo_producto,
              altura: catE.altura, ancho: catE.ancho, fuelle: catE.fuelle,
              fuelle_fondo: catE.fuelle_fondo, fuelle_lateral_iz: catE.fuelle_lateral_iz,
              fuelle_lateral_de: catE.fuelle_lateral_de, refuerzo: catE.refuerzo,
            });
            epIdproductoPapel = fks.idproducto_papel;
            if (epIdproductoPapel) {
              await client.query(
                `UPDATE catalogo_expo SET idproducto_papel=$1 WHERE idcatalogo_expo=$2`,
                [epIdproductoPapel, catE.idcatalogo_expo]
              );
            }
          }
        }

        if (!epIdproductoPapel) {
          console.warn(`[EXPO] No se pudo resolver idproducto_papel para "${epNombre}", insertando como expo`);
          const { rows: spGenRows } = await client.query(`
            INSERT INTO solicitud_producto
              (solicitud_idsolicitud, tintas_idtintas, descripcion, observacion, tipo_material)
            VALUES ($1,$2,$3,$4,'expo')
            RETURNING idsolicitud_producto`,
            [solicitudId, epTintasId, epNombre || null, epObs || obsGeneral || null]  // ← comentarios generales
          );
          const spGenId = spGenRows[0].idsolicitud_producto;
          for (let i = 0; i < 3; i++) {
            const cant = Number(epCants?.[i] ?? 0);
            const precio = Number(epPrecios?.[i] ?? 0);
            if (cant > 0 && precio > 0) {
              await client.query(`
                INSERT INTO solicitud_detalle (solicitud_producto_id, cantidad, precio_total, aprobado, modo_cantidad)
                VALUES ($1,$2,$3,$4,'unidad')`,
                [spGenId, cant, Math.round(cant * precio * 100) / 100, null]
              );
              subtotalTotal += Math.round(cant * precio * 100) / 100;
            }
          }
          continue;
        }

        let epIdAsa: number | null = null;
        if (epTipoAsa) {
          const { rows: asaR } = await client.query(
            `SELECT idcat_tipo_asa FROM cat_tipo_asa WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
            [`%${epTipoAsa.toLowerCase()}%`]
          );
          epIdAsa = asaR[0]?.idcat_tipo_asa ?? null;
        }

        let epIdLaminado: number | null = null;
        if (tipoLaminado) {
          const { rows: lamR } = await client.query(
            `SELECT idcat_laminado FROM cat_laminado WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
            [`%${tipoLaminado.toLowerCase()}%`]
          );
          epIdLaminado = lamR[0]?.idcat_laminado ?? null;
        }

        let epIdFoil: number | null = null;
        if (tipoHs) {
          const termino = tipoHs.toLowerCase().trim();
          const palabras = termino.split(/\s+/);
          const ultimaPalab = palabras[palabras.length - 1];
          const { rows: foilR } = await client.query(
            `SELECT idfoil FROM foil WHERE LOWER(colorfoil) LIKE $1 OR LOWER(codigofoil) LIKE $2 LIMIT 1`,
            [`%${termino}%`, `%${ultimaPalab}%`]
          );
          epIdFoil = foilR[0]?.idfoil ?? null;
        }

        let epIdTextura: number | null = null;
        if (tipoTextura) {
          const { rows: texR } = await client.query(
            `SELECT idcat_textura FROM cat_textura WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
            [`%${tipoTextura.toLowerCase()}%`]
          );
          epIdTextura = texR[0]?.idcat_textura ?? null;
        }

        const { rows: gpRows } = await client.query(
          `SELECT idgrupo_papel FROM grupo_papel WHERE idproducto_papel=$1 ORDER BY idgrupo_papel ASC LIMIT 1`,
          [epIdproductoPapel]
        );
        const epIdgrupo = gpRows[0]?.idgrupo_papel ?? null;

        let epGrupoDesc: string | null = null;
        if (epIdgrupo) {
          const { rows: gdRows } = await client.query(`
            SELECT string_agg(CONCAT(ctp.nombre, ' ', cc.nombre), ' + ') AS desc
            FROM detalle_material_papel dmp
            LEFT JOIN cat_tipo_papel ctp ON ctp.idcat_tipo_papel = dmp.idcat_tipo_papel
            LEFT JOIN cat_calibre cc ON cc.idcat_calibre = dmp.idcat_calibre
            WHERE dmp.idgrupo_papel = $1`, [epIdgrupo]
          );
          epGrupoDesc = gdRows[0]?.desc ?? null;
        }

        console.log("[EXPO] epGrupoDesc:", epGrupoDesc);
        console.log("[EXPO] catExpoRows:", catExpoRows.length, catExpoRows[0]?.material, catExpoRows[0]?.calibre);

        // ← NUEVO: fallback desde catálogo expo si no hay grupo_descripcion
        if (!epGrupoDesc && catExpoRows.length > 0) {
          const catE = catExpoRows[0];
          const partes = [catE.material, catE.calibre].filter(Boolean);
          if (partes.length > 0) epGrupoDesc = partes.join(" ");
        }

        const epPayload: ProductoPapelPayload = {
          tipoCotizacion: "papel",
          idproducto_papel: epIdproductoPapel,
          nombre: epNombre ?? "",
          idgrupo_papel: epIdgrupo,
          grupo_descripcion: epGrupoDesc,
          tintasId: epTintasId,
          pantones: null,
          tintasDentroId: null,
          pantonesDentro: null,
          carasId: null,
          id_asa: epIdAsa,
          idcat_laminado: epIdLaminado,
          idfoil: epIdFoil,
          idcat_textura: epIdTextura,
          uv: epUv === true,
          alto_relieve: epAr === true,
          observacion: epObs || obsGeneral || null,  // ← comentarios generales
          descripcion: epNombre ?? null,
          cantidades: epCants ?? [0, 0, 0],
          precios: epPrecios ?? [0, 0, 0],
          herramental_descripcion: null,
          herramental_precio: null,
          cargo_adicional_descripcion: null,
          cargo_adicional_precio: null,
          metodo_hojeado: "hojeado",
          lleva_armado: false,
        };

        subtotalTotal += await insertarProductoPapel(client, solicitudId, epPayload, "cotizacion");
        continue;
      }

      // ── PLÁSTICO (sistema o expo) — igual a SIGEB normal ─────────────────
      const {
        configuracion_plastico_id,
        tintas_cantidad,
        nombre: prodNombre = null,
        observacion: prodObs = null,
        cantidades,
        precios,
        idsuaje: prodIdsuaje = null,
        id_color: prodIdColor = null,
        pigmento: prodPigmento = null,
      } = prod;

      const tipoMaterial = configuracion_plastico_id ? "plastico" : "expo";

      let tintasId: number | null = null;
      if (tintas_cantidad != null) {
        const tNum = parseInt(String(tintas_cantidad), 10);
        if (!isNaN(tNum)) {
          const { rows: tr } = await client.query(
            `SELECT idtintas FROM tintas WHERE cantidad=$1 LIMIT 1`, [tNum]
          );
          tintasId = tr[0]?.idtintas ?? null;
        }
      }

      const idsuaje = prodIdsuaje != null ? Number(prodIdsuaje) : null;
      const idColor = prodIdColor != null ? Number(prodIdColor) : null;
      console.log(`[EXPO] Plástico cfg_id=${configuracion_plastico_id} idsuaje=${idsuaje} id_color=${idColor}`);

      const { rows: spRows } = await client.query(`
        INSERT INTO solicitud_producto (
          solicitud_idsolicitud,
          configuracion_plastico_idconfiguracion_plastico,
          producto_papel_idproducto_papel,
          tintas_idtintas,
          descripcion,
          observacion,
          tipo_material,
          idsuaje,
          id_color,
          pigmentos
        ) VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9)
        RETURNING idsolicitud_producto`,
        [
          solicitudId,
          configuracion_plastico_id ?? null,
          tintasId,
          prodNombre || null,
          prodObs || obsGeneral || null,   // ← comentarios generales
          tipoMaterial,
          idsuaje,
          idColor,
          prodPigmento || null,
        ]
      );
      const spId = spRows[0].idsolicitud_producto;

      const cantArr: number[] = Array.isArray(cantidades) ? cantidades : [0, 0, 0];
      const preArr: number[] = Array.isArray(precios) ? precios : [0, 0, 0];

      for (let i = 0; i < cantArr.length; i++) {
        const cant = Number(cantArr[i]);
        const precio = Number(preArr[i]);
        if (cant <= 0 || precio <= 0) continue;
        const precioTotal = Math.round(cant * precio * 100) / 100;
        await client.query(`
          INSERT INTO solicitud_detalle
            (solicitud_producto_id, cantidad, precio_total, precio_unitario, aprobado, modo_cantidad)
          VALUES ($1,$2,$3,$4,NULL,'unidad')`,
          [spId, cant, precioTotal, precio]
        );
        subtotalTotal += precioTotal;
      }

      console.log(`✅ [EXPO] sp_id=${spId} tipo=${tipoMaterial} idsuaje=${idsuaje} id_color=${idColor} subtotal_acum=${subtotalTotal}`);
    }

    await client.query("COMMIT");
    console.log(`✅ [EXPO] Cotización ${noCotizacion} guardada. Subtotal=${subtotalTotal}`);
    return res.status(201).json({
      message: "Cotización expo guardada",
      no_cotizacion: noCotizacion,
      idsolicitud: solicitudId,
    });

  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error("❌ [EXPO] CREATE COT:", e.message, e.stack);
    return res.status(500).json({ error: "Error al guardar cotización expo", detalle: e.message });
  } finally {
    client.release();
  }
};

export const getCotizacionesExpo = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        s.idsolicitud, s.no_cotizacion, s.no_pedido, s.estado, s.fecha,
        s.clientes_idclientes,
        cli.atencion AS cliente, cli.celular, cli.correo, cli.impresion,
        cli.clasificacion_expo, cli.intereses_expo, cli.observaciones_expo, cli.identificar,
        dom.poblacion AS ciudad, dom.estado AS estado_cliente,
        sp.idsolicitud_producto, sp.tipo_material, sp.descripcion, sp.observacion,
        sp.configuracion_plastico_idconfiguracion_plastico,
        sp.producto_papel_idproducto_papel,
        sp.pigmentos,
        sp.grupo_papel_descripcion,
sp.grupo_papel_idgrupo_papel,
        sp.idsuaje, sp.id_color,
        asz.tipo AS suaje_tipo,
        ca.color AS color_asa_nombre,
        t.cantidad AS tintas_cantidad,
        cfg.medida AS cfg_medida,
        tpp.material_plastico_producto AS tipo_producto_nombre,
        mp.tipo_material AS material_nombre,
        cal.calibre AS calibre_numero, cal.calibre_bopp,
        ctp.nombre AS papel_tipo_producto,
        pp.medida AS papel_medida, pp.descripcion_papel AS papel_descripcion,
        spp.id_asa, asa.nombre AS asa_nombre,
        spp.idcat_laminado, lam.nombre AS laminado_nombre,
        spp.idfoil, fo.colorfoil AS foil_color, fo.codigofoil AS foil_codigo,
        spp.idcat_textura, tex.nombre AS textura_nombre,
        spp.uv, spp.alto_relieve,
        sd.idsolicitud_detalle, sd.cantidad, sd.precio_total, sd.precio_unitario, sd.aprobado,
        ce_exp.medida AS expo_medida, ce_exp.material AS expo_material, ce_exp.calibre AS expo_calibre,
        ce_exp.tipo_producto AS expo_tipo_producto
      FROM solicitud s
      LEFT JOIN clientes cli ON cli.idclientes=s.clientes_idclientes
      LEFT JOIN domicilio dom ON dom.clientes_idclientes=cli.idclientes
      LEFT JOIN solicitud_producto sp ON sp.solicitud_idsolicitud=s.idsolicitud
      LEFT JOIN asa_suaje asz ON asz.idsuaje=sp.idsuaje
      LEFT JOIN color_asa ca ON ca.id_color=sp.id_color
      LEFT JOIN tintas t ON t.idtintas=sp.tintas_idtintas
      LEFT JOIN configuracion_plastico cfg ON cfg.idconfiguracion_plastico=sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN tipo_producto_plastico tpp ON tpp.idtipo_producto_plastico=cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      LEFT JOIN material_plastico mp ON mp.idmaterial_plastico=cfg.material_plastico_plastico_idmaterial_plastico
      LEFT JOIN calibre cal ON cal.idcalibre=cfg.calibre_idcalibre
      LEFT JOIN producto_papel pp ON pp.idproducto_papel=sp.producto_papel_idproducto_papel
      LEFT JOIN cat_tipo_producto_papel ctp ON ctp.idcat_tipo_producto_papel=pp.idcat_tipo_producto_papel
      LEFT JOIN solicitud_producto_papel spp ON spp.idsolicitud_producto=sp.idsolicitud_producto
      LEFT JOIN cat_tipo_asa asa ON asa.idcat_tipo_asa=spp.id_asa
      LEFT JOIN cat_laminado lam ON lam.idcat_laminado=spp.idcat_laminado
      LEFT JOIN foil fo ON fo.idfoil=spp.idfoil
      LEFT JOIN cat_textura tex ON tex.idcat_textura=spp.idcat_textura
      LEFT JOIN grupo_papel gp ON gp.idgrupo_papel=sp.grupo_papel_idgrupo_papel
      LEFT JOIN LATERAL (
        SELECT ce.medida, ce.material, ce.calibre, ce.tipo_producto
        FROM catalogo_expo ce
        WHERE sp.tipo_material = 'expo'
          AND ce.activo = true
          AND LOWER(ce.nombre) = LOWER(sp.descripcion)
        ORDER BY ce.idcatalogo_expo DESC
        LIMIT 1
      ) ce_exp ON true
      LEFT JOIN solicitud_detalle sd ON sd.solicitud_producto_id=sp.idsolicitud_producto
      WHERE s.origen_expo=true
      ORDER BY s.fecha DESC, sp.idsolicitud_producto, sd.idsolicitud_detalle`);

    const agrupadas: Record<string, any> = {};
    for (const row of rows) {
      const key = String(row.idsolicitud);
      if (!agrupadas[key]) {
        agrupadas[key] = {
          idsolicitud: row.idsolicitud, no_cotizacion: row.no_cotizacion,
          no_pedido: row.no_pedido, estado: row.estado, fecha: row.fecha,
          cliente_id: row.clientes_idclientes, cliente: row.cliente || "",
          celular: row.celular || "", correo: row.correo || "", impresion: row.impresion || "",
          clasificacion: row.clasificacion_expo || "", intereses: row.intereses_expo || [],
          observaciones: row.observaciones_expo || "", ciudad: row.ciudad || "",
          estado_cliente: row.estado_cliente || "", identificar: row.identificar || "",
          productos: [],
        };
      }
      if (!row.idsolicitud_producto) continue;
      let prod = agrupadas[key].productos.find(
        (p: any) => p.idsolicitud_producto === row.idsolicitud_producto
      );
      if (!prod) {
        let nombre = row.descripcion || "";
        if (!nombre) {
          if (row.tipo_material === "papel") {
            nombre = row.papel_tipo_producto
              ? (row.papel_descripcion ? `${row.papel_tipo_producto} — ${row.papel_descripcion}` : row.papel_tipo_producto)
              : `Papel #${row.producto_papel_idproducto_papel}`;
          } else if (row.cfg_medida) {
            nombre = [row.tipo_producto_nombre, row.cfg_medida,
            (row.material_nombre || "").toLowerCase()].filter(Boolean).join(" ");
          } else { nombre = "Producto expo"; }
        }
        const foilNombre = row.foil_color
          ? `${row.foil_color}${row.foil_codigo ? " " + row.foil_codigo : ""}` : null;
        prod = {
          idsolicitud_producto: row.idsolicitud_producto,
          tipo_material: row.tipo_material, nombre,
          medida: row.tipo_material === "papel" ? row.papel_medida : (row.cfg_medida || row.expo_medida || null),
          material: row.material_nombre || row.expo_material || null,
          calibre: row.calibre_numero ? String(row.calibre_numero) : (row.expo_calibre || null),
          tipo_producto: row.tipo_material === "papel"
            ? (row.papel_tipo_producto ?? null)
            : (row.tipo_producto_nombre || row.expo_tipo_producto || null),
          tintas: row.tintas_cantidad ?? null,
          descripcion: row.descripcion || null, observacion: row.observacion || null,
          pigmentos: row.pigmentos || null,
          idsuaje: row.idsuaje ?? null, suaje_tipo: row.suaje_tipo ?? null,
          id_color: row.id_color ?? null, color_asa_nombre: row.color_asa_nombre ?? null,
          id_asa: row.id_asa ?? null, asa_nombre: row.asa_nombre ?? null,
          idcat_laminado: row.idcat_laminado ?? null, laminado_nombre: row.laminado_nombre ?? null,
          idfoil: row.idfoil ?? null, foil_nombre: foilNombre,
          grupo_descripcion: row.grupo_papel_descripcion ?? null,
          idcat_textura: row.idcat_textura ?? null, textura_nombre: row.textura_nombre ?? null,
          uv: row.uv ?? false, alto_relieve: row.alto_relieve ?? false,
          detalles: [],
        };
        agrupadas[key].productos.push(prod);
      }
      if (row.idsolicitud_detalle) {
        prod.detalles.push({
          idsolicitud_detalle: row.idsolicitud_detalle,
          cantidad: Number(row.cantidad),
          precio_total: Number(row.precio_total),
          precio_unitario: row.precio_unitario != null ? Number(row.precio_unitario) : null,
          aprobado: row.aprobado,
        });
      }
    }
    return res.json(Object.values(agrupadas));
  } catch (e: any) {
    console.error("❌ [EXPO] GET COTS:", e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS — Conversión automática de producto expo → configuracion_plastico
// ═══════════════════════════════════════════════════════════════════════════

function calcularPorKiloExpo(
  altura: number, ancho: number,
  fuelleFondo: number, fuelleLat1: number, fuelleLat2: number,
  refuerzo: number, calibre: number, factorMaterial: number
): number | null {
  if (altura === 0 || ancho === 0 || calibre === 0 || factorMaterial === 0) return null;
  const sumaV = altura + fuelleFondo + refuerzo;
  const sumaH = ancho + fuelleLat1 + fuelleLat2;
  const resultado = 1000 / (((sumaV / 100) * (sumaH / 100) * calibre) * factorMaterial);
  return parseFloat(resultado.toFixed(3));
}

function normalizarMaterial(material: string | null): string {
  const m = (material || "").toLowerCase();
  if (m.includes("alta")) return "Alta densidad";
  if (m.includes("baja")) return "Baja densidad";
  if (m.includes("bopp") || m.includes("celofan") || m.includes("celofán")) return "BOPP";
  return material || "";
}

async function resolverFKsProductoExpo(
  client: any,
  cat: {
    categoria: string; nombre: string; material: string | null; calibre: string | null;
    tipo_producto: string | null; altura: number | null; ancho: number | null;
    fuelle: number | null; fuelle_fondo: number | null; fuelle_lateral_iz: number | null;
    fuelle_lateral_de: number | null; refuerzo: number | null;
  }
): Promise<{ idproducto_papel: number | null; idconfiguracion_plastico: number | null }> {

  if (cat.categoria === "plastico") {
    if (!cat.material || !cat.calibre || !cat.tipo_producto) return { idproducto_papel: null, idconfiguracion_plastico: null };
    const materialNorm = normalizarMaterial(cat.material);
    const esBopp = materialNorm === "BOPP";
    const calibreNum = parseFloat(cat.calibre) || 0;
    if (!calibreNum) return { idproducto_papel: null, idconfiguracion_plastico: null };
    const { rows: matRows } = await client.query(
      `SELECT idmaterial_plastico, valor FROM material_plastico WHERE LOWER(tipo_material) = LOWER($1) LIMIT 1`,
      [materialNorm]
    );
    if (!matRows.length) return { idproducto_papel: null, idconfiguracion_plastico: null };
    const materialId = matRows[0].idmaterial_plastico;
    const factorMaterial = parseFloat(matRows[0].valor) || 0;
    const { rows: tipoRows } = await client.query(
      `SELECT idtipo_producto_plastico FROM tipo_producto_plastico WHERE LOWER(material_plastico_producto) LIKE $1 LIMIT 1`,
      [`%${cat.tipo_producto.toLowerCase()}%`]
    );
    if (!tipoRows.length) return { idproducto_papel: null, idconfiguracion_plastico: null };
    const tipoId = tipoRows[0].idtipo_producto_plastico;
    const calibreCol = esBopp ? "calibre_bopp" : "calibre";
    const { rows: calRows } = await client.query(
      `SELECT idcalibre FROM calibre WHERE ${calibreCol} = $1 LIMIT 1`, [calibreNum]
    );
    if (!calRows.length) return { idproducto_papel: null, idconfiguracion_plastico: null };
    const calibreId = calRows[0].idcalibre;
    const altura = Number(cat.altura) || 0;
    const ancho = Number(cat.ancho) || 0;
    const fuelleFondo = Number(cat.fuelle_fondo || cat.fuelle) || 0;
    const fuelleLat1 = Number(cat.fuelle_lateral_iz) || 0;
    const fuelleLat2 = Number(cat.fuelle_lateral_de) || 0;
    const refuerzo = Number(cat.refuerzo) || 0;
    if (!altura || !ancho) return { idproducto_papel: null, idconfiguracion_plastico: null };
    const porKilo = calcularPorKiloExpo(altura, ancho, fuelleFondo, fuelleLat1, fuelleLat2, refuerzo, calibreNum, factorMaterial);
    if (!porKilo) return { idproducto_papel: null, idconfiguracion_plastico: null };
    const partes: string[] = [String(altura)];
    if (fuelleFondo > 0) partes.push(String(fuelleFondo));
    if (refuerzo > 0) partes.push(String(refuerzo));
    const partesDer: string[] = [String(ancho)];
    if (fuelleLat1 > 0) partesDer.push(String(fuelleLat1));
    if (fuelleLat2 > 0 && fuelleLat2 !== fuelleLat1) partesDer.push(String(fuelleLat2));
    const medida = `${partes.join("+")}x${partesDer.join("+")}`;
    const { rows: cfgRows } = await client.query(`
      INSERT INTO configuracion_plastico (
        tipo_producto_plastico_plastico_idtipo_producto_plastico,
        material_plastico_plastico_idmaterial_plastico,
        calibre_idcalibre, altura, ancho, fuelle_fondo, fuelle_latiz, fuelle_latde,
        refuerzo, medida, por_kilo
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT DO NOTHING RETURNING idconfiguracion_plastico`,
      [tipoId, materialId, calibreId, altura, ancho, fuelleFondo, fuelleLat1, fuelleLat2, refuerzo, medida, porKilo]
    );
    let configId: number;
    if (cfgRows.length > 0) {
      configId = cfgRows[0].idconfiguracion_plastico;
    } else {
      const { rows: ex } = await client.query(`
        SELECT idconfiguracion_plastico FROM configuracion_plastico
        WHERE tipo_producto_plastico_plastico_idtipo_producto_plastico=$1
          AND material_plastico_plastico_idmaterial_plastico=$2
          AND calibre_idcalibre=$3 AND altura=$4 AND ancho=$5
          AND fuelle_fondo=$6 AND fuelle_latiz=$7 AND fuelle_latde=$8 AND refuerzo=$9
        LIMIT 1`,
        [tipoId, materialId, calibreId, altura, ancho, fuelleFondo, fuelleLat1, fuelleLat2, refuerzo]
      );
      if (!ex.length) return { idproducto_papel: null, idconfiguracion_plastico: null };
      configId = ex[0].idconfiguracion_plastico;
    }
    return { idproducto_papel: null, idconfiguracion_plastico: configId };
  }

  if (cat.categoria === "papel" || cat.categoria === "carton") {
    const idproductos = cat.categoria === "carton" ? 3 : 2;
    const tipoStr = (cat.tipo_producto || "").toLowerCase();
    const { rows: tpRows } = await client.query(
      `SELECT idcat_tipo_producto_papel FROM cat_tipo_producto_papel WHERE LOWER(nombre) LIKE $1 LIMIT 1`,
      [`%${tipoStr}%`]
    );
    if (!tpRows.length) return { idproducto_papel: null, idconfiguracion_plastico: null };
    const idcatTipoProductoPapel = tpRows[0].idcat_tipo_producto_papel;
    const { rows: tmatRows } = await client.query(
      `SELECT idcat_tipo_papel FROM cat_tipo_papel WHERE LOWER(nombre) = LOWER($1) LIMIT 1`,
      [cat.material || ""]
    );
    const idcatTipoPapel = tmatRows[0]?.idcat_tipo_papel ?? null;
    let idcatCalibre: number | null = null;
    if (cat.calibre) {
      const { rows: calRows } = await client.query(
        `SELECT idcat_calibre FROM cat_calibre WHERE LOWER(nombre) = LOWER($1) LIMIT 1`,
        [cat.calibre]
      );
      idcatCalibre = calRows[0]?.idcat_calibre ?? null;
    }
    const altura = Number(cat.altura) || null;
    const ancho = Number(cat.ancho) || null;
    const fuelle = Number(cat.fuelle || cat.fuelle_fondo) || null;
    const medida = [altura, fuelle, ancho].filter(Boolean).length >= 2
      ? `${altura || ""}${fuelle ? "+" + fuelle : ""}x${ancho || ""}` : null;
    const { rows: ppExist } = await client.query(`
      SELECT pp.idproducto_papel FROM producto_papel pp
      WHERE pp.idproductos=$1 AND pp.idcat_tipo_producto_papel=$2
        AND (pp.ancho=$3 OR ($3 IS NULL AND pp.ancho IS NULL))
        AND (pp.altura=$4 OR ($4 IS NULL AND pp.altura IS NULL))
        AND (pp.fuelle=$5 OR ($5 IS NULL AND pp.fuelle IS NULL))
      LIMIT 1`, [idproductos, idcatTipoProductoPapel, ancho, altura, fuelle]
    );
    let idproductoPapel: number;
    if (ppExist.length > 0) {
      idproductoPapel = ppExist[0].idproducto_papel;
    } else {
      const { rows: ppRows } = await client.query(`
        INSERT INTO producto_papel (idproductos, idcat_tipo_producto_papel, ancho, fuelle, altura, medida, descripcion_papel, activo)
        VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING idproducto_papel`,
        [idproductos, idcatTipoProductoPapel, ancho, fuelle, altura, medida, cat.nombre]
      );
      idproductoPapel = ppRows[0].idproducto_papel;
      const { rows: gpRows } = await client.query(`
        INSERT INTO grupo_papel (idproducto_papel, precio_sugerido, orden)
        VALUES ($1,NULL,1) RETURNING idgrupo_papel`, [idproductoPapel]
      );
      const idgrupoPapel = gpRows[0].idgrupo_papel;
      if (idcatTipoPapel && idcatCalibre) {
        await client.query(`
          INSERT INTO detalle_material_papel (idgrupo_papel, idcat_tipo_papel, idcat_calibre, orden)
          VALUES ($1,$2,$3,1)`, [idgrupoPapel, idcatTipoPapel, idcatCalibre]
        );
      }
    }
    return { idproducto_papel: idproductoPapel, idconfiguracion_plastico: null };
  }

  return { idproducto_papel: null, idconfiguracion_plastico: null };
}

async function convertirProductoExpoASistema(
  client: any, idsolicitudProducto: number, nombre: string
): Promise<string | null> {
  const { rows: spRows } = await client.query(`
    SELECT sp.configuracion_plastico_idconfiguracion_plastico AS cfg_id,
           sp.tipo_material, sp.descripcion
    FROM solicitud_producto sp WHERE sp.idsolicitud_producto=$1`, [idsolicitudProducto]
  );
  if (!spRows.length) return null;
  const sp = spRows[0];
  if (sp.cfg_id != null) return null;
  if (sp.tipo_material === "papel") return null;
  if (sp.tipo_material !== "expo") return null;
  const nombreBuscar = (sp.descripcion || nombre || "").trim();
  if (!nombreBuscar) return `Producto expo sin nombre. Revisar en SIGEB.`;
  const { rows: catRows } = await client.query(`
    SELECT ce.categoria, ce.material, ce.calibre, ce.tipo_producto,
           ce.altura, ce.ancho, ce.fuelle, ce.fuelle_fondo,
           ce.fuelle_lateral_iz, ce.fuelle_lateral_de, ce.refuerzo,
           ce.idproducto_papel, ce.idconfiguracion_plastico, ce.nombre
    FROM catalogo_expo ce
    WHERE LOWER(ce.nombre) = LOWER($1) AND ce.activo=true LIMIT 1`, [nombreBuscar]
  );
  if (!catRows.length) return null;
  const cat = catRows[0];
  if (cat.idconfiguracion_plastico) {
    await client.query(`
      UPDATE solicitud_producto
      SET configuracion_plastico_idconfiguracion_plastico=$1, tipo_material='plastico'
      WHERE idsolicitud_producto=$2`, [cat.idconfiguracion_plastico, idsolicitudProducto]
    );
    return null;
  }
  if (cat.idproducto_papel) {
    const { rows: sppCheck } = await client.query(
      `SELECT 1 FROM solicitud_producto_papel WHERE idsolicitud_producto=$1`, [idsolicitudProducto]
    );
    if (!sppCheck.length) {
      await client.query(`
        INSERT INTO solicitud_producto_papel (idsolicitud_producto, uv, alto_relieve, lleva_armado)
        VALUES ($1,false,false,true) ON CONFLICT (idsolicitud_producto) DO NOTHING`, [idsolicitudProducto]
      );
    }
    await client.query(`
      UPDATE solicitud_producto
      SET tipo_material='papel', producto_papel_idproducto_papel=$1
      WHERE idsolicitud_producto=$2`, [cat.idproducto_papel, idsolicitudProducto]
    );
    return null;
  }
  const fks = await resolverFKsProductoExpo(client, {
    categoria: cat.categoria, nombre: cat.nombre,
    material: cat.material, calibre: cat.calibre, tipo_producto: cat.tipo_producto,
    altura: cat.altura, ancho: cat.ancho, fuelle: cat.fuelle,
    fuelle_fondo: cat.fuelle_fondo, fuelle_lateral_iz: cat.fuelle_lateral_iz,
    fuelle_lateral_de: cat.fuelle_lateral_de, refuerzo: cat.refuerzo,
  });
  if (fks.idconfiguracion_plastico) {
    await client.query(
      `UPDATE catalogo_expo SET idconfiguracion_plastico=$1 WHERE LOWER(nombre)=LOWER($2)`,
      [fks.idconfiguracion_plastico, nombreBuscar]
    );
    await client.query(`
      UPDATE solicitud_producto
      SET configuracion_plastico_idconfiguracion_plastico=$1, tipo_material='plastico'
      WHERE idsolicitud_producto=$2`, [fks.idconfiguracion_plastico, idsolicitudProducto]
    );
    return null;
  }
  if (fks.idproducto_papel) {
    await client.query(
      `UPDATE catalogo_expo SET idproducto_papel=$1 WHERE LOWER(nombre)=LOWER($2)`,
      [fks.idproducto_papel, nombreBuscar]
    );
    const { rows: sppCheck } = await client.query(
      `SELECT 1 FROM solicitud_producto_papel WHERE idsolicitud_producto=$1`, [idsolicitudProducto]
    );
    if (!sppCheck.length) {
      await client.query(`
        INSERT INTO solicitud_producto_papel (idsolicitud_producto, uv, alto_relieve, lleva_armado)
        VALUES ($1,false,false,true) ON CONFLICT (idsolicitud_producto) DO NOTHING`, [idsolicitudProducto]
      );
    }
    await client.query(`
      UPDATE solicitud_producto
      SET tipo_material='papel', producto_papel_idproducto_papel=$1
      WHERE idsolicitud_producto=$2`, [fks.idproducto_papel, idsolicitudProducto]
    );
    return null;
  }
  return null;
}

export const aprobarCotizacionExpo = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { folio } = req.params;
    const { itemsAprobados } = req.body;
    if (!itemsAprobados?.length) return res.status(400).json({ error: "Selecciona al menos un producto" });
    await client.query("BEGIN");
    const { rows: solRows } = await client.query(
      `SELECT idsolicitud,estado,no_pedido,sin_iva FROM solicitud
       WHERE no_cotizacion=$1 AND origen_expo=true`, [folio]
    );
    if (!solRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "No encontrada" });
    }
    const sol = solRows[0];
    if (sol.estado !== "cotizacion") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Ya fue convertida a pedido" });
    }
    const folioPedido = await obtenerSiguienteFolioPedido(client);
    await client.query(`
      UPDATE solicitud_detalle SET aprobado=false
      WHERE solicitud_producto_id IN (
        SELECT idsolicitud_producto FROM solicitud_producto WHERE solicitud_idsolicitud=$1
      )`, [sol.idsolicitud]
    );
    const detalleIds = itemsAprobados
      .map((i: any) => i.idsolicitud_detalle)
      .filter((id: any) => id && id > 0);
    if (detalleIds.length > 0) {
      await client.query(
        `UPDATE solicitud_detalle SET aprobado=true WHERE idsolicitud_detalle=ANY($1::int[])`,
        [detalleIds]
      );
    }
    await client.query(`
      DELETE FROM solicitud_detalle
      WHERE solicitud_producto_id IN (
        SELECT idsolicitud_producto FROM solicitud_producto WHERE solicitud_idsolicitud=$1
      ) AND (aprobado IS NULL OR aprobado=false)`, [sol.idsolicitud]
    );
    const { rows: expoProds } = await client.query(`
      SELECT sp.idsolicitud_producto, COALESCE(sp.descripcion,'Producto expo') AS nombre_prod
      FROM solicitud_producto sp
      WHERE sp.solicitud_idsolicitud=$1 AND sp.tipo_material='expo'
        AND sp.configuracion_plastico_idconfiguracion_plastico IS NULL
        AND EXISTS (
          SELECT 1 FROM solicitud_detalle sd
          WHERE sd.solicitud_producto_id=sp.idsolicitud_producto AND sd.aprobado=true
        )`, [sol.idsolicitud]
    );
    const advertencias: string[] = [];
    for (const prod of expoProds) {
      const adv = await convertirProductoExpoASistema(client, prod.idsolicitud_producto, prod.nombre_prod);
      if (adv) advertencias.push(adv);
    }
    await client.query(`
      UPDATE solicitud SET estado='pedido', no_pedido=$1, fecha_aprobacion=NOW(),
        estado_administrativo_cat_idestado_administrativo_cat=$2
      WHERE idsolicitud=$3`,
      [folioPedido, ESTADO.APROBADO, sol.idsolicitud]
    );
    const { rows: stRows } = await client.query(`
      SELECT COALESCE(SUM(sd.precio_total),0) AS subtotal
      FROM solicitud_producto sp
      LEFT JOIN solicitud_detalle sd ON sd.solicitud_producto_id=sp.idsolicitud_producto
      WHERE sp.solicitud_idsolicitud=$1`, [sol.idsolicitud]
    );
    await crearVentaYDiseno(client, sol.idsolicitud, folioPedido, Number(stRows[0].subtotal), sol.sin_iva);
    await client.query("COMMIT");
    return res.json({
      message: "Cotización aprobada y convertida a pedido",
      no_pedido: folioPedido, no_cotizacion: folio,
      advertencias: advertencias.length > 0 ? advertencias : undefined,
    });
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error("❌ [EXPO] APROBAR:", e.message);
    return res.status(500).json({ error: e.message });
  } finally { client.release(); }
};

export const eliminarCotizacionExpo = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { folio } = req.params;
    await client.query("BEGIN");
    const { rows: solRows } = await client.query(
      `SELECT idsolicitud,estado FROM solicitud WHERE no_cotizacion=$1 AND origen_expo=true`, [folio]
    );
    if (!solRows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "No encontrada" }); }
    if (solRows[0].estado === "pedido") { await client.query("ROLLBACK"); return res.status(400).json({ error: "No se puede eliminar un pedido" }); }
    const solicitudId = solRows[0].idsolicitud;
    const { rows: prodRows } = await client.query(
      `SELECT idsolicitud_producto FROM solicitud_producto WHERE solicitud_idsolicitud=$1`, [solicitudId]
    );
    const ids = prodRows.map((r: any) => r.idsolicitud_producto);
    if (ids.length > 0) {
      await client.query(`DELETE FROM solicitud_producto_papel WHERE idsolicitud_producto=ANY($1::int[])`, [ids]);
      await client.query(`DELETE FROM solicitud_detalle WHERE solicitud_producto_id=ANY($1::int[])`, [ids]);
      await client.query(`DELETE FROM solicitud_producto WHERE solicitud_idsolicitud=$1`, [solicitudId]);
    }
    await client.query(`DELETE FROM solicitud WHERE idsolicitud=$1`, [solicitudId]);
    await client.query("COMMIT");
    return res.json({ message: "Cotización eliminada" });
  } catch (e: any) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e.message });
  } finally { client.release(); }
};