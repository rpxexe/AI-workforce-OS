/** A tool the model may call, described in JSON Schema. Provider-independent. */
export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };

/** The model asking for a tool. `input` is whatever the model wrote: validate it before use. */
export type ToolCall = { id: string; name: string; input: unknown };

export type ToolResult = { callId: string; content: string; isError: boolean };

export type ChatMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      /** The provider's own record of this turn (e.g. thinking blocks), replayed unchanged to the provider that made it. */
      raw?: { provider: string; data: unknown };
    }
  /** The results of every call in the assistant message before it, in one message. */
  | { role: "tool"; results: ToolResult[] };

export type CompletionRequest = {
  system: string;
  /** Oldest first; the last one is the message to answer (or tool results to continue from). */
  messages: ChatMessage[];
  /** Tools the model may call this time. */
  tools?: ToolSpec[];
  /** Aborting stops the request; the caller owns timeouts and cancellation. */
  signal: AbortSignal;
};

export type ProviderEvent =
  | { type: "text"; text: string }
  /**
   * Always the last event of a successful completion. `toolCalls` is set when the model stopped
   * to call tools; send their results back to continue. `raw` goes on the assistant message.
   */
  | {
      type: "done";
      inputTokens: number;
      outputTokens: number;
      toolCalls?: ToolCall[];
      raw?: { provider: string; data: unknown };
      /** Who actually answered. Set by the providers and the router; record these, not the router's own name. */
      provider?: string;
      model?: string;
      /** The cost the provider reported for this call, in US dollars, when it reports one (OpenRouter does). */
      costUsd?: number;
    };

export interface AIProvider {
  /** Stored with each reply, e.g. "anthropic". */
  readonly name: string;
  readonly model: string;
  /** Streams the reply. Fails with `AIProviderError`. */
  stream(request: CompletionRequest): AsyncIterable<ProviderEvent>;
}

export type AIProviderErrorKind = "config" | "auth" | "billing" | "rate_limit" | "refused" | "unavailable" | "invalid";

/** Every provider reports failures as this, so callers never see a vendor's error types. */
export class AIProviderError extends Error {
  kind: AIProviderErrorKind;

  constructor(kind: AIProviderErrorKind, message: string, cause?: unknown) {
    super(message, { cause });
    this.kind = kind;
  }
}

export type ProviderSettings = {
  model?: string;
  maxOutputTokens: number;
  /** An organization's own key (BYOAI); the server's .env key otherwise. */
  apiKey?: string;
  /** Only for OpenAI-compatible services; overrides the vendor's address. */
  baseUrl?: string;
  /** The network the provider uses; custom base URLs get `safeFetch` (public https only). */
  fetch?: typeof fetch;
};

/** Turns text into vectors for semantic search. Fails with `AIProviderError`, like `AIProvider`. */
export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  /** One vector per text, in the same order. */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}
