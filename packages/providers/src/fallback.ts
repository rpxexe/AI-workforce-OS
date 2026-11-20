// Fallback across connections for speech and email, with Phase 13's rules: each target at most once (dedupe by key, so a
// chain can never loop), at most 3 targets, never after output reached the caller, never when the caller cancelled, and
// never for errors another provider cannot fix (auth, config, refusals).
import { randomUUID } from "node:crypto";
import type { ChannelSender, OutboundMessage } from "@workforce/channels";
import type { STTEvent, STTProvider, STTStream } from "@workforce/stt";
import type { TTSProvider } from "@workforce/tts";
import { redact } from "./seal.ts";

/** Failures another provider may not have. Auth and configuration errors are the admin's to fix, not to route around. */
export const FALLBACK_KINDS: ReadonlySet<string> = new Set(["billing", "rate_limit", "unavailable", "invalid", "timeout"]);
/** Email falls back only when the provider refused for load: anything else may have sent the message already. */
const EMAIL_FALLBACK_KINDS: ReadonlySet<string> = new Set(["rate_limit"]);

export const kindOf = (err: unknown): string => {
  const kind = (err as { kind?: unknown } | null)?.kind;
  if (typeof kind === "string") return kind;
  if ((err as { name?: string } | null)?.name === "AbortError" || (err as { name?: string } | null)?.name === "TimeoutError") return "timeout";
  return "unavailable";
};

/** One provider a request may go to. `key` identifies it for deduplication (connection id + provider + voice/model). */
export type Target<T> = {
  key: string;
  provider: string;
  connectionId: string | null;
  value: T;
  /** US dollars per unit (minute of audio or call, 1,000 characters of speech), from the connection's settings. */
  costPerUnit?: number | null;
  /** The model or voice used, for usage reports. */
  model?: string;
  /** The connection's secrets, removed from recorded errors. */
  secrets?: string[];
};

export type AttemptRecord = {
  requestId: string;
  attempt: number;
  provider: string;
  model: string;
  connectionId: string | null;
  operation: string;
  latencyMs: number;
  success: boolean;
  errorKind: string | null;
  error: string | null;
  characters?: number;
  seconds?: number;
  costUsd: number | null;
};

export type Recorder = (record: AttemptRecord) => void;

/** Each target once, in order, at most `max`. */
export function dedupe<T>(targets: Target<T>[], max = 3): Target<T>[] {
  const seen = new Set<string>();
  return targets.filter((t) => !seen.has(t.key) && seen.add(t.key)).slice(0, max);
}

const message = (err: unknown, target?: { secrets?: string[] }) => redact(err instanceof Error ? err.message : String(err), target?.secrets ?? []).slice(0, 500);

/** Runs `run` on each target until one succeeds; records every attempt. */
export async function firstThatWorks<T, R>(
  targets: Target<T>[],
  operation: string,
  run: (value: T) => Promise<R>,
  record: Recorder,
  options: { signal?: AbortSignal; fallbackKinds?: ReadonlySet<string>; units?: (result: R) => { characters?: number; seconds?: number; costUnits?: number } } = {},
): Promise<R> {
  const list = dedupe(targets);
  if (list.length === 0) throw Object.assign(new Error(`No provider is configured for ${operation}`), { kind: "config" });
  const requestId = randomUUID();
  for (const [index, target] of list.entries()) {
    const started = Date.now();
    const base = { requestId, attempt: index + 1, provider: target.provider, model: target.model ?? "", connectionId: target.connectionId, operation };
    try {
      const result = await run(target.value);
      const units = options.units?.(result) ?? {};
      const cost = units.costUnits !== undefined && target.costPerUnit != null ? units.costUnits * target.costPerUnit : null;
      record({ ...base, latencyMs: Date.now() - started, success: true, errorKind: null, error: null, characters: units.characters, seconds: units.seconds, costUsd: cost });
      return result;
    } catch (err) {
      const kind = options.signal?.aborted ? "cancelled" : kindOf(err);
      record({ ...base, latencyMs: Date.now() - started, success: false, errorKind: kind, error: message(err, target), costUsd: null });
      const last = index === list.length - 1;
      if (last || !(options.fallbackKinds ?? FALLBACK_KINDS).has(kind)) throw err;
    }
  }
  throw new Error("unreachable");
}

