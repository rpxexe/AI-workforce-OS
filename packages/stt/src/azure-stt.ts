import { kindOfStatus, localeOf, ProviderError } from "@workforce/shared";
import type { STTProvider } from "./types.ts";

function contentTypeOf(mimeType: string) {
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "audio/ogg") return "audio/ogg; codecs=opus";
  if (mime === "audio/wav" || mime === "audio/x-wav") return "audio/wav; codecs=audio/pcm; samplerate=16000";
  return mimeType;
}

/** Azure AI Speech REST API for short audio (up to a minute): recorded files only. */
export function azureTranscriber({
  apiKey,
  region,
  fetch: fetchImpl = fetch,
  host = `https://${region}.stt.speech.microsoft.com`,
}: {
  apiKey: string;
  region: string;
  fetch?: typeof fetch;
  host?: string;
}): STTProvider {
  return {
    name: "azure_speech",
    async transcribe(audio, { mimeType, language, signal }) {
      const query = new URLSearchParams({ language: localeOf(language), format: "simple" });
      const res = await fetchImpl(`${host}/speech/recognition/conversation/cognitiveservices/v1?${query}`, {
        method: "POST",
        headers: { "Ocp-Apim-Subscription-Key": apiKey, "content-type": contentTypeOf(mimeType) },
        body: new Uint8Array(audio),
        signal: signal ?? AbortSignal.timeout(60_000),
      }).catch((err: unknown) => {
        if (signal?.aborted) throw err;
        throw new ProviderError((err as Error)?.name === "TimeoutError" ? "timeout" : "unavailable", "Azure Speech could not be reached", err);
      });
      if (!res.ok) throw new ProviderError(kindOfStatus(res.status), `Azure Speech answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      const data = (await res.json()) as { RecognitionStatus?: string; DisplayText?: string };
      if (data.RecognitionStatus === "Success") return data.DisplayText?.trim() ?? "";
      // Nothing was said.
      if (data.RecognitionStatus === "NoMatch" || data.RecognitionStatus === "InitialSilenceTimeout") return "";
      throw new ProviderError("invalid", `Azure Speech could not transcribe the audio: ${data.RecognitionStatus ?? "no status"}`);
    },
  };
}
