import { iniciarTx } from "../../middlewares/auditoria";
import { Request, Response } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { pool } from "../../config/db";
// ── NUEVO: enganche de estado de cuenta (ver plan-estado-cuenta-cobranza-v2.md) ──
import { generarEstadoCuentaSiPedidoCompleto } from "../../services/ventas/estadoCuenta.service";

// ════════════════════════════════════════════════════════════════════════
// PROCESOS DE PAPEL — Orquestador
//
// Espejo conceptual de procesos.controller.ts (plástico), pero adaptado a
// una cascada DINÁMICA: plástico resuelve "qué procesos aplican" vía
// tipo_producto_plastico_proceso (fijo por tipo de producto). Papel no
// tiene eso — el cliente decide proceso por proceso al cotizar/pedir, así
// que la fuente de verdad es solicitud_producto_papel (campos uv,
// idcat_laminado, idfoil, idcat_textura, alto_relieve, metodo_hojeado,
// lleva_armado), no una tabla de configuración fija.
//
// proceso_cat SÍ es una tabla real y compartida entre materiales
// (confirmado: ya tiene 5 filas de plástico, IDs 1-5). Los 11 procesos de
// papel se insertan ahí (ver ddl_incremental_procesos_papel.sql) y
// continúan la serial sin colisión. Por eso este controlador NO
// hardcodea IDs — los resuelve por nombre_proceso contra la tabla real,
// con un caché simple en memoria (la tabla es prácticamente estática, no
// vale la pena consultarla en cada request).
//
// orden_produccion.proceso_actual se reutiliza tal cual para papel (un
// solo campo, compartido de verdad entre materiales — sin columnas
// paralelas por material, sin rangos numéricos hardcodeados).
//
// Estados de la orden: NO se crean códigos EN_X por proceso (a diferencia
// de plástico). Se usan los mismos 5 genéricos
// (PENDIENTE/EN_PROCESO/TERMINADO/RESAGADO/NO_APLICA) — el campo
// proceso_actual ya indica en cuál proceso está.
// ════════════════════════════════════════════════════════════════════════

const ESTADO_PROD = {
  PENDIENTE: 1,
  EN_PROCESO: 2,
  TERMINADO: 3,
  RESAGADO: 4,
  NO_APLICA: 5,
} as const;

// Nombres EXACTOS insertados en proceso_cat.nombre_proceso (ver DDL
// incremental). Estas claves son estables y se usan como identificador
// lógico interno en TODO este archivo — los idproceso_cat reales se
// resuelven en runtime contra la BD, nunca se hardcodean.
const NOMBRE_PROCESO_CAT_PAPEL = {
  HOJEADO: "Hojeado",
  GUILLOTINA: "Guillotina",
  IMPRESION: "Impresión Papel",
  LAMINACION: "Laminación",
  BARNIZ_UV: "Barniz UV Papel",
  HOT_STAMPING: "Hot Stamping",
  TEXTURIZADO: "Texturizado",
  ALTO_RELIEVE: "Alto Relieve",
  SUAJE: "Suaje Papel",
  DESBARBE: "Desbarbe",
  ARMADO: "Armado",
  PEGADO: "Pegado",
  LITOLAMINADO: "Litolaminado",
  ESPECIAL: "Especial",
  EMPAQUE: "Empaque Papel",
} as const;

type ClaveProcesoPapel = keyof typeof NOMBRE_PROCESO_CAT_PAPEL;

// Orden de cascada fijo de referencia -- SOLO rige para papel NORMAL (la
// ruta se resuelve por flags de solicitud_producto_papel, ver
// getProcesosDeOrdenPapel). Los especiales NO usan este arreglo: su orden
// sale directo de componente_papel_proceso.orden (ruta libre por
// componente). Hojeado y Guillotina comparten la misma posición relativa
// porque son mutuamente excluyentes en el flujo normal — nunca coexisten
// en el array filtrado real.
//
// Litolaminado NO aparece aquí: es exclusivo de la OP de unión de un
// especial (nunca aplica a papel normal), así que no tiene lugar en la
// cascada fija. Desbarbe y Especial SÍ pueden aplicar a papel
// normal (decisión de Jose, 2026-09-02) pero ese flujo -- capturarlos por
// pedido en solicitud_producto_papel y sumarlos aquí -- todavía no está
// conectado (queda pendiente, ver nota en getProcesosDeOrdenPapel); por
// ahora solo entran a la cascada desde el lado de especiales.
//
// PEGADO ya no está en esta lista (Jose, 2026-09-03): resultó ser el mismo
// proceso que Empaque en la práctica, así que se quitó del catálogo
// seleccionable (ver getProcesosCat en producto_papel.controller.ts) -- lo
// que valía la pena de capturar ahí ("qué se pega") ahora vive en Armado.
// La clave PEGADO y su fila en TABLA_POR_CLAVE_PAPEL/CAMPOS_PROCESO_PAPEL
// se dejan intactas abajo a propósito, solo para no tronar si una orden
// vieja ya tiene ese proceso capturado.
const ORDEN_CLAVES_PAPEL: ClaveProcesoPapel[] = [
  "HOJEADO", "GUILLOTINA", "IMPRESION", "LAMINACION", "BARNIZ_UV",
  "HOT_STAMPING", "TEXTURIZADO", "ALTO_RELIEVE", "SUAJE", "DESBARBE",
  "ARMADO", "ESPECIAL", "EMPAQUE",
];

const TABLA_POR_CLAVE_PAPEL: Record<ClaveProcesoPapel, string> = {
  HOJEADO: "hojeado_papel",
  GUILLOTINA: "guillotina_papel",
  IMPRESION: "impresion_papel",
  LAMINACION: "laminacion_papel",
  BARNIZ_UV: "barniz_uv_papel",
  HOT_STAMPING: "hot_stamping_papel",
  TEXTURIZADO: "texturizado_papel",
  ALTO_RELIEVE: "alto_relieve_papel",
  SUAJE: "suaje_produccion_papel",
  DESBARBE: "desbarbe_papel",
  ARMADO: "armado_papel",
  PEGADO: "pegado_papel",
  LITOLAMINADO: "litolaminado_papel",
  ESPECIAL: "especial_papel",
  EMPAQUE: "empaque_papel",
};

// ── Caché en memoria: idproceso_cat real <-> clave lógica ──────────────
// proceso_cat es prácticamente estática (cambia solo si se agregan
// procesos nuevos), así que cachear evita un round-trip a BD en cada
// request. Se recarga sola si el proceso Node se reinicia.
let cacheClaveAId: Map<ClaveProcesoPapel, number> | null = null;
let cacheIdAClave: Map<number, ClaveProcesoPapel> | null = null;

async function cargarCacheProcesoCatPapel(): Promise<void> {
  const nombres = Object.values(NOMBRE_PROCESO_CAT_PAPEL);
  const { rows } = await pool.query(
    `SELECT idproceso_cat, nombre_proceso FROM proceso_cat WHERE nombre_proceso = ANY($1)`,
    [nombres]
  );

  const claveAId = new Map<ClaveProcesoPapel, number>();
  const idAClave = new Map<number, ClaveProcesoPapel>();

  for (const [clave, nombre] of Object.entries(NOMBRE_PROCESO_CAT_PAPEL) as [ClaveProcesoPapel, string][]) {
    const fila = rows.find((r: any) => r.nombre_proceso === nombre);
    if (fila) {
      claveAId.set(clave, Number(fila.idproceso_cat));
      idAClave.set(Number(fila.idproceso_cat), clave);
    }
  }

  if (claveAId.size !== Object.keys(NOMBRE_PROCESO_CAT_PAPEL).length) {
    const faltantes = Object.entries(NOMBRE_PROCESO_CAT_PAPEL)
      .filter(([clave]) => !claveAId.has(clave as ClaveProcesoPapel))
      .map(([, nombre]) => nombre);
    throw new Error(
      `proceso_cat no tiene registrados todos los procesos de papel. Faltan: ${faltantes.join(", ")}. ` +
      `Corre ddl_incremental_procesos_papel.sql antes de usar este endpoint.`
    );
  }

  cacheClaveAId = claveAId;
  cacheIdAClave = idAClave;
}

async function getMapaProcesoCatPapel(): Promise<{
  claveAId: Map<ClaveProcesoPapel, number>;
  idAClave: Map<number, ClaveProcesoPapel>;
}> {
  if (!cacheClaveAId || !cacheIdAClave) {
    await cargarCacheProcesoCatPapel();
  }
  return { claveAId: cacheClaveAId!, idAClave: cacheIdAClave! };
}

// Campos editables por tabla (cascada entrada->merma->salida + propios de
// la corrida). Usado por finalizarProceso/editarProceso para saber qué
// columnas aceptar del body. NO incluye campos de ficha (esos viven en
// solicitud_producto_papel / detalle_material_papel y se traen por JOIN
// en getProcesosOrdenPapel, jamás se escriben aquí).
const CAMPOS_PROCESO_PAPEL: Record<string, string[]> = {
  hojeado_papel: ["maquinaria_idmaquinaria", "cantidad_hojeado", "merma", "cantidad_entregada"],
  guillotina_papel: ["maquinaria_idmaquinaria", "pliegos", "cortes", "merma", "cantidad_entregada"],
  impresion_papel: ["maquina", "pliegos_entrada", "merma", "pliegos_entregados"],
  laminacion_papel: ["maquina", "bobina_cm", "metros", "rollos", "desarrollo_mm", "ctes_mod", "pliegos_entrada", "merma", "pliegos_entregados"],
  barniz_uv_papel: ["maquina", "pliegos_entrada", "merma", "pliegos_entregados"],
  hot_stamping_papel: ["maquina", "pliegos_entrada", "merma", "pliegos_entregados"],
  texturizado_papel: ["maquina", "pliegos_entrada", "merma", "pliegos_entregados"],
  alto_relieve_papel: ["maquina", "pliegos_entrada", "merma", "pliegos_entregados"],
  suaje_produccion_papel: ["maquina", "suaje_idsuaje_papel", "pliegos_entrada", "merma", "pliegos_entregados"],
  desbarbe_papel: ["maquina", "pliegos_entrada", "merma", "pliegos_entregados"],
  armado_papel: ["maquina", "pliegos_entrada", "bolsas_armadas", "merma", "bolsas_entregadas"],
  pegado_papel: ["maquina", "idcat_tipo_pegado", "idcat_pegamento", "material_pegado", "pliegos_entrada", "merma", "pliegos_entregados"],
  // Litolaminado vive en la OP de unión -- qué materiales entran se resuelve
  // por componente_papel_proceso_material, no aquí (ver comentario de la
  // tabla en la migración Fase 1).
  litolaminado_papel: ["maquina", "pliegos_entrada", "merma", "pliegos_entregados"],
  especial_papel: ["nombre_proceso", "notas", "pliegos_entrada", "merma", "pliegos_entregados"],
  empaque_papel: ["maquina", "bolsas_entrada", "merma", "bolsas_entregadas_final"],
};

// Campo "de entrada" (lo que viene del proceso anterior) por tabla — se
// usa para heredar el valor al inicializar el siguiente proceso al
// finalizar uno.
const CAMPO_ENTRADA_PAPEL: Record<string, string | null> = {
  hojeado_papel: null, // primer proceso posible, no tiene entrada de otro proceso de papel
  guillotina_papel: null, // idem
  impresion_papel: "pliegos_entrada",
  laminacion_papel: "pliegos_entrada",
  barniz_uv_papel: "pliegos_entrada",
  hot_stamping_papel: "pliegos_entrada",
  texturizado_papel: "pliegos_entrada",
  alto_relieve_papel: "pliegos_entrada",
  suaje_produccion_papel: "pliegos_entrada",
  desbarbe_papel: "pliegos_entrada",
  armado_papel: "pliegos_entrada",
  pegado_papel: "pliegos_entrada",
  litolaminado_papel: "pliegos_entrada",
  especial_papel: "pliegos_entrada",
  empaque_papel: "bolsas_entrada", // cambia de unidad: bolsas, no pliegos
};

