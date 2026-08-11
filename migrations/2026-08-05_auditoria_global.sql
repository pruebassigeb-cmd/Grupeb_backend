-- ============================================================================
-- AUDITORÍA GLOBAL
-- 2026-08-05
--
-- Extiende a toda la base la auditoría que hoy solo cubre 12 tablas del
-- módulo de ficha de diseño.
--
-- NO introduce un sistema paralelo: reusa las piezas que ya están instaladas
-- (fn_auditoria, fn_tocar_autoria, fn_usuario_actual, fn_contexto_actual,
-- sp_activar_auditoria) y les agrega lo que les faltaba:
--
--   · soporte para llave primaria compuesta  (6 tablas se quedaban fuera,
--     entre ellas privilegios_has_usuarios — "quién le dio qué permiso a
--     quién", que es justo lo que más importa auditar)
--   · modo liviano para tablas de altísima rotación
--   · columnas de autoría y borrado lógico aplicadas en lote
--
-- El usuario NO se pasa por parámetro: los triggers lo leen de
-- current_setting('app.usuario_id'), que el backend declara con SET LOCAL
-- dentro de cada transacción (src/middlewares/auditoria.ts).
--
-- Consecuencia directa: cualquier escritura que NO pase por req.tx() queda
-- registrada con usuario_id = NULL. Ese es el trabajo de la Fase 1.
--
-- REQUISITO: correr ANTES 2026-08-05_auditoria_00_base.sql, que trae
-- bitacora_cambios, fn_usuario_actual() y fn_contexto_actual(). Este archivo
-- los da por existentes; sin ellos falla.
--
-- Este archivo es idempotente. Se puede correr las veces que haga falta.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. BITÁCORA — columna nueva e índices
-- ============================================================================

-- registro_id es un solo integer y no alcanza para las 6 tablas con PK
-- compuesta (privilegios_has_usuarios, roles_privilegios, domicilio,
-- datos_facturacion, preferencia_correo_reporte, pedido).
--
-- registro_clave guarda SIEMPRE la llave completa. registro_id sigue
-- guardando la columna por la que tiene sentido consultar el historial, que
-- en las compuestas no es necesariamente la primera.
ALTER TABLE public.bitacora_cambios
    ADD COLUMN IF NOT EXISTS registro_clave jsonb;

COMMENT ON COLUMN public.bitacora_cambios.registro_clave
    IS 'Llave primaria completa del registro. Necesaria en tablas con PK compuesta.';

-- El índice que importa: "dame el historial de ESTE registro".
CREATE INDEX IF NOT EXISTS ix_bitacora_tabla_registro
    ON public.bitacora_cambios (tabla, registro_id, created_at DESC);

-- Para el reporte "qué hizo Fulano el martes".
CREATE INDEX IF NOT EXISTS ix_bitacora_usuario
    ON public.bitacora_cambios (usuario_id, created_at DESC);

-- Para la purga por antigüedad.
CREATE INDEX IF NOT EXISTS ix_bitacora_created
    ON public.bitacora_cambios (created_at DESC);

-- Para consultar por la llave completa en las tablas de PK compuesta:
--   WHERE tabla = 'privilegios_has_usuarios'
--     AND registro_clave @> '{"usuarios_idusuario": 5}'
CREATE INDEX IF NOT EXISTS ix_bitacora_clave
    ON public.bitacora_cambios USING gin (registro_clave jsonb_path_ops);


-- ============================================================================
-- 2. fn_auditoria()  —  AFTER INSERT OR UPDATE OR DELETE
--
--    Versión extendida de la que ya estaba instalada. Compatible hacia atrás:
--    los 12 triggers actuales pasan un solo argumento y siguen funcionando
--    exactamente igual.
--
--    Argumentos:
--      TG_ARGV[0] = columna por la que se consulta el historial → registro_id
--      TG_ARGV[1] = (opcional) todas las columnas de la PK, separadas por
--                   coma → registro_clave. Si falta, se asume PK simple.
--      TG_ARGV[2] = (opcional) 'true' → modo liviano: NO guarda
--                   datos_antes/datos_despues, solo acción + usuario +
--                   campos. Para tablas donde el jsonb completo haría crecer
--                   la base sin que nadie vaya a leer esos renglones.
--
--    Se conserva SECURITY DEFINER: la bitácora se escribe aunque el rol de
--    la aplicación no tenga INSERT directo sobre bitacora_cambios.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_auditoria()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_pk        text;
    v_pk_todas  text[];
    v_liviano   boolean;
    v_antes     jsonb;
    v_despues   jsonb;
    v_ref       jsonb;
    v_campos    text[];
    v_id        integer;
    v_clave     jsonb;
BEGIN
    v_pk       := TG_ARGV[0];
    v_pk_todas := CASE WHEN TG_NARGS > 1
                       THEN string_to_array(TG_ARGV[1], ',')
                       ELSE ARRAY[v_pk] END;
    v_liviano  := CASE WHEN TG_NARGS > 2
                       THEN TG_ARGV[2]::boolean
                       ELSE false END;

    IF TG_OP = 'DELETE' THEN
        v_antes   := to_jsonb(OLD);
        v_despues := NULL;

    ELSIF TG_OP = 'UPDATE' THEN
        v_antes   := to_jsonb(OLD);
        v_despues := to_jsonb(NEW);

        SELECT array_agg(d.key ORDER BY d.key)
          INTO v_campos
          FROM jsonb_each(v_despues) AS d
         WHERE d.value IS DISTINCT FROM (v_antes -> d.key)
           AND d.key NOT IN ('updated_at', 'actualizado_por');

        -- Un UPDATE que no cambió nada no merece renglón.
        IF v_campos IS NULL THEN
            RETURN NULL;
        END IF;

    ELSE
        v_antes   := NULL;
        v_despues := to_jsonb(NEW);
    END IF;

    -- En DELETE la fila viva es OLD; en el resto es NEW.
    v_ref   := COALESCE(v_despues, v_antes);
    v_id    := (v_ref ->> v_pk)::integer;
    v_clave := (SELECT jsonb_object_agg(k, v_ref -> k)
                  FROM unnest(v_pk_todas) AS k);

    INSERT INTO public.bitacora_cambios
        (tabla, registro_id, registro_clave, accion, usuario_id,
         datos_antes, datos_despues, campos_cambiados, contexto)
    VALUES
        (TG_TABLE_NAME, v_id, v_clave, TG_OP, public.fn_usuario_actual(),
         CASE WHEN v_liviano THEN NULL ELSE v_antes   END,
         CASE WHEN v_liviano THEN NULL ELSE v_despues END,
         v_campos,
         public.fn_contexto_actual());

    RETURN NULL;
END;
$function$;


-- ============================================================================
-- 3. fn_tocar_autoria()  —  BEFORE INSERT OR UPDATE
--
--    Misma semántica que la versión instalada, con un solo cambio: en vez de
--    reconstruir la fila COMPLETA con jsonb_populate_record, se le aplica un
--    PARCHE que solo contiene columnas de auditoría (integer y timestamp).
--
--    A 12 tablas daba igual. A 113 sí importa: pasar cada fila entera por
--    jsonb en cada INSERT y cada UPDATE cuesta, y expone tipos poco comunes
--    (arrays, jsonb anidado, numeric de alta precisión) a un round-trip que
--    no necesitan hacer.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_tocar_autoria()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_usuario integer := public.fn_usuario_actual();
    v_nuevo   jsonb   := to_jsonb(NEW);
    v_parche  jsonb   := '{}'::jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Si el controller ya mandó un valor explícito, se respeta.
        IF v_nuevo ? 'creado_por' AND (v_nuevo ->> 'creado_por') IS NULL THEN
            v_parche := v_parche || jsonb_build_object('creado_por', v_usuario);
        END IF;

        IF v_nuevo ? 'created_at' AND (v_nuevo ->> 'created_at') IS NULL THEN
            v_parche := v_parche || jsonb_build_object('created_at', now());
        END IF;

    ELSE  -- UPDATE
        IF v_nuevo ? 'actualizado_por' THEN
            v_parche := v_parche || jsonb_build_object('actualizado_por', v_usuario);
        END IF;

        IF v_nuevo ? 'updated_at' THEN
            v_parche := v_parche || jsonb_build_object('updated_at', now());
        END IF;

        -- Borrado lógico: si se está marcando eliminado_at y no se declaró
        -- quién, se pone el usuario de la transacción.
        IF v_nuevo ? 'eliminado_at' AND v_nuevo ? 'eliminado_por'
           AND (v_nuevo ->> 'eliminado_at')  IS NOT NULL
           AND (v_nuevo ->> 'eliminado_por') IS NULL THEN
            v_parche := v_parche || jsonb_build_object('eliminado_por', v_usuario);
        END IF;
    END IF;

    IF v_parche = '{}'::jsonb THEN
        RETURN NEW;
    END IF;

    RETURN jsonb_populate_record(NEW, v_parche);
END;
$function$;


-- ============================================================================
-- 4. sp_activar_auditoria()  —  instalador por tabla
--
--    La versión instalada rechaza las PK compuestas. Esta acepta un override
--    para decir por cuál columna se consulta el historial, y un flag para el
--    modo liviano.
--
--    Se dropea la firma vieja de un solo argumento: dejarla viva volvería
--    ambigua cualquier llamada sp_activar_auditoria('tabla').
--    Los nombres de trigger no cambian (trg_autoria_X / trg_bitacora_X), así
--    que las 12 tablas ya instaladas se reinstalan limpias, sin duplicar.
-- ============================================================================

DROP FUNCTION IF EXISTS public.sp_activar_auditoria(text);

CREATE OR REPLACE FUNCTION public.sp_activar_auditoria(
    p_tabla       text,
    p_pk_consulta text    DEFAULT NULL,
    p_liviano     boolean DEFAULT false
)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_cols  text[];
    v_pk    text;
BEGIN
    IF to_regclass('public.' || quote_ident(p_tabla)) IS NULL THEN
        RETURN 'La tabla ' || p_tabla || ' no existe.';
    END IF;

    SELECT array_agg(a.attname ORDER BY a.attnum)
      INTO v_cols
      FROM pg_index i
      JOIN pg_attribute a
        ON a.attrelid = i.indrelid
       AND a.attnum   = ANY (i.indkey)
     WHERE i.indrelid = ('public.' || quote_ident(p_tabla))::regclass
       AND i.indisprimary;

    IF v_cols IS NULL THEN
        RETURN p_tabla || ' no tiene llave primaria. No se instaló auditoría.';
    END IF;

    IF array_length(v_cols, 1) = 1 THEN
        v_pk := v_cols[1];
    ELSE
        v_pk := p_pk_consulta;
        IF v_pk IS NULL THEN
            RETURN p_tabla || ' tiene PK compuesta (' ||
                   array_to_string(v_cols, ', ') ||
                   '). Indica p_pk_consulta para instalarla.';
        END IF;
        IF NOT (v_pk = ANY(v_cols)) THEN
            RETURN p_tabla || ': ' || v_pk || ' no es parte de la PK.';
        END IF;
    END IF;

    EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_autoria_%1$s ON public.%1$I',
        p_tabla);

    EXECUTE format(
        'CREATE TRIGGER trg_autoria_%1$s
         BEFORE INSERT OR UPDATE ON public.%1$I
         FOR EACH ROW EXECUTE FUNCTION public.fn_tocar_autoria()',
        p_tabla);

    EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_bitacora_%1$s ON public.%1$I',
        p_tabla);

    EXECUTE format(
        'CREATE TRIGGER trg_bitacora_%1$s
         AFTER INSERT OR UPDATE OR DELETE ON public.%1$I
         FOR EACH ROW EXECUTE FUNCTION public.fn_auditoria(%2$L, %3$L, %4$L)',
        p_tabla, v_pk, array_to_string(v_cols, ','), p_liviano::text);

    RETURN 'Auditoría activa en ' || p_tabla ||
           ' (consulta por: ' || v_pk ||
           CASE WHEN p_liviano THEN ', liviano' ELSE '' END || ').';
