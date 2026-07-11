const multer = require("multer");
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client, S3_BUCKET } from "./s3";
import { v4 as uuidv4 } from "uuid";

export interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export const CARPETAS = {
  disenos: "disenos",
  pdfs: "pdfs",
  fotos_envios: "fotos-envios",
  backups: "backups",
  usuarios: "usuarios",
  usuarios_ine: "usuarios-ine",
  suaje: "suaje",
  catalogo_productos: "catalogoproductos",   // ← fotos del catálogo de productos (expo)
} as const;

export const SUBCARPETAS_PDF = [
  "cotizaciones",
  "pedidos",
  "ordenes-produccion",
  "estados-cuenta-detallado",
  "estados-cuenta-simple",
  "historial-pagos",
  "etiquetas",
  "notas-remision",
  "formas-envio",
] as const;

export const SUBCARPETAS_SUAJE = [
  "catalogo",
  "imagen",
  "rendimiento",
  // ✅ NUEVO — aquí se guarda la imagen del producto que se sube al dar de
  // alta un producto de plástico (antes se guardaba en
  // carpeta="catalogoproductos", subcarpeta="plastico").
  "plastico-producto",
] as const;

export const SUBCARPETAS_CATALOGO = [
  "papel",
  "plastico",
  "carton",
] as const;

// Todas las subcarpetas válidas (PDF + Suaje + Catálogo)
export const TODAS_SUBCARPETAS = [
  ...SUBCARPETAS_PDF,
  ...SUBCARPETAS_SUAJE,
  ...SUBCARPETAS_CATALOGO,
] as const;

export type CarpetaS3 = typeof CARPETAS[keyof typeof CARPETAS];
export type SubcarpetaPDF = typeof SUBCARPETAS_PDF[number];
export type SubcarpetaSuaje = typeof SUBCARPETAS_SUAJE[number];
export type SubcarpetaCatalogo = typeof SUBCARPETAS_CATALOGO[number];

// ── Acepta CUALQUIER tipo de archivo sin restricción ─────────────────────────
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req: any, _file: any, cb: any) => {
    cb(null, true); // acepta todo
  },
});

export const uploadToS3 = async (
  file: MulterFile,
  carpeta: CarpetaS3 = "disenos",
  subcarpeta?: string
): Promise<{ url: string; public_id: string; resource_type: string }> => {
  const isPdf = file.mimetype === "application/pdf";

  const nombreSinExtension = file.originalname
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_");

  const extension = isPdf
    ? ".pdf"
    : file.originalname.match(/\.[^/.]+$/)?.[0] || "";

  const rutaCarpeta = subcarpeta
    ? `grupeb/${carpeta}/${subcarpeta}`
    : `grupeb/${carpeta}`;

  const key = `${rutaCarpeta}/${uuidv4()}-${nombreSinExtension}${extension}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    })
  );

  return {
    url: key,
    public_id: key,
    resource_type: isPdf ? "raw" : "image",
  };
};

export const deleteFromS3 = async (key: string): Promise<void> => {
  await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
};

export const getPresignedUrl = async (key: string): Promise<string> => {
  const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
  return getSignedUrl(s3Client, command, { expiresIn: 3600 });
};

export const getPresignedUrlLarga = async (key: string, dias = 7): Promise<string> => {
  const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
  return getSignedUrl(s3Client, command, { expiresIn: 60 * 60 * 24 * dias });
};