// The provider registry: for every supported catalog entry (packages/shared/src/providers.ts), how to build its adapter
// from a connection's opened credentials and settings, and how to test the connection without side effects.
// Adding a provider: a catalog entry (metadata, fields) + an entry here (build, test) + the adapter itself.
import { AIProviderError, createProvider, VENDOR_BASE_URLS, type AIProvider } from "@workforce/ai-provider";
import { metaWhatsApp, resendEmail, telnyxWhatsApp, twilioWhatsApp, type WhatsAppProvider } from "@workforce/channels";
import { kindOfStatus, PROVIDER_CATALOG, ProviderError, type ProviderMeta, type ProviderType, type TestConnectionResult } from "@workforce/shared";
import { assemblyAIProvider, azureTranscriber, deepgramProvider, googleTranscriber, openAITranscriber, type STTProvider } from "@workforce/stt";
import { telnyxProvider, twilioProvider, type TelephonyProvider } from "@workforce/telephony";
import {
  azureTTSProvider,
  cartesiaProvider,
  elevenLabsProvider,
  googleTTSProvider,
  openAISpeechProvider,
  playHTProvider,
  type TTSProvider,
} from "@workforce/tts";
import { sendGridEmail } from "./email/sendgrid.ts";
import { sesEmail } from "./email/ses.ts";
import { smtpEmail } from "./email/smtp.ts";
import { redact } from "./seal.ts";
import { azureBlobStorage } from "./storage/azure-blob.ts";
import { awsS3, gcs, r2, s3Compatible } from "./storage/s3.ts";
import type { EmailSender, ObjectStorage } from "./types.ts";

/** A connection ready to build from: secrets opened, settings as saved, and the networks to use. */
export type Conn = {
  credentials: Record<string, string>;
  configuration: Record<string, unknown>;
  /** For the vendor's own fixed addresses. */
  fetch: typeof fetch;
  /** For addresses the admin typed (custom base URLs, endpoints): public https only, pinned DNS, no redirects. */
  userFetch: typeof fetch;
};

type Products = {
  llm: (c: Conn, settings: { model: string; maxOutputTokens: number }) => AIProvider;
  stt: (c: Conn) => STTProvider;
  tts: (c: Conn, voice?: string) => TTSProvider;
  telephony: (c: Conn) => TelephonyProvider;
  /** `webhookUrl`: where delivery receipts go (this connection's webhook). */
  messaging: (c: Conn, webhookUrl?: string) => WhatsAppProvider;
  email: (c: Conn) => EmailSender;
  storage: (c: Conn) => ObjectStorage;
};

/** What a test learned besides "it worked". Failures are thrown (ProviderError). */
type Probe = { models?: string[]; authUnknown?: boolean };

type Entry<T extends ProviderType> = { build: Products[T]; test: (c: Conn, signal: AbortSignal) => Promise<Probe> };

const str = (c: Conn, key: string, fallback = "") => {
  const v = c.configuration[key];
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
};
const trimSlash = (u: string) => u.replace(/\/+$/, "");

