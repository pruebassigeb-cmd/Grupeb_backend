// src/services/email/mailer.ts
import nodemailer from "nodemailer";

console.log("🔍 EMAIL_HOST cargado:", process.env.EMAIL_HOST);
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT),
  secure: true, // true para puerto 465 (SSL/TLS)
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Verificación opcional al arrancar el server (ver app.ts) — falla rápido
// si las credenciales SMTP están mal, en vez de enterarte hasta el primer envío real.
export async function verificarConexionCorreo(): Promise<void> {
  try {
    await transporter.verify();
    console.log("✅ Conexión SMTP verificada (mail.grupoeb.com.mx)");
  } catch (e: any) {
    console.error("❌ No se pudo verificar la conexión SMTP:", e.message);
  }
}

export interface AdjuntoCorreo {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface EnviarCorreoParams {
  para: string | string[];
  asunto: string;
  html: string;
  adjuntos?: AdjuntoCorreo[];
  cc?: string | string[];
}

export async function enviarCorreo({ para, asunto, html, adjuntos = [], cc }: EnviarCorreoParams) {
  const info = await transporter.sendMail({
    from: `"Grupo EB" <${process.env.EMAIL_USER}>`,
    to: para,
    cc,
    subject: asunto,
    html,
    attachments: adjuntos.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType || "application/pdf",
    })),
  });
  console.log(`✅ Correo enviado: ${info.messageId} → ${Array.isArray(para) ? para.join(", ") : para}`);
  return info;
}