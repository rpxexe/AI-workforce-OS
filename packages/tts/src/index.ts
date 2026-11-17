// Text-to-speech providers. ElevenLabs is the only one so far.
import { elevenLabsProvider } from "./elevenlabs.ts";

export * from "./types.ts";
export { elevenLabsProvider } from "./elevenlabs.ts";

/** From `ELEVENLABS_API_KEY` (optional `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`); null when not configured. */
export function ttsFromEnv(env: Record<string, string | undefined> = process.env) {
  if (!env.ELEVENLABS_API_KEY) return null;
  return elevenLabsProvider({
    apiKey: env.ELEVENLABS_API_KEY,
    voiceId: env.ELEVENLABS_VOICE_ID || undefined,
    model: env.ELEVENLABS_MODEL || undefined,
  });
}