// Campo "de salida final" (lo que entrega cuando el proceso termina) por
// tabla — es lo que se hereda como entrada del siguiente proceso, y lo
// que se usa para calcular el límite de avance.
const CAMPO_SALIDA_PAPEL: Record<string, string> = {
  hojeado_papel: "cantidad_entregada",
  guillotina_papel: "cantidad_entregada",
  impresion_papel: "pliegos_entregados",
  laminacion_papel: "pliegos_entregados",
  barniz_uv_papel: "pliegos_entregados",
  hot_stamping_papel: "pliegos_entregados",
  texturizado_papel: "pliegos_entregados",
  alto_relieve_papel: "pliegos_entregados",
  suaje_produccion_papel: "pliegos_entregados",
  desbarbe_papel: "pliegos_entregados",
  armado_papel: "bolsas_entregadas",
  pegado_papel: "pliegos_entregados",
  litolaminado_papel: "pliegos_entregados",
  especial_papel: "pliegos_entregados",
  empaque_papel: "bolsas_entregadas_final",
};

const AVANCE_UNIDAD_PAPEL: Record<string, "pliegos" | "bolsas"> = {
  hojeado_papel: "pliegos",
  guillotina_papel: "pliegos",
  impresion_papel: "pliegos",
  laminacion_papel: "pliegos",
  barniz_uv_papel: "pliegos",
  hot_stamping_papel: "pliegos",
  texturizado_papel: "pliegos",
  alto_relieve_papel: "pliegos",
  suaje_produccion_papel: "pliegos",
  desbarbe_papel: "pliegos",
  armado_papel: "bolsas",
  pegado_papel: "pliegos",
  litolaminado_papel: "pliegos",
  especial_papel: "pliegos",
  empaque_papel: "bolsas",
};

const TABLAS_VALIDAS_PAPEL = Object.values(TABLA_POR_CLAVE_PAPEL);

// Clave lógica para buscar la máquina preseleccionada. Papel NORMAL la
// busca en solicitud_producto_papel_maquinaria (por pedido); especiales la
// busca en la tabla maquinaria_* correspondiente, filtrada por
// idcomponente_papel (por producto/componente) -- ver
// MAQUINARIA_COMPONENTE_POR_TABLA y getMaquinaElegidaPapel más abajo.
const CLAVE_MAQUINA_POR_TABLA: Record<string, string> = {
  hojeado_papel: "hojeado_guillotina",
  guillotina_papel: "hojeado_guillotina",
  impresion_papel: "impresora",
  laminacion_papel: "laminado_maquina",
  barniz_uv_papel: "uv",
  hot_stamping_papel: "hs_ar",
  texturizado_papel: "texturizadora",
  alto_relieve_papel: "hs_ar",
  suaje_produccion_papel: "suaje_maquina",
  desbarbe_papel: "desbarbe",
  armado_papel: "armado",
  pegado_papel: "pegado", // sin tabla maquinaria_pegado en BD todavía -- no resuelve nada hasta que exista
  litolaminado_papel: "empalme",
  empaque_papel: "empaque_maquina",
};

// Especiales: tabla maquinaria_* + catálogo asociado para cada proceso que
// sí tiene máquina preseleccionable por componente. `idCol` es la columna
// que guarda el id de catálogo en la tabla maquinaria_*; `catTabla`/`catPk`
// son la tabla y llave primaria del catálogo (para traer el nombre a
// mostrar). `tipoMaquina` es solo para las tablas "compuestas" de Fase 1
// (ver más abajo) que pueden traer más de un renglón por componente.
//
// VERIFICADO (2026-09-02) contra fase1_productos_especiales_up.sql y
// catalogos_papel.controller.ts real — antes esto eran nombres "por
// convención", sin confirmar uno por uno. Lo que cambió:
//   - impresion_papel, laminacion_papel, barniz_uv_papel, hot_stamping_papel,
//     texturizado_papel, suaje_produccion_papel, desbarbe_papel, armado_papel,
//     empaque_papel, litolaminado_papel: CONFIRMADOS tal cual ya estaban
//     (coinciden exacto con CATALOGOS en catalogos_papel.controller.ts y con
//     las 11 tablas maquinaria_* "simples" del DDL de Fase 1).
//   - alto_relieve_papel: ERA UN BUG -- apuntaba a maquinaria_hs_ar /
//     idcat_hs_ar (la tabla de Hot Stamping), pero Fase 1 creó una tabla
//     PROPIA para Alto Relieve: maquinaria_alto_relieve, columna
//     idcat_alto_relieve_maquina (confirmado en el DDL, sección "7c. Las
//     tres excepciones..."). Corregido. catTabla/catPk se dejan en
//     cat_hs_ar como suposición razonada (el tab "HS y AR" en Catálogos.tsx
//     es un solo catálogo compartido para Hot Stamping Y Alto Relieve, y no
//     existe ningún catálogo "cat_alto_relieve_maquina" expuesto en
//     catalogos_papel.controller.ts) -- si el nombre real de la columna que
//     guarda el id no es contra cat_hs_ar, esta consulta falla con "column
//     does not exist" y cae al catch de getMaquinaElegidaPapel sin tronar
//     nada más (mismo comportamiento de siempre ante un nombre equivocado).
//   - hojeado_papel / guillotina_papel: FALTABAN por completo -- para
//     especiales nunca resolvían máquina (quedaban en null silenciosamente).
//     Fase 1 SÍ tiene su tabla: maquinaria_hojeado_guillotina, columna
//     idcat_hojeado_guillotina, catálogo cat_hojeado_guillotina (confirmado
//     en catalogos_papel.controller.ts, tieneTipoMaquina:true). Esta tabla
//     es "compuesta" a propósito -- el DDL lo dice explícito: "dos renglones
//     (hojeadora + guillotina)" por componente, uno de cada tipo, porque un
//     mismo componente puede llevar máquina propia para cada una. Por eso
//     lleva `tipoMaquina` -- getMaquinaElegidaPapel filtra por
//     c.tipo_maquina para traer el renglón correcto según cuál de las dos
//     tablas de proceso se está resolviendo.
const MAQUINARIA_COMPONENTE_POR_TABLA: Record<
  string,
  { maquinariaTabla: string; idCol: string; catTabla: string; catPk: string; tipoMaquina?: "hojeadora" | "guillotina" }
> = {
  hojeado_papel: { maquinariaTabla: "maquinaria_hojeado_guillotina", idCol: "idcat_hojeado_guillotina", catTabla: "cat_hojeado_guillotina", catPk: "idcat_hojeado_guillotina", tipoMaquina: "hojeadora" },
  guillotina_papel: { maquinariaTabla: "maquinaria_hojeado_guillotina", idCol: "idcat_hojeado_guillotina", catTabla: "cat_hojeado_guillotina", catPk: "idcat_hojeado_guillotina", tipoMaquina: "guillotina" },
  impresion_papel: { maquinariaTabla: "maquinaria_impresora", idCol: "idcat_impresora", catTabla: "cat_impresora", catPk: "idcat_impresora" },
  laminacion_papel: { maquinariaTabla: "maquinaria_laminado", idCol: "idcat_laminado_maquina", catTabla: "cat_laminado_maquina", catPk: "idcat_laminado_maquina" },
  barniz_uv_papel: { maquinariaTabla: "maquinaria_uv", idCol: "idcat_uv", catTabla: "cat_uv", catPk: "idcat_uv" },
  hot_stamping_papel: { maquinariaTabla: "maquinaria_hs_ar", idCol: "idcat_hs_ar", catTabla: "cat_hs_ar", catPk: "idcat_hs_ar" },
  alto_relieve_papel: { maquinariaTabla: "maquinaria_alto_relieve", idCol: "idcat_alto_relieve_maquina", catTabla: "cat_hs_ar", catPk: "idcat_hs_ar" },
  texturizado_papel: { maquinariaTabla: "maquinaria_texturizadora", idCol: "idcat_texturizadora", catTabla: "cat_texturizadora", catPk: "idcat_texturizadora" },
  suaje_produccion_papel: { maquinariaTabla: "maquinaria_suaje_maquina", idCol: "idcat_suaje_maquina", catTabla: "cat_suaje_maquina", catPk: "idcat_suaje_maquina" },
  desbarbe_papel: { maquinariaTabla: "maquinaria_desbarbe", idCol: "idcat_desbarbe", catTabla: "cat_desbarbe", catPk: "idcat_desbarbe" },
  armado_papel: { maquinariaTabla: "maquinaria_armado", idCol: "idcat_armado", catTabla: "cat_armado", catPk: "idcat_armado" },
  empaque_papel: { maquinariaTabla: "maquinaria_empaque", idCol: "idcat_empaque_maquina", catTabla: "cat_empaque_maquina", catPk: "idcat_empaque_maquina" },
  litolaminado_papel: { maquinariaTabla: "maquinaria_empalme", idCol: "idcat_empalme", catTabla: "cat_empalme", catPk: "idcat_empalme" },
};

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

/**
 * Determina qué procesos aplican a una orden de papel específica, en
 * orden de cascada real, devolviendo los idproceso_cat REALES (resueltos
 * vía caché contra proceso_cat). Fuente de verdad: solicitud_producto_papel
 * de la solicitud_producto asociada a la orden — NO maquinaria_*, NO una
 * tabla de configuración por tipo de producto (a diferencia de plástico).
 * Esto es porque en papel el cliente decide proceso por proceso al
 * cotizar o pedir, no es una propiedad fija del tipo de producto.
 */
export async function getProcesosDeOrdenPapel(client: any, idproduccion: number): Promise<number[]> {
  const { claveAId } = await getMapaProcesoCatPapel();

  // ── Especiales: la ruta NO sale de los flags de solicitud_producto_papel,
  // sale de componente_papel_proceso -- es la ruta libre armada por
  // componente al dar de alta el producto (ver RutaProcesos.tsx / Fase 1).
  // orden_produccion.idcomponente_papel es lo que distingue una OP de un
  // especial (se pone al emitir, ver emitirOrdenProduccionEspecial.service.ts)
  // de una orden normal (siempre NULL).
  //
  // PENDIENTE (deliberado, fuera de esta pasada): `veces` en cada renglón
  // de componente_papel_proceso (repetición del proceso) todavía NO se
  // expande aquí -- cada renglón de ruta entra una sola vez a la cascada,
  // igual que si `veces` siempre fuera 1. Expandir a pasadas reales
  // (pasada 1..veces, con su propio avance/estado) implica tocar también
  // getSiguienteEfectivoPapel, resolverAnteriorEfectivoPapel,
  // getLimiteAvanceAnteriorPapel, iniciarProcesoPapel, registrarAvancePapel,
  // finalizarProcesoPapel y editarProcesoPapel -- son todas funciones que
  // hoy asumen un solo registro por (orden, tabla_proceso), y es lo mismo
  // que le falta a papel normal para su propio `repeticiones_procesos`. Se
  // deja como su propio siguiente paso, compartido entre los dos modelos,
  // en vez de resolverlo a medias solo para especiales.
  const { rows: componenteRows } = await client.query(
    `SELECT idcomponente_papel FROM orden_produccion WHERE idproduccion = $1`,
    [idproduccion]
  );
  const idComponentePapel = componenteRows[0]?.idcomponente_papel ?? null;

  if (idComponentePapel != null) {
    const { rows: rutaRows } = await client.query(
      `SELECT idproceso_cat
         FROM componente_papel_proceso
        WHERE idcomponente_papel = $1
        ORDER BY orden ASC`,
      [idComponentePapel]
    );
    return rutaRows.map((r: any) => Number(r.idproceso_cat));
  }

  const { rows } = await client.query(
    `
    SELECT
      spp.idcat_laminado,
      spp.uv,
      spp.idfoil,
      spp.idcat_textura,
      spp.alto_relieve,
      spp.lleva_armado,
      t.cantidad       AS tintas,
      tdentro.cantidad AS tintas_dentro
    FROM orden_produccion op
    JOIN solicitud_producto sp ON sp.idsolicitud_producto = op.idsolicitud_producto
    JOIN solicitud_producto_papel spp ON spp.idsolicitud_producto = sp.idsolicitud_producto
    LEFT JOIN tintas t ON t.idtintas = sp.tintas_idtintas
    LEFT JOIN tintas tdentro ON tdentro.idtintas = spp.tintas_dentro_idtintas
    WHERE op.idproduccion = $1
    `,
    [idproduccion]
  );

  if (rows.length === 0) return [];
  const r = rows[0];

  const clavesAplican: ClaveProcesoPapel[] = [];

  // CORREGIDO: metodo_hojeado está DEPRECADO (ver ordenProduccionPapel.types.ts)
  // y siempre llega null desde que se decide físicamente en producción, no en
  // el sistema. Antes esta condición nunca era verdadera para ninguno de los
  // dos, así que Hojeado y Guillotina JAMÁS entraban a la cascada -> el
  // backend nunca los devolvía -> el frontend los mostraba como N/A siempre,
  // sin importar qué llevara la orden en realidad.
  //
  // Hojeado y Guillotina ahora aplican SIEMPRE a toda orden de papel, y NO
  // son mutuamente excluyentes: el operador decide en planta (con el PDF
  // físico en mano) cuál usar, y puede ser uno, el otro, o los dos (orden
  // físico fijo: primero Hojeado, luego Guillotina — decisión de Jose,
  // 2026-08-24). Si solo se usa uno, ambos quedan disponibles hasta que
  // uno reciba el primer registro/avance, momento en el cual el otro se
  // oculta (ver override de estado en getProcesosOrdenPapel más abajo).
  // Si al finalizar Hojeado el operador confirma que este pedido también
  // pasa por Guillotina, esta deja de ser una alternativa y pasa a
  // depender de Hojeado como cualquier otro proceso de la cascada (ver
  // debeIgnorarAnteriorPapel / getSiguienteEfectivoPapel / finalizarProcesoPapel).
  clavesAplican.push("HOJEADO");
  clavesAplican.push("GUILLOTINA");

  // Impresión solo aplica si el producto lleva tintas (frente o dentro) —
  // se puede cotizar "Sin tintas" y en ese caso no hay nada que imprimir.
  // Suaje y Empaque sí son obligatorios siempre.
  const tieneTintas = (Number(r.tintas) || 0) > 0 || (Number(r.tintas_dentro) || 0) > 0;
  if (tieneTintas) clavesAplican.push("IMPRESION");

  if (r.idcat_laminado != null) clavesAplican.push("LAMINACION");
  if (r.uv === true) clavesAplican.push("BARNIZ_UV");
  if (r.idfoil != null) clavesAplican.push("HOT_STAMPING");
  if (r.idcat_textura != null) clavesAplican.push("TEXTURIZADO");
  if (r.alto_relieve === true) clavesAplican.push("ALTO_RELIEVE");

  clavesAplican.push("SUAJE");

  if (r.lleva_armado === true) clavesAplican.push("ARMADO");

  clavesAplican.push("EMPAQUE");

  // Preservar el orden de cascada real, filtrando solo a los que
  // aplican, y traducir a idproceso_cat real.
  return ORDEN_CLAVES_PAPEL
    .filter((clave) => clavesAplican.includes(clave))
    .map((clave) => claveAId.get(clave)!);
}

