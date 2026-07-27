// src/services/reportes/reporteSemanal.queries.ts
import { pool } from "../../config/db";
import { contarDiasHabiles } from "../../utils/diasHabiles";

export type TipoReporte = "produccion" | "cotizaciones" | "pedidos" | "diseno" | "anticipos";

const UMBRAL_DIAS_SIN_AVANCE = 5;
const ESTADO_ADMIN = { PENDIENTE: 1, EN_PROCESO: 2, APROBADO: 3, RECHAZADO: 4 } as const;
const ESTADO_PROD_TERMINADO = 3; // ESTADO_PROD.TERMINADO en procesosController.ts

function inicioSemanaAnterior(hoy: Date): Date {
  // Ventana rolling de 7 días — cubre exactamente la semana desde el
  // envío anterior (lunes 8am a lunes 8am).
  const d = new Date(hoy);
  d.setDate(d.getDate() - 7);
  return d;
}

// ============================================================
// 1. PRODUCCIÓN — órdenes habilitadas nuevas (última semana)
// ============================================================
export interface OrdenHabilitadaNueva {
  idproduccion: number;
  no_produccion: string;
  no_pedido: string;
  cliente: string;
  empresa: string | null;
  fecha_habilitacion: Date;
}

export async function obtenerOrdenesHabilitadasNuevas(hoy = new Date()): Promise<OrdenHabilitadaNueva[]> {
  const desde = inicioSemanaAnterior(hoy);
  const { rows } = await pool.query(
    `SELECT
       op.idproduccion, op.no_produccion, op.fecha AS fecha_habilitacion,
       s.no_pedido, c.razon_social AS cliente, c.empresa
     FROM orden_produccion op
     JOIN solicitud_producto sp ON sp.idsolicitud_producto = op.idsolicitud_producto
     JOIN solicitud s ON s.idsolicitud = sp.solicitud_idsolicitud
     LEFT JOIN clientes c ON c.idclientes = s.clientes_idclientes
     WHERE op.fecha >= $1
     ORDER BY op.fecha DESC`,
    [desde],
  );
  return rows;
}

// ============================================================
// 2. PRODUCCIÓN — órdenes con +5 días hábiles sin avance
//    (desde el último avance_proceso, o desde la habilitación si nunca
//    tuvo ninguno). Excluye órdenes ya TERMINADAS.
// ============================================================
export interface OrdenSinAvance {
  idproduccion: number;
  no_produccion: string;
  no_pedido: string;
  cliente: string;
  empresa: string | null;
  fecha_habilitacion: Date;
  ultimo_avance: Date | null;
  dias_habiles_sin_avance: number;
}

export async function obtenerOrdenesSinAvance(hoy = new Date()): Promise<OrdenSinAvance[]> {
  const { rows } = await pool.query(
    `SELECT
       op.idproduccion, op.no_produccion, op.fecha AS fecha_habilitacion,
       s.no_pedido, c.razon_social AS cliente, c.empresa,
       (SELECT MAX(fecha_registro) FROM avance_proceso
         WHERE orden_produccion_idproduccion = op.idproduccion) AS ultimo_avance
     FROM orden_produccion op
     JOIN solicitud_producto sp ON sp.idsolicitud_producto = op.idsolicitud_producto
     JOIN solicitud s ON s.idsolicitud = sp.solicitud_idsolicitud
     LEFT JOIN clientes c ON c.idclientes = s.clientes_idclientes
     WHERE op.idestado_produccion_cat != $1`,
    [ESTADO_PROD_TERMINADO],
  );

  return rows
    .map((r) => {
      const baseFecha = r.ultimo_avance ? new Date(r.ultimo_avance) : new Date(r.fecha_habilitacion);
      return { ...r, dias_habiles_sin_avance: contarDiasHabiles(baseFecha, hoy) };
    })
    .filter((r) => r.dias_habiles_sin_avance > UMBRAL_DIAS_SIN_AVANCE)
    .sort((a, b) => b.dias_habiles_sin_avance - a.dias_habiles_sin_avance);
}

// ============================================================
// 3. COTIZACIONES — nuevas de la última semana
// ============================================================
export interface CotizacionNueva {
  idsolicitud: number;
  no_cotizacion: string;
  cliente: string;
  empresa: string | null;
  fecha: Date;
}

export async function obtenerCotizacionesNuevas(hoy = new Date()): Promise<CotizacionNueva[]> {
  const desde = inicioSemanaAnterior(hoy);
  const { rows } = await pool.query(
    `SELECT s.idsolicitud, s.no_cotizacion, s.fecha, c.razon_social AS cliente, c.empresa
     FROM solicitud s
     LEFT JOIN clientes c ON c.idclientes = s.clientes_idclientes
     WHERE s.estado = 'cotizacion' AND s.fecha >= $1
     ORDER BY s.fecha DESC`,
    [desde],
  );
  return rows;
}

// ============================================================
// 4. COTIZACIONES — +5 días hábiles sin avance ni aprobación
//
//    NOTA: `solicitud` no tiene columna de "última actividad" — el cambio
//    de estado_administrativo_cat no queda con timestamp en ningún lado.
//    Por eso esto mide días hábiles desde `fecha` (creación) para
//    cotizaciones que siguen en estado = 'cotizacion' (no aprobadas).
//    Si se agrega `fecha_actualizacion` a `solicitud` más adelante, este
//    query se puede afinar para medir desde el último cambio real.
// ============================================================
export interface CotizacionSinAvance {
  idsolicitud: number;
  no_cotizacion: string;
  cliente: string;
  empresa: string | null;
  fecha: Date;
  dias_habiles_sin_avance: number;
}

