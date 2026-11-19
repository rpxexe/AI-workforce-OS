// WhatsApp through Twilio's Messages API: form-encoded webhooks signed with X-Twilio-Signature
// (the same scheme as Twilio voice), sends to /Messages.json, status callbacks, media at MediaUrlN.
import { timingSafeEqual } from "node:crypto";
import { normalizeCustomerId } from "@workforce/shared";
import { twilioSignature } from "@workforce/telephony";
import { ChannelError, errorText, readLimited, withRetries, type DeliveryUpdate, type InboundMedia, type WhatsAppProvider } from "./types.ts";

/** Codes meaning "not sent, try again later": REST concurrency (20429) and the channel's rate limit (63018). */
const RETRYABLE = new Set([20429, 63018]);
const MEANING: Record<number, string> = {
  20003: "the Twilio credentials are invalid",
  21211: "the number is not valid",
  63016: "more than 24 hours have passed since the customer's last message, so WhatsApp only allows template messages",
  63018: "the WhatsApp rate limit for this sender was reached",
};
const STATUS: Record<string, DeliveryUpdate["status"]> = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED", undelivered: "FAILED" };

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const bare = (address = "") => address.replace(/^whatsapp:/, "");
const kindOf = (mime: string) => (mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : "document");
const meaning = (code: number | undefined, fallback: string) => `Twilio error${code ? ` ${code}` : ""}: ${(code && MEANING[code]) || fallback}`;

export function twilioWhatsApp(options: {
  accountSid: string;
  authToken: string;
  /** Where Twilio reports delivery (this provider's webhook URL); omit and no receipts arrive. */
  webhookUrl?: string;
  api?: string;
  fetch?: typeof fetch;
  retry?: { attempts: number; backoffMs: number };
}): WhatsAppProvider {
  const api = options.api ?? "https://api.twilio.com";
  const http = options.fetch ?? fetch;
  const retry = options.retry ?? { attempts: 3, backoffMs: 1000 };
  const auth = `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString("base64")}`;

  return {
    kind: "whatsapp",
    name: "twilio",
    // Twilio expects TwiML back; an empty response sends nothing (replies go through the API).
    ack: { contentType: "text/xml", body: "<Response></Response>" },

    parseWebhook({ url, rawBody, headers }) {
      const params = Object.fromEntries(new URLSearchParams(rawBody));
      const signature = headers["x-twilio-signature"];
      if (typeof signature !== "string" || !same(signature, twilioSignature(options.authToken, url, params))) return null;

      // Our status callback URL carries ?event=status; everything else is a customer's message.
      if (new URL(url).searchParams.get("event") === "status") {
        const status = STATUS[params.MessageStatus ?? ""];
        if (!params.MessageSid || !status) return { messages: [], statuses: [] };
        const code = Number(params.ErrorCode) || undefined;
        return {
          messages: [],
          statuses: [{ providerMessageId: params.MessageSid, status, ...(status === "FAILED" && { error: meaning(code, "the message was not delivered") }) }],
        };
      }

      if (!params.MessageSid || !params.From || !params.To) return { messages: [], statuses: [] };
      const media: InboundMedia[] = [];
      for (let i = 0; i < Number(params.NumMedia ?? 0); i++) {
        const url_ = params[`MediaUrl${i}`];
        const mimeType = params[`MediaContentType${i}`] ?? "application/octet-stream";
        if (url_) media.push({ kind: kindOf(mimeType), url: url_, mimeType, ...(i === 0 && params.Body && { caption: params.Body }) });
      }
      let text = params.ButtonText || params.Body || "";
      if (!text && params.Latitude && params.Longitude)
        text = `[Shared a location: ${[params.Label, params.Address].filter(Boolean).join(", ") || "unnamed"} (${params.Latitude}, ${params.Longitude})]`;
      return {
        messages: [
          {
            channel: "whatsapp",
            address: bare(params.To),
            providerMessageId: params.MessageSid,
            from: normalizeCustomerId(params.WaId || bare(params.From)),
            name: params.ProfileName || undefined,
            text,
            media,
            unsupported: !text && media.length === 0 ? "unknown" : undefined,
            receivedAt: new Date(),
          },
        ],
        statuses: [],
      };
    },

    async send({ address, to, text }) {
      const { result, attempts } = await withRetries(retry, async () => {
        const form = new URLSearchParams({ From: `whatsapp:${address}`, To: `whatsapp:${to}`, Body: text });
        if (options.webhookUrl) form.set("StatusCallback", `${options.webhookUrl}?event=status`);
        let res: Response;
        try {
          res = await http(`${api}/2010-04-01/Accounts/${options.accountSid}/Messages.json`, {
            method: "POST",
            headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
            body: form,
            signal: AbortSignal.timeout(15_000),
          });
        } catch (err) {
          // Not retried: the request may have reached Twilio, and a retry could send twice.
          throw new ChannelError(`Twilio could not be reached: ${errorText(err)}`);
        }
        const data = (await res.json().catch(() => null)) as { sid?: string; code?: number; message?: string } | null;
        if (!res.ok) throw new ChannelError(meaning(data?.code, data?.message ?? `HTTP ${res.status}`), res.status === 429 || RETRYABLE.has(data?.code ?? -1));
        if (!data?.sid) throw new ChannelError("Twilio accepted the message but returned no id");
        return data.sid;
      });
      return { providerMessageId: result, attempts };
    },

    async downloadMedia(media, _address, maxBytes) {
      // Media URLs need the account's credentials; never send them anywhere but Twilio's API.
      if (!media.url?.startsWith(`${api}/`)) throw new ChannelError("The file is not at a Twilio address");
      const res = await http(media.url, { headers: { authorization: auth }, signal: AbortSignal.timeout(30_000) }).catch((err: unknown) => {
        throw new ChannelError(`The file could not be downloaded: ${errorText(err)}`);
      });
      if (!res.ok) throw new ChannelError(`The file could not be downloaded (HTTP ${res.status})`);
      return { data: await readLimited(res, maxBytes), mimeType: res.headers.get("content-type") ?? media.mimeType };
    },
  };
}

/** From `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` (the voice account); null when missing. */
export function twilioWhatsAppFromEnv(env: Record<string, string | undefined> = process.env, webhookUrl?: string) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return null;
  return twilioWhatsApp({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, webhookUrl });
}
