BEGIN;

-- Privilegios ya utilizados por el frontend y el backend. Los INSERT son
-- idempotentes para que la migración también funcione en una base nueva.
INSERT INTO privilegios (privilegio, acceso, created_at)
SELECT 'Editar Diseño', true, now()
WHERE NOT EXISTS (
  SELECT 1 FROM privilegios WHERE privilegio = 'Editar Diseño'
);

INSERT INTO privilegios (privilegio, acceso, created_at)
SELECT 'Orden de Diseño', true, now()
WHERE NOT EXISTS (
  SELECT 1 FROM privilegios WHERE privilegio = 'Orden de Diseño'
);

-- Diseño administra el flujo completo. Ventas consulta la ficha, participa
-- en el chat y puede adjuntar feedback. Otros roles pueden recibir cualquiera
-- de estos privilegios desde la ficha de usuario.
INSERT INTO roles_privilegios (roles_idroles, privilegios_idprivilegios, created_at)
SELECT r.idroles, p.idprivilegios, now()
FROM roles r
JOIN privilegios p ON p.privilegio = 'Editar Diseño'
WHERE lower(btrim(r.nombre)) IN ('diseño', 'diseno')
ON CONFLICT (roles_idroles, privilegios_idprivilegios) DO NOTHING;

INSERT INTO roles_privilegios (roles_idroles, privilegios_idprivilegios, created_at)
SELECT r.idroles, p.idprivilegios, now()
FROM roles r
JOIN privilegios p ON p.privilegio = 'Orden de Diseño'
WHERE lower(btrim(r.nombre)) IN ('ventas', 'diseño', 'diseno')
ON CONFLICT (roles_idroles, privilegios_idprivilegios) DO NOTHING;

-- Las cuentas especiales tienen sus propias rutas y no deben heredar el
-- bypass global reservado a administradores. Sus flujos funcionan por rol o
-- por privilegios específicos.
UPDATE roles
SET acceso_total = false,
    updated_at = now()
WHERE lower(btrim(nombre)) IN ('expo', 'cotizadorlibre')
  AND acceso_total = true;

COMMIT;