/**
 * Igual que getProcesosDeOrdenPapel, pero ya resuelto a tabla/nombre en vez
 * de solo idproceso_cat -- para que otros archivos (seguimiento.controller.ts,
 * el PDF) puedan pintar "qué procesos aplican a esta OP" sin tener que
 * reimplementar la lógica de flags de papel normal vs. componente_papel_proceso
 * de especiales por su cuenta (que es justo el tipo de duplicado que se
 * desincroniza solo). Única fuente de verdad: la misma que ya usa el motor
 * de producción para decidir la cascada real.
 */
export async function getProcesosDeOrdenPapelConTabla(
  client: any,
  idproduccion: number
): Promise<{ idproceso_cat: number; tabla: string; nombre_proceso: string }[]> {
  const { idAClave } = await getMapaProcesoCatPapel();
  const ids = await getProcesosDeOrdenPapel(client, idproduccion);
  const out: { idproceso_cat: number; tabla: string; nombre_proceso: string }[] = [];
  for (const idProcesoCat of ids) {
    const clave = idAClave.get(idProcesoCat);
    if (!clave) continue;
    const tabla = TABLA_POR_CLAVE_PAPEL[clave];
    const nombre_proceso = NOMBRE_PROCESO_CAT_PAPEL[clave];
    if (!tabla) continue;
    out.push({ idproceso_cat: idProcesoCat, tabla, nombre_proceso });
  }
  return out;
}

/**
 * Total de tintas (frente + dentro/reverso) de la orden — hasta 4 de cada
 * lado, 8 en total. Usado por merma.service.ts para multiplicar la merma de
 * Impresión por la cantidad de tintas (ver R9 en ese archivo). Consulta
 * separada de getProcesosDeOrdenPapel a propósito: esa función la llaman 7
 * sitios que esperan number[], cambiar su forma de retorno los afectaría a
 * todos para un dato que solo necesita merma.
 */
export async function getTintasDeOrdenPapel(
  client: any,
  idproduccion: number
): Promise<{ tintasFrente: number; tintasDentro: number }> {
  const { rows } = await client.query(
    `
    SELECT
      t.cantidad       AS tintas,
      tdentro.cantidad AS tintas_dentro
    FROM orden_produccion op
    JOIN solicitud_producto sp ON sp.idsolicitud_producto = op.idsolicitud_producto
    JOIN solicitud_producto_papel spp ON spp.idsolicitud_producto = sp.idsolicitud_producto
    LEFT JOIN tintas t ON t.idtintas = sp.tintas_idtintas
    LEFT JOIN tintas tdentro ON tdentro.idtintas = spp.tintas_dentro_idtintas
    WHERE op.idproduccion = $1
    `,
    [idproduccion]
  );

  const r = rows[0];
  return {
    tintasFrente: Number(r?.tintas) || 0,
    tintasDentro: Number(r?.tintas_dentro) || 0,
  };
}

/**
 * Nombre del primer proceso de papel que ya arrancó en esta orden, o null si
 * ninguno ha iniciado. Se considera "iniciado" tener fecha_inicio, que es el
 * mismo criterio que usa Seguimiento para pintar el estado "en proceso".
 *
 * Lo usa actualizarPedido para NO dejar cambiar la cantidad de una orden que
 * ya está en planta: si se recalculara la merma ahí, los operadores verían
 * cambiar su meta a media corrida (decisión de Jose, 2026-08-14).
 */
export async function getPrimerProcesoPapelIniciado(
  client: any,
  idproduccion: number
): Promise<string | null> {
  const union = (Object.entries(TABLA_POR_CLAVE_PAPEL) as [ClaveProcesoPapel, string][])
    .map(([clave, tabla]) =>
      `SELECT '${clave}' AS clave, MIN(fecha_inicio) AS inicio
         FROM ${tabla}
        WHERE orden_produccion_idproduccion = $1 AND fecha_inicio IS NOT NULL`
    )
    .join(" UNION ALL ");

  const { rows } = await client.query(
    `SELECT clave FROM (${union}) t WHERE inicio IS NOT NULL ORDER BY inicio ASC LIMIT 1`,
    [idproduccion]
  );

  if (!rows[0]) return null;
  return NOMBRE_PROCESO_CAT_PAPEL[rows[0].clave as ClaveProcesoPapel] ?? rows[0].clave;
}

async function getMaquinaElegidaPapel(
  client: any,
  idproduccion: number,
  tablaProceso: string
): Promise<{ id: number; nombre: string } | null> {
  // Especiales: la máquina no se preselecciona por pedido
  // (solicitud_producto_papel_maquinaria no tiene noción de componente) --
  // se busca en la tabla maquinaria_* del proceso, filtrada por el
  // idcomponente_papel de ESTA orden (ver Fase 1: cada maquinaria_* tiene
  // idproducto_papel XOR idcomponente_papel).
  const { rows: opRows } = await client.query(
    `SELECT idcomponente_papel FROM orden_produccion WHERE idproduccion = $1`,
    [idproduccion]
  );
  const idComponentePapel = opRows[0]?.idcomponente_papel ?? null;

  if (idComponentePapel != null) {
    const cfg = MAQUINARIA_COMPONENTE_POR_TABLA[tablaProceso];
    if (!cfg) return null;

    // NOTA (verificado 2026-09-02, ver comentario arriba de
    // MAQUINARIA_COMPONENTE_POR_TABLA): los nombres de tabla/columna ya se
    // cotejaron contra el DDL real de Fase 1 y contra
    // catalogos_papel.controller.ts. La única pieza que sigue siendo una
    // suposición razonada (no confirmada 1:1) es a qué catálogo apunta
    // idcat_alto_relieve_maquina -- se probó con cat_hs_ar. Si algo no
    // coincide, esta consulta falla con "relation/column does not exist"
    // y se corrige aquí puntualmente (no afecta a papel normal).
    try {
      const filtroTipo = cfg.tipoMaquina ? ` AND c.tipo_maquina = $2` : "";
      const params = cfg.tipoMaquina ? [idComponentePapel, cfg.tipoMaquina] : [idComponentePapel];
      const { rows } = await client.query(
        `SELECT m.${cfg.idCol} AS id, c.nombre AS nombre
           FROM ${cfg.maquinariaTabla} m
           JOIN ${cfg.catTabla} c ON c.${cfg.catPk} = m.${cfg.idCol}
          WHERE m.idcomponente_papel = $1${filtroTipo}`,
        params
      );
      const maquina = rows[0];
      if (!maquina?.id) return null;
      return { id: Number(maquina.id), nombre: String(maquina.nombre ?? "") };
    } catch (err) {
      console.warn(
        `[getMaquinaElegidaPapel] No se pudo resolver máquina de componente para ${tablaProceso} ` +
        `(revisa MAQUINARIA_COMPONENTE_POR_TABLA contra el esquema real):`, (err as any)?.message
      );
      return null;
    }
  }

  const clave = CLAVE_MAQUINA_POR_TABLA[tablaProceso];
  if (!clave) return null;

  const { rows } = await client.query(
    `SELECT
       spm.idmaquina AS id,
       spm.nombre_maquina AS nombre
     FROM orden_produccion op
     JOIN solicitud_producto_papel spp
       ON spp.idsolicitud_producto = op.idsolicitud_producto
     JOIN solicitud_producto_papel_maquinaria spm
       ON spm.idsolicitud_producto_papel = spp.idsolicitud_producto_papel
      AND spm.proceso = $2
     WHERE op.idproduccion = $1`,
    [idproduccion, clave]
  );

  const maquina = rows[0];
  if (!maquina?.id) return null;
  return { id: Number(maquina.id), nombre: String(maquina.nombre ?? "") };
}

// NOTA: superseded por getSiguienteEfectivoPapel (más abajo), que además
// salta al hermano no usado del par Hojeado/Guillotina. Se deja aquí solo
// como referencia interna; el motor ya no la llama en ningún flujo.
function getSiguienteProcesoPapel(procesos: number[], procesoActual: number): number | null {
  const idx = procesos.indexOf(procesoActual);
  if (idx === -1) return null;
  return procesos[idx + 1] ?? null;
}

// ── Hojeado -> Guillotina (orden físico fijo, decisión de Jose,
// 2026-08-24) ────────────────────────────────────────────────────────────
// Ya NO se tratan como alternativas excluyentes ("el que el operador haya
// elegido"): un pedido puede llevar los dos, uno seguido del otro, o solo
// uno de los dos. Hojeado es siempre el primer punto de entrada posible;
// Guillotina depende de Hojeado únicamente cuando Hojeado sí se usó en
// ese pedido (ver debeIgnorarAnteriorPapel más abajo). No hace falta
// ninguna bandera de configuración por producto — se resuelve en tiempo
// real según lo que el operador vaya registrando en planta.
async function getParPreparacionPapel(): Promise<{ idHojeado: number; idGuillotina: number }> {
  const { claveAId } = await getMapaProcesoCatPapel();
  return {
    idHojeado: claveAId.get("HOJEADO")!,
    idGuillotina: claveAId.get("GUILLOTINA")!,
  };
}

/**
 * ¿Ya se usó Hojeado en este pedido (arrancó, o tiene algún avance
 * registrado)? Es lo que decide si Guillotina debe seguir actuando como
 * punto de entrada independiente (Hojeado nunca se tocó) o si debe
 * depender de Hojeado como cualquier proceso normal de la cascada
 * (Hojeado ya se usó, y el orden físico fijo es Hojeado -> Guillotina —
 * decisión de Jose, 2026-08-24).
 */
