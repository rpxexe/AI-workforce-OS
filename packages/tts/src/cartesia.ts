import { kindOfStatus, ProviderError } from "@workforce/shared";
import type { TTSProvider } from "./types.ts";

/** Cartesia Sonic over HTTP, streamed as raw 8 kHz mu-law. */
export function cartesiaProvider({
  apiKey,
  voice,
  model = "sonic-2",
  fetch: fetchImpl = fetch,
  api = "https://api.cartesia.ai",
}: {
  apiKey: string;
  /** A Cartesia voice id. */
  voice: string;
  model?: string;
  fetch?: typeof fetch;
  api?: string;
}): TTSProvider {
  return {
    name: "cartesia",
    synthesize(text, { language, signal }) {
      const response = fetchImpl(`${api}/tts/bytes`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "Cartesia-Version": "2025-04-16", "content-type": "application/json" },
        body: JSON.stringify({
          model_id: model,
          transcript: text,
          voice: { mode: "id", id: voice },
          output_format: { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 },
          language,
        }),
        signal,
      });
      response.catch(() => {}); // reported when read
      return (async function* () {
        const res = await response.catch((err: unknown) => {
          throw signal.aborted ? err : new ProviderError("unavailable", "Cartesia could not be reached", err);
        });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          throw new ProviderError(kindOfStatus(res.status), `Cartesia answered ${res.status}: ${detail.slice(0, 300)}`);
        }
        for await (const chunk of res.body) yield Buffer.from(chunk);
      })();
    },
  };
}
