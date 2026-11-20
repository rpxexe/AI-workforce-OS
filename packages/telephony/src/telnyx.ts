import { createHmac, timingSafeEqual } from "node:crypto";
import { twimlStatusOf, xml } from "./twilio.ts";
import { TelephonyError, type TelephonyProvider } from "./types.ts";

type Credentials = {
  apiKey: string;
  /** The Telnyx account id TeXML's REST paths use (`AccountSid` in its webhooks). Looked up when absent. */
  accountSid?: string;
  /** The TeXML Application our numbers and outbound calls use. */
  applicationId: string;
};

/**
 * Telnyx over TeXML, its Twilio-compatible markup: the same webhooks, form fields and statuses as
 * Twilio, a slightly different media stream message format. Plain fetch: no SDK.
 */
export function telnyxProvider({ apiKey, accountSid, applicationId }: Credentials, api = "https://api.telnyx.com", http: typeof fetch = fetch): TelephonyProvider {
  // Telnyx does not document signing TeXML's voice URL request, so every webhook URL we hand out
  // carries this secret, and a webhook without it is refused.
  const webhookToken = createHmac("sha256", apiKey).update("telnyx-webhook").digest("hex");
  const withToken = (url: string) => {
    const u = new URL(url);
    u.searchParams.set("token", webhookToken);
    return u.toString();
  };

  const request = async <T>(method: "GET" | "POST" | "PATCH", path: string, body?: object | URLSearchParams): Promise<T> => {
    let res: Response;
    try {
      res = await http(`${api}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(body && { "content-type": body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json" }),
        },
        body: body instanceof URLSearchParams ? body : body && JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new TelephonyError("Telnyx could not be reached", { cause: err });
    }
    const json = (await res.json().catch(() => ({}))) as T & { errors?: { title?: string; detail?: string }[]; message?: string };
    if (!res.ok) {
      const reason = json.errors?.[0] ? (json.errors[0].detail ?? json.errors[0].title) : json.message;
      throw new TelephonyError(`Telnyx answered ${res.status}: ${reason ?? "unknown error"}`);
    }
    return json;
  };

  // bidirectionalMode="rtp": we send raw 8 kHz mu-law back, like Twilio (the default is mp3).
  const connect = (streamUrl: string, parameters: Record<string, string>) =>
    `<Connect><Stream url="${xml(streamUrl)}" bidirectionalMode="rtp" bidirectionalCodec="PCMU">${Object.entries(parameters)
      .map(([name, value]) => `<Parameter name="${xml(name)}" value="${xml(value)}"/>`)
      .join("")}</Stream></Connect>`;
  // Runs only if our stream closes while the caller is still on the line, i.e. when we failed.
  const fallback = "<Say>Sorry, something went wrong on our side. Please call again.</Say><Hangup/>";
  // Telnyx documents no page that shows the account id; the user profile's id is assumed to be it.
  let account: Promise<string> | undefined = accountSid ? Promise.resolve(accountSid) : undefined;
  const calls = async () => {
    account ??= request<{ data?: { user_id?: string } }>("GET", "/v2/user_profile").then((r) => {
      if (!r.data?.user_id) throw new TelephonyError("Telnyx did not say the account id; set TELNYX_ACCOUNT_SID");
      return r.data.user_id;
    });
    account.catch(() => (account = undefined));
    return `/v2/texml/Accounts/${encodeURIComponent(await account)}/Calls`;
  };

  return {
    name: "telnyx",

    verifyWebhook({ url }) {
      // shortcut: the URL token only; also check Telnyx's Ed25519 headers once a real call shows what TeXML signs
      const given = Buffer.from(new URL(url).searchParams.get("token") ?? "");
      const expected = Buffer.from(webhookToken);
      return given.length === expected.length && timingSafeEqual(given, expected);
    },

    connectToStream: (streamUrl, parameters) => `<?xml version="1.0" encoding="UTF-8"?><Response>${connect(streamUrl, parameters)}${fallback}</Response>`,

    sayAndHangUp: (message) => `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xml(message)}</Say><Hangup/></Response>`,

    statusOf: twimlStatusOf,

    async placeCall({ to, from, streamUrl, parameters, statusCallbackUrl, timeLimitSec }) {
      const call = await request<{ sid?: string; call_sid?: string }>("POST", await calls(), {
        To: to,
        From: from,
        ApplicationSid: applicationId,
        Texml: `<Response>${connect(streamUrl, parameters)}${fallback}</Response>`,
        StatusCallback: withToken(statusCallbackUrl),
        StatusCallbackMethod: "POST",
        StatusCallbackEvent: "initiated ringing answered completed",
        TimeLimit: Math.min(Math.max(timeLimitSec, 30), 14_400),
      });
      // Telnyx's API reference shows no call id in this answer; then the first status callback supplies it.
      return { providerCallId: call.sid ?? call.call_sid ?? null };
    },

    async endCall(providerCallId) {
      await request("POST", `${await calls()}/${encodeURIComponent(providerCallId)}`, new URLSearchParams({ Status: "completed" }));
    },

    async transferCall(providerCallId, to, actionUrl) {
      // TeXML's update-call endpoint, like Twilio's, takes replacement markup (as Texml). The action URL
      // carries the webhook token, like every URL we give Telnyx.
      const texml = `<Response><Dial action="${xml(withToken(actionUrl))}" method="POST" timeout="25">${xml(to)}</Dial></Response>`;
      await request("POST", `${await calls()}/${encodeURIComponent(providerCallId)}`, new URLSearchParams({ Texml: texml }));
    },

    async configureNumber(number, { voiceUrl, statusCallbackUrl }) {
      // The filter takes digits only.
      const list = await request<{ data?: { id: string }[] }>("GET", `/v2/phone_numbers?filter[phone_number]=${number.replace(/\D/g, "")}`);
      const id = list.data?.[0]?.id;
      if (!id) throw new TelephonyError(`${number} is not a number in this Telnyx account`);
      // The application's URLs serve every number on it; they all point at this API.
      const app = await request<{ data?: { friendly_name?: string } }>("GET", `/v2/texml_applications/${encodeURIComponent(applicationId)}`);
      await request("PATCH", `/v2/texml_applications/${encodeURIComponent(applicationId)}`, {
        friendly_name: app.data?.friendly_name ?? "AI Workforce",
        voice_url: withToken(voiceUrl),
        voice_method: "post",
        status_callback: withToken(statusCallbackUrl),
        status_callback_method: "post",
      });
      await request("PATCH", `/v2/phone_numbers/${encodeURIComponent(id)}`, { connection_id: applicationId });
      return { providerNumberId: id };
    },

    parseMedia(message) {
      let m: {
        event?: string;
        stream_id?: string;
        start?: { call_control_id?: string; custom_parameters?: Record<string, string> };
        media?: { track?: string; payload?: string };
        mark?: { name?: string };
        dtmf?: { digit?: string };
      };
      try {
        m = JSON.parse(message);
      } catch {
        return { type: "other" };
      }
      switch (m.event) {
        case "start":
          return {
            type: "start",
            streamId: m.stream_id ?? "",
            // The same id TeXML webhooks send as CallSid.
            providerCallId: m.start?.call_control_id ?? "",
            parameters: m.start?.custom_parameters ?? {},
          };
        case "media":
          return m.media?.payload && m.media.track !== "outbound"
            ? { type: "audio", audio: Buffer.from(m.media.payload, "base64") }
            : { type: "other" };
        case "mark":
          return { type: "mark", name: m.mark?.name ?? "" };
        case "dtmf":
          return { type: "dtmf", digit: m.dtmf?.digit ?? "" };
        case "stop":
          return { type: "stop" };
        default:
          return { type: "other" };
      }
    },

    // One stream per call, so Telnyx needs no stream id on what we send.
    audioMessage: (_streamId, audio) => JSON.stringify({ event: "media", media: { payload: audio.toString("base64") } }),
    markMessage: (_streamId, name) => JSON.stringify({ event: "mark", mark: { name } }),
    clearMessage: () => JSON.stringify({ event: "clear" }),
  } satisfies TelephonyProvider;
}

/** From `TELNYX_API_KEY` and `TELNYX_APP_ID` (optional `TELNYX_ACCOUNT_SID`). */
export function telnyxFromEnv(env: Record<string, string | undefined> = process.env) {
  const { TELNYX_API_KEY: apiKey, TELNYX_ACCOUNT_SID: accountSid, TELNYX_APP_ID: applicationId } = env;
  if (!apiKey || !applicationId) return null;
  return telnyxProvider({ apiKey, accountSid: accountSid || undefined, applicationId });
}
