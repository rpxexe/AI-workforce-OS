import WebSocket from "ws";
import type { STTEvent, STTProvider } from "./types.ts";

type Message = {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
  description?: string;
};

const RECONNECTS = 3;
// About two seconds of phone audio, kept while reconnecting so a blip does not lose words.
const MAX_BUFFERED_BYTES = 16_000;

/**
 * Deepgram live transcription. A turn ends when Deepgram's endpointing hears a pause
 * (`speech_final`), or, as a fallback for noisy lines, at `UtteranceEnd`.
 */
export function deepgramProvider({
  apiKey,
  model = "nova-3",
  url = "wss://api.deepgram.com/v1/listen",
}: {
  apiKey: string;
  model?: string;
  url?: string;
}): STTProvider {
  return {
    name: "deepgram",
    open({ language, onEvent }) {
      const query = new URLSearchParams({
        model,
        language,
        encoding: "mulaw",
        sample_rate: "8000",
        channels: "1",
        interim_results: "true",
        // A pause this long ends the caller's turn. Shorter answers faster but cuts people off.
        endpointing: "400",
        utterance_end_ms: "1000",
        smart_format: "true",
        punctuate: "true",
      });
      let socket: WebSocket;
      let closed = false;
      let failures = 0;
      let buffered: Buffer[] = [];
      let heard = ""; // final segments of the current turn
      let lastSent = Date.now();

      const emit = (event: STTEvent) => {
        if (!closed) onEvent(event);
      };
      const endTurn = () => {
        const text = heard.trim();
        heard = "";
        if (text) emit({ type: "turn", text });
      };

      const connect = () => {
        socket = new WebSocket(`${url}?${query}`, { headers: { authorization: `Token ${apiKey}` } });
        socket.on("open", () => {
          failures = 0;
          for (const chunk of buffered) socket.send(chunk);
          buffered = [];
        });
        socket.on("message", (data, isBinary) => {
          if (isBinary) return;
          let m: Message;
          try {
            m = JSON.parse(data.toString()) as Message;
          } catch {
            return;
          }
          if (m.type === "Results") {
            const text = m.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
            if (!m.is_final) {
              if (text) emit({ type: "partial", text });
              return;
            }
            if (text) heard += ` ${text}`;
            if (m.speech_final) endTurn();
          } else if (m.type === "UtteranceEnd") endTurn();
        });
        socket.on("error", () => {}); // followed by "close", which decides what to do
        socket.on("close", () => {
          if (closed) return;
          if (++failures > RECONNECTS) {
            closed = true;
            onEvent({ type: "error", error: new Error("Deepgram connection lost") });
            return;
          }
          setTimeout(() => !closed && connect(), 250 * failures);
        });
      };
      connect();

      // Deepgram closes a connection that hears nothing for 10 seconds.
      const keepAlive = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN && Date.now() - lastSent > 4000) socket.send(JSON.stringify({ type: "KeepAlive" }));
      }, 2000);

      return {
        send(audio) {
          if (closed) return;
          lastSent = Date.now();
          if (socket.readyState === WebSocket.OPEN) socket.send(audio);
          else {
            buffered.push(audio);
            let size = buffered.reduce((n, b) => n + b.length, 0);
            while (size > MAX_BUFFERED_BYTES) size -= buffered.shift()?.length ?? 0;
          }
        },
        close() {
          if (closed) return;
          closed = true;
          clearInterval(keepAlive);
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "CloseStream" }));
          socket.close();
        },
      };
    },

    async transcribe(audio, { mimeType, language, signal }) {
      const query = new URLSearchParams({ model, language, smart_format: "true", punctuate: "true" });
      const res = await fetch(`${url.replace(/^ws/, "http")}?${query}`, {
        method: "POST",
        headers: { authorization: `Token ${apiKey}`, "content-type": mimeType },
        body: new Uint8Array(audio),
        signal: signal ?? AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Deepgram answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } };
      return data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
    },
  };
}
