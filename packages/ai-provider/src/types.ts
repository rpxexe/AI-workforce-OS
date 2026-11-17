export type ChatMessage = { role: "user" | "assistant"; content: string };

export type CompletionRequest = {
  system: string;
  /** Oldest first; the last one is the message to answer. */
  messages: ChatMessage[];
  /** Aborting stops the request; the caller owns timeouts and cancellation. */
  signal: AbortSignal;
};

export type ProviderEvent =
  | { type: "text"; text: string }
  /** Always the last event of a successful completion. */
  | { type: "done"; inputTokens: number; outputTokens: number };

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

export type ProviderSettings = { model?: string; maxOutputTokens: number };

/** Turns text into vectors for semantic search. Fails with `AIProviderError`, like `AIProvider`. */
export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  /** One vector per text, in the same order. */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}
