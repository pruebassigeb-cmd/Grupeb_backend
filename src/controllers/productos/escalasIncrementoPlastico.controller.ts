// src/controllers/plastico/escalasIncrementoPlastico.controller.ts
import { iniciarTx, qAudit } from "../../middlewares/auditoria";
import { Request, Response } from "express";
import { pool } from "../../config/db";

// ============================================================================
// Ambas tablas ahora manejan rangos 100% dinámicos — el admin puede editar
// los límites, agregar rangos nuevos (ej. "20,000 en adelante") y quitar
// los que sobren. Ya no hay una cantidad fija de filas sembrada por
// migración ni un array hardcodeado de rangos — todo vive en la tabla.
//
// El guardado es SIEMPRE en batch (una sola confirmación, como ya hace la
// tabla de "Catálogo de costos" con tarifas_produccion): el frontend manda
// el estado completo de la sección (crear = sin id, editar = con id,
// borrar = con id + eliminar:true) y aquí se aplica todo en una transacción.
// ============================================================================

interface RangoInput {
  id?: number | null;
  rango_min: number;
  rango_max: number | null;
  incremento_por_pieza: number;
  eliminar?: boolean;
}

const rangoValido = (r: any): boolean => {
  if (typeof r.rango_min !== "number" || !Number.isInteger(r.rango_min) || r.rango_min < 0) return false;
  if (
    r.rango_max !== null &&
    (typeof r.rango_max !== "number" || !Number.isInteger(r.rango_max) || r.rango_max <= r.rango_min)
  ) {
    return false;
  }
  if (
    typeof r.incremento_por_pieza !== "number" ||
    !Number.isFinite(r.incremento_por_pieza) ||
    r.incremento_por_pieza < 0
  ) {
    return false;
  }
  return true;
};

// Dos rangos [aMin, aMax] y [bMin, bMax] (max=null → infinito) se traslapan
// si aMin <= bMax Y bMin <= aMax. Se revisan todos los pares de rangos
// activos (no marcados para eliminar) que van a quedar vigentes.
function hayTraslape(rangos: RangoInput[]): boolean {
  const activos = rangos.filter((r) => !r.eliminar);
  for (let i = 0; i < activos.length; i++) {
    for (let j = i + 1; j < activos.length; j++) {
      const a = activos[i];
      const b = activos[j];
      const aMax = a.rango_max ?? Infinity;
      const bMax = b.rango_max ?? Infinity;
      if (a.rango_min <= bMax && b.rango_min <= aMax) return true;
    }
  }
  return false;
}

