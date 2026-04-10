import { Request, Response } from "express";
import { pool } from "../../config/db";

// ==========================
// CREAR CLIENTE
// ==========================
export const createCliente = async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const {
      empresa,
      correo,
      telefono,
      atencion,
      razon_social,
      impresion,
      celular,
      regimen_fiscal_idregimen_fiscal,
      metodo_pago_idmetodo_pago,
      forma_pago_idforma_pago,
      rfc,
      correo_facturacion,
      uso_cfdi,
      moneda,
      domicilio,
      numero,
      colonia,
      codigo_postal,
      poblacion,
      estado,
    } = req.body;

    console.log("📝 Creando nuevo cliente:", { empresa, correo });

    await client.query("BEGIN");

    // 1. Insertar CLIENTE
    // Las tres FK pueden ser null si el usuario no seleccionó nada
    const resultCliente = await client.query(
      `INSERT INTO clientes (
        regimen_fiscal_idregimen_fiscal,
        metodo_pago_idmetodo_pago,
        forma_pago_idforma_pago,
        empresa,
        correo,
        telefono,
        atencion,
        razon_social,
        impresion,
        celular,
        fecha
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
      RETURNING idclientes, empresa, correo, telefono, fecha`,
      [
        regimen_fiscal_idregimen_fiscal || null,
        metodo_pago_idmetodo_pago       || null,
        forma_pago_idforma_pago         || null,
        empresa      || null,
        correo       || null,
        telefono     || null,
        atencion     || null,
        razon_social || null,
        impresion    || null,
        celular      || null,
      ]
    );

    const nuevoCliente = resultCliente.rows[0];
    const idclientes   = nuevoCliente.idclientes;

    console.log("✅ Cliente creado:", { id: idclientes, empresa: nuevoCliente.empresa });

    // 2. Insertar DOMICILIO (solo si hay algún dato)
    let iddomicilio = null;
    if (domicilio || numero || colonia || codigo_postal || poblacion || estado) {
      const resultDomicilio = await client.query(
        `INSERT INTO domicilio (clientes_idclientes, domicilio, numero, colonia, codigo_postal, poblacion, estado)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING iddomicilio`,
        [
          idclientes,
          domicilio     || null,
          numero        || null,
          colonia       || null,
          codigo_postal || null,
          poblacion     || null,
          estado        || null,
        ]
      );
      iddomicilio = resultDomicilio.rows[0].iddomicilio;
      console.log("✅ Domicilio creado:", iddomicilio);
    }

    // 3. Insertar DATOS_FACTURACION (solo si hay algún dato)
    let iddatos_facturacion = null;
    if (rfc || correo_facturacion || uso_cfdi || moneda) {
      const resultFacturacion = await client.query(
        `INSERT INTO datos_facturacion (clientes_idclientes, rfc, correo_facturacion, uso_cfdi, moneda)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING iddatos_facturacion`,
        [idclientes, rfc || null, correo_facturacion || null, uso_cfdi || null, moneda || null]
      );
      iddatos_facturacion = resultFacturacion.rows[0].iddatos_facturacion;
      console.log("✅ Datos de facturación creados:", iddatos_facturacion);
    }

    await client.query("COMMIT");

    console.log("✅ Cliente creado exitosamente");

    res.status(201).json({
      message: "Cliente creado exitosamente",
      cliente: {
        id:            nuevoCliente.idclientes,
        empresa:       nuevoCliente.empresa,
        correo:        nuevoCliente.correo,
        telefono:      nuevoCliente.telefono,
        fecha:         nuevoCliente.fecha,
        domicilio_id:  iddomicilio,
        facturacion_id: iddatos_facturacion,
      },
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ CREATE CLIENTE ERROR:", error.message);
    res.status(500).json({ error: "Error al procesar la solicitud" });
  } finally {
    client.release();
  }
};