async function hojeadoTieneRegistroReal(client: any, idproduccion: number): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT fecha_inicio FROM hojeado_papel WHERE orden_produccion_idproduccion = $1`,
    [idproduccion]
  );
  if (rows.length > 0 && rows[0].fecha_inicio) return true;

  const { rows: avRows } = await client.query(
    `SELECT 1 FROM avance_proceso
     WHERE orden_produccion_idproduccion = $1 AND tabla_proceso = 'hojeado_papel' LIMIT 1`,
    [idproduccion]
  );
  return avRows.length > 0;
}

/**
 * Reemplaza el bypass ciego que antes aplicaba a TODO proceso de
 * preparación por igual (Hojeado y Guillotina trataban como "sin
 * anterior" sin excepción). Hojeado sigue sin depender nunca de nada
 * anterior — es siempre el primer punto de entrada posible. Guillotina
 * en cambio solo se ignora como "sin anterior" cuando Hojeado nunca se
 * usó en este pedido (Guillotina actuando como su propio punto de
 * entrada); si Hojeado sí se usó, Guillotina pasa a depender de él
 * (límite de avance, y debe tener avance/estar terminado para poder
 * iniciarse o finalizarse), exactamente igual que cualquier otro par de
 * la cascada. Así un pedido puede llevar los dos, uno seguido del otro,
 * sin necesitar ninguna bandera de configuración por producto.
 */
async function debeIgnorarAnteriorPapel(
  client: any,
  idproduccion: number,
  procesoCat: number
): Promise<boolean> {
  const { idHojeado, idGuillotina } = await getParPreparacionPapel();
  if (procesoCat === idHojeado) return true;
  if (procesoCat === idGuillotina) return !(await hojeadoTieneRegistroReal(client, idproduccion));
  return false;
}

/**
 * Da el idproceso_cat + tabla del proceso "efectivamente siguiente" a
 * `procesoActual`. Igual que getSiguienteProcesoPapel para cualquier
 * proceso normal, pero si `procesoActual` es Hojeado o Guillotina y el
 * array trae al hermano justo después, lo salta y regresa lo que sigue
 * después del par (normalmente Impresión) — el hermano NUNCA se
 * autoinicializa como "siguiente paso obligatorio".
 */
async function getSiguienteEfectivoPapel(
  procesos: number[],
  procesoActual: number
): Promise<number | null> {
  const { idHojeado, idGuillotina } = await getParPreparacionPapel();
  const idx = procesos.indexOf(procesoActual);
  if (idx === -1) return null;

  const esPreparacion = procesoActual === idHojeado || procesoActual === idGuillotina;
  const siguienteInmediato = procesos[idx + 1] ?? null;

  if (esPreparacion && siguienteInmediato != null &&
      (siguienteInmediato === idHojeado || siguienteInmediato === idGuillotina)) {
    return procesos[idx + 2] ?? null;
  }
  return siguienteInmediato;
}

/**
 * Resuelve cuál de los dos procesos de preparación (Hojeado/Guillotina)
 * es el que efectivamente rige como "anterior" para el resto de la
 * cascada (o para el propio Guillotina, cuando se está resolviendo SU
 * anterior). Devuelve null si ninguno de los dos tiene registro todavía
 * — en ese caso, Impresión (o lo que siga) NO debe desbloquearse.
 *
 * Se considera "usado" en cuanto existe una FILA para ese proceso en
 * este pedido, aunque todavía esté pendiente sin arrancar. Eso es a
 * propósito: cuando el operador confirma al finalizar Hojeado que este
 * pedido "también pasa por Guillotina", se le crea de una vez su fila
 * pendiente (ver finalizarProcesoPapel) — desde ese momento Guillotina
 * ya es el compromiso real de esta orden y el resto de la cascada
 * (Impresión) debe esperarlo a ÉL, no conformarse con lo que ya entregó
 * Hojeado nada más porque Guillotina aún no arrancó.
 *
 * IMPORTANTE: se revisa Guillotina PRIMERO. El orden físico fijo es
 * Hojeado -> Guillotina (nunca al revés — decisión de Jose, 2026-08-24):
 * si un pedido usó los dos, Guillotina es la etapa más avanzada de la
 * cadena y ya depende de lo que entregó Hojeado (ver
 * debeIgnorarAnteriorPapel). Revisar Hojeado primero aquí haría que el
 * resto de la cascada ignorara por completo el paso de Guillotina.
 */
async function getPreparacionUsadaPapel(
  client: any,
  idproduccion: number
): Promise<{ cat: number; tabla: string } | null> {
  const { idHojeado, idGuillotina } = await getParPreparacionPapel();

  for (const cat of [idGuillotina, idHojeado]) {
    const tabla = await getTablaPorIdProcesoCat(cat);
    if (!tabla) continue;

    const { rows } = await client.query(
      `SELECT 1 FROM ${tabla} WHERE orden_produccion_idproduccion = $1`,
      [idproduccion]
    );
    if (rows.length > 0) return { cat, tabla };
  }
  return null;
}

/**
 * Resuelve el "anterior efectivo" de `procesoActualCat` dentro de la
 * cascada: igual que procesos[idx-1] para cualquier proceso normal, pero
 * si lo inmediato anterior es Hojeado o Guillotina, en vez de asumir uno
 * fijo, busca cuál de los dos realmente se usó (getPreparacionUsadaPapel).
 * Devuelve null si se requiere un anterior y ninguno calza (proceso
 * bloqueado) o si de plano no hay anterior (primer proceso real).
 */
async function resolverAnteriorEfectivoPapel(
  client: any,
  idproduccion: number,
  procesos: number[],
  procesoActualCat: number
): Promise<{ cat: number; tabla: string } | null> {
  const idx = procesos.indexOf(procesoActualCat);
  if (idx <= 0) return null;

  const { idHojeado, idGuillotina } = await getParPreparacionPapel();
  const catInmediatoAnterior = procesos[idx - 1];
  const inmediatoEsPreparacion =
    catInmediatoAnterior === idHojeado || catInmediatoAnterior === idGuillotina;

  if (!inmediatoEsPreparacion) {
    const tabla = await getTablaPorIdProcesoCat(catInmediatoAnterior);
    return tabla ? { cat: catInmediatoAnterior, tabla } : null;
  }

  return getPreparacionUsadaPapel(client, idproduccion);
}

async function getProcesoActualOrdenPapel(
  client: any,
  idproduccion: number
): Promise<{ procesoActualCat: number | null; estadoOrden: number }> {
  const { rows } = await client.query(
    `SELECT proceso_actual, idestado_produccion_cat FROM orden_produccion WHERE idproduccion = $1`,
    [idproduccion]
  );
  if (rows.length === 0) return { procesoActualCat: null, estadoOrden: ESTADO_PROD.PENDIENTE };
  return {
    procesoActualCat: rows[0].proceso_actual,
    estadoOrden: rows[0].idestado_produccion_cat,
  };
}

async function getTablaPorIdProcesoCat(idProcesoCat: number): Promise<string | null> {
  const { idAClave } = await getMapaProcesoCatPapel();
  const clave = idAClave.get(idProcesoCat);
  return clave ? TABLA_POR_CLAVE_PAPEL[clave] : null;
}

async function getIdProcesoCatPorTabla(tabla: string): Promise<number | null> {
  const { claveAId } = await getMapaProcesoCatPapel();
  const clave = (Object.entries(TABLA_POR_CLAVE_PAPEL) as [ClaveProcesoPapel, string][])
    .find(([, t]) => t === tabla)?.[0];
  return clave ? claveAId.get(clave) ?? null : null;
}

/**
 * Inicializa el campo proceso_actual de la orden al primer proceso que
 * aplica. Se llama al crear la orden de producción de papel (análogo a
 * inicializarPrimerProceso de plástico).
 */
export async function inicializarPrimerProcesoPapel(client: any, idproduccion: number): Promise<void> {
  const procesos = await getProcesosDeOrdenPapel(client, idproduccion);
  const primero = procesos[0] ?? null;
  if (primero !== null) {
    await client.query(
      `UPDATE orden_produccion SET proceso_actual = $1 WHERE idproduccion = $2`,
      [primero, idproduccion]
    );
  }
}

async function procesoAnteriorTieneAvanceOTerminadoPapel(
  client: any,
  idproduccion: number,
  procesos: number[],
  procesoActualCat: number
): Promise<boolean> {
  const idx = procesos.indexOf(procesoActualCat);
  if (idx <= 0) return true; // primer proceso, no tiene anterior

  // Hojeado nunca depende de nada anterior. Guillotina tampoco, PERO SOLO
  // mientras Hojeado no se haya usado en este pedido — si Hojeado ya se
  // usó, Guillotina pasa a depender de él como cualquier otro proceso de
  // la cascada (ver debeIgnorarAnteriorPapel).
  if (await debeIgnorarAnteriorPapel(client, idproduccion, procesoActualCat)) return true;

  const anterior = await resolverAnteriorEfectivoPapel(client, idproduccion, procesos, procesoActualCat);
  if (!anterior) return false;

  const { rows: estadoRows } = await client.query(
    `SELECT estado_produccion_cat_idestado_produccion_cat AS estado
     FROM ${anterior.tabla} WHERE orden_produccion_idproduccion = $1`,
    [idproduccion]
  );
  if (estadoRows.length > 0 && Number(estadoRows[0].estado) === ESTADO_PROD.TERMINADO) return true;

  const { rows: avanceRows } = await client.query(
    `SELECT 1 FROM avance_proceso
     WHERE orden_produccion_idproduccion = $1 AND tabla_proceso = $2 LIMIT 1`,
    [idproduccion, anterior.tabla]
  );
  return avanceRows.length > 0;
}

async function procesoAnteriorEstaTerminadoPapel(
  client: any,
  idproduccion: number,
  procesos: number[],
  procesoActualCat: number
): Promise<boolean> {
  const idx = procesos.indexOf(procesoActualCat);
  if (idx <= 0) return true;

  // Mismo criterio que procesoAnteriorTieneAvanceOTerminadoPapel arriba:
  // Hojeado siempre bypassa, Guillotina solo bypassa si Hojeado no se usó.
  if (await debeIgnorarAnteriorPapel(client, idproduccion, procesoActualCat)) return true;

  const anterior = await resolverAnteriorEfectivoPapel(client, idproduccion, procesos, procesoActualCat);
  if (!anterior) return false;

  const { rows } = await client.query(
    `SELECT estado_produccion_cat_idestado_produccion_cat AS estado
     FROM ${anterior.tabla} WHERE orden_produccion_idproduccion = $1`,
    [idproduccion]
  );
  return rows.length > 0 && Number(rows[0].estado) === ESTADO_PROD.TERMINADO;
}

/**
 * Límite de avance: cuánto puede avanzar el proceso actual según lo que
 * ya entregó (o lleva acumulado) el proceso anterior. Espejo de
 * getLimiteAvanceAnterior de plástico, pero sin la complejidad de
 * conversión kilo<->pieza (papel siempre trabaja en pliegos/bolsas,
 * nunca kilos).
 */
async function getLimiteAvanceAnteriorPapel(
  client: any,
  idproduccion: number,
  procesos: number[],
  tablaProceso: string
): Promise<number | null> {
  const catActual = await getIdProcesoCatPorTabla(tablaProceso);
  if (!catActual) return null;

  // Hojeado nunca tiene límite previo (siempre puede ser el punto de
  // entrada). Guillotina tampoco, MIENTRAS Hojeado no se haya usado en
  // este pedido — en cuanto Hojeado se usa, Guillotina queda limitada
  // por lo que Hojeado entregó, como cualquier proceso normal de la
  // cascada (ver debeIgnorarAnteriorPapel).
  if (await debeIgnorarAnteriorPapel(client, idproduccion, catActual)) return null;

  const idx = procesos.indexOf(catActual);
  if (idx <= 0) return null;

  const anterior = await resolverAnteriorEfectivoPapel(client, idproduccion, procesos, catActual);
  if (!anterior) return null;

  const campoSalida = CAMPO_SALIDA_PAPEL[anterior.tabla];
  if (!campoSalida) return null;

  const { rows: regRows } = await client.query(
    `SELECT estado_produccion_cat_idestado_produccion_cat AS estado, ${campoSalida} AS campo_final
     FROM ${anterior.tabla}
     WHERE orden_produccion_idproduccion = $1`,
    [idproduccion]
  );

  if (regRows.length === 0) return null;

  const estadoAnterior = Number(regRows[0].estado);

  if (estadoAnterior === ESTADO_PROD.TERMINADO) {
    const v = regRows[0].campo_final;
    return v == null ? null : Number(v);
  }

  const { rows: avRows } = await client.query(
    `SELECT COALESCE(SUM(cantidad), 0) AS total
     FROM avance_proceso
     WHERE orden_produccion_idproduccion = $1 AND tabla_proceso = $2`,
    [idproduccion, anterior.tabla]
  );

  const total = Number(avRows[0]?.total ?? 0);
  return total > 0 ? total : null;
}

// ────────────────────────────────────────────────────────────────────────
// Compuerta de la OP de UNIÓN: sólo debe esperar a que TODAS sus OP de
// INICIO hermanas terminen TODOS sus procesos cuando la unión realmente
// fusiona materiales por Litolaminado (Jose, 2026-09-02):
//   - "Caja de regalo": dos piezas independientes (cada una su propio
//     material, su propia OP-INICIO) que sólo ENCAJAN mecánicamente para
//     formar el producto final -- ahí SÍ se genera una OP de unión (hay que
//     juntar ambas piezas en un solo producto), pero esa unión NO lleva
//     Litolaminado en su ruta porque no hay nada que fusionar. Ese caso NO
//     se bloquea: no tiene sentido esperar a que ambas piezas estén
//     terminadas al 100% sólo para poder ensamblarlas después, en planta.
//   - Unión CON Litolaminado en su ruta: sí necesita que las piezas que va
//     a fusionar ya estén completas antes de poder arrancar (no se puede
//     litolaminar algo que todavía no terminó de imprimirse/barnizarse/etc).
//     Ahí SÍ se bloquea el primer proceso de la unión hasta que cada OP de
//     inicio hermana (misma idsolicitud_producto) tenga TODOS sus procesos
//     en estado TERMINADO.
//
// Sólo aplica al tipo "union" -- "unica" (modo "misma orden", un solo
// componente) nunca tiene hermanas que esperar, por diseño.
// ────────────────────────────────────────────────────────────────────────
export async function unionEsperandoHermanasPapel(
  client: any,
  idproduccion: number
): Promise<{ espera: boolean; motivo?: string }> {
  const { rows: opRows } = await client.query(
    `SELECT idcomponente_papel, idsolicitud_producto FROM orden_produccion WHERE idproduccion = $1`,
    [idproduccion]
  );
  const idComponentePapel = opRows[0]?.idcomponente_papel ?? null;
  const idSolicitudProducto = opRows[0]?.idsolicitud_producto ?? null;
  if (idComponentePapel == null || idSolicitudProducto == null) return { espera: false };

  const { rows: compRows } = await client.query(
    `SELECT tipo FROM componente_papel WHERE idcomponente_papel = $1`,
    [idComponentePapel]
  );
  if (compRows.length === 0 || compRows[0].tipo !== "union") return { espera: false };

  const { rows: litoRows } = await client.query(
    `SELECT 1
       FROM componente_papel_proceso cpp
       JOIN proceso_cat pc ON pc.idproceso_cat = cpp.idproceso_cat
      WHERE cpp.idcomponente_papel = $1 AND pc.tabla = 'litolaminado_papel'
      LIMIT 1`,
    [idComponentePapel]
  );
  if (litoRows.length === 0) return { espera: false }; // unión "encaja", no fusiona -- no espera

  const { rows: hermanasRows } = await client.query(
    `SELECT op2.idproduccion, op2.no_produccion
       FROM orden_produccion op2
       JOIN componente_papel cp2 ON cp2.idcomponente_papel = op2.idcomponente_papel
      WHERE op2.idsolicitud_producto = $1 AND cp2.tipo = 'inicio'`,
    [idSolicitudProducto]
  );

  if (hermanasRows.length === 0) return { espera: false };

  const { idAClave } = await getMapaProcesoCatPapel();
  const pendientes: string[] = [];

  for (const hermana of hermanasRows) {
    const procesosHermana = await getProcesosDeOrdenPapel(client, Number(hermana.idproduccion));
    for (const idProcesoCat of procesosHermana) {
      const clave = idAClave.get(idProcesoCat);
      const tabla = clave ? TABLA_POR_CLAVE_PAPEL[clave] : null;
      if (!tabla) continue;

      const { rows: regRows } = await client.query(
        `SELECT estado_produccion_cat_idestado_produccion_cat AS estado
           FROM ${tabla} WHERE orden_produccion_idproduccion = $1`,
        [hermana.idproduccion]
      );
      const terminado = regRows.length > 0 && Number(regRows[0].estado) === ESTADO_PROD.TERMINADO;
      if (!terminado) {
        const nombreProceso = clave ? NOMBRE_PROCESO_CAT_PAPEL[clave] : tabla;
        pendientes.push(`${hermana.no_produccion} (${nombreProceso})`);
      }
    }
  }

  if (pendientes.length === 0) return { espera: false };

  return {
    espera: true,
    motivo: `Esta unión lleva Litolaminado -- debe esperar a que terminen todas sus OP de inicio: ${pendientes.join(", ")}`,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Piezas finales de cada OP de INICIO hermana, para una OP de UNIÓN
// (Jose, 2026-09-02): la unión no fabrica piezas desde cero -- recibe las
// piezas que ya salieron del ÚLTIMO proceso de cada una de sus OP de inicio
// hermanas (misma idsolicitud_producto, componente_papel.tipo = 'inicio').
// Esto es lo que debe aparecer como "entrada" del primer proceso de la
// unión en su PDF, y lo que el usuario necesita ver para saber cuántas
// piezas debe recibir/tener a la mano antes de arrancar la unión.
//
// Por cada hermana se toma el ÚLTIMO proceso de su propia ruta (no el de la
// unión) y se lee su columna de "entregado" (CAMPO_SALIDA_PAPEL). Si ese
// último proceso ya está TERMINADO se usa su cantidad entregada final; si
// todavía está en curso se suma su avance parcial (avance_proceso), igual
// que hace getLimiteAvanceAnteriorPapel para la cascada dentro de una
// misma OP.
// ────────────────────────────────────────────────────────────────────────
export interface CantidadFinalPapel {
  proceso_final_tabla: string | null;
  proceso_final_nombre: string | null;
  cantidad_entregada: number | null;
  terminado: boolean;
}

// ────────────────────────────────────────────────────────────────────────
// Cantidad final realmente entregada por una orden de papel, sea cual sea
// su ÚLTIMO proceso real. Para papel normal (no especial) ese último
// proceso siempre es Empaque (ver getProcesosDeOrdenPapel: EMPAQUE se
// agrega siempre, sin condición), pero para un componente de un especial
// la ruta es la que se haya configurado en componente_papel_proceso -- "casi
// que cualquier proceso puede ser el final" (Jose, 2026-09-04): puede
// quedarse en Litolaminado y de ahí solo irse a almacenar, sin pasar por
// Suaje/Desbarbe/Armado/Empaque. Antes esto se asumía fijo (Empaque) en
// más de un lugar (aquí y en estadoCuenta.service.ts), lo cual daba
// "cantidad_real" en null para cualquier OP de papel/especial que no
// terminara en Empaque. Factorizado aquí para que ambos (y cualquier otro
// consumidor futuro) usen siempre la misma fuente de verdad, en vez de
// reimplementar la cascada cada vez (el mismo tipo de duplicado que ya se
// desincronizó antes con tipo_material="papel"/"especial").
// ────────────────────────────────────────────────────────────────────────
export async function cantidadEntregadaFinalPapel(
  client: any,
  idproduccion: number
): Promise<CantidadFinalPapel> {
  const procesos = await getProcesosDeOrdenPapelConTabla(client, idproduccion);
  const ultimo = procesos[procesos.length - 1] ?? null;
  if (!ultimo) {
    return { proceso_final_tabla: null, proceso_final_nombre: null, cantidad_entregada: null, terminado: false };
  }

  const campoSalida = CAMPO_SALIDA_PAPEL[ultimo.tabla];
  let cantidadEntregada: number | null = null;
  let terminado = false;

  if (campoSalida) {
    const { rows: regRows } = await client.query(
      `SELECT estado_produccion_cat_idestado_produccion_cat AS estado, ${campoSalida} AS campo_final
         FROM ${ultimo.tabla}
        WHERE orden_produccion_idproduccion = $1`,
      [idproduccion]
    );

    if (regRows.length > 0) {
      const estado = Number(regRows[0].estado);
      terminado = estado === ESTADO_PROD.TERMINADO;

      if (terminado) {
        const v = regRows[0].campo_final;
        cantidadEntregada = v == null ? null : Number(v);
      } else {
        const { rows: avRows } = await client.query(
          `SELECT COALESCE(SUM(cantidad), 0) AS total
             FROM avance_proceso
            WHERE orden_produccion_idproduccion = $1 AND tabla_proceso = $2`,
          [idproduccion, ultimo.tabla]
        );
        const total = Number(avRows[0]?.total ?? 0);
        cantidadEntregada = total > 0 ? total : null;
      }
    }
  }

  return {
    proceso_final_tabla: ultimo.tabla,
    proceso_final_nombre: ultimo.nombre_proceso ?? null,
    cantidad_entregada: cantidadEntregada,
    terminado,
  };
}

export interface PiezasFinalesHermanaPapel {
  idproduccion: number;
  no_produccion: string | null;
  idcomponente_papel: number | null;
  componente_nombre: string | null;
  proceso_final_tabla: string | null;
  proceso_final_nombre: string | null;
  cantidad_entregada: number | null;
  terminado: boolean;
}

export async function piezasFinalesHermanasPapel(
  client: any,
  idproduccionUnion: number
): Promise<PiezasFinalesHermanaPapel[]> {
  const { rows: opRows } = await client.query(
    `SELECT idcomponente_papel, idsolicitud_producto FROM orden_produccion WHERE idproduccion = $1`,
    [idproduccionUnion]
  );
  const idComponentePapel = opRows[0]?.idcomponente_papel ?? null;
  const idSolicitudProducto = opRows[0]?.idsolicitud_producto ?? null;
  if (idComponentePapel == null || idSolicitudProducto == null) return [];

  const { rows: compRows } = await client.query(
    `SELECT tipo FROM componente_papel WHERE idcomponente_papel = $1`,
    [idComponentePapel]
  );
  if (compRows.length === 0 || compRows[0].tipo !== "union") return [];

  const { rows: hermanasRows } = await client.query(
    `SELECT op2.idproduccion, op2.no_produccion, cp2.idcomponente_papel, cp2.nombre AS componente_nombre
       FROM orden_produccion op2
       JOIN componente_papel cp2 ON cp2.idcomponente_papel = op2.idcomponente_papel
      WHERE op2.idsolicitud_producto = $1 AND cp2.tipo = 'inicio'
      ORDER BY cp2.orden ASC NULLS LAST, op2.idproduccion ASC`,
    [idSolicitudProducto]
  );
  if (hermanasRows.length === 0) return [];

  const out: PiezasFinalesHermanaPapel[] = [];

  for (const hermana of hermanasRows) {
    const idprodHermana = Number(hermana.idproduccion);
    const final = await cantidadEntregadaFinalPapel(client, idprodHermana);

    out.push({
      idproduccion: idprodHermana,
      no_produccion: hermana.no_produccion ?? null,
      idcomponente_papel: hermana.idcomponente_papel ?? null,
      componente_nombre: hermana.componente_nombre ?? null,
      ...final,
    });
  }

  return out;
}

// ════════════════════════════════════════════════════════════════════════
// GET /procesos-papel/:idproduccion
// ════════════════════════════════════════════════════════════════════════
export const getProcesosOrdenPapel = async (req: Request, res: Response) => {
  try {
    const { idproduccion } = req.params as { idproduccion: string };
    const { idAClave } = await getMapaProcesoCatPapel();

    const { rows: ordenRows } = await pool.query(`
      SELECT
        op.idproduccion, op.no_produccion, op.fecha,
        op.proceso_actual, op.idestado_produccion_cat,
        ep.nombre AS estado_nombre,
        s.no_pedido, sp.idsolicitud_producto
      FROM orden_produccion op
      JOIN estado_produccion_cat ep ON ep.idestado_produccion_cat = op.idestado_produccion_cat
      JOIN solicitud_producto sp    ON sp.idsolicitud_producto    = op.idsolicitud_producto
      JOIN solicitud s ON s.idsolicitud = op.idsolicitud
      WHERE op.idproduccion = $1
    `, [idproduccion]);

    if (ordenRows.length === 0)
      return res.status(404).json({ error: "Orden no encontrada" });

    const orden = ordenRows[0];

    const procesosIds = await getProcesosDeOrdenPapel(pool, Number(idproduccion));

    if (procesosIds.length === 0) {
      return res.status(400).json({
        error: "No se pudo determinar los procesos de esta orden de papel. Verifica que la orden tenga una solicitud_producto_papel asociada.",
      });
    }

    // Especiales, sólo UNIÓN: piezas finales de cada OP de inicio hermana y
    // el mínimo entre todas -- limitan tanto el "máximo" que se puede
    // registrar como avance del primer proceso de la unión (normalmente
    // Litolaminado) como la "entrada" que se le precarga al finalizar, ya
    // que ese proceso no tiene ningún proceso "anterior" dentro de su
    // propia ruta del que heredar esos datos (Jose, 2026-09-03; espejo de
    // seguimiento.controller.ts). piezasFinalesHermanasPapel ya resuelve
    // internamente si esta orden es de tipo unión y regresa [] si no aplica.
    const piezasFinalesHermanas = await piezasFinalesHermanasPapel(pool, Number(idproduccion));
    const piezasFinalesTotal = piezasFinalesHermanas.length > 0
      ? Math.min(
          ...piezasFinalesHermanas.map((h) => h.cantidad_entregada ?? 0)
        )
      : null;

    const procesosConRegistros = await Promise.all(procesosIds.map(async (idProcesoCat) => {
      const clave = idAClave.get(idProcesoCat)!;
      const tabla = TABLA_POR_CLAVE_PAPEL[clave];
      const nombreProceso = NOMBRE_PROCESO_CAT_PAPEL[clave];

      const { rows: regRows } = await pool.query(
        `SELECT * FROM ${tabla} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
      );

      const registro = regRows[0] ?? null;
      let estado = "pendiente";
      if (registro) {
        const est = Number(registro.estado_produccion_cat_idestado_produccion_cat);
        if (est === ESTADO_PROD.TERMINADO) estado = "terminado";
        else if (est === ESTADO_PROD.RESAGADO) estado = "resagado";
        else if (est === ESTADO_PROD.EN_PROCESO) estado = "en_proceso";
        else estado = "pendiente";
      }

      const { rows: avancesRows } = await pool.query(
        `SELECT idavance, cantidad, unidad, observaciones, fecha_registro
         FROM avance_proceso
         WHERE orden_produccion_idproduccion = $1 AND tabla_proceso = $2
         ORDER BY fecha_registro ASC`,
        [idproduccion, tabla]
      );

      const totalAvances = avancesRows.reduce((sum: number, a: any) => sum + Number(a.cantidad ?? 0), 0);

      return {
        idproceso_cat: idProcesoCat,
        nombre_proceso: nombreProceso,
        tabla, registro, estado,
        observaciones: registro?.observaciones || null,
        avances: avancesRows,
        total_avances: Math.round(totalAvances * 100) / 100,
      };
    }));

    // ── Par Hojeado -> Guillotina (orden físico fijo — decisión de Jose,
    // 2026-08-24) ────────────────────────────────────────────────────────
    // Si Hojeado ya se usó y Guillotina NO TIENE NINGÚN REGISTRO todavía
    // (ni siquiera pendiente), es porque al finalizar Hojeado el operador
    // contestó que este pedido no pasa por Guillotina — se oculta como
    // "no_aplica". Si en cambio Guillotina SÍ tiene un registro (aunque
    // sea pendiente, sin arrancar), es porque el operador confirmó que
    // este pedido pasa por los dos — se deja visible normalmente para
    // que la inicie cuando le toque (ver finalizarProcesoPapel).
    // Si es Guillotina la que arrancó primero (pedido que nunca pasa por
    // Hojeado), Hojeado se oculta apenas Guillotina tenga registro real —
    // ahí no hay paso de confirmación explícita, Guillotina es siempre un
    // punto de entrada libre cuando Hojeado nunca se tocó.
    const esPrepTabla = (tabla: string) => tabla === "hojeado_papel" || tabla === "guillotina_papel";
    const idxHojeado = procesosConRegistros.findIndex((p) => p.tabla === "hojeado_papel");
    const idxGuillotina = procesosConRegistros.findIndex((p) => p.tabla === "guillotina_papel");

    const tieneRegistroReal = (p: (typeof procesosConRegistros)[number]) =>
      !!p?.registro?.fecha_inicio || (p?.total_avances ?? 0) > 0;

    if (idxHojeado !== -1 && idxGuillotina !== -1) {
      const hoj = procesosConRegistros[idxHojeado];
      const gui = procesosConRegistros[idxGuillotina];
      const hojTiene = tieneRegistroReal(hoj);
      const guiTiene = tieneRegistroReal(gui);

      if (hojTiene && !guiTiene && gui.registro == null) {
        procesosConRegistros[idxGuillotina] = { ...gui, estado: "no_aplica" };
      } else if (guiTiene && !hojTiene && hoj.registro == null) {
        procesosConRegistros[idxHojeado] = { ...hoj, estado: "no_aplica" };
      }
    }

    const procesosConLimite = procesosConRegistros.map((proceso, index) => {
      let limiteAvance: number | null = null;

      // Hojeado nunca tiene límite de un proceso anterior: siempre puede
      // ser el punto de entrada de la cascada. Guillotina SÍ puede tener
      // límite -- el que le puso Hojeado -- en cuanto Hojeado tenga
      // registro real (si los dos tienen registro es porque el operador
      // confirmó que van los dos, uno seguido del otro).
      const esHojeadoTabla = proceso.tabla === "hojeado_papel";

      // Primer proceso de esta orden (típicamente Litolaminado en una
      // unión): no hay "anterior" dentro de su propia ruta, así que el
      // límite sale de piezasFinalesTotal en vez de quedar sin tope. Se
      // respeta la misma excepción de Hojeado (nunca tiene límite) por si
      // alguna vez apareciera como primer proceso de una unión.
      if (index === 0 && !esHojeadoTabla) {
        limiteAvance = piezasFinalesTotal;
      } else if (index > 0 && !esHojeadoTabla) {
        let anterior = procesosConRegistros[index - 1];

        // Si lo inmediato anterior es del par Hojeado/Guillotina, usar el
        // que efectivamente rige como límite real: se prefiere Guillotina
        // sobre Hojeado (mismo criterio que getPreparacionUsadaPapel en
        // el backend) porque el orden físico fijo es Hojeado -> Guillotina
        // — si Guillotina tiene registro (aunque sea pendiente), ya es el
        // compromiso real de este pedido y Impresión debe esperarlo a él,
        // no conformarse con lo que entregó Hojeado nada más.
        if (esPrepTabla(anterior.tabla)) {
          const candidatoDosAntes = procesosConRegistros[index - 2];
          const par = [anterior, candidatoDosAntes].filter(
            (p): p is (typeof procesosConRegistros)[number] => !!p && esPrepTabla(p.tabla)
          );
          const usado = par.find((p) => p.registro != null);
          anterior = usado ?? anterior;
          if (!usado) anterior = { ...anterior, registro: null }; // ninguno arrancó -> sin límite
        }

        if (anterior?.registro) {
          const estNum = Number(anterior.registro.estado_produccion_cat_idestado_produccion_cat);
          const campoSalida = CAMPO_SALIDA_PAPEL[anterior.tabla];

          if (estNum === ESTADO_PROD.TERMINADO) {
            const v = anterior.registro[campoSalida];
            limiteAvance = v != null ? Number(v) : null;
          } else {
            const totalAnt = anterior.total_avances ?? 0;
            limiteAvance = totalAnt > 0 ? totalAnt : null;
          }
        }
      }

      return { ...proceso, limite_avance: limiteAvance };
    });

    const procesosFinales = procesosConLimite.map((proceso, index) => {
      let anterior = index > 0 ? procesosConLimite[index - 1] : null;

      if (anterior && esPrepTabla(anterior.tabla)) {
        const candidatoDosAntes = procesosConLimite[index - 2];
        const par = [anterior, candidatoDosAntes].filter(
          (p): p is (typeof procesosConLimite)[number] => !!p && esPrepTabla(p.tabla)
        );
        anterior = par.find((p) => p.registro != null) ?? null;
      }

      const obsAnterior = anterior?.observaciones || null;
      return { ...proceso, observaciones_proceso_anterior: obsAnterior };
    });

    let procesoActual = orden.proceso_actual;
    if (procesoActual && !idAClave.has(Number(procesoActual))) {
      // El proceso_actual guardado ya no aplica (ej. cambió la config del
      // pedido) — buscar el siguiente válido dentro de los que sí aplican.
      procesoActual = (await getSiguienteEfectivoPapel(procesosIds, Number(procesoActual))) ?? procesosIds[0];
    }

    // Esta OP es de unión y todavía espera a sus OP de inicio hermanas
    // (ver unionEsperandoHermanasPapel) — se manda ya resuelto para que el
    // frontend pueda mostrarlo directo en la pantalla, sin que el operador
    // tenga que darle clic a "Iniciar" para enterarse.
    const esperaUnion = await unionEsperandoHermanasPapel(pool, Number(idproduccion));

    return res.json({
      idproduccion: Number(idproduccion),
      no_produccion: orden.no_produccion,
      no_pedido: orden.no_pedido,
      proceso_actual: procesoActual,
      estado_id: orden.idestado_produccion_cat,
      estado_nombre: orden.estado_nombre,
      procesos: procesosFinales,
      espera_union: esperaUnion.espera,
      espera_union_motivo: esperaUnion.motivo ?? null,
      // Especiales, sólo UNIÓN -- ver piezasFinalesHermanasPapel arriba.
      piezas_finales_hermanas: piezasFinalesHermanas,
      piezas_finales_total: piezasFinalesTotal,
    });

  } catch (error: any) {
    console.error("GET PROCESOS ORDEN PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al obtener procesos de papel" });
  }
};

