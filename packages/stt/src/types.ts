export type STTEvent =
  /** Words heard so far that may still change. Used to notice the caller talking over the employee. */
  | { type: "partial"; text: string }
  /** The caller finished a turn: everything they said since the last one. */
  | { type: "turn"; text: string }
  /** The connection failed for good; no more events follow. */
  | { type: "error"; error: Error };

export type STTStream = {
  /** 8 kHz mono mu-law audio, as the phone call delivers it. */
  send(audio: Buffer): void;
  close(): void;
};

export interface STTProvider {
  readonly name: string;
  /** `language` is an ISO 639-1 code such as "en". */
  open(options: { language: string; onEvent: (event: STTEvent) => void }): STTStream;
}