export async function obtenerCotizacionesSinAvance(hoy = new Date()): Promise<CotizacionSinAvance[]> {
  const { rows } = await pool.query(
    `SELECT s.idsolicitud, s.no_cotizacion, s.fecha, c.razon_social AS cliente, c.empresa
     FROM solicitud s
     LEFT JOIN clientes c ON c.idclientes = s.clientes_idclientes
     WHERE s.estado = 'cotizacion'`,
  );

  return rows
    .map((r) => ({ ...r, dias_habiles_sin_avance: contarDiasHabiles(new Date(r.fecha), hoy) }))
    .filter((r) => r.dias_habiles_sin_avance > UMBRAL_DIAS_SIN_AVANCE)
    .sort((a, b) => b.dias_habiles_sin_avance - a.dias_habiles_sin_avance);
}

// ============================================================
// 5. PEDIDOS — nuevos de la última semana (cotización aprobada → pedido)
// ============================================================
export interface PedidoNuevo {
  idsolicitud: number;
  no_pedido: string;
  no_cotizacion: string | null;
  cliente: string;
  empresa: string | null;
  fecha_aprobacion: Date;
}

export async function obtenerPedidosNuevos(hoy = new Date()): Promise<PedidoNuevo[]> {
  const desde = inicioSemanaAnterior(hoy);
  const { rows } = await pool.query(
    `SELECT s.idsolicitud, s.no_pedido, s.no_cotizacion, s.fecha_aprobacion,
            c.razon_social AS cliente, c.empresa
     FROM solicitud s
     LEFT JOIN clientes c ON c.idclientes = s.clientes_idclientes
     WHERE s.estado = 'pedido' AND s.fecha_aprobacion >= $1
     ORDER BY s.fecha_aprobacion DESC`,
    [desde],
  );
  return rows;
}

// ============================================================
// 6. DISEÑO — pendientes de aprobación, de pedidos nuevos de la semana
// ============================================================
export interface DisenoPendiente {
  no_pedido: string;
  cliente: string;
  empresa: string | null;
  fecha_aprobacion_pedido: Date;
  estado_diseno: string;
}

export async function obtenerDisenoPendientes(hoy = new Date()): Promise<DisenoPendiente[]> {
  const desde = inicioSemanaAnterior(hoy);
  const { rows } = await pool.query(
    `SELECT s.no_pedido, c.razon_social AS cliente, c.empresa,
            s.fecha_aprobacion AS fecha_aprobacion_pedido,
            ea.nombre AS estado_diseno
     FROM diseno d
     JOIN solicitud s ON s.idsolicitud = d.solicitud_idsolicitud
     LEFT JOIN clientes c ON c.idclientes = s.clientes_idclientes
     LEFT JOIN estado_administrativo_cat ea
       ON ea.idestado_administrativo_cat = d.estado_administrativo_cat_idestado_administrativo_cat
     WHERE s.fecha_aprobacion >= $1
       AND d.estado_administrativo_cat_idestado_administrativo_cat NOT IN ($2, $3)
     ORDER BY s.fecha_aprobacion DESC`,
    [desde, ESTADO_ADMIN.APROBADO, ESTADO_ADMIN.RECHAZADO],
  );
  return rows;
}

// ============================================================
// 7. ANTICIPOS — pendientes de aprobación, de pedidos nuevos de la semana
// ============================================================
export interface AnticipoPendiente {
  idventas: number;
  no_pedido: string;
  cliente: string;
  empresa: string | null;
  anticipo: number;
  abono: number;
  saldo: number;
  fecha_aprobacion_pedido: Date;
  estado_anticipo: string;
}

// ============================================================
// 8. USUARIOS con sus reportes activos — para armar el correo
//    combinado personalizado (cada quien ve solo lo que marcó)
// ============================================================
export interface UsuarioConReportes {
  correo: string;
  reportes: TipoReporte[];
}

export async function obtenerUsuariosConReportesActivos(): Promise<UsuarioConReportes[]> {
  const { rows } = await pool.query(`
    SELECT u.correo, array_agg(pcr.reporte) AS reportes
    FROM usuarios u
    JOIN preferencia_correo_reporte pcr ON pcr.usuarios_idusuario = u.idusuario
    WHERE u.activo = true
    GROUP BY u.correo
  `);
  return rows.map((r) => ({ correo: r.correo, reportes: r.reportes as TipoReporte[] }));
}

export async function obtenerAnticiposPendientes(hoy = new Date()): Promise<AnticipoPendiente[]> {
  const desde = inicioSemanaAnterior(hoy);
  const { rows } = await pool.query(
    `SELECT v.idventas, s.no_pedido, c.razon_social AS cliente, c.empresa,
            v.anticipo, v.abono, v.saldo,
            s.fecha_aprobacion AS fecha_aprobacion_pedido,
            ea.nombre AS estado_anticipo
     FROM ventas v
     JOIN solicitud s ON s.idsolicitud = v.solicitud_idsolicitud
     LEFT JOIN clientes c ON c.idclientes = s.clientes_idclientes
     LEFT JOIN estado_administrativo_cat ea
       ON ea.idestado_administrativo_cat = v.estado_administrativo_cat_idestado_administrativo_cat
     WHERE s.fecha_aprobacion >= $1
       AND v.estado_administrativo_cat_idestado_administrativo_cat != $2
     ORDER BY s.fecha_aprobacion DESC`,
    [desde, ESTADO_ADMIN.APROBADO],
  );
  return rows;
}