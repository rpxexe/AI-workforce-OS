import { kindOfStatus, localeOf, ProviderError } from "@workforce/shared";
import type { TTSProvider } from "./types.ts";

const XML: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const escapeXml = (text: string) => text.replace(/[&<>"']/g, (c) => XML[c] ?? c);

/** Azure AI Speech text-to-speech, streamed as raw 8 kHz mu-law. */
export function azureTTSProvider({
  apiKey,
  region,
  voice = "en-US-AvaMultilingualNeural",
  fetch: fetchImpl = fetch,
  host = `https://${region}.tts.speech.microsoft.com`,
}: {
  apiKey: string;
  region: string;
  /** A multilingual voice speaks whatever language the call is in. */
  voice?: string;
  fetch?: typeof fetch;
  host?: string;
}): TTSProvider {
  return {
    name: "azure_speech",
    synthesize(text, { language, signal }) {
      const locale = localeOf(language);
      const response = fetchImpl(`${host}/cognitiveservices/v1`, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": apiKey,
          "content-type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "raw-8khz-8bit-mono-mulaw",
          "User-Agent": "ai-workforce-os",
        },
        body: `<speak version="1.0" xml:lang="${escapeXml(locale)}"><voice name="${escapeXml(voice)}">${escapeXml(text)}</voice></speak>`,
        signal,
      });
      response.catch(() => {}); // reported when read
      return (async function* () {
        const res = await response.catch((err: unknown) => {
          throw signal.aborted ? err : new ProviderError("unavailable", "Azure Speech could not be reached", err);
        });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          throw new ProviderError(kindOfStatus(res.status), `Azure Speech answered ${res.status}: ${detail.slice(0, 300)}`);
        }
        for await (const chunk of res.body) yield Buffer.from(chunk);
      })();
    },
  };
}
