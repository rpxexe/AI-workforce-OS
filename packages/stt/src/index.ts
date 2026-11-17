// Speech-to-text providers. Deepgram is the only one so far.
import { deepgramProvider } from "./deepgram.ts";

export * from "./types.ts";
export { deepgramProvider } from "./deepgram.ts";

/** From `DEEPGRAM_API_KEY` (and optional `DEEPGRAM_MODEL`); null when not configured. */
export function sttFromEnv(env: Record<string, string | undefined> = process.env) {
  if (!env.DEEPGRAM_API_KEY) return null;
  return deepgramProvider({ apiKey: env.DEEPGRAM_API_KEY, model: env.DEEPGRAM_MODEL || undefined });
}
