import Anthropic from "@anthropic-ai/sdk";
import { AIProviderError, type AIProvider, type ProviderSettings } from "./types.ts";

const toProviderError = (err: unknown) => {
  if (err instanceof AIProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new AIProviderError("unavailable", "The request was cancelled", err);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
    return new AIProviderError("auth", "Anthropic rejected the credentials", err);
  if (err instanceof Anthropic.RateLimitError) return new AIProviderError("rate_limit", "Anthropic rate limit reached", err);
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError)
    return new AIProviderError("invalid", `Anthropic rejected the request: ${err.message}`, err);
  if (err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError))
    // Raised by the SDK before any request is sent; in practice, no API key or login was found.
    return new AIProviderError("auth", "No Anthropic credentials found", err);
  return new AIProviderError("unavailable", "Anthropic could not be reached or failed", err);
};

/** Credentials come from `ANTHROPIC_API_KEY` (or the SDK's other sources), never from code. */
export function anthropicProvider({ model = "claude-opus-5-5", maxOutputTokens }: ProviderSettings): AIProvider {
  // Created on first use so a missing key fails the chat request, not the whole server.
  let client: Anthropic | undefined;

  return {
    name: "anthropic",
    model,
    async *stream({ system, messages, signal }) {
      try {
        client ??= new Anthropic();
        const stream = client.messages.stream(
          // Caches the conversation so far, so each turn re-reads earlier turns at a fraction of the price.
          { model, max_tokens: maxOutputTokens, system, messages, cache_control: { type: "ephemeral" } },
          { signal },
        );
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta")
            yield { type: "text", text: event.delta.text };
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === "refusal") throw new AIProviderError("refused", "The model declined to answer");
        const { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens } = final.usage;
        yield {
          type: "done",
          // input_tokens excludes cached tokens; the total is what the turn actually read.
          inputTokens: input_tokens + (cache_creation_input_tokens ?? 0) + (cache_read_input_tokens ?? 0),
          outputTokens: output_tokens,
        };
      } catch (err) {
        throw toProviderError(err);
      }
    },
  };
}
