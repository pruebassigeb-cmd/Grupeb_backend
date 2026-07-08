// src/types/whatsapp/whatsapp.types.ts

export interface EnviarPruebaWhatsappBody {
  telefono: string;
  templateName?: string;
  languageCode?: string;
  components?: WhatsappTemplateComponent[];
}

export interface WhatsappTemplateComponent {
  type: "header" | "body" | "button";
  parameters?: WhatsappTemplateParameter[];
}

export interface WhatsappTemplateParameter {
  type: "text" | "currency" | "date_time" | "image" | "document" | "video";
  text?: string;
  image?: {
    link: string;
  };
  document?: {
    link: string;
    filename?: string;
  };
  video?: {
    link: string;
  };
}

export interface WhatsappTemplatePayload {
  messaging_product: "whatsapp";
  to: string;
  type: "template";
  template: {
    name: string;
    language: {
      code: string;
    };
    components?: WhatsappTemplateComponent[];
  };
}

export interface WhatsappWebhookQuery {
  "hub.mode"?: string;
  "hub.verify_token"?: string;
  "hub.challenge"?: string;
}

export interface WhatsappWebhookBody {
  object?: string;
  entry?: WhatsappWebhookEntry[];
}

export interface WhatsappWebhookEntry {
  id?: string;
  changes?: WhatsappWebhookChange[];
}

export interface WhatsappWebhookChange {
  value?: WhatsappWebhookValue;
  field?: string;
}

export interface WhatsappWebhookValue {
  messaging_product?: string;
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  contacts?: WhatsappContact[];
  messages?: WhatsappIncomingMessage[];
  statuses?: WhatsappMessageStatus[];
}

export interface WhatsappContact {
  profile?: {
    name?: string;
  };
  wa_id?: string;
}

export interface WhatsappIncomingMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: {
    body?: string;
  };
  image?: unknown;
  document?: unknown;
  audio?: unknown;
  video?: unknown;
  button?: unknown;
  interactive?: unknown;
}

export interface WhatsappMessageStatus {
  id?: string;
  status?: "sent" | "delivered" | "read" | "failed" | string;
  timestamp?: string;
  recipient_id?: string;
  errors?: unknown[];
}