// ════════════════════════════════════════════════════════════════════════
// POST /procesos-papel/:idproduccion/iniciar
// ════════════════════════════════════════════════════════════════════════
export const iniciarProcesoPapel = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { idproduccion } = req.params as { idproduccion: string };
    const { tabla_proceso, maquina, maquinaria_idmaquinaria } = req.body as {
      tabla_proceso?: string;
      maquina?: string;
      maquinaria_idmaquinaria?: number | string;
    };

    if (!tabla_proceso || !TABLAS_VALIDAS_PAPEL.includes(tabla_proceso)) {
      return res.status(400).json({ error: "Debes indicar el proceso válido (tabla_proceso)" });
    }

    await iniciarTx(req, client);

    const procesos = await getProcesosDeOrdenPapel(client, Number(idproduccion));
    const procesoActualCat = await getIdProcesoCatPorTabla(tabla_proceso);
    const maquinaPedido = await getMaquinaElegidaPapel(
      client,
      Number(idproduccion),
      tabla_proceso
    );
    const maquinaFinal = maquina || maquinaPedido?.nombre || undefined;
    const maquinariaIdFinal =
      maquinaria_idmaquinaria || maquinaPedido?.id || undefined;

    if (!procesoActualCat || !procesos.includes(procesoActualCat)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Este proceso no aplica a esta orden de papel" });
    }

    // NOTA (decisión de Jose, 2026-08-24): antes había un bloqueo aquí que
    // impedía iniciar el segundo proceso de preparación si el primero ya
    // había arrancado -- se quitó a propósito. Un pedido puede llevar
    // Hojeado Y Guillotina, uno seguido del otro, o solo uno de los dos.
    // La validación normal de "proceso anterior" (más abajo, vía
    // procesoAnteriorTieneAvanceOTerminadoPapel) ya se encarga de exigir
    // que Hojeado tenga avance o esté terminado antes de poder iniciar
    // Guillotina CUANDO Hojeado sí se usó (ver debeIgnorarAnteriorPapel) —
    // no hace falta un bloqueo especial aquí.

    const { rows: existeRows } = await client.query(
      `SELECT * FROM ${tabla_proceso} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
    );

    if (existeRows.length > 0 && existeRows[0].fecha_inicio) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Este proceso ya fue iniciado" });
    }

    const idx = procesos.indexOf(procesoActualCat);
    if (idx > 0) {
      const puedeIniciar = await procesoAnteriorTieneAvanceOTerminadoPapel(
        client, Number(idproduccion), procesos, procesoActualCat
      );
      if (!puedeIniciar) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "El proceso anterior debe tener al menos un avance registrado o estar finalizado para poder iniciar este proceso",
        });
      }
    } else {
      // idx === 0: primer proceso de la ruta de ESTA orden. Si esta orden
      // es la OP de unión de un especial que fusiona por Litolaminado,
      // no puede arrancar hasta que todas sus OP de inicio hermanas
      // terminen por completo (ver unionEsperandoHermanasPapel).
      const { espera, motivo } = await unionEsperandoHermanasPapel(client, Number(idproduccion));
      if (espera) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: motivo });
      }
    }

    if (existeRows.length === 0) {
      const columnas = ["estado_produccion_cat_idestado_produccion_cat", "orden_produccion_idproduccion", "fecha_creacion", "fecha_inicio"];
      const valores: any[] = [ESTADO_PROD.EN_PROCESO, idproduccion];
      let placeholders = ["$1", "$2", "NOW()", "NOW()"];

      if (
        ["hojeado_papel", "guillotina_papel"].includes(tabla_proceso) &&
        maquinariaIdFinal
      ) {
        columnas.push("maquinaria_idmaquinaria");
        valores.push(Number(maquinariaIdFinal));
        placeholders.push(`$${valores.length}`);
      } else if (maquinaFinal) {
        columnas.push("maquina");
        valores.push(maquinaFinal);
        placeholders.push(`$${valores.length}`);
      }

      await client.query(
        `INSERT INTO ${tabla_proceso} (${columnas.join(", ")}) VALUES (${placeholders.join(", ")})`,
        valores
      );
    } else {
      const setClauses = ["fecha_inicio = NOW()", "estado_produccion_cat_idestado_produccion_cat = $1"];
      const values: any[] = [ESTADO_PROD.EN_PROCESO];
      let paramIdx = 2;

      if (
        ["hojeado_papel", "guillotina_papel"].includes(tabla_proceso) &&
        maquinariaIdFinal
      ) {
        setClauses.push(`maquinaria_idmaquinaria = $${paramIdx}`);
        values.push(Number(maquinariaIdFinal));
        paramIdx++;
      } else if (maquinaFinal) {
        setClauses.push(`maquina = $${paramIdx}`);
        values.push(maquinaFinal);
        paramIdx++;
      }

      values.push(idproduccion);
      await client.query(
        `UPDATE ${tabla_proceso} SET ${setClauses.join(", ")} WHERE orden_produccion_idproduccion = $${paramIdx}`,
        values
      );
    }

    await client.query(
      `UPDATE orden_produccion SET idestado_produccion_cat = $1, proceso_actual = $2 WHERE idproduccion = $3`,
      [ESTADO_PROD.EN_PROCESO, procesoActualCat, idproduccion]
    );

    await client.query("COMMIT");
    return res.json({
      message: `Proceso ${tabla_proceso} iniciado`,
      idproduccion: Number(idproduccion),
      proceso_actual: procesoActualCat,
      tabla: tabla_proceso,
      estado_id: ESTADO_PROD.EN_PROCESO,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("INICIAR PROCESO PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al iniciar proceso de papel" });
  } finally { client.release(); }
};

// ════════════════════════════════════════════════════════════════════════
// POST /procesos-papel/:idproduccion/avance
// ════════════════════════════════════════════════════════════════════════
export const registrarAvancePapel = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { idproduccion } = req.params as { idproduccion: string };
    const { cantidad, observaciones, tabla_proceso } = req.body as {
      cantidad: number | string; observaciones?: string; tabla_proceso: string;
    };

    if (!cantidad || Number(cantidad) <= 0) {
      return res.status(400).json({ error: "La cantidad debe ser mayor a 0" });
    }

    if (!tabla_proceso || !TABLAS_VALIDAS_PAPEL.includes(tabla_proceso)) {
      return res.status(400).json({ error: "Debes indicar el proceso válido (tabla_proceso)" });
    }

    await iniciarTx(req, client);

    const { rows: procesoRows } = await client.query(
      `SELECT estado_produccion_cat_idestado_produccion_cat AS estado, fecha_inicio
       FROM ${tabla_proceso} WHERE orden_produccion_idproduccion = $1`,
      [idproduccion]
    );

    if (procesoRows.length === 0 || !procesoRows[0].fecha_inicio) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El proceso no ha sido iniciado" });
    }

    const est = Number(procesoRows[0].estado);
    if (est === ESTADO_PROD.TERMINADO) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El proceso ya está terminado" });
    }
    if (est === ESTADO_PROD.RESAGADO) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El proceso está resagado" });
    }

    const procesos = await getProcesosDeOrdenPapel(client, Number(idproduccion));
    const limiteAnterior = await getLimiteAvanceAnteriorPapel(client, Number(idproduccion), procesos, tabla_proceso);

    if (limiteAnterior !== null) {
      const { rows: acumRows } = await client.query(
        `SELECT COALESCE(SUM(cantidad), 0) AS total FROM avance_proceso
         WHERE orden_produccion_idproduccion = $1 AND tabla_proceso = $2`,
        [idproduccion, tabla_proceso]
      );

      const acumuladoActual = Number(acumRows[0]?.total ?? 0);
      const proyectado = acumuladoActual + Number(cantidad);

      if (proyectado > limiteAnterior) {
        console.warn(
          `[AVISO] Sobreproducción detectada en ${tabla_proceso} (papel). ` +
          `Límite: ${limiteAnterior}, proyectado: ${proyectado}`
        );
      }
    }

    const unidad = AVANCE_UNIDAD_PAPEL[tabla_proceso] ?? "pliegos";

    const { rows: inserted } = await client.query(
      `INSERT INTO avance_proceso
         (orden_produccion_idproduccion, tabla_proceso, cantidad, unidad, observaciones, fecha_registro)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING idavance, cantidad, unidad, observaciones, fecha_registro`,
      [idproduccion, tabla_proceso, Number(cantidad), unidad, observaciones?.trim() || null]
    );

    await client.query(`
      UPDATE orden_produccion
      SET es_parcialidad = true
      WHERE idproduccion = $1 AND es_parcialidad = false
    `, [idproduccion]);

    // Desbloquear/inicializar el siguiente proceso si aún no existe
    // (sin datos de entrada todavía — la propagación de cantidades reales
    // ocurre al finalizar, igual que en plástico).
    const procesoActualCat = await getIdProcesoCatPorTabla(tabla_proceso);
    const siguienteCat = procesoActualCat ? await getSiguienteEfectivoPapel(procesos, procesoActualCat) : null;

    if (siguienteCat !== null) {
      const tablaSiguiente = await getTablaPorIdProcesoCat(siguienteCat);
      if (tablaSiguiente) {
        const { rows: sigExiste } = await client.query(
          `SELECT 1 FROM ${tablaSiguiente} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
        );
        if (sigExiste.length === 0) {
          await client.query(`
            INSERT INTO ${tablaSiguiente}
              (estado_produccion_cat_idestado_produccion_cat, orden_produccion_idproduccion, fecha_creacion)
            VALUES ($1, $2, NOW())
            ON CONFLICT DO NOTHING
          `, [ESTADO_PROD.PENDIENTE, idproduccion]);
        }
      }
    }

    await client.query("COMMIT");
    return res.status(201).json({
      message: "Avance registrado correctamente",
      idproduccion: Number(idproduccion), tabla: tabla_proceso, avance: inserted[0],
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("REGISTRAR AVANCE PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al registrar avance de papel" });
  } finally { client.release(); }
};

