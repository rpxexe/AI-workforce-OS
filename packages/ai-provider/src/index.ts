// The one place the application talks to a language model. Everything else depends on the
// `AIProvider` interface; `createRouter` (router.ts) chooses among providers per request.
// Adding a provider means one entry in `VENDORS` (plus a file if it does not speak the OpenAI
// chat-completions protocol).
import { anthropicProvider } from "./anthropic.ts";
import { openAICompatibleEmbedder, openAICompatibleProvider, type Vendor } from "./openai-compatible.ts";
import { AIProviderError, type AIProvider, type EmbeddingProvider, type ProviderSettings } from "./types.ts";

export * from "./types.ts";
export * from "./catalog.ts";
export * from "./router.ts";

type Env = Record<string, string | undefined>;

const OPENROUTER = {
  name: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  keyVar: "OPENROUTER_API_KEY",
  baseUrlVar: "OPENROUTER_BASE_URL",
  // OpenRouter picks a model per request; set AI_MODEL to pin one (e.g. "vendor/model").
  defaultModel: "openrouter/auto",
  defaultEmbeddingModel: "openai/text-embedding-3-small",
};

const openAIStyle = (name: string, baseUrl: string, keyVar = `${name.toUpperCase()}_API_KEY`): Vendor => ({
  name,
  baseUrl,
  keyVar,
  baseUrlVar: `${name.toUpperCase()}_BASE_URL`,
  defaultModel: "",
});

/** Services speaking the OpenAI chat-completions protocol. The env variables hold the platform's own keys. */
const VENDORS: Record<string, Vendor> = {
  openrouter: OPENROUTER,
  openai: {
    name: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyVar: "OPENAI_API_KEY",
    baseUrlVar: "OPENAI_BASE_URL",
    defaultModel: "",
    maxTokensField: "max_completion_tokens",
  },
  gemini: {
    name: "gemini",
    // Gemini's OpenAI-compatible endpoint.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyVar: "GEMINI_API_KEY",
    baseUrlVar: "GEMINI_BASE_URL",
    defaultModel: "",
  },
  // Phase 14: more OpenAI-compatible services. The platform can use them too (AI_PROVIDER=groq and GROQ_API_KEY, ...).
  groq: openAIStyle("groq", "https://api.groq.com/openai/v1"),
  mistral: openAIStyle("mistral", "https://api.mistral.ai/v1"),
  deepseek: openAIStyle("deepseek", "https://api.deepseek.com/v1"),
  xai: openAIStyle("xai", "https://api.x.ai/v1"),
  together: openAIStyle("together", "https://api.together.xyz/v1"),
  fireworks: openAIStyle("fireworks", "https://api.fireworks.ai/inference/v1"),
  huggingface: openAIStyle("huggingface", "https://router.huggingface.co/v1", "HF_TOKEN"),
  openai_compatible: { name: "openai_compatible", baseUrl: "", keyVar: "", baseUrlVar: "", defaultModel: "" },
};

/** The vendors' base URLs, for listing an account's models (Test Connection). */
export const VENDOR_BASE_URLS: Record<string, string> = Object.fromEntries(Object.entries(VENDORS).map(([kind, v]) => [kind, v.baseUrl]));

const PROVIDERS: Record<string, (settings: ProviderSettings, env: Env) => AIProvider> = {
  ...Object.fromEntries(Object.entries(VENDORS).map(([kind, vendor]) => [kind, openAICompatibleProvider(vendor)])),
  anthropic: anthropicProvider,
};

/** The provider kinds `createProvider` builds. */
export const PROVIDER_KINDS = Object.keys(PROVIDERS);

/** A provider of `kind` with explicit settings: an organization's key (BYOAI), or the platform's when `apiKey` is omitted. */
export function createProvider(kind: string, settings: ProviderSettings, env: Env = process.env): AIProvider {
  const create = PROVIDERS[kind];
  if (!create) throw new AIProviderError("config", `Provider "${kind}" is not supported. Use one of: ${PROVIDER_KINDS.join(", ")}`);
  if (kind === "openai_compatible" && !settings.baseUrl) throw new AIProviderError("config", "A custom provider needs a base URL");
  const provider = create(settings, env);
  if (!provider.model) throw new AIProviderError("config", `Name the ${kind} model to use (AI_MODEL for the platform's provider)`);
  return provider;
}

/**
 * Builds the platform's provider named by `AI_PROVIDER` (default `openrouter`). `AI_MODEL` and
 * `AI_MAX_OUTPUT_TOKENS` are optional; each provider reads its own credentials.
 */
export function providerFromEnv(env: Env = process.env): AIProvider {
  const name = env.AI_PROVIDER || "openrouter";
  if (name === "openai_compatible" || !PROVIDERS[name])
    throw new AIProviderError("config", `AI_PROVIDER "${name}" is not supported. Use one of: ${PROVIDER_KINDS.filter((k) => k !== "openai_compatible").join(", ")}`);
  return createProvider(name, { model: env.AI_MODEL || undefined, maxOutputTokens: maxOutputTokensFromEnv(env) }, env);
}

/** `AI_MAX_OUTPUT_TOKENS` (default 16000): the reply cap for every provider, the platform's and organizations' own. */
export function maxOutputTokensFromEnv(env: Env = process.env): number {
  const maxOutputTokens = Number(env.AI_MAX_OUTPUT_TOKENS || 16000);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1)
    throw new AIProviderError("config", "AI_MAX_OUTPUT_TOKENS must be a positive whole number");
  return maxOutputTokens;
}

const EMBEDDERS: Record<string, (model: string | undefined, env: Env) => EmbeddingProvider> = {
  openrouter: openAICompatibleEmbedder(OPENROUTER),
};

/**
 * The size of every stored vector. The database column is `vector(1536)`, so an embedding model
 * must produce exactly this many numbers; changing it means a migration and re-embedding.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/** Builds the embedder named by `EMBEDDING_PROVIDER` (default `openrouter`), model `EMBEDDING_MODEL`. */
export function embeddingProviderFromEnv(env: Env = process.env): EmbeddingProvider {
  const name = env.EMBEDDING_PROVIDER || "openrouter";
  const create = EMBEDDERS[name];
  if (!create)
    throw new AIProviderError(
      "config",
      `EMBEDDING_PROVIDER "${name}" is not supported. Use one of: ${Object.keys(EMBEDDERS).join(", ")}`,
    );
  return create(env.EMBEDDING_MODEL || undefined, env);
}
