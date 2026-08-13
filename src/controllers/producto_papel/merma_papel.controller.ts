// src/controllers/producto_papel/merma_papel.controller.ts
// ═══════════════════════════════════════════════════════════════════════════
// CRUD de la matriz de merma + consulta y recálculo del snapshot por orden.
// Espejo estructural de precios_acabados_papel.controller.ts.
// ═══════════════════════════════════════════════════════════════════════════

import { iniciarTx, qAudit } from "../../middlewares/auditoria";
import type { Request, Response } from "express";
import { pool } from "../../config/db";
import {
  ErrorMermaPapel,
  calcularMerma,
  calcularMermaDeOrden,
  getEscalasMerma,
  getMermaOrden,
  recalcularMermaOrden,
  resolverEscalaMerma,
  usuarioTieneAccesoTotal,
} from "../../services/producto_papel/merma.service";

const idValido = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Piezas de merma: entero >= 0, o null si la celda se deja vacía. */
const piezasValidas = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** Extrae el usuario de la request sin casarse con un solo middleware de auth. */
const getUsuarioId = (req: Request): number | null => {
  const raw =
    (req as any).usuario?.idusuario ??
    (req as any).user?.idusuario ??
    (req as any).usuarioId ??
    null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const manejarError = (res: Response, error: any, fallback: string) => {
  if (error instanceof ErrorMermaPapel) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  console.error("[MERMA PAPEL]", error?.message || error);
  return res.status(500).json({ error: error?.message || fallback });
};

// ═══════════════════════════════════════════════════════════════════════════
// MATRIZ
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Devuelve la matriz completa: columnas (procesos), filas (escalas) y celdas.
 * A diferencia de precios de acabados, aquí no hay selector previo — es una
 * sola tabla, así que se entrega de una vez.
 */
export const getMatrizMermaPapel = async (_req: Request, res: Response) => {
  try {
    const [{ rows: procesos }, { rows: escalas }, { rows: celdas }] = await Promise.all([
      pool.query(`
        SELECT
          cpm.idcat_proceso_merma AS id,
          cpm.clave, cpm.nombre, cpm.idproceso_cat,
          cpm.siempre_aplica, cpm.activo, cpm.orden,
          pc.nombre_proceso
        FROM cat_proceso_merma cpm
        LEFT JOIN proceso_cat pc ON pc.idproceso_cat = cpm.idproceso_cat
        ORDER BY cpm.orden, cpm.idcat_proceso_merma
      `),
      pool.query(`
        SELECT idcat_escala_merma AS id, cantidad, activo, orden
        FROM cat_escala_merma
        ORDER BY orden, cantidad
      `),
      pool.query(`
        SELECT
          idmerma_config AS id,
          idcat_proceso_merma AS id_proceso,
          idcat_escala_merma AS id_escala,
          piezas, activo
        FROM merma_config
      `),
    ]);

    const mapa = new Map<string, any>();
    celdas.forEach((c: any) => mapa.set(`${c.id_escala}:${c.id_proceso}`, c));

    // Una fila por escala; dentro, un objeto indexado por id de proceso.
    const filas = escalas.map((e: any) => ({
      idEscala: Number(e.id),
      cantidad: Number(e.cantidad),
      activo: e.activo,
      orden: Number(e.orden),
      celdas: Object.fromEntries(
        procesos.map((p: any) => {
          const celda = mapa.get(`${e.id}:${p.id}`);
          return [
            String(p.id),
            {
              id: celda?.id ?? null,
              piezas: celda?.piezas == null ? null : Number(celda.piezas),
              activo: celda?.activo ?? true,
            },
          ];
        })
      ),
    }));

    return res.json({
      procesos: procesos.map((p: any) => ({
        ...p,
        id: Number(p.id),
        // El frontend usa esto para marcar la columna Empalmadora como
        // "preparada pero sin efecto" en vez de que parezca funcional.
        inerte: p.siempre_aplica === false && p.idproceso_cat == null,
      })),
      escalas: escalas.map((e: any) => ({ ...e, id: Number(e.id), cantidad: Number(e.cantidad) })),
      filas,
    });
  } catch (error: any) {
    return manejarError(res, error, "No se pudo cargar la matriz de merma");
  }
};

/**
 * Upsert por lotes. Mismo patrón que updateMatrizPreciosAcabadoPapel:
 * se valida todo dentro de la transacción y cualquier celda inválida
 * hace ROLLBACK de todo el lote.
 */
export const updateMatrizMermaPapel = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const celdas = Array.isArray(req.body?.celdas) ? req.body.celdas : [];
    if (!celdas.length) return res.status(400).json({ error: "No se recibieron celdas" });

    await iniciarTx(req, client);

    for (const celda of celdas) {
      const idProceso = idValido(celda.idProceso);
      const idEscala = idValido(celda.idEscala);

      if (!idProceso || !idEscala) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Una celda contiene IDs inválidos" });
      }

      const piezas = piezasValidas(celda.piezas);
      const vacia = celda.piezas === null || celda.piezas === undefined || celda.piezas === "";

      if (!vacia && piezas === null) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "La merma debe ser un número entero mayor o igual a cero (son piezas, no porcentaje)",
        });
      }

      await client.query(
        `
        INSERT INTO merma_config (
          idcat_proceso_merma, idcat_escala_merma, piezas, activo, updated_at
        )
        VALUES ($1,$2,$3,TRUE,CURRENT_TIMESTAMP)
        ON CONFLICT (idcat_proceso_merma, idcat_escala_merma)
        DO UPDATE SET
          piezas = EXCLUDED.piezas,
          activo = TRUE,
          updated_at = CURRENT_TIMESTAMP
        `,
        [idProceso, idEscala, piezas]
      );
    }

    await client.query("COMMIT");
    return res.json({
      message: "Matriz de merma actualizada correctamente",
      actualizadas: celdas.length,
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    return manejarError(res, error, "No se pudo actualizar la matriz de merma");
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ESCALAS
// ═══════════════════════════════════════════════════════════════════════════

export const createEscalaMerma = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const cantidad = idValido(req.body?.cantidad);
    if (!cantidad) return res.status(400).json({ error: "Cantidad inválida" });

    await iniciarTx(req, client);

    const { rows: ordenRows } = await client.query(
      `SELECT COALESCE(MAX(orden),0)+1 AS siguiente FROM cat_escala_merma`
    );

    const { rows } = await client.query(
      `
      INSERT INTO cat_escala_merma (cantidad, orden, activo, updated_at)
      VALUES ($1,$2,TRUE,CURRENT_TIMESTAMP)
      ON CONFLICT (cantidad)
      DO UPDATE SET activo=TRUE, updated_at=CURRENT_TIMESTAMP
      RETURNING idcat_escala_merma AS id, cantidad, activo, orden
      `,
      [cantidad, Number(ordenRows[0].siguiente)]
    );

    const escala = rows[0];

    // Sembrar la columna completa para la escala nueva, igual que hace
    // createEscalaCostoPapel. Sin esto, la fila nueva saldría sin celdas.
    await client.query(
      `
      INSERT INTO merma_config (idcat_proceso_merma, idcat_escala_merma, piezas, activo)
      SELECT p.idcat_proceso_merma, $1, NULL, TRUE
      FROM cat_proceso_merma p
      ON CONFLICT (idcat_proceso_merma, idcat_escala_merma) DO NOTHING
      `,
      [escala.id]
    );

    // Reordenar por cantidad: las escalas se leen de menor a mayor y agregar
    // una intermedia (p.ej. 1500) al final rompería la lectura visual.
    await client.query(`
      WITH ordenadas AS (
        SELECT idcat_escala_merma, ROW_NUMBER() OVER (ORDER BY cantidad) AS nuevo_orden
        FROM cat_escala_merma
      )
      UPDATE cat_escala_merma e
      SET orden = o.nuevo_orden
      FROM ordenadas o
      WHERE o.idcat_escala_merma = e.idcat_escala_merma
        AND e.orden IS DISTINCT FROM o.nuevo_orden
    `);

    await client.query("COMMIT");
    return res.status(201).json({ message: "Escala creada correctamente", escala });
  } catch (error: any) {
    await client.query("ROLLBACK");
    return res.status(error?.code === "23505" ? 409 : 500).json({
      error:
        error?.code === "23505"
          ? "Ya existe una escala con esa cantidad"
          : error?.message || "No se pudo crear la escala",
    });
  } finally {
    client.release();
  }
};

