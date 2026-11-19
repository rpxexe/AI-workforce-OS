import type { ChannelKind, ChannelMedia, WhatsAppProviderName } from "@workforce/shared";

/** A file the customer sent, before it is downloaded: by the provider's media id, or at a URL. */
export type InboundMedia = ChannelMedia & {
  providerMediaId?: string;
  url?: string;
  /** A recorded voice note rather than an audio file. */
  voice?: boolean;
};

/** A customer's message, whatever channel it came from. */
export type InboundMessage = {
  channel: ChannelKind;
  /** Which of our endpoints received it: WhatsApp phone number id, email address, widget key. */
  address: string;
  /** Deduplicates retried webhooks. */
  providerMessageId: string;
  /** The customer as every channel knows them (`normalizeCustomerId`): +digits or a lower-case email. */
  from: string;
  /** Display name, when the channel gives one. */
  name?: string;
  text: string;
  media: InboundMedia[];
  /** Set when the message is of a type we cannot read (a poll, an order); `text` is then empty. */
  unsupported?: string;
  /** Email only. */
  subject?: string;
  inReplyTo?: string;
  /** Email only: the tag of a tagged address it was sent to (support+<conversation id>@...), naming the conversation it answers. */
  threadTag?: string;
  receivedAt: Date;
};

/** What the channel later reports about a message we sent. */
export type DeliveryUpdate = { providerMessageId: string; status: "SENT" | "DELIVERED" | "READ" | "FAILED"; error?: string };

export type OutboundMessage = {
  /** Our endpoint to send from (see `InboundMessage.address`). */
  address: string;
  to: string;
  text: string;
  /** Email only. */
  subject?: string;
  inReplyTo?: string;
  /** Email only: where the customer's reply should go (a tagged address that names the conversation). */
  replyTo?: string;
  /** Email only: the sender's display name (the employee's). */
  fromName?: string;
  /** Stable per message, for providers that deduplicate sends (Telnyx), so a retry cannot send twice. */
  idempotencyKey?: string;
};

/** A send that failed. `retryable` errors were retried before being thrown. */
export class ChannelError extends Error {
  retryable: boolean;
  attempts = 1;
  constructor(message: string, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

export interface ChannelSender {
  readonly kind: ChannelKind;
  /** Sends one message (callers split long replies). Throws `ChannelError`. */
  send(message: OutboundMessage): Promise<{ providerMessageId: string; attempts: number }>;
}

/** A webhook as it arrived, for the provider to verify and read. */
export type WebhookRequest = {
  /** The exact public URL the provider called (PUBLIC_URL + path and query). */
  url: string;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
};

/**
 * WhatsApp behind one interface, whoever carries the number (Meta directly, Twilio, Telnyx). Every
 * provider turns its webhooks into `InboundMessage`s and `DeliveryUpdate`s and sends text.
 */
export interface WhatsAppProvider extends ChannelSender {
  readonly kind: "whatsapp";
  readonly name: WhatsAppProviderName;
  /** The webhook's subscription handshake (GET): the challenge to echo, or null. Only Meta has one. */
  verifySubscription?(query: Record<string, unknown>): string | null;
  /** The messages and receipts in a webhook, or null when it did not come from the provider. */
  parseWebhook(request: WebhookRequest): { messages: InboundMessage[]; statuses: DeliveryUpdate[] } | null;
  /** What the webhook is answered with (Twilio expects TwiML). */
  readonly ack: { contentType: string; body: string };
  /** Shows the customer their message was read. Best effort; not every provider can. */
  markRead?(address: string, providerMessageId: string): Promise<void>;
  /** Fetches a file the customer sent to `address`. Refuses files over `maxBytes`. */
  downloadMedia(media: InboundMedia, address: string, maxBytes: number): Promise<{ data: Buffer; mimeType: string }>;
}

/** Reads a response body, refusing more than `maxBytes`. */
export async function readLimited(res: Response, maxBytes: number) {
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw new ChannelError(`The file is larger than ${maxBytes / 1024 / 1024} MB`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > maxBytes) throw new ChannelError(`The file is larger than ${maxBytes / 1024 / 1024} MB`);
  return data;
}

/** Retries sends refused as "try later", waiting backoffMs, then 4x, 16x. Other errors are thrown at once. */
export async function withRetries<T>(retry: { attempts: number; backoffMs: number }, send: () => Promise<T>): Promise<{ result: T; attempts: number }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { result: await send(), attempts: attempt };
    } catch (err) {
      if (!(err instanceof ChannelError) || !err.retryable || attempt >= retry.attempts) {
        if (err instanceof ChannelError) err.attempts = attempt;
        throw err;
      }
      await new Promise((r) => setTimeout(r, retry.backoffMs * 4 ** (attempt - 1)));
    }
  }
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
