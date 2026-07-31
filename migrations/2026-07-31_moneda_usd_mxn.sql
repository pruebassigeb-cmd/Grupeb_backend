-- ============================================================
-- Migración: soporte de precios en USD y MXN
-- Fecha: 2026-07-31
--
-- Aplica los cambios de la sección "Cambios de base de datos" del plan
-- "Precios en USD y MXN — Cotización → Pedido → Anticipo/Liquidación →
-- Estados de Cuenta → PDFs".
--
-- Seguro de aplicar contra la base de datos en producción: todas las
-- columnas nuevas llevan DEFAULT/NULL, así que ninguna fila existente
-- cambia de significado (todo lo histórico sigue siendo MXN implícito).
-- No reescribe tablas (ADD COLUMN con default constante es solo metadata
-- en Postgres 11+).
--
-- Ejecutar una sola vez, en orden, dentro de una transacción.
-- ============================================================

BEGIN;

-- ── Tabla nueva: log / valor vigente del tipo de cambio ──────────────────
-- "Vigente" = la fila con la fecha más reciente (ver
-- src/services/tipoCambio/tipoCambio.service.ts, obtenerTipoCambioActual).
CREATE TABLE IF NOT EXISTS public.tipo_cambio
(
    idtipo_cambio serial NOT NULL,
    fecha date NOT NULL,
    valor numeric(10, 4) NOT NULL,               -- MXN por 1 USD
    origen character varying(20) NOT NULL DEFAULT 'banxico'::character varying,
    capturado_por integer,
    created_at timestamp without time zone NOT NULL DEFAULT now(),
    CONSTRAINT tipo_cambio_pkey PRIMARY KEY (idtipo_cambio),
    CONSTRAINT tipo_cambio_fecha_key UNIQUE (fecha),
    CONSTRAINT tipo_cambio_origen_check CHECK (origen IN ('banxico', 'manual')),
    CONSTRAINT tipo_cambio_capturado_por_fkey FOREIGN KEY (capturado_por)
        REFERENCES public.usuarios (idusuario)
);

-- ── Moneda a nivel documento (cotización Y pedido, mismo renglón) ────────
ALTER TABLE public.solicitud
    ADD COLUMN IF NOT EXISTS moneda character varying(3) NOT NULL DEFAULT 'MXN'::character varying,
    ADD COLUMN IF NOT EXISTS tipo_cambio numeric(10, 4);

ALTER TABLE public.solicitud
    DROP CONSTRAINT IF EXISTS solicitud_moneda_check;
ALTER TABLE public.solicitud
    ADD CONSTRAINT solicitud_moneda_check CHECK (moneda IN ('MXN', 'USD'));

-- ── Traza de precio por renglón: equivalente convertido + tipo de cambio usado ──
-- precio_tablero_unitario y cargo_extra_unitario (ya existentes) NO cambian de
-- tipo: a partir de ahora se interpretan "en solicitud.moneda".
ALTER TABLE public.solicitud_detalle_calculo
    ADD COLUMN IF NOT EXISTS moneda character varying(3) NOT NULL DEFAULT 'MXN'::character varying,
    ADD COLUMN IF NOT EXISTS tipo_cambio_aplicado numeric(10, 4),
    ADD COLUMN IF NOT EXISTS precio_calculado_unitario_moneda numeric(12, 2);

ALTER TABLE public.solicitud_detalle_calculo
    DROP CONSTRAINT IF EXISTS solicitud_detalle_calculo_moneda_check;
ALTER TABLE public.solicitud_detalle_calculo
    ADD CONSTRAINT solicitud_detalle_calculo_moneda_check CHECK (moneda IN ('MXN', 'USD'));

COMMENT ON COLUMN public.solicitud_detalle_calculo.precio_calculado_unitario_moneda
    IS 'precio_calculado_unitario ya convertido a solicitud.moneda con tipo_cambio_aplicado; punto de partida antes de que el vendedor edite precio_tablero_unitario.';

-- ── Moneda a nivel venta (copiada de solicitud al aprobar, luego congelada) ──
ALTER TABLE public.ventas
    ADD COLUMN IF NOT EXISTS moneda character varying(3) NOT NULL DEFAULT 'MXN'::character varying,
    ADD COLUMN IF NOT EXISTS tipo_cambio numeric(10, 4);

ALTER TABLE public.ventas
    DROP CONSTRAINT IF EXISTS ventas_moneda_check;
ALTER TABLE public.ventas
    ADD CONSTRAINT ventas_moneda_check CHECK (moneda IN ('MXN', 'USD'));

-- ── Moneda por pago individual (puede diferir de ventas.moneda) ──────────
ALTER TABLE public.venta_pago
    ADD COLUMN IF NOT EXISTS moneda character varying(3) NOT NULL DEFAULT 'MXN'::character varying,
    ADD COLUMN IF NOT EXISTS tipo_cambio_aplicado numeric(10, 4),
    ADD COLUMN IF NOT EXISTS monto_moneda_venta numeric(10, 2);

ALTER TABLE public.venta_pago
    DROP CONSTRAINT IF EXISTS venta_pago_moneda_check;
ALTER TABLE public.venta_pago
    ADD CONSTRAINT venta_pago_moneda_check CHECK (moneda IN ('MXN', 'USD'));

COMMENT ON COLUMN public.venta_pago.monto_moneda_venta
    IS 'monto ya convertido a la moneda de la venta asociada (ventas.moneda); es el campo que alimenta abono/saldo. Si moneda = ventas.moneda, es igual a monto.';

-- Backfill de monto_moneda_venta para pagos históricos: todos son MXN y
-- ventas.moneda también es MXN por default, así que monto_moneda_venta = monto.
UPDATE public.venta_pago SET monto_moneda_venta = monto WHERE monto_moneda_venta IS NULL;

ALTER TABLE public.venta_pago
    ALTER COLUMN monto_moneda_venta SET NOT NULL;

COMMIT;
