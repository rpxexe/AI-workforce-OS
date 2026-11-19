// WhatsApp through Telnyx: JSON webhooks signed with Ed25519, sends to /v2/messages/whatsapp with
// an Idempotency-Key (so sends can be retried safely), delivery events, media by URL or media id.
//
// Telnyx documents the inbound WhatsApp payload only partly: `payload.body` mirrors Meta's message
// object (from, id, type, text.body, image/audio/... with url or id). The SMS-style fields
// (`payload.text`, `payload.media`) are read as a fallback. Untested against the live API.
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { normalizeCustomerId } from "@workforce/shared";
import { waMessageToInbound, type WaMessage } from "./whatsapp-meta.ts";
import { ChannelError, errorText, readLimited, withRetries, type DeliveryUpdate, type InboundMessage, type WhatsAppProvider } from "./types.ts";

type TelnyxError = { code?: string | number; title?: string; detail?: string };
type TelnyxEvent = {
  data?: {
    id?: string;
    event_type?: string;
    payload?: {
      id?: string;
      type?: string;
      direction?: string;
      from?: { phone_number?: string };
      to?: string | { phone_number?: string; status?: string }[];
      text?: string;
      media?: { url?: string; content_type?: string }[];
      body?: WaMessage;
      errors?: TelnyxError[];
    };
  };
};

const STATUS: Record<string, DeliveryUpdate["status"]> = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
  sending_failed: "FAILED",
  delivery_failed: "FAILED",
};
/** DER header of an Ed25519 public key; Telnyx's portal shows the 32 raw key bytes in base64. */
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,255}$/;

/** Telnyx's public key (raw 32 bytes or DER, base64) as a key object. */
export function telnyxPublicKey(base64: string): KeyObject {
  const raw = Buffer.from(base64, "base64");
  return createPublicKey({ key: raw.length === 32 ? Buffer.concat([SPKI_ED25519, raw]) : raw, format: "der", type: "spki" });
}

const kindOf = (mime: string) => (mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : "document");
const describe = (e: TelnyxError | undefined, fallback: string) => `Telnyx error${e?.code ? ` ${e.code}` : ""}: ${e?.detail || e?.title || fallback}`;

