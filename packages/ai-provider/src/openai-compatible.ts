import {
  AIProviderError,
  type AIProvider,
  type AIProviderErrorKind,
  type EmbeddingProvider,
  type ProviderSettings,
} from "./types.ts";

type Vendor = {
  name: string;
  baseUrl: string;
  /** Environment variables holding the key and an optional base URL override. */
  keyVar: string;
  baseUrlVar: string;
  defaultModel: string;
};

/** The parts of a streamed chat-completions chunk this provider reads. */
type Chunk = {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string; code?: number | string };
};

const kindOf = (status: number): AIProviderErrorKind =>
  status === 401 || status === 403
    ? "auth"
    : status === 402
      ? "billing"
      : status === 429
        ? "rate_limit"
        : status === 408 || status >= 500
          ? "unavailable"
          : "invalid";

/**
 * Any service that speaks the OpenAI chat-completions streaming protocol: OpenRouter today;
 * OpenAI or a self-hosted endpoint is one more entry in `PROVIDERS`.
 */
export const openAICompatibleProvider =
  (vendor: Vendor) =>
  ({ model = vendor.defaultModel, maxOutputTokens }: ProviderSettings, env: Record<string, string | undefined>): AIProvider => ({
    name: vendor.name,
    model,
    async *stream({ system, messages, signal }) {
      const key = env[vendor.keyVar];
      if (!key) throw new AIProviderError("auth", `${vendor.keyVar} is not set`);

      let res: Response;
      try {
        res = await fetch(`${env[vendor.baseUrlVar] || vendor.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            max_tokens: maxOutputTokens,
            stream: true,
            stream_options: { include_usage: true },
            messages: [{ role: "system", content: system }, ...messages],
          }),
          signal,
        });
      } catch (err) {
        throw new AIProviderError("unavailable", `${vendor.name} could not be reached`, err);
      }
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new AIProviderError(kindOf(res.status), `${vendor.name} answered ${res.status}: ${detail.slice(0, 500)}`);
      }

      let usage: Chunk["usage"];
      let buffer = "";
      try {
        for await (const text of res.body.pipeThrough(new TextDecoderStream())) {
          buffer += text;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            // Other lines are blank separators or ": keep-alive" comments.
            if (!line.startsWith("data: ") || line.startsWith("data: [DONE]")) continue;
            const chunk = JSON.parse(line.slice(6)) as Chunk;
            // Failures after the stream has opened arrive as a chunk, not an HTTP status.
            if (chunk.error)
              throw new AIProviderError(
                typeof chunk.error.code === "number" ? kindOf(chunk.error.code) : "unavailable",
                `${vendor.name} failed mid-reply: ${chunk.error.message ?? "unknown error"}`,
              );
            const choice = chunk.choices?.[0];
            if (choice?.finish_reason === "content_filter")
              throw new AIProviderError("refused", "The reply was blocked by the provider's content filter");
            if (choice?.delta?.content) yield { type: "text", text: choice.delta.content };
            usage = chunk.usage ?? usage;
          }
        }
      } catch (err) {
        if (err instanceof AIProviderError) throw err;
        throw new AIProviderError("unavailable", `${vendor.name} stream broke`, err);
      }
      // shortcut: a service that omits usage is recorded as 0 tokens, estimate them if one does
      yield { type: "done", inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0 };
    },
  });

type EmbeddingResponse = { data?: { index: number; embedding: number[] }[]; error?: { message?: string; code?: number | string } };

/** The same services' `/embeddings` endpoint. */
export const openAICompatibleEmbedder =
  (vendor: Vendor & { defaultEmbeddingModel: string }) =>
  (model: string | undefined, env: Record<string, string | undefined>): EmbeddingProvider => ({
    name: vendor.name,
    model: model ?? vendor.defaultEmbeddingModel,
    async embed(texts, signal) {
      const key = env[vendor.keyVar];
      if (!key) throw new AIProviderError("auth", `${vendor.keyVar} is not set`);
      let res: Response;
      try {
        res = await fetch(`${env[vendor.baseUrlVar] || vendor.baseUrl}/embeddings`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model: this.model, input: texts }),
          signal,
        });
      } catch (err) {
        throw new AIProviderError("unavailable", `${vendor.name} could not be reached`, err);
      }
      const raw = await res.text().catch(() => "");
      if (!res.ok) throw new AIProviderError(kindOf(res.status), `${vendor.name} answered ${res.status}: ${raw.slice(0, 500)}`);
      let body: EmbeddingResponse;
      try {
        body = JSON.parse(raw) as EmbeddingResponse;
      } catch (err) {
        throw new AIProviderError("unavailable", `${vendor.name} sent an unreadable embeddings reply: ${raw.slice(0, 200)}`, err);
      }
      // Some failures (unknown model, no credits) arrive as an error body on a 200 response.
      if (body.error || !body.data || body.data.length !== texts.length)
        throw new AIProviderError(
          typeof body.error?.code === "number" ? kindOf(body.error.code) : "invalid",
          `${vendor.name} embeddings failed: ${body.error?.message ?? "wrong number of vectors returned"}`,
        );
      return body.data.toSorted((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  });