export const updateEscalaMerma = async (req: Request, res: Response) => {
  try {
    const id = idValido(req.params.id);
    const cantidad = idValido(req.body?.cantidad);
    if (!id || !cantidad) return res.status(400).json({ error: "ID o cantidad inválidos" });

    const { rows } = await qAudit(req)(
      `
      UPDATE cat_escala_merma
      SET cantidad=$1, updated_at=CURRENT_TIMESTAMP
      WHERE idcat_escala_merma=$2
      RETURNING idcat_escala_merma AS id, cantidad, activo, orden
      `,
      [cantidad, id]
    );

    if (!rows.length) return res.status(404).json({ error: "Escala no encontrada" });
    return res.json({ message: "Escala actualizada correctamente", escala: rows[0] });
  } catch (error: any) {
    return res.status(error?.code === "23505" ? 409 : 500).json({
      error:
        error?.code === "23505"
          ? "Ya existe una escala con esa cantidad"
          : error?.message || "No se pudo actualizar la escala",
    });
  }
};

export const toggleEscalaMerma = async (req: Request, res: Response) => {
  try {
    const id = idValido(req.params.id);
    const activo = req.body?.activo;
    if (!id || typeof activo !== "boolean")
      return res.status(400).json({ error: "Datos inválidos" });

    // Desactivar la última escala activa dejaría al motor sin poder resolver
    // ningún escalón y toda orden nueva fallaría.
    if (activo === false) {
      const { rows: activas } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM cat_escala_merma WHERE activo = TRUE AND idcat_escala_merma <> $1`,
        [id]
      );
      if (activas[0].total === 0) {
        return res.status(409).json({
          error: "No puedes desactivar la última escala activa: el cálculo de merma se quedaría sin escalones.",
        });
      }
    }

    const { rows } = await qAudit(req)(
      `
      UPDATE cat_escala_merma
      SET activo=$1, updated_at=CURRENT_TIMESTAMP
      WHERE idcat_escala_merma=$2
      RETURNING idcat_escala_merma AS id, cantidad, activo, orden
      `,
      [activo, id]
    );

    if (!rows.length) return res.status(404).json({ error: "Escala no encontrada" });
    return res.json({
      message: activo ? "Escala activada" : "Escala desactivada",
      escala: rows[0],
    });
  } catch (error: any) {
    return manejarError(res, error, "No se pudo cambiar el estado de la escala");
  }
};

export const toggleProcesoMerma = async (req: Request, res: Response) => {
  try {
    const id = idValido(req.params.id);
    const activo = req.body?.activo;
    if (!id || typeof activo !== "boolean")
      return res.status(400).json({ error: "Datos inválidos" });

    const { rows } = await qAudit(req)(
      `
      UPDATE cat_proceso_merma
      SET activo=$1, updated_at=CURRENT_TIMESTAMP
      WHERE idcat_proceso_merma=$2
      RETURNING idcat_proceso_merma AS id, clave, nombre, siempre_aplica, activo, orden
      `,
      [activo, id]
    );

    if (!rows.length) return res.status(404).json({ error: "Concepto de merma no encontrado" });
    return res.json({
      message: activo ? "Concepto activado" : "Concepto desactivado",
      proceso: rows[0],
    });
  } catch (error: any) {
    return manejarError(res, error, "No se pudo cambiar el estado del concepto");
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// SIMULACIÓN Y SNAPSHOT POR ORDEN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Simulador. Sirve para validar la regla del punto medio sin tocar una orden
 * real: GET /merma-papel/simular?cantidad=750
 *
 * Si se pasa idproduccion, usa los procesos reales de esa orden. Si no, se
 * puede pasar `procesos` (CSV de idproceso_cat) o dejarlo vacío para ver solo
 * qué escalón toca y cuánto aporta la base.
 */
export const simularMermaPapel = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const cantidad = Number(req.query.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      return res.status(400).json({ error: "Parámetro 'cantidad' inválido" });
    }

    const idproduccion = idValido(req.query.idproduccion);

    if (idproduccion) {
      const resultado = await calcularMermaDeOrden(client, idproduccion);
      return res.json({ modo: "orden", idproduccion, ...resultado });
    }

    const procesos = String(req.query.procesos ?? "")
      .split(",")
      .map((p) => Number(p.trim()))
      .filter((p) => Number.isInteger(p) && p > 0);

    const resultado = await calcularMerma(cantidad, procesos, client);
    return res.json({ modo: "libre", ...resultado });
  } catch (error: any) {
    return manejarError(res, error, "No se pudo simular la merma");
  } finally {
    client.release();
  }
};

/** Devuelve el escalón que le tocaría a una cantidad. Útil para la UI. */
export const resolverEscalaMermaController = async (req: Request, res: Response) => {
  try {
    const cantidad = Number(req.query.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      return res.status(400).json({ error: "Parámetro 'cantidad' inválido" });
    }

    const escalas = await getEscalasMerma();
    return res.json({ cantidad, escala: resolverEscalaMerma(cantidad, escalas) });
  } catch (error: any) {
    return manejarError(res, error, "No se pudo resolver el escalón");
  }
};

/** Snapshot congelado de una orden. Es lo que consumen el PDF y Estado de Cuenta. */
export const getMermaOrdenController = async (req: Request, res: Response) => {
  try {
    const idproduccion = idValido(req.params.idproduccion);
    if (!idproduccion) return res.status(400).json({ error: "ID de producción inválido" });

    const merma = await getMermaOrden(idproduccion);

    if (!merma) {
      return res.status(404).json({
        error: "Esta orden no tiene merma congelada.",
        detalle:
          "Las órdenes creadas antes de activar el sistema de merma no tienen snapshot. Usa el recálculo manual para generarlo.",
      });
    }

    return res.json(merma);
  } catch (error: any) {
    return manejarError(res, error, "No se pudo cargar la merma de la orden");
  }
};

/**
 * R6 — Recálculo manual. RESTRINGIDO a roles con acceso_total.
 *
 * La validación de permiso va aquí, en el backend, no en el frontend: ocultar
 * el botón es cosmético y cualquiera puede llamar este endpoint directo.
 */
export const recalcularMermaOrdenController = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const idproduccion = idValido(req.params.idproduccion);
    if (!idproduccion) return res.status(400).json({ error: "ID de producción inválido" });

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) {
      return res.status(401).json({ error: "No se pudo identificar al usuario." });
    }

    const autorizado = await usuarioTieneAccesoTotal(usuarioId, client);
    if (!autorizado) {
      return res.status(403).json({
        error: "Solo los usuarios con acceso total pueden recalcular la merma de una orden.",
      });
    }

    const motivo = String(req.body?.motivo ?? "");

    await iniciarTx(req, client);
    const { resultado, anterior, snapshot } = await recalcularMermaOrden(
      client,
      idproduccion,
      usuarioId,
      motivo
    );
    await client.query("COMMIT");

    return res.json({
      message: anterior
        ? "Merma recalculada correctamente"
        : "Merma generada correctamente (la orden no tenía snapshot previo)",
      anterior: anterior
        ? {
            merma_total: Number(anterior.merma_total),
            cantidad_a_producir: Number(anterior.cantidad_a_producir),
            version_calculo: Number(anterior.version_calculo),
          }
        : null,
      actual: {
        merma_total: resultado.merma_total,
        cantidad_a_producir: resultado.cantidad_a_producir,
        version_calculo: Number(snapshot.version_calculo),
      },
      desglose: resultado.desglose,
      advertencias: resultado.advertencias,
    });
  } catch (error: any) {
    await client.query("ROLLBACK").catch(() => {});
    return manejarError(res, error, "No se pudo recalcular la merma");
  } finally {
    client.release();
  }
};

/** Le dice al frontend si mostrar u ocultar el botón de recálculo. */
export const getPermisosMermaController = async (req: Request, res: Response) => {
  try {
    const usuarioId = getUsuarioId(req);
    const accesoTotal = await usuarioTieneAccesoTotal(usuarioId);
    return res.json({ puede_recalcular: accesoTotal });
  } catch (error: any) {
    return manejarError(res, error, "No se pudieron cargar los permisos");
  }
};