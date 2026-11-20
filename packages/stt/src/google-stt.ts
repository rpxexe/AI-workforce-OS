import { kindOfStatus, localeOf, ProviderError } from "@workforce/shared";
import type { STTProvider } from "./types.ts";

const OPUS_RATES = new Set([8000, 12000, 16000, 24000, 48000]);

/** The input sample rate an Ogg Opus file declares in its OpusHead packet; Google wants it stated. */
function opusRate(audio: Buffer) {
  const head = audio.indexOf("OpusHead", 0, "latin1");
  const rate = head !== -1 && head + 16 <= audio.length ? audio.readUInt32LE(head + 12) : 0;
  return OPUS_RATES.has(rate) ? rate : 48000;
}

function configOf(mimeType: string, audio: Buffer): { encoding: string; sampleRateHertz?: number } {
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "audio/ogg") return { encoding: "OGG_OPUS", sampleRateHertz: opusRate(audio) };
  if (mime === "audio/wav" || mime === "audio/x-wav") return { encoding: "LINEAR16" }; // the rate is read from the header
  if (mime === "audio/flac") return { encoding: "FLAC" };
  if (mime === "audio/basic" || mime === "audio/mulaw") return { encoding: "MULAW", sampleRateHertz: 8000 };
  throw new ProviderError("invalid", `Google Speech-to-Text cannot read ${mime}`);
}

/**
 * Google Cloud Speech-to-Text v1 for recorded files. Synchronous recognition, so files up to a minute.
 * The key goes in the URL, so the URL never goes into an error.
 */
export function googleTranscriber({
  apiKey,
  model,
  fetch: fetchImpl = fetch,
  api = "https://speech.googleapis.com",
}: {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  api?: string;
}): STTProvider {
  return {
    name: "google_stt",
    async transcribe(audio, { mimeType, language, signal }) {
      const config = { ...configOf(mimeType, audio), languageCode: localeOf(language), ...(model ? { model } : {}) };
      const res = await fetchImpl(`${api}/v1/speech:recognize?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config, audio: { content: audio.toString("base64") } }),
        signal: signal ?? AbortSignal.timeout(60_000),
      }).catch((err: unknown) => {
        if (signal?.aborted) throw err;
        // No cause: it could carry the URL, and with it the key.
        throw new ProviderError((err as Error)?.name === "TimeoutError" ? "timeout" : "unavailable", "Google Speech-to-Text could not be reached");
      });
      if (!res.ok) throw new ProviderError(kindOfStatus(res.status), `Google Speech-to-Text answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      const data = (await res.json()) as { results?: { alternatives?: { transcript?: string }[] }[] };
      return (data.results ?? [])
        .map((r) => r.alternatives?.[0]?.transcript?.trim() ?? "")
        .filter(Boolean)
        .join(" ");
    },
  };
}
