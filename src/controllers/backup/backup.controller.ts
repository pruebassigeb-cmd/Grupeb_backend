import { Request, Response } from "express";
import { exec }              from "child_process";
import { promisify }         from "util";
import { pool }              from "../../config/db";
import { s3Client, S3_BUCKET } from "../../config/s3";
import { PutObjectCommand }  from "@aws-sdk/client-s3";
import { getPresignedUrl }   from "../../config/multer";
import { v4 as uuidv4 }      from "uuid";
import bcrypt                from "bcrypt";
import { selloArchivoMX }    from "../../utils/fecha";

const execAsync = promisify(exec);

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Parsea la DATABASE_URL de Render.
 * Soporta URLs con y sin puerto explícito:
 *   postgresql://user:pass@host:5432/db   ← con puerto
 *   postgresql://user:pass@host/db         ← sin puerto (Render a veces omite el 5432)
 */
const parseDatabaseUrl = (url: string) => {
  // Usamos la API nativa URL de Node para parsear de forma robusta
  // Render usa postgresql:// pero URL() solo acepta protocolos estándar,
  // así que reemplazamos temporalmente.
  const normalized = url.replace(/^postgres(?:ql)?:\/\//, "http://");

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`DATABASE_URL inválida: no se pudo parsear la URL`);
  }

  const user     = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const host     = parsed.hostname;
  const port     = parsed.port || "5432"; // default PostgreSQL
  const dbname   = parsed.pathname.replace(/^\//, ""); // quitar el "/" inicial

  if (!user || !host || !dbname) {
    throw new Error("DATABASE_URL inválida: faltan campos obligatorios (user, host o dbname)");
  }

  return { user, password, host, port, dbname };
};

const subirBackupAStorage = async (
  buffer: Buffer,
  filename: string,
  subidoPor: number | null
): Promise<void> => {
  const key = `grupeb/backups/${uuidv4()}-${filename}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket:      S3_BUCKET,
      Key:         key,
      Body:        buffer,
      ContentType: "application/octet-stream",
    })
  );

  const tamanoKb = Math.round(buffer.length / 1024);

  await pool.query(
    `INSERT INTO archivos
       (nombre, tipo, mime_type, url, public_id, tamano_kb, subido_por, resource_type, categoria)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [filename, "document", "application/octet-stream", key, key, tamanoKb, subidoPor, "raw", "otro"]
  );
};

// ─────────────────────────────────────────────
// Validar código del administrador
// ─────────────────────────────────────────────

const validarCodigoAdmin = async (
  idusuario: number,
  codigo: string
): Promise<boolean> => {
  const result = await pool.query(
    `SELECT u.codigo
     FROM usuarios u
     INNER JOIN roles r ON r.idroles = u.roles_idroles
     WHERE u.idusuario = $1
       AND r.acceso_total = TRUE`,
    [idusuario]
  );

  if (result.rows.length === 0) return false;

  const codigoGuardado: string = result.rows[0].codigo;

  if (codigoGuardado.startsWith("$2b$") || codigoGuardado.startsWith("$2a$")) {
    return bcrypt.compare(codigo, codigoGuardado);
  }

  return codigo === codigoGuardado;
};

// ─────────────────────────────────────────────
// Lógica central de backup
// ─────────────────────────────────────────────

export const ejecutarBackup = async (subidoPor: number | null = null): Promise<string> => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL no configurada en .env");

  const { user, password, host, port, dbname } = parseDatabaseUrl(dbUrl);

  // Hora de México, no UTC: el nombre lo lee un humano.
  const fecha    = selloArchivoMX();
  const filename = `backup-${dbname}-${fecha}.sql`;

  const env = { ...process.env, PGPASSWORD: password };

  const { stdout } = await execAsync(
    `pg_dump -h ${host} -p ${port} -U ${user} -d ${dbname} --no-password --format=plain`,
    { env, maxBuffer: 200 * 1024 * 1024 }
  );

  const buffer = Buffer.from(stdout, "utf-8");
  await subirBackupAStorage(buffer, filename, subidoPor);

  await pool.query(
    "UPDATE backup_schedule SET ultimo_backup = NOW() WHERE id = 1"
  );

  return filename;
};

