// One live phone call. The voice channel has no brain of its own: every caller turn goes through
// `runTurn`, exactly like test chat, with the same employee, knowledge, memory and tools.
//
//   phone audio -> STT -> caller turn -> runTurn (LLM, tools) -> text -> Speaker (TTS) -> phone
import { createHmac, timingSafeEqual } from "node:crypto";
import { runTurn, type HandoffNotice } from "@workforce/agent-runtime";
import type { AIProvider, EmbeddingProvider } from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import type { MemoryService } from "@workforce/memory";
import type { STTEvent, STTProvider, STTStream } from "@workforce/stt";
import type { MediaEvent, TelephonyProvider } from "@workforce/telephony";
import { ENDED_STATUSES } from "@workforce/telephony";
import { toolRegistry, type ToolExecutor } from "@workforce/tools";
import type { TTSProvider } from "@workforce/tts";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import { recordMessage } from "../channels/service.ts";
import { configOf } from "../employees.ts";
import { Speaker } from "./speaker.ts";

export type VoiceLimits = {
  /** Silence before "Are you still there?", and again before hanging up. */
  idleMs: number;
  /** Calls are ended after this long. */
  maxCallMs: number;
};

export type SessionDeps = {
  telephony: TelephonyProvider;
  stt: STTProvider;
  tts: TTSProvider;
  provider: () => AIProvider;
  embedder: () => EmbeddingProvider;
  memory: (provider: AIProvider, timeoutMs: number) => MemoryService;
  tools: ToolExecutor;
  timeoutMs: number;
  onHandoff?: (notice: HandoffNotice) => void;
  secret: string;
  limits: VoiceLimits;
  log: FastifyBaseLogger;
};

// shortcut: these lines are English whatever the employee's language; make them per-language settings when needed
const LINES = {
  apology: "Sorry, I had trouble with that. Could you say it again?",
  stillThere: "Are you still there?",
  idleGoodbye: "I haven't heard anything for a while, so I'll end the call now. Goodbye.",
  timeLimit: "We've reached the time limit for this call. Goodbye.",
  cannotHear: "Sorry, I'm having trouble hearing you right now. Please call again later.",
  withPerson: "A member of our team is handling this now and will get back to you shortly. Goodbye.",
};

/** The stream token proves a media stream belongs to a call we set up (Twilio does not sign the socket). */
export const streamToken = (secret: string, callId: string) => createHmac("sha256", secret).update(`stream:${callId}`).digest("hex");

