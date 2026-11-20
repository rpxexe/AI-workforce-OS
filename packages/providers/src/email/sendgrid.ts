// Email through SendGrid's v3 Mail Send API. SendGrid has no idempotency key, so only 429 (refused before
// sending) is retried; a network error or 5xx may already have sent the mail.
import { randomUUID } from "node:crypto";
import { ChannelError, errorText, withRetries, type OutboundMessage } from "@workforce/channels";
import { kindOfStatus } from "@workforce/shared";
import type { EmailSender } from "../types.ts";

export function sendGridEmail(o: { apiKey: string; fetch?: typeof fetch; api?: string; retry?: { attempts: number; backoffMs: number } }): EmailSender {
  const api = o.api ?? "https://api.sendgrid.com";
  const http = o.fetch ?? fetch;
  const retry = o.retry ?? { attempts: 3, backoffMs: 1000 };
  const auth = { authorization: `Bearer ${o.apiKey}` };

  const failure = async (res: Response) => {
    const data = (await res.json().catch(() => null)) as { errors?: { message?: string }[] } | null;
    const text = data?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    return new ChannelError(`SendGrid refused (${res.status}): ${text.slice(0, 300)}`, res.status === 429, kindOfStatus(res.status));
  };
  const request = async (path: string, init: RequestInit) => {
    try {
      return await http(`${api}${path}`, { ...init, headers: { ...auth, ...init.headers }, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new ChannelError(`SendGrid could not be reached: ${errorText(err).slice(0, 300)}`, false, "unavailable");
    }
  };

  return {
    kind: "email",
    name: "sendgrid",

    async send({ address, to, text, subject, inReplyTo, replyTo, fromName }: OutboundMessage) {
      const name = fromName?.replace(/["<>\r\n]/g, "").trim();
      const body = JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: address, ...(name && { name }) },
        ...(replyTo && { reply_to: { email: replyTo } }),
        subject: subject || "(no subject)",
        content: [{ type: "text/plain", value: text }],
        ...(inReplyTo && { headers: { "In-Reply-To": inReplyTo, References: inReplyTo } }),
      });
      const { result, attempts } = await withRetries(retry, async () => {
        const res = await request("/v3/mail/send", { method: "POST", headers: { "content-type": "application/json" }, body });
        if (!res.ok) throw await failure(res);
        return res.headers.get("x-message-id") ?? randomUUID();
      });
      return { providerMessageId: result, attempts };
    },

    async check() {
      const res = await request("/v3/scopes", {});
      if (!res.ok) throw await failure(res);
    },
  };
}
