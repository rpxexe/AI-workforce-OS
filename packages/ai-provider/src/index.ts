// The one place the application talks to a language model. Everything else depends on the
// `AIProvider` interface, so adding a provider means one entry in `PROVIDERS` (plus a file if it
// does not speak the OpenAI chat-completions protocol).
import { anthropicProvider } from "./anthropic.ts";
import { openAICompatibleEmbedder, openAICompatibleProvider } from "./openai-compatible.ts";
import { AIProviderError, type AIProvider, type EmbeddingProvider, type ProviderSettings } from "./types.ts";

export * from "./types.ts";

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

const PROVIDERS: Record<string, (settings: ProviderSettings, env: Env) => AIProvider> = {
  openrouter: openAICompatibleProvider(OPENROUTER),
  anthropic: anthropicProvider,
};

/**
 * Builds the provider named by `AI_PROVIDER` (default `openrouter`). `AI_MODEL` and
 * `AI_MAX_OUTPUT_TOKENS` are optional; each provider reads its own credentials.
 */
export function providerFromEnv(env: Env = process.env): AIProvider {
  const name = env.AI_PROVIDER || "openrouter";
  const create = PROVIDERS[name];
  if (!create)
    throw new AIProviderError("config", `AI_PROVIDER "${name}" is not supported. Use one of: ${Object.keys(PROVIDERS).join(", ")}`);
  const maxOutputTokens = Number(env.AI_MAX_OUTPUT_TOKENS || 16000);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1)
    throw new AIProviderError("config", "AI_MAX_OUTPUT_TOKENS must be a positive whole number");
  return create({ model: env.AI_MODEL || undefined, maxOutputTokens }, env);
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