const tokenValid = (secret: string, callId: string, token: string) => {
  const expected = Buffer.from(streamToken(secret, callId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
};

const joined = (...parts: string[]) => parts.filter(Boolean).join(" ");

export function runCallSession(socket: WebSocket, deps: SessionDeps) {
  const { telephony, log } = deps;
  let live: Awaited<ReturnType<typeof startCall>> | undefined;
  let stopped = false;

  socket.on("message", (data) => {
    const event = telephony.parseMedia(data.toString());
    if (event.type === "start") {
      startCall(event, socket, deps).then(
        (call) => {
          live = call;
          if (stopped) void call.finish();
        },
        (err: unknown) => {
          log.error({ err }, "Call stream could not start");
          // Closing the stream makes the provider play the fallback message and hang up.
          socket.close();
        },
      );
    } else if (event.type === "stop") {
      stopped = true;
      void live?.finish();
    } else live?.handle(event);
  });
  socket.on("close", () => {
    stopped = true;
    void live?.finish();
  });
  socket.on("error", (err) => log.warn({ err }, "Call stream socket error"));
}

async function startCall(event: Extract<MediaEvent, { type: "start" }>, socket: WebSocket, deps: SessionDeps) {
  const { telephony, log } = deps;
  const callId = event.parameters.callId ?? "";
  if (!tokenValid(deps.secret, callId, event.parameters.token ?? "")) throw new Error("Invalid stream token");

  const call = await prisma.call.findUnique({
    where: { id: callId },
    include: {
      employee: {
        include: {
          knowledgeSources: { select: { sourceId: true } },
          tools: { select: { tool: true } },
        },
      },
    },
  });
  if (!call) throw new Error(`Call ${callId} not found`);
  if (call.providerCallId && call.providerCallId !== event.providerCallId) throw new Error("Stream belongs to another call");
  // The version that was live when the call came in.
  const version = await prisma.aiEmployeeVersion.findUnique({
    where: { employeeId_number: { employeeId: call.employeeId, number: call.employeeVersion } },
  });
  if (!version) throw new Error("The call's employee version is missing");

  const employee = configOf(version);
  const scope = { organizationId: call.organizationId, workspaceId: call.workspaceId };
  const provider = deps.provider();
  const sourceIds = call.employee.knowledgeSources.map((k) => k.sourceId);
  const knowledge = sourceIds.length > 0 ? { embedder: deps.embedder(), sourceIds } : undefined;
  const specs = toolRegistry.specs(call.employee.tools.map((t) => t.tool));
  const tools = specs.length > 0 ? { executor: deps.tools, specs } : undefined;
  const memory = deps.memory(provider, deps.timeoutMs);

  const answeredAt = call.answeredAt ?? new Date();
  await prisma.call.update({
    where: { id: call.id },
    data: {
      status: "IN_PROGRESS",
      streamId: event.streamId,
      answeredAt,
      providerCallId: call.providerCallId ?? event.providerCallId,
    },
  });
  const providerCallId = call.providerCallId ?? event.providerCallId;
  const offset = () => Date.now() - answeredAt.getTime();

  const send = (message: string) => {
    if (socket.readyState === socket.OPEN) socket.send(message);
  };
  const out = {
    audio: (chunk: Buffer) => send(telephony.audioMessage(event.streamId, chunk)),
    mark: (name: string) => send(telephony.markMessage(event.streamId, name)),
    clear: () => send(telephony.clearMessage(event.streamId)),
  };
  const speakers = new Set<Speaker>();
  const newSpeaker = () => {
    const speaker = new Speaker(deps.tts, employee.language, out, (err) => log.warn({ err, callId }, "Speech synthesis failed"));
    speakers.add(speaker);
    void speaker.played.then(() => speakers.delete(speaker));
    return speaker;
  };
  const line = (speaker: "CUSTOMER" | "EMPLOYEE", text: string, offsetMs: number, interrupted = false) => {
    if (!text) return;
    prisma.callTranscript
      .create({ data: { callId: call.id, speaker, text, offsetMs, interrupted } })
      .catch((err: unknown) => log.error({ err, callId }, "Saving a transcript line failed"));
  };

  // Each exchange also goes to the channel message log, like messages on every other channel.
  const callerNumber = call.direction === "INBOUND" ? call.from : call.to;
  const ourNumber = call.direction === "INBOUND" ? call.to : call.from;
  const logTurn = (heard: string, reply: string | null, error: string | null, latencyMs: number) => {
    const base = { ...scope, employeeId: call.employeeId, channel: "voice", customerId: call.customerId, conversationId };
    void recordMessage(log, {
      ...base,
      direction: "INBOUND",
      // No reply and no error: people have the conversation, the employee stayed silent.
      status: error ? "FAILED" : reply === null ? "HELD" : "ANSWERED",
      error,
      from: callerNumber,
      to: ourNumber,
      text: heard,
    });
    if (reply !== null)
      void recordMessage(log, { ...base, direction: "OUTBOUND", status: "SENT", from: ourNumber, to: callerNumber, text: reply, attempts: 1, latencyMs });
  };

  let conversationId = call.conversationId ?? undefined;
  /** The reply being written, if any. `saved` once runTurn stored the exchange. */
  let turn: { abort: AbortController; userText: string; saved: boolean } | undefined;
  /** What the caller said in a turn that was cut off before it was saved; prepended to the next. */
  let carried = "";
  let finished = false;
  let idleStage = 0;
  let idleTimer: NodeJS.Timeout | undefined;

  const speaking = () => [...speakers].some((s) => s.active);

  /** Says a fixed line (greeting, prompts) and records it. */
  const speakLine = async (text: string) => {
    const speaker = newSpeaker();
    const at = offset();
    speaker.push(text);
    speaker.end();
    await speaker.played;
    line("EMPLOYEE", speaker.spoken, at, speaker.interrupted);
  };

  const hangUp = () => {
    if (!providerCallId) return;
    telephony.endCall(providerCallId).catch((err: unknown) => log.error({ err, callId }, "Hanging up failed"));
  };

  const waitForCaller = () => {
    clearTimeout(idleTimer);
    if (finished) return;
    idleTimer = setTimeout(() => {
      if (turn || speaking()) return waitForCaller();
      idleStage++;
      if (idleStage === 1) void speakLine(LINES.stillThere).then(waitForCaller);
      else void speakLine(LINES.idleGoodbye).then(hangUp);
    }, deps.limits.idleMs);
  };
  const heardCaller = () => {
    idleStage = 0;
    clearTimeout(idleTimer);
  };

  /** The caller talks over the employee: stop speaking, and drop a reply not yet saved. */
  const interrupt = () => {
    if (turn) {
      if (!turn.saved) carried = joined(carried, turn.userText);
      turn.abort.abort();
      turn = undefined;
    }
    for (const speaker of speakers) speaker.interrupt();
  };

  const respond = async (heard: string) => {
    interrupt();
    heardCaller();
    const userText = joined(carried, heard);
    carried = "";
    line("CUSTOMER", heard, offset());

    const current = { abort: new AbortController(), userText, saved: false };
    turn = current;
    const speaker = newSpeaker();
    const at = offset();
    const turnStarted = Date.now();
    let replyText = "";
    // Calls are not transferred: after a handoff the employee says so and hangs up, and a person follows up.
    let handedOff = false;
    for await (const result of runTurn({
      provider,
      ...scope,
      employeeId: call.employeeId,
      userId: "voice",
      employee,
      employeeVersion: call.employeeVersion,
      conversationId,
      knowledge,
      customer: call.customerId
        ? { id: call.customerId, memory, onError: (err) => log.error({ err, callId }, "Updating customer memory failed") }
        : undefined,
      tools,
      channel: "voice",
      userMessage: userText,
      timeoutMs: deps.timeoutMs,
      signal: current.abort.signal,
      onHandoff: deps.onHandoff,
    })) {
      if (result.type === "text") {
        speaker.push(result.text);
        replyText += result.text;
      } else if (result.type === "held") {
        current.saved = true;
        handedOff = true;
        logTurn(userText, null, null, Date.now() - turnStarted);
        speaker.push(LINES.withPerson);
      } else if (result.type === "done") {
        current.saved = true;
        if (result.handoff) handedOff = true;
        if (!conversationId) {
          conversationId = result.conversation.id;
          await prisma.call.update({ where: { id: call.id }, data: { conversationId } });
        }
        logTurn(userText, replyText, null, Date.now() - turnStarted);
      } else {
        log.error({ err: result.cause, kind: result.kind, callId }, "Voice turn failed");
        logTurn(userText, null, result.message, Date.now() - turnStarted);
        speaker.push(` ${LINES.apology}`);
      }
    }
    if (turn === current) turn = undefined;
    speaker.end();
    await speaker.played;
    line("EMPLOYEE", speaker.spoken, at, speaker.interrupted);
    if (handedOff && !speaker.interrupted) return hangUp();
    if (!turn && !speaking()) waitForCaller();
  };

  const onSpeech = (e: STTEvent) => {
    if (finished) return;
    if (e.type === "partial") {
      heardCaller();
      // Real words, not noise, while the employee is talking or thinking: barge-in.
      if (/[\p{L}\p{N}]/u.test(e.text) && (turn || speaking())) interrupt();
    } else if (e.type === "turn") {
      respond(e.text).catch((err: unknown) => log.error({ err, callId }, "Voice turn crashed"));
    } else {
      log.error({ err: e.error, callId }, "Speech recognition failed");
      void speakLine(LINES.cannotHear).then(hangUp);
    }
  };

  let stt: STTStream | undefined;
  try {
    stt = deps.stt.open({ language: employee.language, onEvent: onSpeech });
  } catch (err) {
    log.error({ err, callId }, "Speech recognition could not start");
    void speakLine(LINES.cannotHear).then(hangUp);
  }
  const maxTimer = setTimeout(() => void speakLine(LINES.timeLimit).then(hangUp), deps.limits.maxCallMs);
  void speakLine(call.greeting).then(() => {
    if (!turn && !speaking()) waitForCaller();
  });

  return {
    handle(e: MediaEvent) {
      if (e.type === "audio") stt?.send(e.audio);
      else if (e.type === "mark") for (const speaker of speakers) speaker.heard(e.name);
    },

    /** The call ended (hang-up or stream closed). Runs once. */
    async finish() {
      if (finished) return;
      finished = true;
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      stt?.close();
      interrupt();
      try {
        const now = await prisma.call.findUnique({ where: { id: call.id }, select: { status: true, endedAt: true, durationSec: true } });
        if (!now) return;
        await prisma.call.update({
          where: { id: call.id },
          data: {
            // The provider's status callback may already have said how it ended.
            status: ENDED_STATUSES.includes(now.status) ? now.status : "COMPLETED",
            endedAt: now.endedAt ?? new Date(),
            durationSec: now.durationSec ?? Math.round(offset() / 1000),
          },
        });
      } catch (err) {
        log.error({ err, callId }, "Recording the end of the call failed");
      }
    },
  };
}
