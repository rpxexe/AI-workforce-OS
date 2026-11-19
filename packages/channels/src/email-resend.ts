// Email through Resend (resend.com): sends with an Idempotency-Key, receives through the
// email.received webhook (the body is then fetched by id), and turns delivery webhooks into delivery
// states. Webhooks are signed the Svix way. Plain fetch: no SDK.
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeCustomerId } from "@workforce/shared";
import { toInboundEmail } from "./email.ts";
import {
  ChannelError,
  errorText,
  withRetries,
  type ChannelSender,
  type DeliveryUpdate,
  type InboundMessage,
  type OutboundMessage,
  type WebhookRequest,
} from "./types.ts";

/** An email provider: sends, and reads its webhooks (received mail is fetched in full, hence async). */
export interface EmailProvider extends ChannelSender {
  readonly kind: "email";
  readonly name: "resend";
  /** The messages and receipts in a webhook, or null when it did not come from the provider. Throws if a received email cannot be fetched (the provider retries). */
  readWebhook(request: WebhookRequest): Promise<{ messages: InboundMessage[]; statuses: DeliveryUpdate[] } | null>;
}

type ResendEvent = { type?: string; data?: { email_id?: string; to?: string[]; bounce?: { message?: string; type?: string } } };
type ReceivedEmail = {
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  text?: string | null;
  html?: string | null;
  message_id?: string;
  headers?: Record<string, string>;
};

const STATUS: Record<string, DeliveryUpdate["status"]> = {
  "email.sent": "SENT",
  "email.delivered": "DELIVERED",
  "email.opened": "READ",
  "email.bounced": "FAILED",
  "email.failed": "FAILED",
};

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The Svix signature Resend sends: base64 HMAC-SHA256 of "id.timestamp.body", keyed with the secret after "whsec_". */
export const svixSignature = (secret: string, id: string, timestamp: string, rawBody: string) =>
  createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64"))
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");

export function svixVerify(secret: string, headers: WebhookRequest["headers"], rawBody: string, toleranceSec = 300) {
  const id = headers["svix-id"];
  const timestamp = headers["svix-timestamp"];
  const signatures = headers["svix-signature"];
  if (typeof id !== "string" || typeof timestamp !== "string" || typeof signatures !== "string") return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSec) return false;
  const expected = svixSignature(secret, id, timestamp, rawBody);
  // "v1,<sig> v1,<sig>": several while a secret is being rotated.
  return signatures.split(" ").some((part) => {
    const [version, signature] = part.split(",");
    return version === "v1" && signature !== undefined && same(signature, expected);
  });
}

/** Plain text from an HTML body, for emails sent without a text part. */
export const htmlToText = (html: string) =>
  html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** An address with a tag: support@x.com + abc -> support+abc@x.com. */
export const taggedAddress = (address: string, tag: string) => address.replace("@", `+${tag}@`);

/** An address without its tag, and the tag: support+abc@x.com -> { address: support@x.com, tag: abc }. */
export const untag = (address: string) => {
  const match = /^([^+@\s]+)\+([^@\s]+)(@.+)$/.exec(address.trim().toLowerCase());
  return match ? { address: `${match[1]}${match[3]}`, tag: match[2] } : { address: address.trim().toLowerCase(), tag: undefined };
};
const bare = (address: string) => (/<([^<>\s]+)>/.exec(address)?.[1] ?? address).trim();

