import { createHmac, timingSafeEqual } from "node:crypto";
import { TelephonyError, type CallStatus, type TelephonyProvider } from "./types.ts";

const STATUS: Record<string, CallStatus> = {
  queued: "QUEUED",
  initiated: "QUEUED",
  ringing: "RINGING",
  "in-progress": "IN_PROGRESS",
  answered: "IN_PROGRESS",
  completed: "COMPLETED",
  busy: "BUSY",
  "no-answer": "NO_ANSWER",
  failed: "FAILED",
  canceled: "CANCELED",
};

export const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** A status callback in Twilio's form fields (Telnyx TeXML sends the same ones). */
export function twimlStatusOf(params: Record<string, string>) {
  const duration = Number(params.CallDuration);
  return {
    providerCallId: params.CallSid ?? "",
    status: STATUS[params.CallStatus ?? ""] ?? null,
    durationSec: params.CallDuration !== undefined && Number.isFinite(duration) ? duration : null,
  };
}

/** X-Twilio-Signature: base64 HMAC-SHA1 of the URL followed by every parameter, sorted, as name+value. */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>) {
  const payload = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(payload).digest("base64");
}

type Credentials = {
  accountSid: string;
  authToken: string;
  /** Signs webhooks when it is not the auth token (SignalWire's signing key). */
  signingKey?: string;
  /** "signalwire" for SignalWire's Twilio-compatible LaML API. */
  name?: string;
};

/** Twilio over its REST API and Media Streams. Plain fetch: no SDK. */
export function twilioProvider(
  { accountSid, authToken, signingKey, name = "twilio" }: Credentials,
  api = "https://api.twilio.com",
  http: typeof fetch = fetch,
): TelephonyProvider {
  const auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
  const base = `${api}/2010-04-01/Accounts/${accountSid}`;

  const request = async <T>(path: string, form?: URLSearchParams): Promise<T> => {
    let res: Response;
    try {
      res = await http(`${base}${path}`, {
        method: form ? "POST" : "GET",
        headers: { authorization: auth, ...(form && { "content-type": "application/x-www-form-urlencoded" }) },
        body: form,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new TelephonyError(`${name === "twilio" ? "Twilio" : "SignalWire"} could not be reached`, { cause: err });
    }
    const body = (await res.json().catch(() => ({}))) as T & { message?: string; code?: number };
    if (!res.ok) throw new TelephonyError(`${name === "twilio" ? "Twilio" : "SignalWire"} answered ${res.status}: ${body.message ?? "unknown error"}`, { cause: { status: res.status } });
    return body;
  };

  const connect = (streamUrl: string, parameters: Record<string, string>) =>
    `<Connect><Stream url="${xml(streamUrl)}">${Object.entries(parameters)
      .map(([name, value]) => `<Parameter name="${xml(name)}" value="${xml(value)}"/>`)
      .join("")}</Stream></Connect>`;
  // Runs only if our stream closes while the caller is still on the line, i.e. when we failed.
  const fallback = "<Say>Sorry, something went wrong on our side. Please call again.</Say><Hangup/>";

  return {
    name,

    verifyWebhook({ url, params, headers }) {
      // SignalWire sends its own header name with Twilio's algorithm.
      const signature = headers["x-twilio-signature"] ?? headers["x-signalwire-signature"];
      if (typeof signature !== "string") return false;
      const expected = Buffer.from(twilioSignature(signingKey ?? authToken, url, params));
      const given = Buffer.from(signature);
      return expected.length === given.length && timingSafeEqual(expected, given);
    },

    connectToStream: (streamUrl, parameters) => `<?xml version="1.0" encoding="UTF-8"?><Response>${connect(streamUrl, parameters)}${fallback}</Response>`,

    sayAndHangUp: (message) => `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xml(message)}</Say><Hangup/></Response>`,

    statusOf: twimlStatusOf,

    async placeCall({ to, from, streamUrl, parameters, statusCallbackUrl, timeLimitSec }) {
      const form = new URLSearchParams({
        To: to,
        From: from,
        Twiml: `<Response>${connect(streamUrl, parameters)}${fallback}</Response>`,
        StatusCallback: statusCallbackUrl,
        TimeLimit: String(timeLimitSec),
      });
      for (const event of ["initiated", "ringing", "answered", "completed"]) form.append("StatusCallbackEvent", event);
      const call = await request<{ sid: string }>("/Calls.json", form);
      return { providerCallId: call.sid };
    },

    async endCall(providerCallId) {
      await request(`/Calls/${encodeURIComponent(providerCallId)}.json`, new URLSearchParams({ Status: "completed" }));
    },

    async transferCall(providerCallId, to, actionUrl) {
      // Modifying a live call with new TwiML; for an inbound call the person sees the caller's number.
      const twiml = `<Response><Dial action="${xml(actionUrl)}" method="POST" timeout="25">${xml(to)}</Dial></Response>`;
      await request(`/Calls/${encodeURIComponent(providerCallId)}.json`, new URLSearchParams({ Twiml: twiml }));
    },

    async configureNumber(number, { voiceUrl, statusCallbackUrl }) {
      const list = await request<{ incoming_phone_numbers?: { sid: string }[] }>(
        `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`,
      );
      const sid = list.incoming_phone_numbers?.[0]?.sid;
      if (!sid) throw new TelephonyError(`${number} is not a number in this Twilio account`);
      await request(
        `/IncomingPhoneNumbers/${sid}.json`,
        new URLSearchParams({ VoiceUrl: voiceUrl, VoiceMethod: "POST", StatusCallback: statusCallbackUrl, StatusCallbackMethod: "POST" }),
      );
      return { providerNumberId: sid };
    },

    parseMedia(message) {
      let m: {
        event?: string;
        streamSid?: string;
        start?: { streamSid?: string; callSid?: string; customParameters?: Record<string, string> };
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
            streamId: m.start?.streamSid ?? m.streamSid ?? "",
            providerCallId: m.start?.callSid ?? "",
            parameters: m.start?.customParameters ?? {},
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

    audioMessage: (streamId, audio) => JSON.stringify({ event: "media", streamSid: streamId, media: { payload: audio.toString("base64") } }),
    markMessage: (streamId, name) => JSON.stringify({ event: "mark", streamSid: streamId, mark: { name } }),
    clearMessage: (streamId) => JSON.stringify({ event: "clear", streamSid: streamId }),
  } satisfies TelephonyProvider;
}

/** From `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`. */
export function twilioFromEnv(env: Record<string, string | undefined> = process.env) {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;
  return twilioProvider({ accountSid, authToken });
}
