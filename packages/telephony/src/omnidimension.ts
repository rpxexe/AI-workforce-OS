import { createHmac, timingSafeEqual } from "node:crypto";
import { TelephonyError, type CallStatus, type DelegatedReport, type TelephonyProvider } from "./types.ts";

type Credentials = {
  apiKey: string;
  /** The OmniDimension agent that talks on our calls. */
  agentId: number;
};

const STATUS: Record<string, CallStatus> = {
  completed: "COMPLETED",
  voicemail_detected: "COMPLETED",
  busy: "BUSY",
  "no-answer": "NO_ANSWER",
  failed: "FAILED",
  canceled: "CANCELED",
};

const unsupported = (what: string) => () => {
  throw new TelephonyError(`OmniDimension does not support ${what}: its own agent runs the call`);
};

/**
 * OmniDimension: a voice AI platform that runs the whole call itself (its speech recognition, model and voice).
 * There is no media stream, so our runtime does not talk on these calls: we dispatch the call to the connection's
 * OmniDimension agent, and its post-call webhook brings back the status and the transcript. Outbound only.
 */
export function omnidimensionProvider({ apiKey, agentId }: Credentials, api = "https://omnidim.io/api/v1", http: typeof fetch = fetch): TelephonyProvider {
  // OmniDimension documents no webhook signature: each status URL we hand out carries an HMAC of its call id.
  const sign = (callId: string) => createHmac("sha256", apiKey).update(`omnidimension-webhook:${callId}`).digest("hex");

  const request = async <T>(method: "GET" | "POST", path: string, body?: object): Promise<T> => {
    let res: Response;
    try {
      res = await http(`${api}${path}`, {
        method,
        headers: { authorization: `Bearer ${apiKey}`, ...(body && { "content-type": "application/json" }) },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new TelephonyError("OmniDimension could not be reached", { cause: err });
    }
    const json = (await res.json().catch(() => ({}))) as T & { error?: string; error_description?: string };
    if (!res.ok) throw new TelephonyError(`OmniDimension answered ${res.status}: ${json.error_description ?? json.error ?? "unknown error"}`);
    return json;
  };

  return {
    name: "omnidimension",
    delegated: true,

    verifyWebhook({ url }) {
      const query = new URL(url).searchParams;
      const callId = query.get("callId");
      const given = Buffer.from(query.get("sig") ?? "");
      const expected = Buffer.from(callId ? sign(callId) : "");
      return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
    },

    connectToStream: unsupported("inbound calls"),
    sayAndHangUp: unsupported("inbound calls"),

    statusOf(params) {
      const duration = Number(params.call_duration);
      return {
        providerCallId: params.call_id ?? "",
        status: STATUS[params.call_status ?? ""] ?? null,
        durationSec: params.call_duration !== undefined && Number.isFinite(duration) ? duration : null,
      };
    },

    reportOf(params): DelegatedReport | null {
      let report: { summary?: unknown; interactions?: unknown } = {};
      try {
        report = JSON.parse(params.call_report ?? "{}") as typeof report;
      } catch {
        return null;
      }
      const turns: DelegatedReport["turns"] = [];
      const start = Date.parse(`${params.start_time ?? ""}Z`);
      for (const item of Array.isArray(report.interactions) ? (report.interactions as Record<string, unknown>[]) : []) {
        const at = Date.parse(`${String(item.time ?? "")}Z`);
        const offsetMs = Number.isFinite(start) && Number.isFinite(at) ? Math.max(0, at - start) : 0;
        if (typeof item.user_query === "string" && item.user_query.trim()) turns.push({ speaker: "CUSTOMER", text: item.user_query.trim(), offsetMs });
        if (typeof item.bot_response === "string" && item.bot_response.trim()) turns.push({ speaker: "EMPLOYEE", text: item.bot_response.trim(), offsetMs });
      }
      const summary = typeof report.summary === "string" ? report.summary : "";
      return turns.length > 0 || summary ? { summary, turns } : null;
    },

    async placeCall({ to, statusCallbackUrl, fromNumberId, context }) {
      const callId = new URL(statusCallbackUrl).searchParams.get("callId") ?? "";
      const webhook = new URL(statusCallbackUrl);
      webhook.searchParams.set("sig", sign(callId));
      const result = await request<{ success?: boolean; requestId?: number }>("POST", "/calls/dispatch", {
        agent_id: agentId,
        to_number: to,
        ...(fromNumberId && { from_number_id: Number(fromNumberId) }),
        call_context: context ?? {},
        metadata: { callId },
        __post_call_actions: {
          webhook: {
            enabled: true,
            url: webhook.toString(),
            include: ["summary", "fullConversation", "extracted_variables", "sentiment"],
            trigger_call_statuses: Object.keys(STATUS),
          },
        },
      });
      if (result.success === false) throw new TelephonyError("OmniDimension refused to dispatch the call");
      return { providerCallId: result.requestId !== undefined ? `omnidimension:${result.requestId}` : null };
    },

    // shortcut: no documented hang-up endpoint; the agent ends its own calls
    endCall: async () => {},
    transferCall: unsupported("live transfers"),

    async configureNumber(number) {
      const { phone_numbers = [] } = await request<{ phone_numbers?: { id: number; phone_number: string }[] }>("GET", "/phone_number/list?pagesize=150");
      const found = phone_numbers.find((n) => n.phone_number === number);
      if (!found) throw new TelephonyError(`${number} is not a phone number of this OmniDimension account`);
      return { providerNumberId: String(found.id) };
    },

    parseMedia: () => ({ type: "other" }),
    audioMessage: unsupported("media streams"),
    markMessage: unsupported("media streams"),
    clearMessage: unsupported("media streams"),
  };
}
