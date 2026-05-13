//import * as multer from "multer";
const multer = require("multer");
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client, S3_BUCKET } from "./s3";
import { v4 as uuidv4 } from "uuid";

// Tipo propio para evitar dependencia de @types/multer
export interface MulterFile {
  fieldname:    string;
  originalname: string;
  encoding:     string;
  mimetype:     string;
  size:         number;
  buffer:       Buffer;
}

export const CARPETAS = {
  disenos:      "disenos",
  pdfs:         "pdfs",
  fotos_envios: "fotos-envios",
  backups:      "backups",
  usuarios:     "usuarios",
} as const;

export type CarpetaS3 = typeof CARPETAS[keyof typeof CARPETAS];

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

export const uploadToS3 = async (
  file: MulterFile,
  carpeta: CarpetaS3 = "disenos"
): Promise<{ url: string; public_id: string; resource_type: string }> => {
  const isPdf = file.mimetype === "application/pdf";

  const nombreSinExtension = file.originalname
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_");

  const extension = isPdf
    ? ".pdf"
    : file.originalname.match(/\.[^/.]+$/)?.[0] || "";

  const key = `grupeb/${carpeta}/${uuidv4()}-${nombreSinExtension}${extension}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket:      S3_BUCKET,
      Key:         key,
      Body:        file.buffer,
      ContentType: file.mimetype,
    })
  );

  return {
    url:           key,
    public_id:     key,
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