/** GETs a JSON endpoint, throwing ProviderError by status; returns the body. */
async function getJson(http: typeof fetch, url: string, headers: Record<string, string>, signal: AbortSignal, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await http(url, { headers, signal, ...init });
  } catch (err) {
    if (signal.aborted) throw new ProviderError("timeout", "The provider did not answer in time", err);
    throw new ProviderError("unavailable", `Could not reach ${new URL(url).host}: ${(err as Error).cause instanceof Error ? ((err as Error).cause as Error).message : (err as Error).message}`, err);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new ProviderError(kindOfStatus(res.status), `${new URL(url).host} answered ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const ids = (list: unknown, field = "id", max = 200) =>
  Array.isArray(list) ? list.map((m) => (m as Record<string, unknown>)?.[field]).filter((v): v is string => typeof v === "string").slice(0, max) : [];

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

// A tenth of a second of 16 kHz silence as WAV: a transcription costing next to nothing, for providers without a free
// endpoint that proves the key.
const SILENCE_WAV = (() => {
  const samples = 1600;
  const b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write("WAVEfmt ", 8, "latin1");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(samples * 2, 40);
  return b;
})();

// ---- Language models ----

const llmBuild =
  (kind: string): Products["llm"] =>
  (c, { model, maxOutputTokens }) => {
    const custom = kind === "openai_compatible";
    try {
      return createProvider(kind, {
        model,
        maxOutputTokens,
        apiKey: c.credentials.apiKey,
        ...(custom && { baseUrl: trimSlash(str(c, "baseUrl")), fetch: c.userFetch }),
        ...(!custom && c.fetch !== fetch && { fetch: c.fetch }),
      });
    } catch (err) {
      throw err instanceof AIProviderError ? new ProviderError(err.kind === "config" ? "config" : "invalid", err.message, err) : err;
    }
  };

const llmTest =
  (kind: string) =>
  async (c: Conn, signal: AbortSignal): Promise<Probe> => {
    if (kind === "anthropic") {
      const body = (await getJson(c.fetch, "https://api.anthropic.com/v1/models?limit=100", { "x-api-key": c.credentials.apiKey ?? "", "anthropic-version": "2023-06-01" }, signal)) as { data?: unknown };
      return { models: ids(body.data) };
    }
    const custom = kind === "openai_compatible";
    const base = custom ? trimSlash(str(c, "baseUrl")) : VENDOR_BASE_URLS[kind];
    if (!base) throw new ProviderError("config", "No base URL");
    const body = (await getJson(custom ? c.userFetch : c.fetch, `${base}/models`, { authorization: `Bearer ${c.credentials.apiKey ?? ""}` }, signal)) as { data?: unknown; models?: unknown };
    return { models: ids(body.data ?? body.models, "id").concat(ids(body.models, "name")).slice(0, 200) };
  };

const LLM_KINDS = PROVIDER_CATALOG.filter((p) => p.type === "llm").map((p) => p.id);

// ---- Speech ----

const openAIKey = (c: Conn): Record<string, string> => (c.credentials.apiKey ? { authorization: `Bearer ${c.credentials.apiKey}` } : {});
const azureTokenTest = async (c: Conn, signal: AbortSignal): Promise<Probe> => {
  await getJson(c.fetch, `https://${str(c, "region")}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, { "Ocp-Apim-Subscription-Key": c.credentials.apiKey ?? "" }, signal, { method: "POST" });
  return {};
};

const STT: Record<string, Entry<"stt">> = {
  deepgram: {
    build: (c) => deepgramProvider({ apiKey: c.credentials.apiKey ?? "", model: str(c, "model") || undefined, fetch: c.fetch }),
    test: async (c, signal) => {
      await getJson(c.fetch, "https://api.deepgram.com/v1/projects", { authorization: `Token ${c.credentials.apiKey ?? ""}` }, signal);
      return {};
    },
  },
  assemblyai: {
    build: (c) => assemblyAIProvider({ apiKey: c.credentials.apiKey ?? "", fetch: c.fetch }),
    test: async (c, signal) => {
      await getJson(c.fetch, "https://api.assemblyai.com/v2/transcript?limit=1", { authorization: c.credentials.apiKey ?? "" }, signal);
      return {};
    },
  },
  openai_whisper: {
    build: (c) => openAITranscriber({ name: "openai_whisper", baseUrl: "https://api.openai.com/v1", apiKey: c.credentials.apiKey, model: str(c, "model", "whisper-1"), fetch: c.fetch }),
    test: async (c, signal) => {
      const body = (await getJson(c.fetch, "https://api.openai.com/v1/models", openAIKey(c), signal)) as { data?: unknown };
      return { models: ids(body.data).filter((m) => /whisper|transcribe/.test(m)) };
    },
  },
  google_stt: {
    build: (c) => googleTranscriber({ apiKey: c.credentials.apiKey ?? "", model: str(c, "model") || undefined, fetch: c.fetch }),
    test: async (c, signal) => {
      await STT.google_stt!.build(c).transcribe!(SILENCE_WAV, { mimeType: "audio/wav", language: "en", signal });
      return {};
    },
  },
  azure_speech: {
    build: (c) => azureTranscriber({ apiKey: c.credentials.apiKey ?? "", region: str(c, "region"), fetch: c.fetch }),
    test: azureTokenTest,
  },
  custom_stt: {
    build: (c) => openAITranscriber({ name: "custom_stt", baseUrl: trimSlash(str(c, "baseUrl")), apiKey: c.credentials.apiKey || undefined, model: str(c, "model", "whisper-1"), fetch: c.userFetch }),
    test: async (c, signal) => {
      await STT.custom_stt!.build(c).transcribe!(SILENCE_WAV, { mimeType: "audio/wav", language: "en", signal });
      return {};
    },
  },
};

/** Speaks one word and reads the first audio: proves endpoint, key and audio format for servers with no cheaper call. */
const speakTest = (build: Products["tts"]) => async (c: Conn, signal: AbortSignal): Promise<Probe> => {
  for await (const chunk of build(c).synthesize("Hello.", { language: "en", signal })) if (chunk.length > 0) break;
  return {};
};

const TTS: Record<string, Entry<"tts">> = {
  elevenlabs: {
    build: (c, voice) => elevenLabsProvider({ apiKey: c.credentials.apiKey ?? "", voiceId: voice || str(c, "voice") || undefined, model: str(c, "model") || undefined, fetch: c.fetch }),
    test: async (c, signal) => {
      const body = (await getJson(c.fetch, "https://api.elevenlabs.io/v2/voices?page_size=50", { "xi-api-key": c.credentials.apiKey ?? "" }, signal)) as { voices?: unknown };
      return { models: ids(body.voices, "voice_id") };
    },
  },
  openai_tts: {
    build: (c, voice) =>
      openAISpeechProvider({ name: "openai_tts", baseUrl: "https://api.openai.com/v1", apiKey: c.credentials.apiKey, model: str(c, "model", "gpt-4o-mini-tts"), voice: voice || str(c, "voice", "alloy"), fetch: c.fetch }),
    test: async (c, signal) => {
      const body = (await getJson(c.fetch, "https://api.openai.com/v1/models", openAIKey(c), signal)) as { data?: unknown };
      return { models: ids(body.data).filter((m) => /tts/.test(m)) };
    },
  },
  google_tts: {
    build: (c, voice) => googleTTSProvider({ apiKey: c.credentials.apiKey ?? "", voice: voice || str(c, "voice") || undefined, fetch: c.fetch }),
    test: async (c, signal) => {
      // The key travels in the query string here (Google's API-key scheme); errors are built from the status, never the URL.
      const body = (await getJson(c.fetch, `https://texttospeech.googleapis.com/v1/voices?key=${encodeURIComponent(c.credentials.apiKey ?? "")}`, {}, signal)) as { voices?: unknown };
      return { models: ids(body.voices, "name") };
    },
  },
  azure_speech: {
    build: (c, voice) => azureTTSProvider({ apiKey: c.credentials.apiKey ?? "", region: str(c, "region"), voice: voice || str(c, "voice") || undefined, fetch: c.fetch }),
    test: azureTokenTest,
  },
  cartesia: {
    build: (c, voice) => cartesiaProvider({ apiKey: c.credentials.apiKey ?? "", voice: voice || str(c, "voice"), model: str(c, "model") || undefined, fetch: c.fetch }),
    test: async (c, signal) => {
      const body = await getJson(c.fetch, "https://api.cartesia.ai/voices?limit=100", { authorization: `Bearer ${c.credentials.apiKey ?? ""}`, "Cartesia-Version": "2025-04-16" }, signal);
      return { models: ids(Array.isArray(body) ? body : (body as { data?: unknown }).data) };
    },
  },
  playht: {
    build: (c, voice) => playHTProvider({ apiKey: c.credentials.apiKey ?? "", userId: c.credentials.userId ?? "", voice: voice || str(c, "voice"), model: str(c, "model") || undefined, fetch: c.fetch }),
    test: async (c, signal) => {
      const body = await getJson(c.fetch, "https://api.play.ht/api/v2/voices", { AUTHORIZATION: c.credentials.apiKey ?? "", "X-USER-ID": c.credentials.userId ?? "" }, signal);
      return { models: ids(body) };
    },
  },
  kokoro: {
    build: (c, voice) =>
      openAISpeechProvider({ name: "kokoro", baseUrl: trimSlash(str(c, "baseUrl")), apiKey: c.credentials.apiKey || undefined, model: str(c, "model", "kokoro"), voice: voice || str(c, "voice", "af_bella"), fetch: c.userFetch }),
    test: async (c, signal) => {
      const body = (await getJson(c.userFetch, `${trimSlash(str(c, "baseUrl"))}/audio/voices`, openAIKey(c), signal)) as { voices?: unknown };
      return { models: Array.isArray(body.voices) ? body.voices.filter((v): v is string => typeof v === "string").slice(0, 200) : [] };
    },
  },
  voicestudio: {
    build: (c, voice) =>
      openAISpeechProvider({ name: "voicestudio", baseUrl: trimSlash(str(c, "baseUrl")), apiKey: c.credentials.apiKey || undefined, model: str(c, "model", "omnivoice"), voice: voice || str(c, "voice", "default"), fetch: c.userFetch }),
    // GET /v1/audio/voices is VoiceStudio's documented extension; its shape is not documented, so only reachability and the key are judged.
    test: async (c, signal) => {
      const body = await getJson(c.userFetch, `${trimSlash(str(c, "baseUrl"))}/audio/voices`, openAIKey(c), signal);
      const list = Array.isArray(body) ? body : ((body as { voices?: unknown; data?: unknown }).voices ?? (body as { data?: unknown }).data);
      return { models: [...ids(list), ...ids(list, "name")].slice(0, 200) };
    },
  },
  custom_tts: {
    build: (c, voice) =>
      openAISpeechProvider({ name: "custom_tts", baseUrl: trimSlash(str(c, "baseUrl")), apiKey: c.credentials.apiKey || undefined, model: str(c, "model", "tts-1"), voice: voice || str(c, "voice", "alloy"), fetch: c.userFetch }),
    test: (c, signal) => speakTest(TTS.custom_tts!.build)(c, signal),
  },
};

// ---- Telephony and messaging ----

const signalwireApi = (c: Conn) => `https://${str(c, "space").replace(/\.signalwire\.com$/, "")}.signalwire.com/api/laml`;

const TELEPHONY: Record<string, Entry<"telephony">> = {
  twilio: {
    build: (c) => twilioProvider({ accountSid: c.credentials.accountSid ?? "", authToken: c.credentials.authToken ?? "" }, undefined, c.fetch),
    test: async (c, signal) => {
      const sid = c.credentials.accountSid ?? "";
      await getJson(c.fetch, `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, { authorization: basic(sid, c.credentials.authToken ?? "") }, signal);
      return {};
    },
  },
  telnyx: {
    build: (c) => telnyxProvider({ apiKey: c.credentials.apiKey ?? "", applicationId: str(c, "applicationId"), accountSid: str(c, "accountSid") || undefined }, undefined, c.fetch),
    test: async (c, signal) => {
      // Proves the key and that the TeXML application exists in this account.
      await getJson(c.fetch, `https://api.telnyx.com/v2/texml_applications/${encodeURIComponent(str(c, "applicationId"))}`, { authorization: `Bearer ${c.credentials.apiKey ?? ""}` }, signal);
      return {};
    },
  },
  signalwire: {
    build: (c) =>
      twilioProvider(
        { accountSid: c.credentials.projectId ?? "", authToken: c.credentials.apiToken ?? "", signingKey: c.credentials.signingKey, name: "signalwire" },
        signalwireApi(c),
        c.fetch,
      ),
    test: async (c, signal) => {
      const project = c.credentials.projectId ?? "";
      await getJson(c.fetch, `${signalwireApi(c)}/2010-04-01/Accounts/${encodeURIComponent(project)}.json`, { authorization: basic(project, c.credentials.apiToken ?? "") }, signal);
      return {};
    },
  },
};

const MESSAGING: Record<string, Entry<"messaging">> = {
  meta_whatsapp: {
    build: (c) =>
      metaWhatsApp({
        accessToken: c.credentials.accessToken ?? "",
        appSecret: c.credentials.appSecret ?? "",
        verifyToken: c.credentials.verifyToken ?? "",
        version: str(c, "graphVersion") || undefined,
        fetch: c.fetch,
      }),
    test: async (c, signal) => {
      await getJson(c.fetch, `https://graph.facebook.com/${str(c, "graphVersion", "v26.0")}/me`, { authorization: `Bearer ${c.credentials.accessToken ?? ""}` }, signal);
      return {};
    },
  },
  twilio_whatsapp: {
    build: (c, webhookUrl) => twilioWhatsApp({ accountSid: c.credentials.accountSid ?? "", authToken: c.credentials.authToken ?? "", webhookUrl, fetch: c.fetch }),
    test: (c, signal) => TELEPHONY.twilio!.test(c, signal),
  },
  telnyx_whatsapp: {
    build: (c, webhookUrl) => telnyxWhatsApp({ apiKey: c.credentials.apiKey ?? "", publicKey: c.credentials.publicKey ?? "", webhookUrl, fetch: c.fetch }),
    test: async (c, signal) => {
      await getJson(c.fetch, "https://api.telnyx.com/v2/messaging_profiles?page[size]=1", { authorization: `Bearer ${c.credentials.apiKey ?? ""}` }, signal);
      return {};
    },
  },
};

// ---- Email and storage ----

/** Tests through the adapter's own check: a call that proves the credentials without sending or storing anything. */
const checked = (build: (c: Conn) => { check(): Promise<void> }) => async (c: Conn): Promise<Probe> => {
  await build(c).check();
  return {};
};

const EMAIL: Record<string, Entry<"email">> = {
  resend: {
    build: (c) => {
      const provider = resendEmail({ apiKey: c.credentials.apiKey ?? "", webhookSecret: c.credentials.webhookSecret || undefined, fetch: c.fetch });
      return { ...provider, name: "resend", check: async () => {
          await EMAIL.resend!.test(c, AbortSignal.timeout(10_000));
        },
      };
    },
    test: async (c, signal) => {
      try {
        await getJson(c.fetch, "https://api.resend.com/domains", { authorization: `Bearer ${c.credentials.apiKey ?? ""}`, "user-agent": "ai-workforce-os/1.0" }, signal);
        return {};
      } catch (err) {
        // A sending-only key may not list domains: it is valid, just restricted.
        if (err instanceof ProviderError && /restricted_api_key/.test(err.message)) return { authUnknown: false };
        throw err;
      }
    },
  },
  sendgrid: { build: (c) => sendGridEmail({ apiKey: c.credentials.apiKey ?? "", fetch: c.fetch }), test: checked((c) => EMAIL.sendgrid!.build(c)) },
  ses: {
    build: (c) => sesEmail({ accessKeyId: c.credentials.accessKeyId ?? "", secretAccessKey: c.credentials.secretAccessKey ?? "", region: str(c, "region"), fetch: c.fetch }),
    test: checked((c) => EMAIL.ses!.build(c)),
  },
  smtp: {
    build: (c) =>
      smtpEmail({
        host: str(c, "host"),
        port: typeof c.configuration.port === "number" ? c.configuration.port : 587,
        security: str(c, "security", "starttls") === "tls" ? "tls" : "starttls",
        username: c.credentials.username ?? "",
        password: c.credentials.password ?? "",
      }),
    test: checked((c) => EMAIL.smtp!.build(c)),
  },
};

const keys = (c: Conn) => ({ accessKeyId: c.credentials.accessKeyId ?? "", secretAccessKey: c.credentials.secretAccessKey ?? "" });
const STORAGE_BUILD: Record<string, Products["storage"]> = {
  r2: (c) => r2({ accountId: str(c, "accountId"), bucket: str(c, "bucket"), keys: keys(c), fetch: c.fetch }),
  s3: (c) => awsS3({ region: str(c, "region"), bucket: str(c, "bucket"), keys: keys(c), fetch: c.fetch }),
  gcs: (c) => gcs({ bucket: str(c, "bucket"), keys: keys(c), fetch: c.fetch }),
  azure_blob: (c) => azureBlobStorage({ account: str(c, "account"), container: str(c, "container"), sasToken: c.credentials.sasToken ?? "", fetch: c.fetch }),
  s3_compatible: (c) => s3Compatible({ endpoint: trimSlash(str(c, "endpoint")), region: str(c, "region", "us-east-1"), bucket: str(c, "bucket"), keys: keys(c), fetch: c.userFetch }),
};
const STORAGE: Record<string, Entry<"storage">> = Object.fromEntries(Object.entries(STORAGE_BUILD).map(([id, build]) => [id, { build, test: checked(build) }]));

export const REGISTRY: { [T in ProviderType]: Record<string, Entry<T>> } = {
  llm: Object.fromEntries(LLM_KINDS.map((kind) => [kind, { build: llmBuild(kind), test: llmTest(kind) }])),
  stt: STT,
  tts: TTS,
  telephony: TELEPHONY,
  messaging: MESSAGING,
  email: EMAIL,
  storage: STORAGE,
};

/** The registry entry for a supported provider: catalog metadata plus build and test. */
export function registryEntry<T extends ProviderType>(type: T, id: string): (Entry<T> & { meta: ProviderMeta }) | null {
  const meta = PROVIDER_CATALOG.find((p) => p.type === type && p.id === id);
  const entry = REGISTRY[type][id];
  return meta && meta.status === "supported" && entry ? { ...entry, meta } : null;
}

/**
 * Tests a connection: auth status, configuration status, capabilities, latency and the provider's error with every
 * secret removed. Never throws; the result says what failed.
 */
export async function testConnection(type: ProviderType, id: string, conn: Conn, timeoutMs = 15_000): Promise<TestConnectionResult> {
  const started = Date.now();
  const entry = registryEntry(type, id);
  const result = (ok: boolean, auth: TestConnectionResult["auth"], config: TestConnectionResult["config"], error: string | null, models?: string[]): TestConnectionResult => ({
    ok,
    auth,
    config,
    capabilities: entry?.meta.capabilities ?? [],
    latencyMs: Date.now() - started,
    error: error && redact(error, conn.credentials).slice(0, 500),
    ...(models && models.length > 0 && { models }),
    testedAt: new Date().toISOString(),
  });
  if (!entry) return result(false, "unknown", "invalid", `${id} is not a supported ${type} provider`);
  try {
    const probe = await entry.test(conn, AbortSignal.timeout(timeoutMs));
    return result(true, probe.authUnknown ? "unknown" : "ok", "ok", null, probe.models);
  } catch (err) {
    const kind = (err as { kind?: string }).kind ?? "unavailable";
    const raw = err instanceof Error ? err.message : String(err);
    const message = (err as Error).name === "TimeoutError" || kind === "timeout" ? `No answer within ${timeoutMs / 1000} s` : raw;
    if (kind === "auth" || kind === "billing") return result(false, "failed", "ok", message);
    if (kind === "config" || kind === "invalid") return result(false, "unknown", "invalid", message);
    return result(false, "unknown", "ok", message);
  }
}
