import { Request, Response } from "express";
import { pool } from "../../config/db";

// ==========================
// CREAR CLIENTE
// ==========================
export const createCliente = async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const {
      empresa, correo, telefono, atencion, razon_social, rfc_rs, cp_rs, impresion, celular,
      regimen_fiscal_idregimen_fiscal, metodo_pago_idmetodo_pago, forma_pago_idforma_pago,
      rfc, correo_facturacion, uso_cfdi, moneda,
      domicilio, numero, colonia, codigo_postal, poblacion, estado,
      envio_domicilio, envio_numero, envio_colonia, envio_codigo_postal,
      envio_poblacion, envio_estado, envio_referencia,
    } = req.body;

    // ── Verificar RFC duplicado ANTES de iniciar la transacción ──
    if (rfc) {
      const rfcExistente = await pool.query(
        `SELECT c.idclientes, c.empresa
         FROM datos_facturacion df
         JOIN clientes c ON c.idclientes = df.clientes_idclientes
         WHERE df.rfc = $1
         LIMIT 1`,
        [rfc]
      );
      if ((rfcExistente.rowCount ?? 0) > 0) {
        const clienteExistente = rfcExistente.rows[0];
        return res.status(400).json({
          error: `El RFC "${rfc}" ya está registrado en el cliente "${clienteExistente.empresa || `#${clienteExistente.idclientes}`}"`,
        });
      }
    }

    // ── Verificar correo duplicado ANTES de iniciar la transacción ──
    if (correo) {
      const correoExistente = await pool.query(
        `SELECT idclientes, empresa FROM clientes WHERE correo = $1 LIMIT 1`,
        [correo]
      );
      if ((correoExistente.rowCount ?? 0) > 0) {
        const clienteExistente = correoExistente.rows[0];
        return res.status(400).json({
          error: `El correo "${correo}" ya está registrado en el cliente "${clienteExistente.empresa || `#${clienteExistente.idclientes}`}"`,
        });
      }
    }

    console.log("📝 Creando nuevo cliente:", { empresa, correo });

    await client.query("BEGIN");

    const identificar = await generarIdentificador(client);
    console.log("🔑 Identificador generado:", identificar);

    // 1. Insertar CLIENTE
    const resultCliente = await client.query(
      `INSERT INTO clientes (
        regimen_fiscal_idregimen_fiscal, metodo_pago_idmetodo_pago, forma_pago_idforma_pago,
        empresa, correo, telefono, atencion, razon_social, rfc_rs, cp_rs, impresion, celular, fecha, identificar
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CURRENT_TIMESTAMP,$13)
      RETURNING idclientes, empresa, correo, telefono, fecha, identificar`,
      [
        regimen_fiscal_idregimen_fiscal || null,
        metodo_pago_idmetodo_pago       || null,
        forma_pago_idforma_pago         || null,
        empresa      || null,
        correo       || null,
        telefono     || null,
        atencion     || null,
        razon_social || null,
        rfc_rs       || null,
        cp_rs        || null,
        impresion    || null,
        celular      || null,
        identificar,
      ]
    );

    const nuevoCliente = resultCliente.rows[0];
    const idclientes = nuevoCliente.idclientes;
    console.log("✅ Cliente creado:", { id: idclientes, empresa: nuevoCliente.empresa });

    // 2. Insertar DOMICILIO
    let iddomicilio = null;
    if (domicilio || numero || colonia || codigo_postal || poblacion || estado) {
      const resultDomicilio = await client.query(
        `INSERT INTO domicilio (clientes_idclientes, domicilio, numero, colonia, codigo_postal, poblacion, estado)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING iddomicilio`,
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

    // 3. Insertar DATOS_FACTURACION
    let iddatos_facturacion = null;
    if (rfc || correo_facturacion || uso_cfdi || moneda) {
      const resultFacturacion = await client.query(
        `INSERT INTO datos_facturacion (clientes_idclientes, rfc, correo_facturacion, uso_cfdi, moneda)
         VALUES ($1,$2,$3,$4,$5) RETURNING iddatos_facturacion`,
        [
          idclientes,
          rfc                || null,
          correo_facturacion || null,
          uso_cfdi           || null,
          moneda             || null,
        ]
      );
      iddatos_facturacion = resultFacturacion.rows[0].iddatos_facturacion;
      console.log("✅ Datos de facturación creados:", iddatos_facturacion);
    }

    // 4. Insertar DIRECCION_ENVIO
    let iddireccion_envio = null;
    const hayDatosEnvio = envio_domicilio || envio_numero || envio_colonia ||
      envio_codigo_postal || envio_poblacion || envio_estado || envio_referencia;
    if (hayDatosEnvio) {
      const resultEnvio = await client.query(
        `INSERT INTO direccion_envio (clientes_idclientes, domicilio, numero, colonia, codigo_postal, poblacion, estado, referencia)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING iddireccion`,
        [
          idclientes,
          envio_domicilio     || null,
          envio_numero        || null,
          envio_colonia       || null,
          envio_codigo_postal || null,
          envio_poblacion     || null,
          envio_estado        || null,
          envio_referencia    || null,
        ]
      );
      iddireccion_envio = resultEnvio.rows[0].iddireccion;
      console.log("✅ Dirección de envío creada:", iddireccion_envio);
    }

    await client.query("COMMIT");
    console.log("✅ Cliente creado exitosamente");

    res.status(201).json({
      message: "Cliente creado exitosamente",
      cliente: {
        id: idclientes,
        empresa: nuevoCliente.empresa,
        correo: nuevoCliente.correo,
        telefono: nuevoCliente.telefono,
        fecha: nuevoCliente.fecha,
        domicilio_id: iddomicilio,
        facturacion_id: iddatos_facturacion,
        direccion_envio_id: iddireccion_envio,
      },
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ CREATE CLIENTE ERROR:", error.message);

    // Por si acaso llega un duplicado que se escapó de la validación previa
    if (error.code === "23505") {
      if (error.constraint?.includes("rfc")) {
        return res.status(400).json({ error: "El RFC ingresado ya está registrado en otro cliente" });
      }
      if (error.constraint?.includes("correo")) {
        return res.status(400).json({ error: "El correo ingresado ya está registrado en otro cliente" });
      }
      return res.status(400).json({ error: "Ya existe un registro con esos datos" });
    }

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
        c.identificar,
        c.empresa,
        c.correo,
        c.telefono,
        c.atencion,
        c.razon_social,
        c.rfc_rs,
        c.cp_rs,
        c.impresion,
        c.celular,
        c.fecha,
        rf.tipo_regimen,
        rf.codigo  AS regimen_codigo,
        mp.tipo_pago,
        mp.codigo  AS metodo_codigo,
        fp.tipo_forma,
        fp.codigo  AS forma_codigo,
        df.rfc,
        df.correo_facturacion,
        df.uso_cfdi,
        df.moneda,
        d.domicilio,
        d.numero,
        d.colonia,
        d.codigo_postal,
        d.poblacion,
        d.estado,
        de.iddireccion       AS envio_id,
        de.domicilio         AS envio_domicilio,
        de.numero            AS envio_numero,
        de.colonia           AS envio_colonia,
        de.codigo_postal     AS envio_codigo_postal,
        de.poblacion         AS envio_poblacion,
        de.estado            AS envio_estado,
        de.referencia        AS envio_referencia
      FROM clientes c
      LEFT JOIN regimen_fiscal    rf ON c.regimen_fiscal_idregimen_fiscal = rf.idregimen_fiscal
      LEFT JOIN metodo_pago       mp ON c.metodo_pago_idmetodo_pago       = mp.idmetodo_pago
      LEFT JOIN forma_pago        fp ON c.forma_pago_idforma_pago         = fp.idforma_pago
      LEFT JOIN datos_facturacion df ON df.clientes_idclientes = c.idclientes
      LEFT JOIN domicilio          d ON d.clientes_idclientes  = c.idclientes
      LEFT JOIN direccion_envio   de ON de.clientes_idclientes = c.idclientes
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
        c.identificar,
        c.empresa,
        c.correo,
        c.telefono,
        c.atencion,
        c.razon_social,
        c.rfc_rs,
        c.cp_rs,
        c.impresion,
        c.celular,
        c.fecha,
        c.regimen_fiscal_idregimen_fiscal,
        c.metodo_pago_idmetodo_pago,
        c.forma_pago_idforma_pago,
        rf.tipo_regimen,
        rf.codigo  AS regimen_codigo,
        mp.tipo_pago,
        mp.codigo  AS metodo_codigo,
        fp.tipo_forma,
        fp.codigo  AS forma_codigo,
        df.rfc,
        df.correo_facturacion,
        df.uso_cfdi,
        df.moneda,
        d.domicilio,
        d.numero,
        d.colonia,
        d.codigo_postal,
        d.poblacion,
        d.estado,
        de.iddireccion       AS envio_id,
        de.domicilio         AS envio_domicilio,
        de.numero            AS envio_numero,
        de.colonia           AS envio_colonia,
        de.codigo_postal     AS envio_codigo_postal,
        de.poblacion         AS envio_poblacion,
        de.estado            AS envio_estado,
        de.referencia        AS envio_referencia
      FROM clientes c
      LEFT JOIN regimen_fiscal    rf ON c.regimen_fiscal_idregimen_fiscal = rf.idregimen_fiscal
      LEFT JOIN metodo_pago       mp ON c.metodo_pago_idmetodo_pago       = mp.idmetodo_pago
      LEFT JOIN forma_pago        fp ON c.forma_pago_idforma_pago         = fp.idforma_pago
      LEFT JOIN datos_facturacion df ON df.clientes_idclientes = c.idclientes
      LEFT JOIN domicilio          d ON d.clientes_idclientes  = c.idclientes
      LEFT JOIN direccion_envio   de ON de.clientes_idclientes = c.idclientes
      WHERE c.idclientes = $1
      LIMIT 1`,
      [id]
    );

    if ((result.rowCount ?? 0) === 0)
      return res.status(404).json({ error: "Cliente no encontrado" });

    res.json(result.rows[0]);
  } catch (error: any) {
    console.error("❌ GET CLIENTE BY ID ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener cliente" });
  }
};

export const searchClientes = async (req: Request, res: Response) => {
  try {
    const { query } = req.query;

    if (!query || typeof query !== "string" || query.trim() === "") {
      const result = await pool.query(`
        SELECT
          c.idclientes, c.empresa, c.correo, c.telefono,
          c.atencion, c.celular, c.razon_social, c.impresion,
          c.identificar
        FROM clientes c
        ORDER BY c.idclientes DESC
        LIMIT 50
      `);
      return res.json(result.rows);
    }

    const searchTerm = `%${query.trim()}%`;

    const result = await pool.query(
      `SELECT
        c.idclientes, c.empresa, c.correo, c.telefono,
        c.atencion, c.celular, c.razon_social, c.impresion,
        c.identificar
      FROM clientes c
      WHERE
        c.idclientes::text ILIKE $1 OR
        c.identificar      ILIKE $1 OR
        c.atencion         ILIKE $1 OR
        c.empresa          ILIKE $1 OR
        c.telefono         ILIKE $1 OR
        c.celular          ILIKE $1 OR
        c.correo           ILIKE $1 OR
        c.impresion        ILIKE $1
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
      empresa, correo, telefono, atencion, razon_social, rfc_rs, cp_rs, impresion, celular,
      regimen_fiscal_idregimen_fiscal, metodo_pago_idmetodo_pago, forma_pago_idforma_pago,
      rfc, correo_facturacion, uso_cfdi, moneda,
      domicilio, numero, colonia, codigo_postal, poblacion, estado,
      envio_domicilio, envio_numero, envio_colonia, envio_codigo_postal,
      envio_poblacion, envio_estado, envio_referencia,
    } = req.body;

    // ── Verificar RFC duplicado (excluyendo el cliente actual) ──
    if (rfc) {
      const rfcExistente = await pool.query(
        `SELECT c.idclientes, c.empresa
         FROM datos_facturacion df
         JOIN clientes c ON c.idclientes = df.clientes_idclientes
         WHERE df.rfc = $1 AND df.clientes_idclientes != $2
         LIMIT 1`,
        [rfc, id]
      );
      if ((rfcExistente.rowCount ?? 0) > 0) {
        const clienteExistente = rfcExistente.rows[0];
        return res.status(400).json({
          error: `El RFC "${rfc}" ya está registrado en el cliente "${clienteExistente.empresa || `#${clienteExistente.idclientes}`}"`,
        });
      }
    }

    // ── Verificar correo duplicado (excluyendo el cliente actual) ──
    if (correo) {
      const correoExistente = await pool.query(
        `SELECT idclientes, empresa FROM clientes WHERE correo = $1 AND idclientes != $2 LIMIT 1`,
        [correo, id]
      );
      if ((correoExistente.rowCount ?? 0) > 0) {
        const clienteExistente = correoExistente.rows[0];
        return res.status(400).json({
          error: `El correo "${correo}" ya está registrado en el cliente "${clienteExistente.empresa || `#${clienteExistente.idclientes}`}"`,
        });
      }
    }

    console.log("📝 Actualizando cliente:", id);

    await client.query("BEGIN");

    const clienteActual = await client.query(
      "SELECT idclientes FROM clientes WHERE idclientes = $1 LIMIT 1", [id]
    );
    if ((clienteActual.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    const domicilioExistente = await client.query(
      "SELECT iddomicilio FROM domicilio WHERE clientes_idclientes = $1 LIMIT 1", [id]
    );
    const facturacionExistente = await client.query(
      "SELECT iddatos_facturacion FROM datos_facturacion WHERE clientes_idclientes = $1 LIMIT 1", [id]
    );
    const envioExistente = await client.query(
      "SELECT iddireccion FROM direccion_envio WHERE clientes_idclientes = $1 LIMIT 1", [id]
    );

    // 1. DOMICILIO — update o insert
    if (domicilio || numero || colonia || codigo_postal || poblacion || estado) {
      if ((domicilioExistente.rowCount ?? 0) > 0) {
        await client.query(
          `UPDATE domicilio
           SET domicilio=$1, numero=$2, colonia=$3, codigo_postal=$4, poblacion=$5, estado=$6
           WHERE iddomicilio=$7`,
          [
            domicilio     || null,
            numero        || null,
            colonia       || null,
            codigo_postal || null,
            poblacion     || null,
            estado        || null,
            domicilioExistente.rows[0].iddomicilio,
          ]
        );
      } else {
        await client.query(
          `INSERT INTO domicilio (clientes_idclientes, domicilio, numero, colonia, codigo_postal, poblacion, estado)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
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
      }
    }

    // 2. DATOS_FACTURACION — update o insert
    if (rfc || correo_facturacion || uso_cfdi || moneda) {
      if ((facturacionExistente.rowCount ?? 0) > 0) {
        await client.query(
          `UPDATE datos_facturacion
           SET rfc=$1, correo_facturacion=$2, uso_cfdi=$3, moneda=$4
           WHERE iddatos_facturacion=$5`,
          [
            rfc                || null,
            correo_facturacion || null,
            uso_cfdi           || null,
            moneda             || null,
            facturacionExistente.rows[0].iddatos_facturacion,
          ]
        );
      } else {
        await client.query(
          `INSERT INTO datos_facturacion (clientes_idclientes, rfc, correo_facturacion, uso_cfdi, moneda)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            id,
            rfc                || null,
            correo_facturacion || null,
            uso_cfdi           || null,
            moneda             || null,
          ]
        );
      }
    }

    // 3. DIRECCION_ENVIO — update o insert
    const hayDatosEnvio = envio_domicilio || envio_numero || envio_colonia ||
      envio_codigo_postal || envio_poblacion || envio_estado || envio_referencia;
    if (hayDatosEnvio) {
      if ((envioExistente.rowCount ?? 0) > 0) {
        await client.query(
          `UPDATE direccion_envio
           SET domicilio=$1, numero=$2, colonia=$3, codigo_postal=$4, poblacion=$5, estado=$6, referencia=$7
           WHERE iddireccion=$8`,
          [
            envio_domicilio     || null,
            envio_numero        || null,
            envio_colonia       || null,
            envio_codigo_postal || null,
            envio_poblacion     || null,
            envio_estado        || null,
            envio_referencia    || null,
            envioExistente.rows[0].iddireccion,
          ]
        );
      } else {
        await client.query(
          `INSERT INTO direccion_envio (clientes_idclientes, domicilio, numero, colonia, codigo_postal, poblacion, estado, referencia)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            envio_domicilio     || null,
            envio_numero        || null,
            envio_colonia       || null,
            envio_codigo_postal || null,
            envio_poblacion     || null,
            envio_estado        || null,
            envio_referencia    || null,
          ]
        );
      }
    }

    // 4. CLIENTE principal
    const resultCliente = await client.query(
      `UPDATE clientes
       SET empresa      = $1,
           correo       = $2,
           telefono     = $3,
           atencion     = $4,
           razon_social = $5,
           rfc_rs       = $6,
           cp_rs        = $7,
           impresion    = $8,
           celular      = $9,
           regimen_fiscal_idregimen_fiscal = $10,
           metodo_pago_idmetodo_pago       = $11,
           forma_pago_idforma_pago         = $12
       WHERE idclientes = $13
       RETURNING idclientes, empresa, correo, telefono, fecha`,
      [
        empresa      || null,
        correo       || null,
        telefono     || null,
        atencion     || null,
        razon_social || null,
        rfc_rs       || null,
        cp_rs        || null,
        impresion    || null,
        celular      || null,
        regimen_fiscal_idregimen_fiscal || null,
        metodo_pago_idmetodo_pago       || null,
        forma_pago_idforma_pago         || null,
        id,
      ]
    );

    await client.query("COMMIT");
    console.log("✅ Cliente actualizado exitosamente");

    const clienteActualizado = resultCliente.rows[0];
    res.json({
      message: "Cliente actualizado exitosamente",
      cliente: {
        id: clienteActualizado.idclientes,
        empresa: clienteActualizado.empresa,
        correo: clienteActualizado.correo,
        telefono: clienteActualizado.telefono,
        fecha: clienteActualizado.fecha,
      },
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ UPDATE CLIENTE ERROR:", error.message);

    if (error.code === "23505") {
      if (error.constraint?.includes("rfc")) {
        return res.status(400).json({ error: "El RFC ingresado ya está registrado en otro cliente" });
      }
      if (error.constraint?.includes("correo")) {
        return res.status(400).json({ error: "El correo ingresado ya está registrado en otro cliente" });
      }
      return res.status(400).json({ error: "Ya existe un registro con esos datos" });
    }

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
      "SELECT idclientes FROM clientes WHERE idclientes = $1 LIMIT 1", [id]
    );
    if ((clienteActual.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    await client.query("DELETE FROM direccion_envio   WHERE clientes_idclientes = $1", [id]);
    await client.query("DELETE FROM domicilio         WHERE clientes_idclientes = $1", [id]);
    await client.query("DELETE FROM datos_facturacion WHERE clientes_idclientes = $1", [id]);
    await client.query("DELETE FROM clientes          WHERE idclientes          = $1", [id]);

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

    const identificar = await generarIdentificador(client);

    const resultCliente = await client.query(
      `INSERT INTO clientes (
        regimen_fiscal_idregimen_fiscal, metodo_pago_idmetodo_pago, forma_pago_idforma_pago,
        empresa, correo, telefono, atencion, fecha, identificar
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP,$8)
      RETURNING idclientes, empresa, correo, telefono, atencion, identificar`,
      [null, null, null, empresa || null, correo || null, telefono || null, nombre || null, identificar]
    );

    const nuevoCliente = resultCliente.rows[0];
    await client.query("COMMIT");
    console.log("✅ Cliente ligero creado:", { id: nuevoCliente.idclientes });

    res.status(201).json({
      message: "Cliente creado exitosamente",
      cliente: {
        id: nuevoCliente.idclientes,
        identificar: nuevoCliente.identificar,
        nombre: nuevoCliente.atencion,
        empresa: nuevoCliente.empresa,
        correo: nuevoCliente.correo,
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

// ==========================
// HELPER: Generar identificador
// ==========================
const generarIdentificador = async (client: any): Promise<string> => {
  const result = await client.query(
    `SELECT identificar FROM clientes
     WHERE identificar ~ '^[0-9]+$'
     ORDER BY CAST(identificar AS INTEGER) DESC
     LIMIT 1`
  );

  let nextNum = 600;
  if (result.rowCount > 0) {
    const lastNum = parseInt(result.rows[0].identificar, 10);
    if (!isNaN(lastNum) && lastNum >= 600) nextNum = lastNum + 1;
  }

  return String(nextNum);
};