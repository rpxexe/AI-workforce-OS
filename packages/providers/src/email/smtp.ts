// Email through the organization's own SMTP server (nodemailer). The host is admin-entered, so it is resolved
// and refused when private, then the connection goes to that checked address (no DNS rebinding) while TLS
// still verifies the certificate against the host name.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ChannelError, errorText, withRetries, type OutboundMessage } from "@workforce/channels";
import type { ProviderErrorKind } from "@workforce/shared";
import { isPrivateAddress } from "@workforce/tools";
import nodemailer from "nodemailer";
import type { EmailSender } from "../types.ts";

type Transport = { sendMail(m: object): Promise<{ messageId?: string }>; verify(): Promise<unknown> };
type SmtpError = { code?: string; responseCode?: number };

// "Try later" replies: the server refused the command, so nothing was accepted and a retry cannot send twice.
const TRY_LATER = new Set([421, 450, 451, 452]);

export function smtpEmail(o: {
  host: string;
  port: number;
  security: "starttls" | "tls";
  username: string;
  password: string;
  resolve?: (host: string) => Promise<string[]>;
  transport?: (options: object) => Transport;
  retry?: { attempts: number; backoffMs: number };
}): EmailSender {
  const resolve = o.resolve ?? (async (host: string) => (isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address)));
  const createTransport = o.transport ?? ((options: object) => nodemailer.createTransport(options) as Transport);
  const retry = o.retry ?? { attempts: 3, backoffMs: 1000 };
  const host = o.host.trim().toLowerCase().replace(/\.$/, "");

  const fail = (err: unknown) => {
    if (err instanceof ChannelError) return err;
    const { code, responseCode } = (err ?? {}) as SmtpError;
    const kind: ProviderErrorKind =
      code === "EAUTH" || responseCode === 535 || responseCode === 530
        ? "auth"
        : responseCode && TRY_LATER.has(responseCode)
          ? "rate_limit"
          : responseCode && responseCode >= 500
            ? "refused"
            : "unavailable";
    const raw = errorText(err);
    const text = (o.password ? raw.split(o.password).join("***") : raw).slice(0, 300);
    return new ChannelError(`SMTP ${host} failed${responseCode ? ` (${responseCode})` : ""}: ${text}`, kind === "rate_limit", kind);
  };

  const connect = async () => {
    if (host === "localhost" || host.endsWith(".localhost")) throw new ChannelError(`SMTP host ${host} is a private address`, false, "config");
    let addresses: string[];
    try {
      addresses = await resolve(host.replace(/^\[|\]$/g, ""));
    } catch {
      throw new ChannelError(`SMTP host ${host} could not be found`, false, "config");
    }
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new ChannelError(`SMTP host ${host} is a private address`, false, "config");
    return createTransport({
      host: addresses[0],
      port: o.port,
      secure: o.security === "tls",
      requireTLS: o.security === "starttls",
      servername: host,
      tls: { servername: host },
      auth: { user: o.username, pass: o.password },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 15_000,
    });
  };

  return {
    kind: "email",
    name: "smtp",

    async send({ address, to, text, subject, inReplyTo, replyTo, fromName }: OutboundMessage) {
      const transport = await connect();
      const name = fromName?.replace(/["<>\r\n]/g, "").trim();
      const { result, attempts } = await withRetries(retry, async () => {
        const info = await transport
          .sendMail({
            from: name ? { name, address } : address,
            to,
            subject: subject || "(no subject)",
            text,
            ...(replyTo && { replyTo }),
            ...(inReplyTo && { inReplyTo, references: inReplyTo }),
          })
          .catch((err: unknown) => {
            throw fail(err);
          });
        if (!info.messageId) throw new ChannelError("SMTP accepted the email but returned no message id");
        return info.messageId;
      });
      return { providerMessageId: result, attempts };
    },

    async check() {
      const transport = await connect();
      await transport.verify().catch((err: unknown) => {
        throw fail(err);
      });
    },
  };
}
