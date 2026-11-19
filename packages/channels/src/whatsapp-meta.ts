// WhatsApp through Meta's Cloud API (graph.facebook.com) directly: webhook verification and
// signatures, webhook payloads in the common model, sending with rate-limit retries, media downloads.
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeCustomerId } from "@workforce/shared";
import {
  ChannelError,
  errorText,
  readLimited,
  withRetries,
  type DeliveryUpdate,
  type InboundMedia,
  type InboundMessage,
  type WhatsAppProvider,
} from "./types.ts";

type WaMedia = { id?: string; url?: string; mime_type?: string; caption?: string; filename?: string; voice?: boolean };
/** A WhatsApp message as Meta writes it. Telnyx passes the same object through as its webhook `body`. */
export type WaMessage = {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: WaMedia;
  audio?: WaMedia;
  video?: WaMedia;
  document?: WaMedia;
  sticker?: WaMedia;
  location?: { latitude?: number | string; longitude?: number | string; name?: string; address?: string };
  contacts?: { name?: { formatted_name?: string } }[];
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  button?: { text?: string };
};
type WaStatus = { id?: string; status?: string; errors?: { code?: number; title?: string; message?: string }[] };
type WaWebhook = {
  entry?: {
    changes?: {
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: WaMessage[];
        statuses?: WaStatus[];
      };
    }[];
  }[];
};

const MEDIA_TYPES = ["image", "audio", "video", "document", "sticker"] as const;
/** Error codes that mean "not sent, try again later": throughput and rate limits, a busy service. */
const RETRYABLE = new Set([4, 80007, 130429, 131016, 131056]);
/** What the codes an admin is likely to meet mean, in plain words. */
const MEANING: Record<number, string> = {
  190: "the access token is invalid or expired",
  130429: "the WhatsApp throughput limit was reached",
  131026: "the message could not be delivered; the number may not use WhatsApp",
  131047: "more than 24 hours have passed since the customer's last message, so WhatsApp only allows template messages",
  131056: "too many messages to this customer in a short time",
};