END;
$function$;


-- ============================================================================
-- 5. APLICACIÓN EN LOTE
--
--    Lista de EXCLUSIÓN, no de inclusión: cualquier tabla nueva queda
--    auditada por omisión la próxima vez que se corra este script. Es más
--    seguro olvidar excluir una tabla estática que olvidar incluir una de
--    negocio.
-- ============================================================================

DO $aplicacion$
DECLARE
    r        record;
    v_msg    text;
    v_total  integer := 0;
    v_omit   integer := 0;

    -- ------------------------------------------------------------------
    -- EXCLUIDAS (57). Criterio: el backend nunca les escribe (verificado
    -- contra los ~500 statements de escritura en src/), o son ruido puro.
    -- ------------------------------------------------------------------
    v_excluidas text[] := ARRAY[
        -- la bitácora no se audita a sí misma
        'bitacora_cambios',

        -- catálogos cat_* que solo se siembran. Los que SÍ se editan desde
        -- el admin de precios (cat_acabado_costo, cat_cortes, cat_dobles,
        -- cat_escala_costo, cat_puntos) y cat_zona_producto —que ya está
        -- auditada— NO están aquí.
        'cat_alto_relieve_maquina', 'cat_armado', 'cat_asas_maquina',
        'cat_calibre', 'cat_desbarbe', 'cat_empalme', 'cat_empaque',
        'cat_empaque_maquina', 'cat_hojeado_guillotina', 'cat_hs_ar',
        'cat_impresora', 'cat_laminado', 'cat_laminado_maquina',
        'cat_limite_pantone', 'cat_pegamento', 'cat_perforado',
        'cat_refuerzo_material', 'cat_refuerzo_medidas', 'cat_sacabocados',
        'cat_suaje_maquina', 'cat_tamano_producto', 'cat_textura',
        'cat_texturizadora', 'cat_tipo_asa', 'cat_tipo_papel',
        'cat_tipo_pegado', 'cat_tipo_producto_papel', 'cat_uv',

        -- mapeo máquina <-> proceso, sembrado una vez
        'maquinaria_alto_relieve', 'maquinaria_armado',
        'maquinaria_asas_maquina', 'maquinaria_desbarbe',
        'maquinaria_empalme', 'maquinaria_empaque',
        'maquinaria_hojeado_guillotina', 'maquinaria_hs_ar',
        'maquinaria_impresora', 'maquinaria_laminado',
        'maquinaria_suaje_maquina', 'maquinaria_textura',
        'maquinaria_texturizadora', 'maquinaria_uv',

        -- catálogos fiscales / SAT / geográficos
        'codigos_postales', 'producto_sat', 'regimen_fiscal',
        'objeto_impuesto', 'forma_pago', 'metodo_pago',

        -- catálogos de estado del flujo
        'estado_administrativo_cat', 'estado_produccion_cat', 'proceso_cat',

        -- lookups menores
        'caras', 'color_asa',

        -- ruido técnico: alto volumen, cero valor de auditoría, y en el caso
        -- de verificacion_cotizador_libre además guarda códigos de un solo uso
        'push_subscriptions', 'notificaciones', 'verificacion_cotizador_libre'
    ];

    -- ------------------------------------------------------------------
    -- PK COMPUESTA → por cuál columna se consulta el historial.
    --
    -- Son 6 tablas. La llave completa siempre queda en registro_clave;
    -- esto solo decide desde qué pantalla tiene sentido pedir el historial:
    -- "¿qué le pasó a ESTE cliente / usuario / rol?".
    -- ------------------------------------------------------------------
    v_pk_consulta jsonb := jsonb_build_object(
        'privilegios_has_usuarios',   'usuarios_idusuario',
        'roles_privilegios',          'roles_idroles',
        'domicilio',                  'clientes_idclientes',
        'datos_facturacion',          'clientes_idclientes',
        'preferencia_correo_reporte', 'usuarios_idusuario',
        'pedido',                     'idpedido'
    );

    -- ------------------------------------------------------------------
    -- MODO LIVIANO: se audita QUÉ y QUIÉN, pero sin el jsonb antes/después.
    -- solicitud_detalle_calculo la reescribe el motor de precios en cada
    -- recálculo; guardarle el payload completo hace crecer la base sin que
    -- nadie vaya a leer esos renglones.
    -- ------------------------------------------------------------------
    v_sin_payload text[] := ARRAY[
        'solicitud_detalle_calculo',
        'avance_proceso'
    ];

    -- ------------------------------------------------------------------
    -- BORRADO LÓGICO: solo donde perder el renglón rompe la trazabilidad
    -- del dinero, del pedido o de la conversación.
    --
    -- Fuera de esta lista se usa el 'activo' que ya existe: desactivar es
    -- un UPDATE y la bitácora ya registra quién y cuándo, sin obligar a
    -- meter "AND eliminado_at IS NULL" en cada SELECT del sistema.
    -- ------------------------------------------------------------------
    v_borrado_logico text[] := ARRAY[
        -- dinero
        'ventas', 'venta_pago',
        -- cotización / pedido
        'solicitud', 'solicitud_detalle', 'solicitud_producto',
        'solicitud_producto_papel', 'solicitud_detalle_calculo', 'herramental',
        -- producción
        'orden_produccion',
        -- envíos y remisiones
        'envio', 'envio_bulto', 'bultos', 'nota_remision',
        'nota_remision_envio', 'bitacora_reparto',
        -- diseño
        'diseno', 'diseno_producto',
        -- personas (borrar un usuario dejaría huérfano cada creado_por)
        'usuarios',
        -- las que ya lo traían del módulo de ficha
        'archivos', 'cliente_red_social', 'ficha_detalle',
        'ficha_detalle_ubicacion', 'ficha_imagen', 'ficha_pantone',
        'mensaje_diseno', 'orden_diseno', 'orden_diseno_ficha',
        'orden_diseno_participante', 'revision_diseno'
    ];
