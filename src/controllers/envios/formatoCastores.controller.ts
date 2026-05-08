import { Request, Response } from "express";
import { pool } from "../../config/db";

export const getFormatoCastores = async (req: Request, res: Response) => {
  try {
    const { idenvio } = req.params;

    // ── Datos de Grupeb (remitente) ──
    const { rows: empresaRows } = await pool.query(`
      SELECT
        e.nombre_empresa,
        e.razon_social,
        e.rfc,
        e.regimen_fiscal,
        d.domicilio   AS calle,
        d.numero,
        d.colonia,
        d.codigo_postal,
        d.poblacion,
        d.estado,
        STRING_AGG(t.numero, ' / ' ORDER BY t.id_telefono) AS telefonos
      FROM empresa_empresa e
      LEFT JOIN direccion_empresa d ON d.id_empresa = e.id_empresa
      LEFT JOIN telefono_empresa  t ON t.id_empresa = e.id_empresa
      WHERE e.id_empresa = 1
      GROUP BY
        e.nombre_empresa, e.razon_social, e.rfc, e.regimen_fiscal,
        d.domicilio, d.numero, d.colonia, d.codigo_postal, d.poblacion, d.estado
      LIMIT 1
    `);

    if (empresaRows.length === 0)
      return res.status(500).json({ error: "No se encontraron datos de la empresa" });

    const empresa = empresaRows[0];

    // ── Datos del envío + cliente (destinatario) ──
    const { rows: envioRows } = await pool.query(`
      SELECT
        e.idenvio,
        e.tipo,
        e.estado,
        e.observaciones,
        e.fecha_envio,
        s.no_pedido,
        s.idsolicitud,
        cli.idclientes,
        cli.empresa,
        cli.razon_social      AS cli_razon_social,
        cli.impresion,
        cli.telefono          AS cli_telefono,
        cli.celular,
        rf.tipo_regimen       AS cli_regimen_fiscal,
        df.rfc                AS cli_rfc,
        df.uso_cfdi,
        COALESCE(de.domicilio,     dom.domicilio)     AS cli_calle,
        COALESCE(de.numero,        dom.numero)        AS cli_numero,
        COALESCE(de.colonia,       dom.colonia)       AS cli_colonia,
        COALESCE(de.codigo_postal, dom.codigo_postal) AS cli_cp,
        COALESCE(de.poblacion,     dom.poblacion)     AS cli_poblacion,
        COALESCE(de.estado,        dom.estado)        AS cli_estado,
        p.nombre AS paqueteria_nombre
      FROM envio e
      JOIN solicitud s         ON s.idsolicitud          = e.solicitud_idsolicitud
      JOIN clientes cli        ON cli.idclientes         = s.clientes_idclientes
      LEFT JOIN regimen_fiscal rf  ON rf.idregimen_fiscal = cli.regimen_fiscal_idregimen_fiscal
      LEFT JOIN datos_facturacion df ON df.clientes_idclientes = cli.idclientes
      LEFT JOIN domicilio dom   ON dom.clientes_idclientes = cli.idclientes
      LEFT JOIN direccion_envio de ON de.clientes_idclientes = cli.idclientes
      LEFT JOIN paqueteria p    ON p.idpaqueteria        = e.paqueteria_idpaqueteria
      WHERE e.idenvio = $1
      LIMIT 1
    `, [idenvio]);

    if (envioRows.length === 0)
      return res.status(404).json({ error: "Envío no encontrado" });

    const envio = envioRows[0];

    // ── Bultos del envío (incluye claves SAT guardadas) ──
    const { rows: bultosRows } = await pool.query(`
      SELECT
        b.idbulto,
        b.alto,
        b.largo,
        b.ancho,
        b.peso,
        b.peso_producto,
        b.cantidad_unidades,
        b.clave_producto_sat,
        b.clave_unidad_sat,
        tpp.material_plastico_producto AS nombre_producto,
        cfg.medida
      FROM envio_bulto eb
      JOIN bultos b ON b.idbulto = eb.bultos_idbulto
      LEFT JOIN bolseo bol ON bol.idbolseo = b.bolseo_idbolseo
      LEFT JOIN asa_flexible af ON af.idasa_flexible = b.asa_flexible_idasa_flexible
      LEFT JOIN orden_produccion op
        ON op.idproduccion = COALESCE(bol.orden_produccion_idproduccion, af.orden_produccion_idproduccion)
      LEFT JOIN solicitud_producto sp
        ON sp.idsolicitud_producto = op.idsolicitud_producto
      LEFT JOIN configuracion_plastico cfg
        ON cfg.idconfiguracion_plastico = sp.configuracion_plastico_idconfiguracion_plastico
      LEFT JOIN tipo_producto_plastico tpp
        ON tpp.idtipo_producto_plastico = cfg.tipo_producto_plastico_plastico_idtipo_producto_plastico
      WHERE eb.envio_idenvio = $1
      ORDER BY b.idbulto ASC
    `, [idenvio]);

    const dirRemitente = [
      `${empresa.calle} #${empresa.numero}`,
      empresa.colonia,
      empresa.poblacion,
      empresa.estado,
      `C.P. ${empresa.codigo_postal}`,
    ].filter(Boolean).join(", ");

    const dirDestinatario = [
      `${envio.cli_calle || ""} ${envio.cli_numero ? `#${envio.cli_numero}` : ""}`.trim(),
      envio.cli_colonia,
      envio.cli_poblacion,
      envio.cli_estado,
      envio.cli_cp ? `C.P. ${envio.cli_cp}` : null,
    ].filter(Boolean).join(", ");

    res.json({
      idenvio:    Number(idenvio),
      no_pedido:  envio.no_pedido,
      paqueteria: envio.paqueteria_nombre || "Castores",
      remitente: {
        razon_social:       empresa.razon_social,
        regimen_fiscal:     empresa.regimen_fiscal,
        rfc:                empresa.rfc             || "",
        calle:              empresa.calle           || "",
        numero:             empresa.numero          || "",
        colonia:            empresa.colonia         || "",
        codigo_postal:      empresa.codigo_postal   || "",
        poblacion:          empresa.poblacion       || "",
        estado:             empresa.estado          || "",
        telefono:           empresa.telefonos       || "",
        direccion_completa: dirRemitente,
      },
      destinatario: {
        razon_social:       envio.impresion || envio.cli_razon_social || envio.empresa || "",
        regimen_fiscal:     envio.cli_regimen_fiscal || "",
        rfc:                envio.cli_rfc            || "",
        calle:              envio.cli_calle          || "",
        numero:             envio.cli_numero         || "",
        colonia:            envio.cli_colonia        || "",
        codigo_postal:      envio.cli_cp             || "",
        poblacion:          envio.cli_poblacion      || "",
        estado:             envio.cli_estado         || "",
        telefono:           envio.cli_telefono       || "",
        uso_cfdi:           envio.uso_cfdi           || "",
        direccion_completa: dirDestinatario,
      },
      bultos: bultosRows.map((b: any) => ({
        idbulto:            Number(b.idbulto),
        nombre_producto:    b.nombre_producto  || "",
        medida:             b.medida           || "",
        alto:               b.alto  != null ? Number(b.alto)  : null,
        largo:              b.largo != null ? Number(b.largo) : null,
        ancho:              b.ancho != null ? Number(b.ancho) : null,
        peso:               b.peso  != null ? Number(b.peso)  : null,
        peso_producto:      b.peso_producto     != null ? Number(b.peso_producto)     : null,
        cantidad_unidades:  b.cantidad_unidades != null ? Number(b.cantidad_unidades) : null,
        clave_producto_sat: b.clave_producto_sat || "",
        clave_unidad_sat:   b.clave_unidad_sat   || "",
      })),
    });
  } catch (error: any) {
    console.error("❌ GET FORMATO CASTORES ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener datos del formato Castores" });
  }
};