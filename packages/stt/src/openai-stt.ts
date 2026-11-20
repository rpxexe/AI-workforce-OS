import { kindOfStatus, ProviderError } from "@workforce/shared";
import type { STTProvider } from "./types.ts";

// The API picks the decoder from the file name, so it has to match the audio.
const EXTENSIONS: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/webm": "webm",
};

/** Any OpenAI-compatible `/audio/transcriptions` endpoint (OpenAI Whisper or a custom server). Recorded files only. */
export function openAITranscriber({
  name,
  baseUrl,
  apiKey,
  model,
  fetch: fetchImpl = fetch,
}: {
  name: string;
  /** Up to and including the version, without a trailing slash: https://api.openai.com/v1 */
  baseUrl: string;
  /** Left out for local servers that need none. */
  apiKey?: string;
  model: string;
  fetch?: typeof fetch;
}): STTProvider {
  return {
    name,
    async transcribe(audio, { mimeType, language, signal }) {
      const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `audio.${EXTENSIONS[mime] ?? "ogg"}`);
      form.append("model", model);
      form.append("language", language);
      const res = await fetchImpl(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        body: form,
        signal: signal ?? AbortSignal.timeout(60_000),
      }).catch((err: unknown) => {
        if (signal?.aborted) throw err;
        throw new ProviderError((err as Error)?.name === "TimeoutError" ? "timeout" : "unavailable", `${name} transcription could not be reached`, err);
      });
      if (!res.ok) throw new ProviderError(kindOfStatus(res.status), `${name} transcription answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      const data = (await res.json()) as { text?: string };
      return data.text?.trim() ?? "";
    },
  };
}