/** Speech from the first target that answers. A later target is asked only if the earlier one failed before any audio. */
export function fallbackTTS(targets: Target<TTSProvider>[], record: Recorder): TTSProvider {
  const list = dedupe(targets);
  return {
    name: list[0]?.provider ?? "none",
    synthesize(text, options) {
      const requestId = randomUUID();
      // The first request starts now, as TTSProvider promises; later ones only when needed.
      const first = list[0]?.value.synthesize(text, options);
      return (async function* () {
        if (!first) throw Object.assign(new Error("No text-to-speech provider is configured"), { kind: "config" });
        for (const [index, target] of list.entries()) {
          const started = Date.now();
          const base = { requestId, attempt: index + 1, provider: target.provider, model: target.model ?? "", connectionId: target.connectionId, operation: "synthesize" };
          let spoke = false;
          try {
            for await (const chunk of index === 0 ? first : target.value.synthesize(text, options)) {
              spoke = true;
              yield chunk;
            }
            const cost = target.costPerUnit != null ? (text.length / 1000) * target.costPerUnit : null;
            record({ ...base, latencyMs: Date.now() - started, success: true, errorKind: null, error: null, characters: text.length, costUsd: cost });
            return;
          } catch (err) {
            const kind = options.signal.aborted ? "cancelled" : kindOf(err);
            record({ ...base, latencyMs: Date.now() - started, success: false, errorKind: kind, error: message(err, target), characters: text.length, costUsd: null });
            if (spoke || index === list.length - 1 || !FALLBACK_KINDS.has(kind)) throw err;
          }
        }
      })();
    },
  };
}

/**
 * Speech recognition with fallback. Live: when a stream fails before it heard anything, the next live provider takes
 * over (audio during the switch is lost). Files: the next provider that can read files. Usage records the audio heard.
 */
export function fallbackSTT(targets: Target<STTProvider>[], record: Recorder): STTProvider {
  const live = dedupe(targets.filter((t) => t.value.open));
  const files = targets.filter((t) => t.value.transcribe);
  return {
    name: (live[0] ?? files[0])?.provider ?? "none",
    ...(live.length > 0 && {
      open({ language, onEvent }): STTStream {
        const requestId = randomUUID();
        const started = Date.now();
        let index = 0;
        let heard = false;
        let bytes = 0;
        let closed = false;
        let stream: STTStream;
        const done = (success: boolean, err?: unknown) => {
          const target = live[index]!;
          const seconds = bytes / 8000; // 8 kHz mu-law: one byte per sample
          record({
            requestId,
            attempt: index + 1,
            provider: target.provider,
            model: target.model ?? "",
            connectionId: target.connectionId,
            operation: "live_transcribe",
            latencyMs: Date.now() - started,
            success,
            errorKind: success ? null : kindOf(err),
            error: success ? null : message(err, target),
            seconds,
            costUsd: success && target.costPerUnit != null ? (seconds / 60) * target.costPerUnit : null,
          });
        };
        const openAt = (at: number) => {
          index = at;
          bytes = 0;
          stream = live[at]!.value.open!({
            language,
            onEvent: (event: STTEvent) => {
              if (closed) return;
              if (event.type === "error") {
                done(false, event.error);
                closed = true;
                if (!heard && at + 1 < live.length && FALLBACK_KINDS.has(kindOf(event.error))) {
                  closed = false;
                  return openAt(at + 1);
                }
              } else heard = true;
              onEvent(event);
            },
          });
        };
        openAt(0);
        return {
          send(audio) {
            bytes += audio.length;
            stream.send(audio);
          },
          close() {
            if (!closed) done(true);
            closed = true;
            stream.close();
          },
        };
      },
    }),
    ...(files.length > 0 && {
      transcribe: (audio, options) =>
        firstThatWorks(files, "transcribe", (stt) => stt.transcribe!(audio, options), record, {
          signal: options.signal,
          units: (text) => ({ characters: text.length }),
        }),
    }),
  };
}

/** Email with fallback only on explicit "try later" refusals (see EMAIL_FALLBACK_KINDS). */
export function fallbackEmail(targets: Target<ChannelSender>[], record: Recorder): ChannelSender {
  return {
    kind: "email",
    send: (message: OutboundMessage) => firstThatWorks(targets, "send", (sender) => sender.send(message), record, { fallbackKinds: EMAIL_FALLBACK_KINDS }),
  };
}
