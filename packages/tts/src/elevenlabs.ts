import { TTSError, type TTSProvider } from "./types.ts";

/** Skips a WAV header if one is sent: the phone needs bare mu-law bytes. */
function stripWavHeader(first: Buffer) {
  if (first.subarray(0, 4).toString("latin1") !== "RIFF") return first;
  const data = first.indexOf("data", 12, "latin1");
  return data === -1 ? first : first.subarray(data + 8);
}

/** ElevenLabs streaming speech, one HTTP request per sentence. */
export function elevenLabsProvider({
  apiKey,
  voiceId,
  model = "eleven_flash_v2_5",
  baseUrl = "https://api.elevenlabs.io",
}: {
  apiKey: string;
  /** Leave out to use the account's first default voice. */
  voiceId?: string;
  model?: string;
  baseUrl?: string;
}): TTSProvider {
  let voice: Promise<string> | undefined;
  const voiceToUse = () =>
    (voice ??= voiceId
      ? Promise.resolve(voiceId)
      : fetch(`${baseUrl}/v2/voices?voice_type=default&page_size=1`, { headers: { "xi-api-key": apiKey } })
          .then((res) => (res.ok ? (res.json() as Promise<{ voices?: { voice_id: string }[] }>) : Promise.reject(new TTSError(`ElevenLabs voices answered ${res.status}`))))
          .then((body) => body.voices?.[0]?.voice_id ?? Promise.reject(new TTSError("ElevenLabs has no default voice for this account")))
          .catch((err: unknown) => {
            voice = undefined; // try again on the next sentence
            throw err;
          }));

  return {
    name: "elevenlabs",
    synthesize(text, { language, signal }) {
      const response = voiceToUse().then((id) =>
        fetch(`${baseUrl}/v1/text-to-speech/${id}/stream?output_format=ulaw_8000`, {
          method: "POST",
          headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/basic" },
          // Normalization reads numbers, times and prices out properly; Flash leaves it off by default.
          body: JSON.stringify({ text, model_id: model, language_code: language, apply_text_normalization: "on" }),
          signal,
        }),
      );
      response.catch(() => {}); // reported when read
      return (async function* () {
        const res = await response.catch((err: unknown) => {
          throw err instanceof TTSError ? err : new TTSError("ElevenLabs could not be reached", { cause: err });
        });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          throw new TTSError(`ElevenLabs answered ${res.status}: ${detail.slice(0, 300)}`);
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