BEGIN
    FOR r IN
        SELECT c.relname AS tabla
          FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace
           AND c.relkind = 'r'
           AND NOT (c.relname = ANY(v_excluidas))
         ORDER BY c.relname
    LOOP
        -- --------------------------------------------------------------
        -- Columnas de autoría.
        --
        -- created_at se agrega SIN default a propósito: los renglones que
        -- ya existían quedan en NULL, que es la verdad ("no hay registro"),
        -- en vez de mentir diciendo que se crearon hoy. Los nuevos los
        -- llena fn_tocar_autoria.
        --
        -- Las tablas que ya tenían created_at conservan su default: el
        -- ADD COLUMN IF NOT EXISTS no las toca.
        -- --------------------------------------------------------------
        EXECUTE format($ddl$
            ALTER TABLE public.%I
                ADD COLUMN IF NOT EXISTS creado_por      integer REFERENCES public.usuarios(idusuario),
                ADD COLUMN IF NOT EXISTS created_at      timestamp,
                ADD COLUMN IF NOT EXISTS actualizado_por integer REFERENCES public.usuarios(idusuario),
                ADD COLUMN IF NOT EXISTS updated_at      timestamp
        $ddl$, r.tabla);

        IF r.tabla = ANY(v_borrado_logico) THEN
            EXECUTE format($ddl$
                ALTER TABLE public.%I
                    ADD COLUMN IF NOT EXISTS eliminado_at  timestamp,
                    ADD COLUMN IF NOT EXISTS eliminado_por integer REFERENCES public.usuarios(idusuario)
            $ddl$, r.tabla);

            -- Índice parcial: los SELECT que filtren "no eliminados" no
            -- pagan por los renglones muertos.
            EXECUTE format(
                'CREATE INDEX IF NOT EXISTS %I ON public.%I (%I) WHERE eliminado_at IS NULL',
                'ix_' || r.tabla || '_vivos', r.tabla,
                (SELECT a.attname
                   FROM pg_index i
                   JOIN pg_attribute a
                     ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                  WHERE i.indrelid = format('public.%I', r.tabla)::regclass
                    AND i.indisprimary
                  ORDER BY a.attnum
                  LIMIT 1)
            );
        END IF;

        -- --------------------------------------------------------------
        -- Triggers, vía el instalador que ya existía.
        -- --------------------------------------------------------------
        v_msg := public.sp_activar_auditoria(
            r.tabla,
            v_pk_consulta ->> r.tabla,
            r.tabla = ANY(v_sin_payload)
        );

        IF v_msg LIKE 'Auditoría activa%' THEN
            v_total := v_total + 1;
        ELSE
            RAISE NOTICE 'OMITIDA %', v_msg;
            v_omit := v_omit + 1;
        END IF;
    END LOOP;

    RAISE NOTICE '--------------------------------------------';
    RAISE NOTICE 'Tablas auditadas: %', v_total;
    RAISE NOTICE 'Tablas omitidas:  %', v_omit;
    RAISE NOTICE '--------------------------------------------';