// ==========================
// OBTENER TODOS LOS CLIENTES
// ==========================
export const getClientes = async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT 
        c.idclientes,
        c.empresa,
        c.correo,
        c.telefono,
        c.atencion,
        c.razon_social,
        c.impresion,
        c.celular,
        c.fecha,
        rf.tipo_regimen,
        rf.codigo as regimen_codigo,
        mp.tipo_pago,
        mp.codigo as metodo_codigo,
        fp.tipo_forma,
        fp.codigo as forma_codigo,
        df.rfc,
        df.correo_facturacion,
        df.uso_cfdi,
        df.moneda,
        d.domicilio,
        d.numero,
        d.colonia,
        d.codigo_postal,
        d.poblacion,
        d.estado
      FROM clientes c
      LEFT JOIN regimen_fiscal rf ON c.regimen_fiscal_idregimen_fiscal = rf.idregimen_fiscal
      LEFT JOIN metodo_pago    mp ON c.metodo_pago_idmetodo_pago       = mp.idmetodo_pago
      LEFT JOIN forma_pago     fp ON c.forma_pago_idforma_pago         = fp.idforma_pago
      LEFT JOIN datos_facturacion df ON df.clientes_idclientes = c.idclientes
      LEFT JOIN domicilio          d  ON d.clientes_idclientes  = c.idclientes
      ORDER BY c.idclientes DESC
      LIMIT 1000
    `);

    res.json(result.rows);
  } catch (error: any) {
    console.error("❌ GET CLIENTES ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener clientes" });
  }
};

// ==========================
// OBTENER CLIENTE POR ID
// ==========================
export const getClienteById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT 
        c.idclientes,
        c.empresa,
        c.correo,
        c.telefono,
        c.atencion,
        c.razon_social,
        c.impresion,
        c.celular,
        c.fecha,
        c.regimen_fiscal_idregimen_fiscal,
        c.metodo_pago_idmetodo_pago,
        c.forma_pago_idforma_pago,
        rf.tipo_regimen,
        rf.codigo as regimen_codigo,
        mp.tipo_pago,
        mp.codigo as metodo_codigo,
        fp.tipo_forma,
        fp.codigo as forma_codigo,
        df.rfc,
        df.correo_facturacion,
        df.uso_cfdi,
        df.moneda,
        d.domicilio,
        d.numero,
        d.colonia,
        d.codigo_postal,
        d.poblacion,
        d.estado
      FROM clientes c
      LEFT JOIN regimen_fiscal rf ON c.regimen_fiscal_idregimen_fiscal = rf.idregimen_fiscal
      LEFT JOIN metodo_pago    mp ON c.metodo_pago_idmetodo_pago       = mp.idmetodo_pago
      LEFT JOIN forma_pago     fp ON c.forma_pago_idforma_pago         = fp.idforma_pago
      LEFT JOIN datos_facturacion df ON df.clientes_idclientes = c.idclientes
      LEFT JOIN domicilio          d  ON d.clientes_idclientes  = c.idclientes
      WHERE c.idclientes = $1
      LIMIT 1`,
      [id]
    );

    if ((result.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error: any) {
    console.error("❌ GET CLIENTE BY ID ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener cliente" });
  }
};

// ==========================
// BUSCAR CLIENTES (CON FILTROS)
// ==========================
export const searchClientes = async (req: Request, res: Response) => {
  try {
    const { query } = req.query;

    if (!query || typeof query !== "string" || query.trim() === "") {
      const result = await pool.query(`
        SELECT 
          c.idclientes,
          c.empresa,
          c.correo,
          c.telefono,
          c.atencion,
          c.celular,
          c.razon_social,
          c.impresion
        FROM clientes c
        ORDER BY c.idclientes DESC
        LIMIT 50
      `);
      return res.json(result.rows);
    }

    const searchTerm = `%${query.trim()}%`;

    const result = await pool.query(
      `SELECT 
        c.idclientes,
        c.empresa,
        c.correo,
        c.telefono,
        c.atencion,
        c.celular,
        c.razon_social,
        c.impresion
      FROM clientes c
      WHERE 
        c.idclientes::text ILIKE $1 OR
        c.atencion   ILIKE $1 OR
        c.empresa    ILIKE $1 OR
        c.telefono   ILIKE $1 OR
        c.celular    ILIKE $1 OR
        c.correo     ILIKE $1 OR
        c.impresion  ILIKE $1
      ORDER BY c.idclientes DESC
      LIMIT 50`,
      [searchTerm]
    );

    res.json(result.rows);
  } catch (error: any) {
    console.error("❌ SEARCH CLIENTES ERROR:", error.message);
    res.status(500).json({ error: "Error al buscar clientes" });
  }
};

