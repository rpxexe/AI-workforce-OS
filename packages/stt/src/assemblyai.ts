import { setTimeout as sleep } from "node:timers/promises";
import { kindOfStatus, ProviderError } from "@workforce/shared";
import WebSocket from "ws";
import type { STTEvent, STTProvider } from "./types.ts";

type Message = { type?: string; transcript?: string; end_of_turn?: boolean; turn_is_formatted?: boolean; turn_order?: number };

const RECONNECTS = 3;
// About two seconds of phone audio, kept while reconnecting so a blip does not lose words.
const MAX_BUFFERED_BYTES = 16_000;
// AssemblyAI rejects chunks outside 50-1000 ms, and the phone sends 20 ms frames: send 100 ms at a time.
const CHUNK_BYTES = 800;
const MIN_CHUNK_BYTES = 400;
// With format_turns a finished turn arrives twice, plain and then formatted. The formatted one is the
// turn; the plain one is used only if the formatted one has not come after this long.
const FORMAT_WAIT_MS = 1000;
const TRANSCRIPT_TIMEOUT_MS = 120_000;

/** AssemblyAI: Universal Streaming (v3) for calls, and the async transcript API for recorded files. */
export function assemblyAIProvider({
  apiKey,
  fetch: fetchImpl = fetch,
  api = "https://api.assemblyai.com",
  streamingUrl = "wss://streaming.assemblyai.com/v3/ws",
}: {
  apiKey: string;
  fetch?: typeof fetch;
  api?: string;
  streamingUrl?: string;
}): STTProvider {
  return {
    name: "assemblyai",
    open({ onEvent }) {
      const query = new URLSearchParams({ sample_rate: "8000", encoding: "pcm_mulaw", format_turns: "true" });
      let socket: WebSocket;
      let closed = false;
      let failures = 0;
      let queue = Buffer.alloc(0); // audio not sent yet
      let emitted = -1; // turn_order of the last turn emitted in this session
      let plain: { order: number; text: string; timer: NodeJS.Timeout } | undefined; // a finished turn waiting for its formatted copy

      const emit = (event: STTEvent) => {
        if (!closed) onEvent(event);
      };
      const endTurn = (order: number, text: string) => {
        if (plain?.order === order) {
          clearTimeout(plain.timer);
          plain = undefined;
        }
        if (order <= emitted) return;
        emitted = order;
        if (text) emit({ type: "turn", text });
      };
      const flushPlain = () => plain && endTurn(plain.order, plain.text);
      const flush = () => {
        while (socket.readyState === WebSocket.OPEN && queue.length >= CHUNK_BYTES) {
          socket.send(queue.subarray(0, CHUNK_BYTES));
          queue = queue.subarray(CHUNK_BYTES);
        }
      };

      const connect = () => {
        socket = new WebSocket(`${streamingUrl}?${query}`, { headers: { authorization: apiKey } });
        socket.on("open", () => {
          failures = 0;
          flush();
        });
        socket.on("message", (data, isBinary) => {
          if (isBinary) return;
          let m: Message;
          try {
            m = JSON.parse(data.toString()) as Message;
          } catch {
            return;
          }
          if (m.type === "Begin") emitted = -1; // a new session numbers its turns from 0 again
          if (m.type !== "Turn") return;
          const text = m.transcript?.trim() ?? "";
          const order = m.turn_order ?? 0;
          if (!m.end_of_turn) {
            if (text) emit({ type: "partial", text });
          } else if (m.turn_is_formatted) endTurn(order, text);
          else if (order > emitted && plain?.order !== order) {
            flushPlain();
            plain = { order, text, timer: setTimeout(() => endTurn(order, text), FORMAT_WAIT_MS) };
          }
        });
        socket.on("error", () => {}); // followed by "close", which decides what to do
        socket.on("close", (code) => {
          flushPlain(); // the formatted copy will not come on this connection
          if (closed) return;
          if (++failures > RECONNECTS) {
            closed = true;
            onEvent({ type: "error", error: new ProviderError("unavailable", `AssemblyAI connection lost (${code})`) });
            return;
          }
          setTimeout(() => !closed && connect(), 250 * failures);
        });
      };
      connect();

      return {
        send(audio) {
          if (closed) return;
          queue = Buffer.concat([queue, audio]);
          if (socket.readyState === WebSocket.OPEN) flush();
          else if (queue.length > MAX_BUFFERED_BYTES) queue = queue.subarray(queue.length - MAX_BUFFERED_BYTES);
        },
        close() {
          if (closed) return;
          closed = true;
          if (plain) clearTimeout(plain.timer);
          if (socket.readyState === WebSocket.OPEN) {
            if (queue.length >= MIN_CHUNK_BYTES) socket.send(queue);
            socket.send(JSON.stringify({ type: "Terminate" }));
          }
          socket.close();
        },
      };
    },

    async transcribe(audio, { language, signal }) {
      const call = async <T>(path: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } = {}) => {
        const res = await fetchImpl(`${api}${path}`, {
          ...init,
          headers: { authorization: apiKey, ...init.headers },
          signal: signal ?? AbortSignal.timeout(30_000),
        }).catch((err: unknown) => {
          if (signal?.aborted) throw err;
          throw new ProviderError((err as Error)?.name === "TimeoutError" ? "timeout" : "unavailable", "AssemblyAI could not be reached", err);
        });
        if (!res.ok) throw new ProviderError(kindOfStatus(res.status), `AssemblyAI answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
        return (await res.json()) as T;
      };

      const deadline = Date.now() + TRANSCRIPT_TIMEOUT_MS;
      const { upload_url } = await call<{ upload_url: string }>("/v2/upload", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(audio),
      });
      const { id } = await call<{ id: string }>("/v2/transcript", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio_url: upload_url, language_code: language }),
      });
      for (;;) {
        const transcript = await call<{ status?: string; text?: string; error?: string }>(`/v2/transcript/${encodeURIComponent(id)}`);
        if (transcript.status === "completed") return transcript.text?.trim() ?? "";
        if (transcript.status === "error") throw new ProviderError("invalid", `AssemblyAI could not transcribe the audio: ${(transcript.error ?? "").slice(0, 300)}`);
        if (Date.now() + 1000 > deadline) throw new ProviderError("unavailable", "AssemblyAI did not finish the transcript within 120 seconds");
        await sleep(1000, undefined, { signal });
      }
    },
  };
}
