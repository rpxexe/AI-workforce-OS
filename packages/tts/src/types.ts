export interface TTSProvider {
  readonly name: string;
  /**
   * 8 kHz mono mu-law audio for `text`, streamed as it is made. The request starts when this
   * is called, not when the result is first read, so the next sentence can be prepared while
   * the current one plays.
   */
  synthesize(text: string, options: { language: string; signal: AbortSignal }): AsyncIterable<Buffer>;
}

export class TTSError extends Error {}
