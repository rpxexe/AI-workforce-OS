// Model routing and BYOAI: an organization's own provider credentials, a model policy per task (primary model,
// fallbacks, cost and time limits, allowed providers), and usage records of every model call.
import { z } from "zod";

/** Providers an organization can bring a key for. `openai_compatible` is any service speaking OpenAI's chat-completions API. */
export const AI_PROVIDER_KINDS = [
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "groq",
  "mistral",
  "deepseek",
  "xai",
  "together",
  "fireworks",
  "huggingface",
  "openai_compatible",
] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

export const AI_PROVIDER_LABELS: Record<AiProviderKind, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  xai: "xAI",
  together: "Together AI",
  fireworks: "Fireworks AI",
  huggingface: "Hugging Face",
  openai_compatible: "Custom (OpenAI-compatible)",
};

/** What a model call is for. Each can have its own policy; `default` covers tasks without one. */
export const AI_TASKS = ["default", "chat", "voice", "memory", "copilot", "evaluation", "improvement", "workflow"] as const;
export type AiTask = (typeof AI_TASKS)[number];

export const AI_TASK_LABELS: Record<AiTask, string> = {
  default: "Default (every task without its own policy)",
  chat: "Conversations (test chat, web chat, WhatsApp, email, workflow steps, regression replays)",
  voice: "Phone calls",
  memory: "Customer memory extraction",
  copilot: "Agent Copilot",
  evaluation: "Quality graders",
  improvement: "Improvement proposals",
  workflow: "Workflow yes/no conditions",
};

/** ordered: as listed. fastest: by measured latency. cheapest: by estimated cost. Models that just failed go last either way. */
export const ROUTING_STRATEGIES = ["ordered", "fastest", "cheapest"] as const;
export type RoutingStrategy = (typeof ROUTING_STRATEGIES)[number];

/** What the router knows about a model it cannot look up itself. Prices are US dollars per million tokens. */
export const modelInfoSchema = z.object({
  id: z.string().trim().min(1).max(200),
  contextTokens: z.number().int().min(1000).max(10_000_000).nullable().default(null),
  inputPricePerM: z.number().min(0).max(1000).nullable().default(null),
  outputPricePerM: z.number().min(0).max(1000).nullable().default(null),
  tools: z.boolean().default(true),
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;

const credentialFields = {
  name: z.string().trim().min(1, "Name is required").max(80),
  kind: z.enum(AI_PROVIDER_KINDS),
  baseUrl: z
    .string()
    .trim()
    .url("Enter a full https:// address")
    .refine((u) => u.startsWith("https://"), "Only https:// addresses are allowed")
    .nullable()
    .default(null),
  models: z.array(modelInfoSchema).max(50).default([]),
};
const needsBaseUrl = (c: { kind: AiProviderKind; baseUrl: string | null }) => (c.kind === "openai_compatible") === (c.baseUrl !== null);
const baseUrlIssue = { message: "A base URL is required for custom providers, and only for them", path: ["baseUrl"] };

/** Body of POST /ai/credentials. The key is write-only: no response ever contains it. */
export const credentialSchema = z
  .object({ ...credentialFields, apiKey: z.string().trim().min(8, "Enter the API key").max(1000) })
  .refine(needsBaseUrl, baseUrlIssue);
/** Body of PUT /ai/credentials/:id. A blank key keeps the stored one. */
export const credentialUpdateSchema = z
  .object({ ...credentialFields, apiKey: z.string().trim().max(1000).default("") })
  .refine(needsBaseUrl, baseUrlIssue)
  .refine((c) => c.apiKey === "" || c.apiKey.length >= 8, { message: "Enter the API key", path: ["apiKey"] });
export type CredentialInput = z.input<typeof credentialSchema>;

/** A model to call: through one of the organization's credentials, or the platform's own provider (credentialId null). */
export const modelTargetSchema = z.object({
  credentialId: z.string().min(1).nullable(),
  model: z.string().trim().min(1, "Enter a model id").max(200),
});
export type ModelTarget = z.infer<typeof modelTargetSchema>;

/** Body of PUT /ai/policies/:task. */
export const modelPolicySchema = z.object({
  primary: modelTargetSchema,
  /** Tried in order when the primary fails before answering. Each model is tried at most once per request. */
  fallbacks: z.array(modelTargetSchema).max(3).default([]),
  /** Estimated cost ceiling per model call, in US dollars. Models without a known price are skipped when set. */
  maxCostUsd: z.number().positive().max(100).nullable().default(null),
  /** How long one model may take before the next one is tried. */
  timeoutMs: z.number().int().min(1000).max(300_000).nullable().default(null),
  /** Empty: any provider. */
  allowedProviders: z.array(z.enum(AI_PROVIDER_KINDS)).default([]),
  strategy: z.enum(ROUTING_STRATEGIES).default("ordered"),
});
export type ModelPolicyInput = z.input<typeof modelPolicySchema>;
export type ModelPolicy = z.infer<typeof modelPolicySchema>;

export type AiCredential = {
  id: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string | null;
  /** The key's last 4 characters, to tell keys apart. */
  keyHint: string;
  models: ModelInfo[];
  createdAt: string;
  updatedAt: string;
};

export type AiPolicy = ModelPolicy & { task: AiTask; updatedAt: string };

/** Body of GET /ai/settings. */
export type AiSettings = {
  /** The provider and model the platform uses when an organization has no policy (from the server's .env). */
  platform: { provider: string; model: string };
  credentials: AiCredential[];
  policies: AiPolicy[];
  /** Whether the server can store keys (AI_CREDENTIALS_KEY is set). */
  canStoreKeys: boolean;
};

export type AiUsageRow = {
  id: string;
  task: string;
  requestId: string;
  attempt: number;
  provider: string;
  model: string;
  credentialId: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
  success: boolean;
  errorKind: string | null;
  error: string | null;
  createdAt: string;
};

export type AiUsageGroup = {
  provider: string;
  model: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  avgLatencyMs: number;
};

/** Body of GET /ai/usage. A call is one attempt at one model; a fallback is a later attempt of the same request. */
export type AiUsageSummary = {
  days: number;
  totals: { calls: number; failures: number; fallbacks: number; inputTokens: number; outputTokens: number; costUsd: number; avgLatencyMs: number };
  byModel: AiUsageGroup[];
  byTask: { task: string; calls: number; costUsd: number }[];
  recent: AiUsageRow[];
};
