// Turns the employee's streamed reply into phone audio with as little delay as possible: text is
// cut into sentences as it arrives, each sentence is synthesized as soon as it is complete (in
// parallel with the one playing), and audio is forwarded in order. A mark after each sentence
// tells us when the caller has actually heard it.
import type { TTSProvider } from "@workforce/tts";

/** What a person would say: no markdown, links reduced to their text. */
export const forSpeech = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*#`>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// The shortest text ending in sentence punctuation followed by a space, or a line break.
const SENTENCE = /^([\s\S]*?(?:[.!?…]+["')\]]*(?=\s)|\n))/;
// Long text without punctuation is cut at a comma or space after this many characters.
const MAX_CHUNK = 220;

type Output = { audio(chunk: Buffer): void; mark(name: string): void; clear(): void };

let speakers = 0;

export class Speaker {
  /** Everything handed to speech so far. */
  spoken = "";
  interrupted = false;
  /** Resolves once everything was heard, or the speaker was interrupted. */
  readonly played: Promise<void>;

  private readonly id = `s${++speakers}`;
  private readonly abort = new AbortController();
  private readonly marks = new Set<string>();
  private buffer = "";
  private pending = 0;
  private sentences = 0;
  private ended = false;
  private chain = Promise.resolve();
  private done!: () => void;
  private readonly tts: TTSProvider;
  private readonly language: string;
  private readonly out: Output;
  private readonly onError: (err: unknown) => void;

  constructor(tts: TTSProvider, language: string, out: Output, onError: (err: unknown) => void) {
    this.tts = tts;
    this.language = language;
    this.out = out;
    this.onError = onError;
    this.played = new Promise((resolve) => (this.done = resolve));
  }

  /** Whether audio is still being made or played. */
  get active() {
    return !this.interrupted && !(this.ended && this.pending === 0 && this.marks.size === 0);
  }

  push(text: string) {
    if (this.interrupted) return;
    this.buffer += text;
    for (let m = SENTENCE.exec(this.buffer); m; m = SENTENCE.exec(this.buffer)) {
      this.say(m[1] ?? "");
      this.buffer = this.buffer.slice(m[0].length);
    }
    if (this.buffer.length > MAX_CHUNK) {
      const cut = Math.max(this.buffer.lastIndexOf(", ", MAX_CHUNK), this.buffer.lastIndexOf(" ", MAX_CHUNK));
      if (cut > 0) {
        this.say(this.buffer.slice(0, cut + 1));
        this.buffer = this.buffer.slice(cut + 1);
      }
    }
  }

  /** No more text is coming; speak what is left. */
  end() {
    if (this.ended) return;
    this.say(this.buffer);
    this.buffer = "";
    this.ended = true;
    this.check();
  }

  /** The caller started talking: stop now and drop audio not yet played. */
  interrupt() {
    if (this.interrupted || !this.active) return;
    this.interrupted = true;
    this.abort.abort();
    this.out.clear();
    this.done();
  }

  /** The phone finished playing up to this mark. */
  heard(name: string) {
    if (this.marks.delete(name)) this.check();
  }

  private say(text: string) {
    const sentence = forSpeech(text);
    if (!sentence || this.interrupted) return;
    this.spoken += (this.spoken ? " " : "") + sentence;
    const name = `${this.id}-${++this.sentences}`;
    const options = { language: this.language, signal: this.abort.signal };
    // The request starts here, while earlier sentences are still playing.
    const audio = this.retried(this.tts.synthesize(sentence, options), sentence, options);
    this.pending++;
    this.chain = this.chain
      .then(async () => {
        for await (const chunk of audio) {
          if (this.interrupted) return;
          this.out.audio(chunk);
        }
        if (this.interrupted) return;
        this.marks.add(name);
        this.out.mark(name);
      })
      .catch((err: unknown) => {
        if (!this.interrupted) this.onError(err);
      })
      .finally(() => {
        this.pending--;
        this.check();
      });
  }

  /** One retry if a sentence fails before any audio arrives. */
  private async *retried(
    first: AsyncIterable<Buffer>,
    sentence: string,
    options: { language: string; signal: AbortSignal },
  ): AsyncGenerator<Buffer> {
    let received = false;
    try {
      for await (const chunk of first) {
        received = true;
        yield chunk;
      }
    } catch (err) {
      if (received || this.interrupted) throw err;
      yield* this.tts.synthesize(sentence, options);
    }
  }

  private check() {
    if (!this.active) this.done();
  }
}
