import { randomUUID } from "node:crypto";
import { normalizeCustomerId, type InboundEmail } from "@workforce/shared";
import type { ChannelSender, InboundMessage } from "./types.ts";

/** The new part of a reply: quoted lines and everything from "On ... wrote:" on are dropped. */
const newText = (text: string) => {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^On .+wrote:\s*$/.test(line) || /^-{2,}\s*Original Message/i.test(line)) break;
    if (!line.startsWith(">")) lines.push(line);
  }
  return lines.join("\n").trim();
};

/** An inbound email to `address`, in the common model; null when the sender has no usable address. */
export function toInboundEmail(email: InboundEmail, address: string): InboundMessage | null {
  const bracketed = /<([^<>\s]+@[^<>\s]+)>/.exec(email.from);
  const sender = (bracketed?.[1] ?? email.from).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sender)) return null;
  const name = bracketed ? email.from.slice(0, bracketed.index).replaceAll('"', "").trim() : "";
  return {
    channel: "email",
    address,
    providerMessageId: email.messageId,
    from: normalizeCustomerId(sender),
    name: name || undefined,
    text: newText(email.text),
    media: [],
    subject: email.subject,
    inReplyTo: email.inReplyTo,
    receivedAt: new Date(),
  };
}

// shortcut: test mode, nothing is delivered; the reply is kept only in the message log. Add a sender when an email provider is chosen
export const testEmailSender: ChannelSender = {
  kind: "email",
  async send() {
    return { providerMessageId: `<test-${randomUUID()}@workforce.invalid>`, attempts: 1 };
  },
};