// ════════════════════════════════════════════════════════════════════════
// PUT /procesos-papel/:idproduccion/finalizar
// ════════════════════════════════════════════════════════════════════════
export const finalizarProcesoPapel = async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const { idproduccion } = req.params as { idproduccion: string };
    const datos = req.body;
    const tablaProceso = datos.tabla_proceso as string;

    if (!tablaProceso || !TABLAS_VALIDAS_PAPEL.includes(tablaProceso)) {
      return res.status(400).json({ error: "Debes indicar el proceso válido (tabla_proceso)" });
    }

    await iniciarTx(req, client);

    const procesos = await getProcesosDeOrdenPapel(client, Number(idproduccion));
    const procesoActualCat = await getIdProcesoCatPorTabla(tablaProceso);

    if (!procesoActualCat || !procesos.includes(procesoActualCat)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Este proceso no aplica a esta orden de papel" });
    }

    const { rows: procesoRows } = await client.query(
      `SELECT * FROM ${tablaProceso} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
    );
    if (procesoRows.length === 0 || !procesoRows[0].fecha_inicio) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El proceso no ha sido iniciado aun" });
    }

    const anteriorTerminado = await procesoAnteriorEstaTerminadoPapel(
      client, Number(idproduccion), procesos, procesoActualCat
    );
    if (!anteriorTerminado) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El proceso anterior debe estar finalizado para poder finalizar este proceso" });
    }

    const campos = CAMPOS_PROCESO_PAPEL[tablaProceso] ?? [];
    const setClauses = ["fecha_fin = NOW()", "estado_produccion_cat_idestado_produccion_cat = $1"];
    const values: any[] = [ESTADO_PROD.TERMINADO];
    let paramIdx = 2;

    for (const campo of campos) {
      if (datos[campo] !== undefined && datos[campo] !== null) {
        setClauses.push(`${campo} = $${paramIdx}`); values.push(datos[campo]); paramIdx++;
      }
    }
    if (datos.observaciones !== undefined) {
      setClauses.push(`observaciones = $${paramIdx}`); values.push(datos.observaciones); paramIdx++;
    }

    values.push(idproduccion);
    await client.query(
      `UPDATE ${tablaProceso} SET ${setClauses.join(", ")} WHERE orden_produccion_idproduccion = $${paramIdx}`,
      values
    );

    // Al finalizar Hojeado, el operador puede confirmar explícitamente
    // que este pedido también pasa por Guillotina (una máquina seguida de
    // la otra). En ese caso se salta el "salto de hermano" normal de
    // getSiguienteEfectivoPapel y se apunta directo a Guillotina, que
    // desde ahí queda limitada por lo que Hojeado acaba de entregar (ver
    // debeIgnorarAnteriorPapel / getLimiteAvanceAnteriorPapel). Si no se
    // confirma, el comportamiento es el de siempre: se salta Guillotina y
    // se sigue directo al proceso después del par (normalmente Impresión).
    let siguienteProceso: number | null;
    if (tablaProceso === "hojeado_papel" && datos?.continuar_guillotina === true) {
      const { claveAId } = await getMapaProcesoCatPapel();
      siguienteProceso = claveAId.get("GUILLOTINA") ?? null;
    } else {
      siguienteProceso = await getSiguienteEfectivoPapel(procesos, procesoActualCat);
    }

    if (siguienteProceso !== null) {
      const tablaSiguiente = await getTablaPorIdProcesoCat(siguienteProceso);
      if (!tablaSiguiente) {
        await client.query("ROLLBACK");
        return res.status(500).json({ error: "Proceso siguiente sin tabla asociada" });
      }

      const campoSalidaActual = CAMPO_SALIDA_PAPEL[tablaProceso];
      const valorSalida = campoSalidaActual ? (datos[campoSalidaActual] ?? null) : null;
      const campoEntradaSig = CAMPO_ENTRADA_PAPEL[tablaSiguiente];

      const { rows: sigExisteRows } = await client.query(
        `SELECT 1 FROM ${tablaSiguiente} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
      );
      const sigYaExiste = sigExisteRows.length > 0;

      if (!sigYaExiste) {
        if (campoEntradaSig && valorSalida != null) {
          await client.query(`
            INSERT INTO ${tablaSiguiente}
              (estado_produccion_cat_idestado_produccion_cat, orden_produccion_idproduccion, fecha_creacion, ${campoEntradaSig})
            VALUES ($1, $2, NOW(), $3)
          `, [ESTADO_PROD.PENDIENTE, idproduccion, valorSalida]);
        } else {
          await client.query(`
            INSERT INTO ${tablaSiguiente}
              (estado_produccion_cat_idestado_produccion_cat, orden_produccion_idproduccion, fecha_creacion)
            VALUES ($1, $2, NOW())
          `, [ESTADO_PROD.PENDIENTE, idproduccion]);
        }
      } else if (campoEntradaSig && valorSalida != null) {
        await client.query(`
          UPDATE ${tablaSiguiente} SET ${campoEntradaSig} = COALESCE(${campoEntradaSig}, $1)
          WHERE orden_produccion_idproduccion = $2
        `, [valorSalida, idproduccion]);
      }

      await client.query(`
        UPDATE orden_produccion SET proceso_actual = $1, idestado_produccion_cat = $2 WHERE idproduccion = $3
      `, [siguienteProceso, ESTADO_PROD.PENDIENTE, idproduccion]);
    } else {
      await client.query(`
        UPDATE orden_produccion SET idestado_produccion_cat = $1, proceso_actual = NULL WHERE idproduccion = $2
      `, [ESTADO_PROD.TERMINADO, idproduccion]);

      // ── NUEVO: espejo exacto del enganche en procesosController.finalizarProceso.
      // Se dispara sin importar cuál fue el último proceso real de la cascada
      // de papel (Empaque casi siempre, pero el motor no lo asume — usa
      // getSiguienteEfectivoPapel, así que esta llamada va en el punto
      // genérico correcto). Dentro de la transacción, antes del COMMIT. ──
      await generarEstadoCuentaSiPedidoCompleto(client, Number(idproduccion), req.user?.id ?? null);
    }

    await client.query("COMMIT");
    return res.json({
      message: `Proceso ${tablaProceso} finalizado`, idproduccion: Number(idproduccion),
      proceso_terminado: procesoActualCat, siguiente_proceso: siguienteProceso,
      orden_completada: siguienteProceso === null,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("FINALIZAR PROCESO PAPEL ERROR:", error.message);

    // Código 23503 = violación de llave foránea en Postgres. Si es
    // justo sobre orden_produccion_proceso_actual_fkey, casi siempre es la
    // caché en memoria de proceso_cat desactualizada: un id que era válido
    // cuando el servidor cargó la caché pero que ya no existe en la tabla
    // real (por ejemplo, si proceso_cat se truncó/recargó sin reiniciar el
    // proceso de Node). Limpiar la caché fuerza a releerla del catálogo
    // real en la siguiente petición, sin necesitar un reinicio manual.
    if (error?.code === "23503" && error?.constraint === "orden_produccion_proceso_actual_fkey") {
      cacheClaveAId = null;
      cacheIdAClave = null;
      return res.status(409).json({
        error: "El catálogo de procesos de papel cambió después de que el servidor inició su caché. " +
               "Ya se limpió esa caché -- intenta finalizar el proceso de nuevo.",
      });
    }

    return res.status(500).json({ error: "Error al finalizar proceso de papel" });
  } finally { client.release(); }
};