// ============================================================================
// ASA FLEXIBLE
// ============================================================================
export const getEscalasAsaFlexible = async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT idescala_incremento_asa_flexible AS id, rango_min, rango_max,
             incremento_por_pieza, activo
      FROM escala_incremento_asa_flexible
      WHERE activo = true
      ORDER BY rango_min ASC
    `);

    return res.json(
      rows.map((r) => ({ ...r, incremento_por_pieza: Number(r.incremento_por_pieza) }))
    );
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || "No se pudieron cargar las escalas de asa flexible" });
  }
};

export const updateEscalasAsaFlexibleBatch = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const escalas: RangoInput[] = Array.isArray(req.body?.escalas) ? req.body.escalas : [];

    if (!escalas.length) {
      return res.status(400).json({ error: "No se recibieron escalas." });
    }
    for (const r of escalas) {
      if (!r.eliminar && !rangoValido(r)) {
        return res.status(400).json({
          error: "Una de las escalas tiene datos inválidos — revisa que el rango final sea mayor al inicial y el monto no sea negativo.",
        });
      }
    }
    if (hayTraslape(escalas)) {
      return res.status(400).json({
        error: "Hay rangos que se traslapan entre sí. Ajusta los límites antes de guardar.",
      });
    }

    const usuarioId = (req as any).user?.id || null;
    await iniciarTx(req, client);

    for (const r of escalas) {
      if (r.id && r.eliminar) {
        await client.query(
          `UPDATE escala_incremento_asa_flexible
           SET activo = false, actualizado_por = $1, updated_at = now()
           WHERE idescala_incremento_asa_flexible = $2`,
          [usuarioId, r.id]
        );
      } else if (r.id) {
        await client.query(
          `UPDATE escala_incremento_asa_flexible
           SET rango_min = $1, rango_max = $2, incremento_por_pieza = $3,
               actualizado_por = $4, updated_at = now()
           WHERE idescala_incremento_asa_flexible = $5`,
          [r.rango_min, r.rango_max, r.incremento_por_pieza, usuarioId, r.id]
        );
      } else if (!r.eliminar) {
        await client.query(
          `INSERT INTO escala_incremento_asa_flexible
             (rango_min, rango_max, incremento_por_pieza, actualizado_por)
           VALUES ($1, $2, $3, $4)`,
          [r.rango_min, r.rango_max, r.incremento_por_pieza, usuarioId]
        );
      }
    }

    await client.query("COMMIT");

    const { rows } = await pool.query(`
      SELECT idescala_incremento_asa_flexible AS id, rango_min, rango_max,
             incremento_por_pieza, activo
      FROM escala_incremento_asa_flexible
      WHERE activo = true
      ORDER BY rango_min ASC
    `);

    return res.json(rows.map((r) => ({ ...r, incremento_por_pieza: Number(r.incremento_por_pieza) })));
  } catch (error: any) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: error?.message || "No se pudieron guardar las escalas." });
  } finally {
    client.release();
  }
};

// ============================================================================
// CINTA DE SEGURIDAD — cada cinta tiene su propio set de rangos, 100%
// independiente de las demás cintas (una puede tener 2 rangos y otra 3).
// Ya no se sintetizan filas "vacías" por defecto: se regresan solo las que
// de verdad existen; si una cinta no tiene ninguna, el frontend muestra el
// estado vacío con el botón de "+ Agregar rango".
// ============================================================================
export const getEscalasCintaSeguridad = async (_req: Request, res: Response) => {
  try {
    const { rows: cintas } = await pool.query(`
      SELECT idcinta_seguridad AS id, nombre, medida
      FROM cinta_seguridad
      WHERE activo = true
      ORDER BY nombre ASC
    `);

    const { rows: escalas } = await pool.query(`
      SELECT idescala_incremento_cinta_seguridad AS id, cinta_seguridad_id,
             rango_min, rango_max, incremento_por_pieza, activo
      FROM escala_incremento_cinta_seguridad
      WHERE activo = true
      ORDER BY rango_min ASC
    `);

    const porCinta = new Map<number, any[]>();
    escalas.forEach((e) => {
      const lista = porCinta.get(e.cinta_seguridad_id) ?? [];
      lista.push({ ...e, incremento_por_pieza: Number(e.incremento_por_pieza) });
      porCinta.set(e.cinta_seguridad_id, lista);
    });

    const resultado = cintas.map((cinta) => ({
      cinta_seguridad_id: cinta.id,
      nombre: cinta.nombre,
      medida: cinta.medida,
      escalas: porCinta.get(cinta.id) ?? [],
    }));

    return res.json(resultado);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || "No se pudieron cargar las escalas de cinta de seguridad" });
  }
};

export const updateEscalasCintaSeguridadBatch = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    // cambios: array plano de { cinta_seguridad_id, id?, rango_min, rango_max,
    // incremento_por_pieza, eliminar? } — puede traer filas de varias cintas
    // a la vez, ya que el "Guardar cambios" es de toda la sección.
    const cambios: Array<RangoInput & { cinta_seguridad_id: number }> = Array.isArray(req.body?.cambios)
      ? req.body.cambios
      : [];

    if (!cambios.length) {
      return res.status(400).json({ error: "No se recibieron cambios." });
    }

    for (const c of cambios) {
      if (!Number.isInteger(c.cinta_seguridad_id) || c.cinta_seguridad_id <= 0) {
        return res.status(400).json({ error: "Una fila no tiene una cinta de seguridad válida." });
      }
      if (!c.eliminar && !rangoValido(c)) {
        return res.status(400).json({
          error: "Una de las escalas tiene datos inválidos — revisa que el rango final sea mayor al inicial y el monto no sea negativo.",
        });
      }
    }

    // El traslape se valida POR CINTA — dos cintas distintas pueden
    // perfectamente compartir el mismo rango de piezas.
    const porCinta = new Map<number, RangoInput[]>();
    cambios.forEach((c) => {
      const lista = porCinta.get(c.cinta_seguridad_id) ?? [];
      lista.push(c);
      porCinta.set(c.cinta_seguridad_id, lista);
    });
    for (const [cintaId, rangos] of porCinta) {
      if (hayTraslape(rangos)) {
        return res.status(400).json({
          error: `Hay rangos que se traslapan en una de las cintas. Ajusta los límites antes de guardar.`,
        });
      }
    }

    const usuarioId = (req as any).user?.id || null;
    await iniciarTx(req, client);

    for (const c of cambios) {
      if (c.id && c.eliminar) {
        await client.query(
          `UPDATE escala_incremento_cinta_seguridad
           SET activo = false, actualizado_por = $1, updated_at = now()
           WHERE idescala_incremento_cinta_seguridad = $2`,
          [usuarioId, c.id]
        );
      } else if (c.id) {
        await client.query(
          `UPDATE escala_incremento_cinta_seguridad
           SET rango_min = $1, rango_max = $2, incremento_por_pieza = $3,
               actualizado_por = $4, updated_at = now()
           WHERE idescala_incremento_cinta_seguridad = $5`,
          [c.rango_min, c.rango_max, c.incremento_por_pieza, usuarioId, c.id]
        );
      } else if (!c.eliminar) {
        await client.query(
          `INSERT INTO escala_incremento_cinta_seguridad
             (cinta_seguridad_id, rango_min, rango_max, incremento_por_pieza, actualizado_por)
           VALUES ($1, $2, $3, $4, $5)`,
          [c.cinta_seguridad_id, c.rango_min, c.rango_max, c.incremento_por_pieza, usuarioId]
        );
      }
    }

    await client.query("COMMIT");

    const { rows: cintas } = await pool.query(`
      SELECT idcinta_seguridad AS id, nombre, medida
      FROM cinta_seguridad
      WHERE activo = true
      ORDER BY nombre ASC
    `);
    const { rows: escalas } = await pool.query(`
      SELECT idescala_incremento_cinta_seguridad AS id, cinta_seguridad_id,
             rango_min, rango_max, incremento_por_pieza, activo
      FROM escala_incremento_cinta_seguridad
      WHERE activo = true
      ORDER BY rango_min ASC
    `);
    const porCintaResp = new Map<number, any[]>();
    escalas.forEach((e) => {
      const lista = porCintaResp.get(e.cinta_seguridad_id) ?? [];
      lista.push({ ...e, incremento_por_pieza: Number(e.incremento_por_pieza) });
      porCintaResp.set(e.cinta_seguridad_id, lista);
    });

    return res.json(
      cintas.map((cinta) => ({
        cinta_seguridad_id: cinta.id,
        nombre: cinta.nombre,
        medida: cinta.medida,
        escalas: porCintaResp.get(cinta.id) ?? [],
      }))
    );
  } catch (error: any) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: error?.message || "No se pudieron guardar las escalas." });
  } finally {
    client.release();
  }
};