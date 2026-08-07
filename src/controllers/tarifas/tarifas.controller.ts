import { iniciarTx } from "../../middlewares/auditoria";
import { Request, Response } from "express";
import { pool } from "../../config/db";

// ==========================
// OBTENER TODAS LAS TARIFAS
// ==========================
export const getTarifas = async (req: Request, res: Response) => {
  try {
    console.log("📋 Obteniendo tarifas de producción...");

    const result = await pool.query(`
      SELECT 
        tp.idtarifas_produccion,
        tp.tintas_idtintas,
        tp.kilogramos_idkilogramos,
        tp.precio,
        tp.merma_porcentaje,
        t.cantidad as cantidad_tintas,
        k.kg as kilogramos
      FROM tarifas_produccion tp
      INNER JOIN tintas t ON tp.tintas_idtintas = t.idtintas
      INNER JOIN kilogramos k ON tp.kilogramos_idkilogramos = k.idkilogramos
      ORDER BY k.kg ASC, t.cantidad ASC
    `);

    res.json(result.rows);
    console.log(`✅ ${result.rows.length} tarifas obtenidas`);
  } catch (error: any) {
    console.error("❌ GET TARIFAS ERROR:", error.message);
    res.status(500).json({
      error: "Error al obtener tarifas de producción",
    });
  }
};

// ==========================
// ACTUALIZAR MÚLTIPLES TARIFAS (batch update)
// ==========================
export const updateTarifasBatch = async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const { tarifas } = req.body; // Array de { id, precio, merma_porcentaje }

    if (!Array.isArray(tarifas) || tarifas.length === 0) {
      return res.status(400).json({
        error: "Se requiere un array de tarifas",
      });
    }

    console.log(`📝 Actualizando ${tarifas.length} tarifas en lote...`);

    await iniciarTx(req, client);

    for (const tarifa of tarifas) {
      const { id, precio, merma_porcentaje } = tarifa;

      // Validar que los valores sean números válidos
      if (!id || precio === undefined || merma_porcentaje === undefined) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Datos inválidos en tarifa",
        });
      }

      await client.query(
        `UPDATE tarifas_produccion 
         SET precio = $1, merma_porcentaje = $2
         WHERE idtarifas_produccion = $3`,
        [precio, merma_porcentaje, id]
      );
    }

    await client.query("COMMIT");

    res.json({
      message: "Tarifas actualizadas exitosamente",
      count: tarifas.length,
    });

    console.log(`✅ ${tarifas.length} tarifas actualizadas exitosamente`);
  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("❌ UPDATE BATCH ERROR:", error.message);
    res.status(500).json({
      error: "Error al actualizar tarifas",
    });
  } finally {
    client.release();
  }
};