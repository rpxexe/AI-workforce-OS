import { kindOfStatus, ProviderError } from "@workforce/shared";
import type { TTSProvider } from "./types.ts";
import { wavToMulaw } from "./wav.ts";

/** The useful part of an error body: OpenAI's `error.message`, FastAPI's `detail` (VoiceStudio, Kokoro), or the text. */
function detailOf(body: string) {
  try {
    const json = JSON.parse(body) as { error?: { message?: string }; detail?: unknown };
    const detail = json.error?.message ?? json.detail;
    if (detail) return typeof detail === "string" ? detail : JSON.stringify(detail);
  } catch {
    // not JSON
  }
  return body;
}

/**
 * Any OpenAI-compatible `/audio/speech` endpoint: OpenAI itself, Kokoro-FastAPI, VoiceStudio or a
 * custom server. WAV is asked for because every such server makes it and it streams.
 */
export function openAISpeechProvider({
  name,
  baseUrl,
  apiKey,
  model,
  voice,
  fetch: fetchImpl = fetch,
}: {
  name: string;
  /** Up to and including the version, without a trailing slash: https://api.openai.com/v1 */
  baseUrl: string;
  /** Left out for local servers that need none. */
  apiKey?: string;
  model: string;
  voice: string;
  fetch?: typeof fetch;
}): TTSProvider {
  return {
    name,
    synthesize(text, { signal }) {
      const response = fetchImpl(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, voice, input: text, response_format: "wav" }),
        signal,
      });
      response.catch(() => {}); // reported when read
      return (async function* () {
        const res = await response.catch((err: unknown) => {
          throw signal.aborted ? err : new ProviderError("unavailable", `${name} speech could not be reached`, err);
        });
        if (!res.ok || !res.body) {
          const detail = detailOf(await res.text().catch(() => ""));
          throw new ProviderError(kindOfStatus(res.status), `${name} speech answered ${res.status}: ${detail.slice(0, 300)}`);
        }
        yield* wavToMulaw(res.body);
      })();
    },
  };
}