// ==========================
// ACTUALIZAR CLIENTE
// ==========================
export const updateCliente = async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const {
      empresa,
      correo,
      telefono,
      atencion,
      razon_social,
      impresion,
      celular,
      regimen_fiscal_idregimen_fiscal,
      metodo_pago_idmetodo_pago,
      forma_pago_idforma_pago,
      rfc,
      correo_facturacion,
      uso_cfdi,
      moneda,
      domicilio,
      numero,
      colonia,
      codigo_postal,
      poblacion,
      estado,
    } = req.body;

    console.log("📝 Actualizando cliente:", id);

    await client.query("BEGIN");

    const clienteActual = await client.query(
      "SELECT idclientes FROM clientes WHERE idclientes = $1 LIMIT 1",
      [id]
    );

    if ((clienteActual.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    const domicilioExistente = await client.query(
      "SELECT iddomicilio FROM domicilio WHERE clientes_idclientes = $1 LIMIT 1",
      [id]
    );

    const facturacionExistente = await client.query(
      "SELECT iddatos_facturacion FROM datos_facturacion WHERE clientes_idclientes = $1 LIMIT 1",
      [id]
    );

    // 1. ACTUALIZAR O CREAR DOMICILIO
    let iddomicilio = null;
    if (domicilio || numero || colonia || codigo_postal || poblacion || estado) {
      if ((domicilioExistente.rowCount ?? 0) > 0) {
        iddomicilio = domicilioExistente.rows[0].iddomicilio;
        await client.query(
          `UPDATE domicilio 
           SET domicilio = $1, numero = $2, colonia = $3, 
               codigo_postal = $4, poblacion = $5, estado = $6
           WHERE iddomicilio = $7`,
          [
            domicilio     || null,
            numero        || null,
            colonia       || null,
            codigo_postal || null,
            poblacion     || null,
            estado        || null,
            iddomicilio,
          ]
        );
        console.log("✅ Domicilio actualizado:", iddomicilio);
      } else {
        const resultDomicilio = await client.query(
          `INSERT INTO domicilio (clientes_idclientes, domicilio, numero, colonia, codigo_postal, poblacion, estado)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING iddomicilio`,
          [
            id,
            domicilio     || null,
            numero        || null,
            colonia       || null,
            codigo_postal || null,
            poblacion     || null,
            estado        || null,
          ]
        );
        iddomicilio = resultDomicilio.rows[0].iddomicilio;
        console.log("✅ Domicilio creado:", iddomicilio);
      }
    }

    // 2. ACTUALIZAR O CREAR DATOS_FACTURACION
    let iddatos_facturacion = null;
    if (rfc || correo_facturacion || uso_cfdi || moneda) {
      if ((facturacionExistente.rowCount ?? 0) > 0) {
        iddatos_facturacion = facturacionExistente.rows[0].iddatos_facturacion;
        await client.query(
          `UPDATE datos_facturacion 
           SET rfc = $1, correo_facturacion = $2, uso_cfdi = $3, moneda = $4
           WHERE iddatos_facturacion = $5`,
          [rfc || null, correo_facturacion || null, uso_cfdi || null, moneda || null, iddatos_facturacion]
        );
        console.log("✅ Datos de facturación actualizados:", iddatos_facturacion);
      } else {
        const resultFacturacion = await client.query(
          `INSERT INTO datos_facturacion (clientes_idclientes, rfc, correo_facturacion, uso_cfdi, moneda)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING iddatos_facturacion`,
          [id, rfc || null, correo_facturacion || null, uso_cfdi || null, moneda || null]
        );
        iddatos_facturacion = resultFacturacion.rows[0].iddatos_facturacion;
        console.log("✅ Datos de facturación creados:", iddatos_facturacion);
      }
    }

    // 3. ACTUALIZAR CLIENTE
    const resultCliente = await client.query(
      `UPDATE clientes 
       SET empresa       = $1,
           correo        = $2,
           telefono      = $3,
           atencion      = $4,
           razon_social  = $5,
           impresion     = $6,
           celular       = $7,
           regimen_fiscal_idregimen_fiscal = $8,
           metodo_pago_idmetodo_pago       = $9,
           forma_pago_idforma_pago         = $10
       WHERE idclientes = $11
       RETURNING idclientes, empresa, correo, telefono, fecha`,
      [
        empresa      || null,
        correo       || null,
        telefono     || null,
        atencion     || null,
        razon_social || null,
        impresion    || null,
        celular      || null,
        regimen_fiscal_idregimen_fiscal || null,
        metodo_pago_idmetodo_pago       || null,
        forma_pago_idforma_pago         || null,
        id,
      ]
    );

    const clienteActualizado = resultCliente.rows[0];

    await client.query("COMMIT");

    console.log("✅ Cliente actualizado exitosamente");

    res.json({
      message: "Cliente actualizado exitosamente",
      cliente: {
        id:       clienteActualizado.idclientes,
        empresa:  clienteActualizado.empresa,
        correo:   clienteActualizado.correo,
        telefono: clienteActualizado.telefono,
        fecha:    clienteActualizado.fecha,
      },
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ UPDATE CLIENTE ERROR:", error.message);
    res.status(500).json({ error: "Error al procesar la solicitud" });
  } finally {
    client.release();
  }
};

// ==========================
// ELIMINAR CLIENTE
// ==========================
export const deleteCliente = async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    await client.query("BEGIN");

    const clienteActual = await client.query(
      "SELECT idclientes FROM clientes WHERE idclientes = $1 LIMIT 1",
      [id]
    );

    if ((clienteActual.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    const resultDomicilio = await client.query(
      "DELETE FROM domicilio WHERE clientes_idclientes = $1 RETURNING iddomicilio",
      [id]
    );
    if ((resultDomicilio.rowCount ?? 0) > 0) {
      console.log("✅ Domicilio eliminado:", resultDomicilio.rows[0].iddomicilio);
    }

    const resultFacturacion = await client.query(
      "DELETE FROM datos_facturacion WHERE clientes_idclientes = $1 RETURNING iddatos_facturacion",
      [id]
    );
    if ((resultFacturacion.rowCount ?? 0) > 0) {
      console.log("✅ Datos de facturación eliminados:", resultFacturacion.rows[0].iddatos_facturacion);
    }

    await client.query("DELETE FROM clientes WHERE idclientes = $1", [id]);

    await client.query("COMMIT");

    console.log("✅ Cliente eliminado:", id);

    res.json({ message: "Cliente eliminado exitosamente" });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ DELETE CLIENTE ERROR:", error.message);
    res.status(500).json({ error: "Error al procesar la solicitud" });
  } finally {
    client.release();
  }
};

// ==========================
// CREAR CLIENTE LIGERO (PARA COTIZACIÓN)
// ==========================
export const createClienteLigero = async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const { nombre, telefono, correo, empresa } = req.body;

    console.log("📝 Creando cliente ligero para cotización:", { nombre, correo });

    await client.query("BEGIN");

    const resultCliente = await client.query(
      `INSERT INTO clientes (
        regimen_fiscal_idregimen_fiscal,
        metodo_pago_idmetodo_pago,
        forma_pago_idforma_pago,
        empresa,
        correo,
        telefono,
        atencion,
        fecha
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
      RETURNING idclientes, empresa, correo, telefono, atencion`,
      [
        null, // FK opcionales
        null,
        null,
        empresa  || null,
        correo   || null,
        telefono || null,
        nombre   || null,
      ]
    );

    const nuevoCliente = resultCliente.rows[0];

    await client.query("COMMIT");

    console.log("✅ Cliente ligero creado:", { id: nuevoCliente.idclientes });

    res.status(201).json({
      message: "Cliente creado exitosamente",
      cliente: {
        id:       nuevoCliente.idclientes,
        nombre:   nuevoCliente.atencion,
        empresa:  nuevoCliente.empresa,
        correo:   nuevoCliente.correo,
        telefono: nuevoCliente.telefono,
      },
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ CREATE CLIENTE LIGERO ERROR:", error.message);
    res.status(500).json({ error: "Error al procesar la solicitud" });
  } finally {
    client.release();
  }
};