export function telnyxWhatsApp(options: {
  apiKey: string;
  /** Mission Control > Keys & Credentials > Public Key. */
  publicKey: string;
  /** Sent with each message so delivery events reach this provider's webhook. */
  webhookUrl?: string;
  api?: string;
  fetch?: typeof fetch;
  retry?: { attempts: number; backoffMs: number };
  /** Webhooks older than this are refused (replays). */
  toleranceSec?: number;
}): WhatsAppProvider {
  const api = options.api ?? "https://api.telnyx.com";
  const http = options.fetch ?? fetch;
  const retry = options.retry ?? { attempts: 3, backoffMs: 1000 };
  const key = telnyxPublicKey(options.publicKey);
  const bearer = { authorization: `Bearer ${options.apiKey}` };

  return {
    kind: "whatsapp",
    name: "telnyx",
    ack: { contentType: "text/plain", body: "" },

    parseWebhook({ rawBody, headers }) {
      const signature = headers["telnyx-signature-ed25519"];
      const timestamp = headers["telnyx-timestamp"];
      if (typeof signature !== "string" || typeof timestamp !== "string") return null;
      if (Math.abs(Date.now() / 1000 - Number(timestamp)) > (options.toleranceSec ?? 300)) return null;
      try {
        if (!verify(null, Buffer.from(`${timestamp}|${rawBody}`), key, Buffer.from(signature, "base64"))) return null;
      } catch {
        return null;
      }
      let event: TelnyxEvent;
      try {
        event = JSON.parse(rawBody) as TelnyxEvent;
      } catch {
        return null;
      }
      const messages: InboundMessage[] = [];
      const statuses: DeliveryUpdate[] = [];
      const p = event.data?.payload;
      const id = p?.id ?? event.data?.id;
      // SMS and MMS on the same messaging profile are not ours.
      if (!p || !id || (p.type && p.type.toUpperCase() !== "WHATSAPP")) return { messages, statuses };

      if (event.data?.event_type === "message.received") {
        const address = typeof p.to === "string" ? p.to : p.to?.[0]?.phone_number;
        const from = p.body?.from ?? p.from?.phone_number;
        if (!address || !from) return { messages, statuses };
        const body: WaMessage = p.body ?? { from, type: "text", text: { body: p.text ?? "" } };
        const inbound = waMessageToInbound({ ...body, from }, normalizeCustomerId(address), undefined, id);
        if (inbound && !p.body)
          for (const m of p.media ?? [])
            if (m.url) inbound.media.push({ kind: kindOf(m.content_type ?? ""), url: m.url, mimeType: m.content_type ?? "application/octet-stream" });
        if (inbound) messages.push(inbound);
      } else if (p.direction === "outbound" && typeof p.to !== "string") {
        const status = STATUS[p.to?.[0]?.status ?? ""];
        if (status) statuses.push({ providerMessageId: id, status, ...(status === "FAILED" && { error: describe(p.errors?.[0], "the message was not delivered") }) });
      }
      return { messages, statuses };
    },

    async send({ address, to, text, idempotencyKey }) {
      // With an idempotency key Telnyx sends once however often it is asked, so network errors and 5xx can be retried too.
      const keyed = idempotencyKey !== undefined && IDEMPOTENCY_KEY.test(idempotencyKey);
      const { result, attempts } = await withRetries(retry, async () => {
        let res: Response;
        try {
          res = await http(`${api}/v2/messages/whatsapp`, {
            method: "POST",
            headers: { ...bearer, "content-type": "application/json", ...(keyed && { "idempotency-key": idempotencyKey }) },
            body: JSON.stringify({
              from: address,
              to,
              type: "WHATSAPP",
              whatsapp_message: { type: "text", text: { body: text, preview_url: false } },
              ...(options.webhookUrl && { webhook_url: options.webhookUrl }),
            }),
            signal: AbortSignal.timeout(15_000),
          });
        } catch (err) {
          throw new ChannelError(`Telnyx could not be reached: ${errorText(err)}`, keyed);
        }
        const data = (await res.json().catch(() => null)) as { data?: { id?: string }; errors?: TelnyxError[] } | null;
        if (!res.ok) throw new ChannelError(describe(data?.errors?.[0], `HTTP ${res.status}`), res.status === 429 || (keyed && res.status >= 500));
        if (!data?.data?.id) throw new ChannelError("Telnyx accepted the message but returned no id");
        return data.data.id;
      });
      return { providerMessageId: result, attempts };
    },

    async downloadMedia(media, address, maxBytes) {
      const byId = media.providerMediaId && `${api}/v2/whatsapp/media/${encodeURIComponent(address)}/${encodeURIComponent(media.providerMediaId)}`;
      const url = media.url ?? byId;
      if (!url?.startsWith("https://")) throw new ChannelError("The file has no download address");
      // The API key goes only to Telnyx's API; hosted media URLs are fetched without it.
      const res = await http(url, { headers: url.startsWith(`${api}/`) ? bearer : {}, signal: AbortSignal.timeout(30_000) }).catch((err: unknown) => {
        throw new ChannelError(`The file could not be downloaded: ${errorText(err)}`);
      });
      if (!res.ok) throw new ChannelError(`The file could not be downloaded (HTTP ${res.status})`);
      return { data: await readLimited(res, maxBytes), mimeType: res.headers.get("content-type") ?? media.mimeType };
    },
  };
}

/** From `TELNYX_API_KEY` and `TELNYX_PUBLIC_KEY`; null when either is missing. */
export function telnyxWhatsAppFromEnv(env: Record<string, string | undefined> = process.env, webhookUrl?: string) {
  if (!env.TELNYX_API_KEY || !env.TELNYX_PUBLIC_KEY) return null;
  return telnyxWhatsApp({ apiKey: env.TELNYX_API_KEY, publicKey: env.TELNYX_PUBLIC_KEY, webhookUrl });
}
