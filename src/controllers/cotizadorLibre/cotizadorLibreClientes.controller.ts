// src/controllers/cotizadorLibre/cotizadorLibreClientes.controller.ts
import { Request, Response } from "express";
import { pool } from "../../config/db";
import { enviarCorreo } from "../../services/email/mailer";
import crypto from "crypto";

// ==========================
// HELPERS — enmascarado
// ==========================
function enmascararCorreo(correo: string | null): string | null {
  if (!correo || !correo.includes("@")) return null;
  const [usuario, dominio] = correo.split("@");
  const primero = usuario.charAt(0);
  return `${primero}***@${dominio}`;
}

function enmascararTelefono(telefono: string | null): string | null {
  if (!telefono) return null;
  const limpio = telefono.replace(/\D/g, "");
  if (limpio.length < 4) return null;
  return `***${limpio.slice(-4)}`;
}

// ==========================
// HELPER — generar código de 6 dígitos
// ==========================
function generarCodigo(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

// ==========================
// 1. BUSCAR CLIENTE (emparejamiento sin exponer datos completos)
// ==========================
export const buscarClienteCotizadorLibre = async (req: Request, res: Response) => {
  try {
    const { empresa, rfc, telefono, correo } = req.body as {
      empresa?: string;
      rfc?: string;
      telefono?: string;
      correo?: string;
    };

    if (!empresa && !rfc && !telefono && !correo) {
      return res.status(400).json({
        error: "Captura al menos un dato (empresa, RFC, teléfono o correo).",
      });
    }

    const rfcNorm = rfc?.trim().toUpperCase() || null;
    const correoNorm = correo?.trim().toLowerCase() || null;
    const telefonoNorm = telefono?.replace(/\D/g, "") || null;
    const empresaNorm = empresa?.trim() || null;

    // El RFC del cliente (no el de su razón social — ese es clientes.rfc_rs,
    // otro dato) vive en datos_facturacion, ligado por clientes_idclientes.
    const { rows } = await pool.query(
      `SELECT c.idclientes, c.correo, c.telefono, c.celular, df.rfc, c.empresa
       FROM clientes c
       LEFT JOIN datos_facturacion df ON df.clientes_idclientes = c.idclientes
       WHERE ($1::text IS NOT NULL AND UPPER(df.rfc) = $1)
          OR ($2::text IS NOT NULL AND LOWER(c.correo) = $2)
          OR ($3::text IS NOT NULL AND (c.telefono = $3 OR c.celular = $3))
          OR ($4::text IS NOT NULL AND LOWER(c.empresa) = LOWER($4))
       ORDER BY
         CASE
           WHEN $1::text IS NOT NULL AND UPPER(df.rfc) = $1 THEN 1
           WHEN $2::text IS NOT NULL AND LOWER(c.correo) = $2 THEN 2
           WHEN $3::text IS NOT NULL AND (c.telefono = $3 OR c.celular = $3) THEN 3
           ELSE 4
         END
       LIMIT 1`,
      [rfcNorm, correoNorm, telefonoNorm, empresaNorm]
    );

    if (rows.length === 0) {
      return res.json({ match: false });
    }

    const cliente = rows[0];

    return res.json({
      match: true,
      cliente_id: cliente.idclientes,
      impresion: {
        correo_mask: enmascararCorreo(cliente.correo),
        telefono_mask: enmascararTelefono(cliente.telefono || cliente.celular),
      },
    });
  } catch (error: any) {
    console.error("❌ BUSCAR CLIENTE COTIZADOR LIBRE ERROR:", error.message);
    res.status(500).json({ error: "Error al buscar cliente" });
  }
};

// ==========================
// 2. ENVIAR CÓDIGO DE VERIFICACIÓN
// ==========================
export const enviarCodigoVerificacion = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { cliente_id } = req.body as { cliente_id?: number };

    if (!cliente_id || !Number.isInteger(cliente_id)) {
      return res.status(400).json({ error: "cliente_id inválido" });
    }

    const { rows: clienteRows } = await client.query(
      `SELECT idclientes, correo FROM clientes WHERE idclientes = $1 LIMIT 1`,
      [cliente_id]
    );

    if (clienteRows.length === 0) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    const correoDestino = clienteRows[0].correo;
    if (!correoDestino) {
      return res.status(404).json({ error: "El cliente no tiene correo registrado" });
    }

    // Evita spam de reenvíos: 1 solicitud por minuto por cliente
    const { rows: recienteRows } = await client.query(
      `SELECT creado_en FROM verificacion_cotizador_libre
       WHERE clientes_idclientes = $1
       ORDER BY creado_en DESC
       LIMIT 1`,
      [cliente_id]
    );

    if (recienteRows.length > 0) {
      const segundosDesdeUltimo =
        (Date.now() - new Date(recienteRows[0].creado_en).getTime()) / 1000;
      if (segundosDesdeUltimo < 60) {
        return res.status(429).json({
          error: `Espera ${Math.ceil(60 - segundosDesdeUltimo)} segundos antes de solicitar otro código.`,
        });
      }
    }

    await client.query("BEGIN");

    // Invalida cualquier código previo sin usar de este cliente
    await client.query(
      `UPDATE verificacion_cotizador_libre
       SET usado = true
       WHERE clientes_idclientes = $1 AND usado = false`,
      [cliente_id]
    );

    const codigo = generarCodigo();
    const expiraEn = new Date(Date.now() + 20 * 60 * 1000);

    await client.query(
      `INSERT INTO verificacion_cotizador_libre
        (clientes_idclientes, codigo, expira_en)
       VALUES ($1, $2, $3)`,
      [cliente_id, codigo, expiraEn]
    );

    await client.query("COMMIT");

    await enviarCorreo({
      para: correoDestino,
      asunto: "Tu código de verificación — Grupo EB",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 420px; margin: 0 auto;">
          <h2 style="color:#1e3a2b;">Grupo EB — Cotizador Interactivo</h2>
          <p>Tu código de verificación es:</p>
          <p style="font-size: 32px; font-weight: 800; letter-spacing: 4px; color:#1e3a2b;">${codigo}</p>
          <p style="color:#6b6f63; font-size: 13px;">Este código es válido por 20 minutos. Si tú no solicitaste esta cotización, puedes ignorar este correo.</p>
        </div>
      `,
    });

    console.log(`✅ Código de verificación enviado a cliente ${cliente_id}`);

    return res.json({ enviado: true, expira_en: expiraEn.toISOString() });
  } catch (error: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("❌ ENVIAR CODIGO VERIFICACION ERROR:", error.message);
    res.status(500).json({ error: "Error al enviar el código de verificación" });
  } finally {
    client.release();
  }
};

// ==========================
// 3. CONFIRMAR CÓDIGO DE VERIFICACIÓN
// ==========================
export const confirmarCodigoVerificacion = async (req: Request, res: Response) => {
  try {
    const { cliente_id, codigo } = req.body as { cliente_id?: number; codigo?: string };

    if (!cliente_id || !Number.isInteger(cliente_id) || !codigo) {
      return res.status(400).json({ error: "cliente_id y codigo son requeridos" });
    }

    const { rows } = await pool.query(
      `SELECT idverificacion_cotizador_libre, codigo, expira_en, intentos
       FROM verificacion_cotizador_libre
       WHERE clientes_idclientes = $1 AND usado = false
       ORDER BY creado_en DESC
       LIMIT 1`,
      [cliente_id]
    );

    if (rows.length === 0) {
      return res.json({ verificado: false, motivo: "sin_codigo_activo" });
    }

    const verificacion = rows[0];

    if (new Date(verificacion.expira_en).getTime() < Date.now()) {
      await pool.query(
        `UPDATE verificacion_cotizador_libre SET usado = true WHERE idverificacion_cotizador_libre = $1`,
        [verificacion.idverificacion_cotizador_libre]
      );
      return res.json({ verificado: false, motivo: "expirado" });
    }

    if (verificacion.intentos >= 5) {
      await pool.query(
        `UPDATE verificacion_cotizador_libre SET usado = true WHERE idverificacion_cotizador_libre = $1`,
        [verificacion.idverificacion_cotizador_libre]
      );
      return res.json({ verificado: false, motivo: "demasiados_intentos" });
    }

    if (verificacion.codigo !== codigo.trim()) {
      const { rows: updated } = await pool.query(
        `UPDATE verificacion_cotizador_libre
         SET intentos = intentos + 1
         WHERE idverificacion_cotizador_libre = $1
         RETURNING intentos`,
        [verificacion.idverificacion_cotizador_libre]
      );

      const intentosActuales = updated[0].intentos;

      if (intentosActuales >= 5) {
        await pool.query(
          `UPDATE verificacion_cotizador_libre SET usado = true WHERE idverificacion_cotizador_libre = $1`,
          [verificacion.idverificacion_cotizador_libre]
        );
        return res.json({ verificado: false, motivo: "demasiados_intentos" });
      }

      return res.json({
        verificado: false,
        motivo: "codigo_incorrecto",
        intentos_restantes: 5 - intentosActuales,
      });
    }

    await pool.query(
      `UPDATE verificacion_cotizador_libre SET usado = true WHERE idverificacion_cotizador_libre = $1`,
      [verificacion.idverificacion_cotizador_libre]
    );

    console.log(`✅ Cliente ${cliente_id} verificado correctamente`);

    return res.json({ verificado: true });
  } catch (error: any) {
    console.error("❌ CONFIRMAR CODIGO VERIFICACION ERROR:", error.message);
    res.status(500).json({ error: "Error al confirmar el código de verificación" });
  }
};