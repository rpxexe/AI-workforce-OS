// Phase 14: every outside service the platform talks to, described once. The catalog below is the registry's metadata
// (the API adds the adapters); the dashboard renders connection forms from it, the API validates against it.
import { z } from "zod";
import { modelInfoSchema } from "./ai.ts";

export const PROVIDER_TYPES = ["llm", "stt", "tts", "telephony", "messaging", "email", "storage"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const PROVIDER_TYPE_LABELS: Record<ProviderType, string> = {
  llm: "Language models",
  stt: "Speech to text",
  tts: "Text to speech",
  telephony: "Telephony",
  messaging: "Messaging",
  email: "Email",
  storage: "Storage",
};

/** Types an employee or a workflow can point at another connection than the organization's default. */
export const OVERRIDABLE_TYPES = ["llm", "stt", "tts", "email"] as const satisfies readonly ProviderType[];
export type OverridableType = (typeof OVERRIDABLE_TYPES)[number];

export type ProviderField = {
  key: string;
  label: string;
  /** secret: sealed, write-only. models: the LLM model list (context, prices). */
  kind: "secret" | "text" | "url" | "number" | "select" | "models";
  required: boolean;
  placeholder?: string;
  help?: string;
  options?: string[];
  default?: string | number;
};

export type ProviderMeta = {
  id: string;
  type: ProviderType;
  name: string;
  /** supported: a working adapter and configuration path. coming_soon: listed, cannot be connected. */
  status: "supported" | "coming_soon";
  /** e.g. chat, tools, live (phone-call transcription), transcribe (recorded files), synthesize, calls, whatsapp, send, store. */
  capabilities: string[];
  credentialFields: ProviderField[];
  configFields: ProviderField[];
  /** Models (or voices) known without asking the provider; Test Connection lists the account's own. */
  models: string[];
  docsUrl: string;
  /** Limits and assumptions an admin should know. */
  notes?: string;
};

const secret = (key: string, label: string, required = true, help?: string): ProviderField => ({ key, label, kind: "secret", required, help });
const text = (key: string, label: string, required = false, extra: Partial<ProviderField> = {}): ProviderField => ({ key, label, kind: "text", required, ...extra });
const url = (key: string, label: string, help?: string): ProviderField => ({ key, label, kind: "url", required: true, placeholder: "https://", help });
const apiKey = secret("apiKey", "API key");
const optionalKey = secret("apiKey", "API key", false, "Leave empty if the server needs none");
const from = text("from", "From address", true, { placeholder: "Support <support@example.com>" });
const llmConfig = (extra: ProviderField[] = []): ProviderField[] => [
  ...extra,
  text("defaultModel", "Default model", false, { help: "Used when this is the organization's default and no model policy applies" }),
  { key: "models", label: "Model details", kind: "models", required: false, help: "Context size and prices the router cannot look up" },
];
const llm = (id: string, name: string, docsUrl: string, models: string[] = [], extra: Partial<ProviderMeta> = {}): ProviderMeta => ({
  id,
  type: "llm",
  name,
  status: "supported",
  capabilities: ["chat", "streaming", "tools"],
  credentialFields: [apiKey],
  configFields: llmConfig(),
  models,
  docsUrl,
  ...extra,
});
const soon = (id: string, type: ProviderType, name: string, docsUrl: string, notes: string): ProviderMeta => ({
  id,
  type,
  name,
  status: "coming_soon",
  capabilities: [],
  credentialFields: [],
  configFields: [],
  models: [],
  docsUrl,
  notes,
});
const s3Keys = [secret("accessKeyId", "Access key ID"), secret("secretAccessKey", "Secret access key")];
const speechKey = [apiKey];
const region = (example: string) => text("region", "Region", true, { placeholder: example });

export const PROVIDER_CATALOG: ProviderMeta[] = [
  // ---- Language models (Phase 13's kinds keep their ids) ----
  llm("openai", "OpenAI", "https://platform.openai.com/docs/api-reference/chat"),
  llm("anthropic", "Anthropic", "https://docs.claude.com/en/api/overview", ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"]),
  llm("gemini", "Google Gemini", "https://ai.google.dev/gemini-api/docs/openai"),
  llm("openrouter", "OpenRouter", "https://openrouter.ai/docs", ["openrouter/auto"]),
  llm("groq", "Groq", "https://console.groq.com/docs/openai"),
  llm("mistral", "Mistral", "https://docs.mistral.ai/api/"),
  llm("deepseek", "DeepSeek", "https://api-docs.deepseek.com/"),
  llm("xai", "xAI", "https://docs.x.ai/docs/api-reference"),
  llm("together", "Together AI", "https://docs.together.ai/docs/openai-api-compatibility"),
  llm("fireworks", "Fireworks AI", "https://docs.fireworks.ai/tools-sdks/openai-compatibility"),
  llm("huggingface", "Hugging Face", "https://huggingface.co/docs/inference-providers/index", [], {
    notes: "Inference Providers router (OpenAI-compatible). Model ids look like vendor/model, optionally :provider.",
  }),
  llm("openai_compatible", "Custom (OpenAI-compatible)", "https://platform.openai.com/docs/api-reference/chat", [], {
    configFields: llmConfig([url("baseUrl", "Base URL", "Public https only, e.g. https://llm.example.com/v1")]),
    notes: "The server calls it, so it must be a public https address (no localhost or private networks).",
  }),

  // ---- Speech to text ----
  {
    id: "deepgram",
    type: "stt",
    name: "Deepgram",
    status: "supported",
    capabilities: ["live", "transcribe"],
    credentialFields: speechKey,
    configFields: [text("model", "Model", false, { default: "nova-3" })],
    models: ["nova-3", "nova-2"],
    docsUrl: "https://developers.deepgram.com/reference/speech-to-text-api/listen-streaming",
  },
  {
    id: "assemblyai",
    type: "stt",
    name: "AssemblyAI",
    status: "supported",
    capabilities: ["live", "transcribe"],
    credentialFields: speechKey,
    configFields: [],
    models: ["universal-streaming"],
    docsUrl: "https://www.assemblyai.com/docs/speech-to-text/universal-streaming",
  },
  {
    id: "openai_whisper",
    type: "stt",
    name: "OpenAI Whisper",
    status: "supported",
    capabilities: ["transcribe"],
    credentialFields: speechKey,
    configFields: [text("model", "Model", false, { default: "whisper-1" })],
    models: ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"],
    docsUrl: "https://platform.openai.com/docs/api-reference/audio/createTranscription",
    notes: "Recorded audio only (voice notes); phone calls need a live provider.",
  },
  {
    id: "google_stt",
    type: "stt",
    name: "Google Speech-to-Text",
    status: "supported",
    capabilities: ["transcribe"],
    credentialFields: [secret("apiKey", "API key", true, "An API key restricted to the Speech-to-Text API")],
    configFields: [text("model", "Model", false, { default: "default" })],
    models: ["default", "latest_short", "latest_long"],
    docsUrl: "https://cloud.google.com/speech-to-text/docs/reference/rest/v1/speech/recognize",
    notes: "Recorded audio only. Live phone-call transcription needs Google's gRPC streaming API: coming soon.",
  },
  {
    id: "azure_speech",
    type: "stt",
    name: "Azure Speech",
    status: "supported",
    capabilities: ["transcribe"],
    credentialFields: speechKey,
    configFields: [region("eastus")],
    models: [],
    docsUrl: "https://learn.microsoft.com/azure/ai-services/speech-service/rest-speech-to-text-short",
    notes: "Recorded audio up to 60 seconds. Live phone-call transcription needs Azure's Speech SDK: coming soon.",
  },
  {
    id: "custom_stt",
    type: "stt",
    name: "Custom STT (OpenAI-compatible)",
    status: "supported",
    capabilities: ["transcribe"],
    credentialFields: [optionalKey],
    configFields: [url("baseUrl", "Base URL", "Serves POST /audio/transcriptions, e.g. https://stt.example.com/v1"), text("model", "Model", false, { default: "whisper-1" })],
    models: [],
    docsUrl: "https://platform.openai.com/docs/api-reference/audio/createTranscription",
    notes: "Public https only.",
  },

  // ---- Text to speech ----
  {
    id: "elevenlabs",
    type: "tts",
    name: "ElevenLabs",
    status: "supported",
    capabilities: ["synthesize", "streaming"],
    credentialFields: speechKey,
    configFields: [text("voice", "Voice ID", false, { help: "Empty: the account's first default voice" }), text("model", "Model", false, { default: "eleven_flash_v2_5" })],
    models: ["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2"],
    docsUrl: "https://elevenlabs.io/docs/api-reference/text-to-speech/stream",
  },
  {
    id: "openai_tts",
    type: "tts",
    name: "OpenAI TTS",
    status: "supported",
    capabilities: ["synthesize", "streaming"],
    credentialFields: speechKey,
    configFields: [text("voice", "Voice", false, { default: "alloy" }), text("model", "Model", false, { default: "gpt-4o-mini-tts" })],
    models: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"],
    docsUrl: "https://platform.openai.com/docs/api-reference/audio/createSpeech",
  },
  {
    id: "google_tts",
    type: "tts",
    name: "Google Cloud TTS",
    status: "supported",
    capabilities: ["synthesize"],
    credentialFields: [secret("apiKey", "API key", true, "An API key restricted to the Text-to-Speech API")],
    configFields: [text("voice", "Voice name", false, { placeholder: "en-US-Neural2-F", help: "Empty: Google's default for the language" })],
    models: [],
    docsUrl: "https://cloud.google.com/text-to-speech/docs/reference/rest/v1/text/synthesize",
  },
  {
    id: "azure_speech",
    type: "tts",
    name: "Azure Speech",
    status: "supported",
    capabilities: ["synthesize", "streaming"],
    credentialFields: speechKey,
    configFields: [region("eastus"), text("voice", "Voice name", false, { default: "en-US-AvaMultilingualNeural" })],
    models: [],
    docsUrl: "https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech",
  },
  {
    id: "cartesia",
    type: "tts",
    name: "Cartesia",
    status: "supported",
    capabilities: ["synthesize", "streaming"],
    credentialFields: speechKey,
    configFields: [text("voice", "Voice ID", true), text("model", "Model", false, { default: "sonic-2" })],
    models: ["sonic-2"],
    docsUrl: "https://docs.cartesia.ai/api-reference/tts/bytes",
  },
  {
    id: "playht",
    type: "tts",
    name: "PlayHT",
    status: "supported",
    capabilities: ["synthesize", "streaming"],
    credentialFields: [apiKey, secret("userId", "User ID")],
    configFields: [text("voice", "Voice", true, { help: "The voice's manifest URL or id" }), text("model", "Voice engine", false, { default: "Play3.0-mini" })],
    models: ["Play3.0-mini", "PlayDialog"],
    docsUrl: "https://docs.play.ht/reference/api-generate-tts-audio-stream",
    notes: "Mu-law output assumed from the v2 docs; not yet tried against the real API.",
  },
  {
    id: "kokoro",
    type: "tts",
    name: "Kokoro (self-hosted)",
    status: "supported",
    capabilities: ["synthesize", "streaming"],
    credentialFields: [optionalKey],
    configFields: [url("baseUrl", "Base URL", "Kokoro-FastAPI's OpenAI-compatible address, e.g. https://kokoro.example.com/v1"), text("voice", "Voice", false, { default: "af_bella" }), text("model", "Model", false, { default: "kokoro" })],
    models: ["kokoro"],
    docsUrl: "https://github.com/remsky/Kokoro-FastAPI",
    notes: "Must be reachable at a public https address.",
  },
  {
    id: "voicestudio",
    type: "tts",
    name: "VoiceStudio",
    status: "supported",
    capabilities: ["synthesize"],
    credentialFields: [secret("apiKey", "API key", false, "OMNIVOICE_API_KEY on the VoiceStudio machine (needed for remote access)")],
    configFields: [url("baseUrl", "Base URL", "VoiceStudio's API with remote access on, behind TLS, e.g. https://voice.example.com/v1"), text("voice", "Voice profile", false, { default: "default" }), text("model", "Engine", false, { default: "omnivoice" })],
    models: ["omnivoice", "voxcpm2", "cosyvoice", "kittentts"],
    docsUrl: "https://voicestudio.sh/docs/quickstart",
    notes: "VoiceStudio runs on your machine (port 3900). The platform reaches it only at a public https address (e.g. a tunnel with TLS), never localhost.",
  },
  {
    id: "custom_tts",
    type: "tts",
    name: "Custom TTS (OpenAI-compatible)",
    status: "supported",
    capabilities: ["synthesize", "streaming"],
    credentialFields: [optionalKey],
    configFields: [url("baseUrl", "Base URL", "Serves POST /audio/speech returning WAV"), text("voice", "Voice", false, { default: "alloy" }), text("model", "Model", false, { default: "tts-1" })],
    models: [],
    docsUrl: "https://platform.openai.com/docs/api-reference/audio/createSpeech",
    notes: "Public https only. The answer must be 16-bit PCM WAV (any sample rate).",
  },

  // ---- Telephony ----
  {
    id: "twilio",
    type: "telephony",
    name: "Twilio",
    status: "supported",
    capabilities: ["calls", "inbound", "outbound", "transfer", "media_stream"],
    credentialFields: [secret("accountSid", "Account SID"), secret("authToken", "Auth token")],
    configFields: [],
    models: [],
    docsUrl: "https://www.twilio.com/docs/voice/media-streams",
  },
  {
    id: "telnyx",
    type: "telephony",
    name: "Telnyx",
    status: "supported",
    capabilities: ["calls", "inbound", "outbound", "transfer", "media_stream"],
    credentialFields: [apiKey],
    configFields: [text("applicationId", "TeXML Application ID", true), text("accountSid", "Account SID", false, { help: "Empty: looked up from the API key" })],
    models: [],
    docsUrl: "https://developers.telnyx.com/docs/voice/programmable-voice/texml-setup",
  },
  {
    id: "signalwire",
    type: "telephony",
    name: "SignalWire",
    status: "supported",
    capabilities: ["calls", "inbound", "outbound", "transfer", "media_stream"],
    credentialFields: [secret("projectId", "Project ID"), secret("apiToken", "API token"), secret("signingKey", "Signing key", true, "Your Space's API page; signs webhooks")],
    configFields: [text("space", "Space", true, { placeholder: "example (from example.signalwire.com)" })],
    models: [],
    docsUrl: "https://developer.signalwire.com/compatibility-api/",
    notes: "Through SignalWire's Twilio-compatible (LaML) API. Not yet tried against the real API.",
  },
  {
    id: "omnidimension",
    type: "telephony",
    name: "OmniDimension",
    status: "supported",
    capabilities: ["calls", "outbound"],
    credentialFields: [apiKey],
    configFields: [text("agentId", "Agent ID", true, { help: "The OmniDimension agent that talks on these calls (its id in OmniDimension's dashboard or API)" })],
    models: [],
    docsUrl: "https://docs.omnidim.io/docs/api-reference/calls/dispatchCall",
    notes:
      "OmniDimension's own agent runs the call (its speech, model and voice), so the employee's instructions, knowledge and tools do not apply during it. The transcript and summary come back to the conversation and customer memory after the call. Outbound only, no live transfer. Not yet tried against the real API.",
  },
  soon("plivo", "telephony", "Plivo", "https://www.plivo.com/docs/voice/", "Plivo's audio stream uses its own message format; coming soon."),
  soon("vonage", "telephony", "Vonage", "https://developer.vonage.com/en/voice/voice-api/overview", "Vonage streams 16 kHz linear PCM over its own WebSocket protocol; coming soon."),
  soon("sip", "telephony", "SIP / custom", "https://datatracker.ietf.org/doc/html/rfc3261", "Direct SIP trunks need a media server (RTP); coming soon."),

  // ---- Messaging ----
  {
    id: "meta_whatsapp",
    type: "messaging",
    name: "WhatsApp Cloud API (Meta)",
    status: "supported",
    capabilities: ["whatsapp", "media", "read_receipts"],
    credentialFields: [secret("accessToken", "Access token"), secret("appSecret", "App secret"), secret("verifyToken", "Webhook verify token")],
    configFields: [text("graphVersion", "Graph API version", false, { default: "v26.0" })],
    models: [],
    docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",
  },
  {
    id: "twilio_whatsapp",
    type: "messaging",
    name: "Twilio WhatsApp",
    status: "supported",
    capabilities: ["whatsapp", "media"],
    credentialFields: [secret("accountSid", "Account SID"), secret("authToken", "Auth token")],
    configFields: [],
    models: [],
    docsUrl: "https://www.twilio.com/docs/whatsapp/api",
  },
  {
    id: "telnyx_whatsapp",
    type: "messaging",
    name: "Telnyx WhatsApp",
    status: "supported",
    capabilities: ["whatsapp", "media"],
    credentialFields: [apiKey, secret("publicKey", "Public key", true, "Verifies webhook signatures (Ed25519)")],
    configFields: [],
    models: [],
    docsUrl: "https://developers.telnyx.com/docs/messaging/whatsapp",
  },

  // ---- Email ----
  {
    id: "resend",
    type: "email",
    name: "Resend",
    status: "supported",
    capabilities: ["send", "receive"],
    credentialFields: [apiKey, secret("webhookSecret", "Webhook signing secret", false, "Needed to receive email")],
    configFields: [from],
    models: [],
    docsUrl: "https://resend.com/docs/api-reference/emails/send-email",
  },
  {
    id: "sendgrid",
    type: "email",
    name: "SendGrid",
    status: "supported",
    capabilities: ["send"],
    credentialFields: [apiKey],
    configFields: [from],
    models: [],
    docsUrl: "https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send",
  },
  {
    id: "ses",
    type: "email",
    name: "Amazon SES",
    status: "supported",
    capabilities: ["send"],
    credentialFields: s3Keys,
    configFields: [region("us-east-1"), from],
    models: [],
    docsUrl: "https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html",
  },
  {
    id: "smtp",
    type: "email",
    name: "SMTP",
    status: "supported",
    capabilities: ["send"],
    credentialFields: [secret("username", "Username"), secret("password", "Password")],
    configFields: [
      text("host", "Host", true, { placeholder: "smtp.example.com" }),
      { key: "port", label: "Port", kind: "number", required: false, default: 587 },
      { key: "security", label: "Security", kind: "select", required: false, options: ["starttls", "tls"], default: "starttls" },
      from,
    ],
    models: [],
    docsUrl: "https://nodemailer.com/smtp/",
    notes: "Public hosts only; the connection always uses TLS (STARTTLS on 587, TLS on 465).",
  },

  // ---- Storage ----
  {
    id: "r2",
    type: "storage",
    name: "Cloudflare R2",
    status: "supported",
    capabilities: ["store"],
    credentialFields: s3Keys,
    configFields: [text("accountId", "Account ID", true), text("bucket", "Bucket", true)],
    models: [],
    docsUrl: "https://developers.cloudflare.com/r2/api/s3/api/",
  },
  {
    id: "s3",
    type: "storage",
    name: "AWS S3",
    status: "supported",
    capabilities: ["store"],
    credentialFields: s3Keys,
    configFields: [region("us-east-1"), text("bucket", "Bucket", true)],
    models: [],
    docsUrl: "https://docs.aws.amazon.com/AmazonS3/latest/API/Welcome.html",
  },
  {
    id: "gcs",
    type: "storage",
    name: "Google Cloud Storage",
    status: "supported",
    capabilities: ["store"],
    credentialFields: [secret("accessKeyId", "HMAC access ID"), secret("secretAccessKey", "HMAC secret")],
    configFields: [text("bucket", "Bucket", true)],
    models: [],
    docsUrl: "https://cloud.google.com/storage/docs/interoperability",
    notes: "Through GCS's S3-compatible XML API with an HMAC key.",
  },
  {
    id: "azure_blob",
    type: "storage",
    name: "Azure Blob Storage",
    status: "supported",
    capabilities: ["store"],
    credentialFields: [secret("sasToken", "Container SAS token", true, "Read, add, create, write, delete and list on the container")],
    configFields: [text("account", "Storage account", true), text("container", "Container", true)],
    models: [],
    docsUrl: "https://learn.microsoft.com/rest/api/storageservices/put-blob",
  },
  {
    id: "s3_compatible",
    type: "storage",
    name: "S3-compatible",
    status: "supported",
    capabilities: ["store"],
    credentialFields: s3Keys,
    configFields: [url("endpoint", "Endpoint", "e.g. https://minio.example.com"), text("region", "Region", false, { default: "us-east-1" }), text("bucket", "Bucket", true)],
    models: [],
    docsUrl: "https://docs.aws.amazon.com/AmazonS3/latest/API/Welcome.html",
    notes: "Path-style requests. Public https only.",
  },
];

export const providerMeta = (type: string, id: string) => PROVIDER_CATALOG.find((p) => p.type === type && p.id === id);

// ---- Connections ----

export const CONNECTION_STATUSES = ["active", "disabled"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export type ProviderConnectionInfo = {
  id: string;
  providerType: ProviderType;
  providerId: string;
  displayName: string;
  configuration: Record<string, unknown>;
  /** Last 4 characters of each stored secret, by field: the secrets themselves never leave the server. */
  credentialHints: Record<string, string>;
  status: ConnectionStatus;
  isDefault: boolean;
  lastTestedAt: string | null;
  lastTestStatus: "ok" | "failed" | null;
  lastTestError: string | null;
  rotatedAt: string | null;
  /** Telephony and messaging: the addresses to enter in the provider's console (admins only). */
  webhookUrls: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
};

const values = z.record(z.string().max(100), z.unknown());
const secrets = z.record(z.string().max(100), z.string().trim().max(4000));
const displayName = z.string().trim().min(1, "Name is required").max(80);

/** Body of POST /providers/connections. Fields are checked against the catalog entry (`checkFields`). */
export const createConnectionSchema = z.object({
  providerType: z.enum(PROVIDER_TYPES),
  providerId: z.string().min(1).max(60),
  displayName,
  credentials: secrets.default({}),
  configuration: values.default({}),
});
export type CreateConnection = z.input<typeof createConnectionSchema>;

/** Body of PATCH /providers/connections/:id: name and settings; secrets change only by rotation. */
export const updateConnectionSchema = z.object({ displayName: displayName.optional(), configuration: values.optional() });
/** Body of POST /providers/connections/:id/rotate: every secret field again. */
export const rotateCredentialsSchema = z.object({ credentials: secrets });

const isUrl = (v: string) => {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};

/** Problems with a connection's fields against its catalog entry, as `issues` paths the form understands. */
export function checkFields(meta: ProviderMeta, credentials: Record<string, string> | null, configuration: Record<string, unknown>) {
  const issues: { path: string; message: string }[] = [];
  if (credentials) {
    for (const f of meta.credentialFields) if (f.required && !credentials[f.key]?.trim()) issues.push({ path: `credentials.${f.key}`, message: `${f.label} is required` });
    for (const key of Object.keys(credentials))
      if (!meta.credentialFields.some((f) => f.key === key)) issues.push({ path: `credentials.${key}`, message: "Unknown field" });
  }
  for (const f of meta.configFields) {
    const v = configuration[f.key];
    const empty = v === undefined || v === null || v === "";
    if (empty) {
      if (f.required) issues.push({ path: `configuration.${f.key}`, message: `${f.label} is required` });
      continue;
    }
    if (f.kind === "url" && (typeof v !== "string" || !isUrl(v))) issues.push({ path: `configuration.${f.key}`, message: "Enter a full https:// address" });
    if ((f.kind === "text" || f.kind === "select") && (typeof v !== "string" || v.length > 500)) issues.push({ path: `configuration.${f.key}`, message: `${f.label} must be text` });
    if (f.kind === "select" && f.options && !f.options.includes(v as string)) issues.push({ path: `configuration.${f.key}`, message: `Choose one of ${f.options.join(", ")}` });
    if (f.kind === "number" && (typeof v !== "number" || !Number.isFinite(v))) issues.push({ path: `configuration.${f.key}`, message: `${f.label} must be a number` });
    if (f.kind === "models" && !z.array(modelInfoSchema).max(50).safeParse(v).success) issues.push({ path: `configuration.${f.key}`, message: "Invalid model list" });
  }
  for (const key of Object.keys(configuration))
    if (!meta.configFields.some((f) => f.key === key) && !["costPerUnit"].includes(key)) issues.push({ path: `configuration.${key}`, message: "Unknown field" });
  return issues;
}

export type TestConnectionResult = {
  ok: boolean;
  auth: "ok" | "failed" | "unknown";
  config: "ok" | "invalid";
  capabilities: string[];
  latencyMs: number;
  /** The provider's error, with every secret removed. */
  error: string | null;
  /** Models or voices the account offers, when the provider lists them. */
  models?: string[];
  testedAt: string;
};

// ---- Overrides (resolution: workflow > employee > organization default > platform) ----

const overrideTarget = z.object({ connectionId: z.string().min(1).nullable() });
/** An employee's or a workflow's own providers. null connection: the platform's. Missing: inherit. */
export const providerOverridesSchema = z.object({
  llm: overrideTarget.extend({ model: z.string().trim().min(1).max(200) }).optional(),
  stt: overrideTarget.optional(),
  tts: overrideTarget.extend({ voice: z.string().trim().max(200).optional() }).optional(),
  email: overrideTarget.optional(),
});
export type ProviderOverrides = z.infer<typeof providerOverridesSchema>;

/** Body of GET /providers/settings. */
export type ProviderSettings = {
  connections: ProviderConnectionInfo[];
  /** What the server's .env provides per type when an organization has no connection. */
  platform: Record<ProviderType, string[]>;
  canStoreKeys: boolean;
};

export type ProviderMetric = {
  providerType: string;
  provider: string;
  requests: number;
  failures: number;
  timeouts: number;
  fallbacks: number;
  avgLatencyMs: number;
  costUsd: number;
  characters: number;
  seconds: number;
};

export type ProviderAuditEntry = {
  id: string;
  connectionId: string | null;
  providerType: string;
  providerId: string;
  action: string;
  actorId: string;
  detail: Record<string, unknown>;
  createdAt: string;
};

// ---- Errors ----

/** How a provider call failed. Only some kinds are worth trying another provider for. */
export type ProviderErrorKind = "config" | "auth" | "billing" | "rate_limit" | "unavailable" | "invalid" | "refused" | "timeout";

/** Thrown by Phase 14 adapters, so callers never see a vendor's error types. */
export class ProviderError extends Error {
  kind: ProviderErrorKind;
  constructor(kind: ProviderErrorKind, message: string, cause?: unknown) {
    super(message, { cause });
    this.kind = kind;
  }
}

/** The kind an HTTP status means. */
export const kindOfStatus = (status: number): ProviderErrorKind =>
  status === 401 || status === 403 ? "auth" : status === 402 ? "billing" : status === 429 ? "rate_limit" : status === 404 ? "config" : status >= 500 ? "unavailable" : "invalid";

/** A locale for providers that want one (en -> en-US); a full locale passes through. */
const LOCALES: Record<string, string> = {
  en: "en-US", es: "es-ES", fr: "fr-FR", de: "de-DE", it: "it-IT", pt: "pt-BR", nl: "nl-NL", hi: "hi-IN", ja: "ja-JP", ko: "ko-KR",
  zh: "zh-CN", ar: "ar-SA", ru: "ru-RU", pl: "pl-PL", tr: "tr-TR", sv: "sv-SE", da: "da-DK", fi: "fi-FI", nb: "nb-NO", id: "id-ID",
  "hi-en": "hi-IN",
};
export const localeOf = (language: string) => LOCALES[language] ?? (language.includes("-") ? language : `${language}-${language.toUpperCase()}`);
/** The ISO 639-1 code for providers that take one (en-IN -> en; hi-en, Hinglish, -> hi). */
export const isoOf = (language: string) => language.split("-")[0]!;
/** Hinglish: providers that can listen for several languages at once should; the others are told Hindi or guess. */
export const isMixedLanguage = (language: string) => language === "hi-en";
