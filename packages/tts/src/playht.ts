import { kindOfStatus, ProviderError } from "@workforce/shared";
import type { TTSProvider } from "./types.ts";
import { stripWavHeader } from "./wav.ts";

// PlayHT names languages in English ("english", "spanish") rather than by code.
const languageNames = new Intl.DisplayNames(["en"], { type: "language" });

/** PlayHT streaming speech, 8 kHz mu-law. */
export function playHTProvider({
  apiKey,
  userId,
  voice,
  model = "Play3.0-mini",
  fetch: fetchImpl = fetch,
  api = "https://api.play.ht",
}: {
  apiKey: string;
  userId: string;
  /** A PlayHT voice manifest URL or id. */
  voice: string;
  model?: string;
  fetch?: typeof fetch;
  api?: string;
}): TTSProvider {
  return {
    name: "playht",
    synthesize(text, { language, signal }) {
      const languageName = languageNames.of(language.split("-")[0] || "en")?.toLowerCase();
      const response = fetchImpl(`${api}/api/v2/tts/stream`, {
        method: "POST",
        headers: { AUTHORIZATION: apiKey, "X-USER-ID": userId, accept: "audio/basic", "content-type": "application/json" },
        body: JSON.stringify({ text, voice, voice_engine: model, output_format: "mulaw", sample_rate: 8000, language: languageName }),
        signal,
      });
      response.catch(() => {}); // reported when read
      return (async function* () {
        const res = await response.catch((err: unknown) => {
          throw signal.aborted ? err : new ProviderError("unavailable", "PlayHT could not be reached", err);
        });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          throw new ProviderError(kindOfStatus(res.status), `PlayHT answered ${res.status}: ${detail.slice(0, 300)}`);
        }
        let first = true;
        for await (const chunk of res.body) {
          const audio = Buffer.from(chunk);
          yield first ? stripWavHeader(audio) : audio;
          first = false;
        }
      })();
    },
  };
}
