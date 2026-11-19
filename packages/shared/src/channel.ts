// Channels: where customers reach an AI employee. Every channel turns its messages into the same
// conversation model and answers through the same agent runtime.
import { z } from "zod";
import { TOOL_NAMES, type ToolName } from "./tool.ts";
import { e164 } from "./voice.ts";

export const CHANNEL_KINDS = ["web_chat", "whatsapp", "email", "voice"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** Channels set up on the employee's Channels card. Voice is set up with phone numbers. */
export const MESSAGING_CHANNELS = ["web_chat", "whatsapp", "email"] as const;
export type MessagingChannel = (typeof MESSAGING_CHANNELS)[number];

/** What each channel can carry. Replies longer than `maxChars` are split into several messages. */
export const CHANNEL_CAPABILITIES: Record<ChannelKind, { label: string; maxChars: number | null; inboundMedia: boolean }> = {
  web_chat: { label: "Web chat", maxChars: null, inboundMedia: false },
  whatsapp: { label: "WhatsApp", maxChars: 4096, inboundMedia: true },
  // shortcut: email attachments are ignored; read them like WhatsApp documents when an email provider is chosen
  email: { label: "Email", maxChars: null, inboundMedia: false },
  voice: { label: "Phone", maxChars: null, inboundMedia: false },
};

/** Who carries an employee's WhatsApp number. Several can be configured at once; each number uses one. */
export const WHATSAPP_PROVIDERS = ["meta", "twilio", "telnyx"] as const;
export type WhatsAppProviderName = (typeof WHATSAPP_PROVIDERS)[number];
export const WHATSAPP_PROVIDER_LABELS: Record<WhatsAppProviderName, string> = { meta: "Meta (Cloud API)", twilio: "Twilio", telnyx: "Telnyx" };

export const DEFAULT_CHAT_GREETING = "Hi! How can I help you today?";

const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

/** The settings of each channel, validated when an admin saves them. */
export const channelConfigSchemas = {
  web_chat: z.object({
    greeting: z.string().trim().min(1).max(300).default(DEFAULT_CHAT_GREETING),
    /** Websites allowed to show the widget. The API's own preview page is always allowed. */
    allowedOrigins: z
      .array(z.string().trim().toLowerCase().overwrite((s) => s.replace(/\/+$/, "")).regex(ORIGIN, "Enter an origin such as https://www.example.com"))
      .max(20)
      .default([]),
    /** Only visitors the website vouches for (customer + hash) may chat. */
    requireIdentity: z.boolean().default(false),
  }),
  // Settings saved before providers existed have no `provider`: they are Meta's.
  whatsapp: z.preprocess(
    (v) => (v && typeof v === "object" && !("provider" in v) ? { ...v, provider: "meta" } : v),
    z.discriminatedUnion("provider", [
      z.object({
        provider: z.literal("meta"),
        /** Meta's "Phone number ID" for the business number (not the number itself). */
        phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, "Copy the Phone number ID from Meta (digits only)"),
        displayNumber: e164.optional(),
      }),
      /** Twilio and Telnyx route by the WhatsApp number itself. */
      z.object({ provider: z.literal("twilio"), number: e164 }),
      z.object({ provider: z.literal("telnyx"), number: e164 }),
    ]),
  ),
  email: z.object({ address: z.string().trim().toLowerCase().pipe(z.email("Enter an email address")) }),
} satisfies Record<MessagingChannel, z.ZodType>;
export type ChannelConfigs = { [K in MessagingChannel]: z.infer<(typeof channelConfigSchemas)[K]> };

