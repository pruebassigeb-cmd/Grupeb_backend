// src/controllers/producto_papel/precios_acabados_papel.controller.ts
import type { Request, Response } from "express";
import { pool } from "../../config/db";

const idValido = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const precioValido = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const costoMetroValido = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;

  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 99.99) return null;

  return Math.round((n + Number.EPSILON) * 100) / 100;
};

// ─────────────────────────────────────────────────────────────────────────────
// COSTO GLOBAL DEL LAMINADO
// ─────────────────────────────────────────────────────────────────────────────
export const getCostoMetroLaminado = async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT idcosto_metro AS id, costo, created_at, updated_at
      FROM costo_metro
      WHERE idcosto_metro = 1
    `);

    if (!rows.length) {
      const { rows: creadas } = await pool.query(`
        INSERT INTO costo_metro (idcosto_metro, costo)
        VALUES (1, 6.50)
        ON CONFLICT (idcosto_metro)
        DO UPDATE SET idcosto_metro = EXCLUDED.idcosto_metro
        RETURNING idcosto_metro AS id, costo, created_at, updated_at
      `);

      return res.json({
        ...creadas[0],
        costo: Number(creadas[0].costo),
      });
    }

    return res.json({
      ...rows[0],
      costo: Number(rows[0].costo),
    });
  } catch (error: any) {
    return res.status(500).json({
      error: error?.message || "No se pudo cargar el costo del laminado",
    });
  }
};

export const updateCostoMetroLaminado = async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const costo = costoMetroValido(req.body?.costo);

    if (costo === null) {
      return res.status(400).json({
        error: "El costo debe ser un número entre 0.00 y 99.99",
      });
    }

    await client.query("BEGIN");

    const { rows } = await client.query(`
      INSERT INTO costo_metro (
        idcosto_metro,
        costo,
        updated_at
      )
      VALUES (1, $1, CURRENT_TIMESTAMP)
      ON CONFLICT (idcosto_metro)
      DO UPDATE SET
        costo = EXCLUDED.costo,
        updated_at = CURRENT_TIMESTAMP
      RETURNING idcosto_metro AS id, costo, created_at, updated_at
    `, [costo]);

    await client.query("COMMIT");

    return res.json({
      message: "Costo del laminado actualizado correctamente",
      costoMetro: {
        ...rows[0],
        costo: Number(rows[0].costo),
      },
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    return res.status(500).json({
      error: error?.message || "No se pudo actualizar el costo del laminado",
    });
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CATÁLOGOS Y MATRIZ DE PRECIOS
// ─────────────────────────────────────────────────────────────────────────────
export const getCatalogosPreciosAcabadosPapel = async (_req: Request, res: Response) => {
  try {
    const [acabados, tamanos, escalas] = await Promise.all([
      pool.query(`
        SELECT idcat_acabado_costo AS id, clave, nombre, tipo_calculo, activo, orden
        FROM cat_acabado_costo ORDER BY orden, nombre
      `),
      pool.query(`
        SELECT idcat_tamano_producto AS id, clave, nombre, activo
        FROM cat_tamano_producto ORDER BY idcat_tamano_producto
      `),
      pool.query(`
        SELECT idcat_escala_costo AS id, cantidad, activo, orden
        FROM cat_escala_costo ORDER BY orden, cantidad
      `),
    ]);

    return res.json({
      acabados: acabados.rows,
      tamanos: tamanos.rows,
      escalas: escalas.rows,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || "No se pudieron cargar los catálogos" });
  }
};

export const getMatrizPreciosAcabadoPapel = async (req: Request, res: Response) => {
  try {
    const idAcabado = idValido(req.params.idAcabado);
    if (!idAcabado) return res.status(400).json({ error: "ID de acabado inválido" });

    const { rows: acabadoRows } = await pool.query(`
      SELECT idcat_acabado_costo AS id, clave, nombre, tipo_calculo, activo, orden
      FROM cat_acabado_costo
      WHERE idcat_acabado_costo = $1
    `, [idAcabado]);

    if (!acabadoRows.length) return res.status(404).json({ error: "Acabado no encontrado" });

    const [{ rows: escalas }, { rows: tamanos }, { rows: precios }] = await Promise.all([
      pool.query(`
        SELECT idcat_escala_costo AS id, cantidad, activo, orden
        FROM cat_escala_costo ORDER BY orden, cantidad
      `),
      pool.query(`
        SELECT idcat_tamano_producto AS id, clave, nombre, activo
        FROM cat_tamano_producto ORDER BY idcat_tamano_producto
      `),
      pool.query(`
        SELECT idacabado_costo AS id,
               idcat_tamano_producto AS id_tamano,
               idcat_escala_costo AS id_escala,
               precio_unitario,
               activo
        FROM acabado_costo
        WHERE idcat_acabado_costo = $1
      `, [idAcabado]),
    ]);

    const mapa = new Map<string, any>();
    precios.forEach((p) => mapa.set(`${p.id_tamano}:${p.id_escala}`, p));

    const filas = tamanos.map((t) => ({
      idTamano: t.id,
      clave: t.clave,
      tamano: t.nombre,
      activo: t.activo,
      precios: Object.fromEntries(escalas.map((e) => {
        const celda = mapa.get(`${t.id}:${e.id}`);
        return [String(e.id), {
          id: celda?.id ?? null,
          precio: celda?.precio_unitario == null ? null : Number(celda.precio_unitario),
          activo: celda?.activo ?? true,
        }];
      })),
    }));

    return res.json({ acabado: acabadoRows[0], escalas, filas });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || "No se pudo cargar la matriz" });
  }
};

export const updateMatrizPreciosAcabadoPapel = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const idAcabado = idValido(req.params.idAcabado);
    const celdas = Array.isArray(req.body?.celdas) ? req.body.celdas : [];

    if (!idAcabado) return res.status(400).json({ error: "ID de acabado inválido" });
    if (!celdas.length) return res.status(400).json({ error: "No se recibieron celdas" });

    await client.query("BEGIN");

    for (const celda of celdas) {
      const idTamano = idValido(celda.idTamano);
      const idEscala = idValido(celda.idEscala);

      if (!idTamano || !idEscala) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Una celda contiene IDs inválidos" });
      }

      const precio = precioValido(celda.precio);
      if (celda.precio !== null && celda.precio !== "" && precio === null) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Una celda contiene un precio inválido" });
      }

      await client.query(`
        INSERT INTO acabado_costo (
          idcat_acabado_costo, idcat_tamano_producto, idcat_escala_costo,
          precio_unitario, activo, updated_at
        )
        VALUES ($1,$2,$3,$4,TRUE,CURRENT_TIMESTAMP)
        ON CONFLICT (idcat_acabado_costo,idcat_tamano_producto,idcat_escala_costo)
        DO UPDATE SET
          precio_unitario = EXCLUDED.precio_unitario,
          activo = TRUE,
          updated_at = CURRENT_TIMESTAMP
      `, [idAcabado, idTamano, idEscala, precio]);
    }

    await client.query("COMMIT");
    return res.json({ message: "Matriz actualizada correctamente", actualizadas: celdas.length });
  } catch (error: any) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: error?.message || "No se pudo actualizar la matriz" });
  } finally {
    client.release();
  }
};

export const createEscalaCostoPapel = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const cantidad = idValido(req.body?.cantidad);
    if (!cantidad) return res.status(400).json({ error: "Cantidad inválida" });

    await client.query("BEGIN");

    const { rows: ordenRows } = await client.query(`
      SELECT COALESCE(MAX(orden),0)+1 AS siguiente FROM cat_escala_costo
    `);

    const { rows } = await client.query(`
      INSERT INTO cat_escala_costo (cantidad, orden, activo, updated_at)
      VALUES ($1,$2,TRUE,CURRENT_TIMESTAMP)
      ON CONFLICT (cantidad)
      DO UPDATE SET activo=TRUE, updated_at=CURRENT_TIMESTAMP
      RETURNING idcat_escala_costo AS id, cantidad, activo, orden
    `, [cantidad, Number(ordenRows[0].siguiente)]);

    const escala = rows[0];

    await client.query(`
      INSERT INTO acabado_costo (
        idcat_acabado_costo, idcat_tamano_producto, idcat_escala_costo,
        precio_unitario, activo
      )
      SELECT a.idcat_acabado_costo, t.idcat_tamano_producto, $1, NULL, TRUE
      FROM cat_acabado_costo a
      CROSS JOIN cat_tamano_producto t
      ON CONFLICT (idcat_acabado_costo,idcat_tamano_producto,idcat_escala_costo)
      DO NOTHING
    `, [escala.id]);

    await client.query("COMMIT");
    return res.status(201).json({ message: "Escala creada correctamente", escala });
  } catch (error: any) {
    await client.query("ROLLBACK");
    return res.status(error?.code === "23505" ? 409 : 500).json({
      error: error?.code === "23505" ? "La escala ya existe" : error?.message || "No se pudo crear la escala",
    });
  } finally {
    client.release();
  }
};

export const updateEscalaCostoPapel = async (req: Request, res: Response) => {
  try {
    const id = idValido(req.params.id);
    const cantidad = idValido(req.body?.cantidad);
    if (!id || !cantidad) return res.status(400).json({ error: "ID o cantidad inválidos" });

    const { rows } = await pool.query(`
      UPDATE cat_escala_costo
      SET cantidad=$1, updated_at=CURRENT_TIMESTAMP
      WHERE idcat_escala_costo=$2
      RETURNING idcat_escala_costo AS id, cantidad, activo, orden
    `, [cantidad, id]);

    if (!rows.length) return res.status(404).json({ error: "Escala no encontrada" });
    return res.json({ message: "Escala actualizada correctamente", escala: rows[0] });
  } catch (error: any) {
    return res.status(error?.code === "23505" ? 409 : 500).json({
      error: error?.code === "23505" ? "Ya existe una escala con esa cantidad" : error?.message,
    });
  }
};

export const toggleEscalaCostoPapel = async (req: Request, res: Response) => {
  try {
    const id = idValido(req.params.id);
    const activo = req.body?.activo;
    if (!id || typeof activo !== "boolean") return res.status(400).json({ error: "Datos inválidos" });

    const { rows } = await pool.query(`
      UPDATE cat_escala_costo
      SET activo=$1, updated_at=CURRENT_TIMESTAMP
      WHERE idcat_escala_costo=$2
      RETURNING idcat_escala_costo AS id, cantidad, activo, orden
    `, [activo, id]);

    if (!rows.length) return res.status(404).json({ error: "Escala no encontrada" });
    return res.json({ message: activo ? "Escala activada" : "Escala desactivada", escala: rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || "No se pudo cambiar el estado" });
  }
};

export const toggleAcabadoCostoPapel = async (req: Request, res: Response) => {
  try {
    const id = idValido(req.params.id);
    const activo = req.body?.activo;
    if (!id || typeof activo !== "boolean") return res.status(400).json({ error: "Datos inválidos" });

    const { rows } = await pool.query(`
      UPDATE cat_acabado_costo
      SET activo=$1, updated_at=CURRENT_TIMESTAMP
      WHERE idcat_acabado_costo=$2
      RETURNING idcat_acabado_costo AS id, clave, nombre, tipo_calculo, activo, orden
    `, [activo, id]);

    if (!rows.length) return res.status(404).json({ error: "Acabado no encontrado" });
    return res.json({ message: activo ? "Acabado activado" : "Acabado desactivado", acabado: rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || "No se pudo cambiar el estado" });
  }
};
