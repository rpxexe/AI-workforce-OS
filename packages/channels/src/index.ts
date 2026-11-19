// Messaging channels behind one model: each turns its payloads into `InboundMessage`s and
// `DeliveryUpdate`s, and sends `OutboundMessage`s. The API runs every inbound message through
// the same agent runtime, whatever channel (and provider) it came from.
import type { WhatsAppProvider } from "./types.ts";
import { metaWhatsAppFromEnv } from "./whatsapp-meta.ts";
import { telnyxWhatsAppFromEnv } from "./whatsapp-telnyx.ts";
import { twilioWhatsAppFromEnv } from "./whatsapp-twilio.ts";

export * from "./types.ts";
export { splitText } from "./text.ts";
export { testEmailSender, toInboundEmail } from "./email.ts";
export { metaSignature, metaWhatsApp, metaWhatsAppFromEnv } from "./whatsapp-meta.ts";
export { telnyxPublicKey, telnyxWhatsApp, telnyxWhatsAppFromEnv } from "./whatsapp-telnyx.ts";
export { twilioWhatsApp, twilioWhatsAppFromEnv } from "./whatsapp-twilio.ts";

/**
 * Every WhatsApp provider `.env` has credentials for. Several can be live at once; each employee's
 * number says which one carries it. Delivery receipts are pointed at PUBLIC_URL when it is set.
 */
export function whatsappProvidersFromEnv(env: Record<string, string | undefined> = process.env): WhatsAppProvider[] {
  const base = env.PUBLIC_URL?.replace(/\/+$/, "");
  const hook = (name: string) => (base ? `${base}/channels/whatsapp/${name}/webhook` : undefined);
  return [metaWhatsAppFromEnv(env), twilioWhatsAppFromEnv(env, hook("twilio")), telnyxWhatsAppFromEnv(env, hook("telnyx"))].filter(
    (p): p is WhatsAppProvider => p !== null,
  );
}