// ════════════════════════════════════════════════════════════════════════
// PUT /procesos-papel/:idproduccion/editar/:tabla
// ════════════════════════════════════════════════════════════════════════
export const editarProcesoPapel = async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const { idproduccion, tabla } = req.params as { idproduccion: string; tabla: string };
    const datos = req.body;

    if (!TABLAS_VALIDAS_PAPEL.includes(tabla)) {
      return res.status(400).json({ error: `Tabla invalida: ${tabla}` });
    }

    await iniciarTx(req, client);

    const { rows: procesoRows } = await client.query(
      `SELECT * FROM ${tabla} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
    );
    if (procesoRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Proceso no encontrado" });
    }

    const estadoActual = Number(procesoRows[0].estado_produccion_cat_idestado_produccion_cat);
    if (estadoActual !== ESTADO_PROD.TERMINADO) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Solo se pueden editar procesos terminados" });
    }

    const campos = CAMPOS_PROCESO_PAPEL[tabla] ?? [];
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    for (const campo of campos) {
      if (datos[campo] !== undefined) {
        setClauses.push(`${campo} = $${paramIdx}`);
        values.push(datos[campo] !== "" ? datos[campo] : null);
        paramIdx++;
      }
    }
    if (datos.observaciones !== undefined) {
      setClauses.push(`observaciones = $${paramIdx}`); values.push(datos.observaciones || null); paramIdx++;
    }
    if (datos.fecha_inicio !== undefined) {
      // Ver nota en procesosController: el cast explícito evita que Postgres
      // tire el offset del ISO y termine guardando hora de México en una
      // columna que NOW() llena en UTC.
      setClauses.push(`fecha_inicio = $${paramIdx}::timestamptz AT TIME ZONE 'UTC'`);
      values.push(datos.fecha_inicio || null); paramIdx++;
    }
    if (datos.fecha_fin !== undefined) {
      setClauses.push(`fecha_fin = $${paramIdx}::timestamptz AT TIME ZONE 'UTC'`);
      values.push(datos.fecha_fin || null); paramIdx++;
    }

    if (setClauses.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No se enviaron campos para actualizar" });
    }

    values.push(idproduccion);
    await client.query(
      `UPDATE ${tabla} SET ${setClauses.join(", ")} WHERE orden_produccion_idproduccion = $${paramIdx}`,
      values
    );

    // Si se editó el campo de salida y existe el siguiente proceso aún
    // sin iniciar, propagar el nuevo valor como su entrada (igual que
    // plástico hace al editar extrusion/impresion/bolseo).
    const campoSalida = CAMPO_SALIDA_PAPEL[tabla];
    if (campoSalida && datos[campoSalida] != null && datos[campoSalida] !== "") {
      const procesos = await getProcesosDeOrdenPapel(client, Number(idproduccion));
      const catActual = await getIdProcesoCatPorTabla(tabla);
      const siguienteCat = catActual ? await getSiguienteEfectivoPapel(procesos, catActual) : null;
      const tablaSiguiente = siguienteCat ? await getTablaPorIdProcesoCat(siguienteCat) : null;
      const campoEntradaSig = tablaSiguiente ? CAMPO_ENTRADA_PAPEL[tablaSiguiente] : null;

      if (tablaSiguiente && campoEntradaSig) {
        const { rows: sigRows } = await client.query(
          `SELECT fecha_inicio FROM ${tablaSiguiente} WHERE orden_produccion_idproduccion = $1`,
          [idproduccion]
        );
        // Solo propagar si el siguiente aún no inició (no se quiere
        // pisar trabajo ya en curso).
        if (sigRows.length > 0 && !sigRows[0].fecha_inicio) {
          await client.query(
            `UPDATE ${tablaSiguiente} SET ${campoEntradaSig} = $1 WHERE orden_produccion_idproduccion = $2`,
            [datos[campoSalida], idproduccion]
          );
        }
      }
    }

    // ── NUEVO: regeneración automática — mismo criterio que editarProceso
    // (plástico). Idempotente vía generarEstadoCuenta. ──
    await generarEstadoCuentaSiPedidoCompleto(client, Number(idproduccion), req.user?.id ?? null);

    await client.query("COMMIT");
    return res.json({ message: `Proceso ${tabla} actualizado`, idproduccion: Number(idproduccion), tabla });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("EDITAR PROCESO PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al editar proceso de papel" });
  } finally { client.release(); }
};

// ════════════════════════════════════════════════════════════════════════
// DELETE /procesos-papel/:idproduccion/reiniciar/:tabla
//
// Único endpoint destructivo del orquestador de papel, y a propósito
// limitado SOLO a hojeado_papel / guillotina_papel: son el único par de
// procesos que se elige manualmente en planta (con el PDF físico), así
// que es el único caso donde "me equivoqué de proceso" es un escenario
// esperado y no un error de flujo. El resto de la cascada es secuencial
// y su reversión debe manejarse con /editar, no con un borrado.
//
// Bloquea el reinicio si el proceso efectivamente siguiente (normalmente
// Impresión) ya arrancó -- en ese punto ya consumió la salida de este
// proceso como su entrada, y borrar dejaría datos huérfanos.
// ════════════════════════════════════════════════════════════════════════
const PROCESOS_INTERCAMBIABLES_PAPEL = ["hojeado_papel", "guillotina_papel"];

export const reiniciarProcesoPreparacionPapel = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { idproduccion, tabla } = req.params as { idproduccion: string; tabla: string };

    if (!PROCESOS_INTERCAMBIABLES_PAPEL.includes(tabla)) {
      return res.status(400).json({
        error: "Solo se puede reiniciar Hojeado o Guillotina — son el único par intercambiable.",
      });
    }

    await iniciarTx(req, client);

    const procesos = await getProcesosDeOrdenPapel(client, Number(idproduccion));
    const catActual = await getIdProcesoCatPorTabla(tabla);
    if (!catActual) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Proceso inválido" });
    }

    const { rows: existeRows } = await client.query(
      `SELECT fecha_inicio FROM ${tabla} WHERE orden_produccion_idproduccion = $1`, [idproduccion]
    );
    if (existeRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Este proceso no tiene nada que reiniciar" });
    }
    // NOTA: ya no se exige fecha_inicio aquí -- una fila pendiente sin
    // arrancar también se puede "reiniciar" (quitar). Es el caso de
    // Guillotina cuando el operador confirmó al finalizar Hojeado que
    // este pedido también pasaba por Guillotina, pero luego se dio
    // cuenta de que no hacía falta: sin esto, esa fila pendiente se
    // queda huérfana para siempre (Impresión esperaría a Guillotina sin
    // que nadie la vaya a iniciar nunca — ver debeIgnorarAnteriorPapel).

    // Si se está reiniciando Hojeado y Guillotina YA tiene avances o está
    // terminada, bloquear -- Guillotina depende de lo que entregó Hojeado
    // (orden físico fijo Hojeado -> Guillotina), así que borrar Hojeado
    // dejaría a Guillotina con un límite huérfano.
    if (tabla === "hojeado_papel") {
      const { rows: guiRows } = await client.query(
        `SELECT estado_produccion_cat_idestado_produccion_cat AS estado
         FROM guillotina_papel WHERE orden_produccion_idproduccion = $1`,
        [idproduccion]
      );
      const guiTerminada = guiRows.length > 0 && Number(guiRows[0].estado) === ESTADO_PROD.TERMINADO;
      const { rows: guiAvRows } = await client.query(
        `SELECT 1 FROM avance_proceso
         WHERE orden_produccion_idproduccion = $1 AND tabla_proceso = 'guillotina_papel' LIMIT 1`,
        [idproduccion]
      );
      if (guiTerminada || guiAvRows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `No se puede reiniciar: "Guillotina" ya tiene avances registrados o está terminada, y depende de lo que entregó Hojeado.`,
        });
      }
    }

    const siguienteCat = await getSiguienteEfectivoPapel(procesos, catActual);
    if (siguienteCat !== null) {
      const tablaSiguiente = await getTablaPorIdProcesoCat(siguienteCat);
      if (tablaSiguiente) {
        // CORREGIDO: antes bloqueaba con solo que el siguiente proceso
        // tuviera fecha_inicio -- pero "iniciado sin avances" no significa
        // que ya haya consumido nada de este proceso (la propagación real
        // de cantidades ocurre al registrar avance o al finalizar, igual
        // que en el resto de la cascada). Usar el mismo criterio de
        // "avance o terminado" que usa procesoAnteriorTieneAvanceOTerminadoPapel
        // evita bloquear reinicios legítimos por filas que solo se
        // "abrieron" sin capturar nada todavía.
        const { rows: sigRows } = await client.query(
          `SELECT estado_produccion_cat_idestado_produccion_cat AS estado
           FROM ${tablaSiguiente} WHERE orden_produccion_idproduccion = $1`,
          [idproduccion]
        );
        const siguienteTerminado =
          sigRows.length > 0 && Number(sigRows[0].estado) === ESTADO_PROD.TERMINADO;

        const { rows: avRows } = await client.query(
          `SELECT 1 FROM avance_proceso
           WHERE orden_produccion_idproduccion = $1 AND tabla_proceso = $2 LIMIT 1`,
          [idproduccion, tablaSiguiente]
        );
        const siguienteTieneAvance = avRows.length > 0;

        if (siguienteTerminado || siguienteTieneAvance) {
          const { idAClave } = await getMapaProcesoCatPapel();
          const claveSiguiente = idAClave.get(siguienteCat);
          const nombreSiguiente = claveSiguiente
            ? NOMBRE_PROCESO_CAT_PAPEL[claveSiguiente]
            : tablaSiguiente;

          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `No se puede reiniciar: "${nombreSiguiente}" ya tiene avances registrados o está terminado.`,
          });
        }
      }
    }

    await client.query(
      `DELETE FROM avance_proceso WHERE orden_produccion_idproduccion = $1 AND tabla_proceso = $2`,
      [idproduccion, tabla]
    );
    await client.query(
      `DELETE FROM ${tabla} WHERE orden_produccion_idproduccion = $1`,
      [idproduccion]
    );

    // Si la orden apuntaba a este proceso como el actual, regresa el
    // puntero al primero de la cascada (vuelve a quedar "en selección"
    // entre Hojeado/Guillotina) y el estado general a PENDIENTE.
    await client.query(
      `UPDATE orden_produccion SET proceso_actual = $1, idestado_produccion_cat = $2
       WHERE idproduccion = $3 AND proceso_actual = $4`,
      [procesos[0], ESTADO_PROD.PENDIENTE, idproduccion, catActual]
    );

    await client.query("COMMIT");
    return res.json({
      message: `Proceso ${tabla} reiniciado — vuelve a estar disponible para elegir de nuevo`,
      idproduccion: Number(idproduccion),
      tabla,
    });

  } catch (error: any) {
    await client.query("ROLLBACK");
    console.error("REINICIAR PROCESO PREPARACION PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error al reiniciar el proceso" });
  } finally { client.release(); }
};