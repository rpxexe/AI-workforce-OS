/** What the router knows about a model. Prices are US dollars per million tokens; null = unknown. */
export type ModelInfo = {
  id: string;
  contextTokens: number | null;
  inputPricePerM: number | null;
  outputPricePerM: number | null;
  /** Whether the model can call tools. */
  tools: boolean;
};

const anthropic = (id: string, input: number, output: number): ModelInfo => ({
  id,
  contextTokens: 1_000_000,
  inputPricePerM: input,
  outputPricePerM: output,
  tools: true,
});

/**
 * Models known without being told: Anthropic's current ones (first-party prices, from the Claude API docs,
 * November 2026). Every other model's price and context come from the organization's credential settings;
 * OpenRouter reports the real cost of each call itself.
 */
// shortcut: hand-kept list; read prices from each vendor's models API when more providers need built-in prices
export const MODEL_CATALOG: Record<string, ModelInfo[]> = {
  anthropic: [
    anthropic("claude-fable-5-2", 8, 40),
    anthropic("claude-opus-5-5", 4, 20),
    anthropic("claude-sonnet-5-5", 2, 10),
    // shortcut: Haiku 5.5's price for prompts up to 100K tokens; longer prompts cost 5x and are estimated low
    anthropic("claude-haiku-5-5", 0.1, 0.5),
  ],
};

/** The organization's own description of a model wins over the catalog. */
export const modelInfo = (kind: string, model: string, own: ModelInfo[] = []): ModelInfo | undefined =>
  own.find((m) => m.id === model) ?? MODEL_CATALOG[kind]?.find((m) => m.id === model);

/** Cost in US dollars of a call with these token counts, or null when the price is unknown. */
export const costOf = (info: ModelInfo | undefined, inputTokens: number, outputTokens: number): number | null =>
  info?.inputPricePerM == null || info.outputPricePerM == null
    ? null
    : (inputTokens * info.inputPricePerM + outputTokens * info.outputPricePerM) / 1_000_000;
