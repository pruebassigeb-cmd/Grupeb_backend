import { pool } from "../src/config/db";

// Réplica exacta de las reglas de Sidebar.tsx / App.tsx tras los cambios.
const PANTALLAS: { nombre: string; prefijo?: string; permiso?: string; accesoTotal?: boolean }[] = [
  { nombre: "Usuarios",               prefijo: "seguridad.usuarios." },
  { nombre: "Reportes de Correo",     permiso: "seguridad.usuarios.gestionar" },
  { nombre: "Clientes",               prefijo: "clientes." },
  { nombre: "Dar alta productos",     prefijo: "productos." },
  { nombre: "Cotización",             prefijo: "cotizacion." },
  { nombre: "Pedido",                 prefijo: "pedido." },
  { nombre: "Diseño",                 prefijo: "diseno." },
  { nombre: "Seguimiento",            prefijo: "produccion." },
  { nombre: "Envíos / Entregas",      prefijo: "envios." },
  { nombre: "Anticipo / Liquidación", prefijo: "cobranza." },
  { nombre: "Precios productos",      prefijo: "precios." },
  { nombre: "Catálogos",              prefijo: "catalogos." },
  { nombre: "Archivos",               accesoTotal: true },
  { nombre: "Backups BD",             accesoTotal: true },
  { nombre: "Gestor proveedores",     prefijo: "proveedores." },
  { nombre: "Cotizador Expo",         prefijo: "externos.expo." },
  { nombre: "Cotizador Interactivo",  prefijo: "externos.cotizador_libre." },
];

const ve = (privs: string[], accesoTotal: boolean, p: typeof PANTALLAS[number]) => {
  if (p.accesoTotal) return accesoTotal;
  if (accesoTotal) return true;
  if (p.prefijo) return privs.some(x => x.startsWith(p.prefijo!));
  if (p.permiso) return privs.includes(p.permiso);
  return true;
};

async function main() {
  const { rows: roles } = await pool.query(`
    SELECT r.idroles, r.nombre, r.acceso_total,
           COALESCE(array_agg(p.clave) FILTER (WHERE p.clave IS NOT NULL), '{}') AS privs
    FROM roles r
    LEFT JOIN roles_privilegios rp ON rp.roles_idroles = r.idroles
    LEFT JOIN privilegios p ON p.idprivilegios = rp.privilegios_idprivilegios AND p.activo
    GROUP BY r.idroles, r.nombre, r.acceso_total ORDER BY r.idroles
  `);

  const problemas: string[] = [];

  for (const r of roles) {
    const privs: string[] = r.privs;
    let visibles = PANTALLAS.filter(p => ve(privs, r.acceso_total, p)).map(p => p.nombre);

    // Roles exclusivos (candado por nombre en Sidebar.tsx / ProtectedRoute.tsx)
    if (r.nombre === "Expo") visibles = visibles.filter(v => v === "Cotizador Expo");
    if (r.nombre === "CotizadorLibre") visibles = visibles.filter(v => v === "Cotizador Interactivo");

    const etiqueta = r.acceso_total ? " (ACCESO TOTAL)" : "";
    console.log(`\n── ${r.nombre}${etiqueta} — ${privs.length} privilegio(s)`);
    console.log(`   PANTALLAS: ${visibles.length ? visibles.join(", ") : "⚠ NINGUNA"}`);

    if (visibles.length === 0) {
      problemas.push(`${r.nombre}: no ve NINGUNA pantalla -> queda en blanco al entrar`);
    }
    // Privilegios que no abren ninguna pantalla
    const huerfanos = privs.filter(c =>
      !PANTALLAS.some(p => (p.prefijo && c.startsWith(p.prefijo)) || p.permiso === c)
    );
    if (huerfanos.length) problemas.push(`${r.nombre}: privilegios sin pantalla -> ${huerfanos.join(", ")}`);
  }

  console.log("\n\n=========== PROBLEMAS ===========");
  console.log(problemas.length ? problemas.map(p => "• " + p).join("\n") : "Ninguno");

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
