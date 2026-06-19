// scripts/exportarCatalogosJSON.ts
//
// Consulta la BD y exporta un JSON con todos los catálogos que alimentan
// los dropdowns del Excel de carga masiva. Ese JSON lo consume después
// scripts/actualizar_catalogos_xlsm.py para refrescar la plantilla .xlsm
// SIN perder la macro ni las validaciones ya configuradas.
//
// Uso:
//   npx ts-node scripts/exportarCatalogosJSON.ts
//   → genera ./catalogos.json
//
//   python3 scripts/actualizar_catalogos_xlsm.py \
//       plantilla_carga_masiva_papel.xlsm \
//       catalogos.json \
//       plantilla_carga_masiva_papel.xlsm
//
// (sí, puedes sobreescribir el mismo .xlsm de salida — el script Python
// lee todo el original antes de escribir el nuevo)

import fs from "fs";
import { pool } from "../src/config/db";

interface FuenteCatalogo {
  nombreLista: string;
  query: string;
}

const FUENTES: FuenteCatalogo[] = [
  { nombreLista: "TipoProducto", query: `SELECT nombre AS valor FROM cat_tipo_producto_papel WHERE activo = true ORDER BY nombre` },
  { nombreLista: "Matrix", query: `SELECT medida_matrix AS valor FROM matrix WHERE activo = true ORDER BY medida_matrix` },
  { nombreLista: "TipoPegado", query: `SELECT nombre AS valor FROM cat_tipo_pegado WHERE activo = true ORDER BY nombre` },
  { nombreLista: "Pegamento", query: `SELECT nombre AS valor FROM cat_pegamento WHERE activo = true ORDER BY nombre` },
  { nombreLista: "RefuerzoMaterial", query: `SELECT nombre AS valor FROM cat_refuerzo_material WHERE activo = true ORDER BY nombre` },
  { nombreLista: "RefuerzoMedidas", query: `SELECT nombre AS valor FROM cat_refuerzo_medidas WHERE activo = true ORDER BY nombre` },
  { nombreLista: "Empaque", query: `SELECT nombre AS valor FROM cat_empaque WHERE activo = true ORDER BY nombre` },
  { nombreLista: "TipoAsa", query: `SELECT nombre AS valor FROM cat_tipo_asa WHERE activo = true ORDER BY nombre` },
  { nombreLista: "Laminado", query: `SELECT nombre AS valor FROM cat_laminado WHERE activo = true ORDER BY nombre` },
  { nombreLista: "MaqHojeadoGuillotina", query: `SELECT nombre AS valor FROM cat_hojeado_guillotina WHERE activo = true ORDER BY nombre` },
  { nombreLista: "MaqImpresora", query: `SELECT nombre AS valor FROM cat_impresora WHERE activo = true ORDER BY nombre` },
  { nombreLista: "MaqHsAr", query: `SELECT nombre AS valor FROM cat_hs_ar WHERE activo = true ORDER BY nombre` },
  { nombreLista: "MaqSuaje", query: `SELECT nombre AS valor FROM cat_suaje_maquina WHERE activo = true ORDER BY nombre` },
  { nombreLista: "MaqUv", query: `SELECT nombre AS valor FROM cat_uv WHERE activo = true ORDER BY nombre` },
  { nombreLista: "MaqTextura", query: `SELECT nombre AS valor FROM cat_textura WHERE activo = true ORDER BY nombre` },
  { nombreLista: "MaqEmpalme", query: `SELECT nombre AS valor FROM cat_empalme WHERE activo = true ORDER BY nombre` },
  { nombreLista: "MaqArmado", query: `SELECT nombre AS valor FROM cat_armado WHERE activo = true ORDER BY nombre` },
  { nombreLista: "MaqAsasMaquina", query: `SELECT nombre AS valor FROM cat_asas_maquina WHERE activo = true ORDER BY nombre` },
  { nombreLista: "MaqDesbarbe", query: `SELECT nombre AS valor FROM cat_desbarbe WHERE activo = true ORDER BY nombre` },
  { nombreLista: "TipoPapel", query: `SELECT nombre AS valor FROM cat_tipo_papel WHERE activo = true ORDER BY nombre` },
];

// Listas fijas que no vienen de la BD (igual que en generarPlantillaCargaMasiva.ts)
const LISTAS_FIJAS: Record<string, string[]> = {
  SiNo: ["SI", "NO"],
  UnidadCalibre: ["pts", "gms", "ect"],
};

async function main() {
  console.log("📡 Consultando catálogos...");
  const resultado: Record<string, string[]> = { ...LISTAS_FIJAS };

  for (const fuente of FUENTES) {
    const { rows } = await pool.query(fuente.query);
    const valores: string[] = rows.map((r: any) => r.valor).filter((v: any) => v != null && v !== "");
    // Si dos fuentes apuntan al mismo nombreLista (ej. base_material/refuerzo_material
    // comparten "RefuerzoMaterial"), simplemente se sobreescribe con el mismo resultado.
    resultado[fuente.nombreLista] = valores;
    console.log(`   ✓ ${fuente.nombreLista}: ${valores.length} valores`);
  }

  fs.writeFileSync("./catalogos.json", JSON.stringify(resultado, null, 2), "utf-8");
  console.log("\n✅ Generado: ./catalogos.json");
  console.log("   Siguiente paso:");
  console.log("   python3 scripts/actualizar_catalogos_xlsm.py \\");
  console.log("       plantilla_carga_masiva_papel.xlsm \\");
  console.log("       catalogos.json \\");
  console.log("       plantilla_carga_masiva_papel.xlsm");

  await pool.end();
}

main().catch(err => {
  console.error("❌ Error exportando catálogos:", err);
  process.exit(1);
});