// ─────────────────────────────────────────────
// Controllers
// ─────────────────────────────────────────────

/** POST /api/backups/verificar-codigo */
export const verificarCodigo = async (req: Request, res: Response): Promise<void> => {
  try {
    const idusuario = (req as any).user?.id;
    const { codigo } = req.body;

    if (!codigo) {
      res.status(400).json({ error: "Se requiere el código" });
      return;
    }

    const valido = await validarCodigoAdmin(idusuario, codigo);
    if (!valido) {
      res.status(401).json({ error: "Código incorrecto" });
      return;
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("❌ Error al verificar código:", error);
    res.status(500).json({ error: "Error al verificar código" });
  }
};

/** POST /api/backups/manual */
export const backupManual = async (req: Request, res: Response): Promise<void> => {
  try {
    const idusuario = (req as any).user?.id;
    const { codigo } = req.body;

    if (!codigo) {
      res.status(400).json({ error: "Se requiere el código de administrador" });
      return;
    }

    const valido = await validarCodigoAdmin(idusuario, codigo);
    if (!valido) {
      res.status(401).json({ error: "Código incorrecto" });
      return;
    }

    const filename = await ejecutarBackup(idusuario);
    res.json({ ok: true, filename, mensaje: `Backup generado: ${filename}` });
  } catch (error) {
    console.error("❌ Error en backup manual:", error);
    res.status(500).json({ error: "Error al generar el backup" });
  }
};

/** GET /api/backups/schedule */
export const getSchedule = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query("SELECT * FROM backup_schedule WHERE id = 1");
    res.json(result.rows[0] ?? null);
  } catch (error) {
    console.error("❌ Error al obtener schedule:", error);
    res.status(500).json({ error: "Error al obtener configuración" });
  }
};

/** PUT /api/backups/schedule */
export const updateSchedule = async (req: Request, res: Response): Promise<void> => {
  try {
    const idusuario = (req as any).user?.id;
    const { codigo, activo, frecuencia, hora, dia_semana } = req.body;

    if (!codigo) {
      res.status(400).json({ error: "Se requiere el código de administrador" });
      return;
    }

    const valido = await validarCodigoAdmin(idusuario, codigo);
    if (!valido) {
      res.status(401).json({ error: "Código incorrecto" });
      return;
    }

    const FRECUENCIAS_VALIDAS = [
      "diario", "cada_2_dias", "cada_3_dias",
      "semanal", "cada_2_semanas", "mensual",
    ];
    if (!FRECUENCIAS_VALIDAS.includes(frecuencia)) {
      res.status(400).json({ error: "Frecuencia inválida" });
      return;
    }

    if (!/^\d{2}:\d{2}$/.test(hora)) {
      res.status(400).json({ error: "Formato de hora inválido (HH:MM)" });
      return;
    }

    await pool.query(
      `INSERT INTO backup_schedule (id, activo, frecuencia, hora, dia_semana, updated_at)
       VALUES (1, $1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE
         SET activo     = EXCLUDED.activo,
             frecuencia = EXCLUDED.frecuencia,
             hora       = EXCLUDED.hora,
             dia_semana = EXCLUDED.dia_semana,
             updated_at = NOW()`,
      [activo, frecuencia, hora, dia_semana ?? 0]
    );

    const { reiniciarScheduler } = await import("./backup.scheduler");
    await reiniciarScheduler();

    res.json({ ok: true, mensaje: "Configuración guardada" });
  } catch (error) {
    console.error("❌ Error al actualizar schedule:", error);
    res.status(500).json({ error: "Error al guardar configuración" });
  }
};