END
$aplicacion$;


-- ============================================================================
-- 6. PROTECCIÓN DE LA BITÁCORA
--
--    "Registro inmutable" tiene que ser una regla de la base, no una buena
--    intención en un comentario. Un UPDATE o un DELETE sobre bitacora_cambios
--    truena, venga de donde venga.
--
--    Para purgar por antigüedad hay que deshabilitar el trigger a propósito,
--    en una ventana de mantenimiento:
--       ALTER TABLE bitacora_cambios DISABLE TRIGGER trg_bitacora_inmutable;
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_bitacora_inmutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    RAISE EXCEPTION 'bitacora_cambios es de solo inserción (intento de %)', TG_OP;
END;
$function$;

DROP TRIGGER IF EXISTS trg_bitacora_inmutable ON public.bitacora_cambios;
CREATE TRIGGER trg_bitacora_inmutable
    BEFORE UPDATE OR DELETE ON public.bitacora_cambios
    FOR EACH ROW EXECUTE FUNCTION public.fn_bitacora_inmutable();


COMMIT;


-- ============================================================================
-- VERIFICACIÓN — correr después del COMMIT
-- ============================================================================
--
-- Cuántas tablas quedaron con cada trigger (se esperan 113 y 113):
--
--   SELECT p.proname, count(*)
--     FROM pg_trigger t
--     JOIN pg_proc p ON p.oid = t.tgfoid
--    WHERE NOT t.tgisinternal
--    GROUP BY 1 ORDER BY 1;
--
-- Prueba de humo — debe devolver un renglón con usuario_id = 7:
--
--   BEGIN;
--     SELECT set_config('app.usuario_id', '7', true);
--     UPDATE proveedor SET notas = COALESCE(notas,'') || ' x'
--      WHERE idproveedor = (SELECT min(idproveedor) FROM proveedor);
--     SELECT tabla, registro_id, registro_clave, accion, usuario_id, campos_cambiados
--       FROM bitacora_cambios ORDER BY idbitacora_cambio DESC LIMIT 1;
--   ROLLBACK;
--
-- Que la bitácora sea inmutable (debe tronar):
--
--   DELETE FROM bitacora_cambios WHERE idbitacora_cambio = 1;
-- ============================================================================
