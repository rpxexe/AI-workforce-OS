// Email through Amazon SES (API v2), SigV4-signed over plain fetch. SendEmail has no idempotency key, so only
// throttling (refused before sending) is retried.
import { ChannelError, errorText, withRetries, type OutboundMessage } from "@workforce/channels";
import { kindOfStatus } from "@workforce/shared";
import { signV4 } from "../aws.ts";
import type { EmailSender } from "../types.ts";

/** "Name <address>"; SES wants a non-ASCII display name as a MIME encoded-word. */
const fromHeader = (address: string, name: string | undefined) => {
  if (!name) return address;
  const display = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/\\/g, "")}"` : `=?UTF-8?B?${Buffer.from(name).toString("base64")}?=`;
  return `${display} <${address}>`;
};

export function sesEmail(o: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  fetch?: typeof fetch;
  endpoint?: string;
  retry?: { attempts: number; backoffMs: number };
}): EmailSender {
  const endpoint = o.endpoint ?? `https://email.${o.region}.amazonaws.com`;
  const http = o.fetch ?? fetch;
  const retry = o.retry ?? { attempts: 3, backoffMs: 1000 };

  const request = async (method: string, path: string, body = "") => {
    const url = new URL(`${endpoint}${path}`);
    const headers = signV4({
      method,
      url,
      headers: body ? { "content-type": "application/json" } : {},
      body,
      region: o.region,
      service: "ses",
      accessKeyId: o.accessKeyId,
      secretAccessKey: o.secretAccessKey,
    });
    delete headers.host; // fetch sets the same Host from the URL
    let res: Response;
    try {
      res = await http(url, { method, headers, ...(body && { body }), signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new ChannelError(`SES could not be reached: ${errorText(err).slice(0, 300)}`, false, "unavailable");
    }
    if (res.ok) return res;
    // REST-JSON errors: the type in x-amzn-ErrorType ("ThrottlingException:..."), the text in the body.
    const type = (res.headers.get("x-amzn-errortype") ?? "").split(":")[0] ?? "";
    const data = (await res.json().catch(() => null)) as { message?: string; Message?: string } | null;
    const throttled = res.status === 429 || /TooManyRequests|Throttling/.test(type);
    const text = (data?.message ?? data?.Message ?? `HTTP ${res.status}`).slice(0, 300);
    throw new ChannelError(`SES refused (${res.status}${type ? ` ${type}` : ""}): ${text}`, throttled, throttled ? "rate_limit" : kindOfStatus(res.status));
  };

  return {
    kind: "email",
    name: "ses",

    async send({ address, to, text, subject, inReplyTo, replyTo, fromName }: OutboundMessage) {
      const name = fromName?.replace(/["<>\r\n]/g, "").trim();
      const body = JSON.stringify({
        FromEmailAddress: fromHeader(address, name),
        Destination: { ToAddresses: [to] },
        ...(replyTo && { ReplyToAddresses: [replyTo] }),
        Content: {
          Simple: {
            Subject: { Data: subject || "(no subject)" },
            Body: { Text: { Data: text } },
            ...(inReplyTo && { Headers: [{ Name: "In-Reply-To", Value: inReplyTo }, { Name: "References", Value: inReplyTo }] }),
          },
        },
      });
      const { result, attempts } = await withRetries(retry, async () => {
        const res = await request("POST", "/v2/email/outbound-emails", body);
        const data = (await res.json().catch(() => null)) as { MessageId?: string } | null;
        if (!data?.MessageId) throw new ChannelError("SES accepted the email but returned no id");
        return data.MessageId;
      });
      return { providerMessageId: result, attempts };
    },

    async check() {
      await request("GET", "/v2/email/account");
    },
  };
}
