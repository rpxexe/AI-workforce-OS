// Telephony behind one interface: call control, webhooks and the live media stream. Audio is
// always 8 kHz mono mu-law, the format phone networks carry, so STT and TTS work in it too.

export type CallStatus = "QUEUED" | "RINGING" | "IN_PROGRESS" | "COMPLETED" | "BUSY" | "NO_ANSWER" | "FAILED" | "CANCELED";
export const ENDED_STATUSES: readonly CallStatus[] = ["COMPLETED", "BUSY", "NO_ANSWER", "FAILED", "CANCELED"];

/** What the provider says over the media stream, in our terms. */
export type MediaEvent =
  | { type: "start"; streamId: string; providerCallId: string; parameters: Record<string, string> }
  | { type: "audio"; audio: Buffer }
  /** Audio sent before the mark with this name has finished playing (or was cleared). */
  | { type: "mark"; name: string }
  | { type: "dtmf"; digit: string }
  | { type: "stop" }
  | { type: "other" };

export class TelephonyError extends Error {}

export type Webhook = {
  /** The exact public URL the provider called. */
  url: string;
  /** The form-encoded body, parsed. */
  params: Record<string, string>;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
};

export interface TelephonyProvider {
  readonly name: string;
  /** Whether a webhook really came from the provider. */
  verifyWebhook(webhook: Webhook): boolean;
  /** Webhook answer that connects the call to our media stream; `parameters` come back on its start event. */
  connectToStream(streamUrl: string, parameters: Record<string, string>): string;
  /** Webhook answer that tells the caller something and hangs up. */
  sayAndHangUp(message: string): string;
  /** Reads a call status webhook. */
  statusOf(params: Record<string, string>): { providerCallId: string; status: CallStatus | null; durationSec: number | null };
  placeCall(options: {
    to: string;
    from: string;
    streamUrl: string;
    parameters: Record<string, string>;
    statusCallbackUrl: string;
    timeLimitSec: number;
  }): Promise<{ providerCallId: string | null }>; // null: learned from the first status callback
  endCall(providerCallId: string): Promise<void>;
  /** Points a number the account owns at our webhooks. Fails if the account does not own it. */
  configureNumber(number: string, urls: { voiceUrl: string; statusCallbackUrl: string }): Promise<{ providerNumberId: string }>;
  parseMedia(message: string): MediaEvent;
  audioMessage(streamId: string, audio: Buffer): string;
  markMessage(streamId: string, name: string): string;
  /** Drops audio not yet played: how barge-in stops the employee mid-sentence. */
  clearMessage(streamId: string): string;
}