/** The `X-Hub-Signature-256` header Meta sends: HMAC-SHA256 of the raw body with the app secret. */
export const metaSignature = (appSecret: string, rawBody: string) => `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * One WhatsApp message in the common model; null for what is not a customer message (reactions,
 * system notices). `id` overrides the message's own id (Telnyx deduplicates on its own).
 */
export function waMessageToInbound(m: WaMessage, address: string, name?: string, id = m.id): InboundMessage | null {
  if (!id || !m.from || m.type === "reaction" || m.type === "system") return null;
  const media: InboundMedia[] = [];
  let text = "";
  let unsupported: string | undefined;
  const type = m.type ?? "unknown";
  const file = (MEDIA_TYPES as readonly string[]).includes(type) ? m[type as (typeof MEDIA_TYPES)[number]] : undefined;
  if (m.type === "text") text = m.text?.body ?? "";
  else if (file?.id || file?.url) {
    media.push({
      kind: type,
      ...(file.id && { providerMediaId: file.id }),
      ...(file.url && { url: file.url }),
      mimeType: file.mime_type ?? "application/octet-stream",
      ...(file.caption && { caption: file.caption }),
      ...(file.filename && { filename: file.filename }),
      ...(file.voice && { voice: true }),
    });
    text = file.caption ?? "";
  } else if (m.type === "location" && m.location) {
    const { name: place, address: street, latitude, longitude } = m.location;
    text = `[Shared a location: ${[place, street].filter(Boolean).join(", ") || "unnamed"} (${latitude}, ${longitude})]`;
  } else if (m.type === "contacts") {
    text = `[Shared a contact: ${(m.contacts ?? []).map((c) => c.name?.formatted_name).filter(Boolean).join(", ")}]`;
  } else if (m.type === "interactive") {
    text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "";
  } else if (m.type === "button") {
    text = m.button?.text ?? "";
  } else unsupported = type;
  return {
    channel: "whatsapp",
    address,
    providerMessageId: id,
    from: normalizeCustomerId(m.from),
    name,
    text,
    media,
    unsupported,
    receivedAt: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
  };
}

export function metaWhatsApp(options: {
  accessToken: string;
  appSecret: string;
  /** Any string; the admin types the same one into Meta's webhook settings. */
  verifyToken: string;
  version?: string;
  graphUrl?: string;
  fetch?: typeof fetch;
  /** Sends refused for a rate limit are retried this many times in all. */
  retry?: { attempts: number; backoffMs: number };
}): WhatsAppProvider {
  const base = `${options.graphUrl ?? "https://graph.facebook.com"}/${options.version ?? "v26.0"}`;
  const http = options.fetch ?? fetch;
  const retry = options.retry ?? { attempts: 3, backoffMs: 1000 };
  const auth = { authorization: `Bearer ${options.accessToken}` };

  const graph = async (path: string, body?: object) => {
    let res: Response;
    try {
      res = await http(`${base}/${path}`, {
        method: body ? "POST" : "GET",
        headers: { ...auth, ...(body && { "content-type": "application/json" }) },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // Not retried: the request may have reached Meta, and a retry could send the message twice.
      throw new ChannelError(`WhatsApp could not be reached: ${errorText(err)}`);
    }
    const data = (await res.json().catch(() => null)) as { error?: { code?: number; message?: string; error_data?: { details?: string } } } | null;
    if (!res.ok) {
      const code = data?.error?.code;
      const detail = (code !== undefined && MEANING[code]) || data?.error?.error_data?.details || data?.error?.message || `HTTP ${res.status}`;
      throw new ChannelError(`WhatsApp refused${code !== undefined ? ` (${code})` : ""}: ${detail}`, res.status === 429 || RETRYABLE.has(code ?? -1));
    }
    return data as Record<string, unknown> | null;
  };

  return {
    kind: "whatsapp",
    name: "meta",
    ack: { contentType: "text/plain", body: "" },

    verifySubscription(query) {
      const token = query["hub.verify_token"];
      const ok = query["hub.mode"] === "subscribe" && typeof token === "string" && same(token, options.verifyToken);
      return ok && typeof query["hub.challenge"] === "string" ? query["hub.challenge"] : null;
    },

    parseWebhook({ rawBody, headers }) {
      const header = headers["x-hub-signature-256"];
      if (typeof header !== "string" || !same(header, metaSignature(options.appSecret, rawBody))) return null;
      let body: WaWebhook;
      try {
        body = JSON.parse(rawBody) as WaWebhook;
      } catch {
        return null;
      }
      const messages: InboundMessage[] = [];
      const statuses: DeliveryUpdate[] = [];
      for (const entry of body?.entry ?? [])
        for (const change of entry.changes ?? []) {
          const value = change.value;
          const address = value?.metadata?.phone_number_id;
          if (change.field !== "messages" || !value || !address) continue;
          const names = new Map((value.contacts ?? []).flatMap((c) => (c.wa_id && c.profile?.name ? [[c.wa_id, c.profile.name] as const] : [])));
          for (const m of value.messages ?? []) {
            const inbound = waMessageToInbound(m, address, names.get(m.from ?? ""));
            if (inbound) messages.push(inbound);
          }
          for (const s of value.statuses ?? []) {
            const status = s.status?.toUpperCase();
            if (!s.id || (status !== "SENT" && status !== "DELIVERED" && status !== "READ" && status !== "FAILED")) continue;
            const e = s.errors?.[0];
            const error = e && `WhatsApp error${e.code !== undefined ? ` ${e.code}` : ""}: ${(e.code !== undefined && MEANING[e.code]) || e.message || e.title}`;
            statuses.push({ providerMessageId: s.id, status, ...(error && { error }) });
          }
        }
      return { messages, statuses };
    },

    async send({ address, to, text }) {
      const { result, attempts } = await withRetries(retry, async () => {
        const data = await graph(`${address}/messages`, {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: to.replace(/^\+/, ""),
          type: "text",
          text: { preview_url: false, body: text },
        });
        const id = (data?.messages as { id?: string }[] | undefined)?.[0]?.id;
        if (!id) throw new ChannelError("WhatsApp accepted the message but returned no id");
        return id;
      });
      return { providerMessageId: result, attempts };
    },

    /** Also shows the customer that the employee is typing. */
    async markRead(address, providerMessageId) {
      await graph(`${address}/messages`, { messaging_product: "whatsapp", status: "read", message_id: providerMessageId, typing_indicator: { type: "text" } });
    },

    async downloadMedia(media, _address, maxBytes) {
      if (!media.providerMediaId) throw new ChannelError("The file has no media id");
      const meta = (await graph(encodeURIComponent(media.providerMediaId))) as { url?: string; mime_type?: string; file_size?: number | string } | null;
      if (!meta?.url?.startsWith("https://")) throw new ChannelError("WhatsApp gave no download address for the file");
      if (Number(meta.file_size ?? 0) > maxBytes) throw new ChannelError(`The file is larger than ${maxBytes / 1024 / 1024} MB`);
      const res = await http(meta.url, { headers: auth, signal: AbortSignal.timeout(30_000) }).catch((err: unknown) => {
        throw new ChannelError(`The file could not be downloaded: ${errorText(err)}`);
      });
      if (!res.ok) throw new ChannelError(`The file could not be downloaded (HTTP ${res.status})`);
      return { data: await readLimited(res, maxBytes), mimeType: meta.mime_type ?? "application/octet-stream" };
    },
  };
}

/** From `META_WHATSAPP_ACCESS_TOKEN`, `META_APP_SECRET` and `META_WHATSAPP_VERIFY_TOKEN`; null when any is missing. */
export function metaWhatsAppFromEnv(env: Record<string, string | undefined> = process.env) {
  if (!env.META_WHATSAPP_ACCESS_TOKEN || !env.META_APP_SECRET || !env.META_WHATSAPP_VERIFY_TOKEN) return null;
  return metaWhatsApp({
    accessToken: env.META_WHATSAPP_ACCESS_TOKEN,
    appSecret: env.META_APP_SECRET,
    verifyToken: env.META_WHATSAPP_VERIFY_TOKEN,
    version: env.META_GRAPH_VERSION || undefined,
  });
}