/** Body of `PUT .../employees/:id/channels/:kind`; `config` is checked against the kind's schema. */
export const setChannelSchema = z.object({
  enabled: z.boolean().default(true),
  /** Tools the employee may use on this channel; null means every tool it is granted. */
  allowedTools: z.array(z.enum(TOOL_NAMES)).max(TOOL_NAMES.length).nullable().default(null),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type SetChannel = z.infer<typeof setChannelSchema>;

/** Body of `POST /chat/:key/session`, sent by the widget. */
export const chatSessionSchema = z.object({
  /** The browser's anonymous id, kept in localStorage; a new one is issued when absent. */
  visitorId: z.uuid().optional(),
  /** Who the website says the visitor is (phone or email), with `customerHash` = HMAC-SHA256(identity secret, customer) in hex. */
  customer: z.string().trim().min(3).max(200).optional(),
  customerHash: z.string().trim().toLowerCase().regex(/^[0-9a-f]{64}$/).optional(),
});

export const chatMessageSchema = z.object({ message: z.string().trim().min(1).max(4000) });

/**
 * How a customer is known across channels: phone numbers as +digits (what callers and WhatsApp
 * give), emails in lower case. The same person on two channels then finds the same memory.
 */
export function normalizeCustomerId(raw: string) {
  const value = raw.trim();
  if (value.includes("@")) return value.toLowerCase();
  if (/^\+?[\d\s().-]{7,25}$/.test(value)) return `+${value.replace(/\D/g, "")}`;
  return value;
}

export const listChannelMessagesQuery = z.object({
  employeeId: z.string().min(1).optional(),
  customerId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  channel: z.enum(CHANNEL_KINDS).optional(),
});

// ---- API responses (dates are ISO strings) ----

export type EmployeeChannelInfo = {
  kind: MessagingChannel;
  enabled: boolean;
  allowedTools: ToolName[] | null;
  config: Record<string, unknown>;
  /** What routes messages here: the widget key, the WhatsApp number (Meta: its phone number id), or the email address. */
  address: string;
  /** Admins only. Web chat: signs visitor identities. Email: part of the inbound webhook URL. */
  secret: string | null;
  /** Web chat: the widget script. WhatsApp: the webhook to give Meta. Email: the inbound webhook (admins only). */
  url: string | null;
  /** Web chat: a page on the API that shows the widget, for trying it. */
  previewUrl: string | null;
  updatedAt: string;
};

/** `GET .../employees/:id/channels`. */
export type EmployeeChannels = {
  channels: EmployeeChannelInfo[];
  /** The WhatsApp providers the server has credentials for; numbers can be saved either way. */
  whatsappProviders: WhatsAppProviderName[];
  /** Replies by email are recorded, not delivered, until an email provider is chosen. */
  emailTestMode: true;
};

export type ChannelMessageStatus =
  | "RECEIVED" // inbound, being answered
  | "ANSWERED"
  | "REJECTED" // inbound, deliberately not answered (see error)
  | "PENDING" // outbound, being sent
  | "SENT"
  | "DELIVERED"
  | "READ"
  | "FAILED";

export type ChannelMedia = { kind: string; mimeType: string; filename?: string; caption?: string; sizeBytes?: number; note?: string };

/** One message in or out of a channel: the audit log. */
export type ChannelMessageRecord = {
  id: string;
  channel: ChannelKind;
  direction: "INBOUND" | "OUTBOUND";
  status: ChannelMessageStatus;
  employeeId: string;
  customerId: string | null;
  conversationId: string | null;
  providerMessageId: string | null;
  from: string | null;
  to: string | null;
  text: string;
  media: ChannelMedia[];
  error: string | null;
  attempts: number;
  /** Outbound: from receiving the customer's message to handing the reply to the channel. */
  latencyMs: number | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Body of the inbound email webhook (`POST /hooks/email/:channelId/:token`): the fields every
 * inbound-email service gives, in our names. `from` may be "Name <address>".
 */
export const inboundEmailSchema = z.object({
  from: z.string().trim().min(3).max(320),
  subject: z.string().trim().max(500).default(""),
  text: z.string().max(100_000),
  messageId: z.string().trim().min(1).max(500),
  inReplyTo: z.string().trim().max(500).optional(),
});
export type InboundEmail = z.infer<typeof inboundEmailSchema>;