/** GET /api/backups/historial */
export const getHistorialBackups = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT id_archivo, nombre, tamano_kb, created_at, public_id
       FROM archivos
       WHERE public_id LIKE '%backups%'
       ORDER BY created_at DESC
       LIMIT 50`
    );

    const archivosConUrl = await Promise.all(
      result.rows.map(async (a) => ({
        ...a,
        url: await getPresignedUrl(a.public_id),
      }))
    );

    res.json(archivosConUrl);
  } catch (error) {
    console.error("❌ Error al obtener historial:", error);
    res.status(500).json({ error: "Error al obtener historial de backups" });
  }
};

// ─────────────────────────────────────────────
// DIAGNÓSTICO — solo para pruebas en local
// ─────────────────────────────────────────────

export const diagnostico = async (_req: Request, res: Response): Promise<void> => {
  const resultado: Record<string, any> = {};

  // 1. DATABASE_URL
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    resultado.database_url = { ok: false, error: "DATABASE_URL no está definida en .env" };
  } else {
    try {
      const parsed = parseDatabaseUrl(dbUrl);
      resultado.database_url = {
        ok:   true,
        host: parsed.host,
        port: parsed.port,
        db:   parsed.dbname,
        user: parsed.user,
      };
    } catch (e: any) {
      resultado.database_url = { ok: false, error: e.message };
    }
  }

  // 2. pg_dump instalado
  try {
    const { stdout } = await execAsync("pg_dump --version");
    resultado.pg_dump = { ok: true, version: stdout.trim() };
  } catch {
    resultado.pg_dump = {
      ok:    false,
      error: "pg_dump no encontrado. Instala PostgreSQL client.",
    };
  }

  // 3. Conexión a la BD
  try {
    await pool.query("SELECT 1");
    resultado.conexion_bd = { ok: true, mensaje: "Conexión exitosa" };
  } catch (e: any) {
    resultado.conexion_bd = {
      ok:    false,
      error: e.message,
      tip:   "Usa la External URL de Render (no la Internal)",
    };
  }

  // 4. S3
  try {
    if (!S3_BUCKET) throw new Error("S3_BUCKET_NAME no configurado en .env");
    resultado.s3 = {
      ok:     true,
      bucket: S3_BUCKET,
      region: process.env.AWS_REGION ?? "no definido",
    };
  } catch (e: any) {
    resultado.s3 = { ok: false, error: e.message };
  }

  // 5. Tabla backup_schedule
  try {
    await pool.query("SELECT id FROM backup_schedule WHERE id = 1");
    resultado.tabla_schedule = { ok: true };
  } catch {
    resultado.tabla_schedule = {
      ok:  false,
      tip: "Ejecuta backup_schedule.sql en tu BD",
    };
  }

  const todoOk = Object.values(resultado).every((v: any) => v.ok);
  res.status(todoOk ? 200 : 207).json({ listo_para_backup: todoOk, checks: resultado });
};

/** POST /api/backups/automatico — llamado por cron-job.org */
export const backupAutomatico = async (req: Request, res: Response): Promise<void> => {
  const secret = req.headers["x-cron-secret"];
  if (secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: "No autorizado" });
    return;
  }
  try {
    const filename = await ejecutarBackup(null);
    res.json({ ok: true, filename });
  } catch (error) {
    console.error("❌ Error en backup automático:", error);
    res.status(500).json({ error: "Error en backup automático" });
  }
};

/** Verificar si hay un backup pendiente al arrancar el servidor */
export const verificarBackupPendiente = async (): Promise<void> => {
  try {
    const result = await pool.query(
      "SELECT activo, frecuencia, ultimo_backup FROM backup_schedule WHERE id = 1"
    );
    const config = result.rows[0];
    if (!config?.activo) return;

    const ahora = new Date();
    const ultimo = config.ultimo_backup ? new Date(config.ultimo_backup) : null;
    const diasDesdeUltimo = ultimo
      ? (ahora.getTime() - ultimo.getTime()) / (1000 * 60 * 60 * 24)
      : Infinity;

    const diasEsperados: Record<string, number> = {
      diario: 1, cada_2_dias: 2, cada_3_dias: 3,
      semanal: 7, cada_2_semanas: 14, mensual: 30,
    };

    if (diasDesdeUltimo >= diasEsperados[config.frecuencia]) {
      console.log("⚠️ Backup pendiente detectado al arrancar, ejecutando...");
      await ejecutarBackup(null);
    }
  } catch (error) {
    console.error("❌ Error al verificar backup pendiente:", error);
  }
};