export function resendEmail(options: {
  apiKey: string;
  /** Signs webhooks (the webhook's signing secret in Resend). Without it, webhooks are refused. */
  webhookSecret?: string;
  api?: string;
  fetch?: typeof fetch;
  retry?: { attempts: number; backoffMs: number };
}): EmailProvider {
  const api = options.api ?? "https://api.resend.com";
  const http = options.fetch ?? fetch;
  const retry = options.retry ?? { attempts: 3, backoffMs: 1000 };
  // Resend refuses requests without a User-Agent.
  const headers = { authorization: `Bearer ${options.apiKey}`, "user-agent": "ai-workforce-os/1.0" };

  const failure = async (res: Response, keyed: boolean) => {
    const data = (await res.json().catch(() => null)) as { name?: string; message?: string } | null;
    const retryable = data?.name === "rate_limit_exceeded" || (keyed && res.status >= 500);
    return new ChannelError(`Resend refused (${data?.name ?? res.status}): ${data?.message ?? `HTTP ${res.status}`}`, retryable);
  };

  return {
    kind: "email",
    name: "resend",

    async send({ address, to, text, subject, inReplyTo, replyTo, fromName, idempotencyKey }: OutboundMessage) {
      // With an idempotency key Resend sends once however often it is asked (24 hours), so network errors and 5xx can be retried too.
      const keyed = idempotencyKey !== undefined && idempotencyKey.length <= 256;
      const name = fromName?.replace(/["<>\r\n]/g, "").trim();
      const { result, attempts } = await withRetries(retry, async () => {
        let res: Response;
        try {
          res = await http(`${api}/emails`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json", ...(keyed && { "idempotency-key": idempotencyKey }) },
            body: JSON.stringify({
              from: name ? `${name} <${address}>` : address,
              to: [to],
              subject: subject || "(no subject)",
              text,
              ...(replyTo && { reply_to: replyTo }),
              ...(inReplyTo && { headers: { "In-Reply-To": inReplyTo, References: inReplyTo } }),
            }),
            signal: AbortSignal.timeout(15_000),
          });
        } catch (err) {
          throw new ChannelError(`Resend could not be reached: ${errorText(err)}`, keyed);
        }
        if (!res.ok) throw await failure(res, keyed);
        const data = (await res.json().catch(() => null)) as { id?: string } | null;
        if (!data?.id) throw new ChannelError("Resend accepted the email but returned no id");
        return data.id;
      });
      return { providerMessageId: result, attempts };
    },

    async readWebhook({ rawBody, headers: received }) {
      if (!options.webhookSecret || !svixVerify(options.webhookSecret, received, rawBody)) return null;
      let event: ResendEvent;
      try {
        event = JSON.parse(rawBody) as ResendEvent;
      } catch {
        return null;
      }
      const emailId = event.data?.email_id;
      if (!emailId) return { messages: [], statuses: [] };

      const status = STATUS[event.type ?? ""];
      if (status) {
        const bounce = event.data?.bounce;
        const error = status === "FAILED" ? `Resend: ${event.type === "email.bounced" ? "bounced" : "failed"}${bounce?.message ? `: ${bounce.message}` : ""}` : undefined;
        return { messages: [], statuses: [{ providerMessageId: emailId, status, ...(error && { error }) }] };
      }
      if (event.type !== "email.received") return { messages: [], statuses: [] };

      // The webhook has only metadata; the body is fetched. A failure throws, so the webhook is answered with an error and Resend retries.
      const res = await http(`${api}/emails/receiving/${encodeURIComponent(emailId)}`, { headers, signal: AbortSignal.timeout(15_000) }).catch((err: unknown) => {
        throw new ChannelError(`Resend could not be reached: ${errorText(err)}`, true);
      });
      if (!res.ok) throw await failure(res, false);
      const email = (await res.json()) as ReceivedEmail;
      const header = (name: string) => Object.entries(email.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
      const base = {
        from: email.from ?? "",
        subject: email.subject ?? "",
        text: email.text ?? (email.html ? htmlToText(email.html) : ""),
        messageId: email.message_id ?? `<${emailId}@resend>`,
        inReplyTo: header("in-reply-to"),
      };
      // One message per recipient address; the API keeps those that are an employee's.
      const messages = [...(email.to ?? []), ...(email.cc ?? [])].flatMap((recipient) => {
        const { address, tag } = untag(bare(recipient));
        const inbound = toInboundEmail(base, address);
        return inbound ? [{ ...inbound, address: normalizeCustomerId(address), ...(tag && { threadTag: tag }) }] : [];
      });
      return { messages, statuses: [] };
    },
  };
}

/** From `RESEND_API_KEY` (and `RESEND_WEBHOOK_SECRET` for inbound mail and receipts); null without a key. */
export function resendFromEnv(env: Record<string, string | undefined> = process.env) {
  if (!env.RESEND_API_KEY) return null;
  return resendEmail({ apiKey: env.RESEND_API_KEY, webhookSecret: env.RESEND_WEBHOOK_SECRET || undefined });
}
