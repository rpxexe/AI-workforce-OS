import { kindOfStatus, localeOf, ProviderError } from "@workforce/shared";
import type { TTSProvider } from "./types.ts";
import { stripWavHeader } from "./wav.ts";

/**
 * Google Cloud Text-to-Speech. Not streamed: one request returns the whole sentence.
 * The key goes in the URL, so the URL never goes into an error.
 */
export function googleTTSProvider({
  apiKey,
  voice,
  fetch: fetchImpl = fetch,
  api = "https://texttospeech.googleapis.com",
}: {
  apiKey: string;
  /** A voice name such as en-US-Neural2-F; left out, Google picks one for the language. */
  voice?: string;
  fetch?: typeof fetch;
  api?: string;
}): TTSProvider {
  return {
    name: "google_tts",
    synthesize(text, { language, signal }) {
      const response = fetchImpl(`${api}/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: localeOf(language), ...(voice ? { name: voice } : {}) },
          audioConfig: { audioEncoding: "MULAW", sampleRateHertz: 8000 },
        }),
        signal,
      });
      response.catch(() => {}); // reported when read
      return (async function* () {
        const res = await response.catch((err: unknown) => {
          // No cause: it could carry the URL, and with it the key.
          throw signal.aborted ? err : new ProviderError("unavailable", "Google Text-to-Speech could not be reached");
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new ProviderError(kindOfStatus(res.status), `Google Text-to-Speech answered ${res.status}: ${detail.slice(0, 300)}`);
        }
        const { audioContent } = (await res.json()) as { audioContent?: string };
        if (!audioContent) throw new ProviderError("invalid", "Google Text-to-Speech returned no audio");
        // MULAW comes wrapped in a WAV header.
        yield stripWavHeader(Buffer.from(audioContent, "base64"));
      })();
    },
  };
}
