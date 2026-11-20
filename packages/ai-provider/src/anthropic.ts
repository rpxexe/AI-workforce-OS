import Anthropic from "@anthropic-ai/sdk";
import { AIProviderError, type AIProvider, type ChatMessage, type ProviderSettings } from "./types.ts";

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

/** Our messages in the Messages API shape. Assistant turns we made are replayed exactly as received. */
const toParam = (m: ChatMessage): Anthropic.MessageParam => {
  if (m.role === "user") return m;
  if (m.role === "tool")
    return {
      role: "user",
      // All results of one assistant turn go back in a single message.
      content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.callId, content: r.content, is_error: r.isError })),
    };
  // Thinking blocks must come back unchanged, so a turn we produced is sent as it arrived.
  if (m.raw?.provider === "anthropic") return { role: "assistant", content: m.raw.data as Anthropic.ContentBlockParam[] };
  if (!m.toolCalls?.length) return { role: "assistant", content: m.content };
  return {
    role: "assistant",
    content: [
      ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
      ...m.toolCalls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
    ],
  };
};

/** Credentials: an organization's own key (BYOAI), else `ANTHROPIC_API_KEY` (or the SDK's other sources), never from code. */
export function anthropicProvider({ model = "claude-opus-5-5", maxOutputTokens, apiKey }: ProviderSettings): AIProvider {
  // Created on first use so a missing key fails the chat request, not the whole server.
  let client: Anthropic | undefined;

  return {
    name: "anthropic",
    model,
    async *stream({ system, messages, tools, signal }) {
      try {
        client ??= apiKey ? new Anthropic({ apiKey }) : new Anthropic();
        const stream = client.messages.stream(
          // Caches the conversation so far, so each turn re-reads earlier turns at a fraction of the price.
          {
            model,
            max_tokens: maxOutputTokens,
            system,
            messages: messages.map(toParam),
            ...(tools?.length && {
              tools: tools.map(
                (t): Anthropic.Tool => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
                  // Inputs stream as written; the tool executor validates every input against its schema.
                  eager_input_streaming: true,
                }),
              ),
            }),
            cache_control: { type: "ephemeral" },
          },
          { signal },
        );
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta")
            yield { type: "text", text: event.delta.text };
        }
        const final = await stream.finalMessage();
        // A refusal can cut a tool call off mid-input: never run that turn's tools.
        if (final.stop_reason === "refusal") throw new AIProviderError("refused", "The model declined to answer");
        const toolCalls = final.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input }));
        // An input cut off at the output limit usually still parses, as a partial object.
        if (toolCalls.length > 0 && final.stop_reason === "max_tokens")
          throw new AIProviderError("invalid", "The reply hit the output token limit while calling a tool");
        const { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens } = final.usage;
        yield {
          type: "done",
          // input_tokens excludes cached tokens; the total is what the turn actually read.
          inputTokens: input_tokens + (cache_creation_input_tokens ?? 0) + (cache_read_input_tokens ?? 0),
          outputTokens: output_tokens,
          ...(toolCalls.length > 0 && { toolCalls, raw: { provider: "anthropic", data: final.content } }),
          provider: "anthropic",
          model,
        };
      } catch (err) {
        throw toProviderError(err);
      }
    },
  };
}
