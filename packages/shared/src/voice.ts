// Phone numbers and calls.
import { z } from "zod";

export const e164 = z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "Use international format, e.g. +14155550100");
/** "{name}" is replaced with the employee's name when the call starts. */
const greeting = z.string().trim().min(1).max(300);

export const DEFAULT_INBOUND_GREETING = "Hi, this is {name}. How can I help you today?";
export const DEFAULT_OUTBOUND_GREETING = "Hi, this is {name}. Is now a good time to talk?";

export const addPhoneNumberSchema = z.object({ number: e164, employeeId: z.string().min(1), greeting: greeting.optional() });
export type AddPhoneNumber = z.infer<typeof addPhoneNumberSchema>;

export const placeCallSchema = z.object({
  to: e164,
  /** One of the employee's numbers; defaults to its first. */
  phoneNumberId: z.string().min(1).optional(),
  greeting: greeting.optional(),
});
export type PlaceCall = z.infer<typeof placeCallSchema>;

// ---- API responses (dates are ISO strings) ----

export type PhoneNumberInfo = { id: string; number: string; employeeId: string; greeting: string; createdAt: string };

export type CallStatus = "QUEUED" | "RINGING" | "IN_PROGRESS" | "COMPLETED" | "BUSY" | "NO_ANSWER" | "FAILED" | "CANCELED";

export type CallSummary = {
  id: string;
  employeeId: string;
  direction: "INBOUND" | "OUTBOUND";
  status: CallStatus;
  from: string;
  to: string;
  conversationId: string | null;
  customerId: string | null;
  error: string | null;
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
};

/** One live transfer of a call to a person after a handoff (the audit log). */
export type CallTransferRecord = {
  id: string;
  callId: string;
  to: string;
  status: "INITIATED" | "COMPLETED" | "NO_ANSWER" | "BUSY" | "CANCELED" | "FAILED";
  error: string | null;
  talkSec: number | null;
  createdAt: string;
  endedAt: string | null;
};

export const toTransferRecord = (t: { id: string; callId: string; to: string; status: CallTransferRecord["status"]; error: string | null; talkSec: number | null; createdAt: Date; endedAt: Date | null }): CallTransferRecord => ({
  id: t.id,
  callId: t.callId,
  to: t.to,
  status: t.status,
  error: t.error,
  talkSec: t.talkSec,
  createdAt: t.createdAt.toISOString(),
  endedAt: t.endedAt?.toISOString() ?? null,
});

export type CallDetail = CallSummary & {
  transfers: CallTransferRecord[];
  employeeVersion: number;
  participants: { role: "CUSTOMER" | "EMPLOYEE"; phoneNumber: string | null; customerId: string | null; employeeId: string | null }[];
  transcript: { speaker: "CUSTOMER" | "EMPLOYEE"; text: string; offsetMs: number; interrupted: boolean }[];
};
