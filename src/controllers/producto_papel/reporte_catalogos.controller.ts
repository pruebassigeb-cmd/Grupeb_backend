// src/controllers/producto_papel/reporte_catalogos.controller.ts
//
// POST /productos-papel/carga-masiva/reporte
// Recibe en el body el arreglo `catalogosNuevos` que devolvió el endpoint
// de carga masiva, y regresa un .xlsx descargable con ese resumen.
//
// Se separa del endpoint principal para que el frontend pueda mostrar
// el resumen en pantalla primero, y solo generar el archivo si el
// usuario decide descargarlo (no se genera el Excel si no se usa).

import { Request, Response } from "express";
import ExcelJS from "exceljs";

export const descargarReporteCatalogos = async (req: Request, res: Response) => {
  try {
    const catalogosNuevos: { catalogo: string; valor_nuevo: string }[] = req.body.catalogosNuevos ?? [];

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Catálogos nuevos");

    ws.columns = [
      { header: "Catálogo", key: "catalogo", width: 28 },
      { header: "Valor nuevo creado", key: "valor_nuevo", width: 40 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } };

    catalogosNuevos.forEach(item => {
      ws.addRow({ catalogo: item.catalogo, valor_nuevo: item.valor_nuevo });
    });

    if (catalogosNuevos.length === 0) {
      ws.addRow({ catalogo: "—", valor_nuevo: "No se crearon catálogos nuevos en esta carga." });
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="reporte_catalogos_nuevos.xlsx"`);

    await wb.xlsx.write(res);
    res.end();
  } catch (error: any) {
    console.error("❌ REPORTE CATALOGOS ERROR:", error.message);
    return res.status(500).json({ error: "Error al generar el reporte" });
  }
};